/**
 * Sync data — the user's data as ONE payload: Export / Import (the file), the
 * Google Drive payload (buildPayload, with the point lists split into their own
 * .kmz files) and the merge of a remote payload into this device (applyRemote:
 * lists, trips, plotted dots, year and life lists, checklists, name harvest),
 * the selective-sync categories, the backup nudge and the localStorage quota
 * ladder. `window.AppData` (used by gdrive-sync.js) moves with it.
 *
 * Lifted out of app.js byte-for-byte (v2230). app.js still owns the live
 * state (detections, lists, keys) and injects what this module needs through
 * init() — same identifiers as inside the monolith; the state it reads goes
 * through getters, the two values it writes through setters.
 *
 * Exposed as window.AppSyncData (no module system; loaded via <script>).
 */
window.AppSyncData = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var cachesReady, detName, detPointFromRow, detSets, downloadCsv, fitToDetections,
      fmtBytes, linkUrl, loadAllSights, mergeDetRows, nameHarvest, refreshChecklists,
      refreshCurrentView, refreshMpPanel, reloadPlottedFromStore, renderDetListModal, renderListsModal, saveDetections,
      saveNameHarvest, saveVernacCache, sciShow, serializeDetPlot, setStatus, storeSightEntry,
      t, vernacCache;
  // … the other modules' entry points and constants, under their app.js names …
  var AppSources, EBIRD_KEY_LS, ART_KEY_LS, artKey, ebirdKey, setArtKey, setEbirdKey, mpState,
      loadMapPoints, renderMapPoints, saveMapPoints;
  // … and getters/setters for app state that changes at runtime.
  var getCustomLists, getDetPlot, getDetSetStore, getDetSetsIdbReady,
      getInterestingSpecies, getLifeList, getNhDirty, getPersistedSightings, getTaxByCode, getYearLists,
      setDetSetStore, setNhDirty;

  function init(ctx) {
    cachesReady = ctx.cachesReady;
    detName = ctx.detName;
    detPointFromRow = ctx.detPointFromRow;
    detSets = ctx.detSets;
    downloadCsv = ctx.downloadCsv;
    fitToDetections = ctx.fitToDetections;
    fmtBytes = ctx.fmtBytes;
    linkUrl = ctx.linkUrl;
    loadAllSights = ctx.loadAllSights;
    mergeDetRows = ctx.mergeDetRows;
    nameHarvest = ctx.nameHarvest;
    refreshChecklists = ctx.refreshChecklists;
    refreshCurrentView = ctx.refreshCurrentView;
    refreshMpPanel = ctx.refreshMpPanel;
    reloadPlottedFromStore = ctx.reloadPlottedFromStore;
    renderDetListModal = ctx.renderDetListModal;
    renderListsModal = ctx.renderListsModal;
    saveDetections = ctx.saveDetections;
    saveNameHarvest = ctx.saveNameHarvest;
    saveVernacCache = ctx.saveVernacCache;
    sciShow = ctx.sciShow;
    serializeDetPlot = ctx.serializeDetPlot;
    setStatus = ctx.setStatus;
    storeSightEntry = ctx.storeSightEntry;
    t = ctx.t;
    vernacCache = ctx.vernacCache;
    AppSources = ctx.AppSources;
    EBIRD_KEY_LS = ctx.EBIRD_KEY_LS;
    ART_KEY_LS = ctx.ART_KEY_LS;
    setArtKey = ctx.setArtKey;
    setEbirdKey = ctx.setEbirdKey;
    mpState = ctx.mpState;
    loadMapPoints = ctx.loadMapPoints;
    renderMapPoints = ctx.renderMapPoints;
    saveMapPoints = ctx.saveMapPoints;
    artKey = ctx.artKey;
    ebirdKey = ctx.ebirdKey;
    getCustomLists = ctx.getCustomLists;
    getDetPlot = ctx.getDetPlot;
    getDetSetStore = ctx.getDetSetStore;
    getDetSetsIdbReady = ctx.getDetSetsIdbReady;
    getInterestingSpecies = ctx.getInterestingSpecies;
    getLifeList = ctx.getLifeList;
    getNhDirty = ctx.getNhDirty;
    getPersistedSightings = ctx.getPersistedSightings;
    getTaxByCode = ctx.getTaxByCode;
    getYearLists = ctx.getYearLists;
    setDetSetStore = ctx.setDetSetStore;
    setNhDirty = ctx.setNhDirty;
  }

  // ---- Cross-device share: Export / Import the user's data ------------------
  // Settings, checklists, eBird key, interesting list, plotted points —
  // anything held in our two localStorage entries. The H3 range cache is left
  // out (large, fully reconstructible). Imports MERGE checklists by id and
  // append log entries (deduped by entry id), so observations made on either
  // device survive a round-trip.
  // The full transportable snapshot of the user's data — shared by the file
  // Export and the Google Drive sync. `state.updatedAt` (stamped by GeoState on
  // every write) rides along as the local "version" used to order sync writes.
  // Which categories the sync dialog is set to include. Defaults match the dialog's own
  // defaults, so a payload built before the dialog is ever opened behaves the same.
  function syncCatOn(cat) {
    var saved = window.GeoState.get("syncOpts", null) || {};
    var cats = saved.cats || { settings: 1, lists: 1, trips: 1, checklists: 1, fetched: 0 };
    return !!cats[cat];
  }
  function buildPayload() {
    // Flush the live map first so EVERY push includes the dots/stars and pins
    // currently on screen — even on the first sync (no remote file yet), where
    // applyRemote (which also flushes) never runs. This is what lets plotted
    // detections sync directly, without saving them as a named set first.
    try { if (typeof getDetPlot() !== "undefined" && Object.keys(getDetPlot()).length) saveDetections(); } catch (e) {}
    try { if (typeof saveMapPoints === "function") saveMapPoints(); } catch (e) {}
    var state = {};
    try { state = JSON.parse(localStorage.getItem(window.GeoState.storageKey) || "{}"); } catch (e) {}
    delete state.offlineAreas;   // the downloaded map areas are THIS device's: never in a payload (owner, 2026-11-01)
    // Belt-and-braces: take the plotted detections straight from memory too, so a
    // large on-screen set still syncs even if the localStorage write above was
    // rejected (e.g. quota) and the round-tripped copy is stale/missing.
    try { if (typeof getDetPlot() !== "undefined" && Object.keys(getDetPlot()).length) state.mapDetections = capDetections(serializeDetPlot(), DET_CAP); } catch (e) {}
    // Saved trips now live in IndexedDB (mirrored in detSetStore), not the blob —
    // re-attach them so the Drive payload shape is unchanged.
    try { if (typeof getDetSetStore() !== "undefined") state.mapDetectionSets = getDetSetStore().filter(function (s) { return s && s.name; }); } catch (e) {}
    // Named point lists moved to IndexedDB too — re-attach them so the Drive payload
    // shape (and every existing backup) is unchanged.
    // A list flagged "don't sync" stays on this device. Safe to omit: mergePointSets starts
    // from the LOCAL sets and only adds/merges incoming ones, so a list missing from the
    // payload is never dropped — and reference data you can re-import at will is exactly what
    // should not travel. The biggest generated list alone is over half the payload.
    try {
      if (mpState.mpIdbReady && mpState.mpIdbReady())
        state.mapPointSets = mpState.mpCollections().filter(function (c) { return c && c.name && !c.noSync && !c.viewOnly; });   // a view-only (received) list never leaves the device
    } catch (e) {}
    // Names the user's own use has accumulated — harvested from iNaturalist, and the
    // extra vernaculars — live in IndexedDB and were never in the payload, so every
    // new device started collecting them again from scratch.
    try { var nh = nameHarvest(); if (nh && Object.keys(nh).length) state.nameHarvest = nh; } catch (e) {}
    try { var vc = vernacCache(); if (vc && Object.keys(vc).length) state.extraVernac = vc; } catch (e) {}
    // The fetched observations are the biggest thing the app holds, so they ride along
    // ONLY when the "Fetched points" box is ticked (see SYNC_CAT_KEYS.fetched).
    try {
      if (syncCatOn("fetched") && typeof getPersistedSightings() !== "undefined" && getPersistedSightings()) {
        state.sightingsCache = getPersistedSightings();   // the sync / export loads every stored record first (loadAllSights)
      }
    } catch (e) {}
    return {
      app: "migration_calendar",
      version: 1,
      exportedAt: new Date().toISOString(),
      state: state,
      ebirdKey: localStorage.getItem(EBIRD_KEY_LS) || "",
      artdbKey: localStorage.getItem(ART_KEY_LS) || "",
      // The user's own OAuth client id, typed by hand — worth carrying to a new device.
      // "gdrive-file-id" and "gdrive-folder-id" are deliberately NOT here: they name
      // objects in one account's Drive and must stay device-local.
      gdriveClientId: localStorage.getItem("gdrive-client-id") || ""
    };
  }
  // ---- "your lists have grown since the last backup" -------------------------
  // Point lists are the data users mind losing most, and nothing in the browser
  // survives an uninstall — so when they have grown since the last sync and an hour
  // has passed, the gear shows a small orange ! and the Sync button turns orange.
  var BACKUP_DUE_MS = 3600000;
  // Points SAVED INTO A LIST — the data this nudge is about. Loose working pins are
  // not counted (the panel already shows its own "unsaved" banner for those), and
  // fetched observations are not points at all.
  function storedPointCount() {
    var n = 0;
    try { (mpState.mpCollections() || []).forEach(function (c) { n += mpState.collCount(c); }); } catch (e) {}
    return n;
  }
  // Called by the sync transport when a push (or a restore) has put this device and
  // Drive in step: remember when, and how much was in it.
  function markBackedUp() {
    window.GeoState.save({ gdriveLastSync: Date.now(), gdriveSyncPts: storedPointCount() });
    try { updateBackupNudge(); } catch (e) {}
  }
  function backupState() {
    var at = +window.GeoState.get("gdriveLastSync", 0) || 0;
    var was = +window.GeoState.get("gdriveSyncPts", 0) || 0;
    var now = storedPointCount();
    // No stamp means UNKNOWN, not "never backed up": before v1779 the sync time was
    // never persisted, so every device that had synced for years looked unsynced and
    // lit the warning at once. With no stamp we start watching from now — the baseline
    // is today's count — and only speak up once the lists GROW past it.
    var from = at;
    if (!at) {
      from = +window.GeoState.get("gdriveWatchFrom", 0) || 0;
      if (!from) { from = Date.now(); window.GeoState.save({ gdriveWatchFrom: from, gdriveSyncPts: now }); was = now; }
    }
    var due = now > 0 && now > was && Date.now() - from > BACKUP_DUE_MS;
    return { at: at, pts: now, was: was, due: due, from: from };
  }
  // A sync runs while the Settings panel is usually shut, so its spinner and progress bar
  // are out of sight. This is the one indicator that is always on screen: a turning ⟳ in
  // the corner for as long as the sync is busy, with the step and the file count beside it.
  // Registered at boot, independent of the Settings wiring, so it works even if that panel
  // is never opened.
  // The sync used to also raise a floating tile over the page (#sync-spinner). It said
  // exactly what the Settings sync button already says — the phase, the file being written,
  // the "3/12" count — next to a progress bar that says the rest, so it was one more thing
  // covering the map for no information. Removed on request; any leftover tile from a
  // previous version is cleared on the next status event.
  function wireSyncSpinner() {
    if (!window.GDriveSync || !window.GDriveSync.onStatus) return;
    window.GDriveSync.onStatus(function () {
      var el = document.getElementById("sync-spinner");
      if (el) el.remove();
    });
  }
  function updateBackupNudge() {
    var st = backupState();
    var gear = document.getElementById("settings-toggle");
    if (gear) {
      gear.classList.toggle("backup-due", st.due);
      if (st.due) gear.title = t("sync.backupDue"); else gear.title = t("ctrl.settingsHold");
    }
    var sb = document.getElementById("gd-sync");
    if (sb) { sb.classList.toggle("backup-due", st.due); sb.title = st.due ? t("sync.backupDue") : ""; }
    var line = document.getElementById("mp-backup-line");
    if (line) {
      // The "last backed up to Drive …" sentence was removed (2026-09-24): it sat in the
      // Points panel on every open saying nothing the user could act on. The overdue
      // nudge stays — that one asks for something.
      line.textContent = st.due ? t("sync.backupDue") : "";
      line.classList.toggle("backup-due", st.due);
    }
  }
  function exportAppData() {
    mpState.whenAllLoaded().then(cachesReady).then(function () { return syncCatOn("fetched") ? loadAllSights() : null; }).then(function () {   // lists (and fetched records) load lazily: a backup must hold them whole
      if (mpState.anyLazy()) return;
      downloadCsv("BirdsWhere_backup_" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(buildPayload(), null, 2), "application/json;charset=utf-8;");
    });
  }
  function mergeChecklists(local, incoming) {
    var out = {}; Object.keys(local || {}).forEach(function (k) { out[k] = local[k]; });
    Object.keys(incoming || {}).forEach(function (id) {
      var inc = incoming[id]; if (!inc) return;
      if (!out[id]) { out[id] = inc; return; }
      var loc = out[id];
      // Merge log: append entries from incoming that we don't already have (by id).
      var ids = Object.create(null); (loc.log || []).forEach(function (e) { if (e && e.id) ids[e.id] = 1; });
      (inc.log || []).forEach(function (e) { if (e && e.id && !ids[e.id]) { (loc.log = loc.log || []).push(e); ids[e.id] = 1; } });
      if (loc.log) loc.log.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      // Union the seen-flags map.
      loc.seen = loc.seen || {}; Object.keys(inc.seen || {}).forEach(function (k) { if (inc.seen[k]) loc.seen[k] = true; });
      // Prefer the more recently accessed side's title + accessedAt.
      if ((inc.accessedAt || 0) > (loc.accessedAt || 0)) {
        if (inc.title) loc.title = inc.title;
        loc.accessedAt = inc.accessedAt;
      } else if (!loc.title && inc.title) { loc.title = inc.title; }
      // Carry country-list rows through if local doesn't have them.
      if (inc.rows && !loc.rows) loc.rows = inc.rows;
      if (inc.kind === "country" && !loc.kind) loc.kind = inc.kind;
      out[id] = loc;
    });
    return out;
  }
  // Loose (unsaved) pins for a stored state = the working set, but only when no
  // named list is active (an active working set IS that list, already in sets).
  function loosePointsOf(state) {
    if (!state || state.mapPointSetActive) return [];
    return Array.isArray(state.mapPoints) ? state.mapPoints : [];
  }
  // Union two pin arrays, de-duping by id (idempotent re-imports don't pile up).
  function mergePins(a, b) {
    var seen = Object.create(null), out = [];
    (a || []).concat(b || []).forEach(function (p) {
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return;
      var id = p.id || (p.lat + "," + p.lon + "|" + (p.name || ""));
      if (seen[id]) return; seen[id] = 1; out.push(p);
    });
    return out;
  }
  // Merge incoming named lists into local: same-named lists ask the user to
  // merge (union the pins) or overwrite (replace with the imported list).
  // `interactive` false (background Drive sync) skips the prompt and always
  // unions — a sync must never silently drop a device's pins.
  // A list's own fields travel with it — folder, order, shared, protection … — not only its
  // name and points (owner, 2026-10-02: "when syncing to gdrive preserve the folder structure").
  // Local metadata is kept; whatever the local copy lacks is taken from the incoming one.
  function withMeta(c) {
    var o = { name: c.name, points: (c.points || []).slice() };
    Object.keys(c).forEach(function (k) { if (k !== "points" && k !== "name" && c[k] != null) o[k] = c[k]; });
    return o;
  }
  function mergePointSets(localSets, incSets, interactive, incomingWins, replace) {
    var out = (Array.isArray(localSets) ? localSets : []).map(withMeta);
    var byName = Object.create(null); out.forEach(function (c) { byName[c.name] = c; });
    (Array.isArray(incSets) ? incSets : []).forEach(function (inc) {
      if (!inc || !inc.name) return;
      var cur = byName[inc.name];
      if (inc._same) return;   // identical to this device's copy — not downloaded, kept as it is
      if (!cur) { var added = withMeta(inc); delete added.file; delete added.n; delete added.psig; out.push(added); byName[inc.name] = added; return; }
      // (file / n / psig are a Drive payload's reference fields — an older build echoes them back; never a list's own)
      Object.keys(inc).forEach(function (k) { if (k !== "points" && k !== "name" && k !== "file" && k !== "n" && k !== "psig" && cur[k] == null && inc[k] != null) cur[k] = inc[k]; });
      // A ROUTE's order is its content (owner, 2026-10-04): when the incoming copy is the
      // newer one, its stop order wins (local-only stops append); otherwise the local order
      // stays. A plain list keeps the local-first union as before.
      var isRoute = !!(inc.route || cur.route) || ((inc.points || []).length > 0 && (inc.points || []).every(function (p) { return p && p.source === "route"; }));
      if (isRoute) cur.route = true;
      if (replace) cur.points = (inc.points || []).slice();   // a download: Drive's copy of the list is the truth
      else if (!interactive || confirm(t("sync.listMergePrompt", { name: inc.name }))) cur.points = (isRoute && incomingWins) ? mergePins(inc.points, cur.points) : mergePins(cur.points, inc.points);
      else cur.points = (inc.points || []).slice();
    });
    return out;
  }
  // Merge a parsed payload into local storage and return a summary of the merge.
  // Collections (checklists, loose pins, named lists) are ALWAYS unioned so no
  // observation is ever lost, regardless of direction. Scalar settings follow
  // `opts.incomingWins`: true → incoming overrides local (file import, and Drive
  // pulls where the remote copy is newer); false → local is kept (Drive pushes
  // where the local copy is newer). `opts.interactive` gates the same-named
  // list merge/replace prompt (off for background sync). Writes straight to
  // localStorage (bypassing GeoState) so it does not re-trigger a sync push.
  // Total observation rows across a mapDetections object (used to tell whether a
  // sync actually brought in new dots, so we only re-fit the map when it did).
  function detRowCount(m) { var n = 0; Object.keys(m || {}).forEach(function (k) { n += ((m[k] || {}).rows || []).length; }); return n; }
  var DET_CAP = 15000;   // max stored/synced detection rows — keep the newest, drop the oldest
  // Cap a mapDetections object to the newest `max` observation rows, dropping the
  // OLDEST first (by date). Lists / year-life lists / checklists / points are
  // small and are never capped — only the bulky detection dots are bounded so
  // the whole store stays under the localStorage quota.
  function capDetections(det, max) {
    if (!det) return {};
    var all = [];
    Object.keys(det).forEach(function (k) {
      var e = det[k] || {};
      (e.rows || []).forEach(function (r) { all.push({ k: k, r: r, t: (r && Date.parse(r.date)) || 0 }); });
    });
    if (all.length <= max) return det;
    // Round-robin over the fetched areas (newest first within each) so a trim keeps
    // every area represented — a plain newest-first cut dropped whole older areas,
    // which came back from storage as outlines with no dots.
    var byArea = Object.create(null), aOrder = [];
    all.forEach(function (x) {
      var a = (x.r && x.r._areas && x.r._areas[0]) || "";
      if (!byArea[a]) { byArea[a] = []; aOrder.push(a); }
      byArea[a].push(x);
    });
    aOrder.forEach(function (a) { byArea[a].sort(function (p, q) { return q.t - p.t; }); });
    var kept = [], i2 = 0, guard2 = 0;
    while (kept.length < max && guard2++ < 1e7) {
      var got = false;
      for (var gi = 0; gi < aOrder.length && kept.length < max; gi++) {
        var arr = byArea[aOrder[gi]];
        if (i2 < arr.length) { kept.push(arr[i2]); got = true; }
      }
      if (!got) break;
      i2++;
    }
    all = kept;
    var out = {};
    all.forEach(function (x) {
      var src = det[x.k];
      if (!out[x.k]) out[x.k] = { key: src.key, name: src.name, color: src.color, cls: src.cls || "", rows: [] };
      out[x.k].rows.push(x.r);
    });
    return out;
  }
  // Persist the merged state, never losing the small/important data: try the
  // detection cap, then progressively smaller caps on a quota error, only ever
  // trimming mapDetections (oldest first). Lists, year/life lists, checklists,
  // points and settings are written untouched. Returns the rows actually kept.
  // Keys that are pure CACHES: dropping one costs a re-fetch and nothing else.
  // Same set the Settings → Storage "clear cached data" buttons offer, minus the
  // ones that live in IndexedDB or the Cache API.
  var REBUILDABLE_KEYS = ["spImages", "extraVernac", "ebirdHotspots", "errorLog", "gbifLearnedScopes", "nameHarvest", "sightingsCache"];
  function dropRebuildable(o) {
    var n = 0;
    REBUILDABLE_KEYS.forEach(function (k) { if (o[k] != null) { delete o[k]; n++; } });
    return n;
  }
  // The biggest keys in a state object — named in the error when a write cannot be
  // made to fit, so "storage full" says WHAT is full.
  function biggestStateKeys(o, n) {
    var sizes = Object.keys(o || {}).map(function (k) {
      var b = 0; try { b = JSON.stringify(o[k]).length; } catch (e) {}
      return { k: k, b: b };
    }).sort(function (a, b) { return b.b - a.b; }).slice(0, n || 3);
    return sizes.map(function (x) { return x.k + " " + fmtBytes(x.b); }).join(", ");
  }
  function writeStateCapped(obj) {
    // Each rung frees more than the last: the oldest plotted detections first, then
    // the rebuildable caches, then the rarity list. Lists, year/life lists,
    // checklists, points and settings are NEVER trimmed — that is the whole point of
    // this ladder. (A sync merges BOTH devices' data, so the write it has to make fit
    // is bigger than either side alone; before the cache rungs existed, a full store
    // meant a sync that could never succeed, reported as a Drive problem.)
    var steps = [
      { cap: DET_CAP }, { cap: 8000 }, { cap: 4000 }, { cap: 1500 }, { cap: 0 },
      { cap: 0, caches: 1 }, { cap: 0, caches: 1, rar: 200 }, { cap: 0, caches: 1, rar: 50 }, { cap: 0, caches: 1, rar: 0 }
    ];
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i];
      var o = {}; for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k];
      o.mapDetections = capDetections(obj.mapDetections, st.cap);
      if (st.caches) dropRebuildable(o);
      if (st.rar != null && o.rarityList && o.rarityList.length > st.rar) o.rarityList = o.rarityList.slice(0, st.rar);
      try { localStorage.setItem(window.GeoState.storageKey, JSON.stringify(o)); window.GeoState.invalidate(); try { AppSources.invalidate(); } catch (e3) {} return detRowCount(o.mapDetections); }
      catch (e) { /* quota — free more and retry */ }
    }
    throw new Error("storage full; biggest: " + biggestStateKeys(obj, 3));
  }
  // Quota safety net for EVERY GeoState.save: if a write is too big, drop the
  // oldest plotted detections (never the lists/starred/points/settings) and retry
  // — so a year/life-list or star toggle is never lost just because the detection
  // store filled localStorage.
  if (window.GeoState && window.GeoState.setQuotaTrim) {
    window.GeoState.setQuotaTrim(function (state, attempt) {
      var caps = [DET_CAP, 8000, 4000, 1500, 500, 0];
      if (attempt >= caps.length) return null;
      var o = {}; for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) o[k] = state[k];
      o.mapDetections = capDetections(o.mapDetections, caps[attempt]);
      // The rarity list is the other store that grows on its own (500 groups × 15
      // records, with notes and photo URLs). It was never in this ladder, so a fat
      // alert list made EVERY write fail — stars, lists, settings — not just its own.
      var rarCaps = [500, 300, 200, 100, 50, 25];
      if (o.rarityList && o.rarityList.length > rarCaps[attempt]) o.rarityList = o.rarityList.slice(0, rarCaps[attempt]);
      if (attempt >= 3) dropRebuildable(o);   // last resorts: the caches cost only a re-fetch
      return o;
    });
  }
  // Merge two saved mapDetections objects (the plotted dots/stars): union each
  // species' observation rows (deduped) so a sync combines both devices' pins.
  function mergeDetections(a, b) {
    a = a || {}; b = b || {}; var out = {};
    Object.keys(a).forEach(function (k) { var e = a[k] || {}; out[k] = { key: e.key || k, name: e.name || "", color: e.color, cls: e.cls || "", rows: (e.rows || []).slice() }; });
    Object.keys(b).forEach(function (k) {
      var e = b[k] || {};
      if (!out[k]) out[k] = { key: e.key || k, name: e.name || "", color: e.color, cls: e.cls || "", rows: (e.rows || []).slice() };
      else { out[k].rows = mergeDetRows(out[k].rows, e.rows); if (!out[k].name) out[k].name = e.name; if (!out[k].cls) out[k].cls = e.cls; }
    });
    return out;
  }
  // Durable-write register. applyRemote's IndexedDB writes are async; anything that
  // navigates straight afterwards must wait for them, or the merge is only ever in memory.
  var pendingIdbWrites = [];
  function flushWrites() {
    var w = pendingIdbWrites; pendingIdbWrites = [];
    if (!w.length) return Promise.resolve();
    return Promise.all(w.map(function (p) { return Promise.resolve(p).catch(function () {}); }));
  }
  function applyRemote(data, opts) {
    opts = opts || {};
    if (!data || data.app !== "migration_calendar") throw new Error(t("sync.notBackup"));
    // The list store not readable yet (IndexedDB blocked): the merge would see NO local lists and
    // the result would stand in for them — never merge then (owner, 2026-10-10: lists must never go).
    if (window.AppIDB && window.AppIDB.available() && mpState.mpIdbReady && !mpState.mpIdbReady()) throw new Error("lists still loading");
    // A list that is only a file reference (a Drive payload opened without its .kmz files)
    // has no points to merge — and merging it would stamp its file fields onto a local list.
    if (data.state && Array.isArray(data.state.mapPointSets) && data.state.mapPointSets.some(isListRef)) {
      var refNames = data.state.mapPointSets.filter(isListRef).map(function (e) { return e.name; });
      data.state.mapPointSets = data.state.mapPointSets.filter(function (e) { return !isListRef(e); });
      // Say so: a Drive-folder JSON imported as a file carries only the lists' NAMES — silently
      // dropping them looked like a restore that lost the lists (compat audit, 2026-11-01).
      if (refNames.length) try { setStatus(t("sync.importRefs", { n: refNames.length, names: refNames.slice(0, 3).join(", ") + (refNames.length > 3 ? "\u2026" : "") }), true); } catch (e) {}
    }
    // Flush the live map (plotted dots/stars) to storage FIRST, so the merge
    // unions the points the user is currently looking at — not just the last
    // explicitly-saved snapshot. Without this a sync could drop on-screen dots.
    try { if (typeof getDetPlot() !== "undefined" && Object.keys(getDetPlot()).length) saveDetections(); } catch (e) {}
    try { if (typeof saveMapPoints === "function") saveMapPoints(); } catch (e) {}   // same for the live map points
    var local = {}; try { local = JSON.parse(localStorage.getItem(window.GeoState.storageKey) || "{}"); } catch (e) {}
    // Saved trips live in IndexedDB now, not the blob — merge against the live mirror.
    try { if (typeof getDetSetStore() !== "undefined") local.mapDetectionSets = getDetSetStore().filter(function (s) { return s && s.name; }); } catch (e) {}
    // Named point lists too: without this the merge would see NO local lists (the blob
    // no longer carries them) and "merge" would mean "replace with the other device's".
    try { if (mpState.mpIdbReady && mpState.mpIdbReady()) local.mapPointSets = mpState.mpCollections().filter(function (c) { return c && c.name && !c.viewOnly; }); } catch (e) {}
    var viewOnlyKept = mpState.mpCollections().filter(function (c) { return c && c.viewOnly; });   // session-only received lists: kept on screen, never merged or stored
    var incoming = data.state || {};
    var mergedCl = mergeChecklists(local.fieldChecklists, incoming.fieldChecklists);
    // Map points: merge rather than overwrite. Loose pins from both sides are
    // unioned into the working set; named lists are merged/overwritten by name.
    var mergedLoose = mergePins(loosePointsOf(local), loosePointsOf(incoming));
    var mergedSets = mergePointSets(local.mapPointSets, incoming.mapPointSets, opts.interactive, !!opts.incomingWins, !!opts.replaceLists);
    // Plotted detections (dots/stars) and the starred-species list: union both
    // sides so syncing merges pins instead of one device overwriting the other.
    var localDetN = detRowCount(local.mapDetections);
    var mergedDet = mergeDetections(local.mapDetections, incoming.mapDetections);
    var gainedDet = detRowCount(mergedDet) > localDetN;   // sync pulled in new dots → re-fit to show them
    var interestUnion = {}; (local.interesting || []).concat(incoming.interesting || []).forEach(function (k) { if (k) interestUnion[k] = 1; });
    // Year + life lists: union the life list, and union each year's set by year.
    var lifeUnion = {}; (local.lifeList || []).concat(incoming.lifeList || []).forEach(function (k) { if (k) lifeUnion[k] = 1; });
    var yearMerge = {};
    [local.yearLists, incoming.yearLists].forEach(function (yl) {
      Object.keys(yl || {}).forEach(function (y) { yearMerge[y] = yearMerge[y] || {}; (yl[y] || []).forEach(function (k) { if (k) yearMerge[y][k] = 1; }); });
    });
    var yearMergeArr = {}; Object.keys(yearMerge).forEach(function (y) { yearMergeArr[y] = Object.keys(yearMerge[y]); });
    // The user's own named lists: union by name, exactly as the year lists are.
    var custMerge = {};
    [local.customLists, incoming.customLists].forEach(function (cl) {
      Object.keys(cl || {}).forEach(function (n) { custMerge[n] = custMerge[n] || {}; (cl[n] || []).forEach(function (k) { if (k) custMerge[n][k] = 1; }); });
    });
    var custMergeArr = {}; Object.keys(custMerge).forEach(function (n) { custMergeArr[n] = Object.keys(custMerge[n]); });
    // Learned families (for dot colours): union both sides so a species keeps the
    // family — and therefore the colour — learned on either device.
    var mergedFam = {}; [local.detFamilies, incoming.detFamilies].forEach(function (m) { Object.keys(m || {}).forEach(function (k) { if (m[k]) mergedFam[k] = m[k]; }); });
    // Named detection sets ("trips"): tombstoned names are dropped on both sides
    // (so a delete sticks); the rest are unioned by name (same name → union dots
    // and stars), so every device's saved trips survive the merge.
    var setTomb = {}; [local.mapDetectionSetsDel, incoming.mapDetectionSetsDel].forEach(function (a) { (a || []).forEach(function (n) { if (n) setTomb[n] = 1; }); });
    var setByName = Object.create(null), setOrder = [];
    [local.mapDetectionSets, incoming.mapDetectionSets].forEach(function (arr) {
      (Array.isArray(arr) ? arr : []).forEach(function (s) {
        if (!s || !s.name || setTomb[s.name]) return;
        var cur = setByName[s.name];
        if (!cur) { setByName[s.name] = { name: s.name, createdAt: s.createdAt || 0, detections: s.detections || {}, interesting: (s.interesting || []).slice() }; setOrder.push(s.name); }
        else {
          cur.detections = mergeDetections(cur.detections, s.detections);
          var iu = {}; cur.interesting.concat(s.interesting || []).forEach(function (k) { if (k) iu[k] = 1; }); cur.interesting = Object.keys(iu);
          cur.createdAt = Math.max(cur.createdAt, s.createdAt || 0);
        }
      });
    });
    var mergedSetsList = setOrder.map(function (n) { return setByName[n]; });
    // Which lists are SHOWN is THIS device's business: a sync must not draw a list on
    // the map because another device had it ticked. It used to union both sides — so a
    // sync could silently cover the map with lists the user had never shown here.
    // (Detection sets still union; they are trips, and a synced trip you cannot see
    // looks like a failed sync.)
    var setNames = {}; mergedSets.forEach(function (c) { setNames[c.name] = 1; });
    var shownUnion = {}; (Array.isArray(local.mapPointsShownColls) ? local.mapPointsShownColls : [])
      .forEach(function (n) { if (n && setNames[n]) shownUnion[n] = 1; });
    var detSetNames = {}; mergedSetsList.forEach(function (s) { detSetNames[s.name] = 1; });
    var detShownUnion = {}; [local.mapDetSetsShown, incoming.mapDetSetsShown].forEach(function (a) { (Array.isArray(a) ? a : []).forEach(function (n) { if (n && detSetNames[n]) detShownUnion[n] = 1; }); });
    // Scalar settings: the winning side overrides, the other fills any gaps.
    var primary = opts.incomingWins ? incoming : local;
    var secondary = opts.incomingWins ? local : incoming;
    var newState = {}; Object.keys(secondary).forEach(function (k) { newState[k] = secondary[k]; });
    Object.keys(primary).forEach(function (k) { newState[k] = primary[k]; });
    // A synced/imported payload is untrusted: force every link URL it carries to a
    // safe http(s) form before it lands in localStorage (else a `javascript:` URL in
    // blogLinks/countryLinks/gbifDatasets would be a persistent XSS when rendered).
    ["blogLinks", "countryLinks", "customCountryUrls"].forEach(function (k) {
      if (!Array.isArray(newState[k])) return;
      newState[k] = newState[k].filter(function (e) { return e && e.cc && linkUrl(e.url); })
        .map(function (e) { return { cc: e.cc, url: linkUrl(e.url), label: e.label }; });
    });
    if (Array.isArray(newState.gbifDatasets)) {
      newState.gbifDatasets = newState.gbifDatasets.map(function (d) {
        return (d && d.url) ? { key: d.key, name: d.name, url: linkUrl(d.url), country: d.country } : d;
      });
    }
    // A source's endpoint travels with the settings, and the adapters attach the user's API
    // key to whatever URL is stored — so an endpoint that is NOT this device's own is kept
    // only on that source's default host; anything else falls back to the default
    // (security review, 2026-11-01).
    if (Array.isArray(newState.directSources)) {
      var mineUrl = {}; (Array.isArray(local.directSources) ? local.directSources : []).forEach(function (s) { if (s && s.id) mineUrl[s.id] = s.url; });
      var host = function (x) { var m = /^https?:\/\/([^\/?#]+)/i.exec(x || ""); return m ? m[1].toLowerCase() : ""; };
      newState.directSources = newState.directSources.map(function (s) {
        if (!s || !s.id || s.url === mineUrl[s.id]) return s;
        var d = (AppSources.DIRECT_BY_ID || {})[s.id], du = (d && d.url) || "", u = linkUrl(s.url);
        if (!u || !du || host(u) !== host(du)) u = du;
        var o = {}; Object.keys(s).forEach(function (k) { o[k] = s[k]; }); o.url = u; return o;
      });
    }
    // Secrets fill a gap, never replace: this device's TinyURL token stays whatever wins.
    if (local.tinyApiToken) newState.tinyApiToken = local.tinyApiToken;
    // The downloaded offline map areas are device-local — another device's list must never
    // replace this one's (its areas would vanish from Settings while their tiles stayed
    // on the disk); the owner wants areas deleted by hand only (2026-11-01).
    if (local.offlineAreas != null) newState.offlineAreas = local.offlineAreas; else delete newState.offlineAreas;
    // Rarity alerts: merged FIELD-WISE, never as one blob. The preferences — the email
    // address, the interval, the threshold, which sources, the sound — travel like any
    // other setting, while the bookkeeping stays this device's own: copying a seen-set
    // or a seeded-locations map across devices would either re-announce everything or
    // silence a device that has never polled.
    (function () {
      var lr = (local && local.rarityAlerts) || null, ir = (incoming && incoming.rarityAlerts) || null;
      if (!lr && !ir) return;
      lr = lr || {}; ir = ir || {};
      var PREFS = ["enabled", "intervalMin", "probPct", "showDays", "showMap", "allSources",
        "countryWide", "sound", "sysNotif"];   // the e-mail address fills a gap only (below) — an import never redirects the alerts
      var MINE = ["seen", "seeded", "lastPoll", "lastEmail", "emailState", "emailAt", "emailKind", "emailCount"];
      var win = opts.incomingWins ? ir : lr, other = opts.incomingWins ? lr : ir;
      var out = {}; Object.keys(lr).forEach(function (k) { out[k] = lr[k]; });
      PREFS.forEach(function (k) {
        var v = (win[k] !== undefined) ? win[k] : other[k];
        if (v !== undefined) out[k] = v;
      });
      // An older device's threshold lived in probMaxPct (before it was unified onto probPct): carry it
      // when nothing newer says otherwise, so a restore does not reset the alerts to 15 % (compat audit, 2026-11-01).
      if (out.probPct == null) { var pm = (win.probMaxPct != null) ? win.probMaxPct : other.probMaxPct; if (pm != null) out.probPct = pm; }
      if (!out.email && ir.email) out.email = ir.email;
      // The address ALSO fills in when this device simply has none — the same rule the
      // eBird key follows, so a second device picks it up without forcing a download.
      if (!String(out.email || "").trim() && String(ir.email || "").trim()) out.email = ir.email;
      MINE.forEach(function (k) { if (lr[k] !== undefined) out[k] = lr[k]; else delete out[k]; });
      // A different address than this device was using starts with a clean mail state:
      // "not confirmed yet" for someone else's address would be a lie.
      if (String(out.email || "").trim() !== String(lr.email || "").trim()) {
        out.emailState = ""; out.emailAt = 0; out.emailKind = ""; out.emailCount = 0;
      }
      newState.rarityAlerts = out;
    })();
    // The merged collections override either side's copy.
    newState.fieldChecklists = mergedCl;
    // Merged lists go to IndexedDB (and out of the blob) when that is the store — the
    // union of two devices' lists is exactly the write that used to break the sync.
    if (mpState.mpIdbReady && mpState.mpIdbReady()) {
      mpState.setMpCollections(mergedSets.concat(viewOnlyKept));
      // Collected, not fired and forgotten: a caller about to reload (or a user about to
      // close the app) waits on these through AppData.flushWrites(), or the synced lists
      // are lost with the transaction.
      try { pendingIdbWrites.push(window.AppPoints.persistMpSets(mergedSets, { onProgress: opts.onProgress })); } catch (e) {}   // onProgress: the sync's "Storing lists n/m" bar
      delete newState.mapPointSets;
    } else newState.mapPointSets = mergedSets;
    newState.mapDetections = mergedDet;
    newState.interesting = Object.keys(interestUnion);
    newState.lifeList = Object.keys(lifeUnion);
    newState.yearLists = yearMergeArr;
    newState.customLists = custMergeArr;
    newState.detFamilies = mergedFam;
    // Blogs: UNION the user-added links (by cc|url) and the removed-tombstones across
    // both sides, so a blog added/deleted on one device isn't clobbered by the other.
    // URLs are sanitised at union time (linkUrl) — a synced payload is untrusted.
    var blogLinkUnion = {};
    (local.blogLinks || []).concat(incoming.blogLinks || []).forEach(function (b) {
      if (!b || !b.cc) return; var u = linkUrl(b.url); if (!u) return;
      var k = String(b.cc).toUpperCase() + "|" + u;
      if (!blogLinkUnion[k]) blogLinkUnion[k] = { cc: String(b.cc).toUpperCase(), url: u, label: b.label };
    });
    var blogRemovedUnion = {};
    (local.blogRemoved || []).concat(incoming.blogRemoved || []).forEach(function (k) { if (k) blogRemovedUnion[k] = 1; });
    newState.blogLinks = Object.keys(blogLinkUnion).map(function (k) { return blogLinkUnion[k]; });
    newState.blogRemoved = Object.keys(blogRemovedUnion);
    // Trips: update the in-memory mirror and persist to IndexedDB (write the merged
    // ones, delete tombstoned ones); keep them OUT of the localStorage blob so it
    // doesn't re-bloat. Fallback (no IDB) keeps them in the blob as before.
    setDetSetStore(mergedSetsList);
    if (getDetSetsIdbReady() && window.AppIDB) {
      // Surface a storage-full failure rather than silently dropping a synced trip
      // (matches persistDetSet): a failed write leaves the trip in the in-memory
      // mirror but not durable, so flag it instead of swallowing the rejection.
      var onIdbErr = function () { setStatus(t("err.storageFull")); };
      mergedSetsList.forEach(function (s) { if (s && s.name) pendingIdbWrites.push(window.AppIDB.put("set:" + s.name, s).then(null, onIdbErr)); });
      Object.keys(setTomb).forEach(function (n) { pendingIdbWrites.push(window.AppIDB.del("set:" + n).then(null, onIdbErr)); });
      delete newState.mapDetectionSets;   // trips live in IDB; keep them out of the blob (the scalar copy may have set this)
    } else {
      newState.mapDetectionSets = mergedSetsList;
    }
    newState.mapDetectionSetsDel = Object.keys(setTomb);
    newState.mapPointsShownColls = Object.keys(shownUnion);   // this device's own ticks only
    newState.mapDetSetsShown = Object.keys(detShownUnion);
    // Working set + active list: a file IMPORT shows the merged loose set (no
    // active list); a background SYNC keeps the user's loaded list active and
    // makes the working set that list's MERGED points, so additions from the
    // other device appear in place.
    var keepActive = opts.interactive ? "" : (local.mapPointSetActive || "");
    var activeSet = keepActive ? mergedSets.filter(function (c) { return c.name === keepActive; })[0] : null;
    if (activeSet) {
      newState.mapPoints = (activeSet.points || []).slice();
      newState.mapPointSetActive = keepActive;
    } else {
      // No active list (or it's gone) → show the merged loose union. NEVER set
      // mapPoints to [] here: that would wipe this device's pins on a sync.
      newState.mapPoints = mergedLoose;
      newState.mapPointSetActive = "";
    }
    // These three ride in the payload but belong in IndexedDB, not in the localStorage
    // blob — they are restored above. Leaving them here would push a multi-megabyte
    // cache into a ~5 MB store and cost the user everything else in it.
    delete newState.nameHarvest; delete newState.extraVernac; delete newState.sightingsCache;
    // Resilient write: keeps lists / year-life lists / checklists / points and
    // trims only the oldest detections if the store would exceed the quota.
    try { writeStateCapped(newState); } catch (e) { throw new Error("storage write failed: " + e.message); }
    // eBird key: adopt incoming only when it should win, or when we have none.
    // Gap-fill only: an import or sync never replaces a key this device already holds
    // (security review, 2026-11-01).
    if (data.ebirdKey && !ebirdKey()) setEbirdKey(data.ebirdKey);
    if (data.artdbKey && !artKey()) setArtKey(data.artdbKey);
    try { if (data.gdriveClientId && !localStorage.getItem("gdrive-client-id")) localStorage.setItem("gdrive-client-id", data.gdriveClientId); } catch (e) {}
    // Harvested names and extra vernaculars UNION in — a name this device already has is
    // never dropped because the other device had not met that species yet.
    try {
      if (incoming.nameHarvest) {
        var nh = nameHarvest(), added = 0;
        Object.keys(incoming.nameHarvest).forEach(function (k) { if (!nh[k]) { nh[k] = incoming.nameHarvest[k]; added++; } });
        if (added) { setNhDirty(true); saveNameHarvest(); }   // the saver is a no-op unless the dirty flag is set
      }
    } catch (e) {}
    try {
      if (incoming.extraVernac) {
        var vc = vernacCache(), vAdded = 0;
        Object.keys(incoming.extraVernac).forEach(function (k) { if (!vc[k]) { vc[k] = incoming.extraVernac[k]; vAdded++; } });
        if (vAdded) saveVernacCache();
      }
    } catch (e) {}
    // The fetched-observation cache only arrives when the sender had "Fetched points"
    // ticked; write it straight back to IndexedDB and into the live map.
    try {
      if (incoming.sightingsCache && window.AppIDB && AppIDB.available()) {
        Object.keys(incoming.sightingsCache).forEach(function (ck) { var e = incoming.sightingsCache[ck]; if (e && e.out) storeSightEntry(ck, e); });
      }
    } catch (e) {}
    // Reflect the merged pins (dots/stars) on the map + legend immediately.
    try { reloadPlottedFromStore(); } catch (e) {}
    // If the sync brought in detections from the other device, fit the map to
    // the plotted dots so they're actually on screen (they render at their own
    // coordinates, which may be far from the view this device was showing).
    try { if (gainedDet) fitToDetections(); } catch (e) {}
    // Same for the user's map points: reload the merged set into memory and
    // re-render the markers + the Map-points panel (this was missing, so map
    // points appeared unchanged after a sync until a manual reload).
    try { if (typeof loadMapPoints === "function") { loadMapPoints(); renderMapPoints(); if (typeof refreshMpPanel === "function") refreshMpPanel(); } } catch (e) {}
    // Refresh the rest of the open views so a sync takes effect WITHOUT a manual
    // reload: the current species/field page, the checklist list, and any open
    // modal that lists synced data (detections, year/life lists, detection sets).
    try { if (typeof refreshCurrentView === "function") refreshCurrentView(); } catch (e) {}
    try { if (typeof refreshChecklists === "function") refreshChecklists(); } catch (e) {}
    function visible(id) { var m = document.getElementById(id); return m && m.style.display !== "none"; }
    try { if (visible("detlist-modal") && typeof renderDetListModal === "function") renderDetListModal(); } catch (e) {}
    try { if (visible("lists-modal") && typeof renderListsModal === "function") renderListsModal(); } catch (e) {}
    return {
      checklistsIncoming: Object.keys(incoming.fieldChecklists || {}).length,
      checklistsTotal: Object.keys(mergedCl).length,
      pointsTotal: mergedLoose.length,
      listsTotal: mergedSets.length,
      hadKey: !!data.ebirdKey
    };
  }
  function importAppData(jsonText) {
    var data; try { data = window.GeoState.safeParse(jsonText); } catch (e) { throw new Error("Invalid JSON"); }
    if (mpState.anyLazy && mpState.anyLazy()) throw new Error("lists still loading");   // never merge into half-loaded lists
    return applyRemote(data, { incomingWins: true, interactive: true });
  }

  // ---- Selective sync ------------------------------------------------------
  // The sync dialog lets the user pick WHICH categories to sync. Each category
  // owns a set of state keys; "settings" is everything else (minus the small
  // always-synced species-status lists). Excluding a category means: don't pull
  // it from the remote, and don't overwrite the remote's copy of it on push.
  var SYNC_CATS = ["settings", "lists", "trips", "checklists", "fetched"];
  var SYNC_CAT_KEYS = {
    lists: ["mapPointSets", "mapPoints", "mapPointSetActive", "mapPointsShownColls"],
    trips: ["mapDetectionSets", "mapDetectionSetsDel", "mapDetSetsShown"],
    checklists: ["fieldChecklists"],
    fetched: ["mapDetections", "sightingsCache"]
  };
  // Small, union-safe lists that always sync regardless of the toggles.
  var SYNC_ALWAYS_KEYS = { interesting: 1, lifeList: 1, yearLists: 1, customLists: 1, detFamilies: 1, updatedAt: 1 };
  // "settings" = every scalar key present on either side that no other category
  // owns and that isn't in the always-synced set.
  function syncSettingsKeys(stA, stB) {
    var owned = {}; Object.keys(SYNC_CAT_KEYS).forEach(function (c) { SYNC_CAT_KEYS[c].forEach(function (k) { owned[k] = 1; }); });
    var out = {};
    [stA, stB].forEach(function (st) { Object.keys(st || {}).forEach(function (k) { if (!owned[k] && !SYNC_ALWAYS_KEYS[k]) out[k] = 1; }); });
    return Object.keys(out);
  }
  // A shallow-cloned incoming payload with the EXCLUDED categories stripped, so a
  // selective sync never pulls them in. `inc` = { settings, lists, ... } truthy=include.
  function filterIncomingForSync(data, inc, localState) {
    var d = { app: data.app, version: data.version, exportedAt: data.exportedAt, ebirdKey: data.ebirdKey, artdbKey: data.artdbKey, state: {} };
    var st = data.state || {};
    Object.keys(st).forEach(function (k) { d.state[k] = st[k]; });
    function drop(keys) { keys.forEach(function (k) { delete d.state[k]; }); }
    ["lists", "trips", "checklists", "fetched"].forEach(function (c) { if (!inc[c]) drop(SYNC_CAT_KEYS[c]); });
    if (!inc.settings) { drop(syncSettingsKeys(st, localState)); d.ebirdKey = ""; d.artdbKey = ""; }
    return d;
  }
  // Keep the remote's copy of EXCLUDED categories intact on push: overlay the
  // remote's values back into the payload (or drop the keys when the remote has
  // none, so an excluded category is never freshly created on Drive from here).
  function overlayExcludedForPush(payload, remote, inc, localState) {
    var rem = (remote && remote.state) || null;
    function restore(keys) {
      keys.forEach(function (k) {
        if (rem && Object.prototype.hasOwnProperty.call(rem, k)) payload.state[k] = rem[k];
        else delete payload.state[k];
      });
    }
    ["lists", "trips", "checklists", "fetched"].forEach(function (c) { if (!inc[c]) restore(SYNC_CAT_KEYS[c]); });
    if (!inc.settings) {
      restore(syncSettingsKeys(rem || {}, localState));
      payload.ebirdKey = (remote && remote.ebirdKey) || "";
      payload.artdbKey = (remote && remote.artdbKey) || "";
    }
    return payload;
  }

  // ---- readable copies for the Drive folder ---------------------------------
  // The sync itself round-trips one JSON payload, which is what a merge needs — but a
  // folder full of "migration_calendar-2026-09-24-1830.json" is no use to a person. So
  // every push also writes the same data in the formats these things normally travel in:
  // a .kmz per point list and per saved trip, and CSV for the species and checklists.
  // One-way: nothing reads these back, so their shape is free to be plain.
  function csvCell(v) {
    var x = String(v == null ? "" : v);
    return /[",\n;]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
  }
  function csvOf(header, rows) {
    return header.join(",") + "\n" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\n") + "\n";
  }
  function speciesListsCsv() {
    var rows = [];
    function add(listName, keys) {
      (keys || []).forEach(function (k) {
        rows.push([listName, sciShow(k), detName({ key: k, cls: "" }) || "", (getTaxByCode()[k] && getTaxByCode()[k].cls) || ""]);
      });
    }
    // Read the hydrated in-memory maps, not GeoState: on disk these are ARRAYS of keys
    // ("lifeList": ["Strix aluco", …]), so Object.keys would hand back 0,1,2.
    try { add("life", Object.keys(getLifeList() || {})); } catch (e) {}
    try { Object.keys(getYearLists() || {}).forEach(function (y) { add("year " + y, Object.keys(getYearLists()[y] || {})); }); } catch (e) {}
    try { Object.keys(getCustomLists() || {}).forEach(function (nm) { add(nm, Object.keys(getCustomLists()[nm] || {})); }); } catch (e) {}
    try { add("starred", Object.keys(getInterestingSpecies() || {})); } catch (e) {}
    return rows.length ? csvOf(["list", "scientific_name", "common_name", "group"], rows) : "";
  }
  // Name a file the way a person would, without letting a list name break the path.
  function safeFileName(x) { return String(x || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "unnamed"; }
  // A readable copy is a convenience; the sync payload is the data. Building one for a
  // very large list is not worth what it costs — a 73 000-point list makes ~115 MB of KML
  // string before it is even deflated, which on a phone is the sync "hanging". Lists past
  // this go to Drive in the payload as always, just without a .kmz beside them.
  var COPY_MAX_POINTS = 20000;
  function driveExtraFiles() {
    var out = [], skipped = [];
    // LAZY on purpose. This used to build every list's KML string and its compressed copy
    // up front and hold them ALL in memory before the first upload — with a dozen imported
    // lists that is hundreds of megabytes of strings at once, and the tab died with Chrome's
    // "Aw, Snap!" (a renderer OOM). writeReadableCopies calls build() one file at a time and
    // releases each before the next, so only ONE list is ever materialised. The closure
    // holds a reference to the existing points array, not a copy.
    function kmz(name, points) {
      if (!points || !points.length) return;
      if (points.length > COPY_MAX_POINTS) { skipped.push(name + " (" + points.length + ")"); return; }
      out.push({ name: safeFileName(name) + ".kmz", mime: "application/vnd.google-earth.kmz",
        build: function () { return mpState.buildKmz(mpState.buildPointsKml([{ name: name, points: points }], [])); } });
    }
    // Point lists are no longer written here: each is a DATA file of the sync now
    // (splitListsForDrive below), not a convenience copy.
    try {
      (detSets() || []).forEach(function (set) {
        var pts = [];
        Object.keys(set.detections || {}).forEach(function (k) {
          var e = set.detections[k] || {};
          (e.rows || []).forEach(function (r) {
            if (r.lat == null || r.lon == null) return;
            pts.push(detPointFromRow({ lat: r.lat, lon: r.lon, key: e.key || k, color: e.color || "",
              name: detName({ key: e.key || k, cls: e.cls || "", name: e.name }) || e.name || k,
              date: r.date, count: r.count, url: r.url, src: r.src, act: r.act }));
          });
        });
        kmz("Trip - " + set.name, pts);
      });
    } catch (e) {}
    var sp = "";
    try { sp = speciesListsCsv(); } catch (e) {}
    if (sp) out.push({ name: "Species lists.csv", mime: "text/csv;charset=utf-8", text: sp });
    try {
      var fc = window.AppField && window.AppField.fieldChecklistCsv && window.AppField.fieldChecklistCsv();
      if (fc) out.push({ name: "Checklists.csv", mime: "text/csv;charset=utf-8", text: fc });
    } catch (e) {}
    if (skipped.length) out._skipped = skipped;   // reported by the sync, not silently dropped
    return Promise.resolve(out);
  }
  // ---- Point lists as standalone files on Drive (owner, 2026-10-05) -------------------
  // "I want the syncing operation to read the standalone kmz files and avoid embedding the
  // files in json (just keep file names there for load path)." Each synced list travels as
  // its own "Points - <name>.kmz" in the run folder; migration_calendar.json keeps, per list,
  // only its fields, the file name, the point count and a signature of the points. The .kmz
  // is an ordinary KML (opens in Google Earth / My Maps) that ALSO carries the exact list
  // as JSON in a document-level <ExtendedData> — the placemarks alone are lossy (no species
  // key, date, observer, count, source link, probability, id), and that block is what the
  // sync reads back. The Export / Import file (buildPayload) stays self-contained.
  var LIST_DATA_OPEN = '<Data name="birdswhere-list"><value><![CDATA[', LIST_DATA_CLOSE = "]]></value></Data>";
  // Key-order independent text of a value, so two devices sign the same list the same way.
  // Fields starting with "_" are per-device caches (_dn, _ot, …): not signed, not written.
  function canonStr(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) { var a = new Array(v.length); for (var i = 0; i < v.length; i++) a[i] = canonStr(v[i]); return "[" + a.join(",") + "]"; }
    var ks = Object.keys(v).sort(), o = [];
    for (var j = 0; j < ks.length; j++) { if (v[ks[j]] !== undefined && ks[j].charAt(0) !== "_") o.push(JSON.stringify(ks[j]) + ":" + canonStr(v[ks[j]])); }
    return "{" + o.join(",") + "}";
  }
  // `ordered` (a route: its stop order IS its content) signs the sequence; any other list
  // signs the SET of points, so two devices holding the same points in a different order —
  // which is what a merge leaves behind — agree, and neither uploads the list again.
  function listPointsSig(points, ordered) {
    var parts = (points || []).map(canonStr); if (!ordered) parts.sort();
    var s = parts.join("\n"), h1 = 0x811c9dc5, h2 = 5381;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (Math.imul(h2, 33) + c) | 0; }
    return (points || []).length + "-" + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + "-" + s.length;
  }
  function localListSig(name) {
    var c = (mpState.mpCollections() || []).filter(function (x) { return x && x.name === name; })[0];
    return c ? listPointsSig(c.points || [], mpState.isRouteColl(c)) : "";
  }
  async function listKmzBytes(c) {
    var xml = function (x) { return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var pts = c.points || [], kml;
    var body = { v: 1, name: c.name, points: pts };
    if (c.polys && c.polys.length) body.polys = c.polys;
    if (c.lines && c.lines.length) body.lines = c.lines;   // a recorded GPS track
    var data = "<ExtendedData>" + LIST_DATA_OPEN + JSON.stringify(body, function (k, val) { return k.charAt(0) === "_" ? undefined : val; }).replace(/]]>/g, "]]]]><![CDATA[>") + LIST_DATA_CLOSE + "</ExtendedData>";
    if (pts.length > COPY_MAX_POINTS) {
      // A very large list: bare placemarks (name + position) — the full KML with descriptions
      // is hundreds of megabytes of string. The data block is complete either way.
      var parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', "<Document>", "<name>" + xml(c.name) + "</name>", data, "<Folder><name>" + xml(c.name) + "</name>"];
      pts.forEach(function (p) { parts.push("<Placemark><name>" + xml(p.name || "Point") + "</name><Point><coordinates>" + Number(p.lon).toFixed(6) + "," + Number(p.lat).toFixed(6) + ",0</coordinates></Point></Placemark>"); });
      parts.push("</Folder>", "</Document>", "</kml>");
      kml = parts.join("\n");
    } else {
      kml = mpState.buildPointsKml([{ name: c.name, points: pts, polys: c.polys, lines: c.lines }], [], { noBlock: true });   // the block is added once, below
      var at = kml.indexOf("<Document>");
      kml = kml.slice(0, at + 10) + "\n" + data + kml.slice(at + 10);
    }
    return mpState.buildKmz(kml);
  }
  // The exact points of a list file written by listKmzBytes. Throws when the file is not one.
  async function listFromKmz(buf) {
    var kml = await mpState.extractKmlFromKmz(buf);
    var a = kml.indexOf(LIST_DATA_OPEN); if (a < 0) throw new Error("not a BirdsWhere list file");
    a += LIST_DATA_OPEN.length;
    var b = kml.indexOf(LIST_DATA_CLOSE, a); if (b < 0) throw new Error("list file is cut short");
    var obj = window.GeoState.safeParse(kml.slice(a, b).split("]]]]><![CDATA[>").join("]]>"));
    if (!obj || !Array.isArray(obj.points)) throw new Error("list file has no points");
    if (Array.isArray(obj.polys)) obj.points.polys = obj.polys;   // the list's areas ride along (the caller moves them onto the list)
    if (Array.isArray(obj.lines)) obj.points.lines = obj.lines;   // … and its lines (a GPS track)
    return obj.points;
  }
  function isListRef(e) { return !!(e && e.file && !Array.isArray(e.points)); }
  // Turn the payload's lists into references and return the files to write. `refs` = what
  // the newest run on Drive holds ({ listName: { file, psig } }): a list whose points are
  // unchanged is COPIED there (server side) instead of uploaded again. A list that is already
  // a reference (the lists category was left out of this sync) is carried over the same way.
  function splitListsForDrive(payload, refs) {
    var sets = payload && payload.state && payload.state.mapPointSets, files = [];
    if (!Array.isArray(sets)) return files;
    refs = refs || {};
    var taken = Object.create(null);
    sets.forEach(function (c) { if (isListRef(c)) taken[c.file] = 1; });
    payload.state.mapPointSets = sets.map(function (c) {
      if (!c || !c.name) return c;
      if (isListRef(c)) { files.push({ name: c.file, list: c.name, copy: c.file, build: null }); return c; }
      var base = "Points - " + safeFileName(c.name), fname = base + ".kmz", k = 2;
      var ref = refs[c.name], psig = listPointsSig(c.points || [], mpState.isRouteColl(c));
      if (ref && ref.file && !taken[ref.file]) fname = ref.file;      // keep the name it already has on Drive
      else while (taken[fname]) fname = base + " (" + (k++) + ").kmz";
      taken[fname] = 1;
      var stub = {};
      Object.keys(c).sort().forEach(function (key) { if (key !== "points" && key !== "polys" && key !== "lines" && key !== "file" && key !== "n" && key !== "psig") stub[key] = c[key]; });   // areas live in the list's .kmz, not the JSON
      stub.file = fname; stub.n = (c.points || []).length; stub.psig = psig;
      files.push({ name: fname, list: c.name, copy: (ref && ref.psig === psig) ? ref.file : null, build: function () { return listKmzBytes(c); } });
      return stub;
    });
    return files;
  }
  // Surface the data layer for the Google Drive sync module (gdrive-sync.js),
  // which lives outside this IIFE. It builds the payload and merges remote
  // copies through the exact same code path as the file Export/Import.
  window.AppData = {
    buildPayload: buildPayload,
    loadFetchedForSync: function () { return syncCatOn("fetched") ? loadAllSights() : Promise.resolve(); },   // the stored location records are read on demand; a sync with "Fetched points" ticked needs them all
    flushWrites: flushWrites,
    driveExtraFiles: driveExtraFiles,
    markBackedUp: markBackedUp,
    applyRemote: applyRemote,
    ebirdKey: window.AppSources.ebirdKey,   // the key as it was when the app loaded, as before (this object is built while the file loads, before init)
    setEbirdKey: setEbirdKey,
    SYNC_CATS: SYNC_CATS,
    filterIncomingForSync: filterIncomingForSync,
    overlayExcludedForPush: overlayExcludedForPush,
    splitListsForDrive: splitListsForDrive, listFromKmz: listFromKmz, localListSig: localListSig, isListRef: isListRef, cachesReady: cachesReady,
    _listKmzBytes: listKmzBytes, _listPointsSig: listPointsSig
  };

  return {
    init: init,
    DET_CAP: DET_CAP,
    applyRemote: applyRemote,
    capDetections: capDetections,
    detRowCount: detRowCount,
    exportAppData: exportAppData,
    flushWrites: flushWrites,
    importAppData: importAppData,
    updateBackupNudge: updateBackupNudge,
    wireSyncSpinner: wireSyncSpinner,
    writeStateCapped: writeStateCapped,
  };
})();
