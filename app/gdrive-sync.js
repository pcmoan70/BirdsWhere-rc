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

  // drive.file gives per-file access to what this app creates — enough to keep the
  // backups in a folder the user can actually open, and nothing else in their Drive.
  // drive.appdata is kept alongside it so backups written before v1875, which live in
  // the hidden application-data folder, can still be read and carried across.
  var SCOPE = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file";
  var FOLDER_NAME = "BirdsWhere";
  var LS_FOLDER_ID = "gdrive-folder-id";
  var FILE_NAME = "migration_calendar.json";
  // Every push also leaves a DATED copy beside the current file, so the app-data
  // folder carries a history instead of one endlessly overwritten file. The newest
  // of them is what a download reads; the rest are backups (restorable from the
  // sync dialog — Drive's own UI cannot show app-data files). The current file keeps
  // its plain name so builds that look for it by name keep working.
  var SNAP_PREFIX = "migration_calendar-";
  var SNAP_KEEP = 10;               // newest kept; older copies are deleted on push
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // "migration_calendar-2026-09-17_1830.json" — sortable by name as well as by time.
  function snapName(ts) {
    var d = new Date(ts || Date.now());
    return SNAP_PREFIX + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + ".json";
  }
  // Newest first, by modifiedTime (falling back to the name, which sorts the same way).
  function byNewest(files) {
    return (files || []).slice().sort(function (a, b) {
      var ta = Date.parse(a.modifiedTime) || 0, tb = Date.parse(b.modifiedTime) || 0;
      return tb - ta || String(b.name || "").localeCompare(String(a.name || ""));
    });
  }
  // Which dated copies to delete: everything past the newest `keep`.
  function snapsToPrune(files, keep) {
    return byNewest((files || []).filter(function (f) { return f && String(f.name || "").indexOf(SNAP_PREFIX) === 0; }))
      .slice(Math.max(0, keep == null ? SNAP_KEEP : keep));
  }
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
  // ms epoch of the last successful sync — PERSISTED, so after a reload the app still
  // knows whether the lists have outgrown their last backup.
  var lastSyncAt = (function () { try { return +window.GeoState.get("gdriveLastSync", 0) || 0; } catch (e) { return 0; } })();
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
  var lastPhase = "";                // which step of a sync is running, for the button
  var lastPhaseName = "";            // …and, while files are being written, WHICH file
  function phase(p, name) { lastPhase = p || ""; lastPhaseName = name || ""; emit(lastStatus); }
  function snapshot() { return { connected: connected, hasClientId: !!clientId(), status: lastStatus, busy: syncing, lastSyncAt: lastSyncAt, error: lastError, phase: lastPhase, phaseName: lastPhaseName }; }
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

  var consentAsked = false;          // the missing-scope prompt is asked at most once per load
  function initTokenClient() {
    if (tokenClient || !clientId()) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: function (resp) {
        if (resp && resp.access_token) {
          // Anyone who connected before v1875 granted drive.appdata ALONE. A silent
          // request hands that old grant straight back, and every call to the visible
          // folder then fails with 403 insufficient scope — the sync sees none of the
          // new structure. Ask once, with a real consent prompt, for what is missing.
          var granted = String(resp.scope || "");
          if (granted && granted.indexOf("drive.file") < 0 && !consentAsked) {
            consentAsked = true;
            try { tokenClient.requestAccessToken({ prompt: "consent" }); return; } catch (e) {}
          }
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
    // 403 from Drive is usually "you hold a token, but not for this scope" — which is
    // exactly what an account connected before the visible folder existed will get.
    // Re-ask with a consent prompt once, then retry the call.
    if (r.status === 403 && !consentAsked) {
      var body = ""; try { body = await r.clone().text(); } catch (e) {}
      if (/insufficient|scope|ACCESS_TOKEN_SCOPE/i.test(body)) {
        consentAsked = true; accessToken = null; tokenExpiry = 0;
        try {
          token = await new Promise(function (resolve, reject) {
            tokenResolve = resolve; tokenReject = reject;
            tokenClient.requestAccessToken({ prompt: "consent" });
          });
          opts.headers["Authorization"] = "Bearer " + token;
          r = await fetch(url, opts);
        } catch (e) { /* fall through with the 403 */ }
      }
    }
    return r;
  }

  // The visible folder. Found by name in My Drive (only folders this app made are
  // visible to drive.file, so this never picks up a stranger's folder), created on
  // first use, and its id remembered so later syncs skip the lookup.
  var _folderId = null;
  async function ensureFolder() {
    if (_folderId) return _folderId;
    var cached = "";
    try { cached = localStorage.getItem(LS_FOLDER_ID) || ""; } catch (e) {}
    if (cached) {
      var chk = await driveFetch("https://www.googleapis.com/drive/v3/files/" + cached + "?fields=id,trashed", {});
      if (chk.ok) {
        var cj = await chk.json();
        if (cj && cj.id && !cj.trashed) { _folderId = cj.id; return _folderId; }
      }
      try { localStorage.removeItem(LS_FOLDER_ID); } catch (e) {}   // deleted or emptied from Drive
    }
    var q = encodeURIComponent("trashed=false and mimeType='application/vnd.google-apps.folder' and name='" + FOLDER_NAME + "'");
    var r = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=files(id)&pageSize=10&q=" + q, {});
    if (r.ok) {
      var j = await r.json();
      if (j.files && j.files.length) { _folderId = j.files[0].id; }
    }
    if (!_folderId) {
      var c = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
      });
      if (!c.ok) throw new Error("Drive folder create failed (" + c.status + ")");
      _folderId = (await c.json()).id;
    }
    try { localStorage.setItem(LS_FOLDER_ID, _folderId); } catch (e) {}
    return _folderId;
  }
  // Each sync writes into its own subfolder of BirdsWhere, named for the moment it ran
  // ("2026-09-24 1830"). That IS the history: the folder holds that sync's payload and
  // its readable copies together, and the names sort chronologically.
  function runFolderName(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + pad2(d.getMinutes());
  }
  async function createRunFolder() {
    var parent = await ensureFolder();
    var r = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name: runFolderName(Date.now()), parents: [parent],
                             mimeType: "application/vnd.google-apps.folder" })
    });
    if (!r.ok) throw new Error("Drive run folder failed (" + r.status + ")");
    return (await r.json()).id;
  }
  // The dated subfolders, newest first. Their names sort chronologically, but Drive is
  // asked for createdTime too so a hand-renamed folder cannot reorder the history.
  async function listRunFolders() {
    var parent;
    try { parent = await ensureFolder(); } catch (e) { return []; }
    var q = encodeURIComponent("trashed=false and mimeType='application/vnd.google-apps.folder' and '" + parent + "' in parents");
    var r = await driveFetch("https://www.googleapis.com/drive/v3/files?pageSize=200" +
      "&fields=files(id,name,createdTime)&orderBy=" + encodeURIComponent("createdTime desc") + "&q=" + q, {});
    if (!r.ok) return [];
    return ((await r.json()).files || []).slice();
  }
  // Keep the newest few runs; trashing a folder takes its contents with it.
  async function pruneRunFolders(keep) {
    try {
      var f = await listRunFolders();
      for (var i = keep; i < f.length; i++) {
        try { await driveFetch("https://www.googleapis.com/drive/v3/files/" + f[i].id, { method: "DELETE" }); } catch (e) {}
      }
    } catch (e) {}
  }
  // Every file of ours: the current one plus the dated copies. Looked for in the
  // visible folder AND in the old app-data space, so a device that has synced for
  // years still finds its history — the next push writes to the folder.
  async function listOurFiles() {
    var base = "trashed=false and (name='" + FILE_NAME + "' or name contains '" + SNAP_PREFIX + "')";
    var fields = "&fields=files(id,name,modifiedTime,size)&orderBy=" + encodeURIComponent("modifiedTime desc") + "&pageSize=100";
    var out = [], seen = {};
    var fid = null;
    try { fid = await ensureFolder(); } catch (e) {}
    var urls = [];
    if (fid) {
      urls.push("https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(base + " and '" + fid + "' in parents") + fields);
      var runs = await listRunFolders();
      for (var k = 0; k < runs.length && k < 20; k++) {
        urls.push("https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(base + " and '" + runs[k].id + "' in parents") + fields);
      }
    }
    urls.push("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=" + encodeURIComponent(base) + fields);   // legacy
    var okAny = false, lastCode = 0;   // NOT lastStatus — that is the module's sync state
    for (var i = 0; i < urls.length; i++) {
      var r = await driveFetch(urls[i], {});
      if (!r.ok) { lastCode = r.status; continue; }   // one space failing must not hide the other
      okAny = true;
      var j = await r.json();
      (j.files || []).forEach(function (f) { if (f && !seen[f.id]) { seen[f.id] = 1; out.push(f); } });
    }
    if (!okAny) throw new Error("Drive list failed (" + lastCode + ")");
    return out;
  }
  // What a DOWNLOAD reads: the most recent of everything we hold — normally the last
  // dated copy, or the current file when another build wrote it more recently.
  async function findFile() {
    var files = byNewest(await listOurFiles());
    return files.length ? files[0] : null;
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

  async function createFile(payloadStr, parentId) {
    return resumableUpload("POST",
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
      { name: FILE_NAME, parents: [parentId || await ensureFolder()] }, payloadStr);
  }


  // Write (or replace) one plainly-named file in the visible folder. Two steps rather
  // than a multipart body: create the metadata, then PUT the bytes — so the same code
  // handles a KMZ (binary) and a CSV (text) without hand-rolling MIME boundaries.
  async function putNamedFile(name, mime, body, parentId) {
    var fid = parentId || await ensureFolder();
    var q = encodeURIComponent("trashed=false and name='" + String(name).replace(/'/g, "\\'") + "' and '" + fid + "' in parents");
    var found = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=files(id)&pageSize=1&q=" + q, {});
    var id = "";
    if (found.ok) { var fj = await found.json(); if (fj.files && fj.files.length) id = fj.files[0].id; }
    if (!id) {
      var c = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: name, parents: [fid], mimeType: mime })
      });
      if (!c.ok) throw new Error("create " + name + " failed (" + c.status + ")");
      id = (await c.json()).id;
    }
    var put = await driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media",
      { method: "PATCH", headers: { "Content-Type": mime }, body: body });
    if (!put.ok) throw new Error("write " + name + " failed (" + put.status + ")");
  }
  // The readable copies (a .kmz per list and trip, CSV for species and checklists).
  // Built by the app, written one at a time; a failure here never fails the sync.
  async function writeReadableCopies(parentId) {
    if (!window.AppData || !window.AppData.driveExtraFiles) return;
    var files = [];
    try { files = await window.AppData.driveExtraFiles(); } catch (e) { return; }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      phase("files", f.name);
      try { await putNamedFile(f.name, f.mime, f.bytes ? new Blob([f.bytes], { type: f.mime }) : f.text, parentId); }
      catch (e) { /* one bad file must not cost the others, or the sync */ }
    }
  }
  // ---- sync orchestration ---------------------------------------------------
  // One manual pull→merge→push, run only from the Connect / Sync now buttons.
  // `options` (from the sync dialog) may narrow it: { direction, cats } where
  // direction ∈ "two"|"upload"|"download" and cats = { settings, lists, trips,
  // checklists, fetched } truthy = include. Omitted → full two-way (default).
  async function sync(options) {
    if (!connected || syncing || !clientId() || !navigator.onLine) return;
    var dir = (options && options.direction) || "two";
    // Fetched observation dots are excluded unless asked for: re-fetchable, bulky, and
    // not something the user made. Anything already on Drive is left as it is.
    var inc = (options && options.cats) || { settings: 1, lists: 1, trips: 1, checklists: 1, fetched: 0 };
    syncing = true; lastPhase = "signin"; lastPhaseName = ""; emit("syncing");
    try {
      phase("read");
      var meta = await findFile();                 // newest payload: latest dated run folder, else legacy
      var remote = meta ? await downloadFile(meta.id) : null;
      phase("merge");

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
        // Each sync gets its own dated folder holding that run's payload AND its readable
        // copies, instead of overwriting one file and leaving loose dated JSONs beside it.
        phase("write", FILE_NAME);
        var runId = await createRunFolder();
        var created = await createFile(str, runId);
        fileId = created.id; try { localStorage.setItem(LS_FILE_ID, fileId); } catch (e) {}
        await writeReadableCopies(runId);   // .kmz / .csv in the same folder, for a human to open
        await pruneRunFolders(SNAP_KEEP);   // keep the newest few runs (never fails the sync)
      }

      localDirty = false;
      lastSyncAt = Date.now();
      lastError = "";        // clear any previous failure on success
      // Record what is now safely on Drive (when, and how many points) so the app can
      // tell when the lists have grown past their last backup. A download-only sync
      // put nothing THERE, so it only stamps the time.
      try {
        if (dir !== "download" && needPush) window.AppData.markBackedUp();
        else window.GeoState.save({ gdriveLastSync: lastSyncAt });
      } catch (e) {}
      lastPhase = ""; lastPhaseName = "";
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
      // A storage failure is NOT a connection problem: reporting it as "reconnect"
      // sent the user back through Google sign-in over and over for something only
      // freeing space on the device can fix.
      var msg = (e && e.message) ? String(e.message) : "";
      fail(/storage/i.test(msg) ? "storagefull" : "reconnect", e);
    } finally {
      syncing = false;
      lastPhase = ""; lastPhaseName = "";   // a failed run must not leave the button mid-sentence
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

    // The dated history, newest first: [{ id, name, at (ms), size }]. Needs a token,
    // so it is called from an explicit user gesture (the sync dialog's Backups view),
    // never on load. Resolves [] when there is nothing yet.
    listBackups: async function () {
      if (!clientId() || !navigator.onLine) return [];
      try {
        await waitForGis(); initTokenClient(); connected = true;   // same gesture sequence as syncNow
        await ensureToken();
        // One entry per dated run folder — its name is the date, its payload is what a
        // restore reads. Folders written before v1876 have none; the loose dated JSONs
        // from then are listed after them so nothing already on Drive disappears.
        var runs = await listRunFolders(), out = [];
        for (var i = 0; i < runs.length; i++) {
          var q = encodeURIComponent("trashed=false and name='" + FILE_NAME + "' and '" + runs[i].id + "' in parents");
          var rr = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=files(id,size)&pageSize=1&q=" + q, {});
          if (!rr.ok) continue;
          var ff = (await rr.json()).files || [];
          if (!ff.length) continue;
          out.push({ id: ff[0].id, name: runs[i].name, at: Date.parse(runs[i].createdTime) || 0, size: +ff[0].size || 0 });
        }
        byNewest((await listOurFiles()).filter(function (f) { return f && String(f.name || "").indexOf(SNAP_PREFIX) === 0; }))
          .forEach(function (f) { out.push({ id: f.id, name: f.name, at: Date.parse(f.modifiedTime) || 0, size: +f.size || 0 }); });
        return out;
      } catch (e) { fail("reconnect", e); return []; }
      finally { teardown(); emit(lastStatus); }
    },
    // Put one dated backup back on this device: its settings win, collections are
    // unioned (so nothing on this device is deleted). Pull only — no push.
    restoreBackup: async function (id) {
      if (!id || !clientId() || !navigator.onLine || syncing) return false;
      syncing = true; emit("syncing");
      try {
        await waitForGis(); initTokenClient(); connected = true;
        await ensureToken();
        var data = await downloadFile(id);
        if (!data) throw new Error("backup could not be read");
        window.AppData.applyRemote(data, { incomingWins: true, interactive: false });
        lastSyncAt = Date.now(); lastError = "";
        try { window.AppData.markBackedUp(); } catch (e) {}   // restored → in step with Drive
        emit("idle");
        return true;
      } catch (e) {
        var msg = (e && e.message) ? String(e.message) : "";
        fail(/storage/i.test(msg) ? "storagefull" : "reconnect", e);
        return false;
      } finally { syncing = false; teardown(); emit(lastStatus); }
    },
    // Kept for the (now hidden) Connect button — same one-shot behaviour.
    connect: function () { return this.syncNow(); },

    // Pure helpers, exposed for verification (naming / ordering / prune choice).
    _snapName: snapName, _byNewest: byNewest, _snapsToPrune: snapsToPrune,

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
