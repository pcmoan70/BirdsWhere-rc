/**
 * Google Drive sync — keeps the user's data (settings, checklists, map points,
 * eBird key) in step across devices through their Drive *appdata* folder, a
 * hidden per-user area the app can read/write but the user never sees.
 *
 * This module is only the transport + auth layer. The actual snapshot building
 * and merge live in app.js and are reached through window.AppData:
 *   - AppData.buildPayload()                  → the JSON we store in Drive
 *   - AppData.applyRemote(obj, {incomingWins, interactive})  → merge a remote copy in
 * Collections (checklists/pins/lists) are always unioned; scalar settings follow
 * `incomingWins`, decided here by comparing change-stamps.
 *
 * Sync is MANUAL and ONE-SHOT — there is no background/automatic syncing, and
 * no standing connection. Tapping "Synchronize" signs in (OAuth), runs one full
 * pull→merge→push, then disconnects, so the button returns to "Synchronize" and
 * the next tap signs in and syncs again from scratch. The Google sign-in window
 * only ever appears in direct response to a click.
 *
 * Auth uses Google Identity Services (the browser token model). The token is
 * dropped after each sync (teardown), so every Synchronize re-acquires one. We
 * only request the `drive.appdata` scope (no email/profile), so nothing
 * identifies the user and the OAuth verification path stays light.
 *
 * Exposed as window.GDriveSync (no module system; loaded via <script>).
 */
window.GDriveSync = (function () {
  "use strict";

  // The deployer's OAuth Web client ID. Leave "" to let users paste their own
  // in Settings (the public build can hard-code one here instead). It is public
  // by design — the browser token flow uses no client secret.
  var DEFAULT_CLIENT_ID = "309967713424-o0vgr5cgb1t8bvc9pk78br2mmo4v8kkm.apps.googleusercontent.com";

  var SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  var FILE_NAME = "migration_calendar.json";
  var LS_CONNECTED = "gdrive-connected";
  var LS_FILE_ID = "gdrive-file-id";
  var LS_CLIENT_ID = "gdrive-client-id";
  var LS_TOKEN = "gdrive-token";       // legacy keys — no longer written; purged on load +
  var LS_TOKEN_EXP = "gdrive-token-exp"; // teardown so an old persisted token can't linger.

  var connected = (function () { try { return localStorage.getItem(LS_CONNECTED) === "1"; } catch (e) { return false; } })();
  var fileId = (function () { try { return localStorage.getItem(LS_FILE_ID) || ""; } catch (e) { return ""; } })();

  var tokenClient = null;
  // The OAuth access token is kept in MEMORY ONLY — never localStorage — so no XSS
  // can read a live Drive token. Sync is user-gesture-driven, so a reload just
  // re-acquires the token on the next Sync (cheap). Purge any token a prior build
  // persisted.
  var accessToken = null, tokenExpiry = 0;
  try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_TOKEN_EXP); } catch (e) {}
  var tokenResolve = null, tokenReject = null;
  var tokenPromise = null;           // in-flight interactive token request (single-flight)

  var syncing = false;               // re-entrancy guard
  var armed = false;                 // ignore GeoState writes from this session's init churn
  var localDirty = false;            // a real user change happened this session → local scalars win
  var lastStatus = "idle";           // idle | syncing | error | reconnect
  var lastError = "";                // human-readable detail of the last failure (surfaced in the UI)
  var lastSyncAt = 0;                // ms epoch of the last successful sync
  var statusListeners = [];

  // ---- small helpers --------------------------------------------------------
  function clientId() {
    if (DEFAULT_CLIENT_ID) return DEFAULT_CLIENT_ID;
    try { return localStorage.getItem(LS_CLIENT_ID) || ""; } catch (e) { return ""; }
  }
  function localStateStr() { try { return localStorage.getItem(window.GeoState.storageKey) || "{}"; } catch (e) { return "{}"; } }
  // Stringify a state object with `updatedAt` excluded, so a push decision
  // ignores a timestamp-only difference (every local write bumps updatedAt).
  function stateStrNoStamp(state) {
    if (!state || typeof state !== "object") return JSON.stringify(state);
    var copy = {}, k;
    for (k in state) { if (Object.prototype.hasOwnProperty.call(state, k) && k !== "updatedAt") copy[k] = state[k]; }
    return JSON.stringify(copy);
  }
  function snapshot() { return { connected: connected, hasClientId: !!clientId(), status: lastStatus, busy: syncing, lastSyncAt: lastSyncAt, error: lastError }; }
  function emit(s) { lastStatus = s; for (var i = 0; i < statusListeners.length; i++) { try { statusListeners[i](snapshot()); } catch (e) {} } }
  // Record a failure's detail so the UI can show WHY a sync failed, then emit.
  function fail(status, e) { lastError = (e && e.message) ? String(e.message) : (typeof e === "string" ? e : "sync failed"); emit(status); }

  // ---- Google Identity Services / token -------------------------------------
  function waitForGis() {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function check() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (tries++ > 100) return reject(new Error("Google library not loaded"));
        setTimeout(check, 100);
      })();
    });
  }

  function initTokenClient() {
    if (tokenClient || !clientId()) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: function (resp) {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;   // in memory only — never persisted
          tokenExpiry = Date.now() + ((+resp.expires_in || 3600) * 1000) - 60000;
          if (tokenResolve) { tokenResolve(accessToken); }
        } else if (tokenReject) { tokenReject(new Error("no access token")); }
        tokenResolve = tokenReject = null;
      },
      error_callback: function (err) {
        if (tokenReject) { tokenReject(err || new Error("auth failed")); }
        tokenResolve = tokenReject = null;
      }
    });
  }

  // Resolve with a usable access token. Sync is manual-only, so this only ever
  // runs from a user gesture (the Connect / Sync now buttons): a still-valid
  // cached token (persisted ~1 h) is reused silently; otherwise we request one,
  // which is the single place the Google popup is expected. Single-flighted so a
  // double-tap can't open two requests.
  function ensureToken() {
    if (accessToken && Date.now() < tokenExpiry) return Promise.resolve(accessToken);
    if (tokenPromise) return tokenPromise;
    if (!tokenClient) return Promise.reject(new Error("not initialized"));
    tokenPromise = new Promise(function (resolve, reject) {
      tokenResolve = resolve; tokenReject = reject;
      try { tokenClient.requestAccessToken({ prompt: "" }); }
      catch (e) { tokenResolve = tokenReject = null; reject(e); }
    });
    var clear = function () { tokenPromise = null; };
    tokenPromise.then(clear, clear);
    return tokenPromise;
  }

  // ---- Drive REST -----------------------------------------------------------
  async function driveFetch(url, opts) {
    var token = await ensureToken();
    opts = opts || {}; opts.headers = opts.headers || {};
    opts.headers["Authorization"] = "Bearer " + token;
    var r = await fetch(url, opts);
    if (r.status === 401) {            // token rejected → drop it and re-auth
      accessToken = null; tokenExpiry = 0;
      token = await ensureToken();
      opts.headers["Authorization"] = "Bearer " + token;
      r = await fetch(url, opts);
    }
    return r;
  }

  async function findFile() {
    var q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    var r = await driveFetch("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,modifiedTime)&orderBy=" +
      encodeURIComponent("modifiedTime desc") + "&q=" + q, {});
    if (!r.ok) throw new Error("Drive list failed (" + r.status + ")");
    var j = await r.json();
    var files = (j.files || []).slice();
    if (!files.length) return null;
    // Defensive: if two app-data files exist (created concurrently on two devices)
    // bind to the NEWEST so we don't ping-pong overwrites onto a stale copy — even
    // if orderBy was ignored. trashed=false above keeps deleted copies out.
    files.sort(function (a, b) { return (Date.parse(b.modifiedTime) || 0) - (Date.parse(a.modifiedTime) || 0); });
    return files[0];
  }

  async function downloadFile(id) {
    var r = await driveFetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media", {});
    if (!r.ok) return null;
    try { return await r.json(); } catch (e) { return null; }
  }

  // Resumable upload — handles ANY payload size. Simple multipart/media uploads
  // are capped at 5 MB by Google, so a large detection set (lots of dots) would
  // silently fail to push and never reach the other device. Two steps: start a
  // session (metadata), then PUT the content to the returned session URI.
  async function resumableUpload(method, url, metadata, payloadStr) {
    var start = await driveFetch(url, {
      method: method,
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/json" },
      body: JSON.stringify(metadata || {})
    });
    if (!start.ok) throw new Error("Drive upload init failed (" + start.status + ")");
    var session = start.headers.get("Location") || start.headers.get("location");
    if (!session) throw new Error("Drive upload: no session URI (header not exposed)");
    var put = await driveFetch(session, { method: "PUT", headers: { "Content-Type": "application/json" }, body: payloadStr });
    if (!put.ok) throw new Error("Drive upload failed (" + put.status + ")");
    return await put.json();
  }

  async function createFile(payloadStr) {
    return resumableUpload("POST",
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
      { name: FILE_NAME, parents: ["appDataFolder"] }, payloadStr);
  }

  async function updateFile(id, payloadStr) {
    return resumableUpload("PATCH",
      "https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=resumable&fields=id",
      {}, payloadStr);
  }

  // ---- sync orchestration ---------------------------------------------------
  // One manual pull→merge→push, run only from the Connect / Sync now buttons.
  // `options` (from the sync dialog) may narrow it: { direction, cats } where
  // direction ∈ "two"|"upload"|"download" and cats = { settings, lists, trips,
  // checklists, fetched } truthy = include. Omitted → full two-way (default).
  async function sync(options) {
    if (!connected || syncing || !clientId() || !navigator.onLine) return;
    var dir = (options && options.direction) || "two";
    var inc = (options && options.cats) || { settings: 1, lists: 1, trips: 1, checklists: 1, fetched: 1 };
    syncing = true; emit("syncing");
    try {
      var meta = await findFile();
      if (meta && meta.id !== fileId) { fileId = meta.id; try { localStorage.setItem(LS_FILE_ID, fileId); } catch (e) {} }
      var remote = meta ? await downloadFile(meta.id) : null;

      // Scalar-settings direction (collections always union regardless). Two-way:
      // remote wins ONLY when its change-stamp is strictly newer than what THIS
      // device last saved AND the user hasn't edited locally this session (every
      // payload carries updatedAt). Upload forces local-wins; Download forces
      // remote-wins. Collections are always unioned, so no direction loses data.
      var remoteStamp = remote && remote.state ? (+remote.state.updatedAt || 0) : 0;
      var incomingWins;
      if (dir === "download") incomingWins = !!remote;
      else if (dir === "upload") incomingWins = false;
      else incomingWins = !!remote && remoteStamp > window.GeoState.bootUpdatedAt() && !localDirty;

      var localState = {}; try { localState = JSON.parse(localStateStr()); } catch (e) {}
      var toApply = remote ? window.AppData.filterIncomingForSync(remote, inc, localState) : null;
      var before = localStateStr();
      if (toApply) window.AppData.applyRemote(toApply, { incomingWins: incomingWins, interactive: false });
      var changed = localStateStr() !== before;

      // Push when there's no remote yet, or the merged result differs from it
      // (local-only collections, or our scalars winning). Compare state with
      // `updatedAt` excluded: every local write bumps that timestamp, so a
      // bare stringify would treat an otherwise-unchanged sync as dirty and
      // trigger a full resumable upload on every sync. Download is pull-only.
      var merged = window.AppData.buildPayload();
      window.AppData.overlayExcludedForPush(merged, remote, inc, localState);
      var needPush = dir !== "download" && (!remote ||
        stateStrNoStamp(merged.state) !== stateStrNoStamp(remote.state) ||
        (merged.ebirdKey && merged.ebirdKey !== (remote.ebirdKey || "")));
      if (needPush) {
        var str = JSON.stringify(merged);
        if (fileId) { await updateFile(fileId, str); }
        else { var created = await createFile(str); fileId = created.id; try { localStorage.setItem(LS_FILE_ID, fileId); } catch (e) {} }
      }

      localDirty = false;
      lastSyncAt = Date.now();
      lastError = "";        // clear any previous failure on success
      emit("idle");

      // A pull that overwrote scalar settings the UI already rendered needs a
      // reload to show them. Guard keyed on the remote's stamp (not a bare
      // boolean): a genuinely-newer remote on a LATER sync still reloads, while
      // the same stamp (after reload, local == remote → no further reload)
      // can't loop.
      if (changed && incomingWins) {
        try {
          if (sessionStorage.getItem("gdrive-reloaded") !== String(remoteStamp)) {
            sessionStorage.setItem("gdrive-reloaded", String(remoteStamp));
            location.reload();
          }
        } catch (e) {}
      }
    } catch (e) {
      fail("reconnect", e);
    } finally {
      syncing = false;
    }
  }

  // Drop the access token + connected flag so we never hold a standing
  // connection. Each Sync re-acquires a token (so Google's sign-in shows) and
  // calls this when done, leaving the button back at "Synchronize". Does not
  // emit — the caller keeps whatever status the sync produced.
  function teardown() {
    accessToken = null; tokenExpiry = 0; connected = false; fileId = "";
    try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_TOKEN_EXP); localStorage.removeItem(LS_CONNECTED); localStorage.removeItem(LS_FILE_ID); } catch (e) {}
  }

  // ---- public API -----------------------------------------------------------
  return {
    // Called once by app.js at the end of init. Sync is MANUAL + one-shot —
    // nothing here reaches out to Google or runs a sync; we just track whether
    // the user changed anything this session (so the sync lets local win) and
    // surface the last-synced status. OAuth happens solely when Synchronize is
    // tapped, and the connection is dropped again as soon as the sync finishes.
    init: function () {
      armed = true;
      window.GeoState.onChange(function () { if (armed) localDirty = true; });
      emit(lastStatus);
    },

    // Kept for the (now hidden) Connect button — same one-shot behaviour.
    connect: function () { return this.syncNow(); },

    disconnect: function () {
      try { if (accessToken && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(accessToken, function () {}); } catch (e) {}
      teardown(); emit("idle");
    },

    // "Synchronize" (a gesture): sign in (OAuth), run one full pull→merge→push,
    // then disconnect — so the next tap signs in and syncs again from scratch.
    // `options` (from the sync dialog) narrows which categories + direction; omit
    // for full two-way.
    syncNow: function (options) {
      if (!clientId()) { fail("error", "no Google client ID set"); return Promise.resolve(); }
      return waitForGis()
        .then(function () { initTokenClient(); connected = true; return sync(options); })  // sync() emits idle/reconnect and never rejects
        .catch(function (e) { fail("reconnect", e || "could not reach Google sign-in"); })   // GIS-load / sign-in failure
        .then(function () { teardown(); emit(lastStatus); });                       // drop the connection, keep the result status
    },

    setClientId: function (id) {
      try { localStorage.setItem(LS_CLIENT_ID, (id || "").trim()); } catch (e) {}
      tokenClient = null;   // rebuild against the new id on next use
      emit(lastStatus);
    },

    onStatus: function (cb) { if (typeof cb === "function") { statusListeners.push(cb); cb(snapshot()); } },
    getState: snapshot
  };
})();
