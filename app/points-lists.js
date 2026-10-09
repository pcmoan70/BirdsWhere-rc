/**
 * Map points, saved lists and routes — the user's own pins.
 *
 * Lifted out of app.js byte-for-byte (v1262): the working set and its named
 * collections, tag colours, the KML / KMZ / GeoJSON import + export, the route
 * basket and its navigation hand-off, and the pin layer (rendering, spider-out
 * for overlapping pins, popups). app.js still owns the map, the detections and
 * the panels that display all this (refreshMpPanel, the admin view, the point
 * editor), and injects them through init() — the injected names are the SAME
 * identifiers the code used inside the monolith, so the bodies below are
 * unchanged.
 *
 * State lives here now; app.js reads it through the getters at the bottom
 * (mapPoints(), mpCollections(), shownColls(), …) and the few setters that
 * replace a whole container.
 *
 * Exposed as window.AppPoints (no module system; loaded via <script>).
 */
window.AppPoints = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var clearSpider, detRenderer, detStarMarker, downloadCsv, escapeHtml, haversineKm, ico,
      copyPointToList, deleteListPoint, listPointPasses, looksLikeHtml, makePopupBtn, modalPrompt, mpTipHtml, openExternal, openPointEditor,
      refreshMpPanel, renderMpAdmin, setStatus, showDetRowMenu, syncListDetections,
      pulseFunnels, tagDisplay, labelForSci, updateDetSetOverlays, updateMpBadge, updateSpDistances, t;
  // … and accessors for app state that is replaced at runtime (the map and the
  // clicked-spot marker are built later; the spider layer is app.js's).
  var getMap, getMarker, getSpiderHidden, setSpiderLayer;

  function init(ctx) {
    clearSpider = ctx.clearSpider; detRenderer = ctx.detRenderer; detStarMarker = ctx.detStarMarker;
    downloadCsv = ctx.downloadCsv; escapeHtml = ctx.escapeHtml; haversineKm = ctx.haversineKm;
    ico = ctx.ico; looksLikeHtml = ctx.looksLikeHtml; makePopupBtn = ctx.makePopupBtn;
    copyPointToList = ctx.copyPointToList; deleteListPoint = ctx.deleteListPoint;
    listPointPasses = ctx.listPointPasses; modalPrompt = ctx.modalPrompt; mpTipHtml = ctx.mpTipHtml; openExternal = ctx.openExternal;
    openPointEditor = ctx.openPointEditor; refreshMpPanel = ctx.refreshMpPanel;
    renderMpAdmin = ctx.renderMpAdmin; setStatus = ctx.setStatus; showDetRowMenu = ctx.showDetRowMenu;
    syncListDetections = ctx.syncListDetections; updateDetSetOverlays = ctx.updateDetSetOverlays;
    pulseFunnels = ctx.pulseFunnels || function () {};
    tagDisplay = ctx.tagDisplay || function (x) { return x; };
    labelForSci = ctx.labelForSci || function () { return null; };   // scientific name → model label (app.js owns the index)
    updateMpBadge = ctx.updateMpBadge; updateSpDistances = ctx.updateSpDistances; t = ctx.t;
    getMap = ctx.getMap; getMarker = ctx.getMarker;
    getSpiderHidden = ctx.getSpiderHidden; setSpiderLayer = ctx.setSpiderLayer;
  }

  // ---- Map points (user-added pins + named lists) ---------------------------
  // Storage: GeoState.mapPoints = [{ id, lat, lon, name, tags[], note, source, createdAt }]
  // Filter:  GeoState.mapPointsFilter = [tag, ...]; "" means the "(no tag)" chip.
  // Markers live in mpLayer (a single Leaflet layerGroup) so we can rebuild
  // cheaply on edit/filter changes without touching the rest of the map.
  var mapPoints = [];
  var mpFilter = [];
  var mpExclude = [];   // tags whose points are HIDDEN (the chip's third state: coloured, crossed out) — owner 2026-10-02
  var mpShown = true;   // master visibility toggle — hides all markers but keeps the data
  var mpLayer = null;
  // Named collections — saveable/retrievable point lists (e.g. "Owl nests",
  // "Spring trip"). mpActiveName is the loaded list; edits to the working set
  // auto-sync into it. Shape: GeoState.mapPointSets = [{ name, points[] }].
  var mpCollections = [];
  var mpActiveName = "";
  var mpLastColor = "";   // last explicit point colour chosen — the default for the next NEW point
  var mpSort = "dist";   // points list order: "dist" (nearest first) | "name"
  // Distances + nearest-first sorting in the point lists are measured from the LAST
  // point the user selected on the map (a map click, a pin, a detection dot, or a
  // list row). Falls back to the map centre until something is selected. Selecting
  // a point re-measures and re-sorts via refreshMpPanel().
  var mpDistOrigin = null;   // { lat, lng } or null
  function setMpDistOrigin(lat, lon) {
    if (lat == null || lon == null || isNaN(+lat) || isNaN(+lon)) return;
    mpDistOrigin = { lat: +lat, lng: +lon };
    refreshMpPanel();
    updateSpDistances();   // the list views' Dist columns re-measure from the new pin
  }
  // Saved lists are now shown as toggleable OVERLAYS (tick to show, several at
  // once) rather than loaded into the working set. These hold which saved
  // point-lists / detection sets are currently shown; detSetOverlays holds the
  // live map layer for each shown detection set.
  var shownColls = {};
  var shownDetSets = {};
  var detSetOverlays = {};

  var MP_COLORS = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];
  function mpHashColor(tag) {
    if (!tag) return "#888";
    var h = 0; for (var i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
    return MP_COLORS[Math.abs(h) % MP_COLORS.length];
  }
  function mpColorFor(p) { return mpHashColor((p.tags && p.tags[0]) || ""); }
  // A saved list's colour: an explicit list colour if set (via the list editor),
  // else the automatic name-hashed colour.
  function collColor(c) { return (c && c.color) || mpHashColor(c ? c.name : ""); }
  // A saved point-list is a "route" if it was saved from the route bar (c.route), or
  // — for lists saved before that flag existed — every point came from the route
  // (source "route"). Shown route lists render as numbered stops + get the nav bar.
  function isRouteColl(c) {
    if (!c) return false;
    if (c.route) return true;
    var pts = c.points || [];
    return pts.length > 0 && pts.every(function (p) { return p && p.source === "route"; });
  }
  // Whole-list editor: set a colour + tags applied to every point in the list
  // (and rename it). Opened from the ✎ on a list row in the Points overview.
  function openCollEditModal(name) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0]; if (!c) return;
    var esc = escapeHtml, auto = mpHex6(mpHashColor(c.name)), cur = mpHex6(c.color || auto);
    // Seed the tag box with tags shared by ALL points (so saving doesn't wipe them).
    var common = null;
    (c.points || []).forEach(function (p) {
      var set = {}; (p.tags || []).forEach(function (x) { set[x] = 1; });
      if (common === null) common = set;
      else Object.keys(common).forEach(function (x) { if (!set[x]) delete common[x]; });
    });
    var tagStr = common ? Object.keys(common).join(", ") : "";
    // "Notes are HTML" starts ticked only if every point that has a note is flagged.
    var noted = (c.points || []).filter(function (p) { return p.note; });
    var allHtml = noted.length > 0 && noted.every(function (p) { return p.noteHtml; });
    var ov = document.createElement("div"); ov.id = "coll-edit-modal"; ov.className = "kml-modal";
    ov.innerHTML = '<div class="kml-modal-box">' +
      '<button type="button" id="ce-close" class="kml-close" aria-label="' + esc(t("btn.close")) + '">×</button>' +
      "<h3>" + esc(t("points.editList")) + "</h3>" +
      '<label class="kml-row">' + esc(t("points.name")) + '<input type="text" id="ce-name" value="' + esc(c.name) + '" /></label>' +
      '<label class="kml-row">' + esc(t("points.tags")) + '<input type="text" id="ce-tags" value="' + esc(tagStr) + '" placeholder="' + esc(t("points.tagsPh")) + '" /></label>' +
      '<span class="mp-color-row"><span class="mp-color-lbl">' + esc(t("points.color")) + "</span>" +
        '<input type="color" id="ce-color" data-auto="' + esc(auto) + '" value="' + esc(cur) + '" />' +
        '<button type="button" id="ce-color-auto" class="mp-color-reset" title="' + esc(t("points.colorAuto")) + '" aria-label="' + esc(t("points.colorAuto")) + '">↺</button></span>' +
      '<label class="kml-row kml-check"><input type="checkbox" id="ce-note-html"' + (allHtml ? " checked" : "") + " />" + esc(t("points.noteHtml")) + "</label>" +
      '<label class="kml-row kml-check"><input type="checkbox" id="ce-protect"' + (isCollProtected(c.name) ? " checked" : "") + " />" + esc(t("lists.protect")) + "</label>" +
      '<p class="cu-hint">' + esc(t("points.editListHint")) + "</p>" +
      '<div class="kml-actions"><button type="button" id="ce-save" class="btn">' + esc(t("points.save")) + "</button></div>" +
      "</div>";
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.getElementById("ce-close").addEventListener("click", close);
    var ci = document.getElementById("ce-color"), reset = document.getElementById("ce-color-auto");
    reset.addEventListener("click", function () { ci.value = ci.getAttribute("data-auto") || "#888888"; });
    document.getElementById("ce-save").addEventListener("click", function () {
      var newName = (document.getElementById("ce-name").value || "").trim();
      var tags = mpParseTags(document.getElementById("ce-tags").value);
      var colVal = (ci.value || "").toLowerCase(), col = (colVal && colVal !== auto.toLowerCase()) ? ci.value : "";   // auto → no explicit colour
      var noteHtml = document.getElementById("ce-note-html").checked;
      var isActive = mpActiveName === c.name;   // capture before any rename
      c.color = col || undefined;
      // Apply the colour + tags + note-is-HTML flag to every point. The colour is
      // written per-point too (not just on the list) so it shows through both draw
      // paths — the active working set colours per-point via mpColorFor, shown lists
      // via collColor.
      var applyFlags = function (p) { p.color = col; p.tags = tags.slice(); if (noteHtml) p.noteHtml = true; else delete p.noteHtml; };
      (c.points || []).forEach(applyFlags);
      // If this list is the one currently loaded onto the map, mirror the edit onto
      // the working set — else saveMapPoints() would copy mapPoints back over c.points.
      if (isActive) mapPoints.forEach(applyFlags);
      // Rename (migrate the shown + protected flags, which are keyed by name).
      if (newName && newName !== c.name && !mpCollections.some(function (x) { return x.name === newName; })) {
        var old = c.name, wasShown = !!shownColls[old], wasProt = isCollProtected(old);
        c.name = newName;
        if (isActive) mpActiveName = newName;
        if (wasShown) { delete shownColls[old]; shownColls[newName] = true; }
        if (wasProt) { setCollProtected(old, false); setCollProtected(newName, true); }
        saveShownState();
      }
      setCollProtected(c.name, document.getElementById("ce-protect").checked);   // after the rename: keyed by the final name
      saveMapPoints(); renderMapPoints(); if (typeof refreshMpPanel === "function") refreshMpPanel();
      if (typeof renderMpAdmin === "function") renderMpAdmin();
      close();
    });
  }
  // <input type=color> needs a 6-digit hex; expand "#888" → "#888888".
  function mpHex6(c) {
    c = String(c || "");
    if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return /^#[0-9a-f]{6}$/i.test(c) ? c : "#888888";
  }
  // Editor colour row: a "custom colour" checkbox + swatch. Unchecked = auto
  // (tag-derived, else grey). Shared by the live and saved-point editors.
  function mpColorRow(p) {
    // No "custom?" checkbox: the swatch starts at the point's automatic (tag-based)
    // colour; changing it makes the colour custom, and ↺ resets it to automatic.
    // data-auto carries the auto colour so mpReadColor can tell them apart.
    var auto = mpHex6(mpColorFor(p));
    // A NEW point (no id yet) defaults to the last colour you chose, so a run of
    // points shares a colour until you change it (e.g. one colour per year).
    var isNew = !(p && p.id);
    var val = mpHex6((p && p.color) || (isNew && mpLastColor) || auto);
    return '<span class="mp-color-row"><span class="mp-color-lbl">' + escapeHtml(t("points.color")) + "</span>" +
      '<input type="color" id="mp-color" data-auto="' + escapeHtml(auto) + '" value="' + escapeHtml(val) + '" />' +
      '<button type="button" id="mp-color-auto" class="mp-color-reset" title="' + escapeHtml(t("points.colorAuto")) + '" aria-label="' + escapeHtml(t("points.colorAuto")) + '">↺</button></span>';
  }
  function mpReadColor() {
    var ci = document.getElementById("mp-color"); if (!ci) return "";
    var auto = (ci.getAttribute("data-auto") || "").toLowerCase(), val = (ci.value || "").toLowerCase();
    return (val && val !== auto) ? ci.value : "";   // still the auto colour → store "" (automatic)
  }
  // ↺ resets the swatch to the point's automatic colour.
  function wireMpColorRow() {
    var reset = document.getElementById("mp-color-auto"), ci = document.getElementById("mp-color");
    if (reset && ci) reset.addEventListener("click", function () { ci.value = ci.getAttribute("data-auto") || "#888888"; });
  }
  // Comma-separated free-form tag input → clean, deduped lowercase-trimmed array.
  // A tag never carries a record count: a KML folder "eggs (3)" and a category "eggs" are the
  // same tag (owner, 2026-10-01 — the chips showed both); the chip shows the live count instead.
  function normTag(t) { return String(t || "").replace(/\s*\(\d[\d\s.,]*\)\s*$/, "").trim(); }
  function mpParseTags(s) {
    return String(s || "").split(",").map(function (t) { return normTag(t); }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
  }
  function mpUid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  // ---- Named lists in IndexedDB ---------------------------------------------
  // A single imported route can be megabytes, and every named list used to sit in
  // the one localStorage blob (~5 MB for the WHOLE app). That capped the app, and it
  // broke Drive sync outright: a sync writes the MERGED state — both devices' lists —
  // so the write could not fit and the sync failed every time. Lists now live in
  // Points arrive from JSON.parse (IndexedDB, an import, a synced payload), and JSON.parse
  // does NOT share equal strings — every point gets its own copy of "Lyrurus tetrix",
  // "2024-04-12", "lek / display ground", its own 6-string tags array, and so on. Across the
  // generated species files that is the single largest avoidable cost: measured over 60,000
  // points with a forced GC, sharing them takes the set from 24.3 MB to 6.2 MB.
  //
  // Purely a representation change: every value is identical afterwards, so nothing that
  // reads a point can tell the difference. The pool is local to the call, so it is collected
  // and only the shared strings the points still hold survive.
  var INTERN_FIELDS = ["name", "sci", "date", "observer", "count", "place", "source",
                       "createdAt", "color", "spColor", "src", "act", "list",
                       "stage", "country", "dset", "note", "flags", "origin", "spKey", "spCls"];
  function internPoints(colls) {
    var pool = Object.create(null), tagPool = Object.create(null), n = 0;
    function sh(v) {
      if (typeof v !== "string" || !v) return v;
      var hit = pool[v];
      return hit === undefined ? (pool[v] = v) : hit;
    }
    (colls || []).forEach(function (c) {
      (c && c.points || []).forEach(function (p) {
        if (!p) return;
        n++;
        for (var i = 0; i < INTERN_FIELDS.length; i++) {
          var k = INTERN_FIELDS[i];
          if (typeof p[k] === "string") p[k] = sh(p[k]);
        }
        // Identical tag lists are extremely common (one per species/criterion combination),
        // so share the ARRAY, not just its strings.
        var tg = p.tags;
        if (tg && tg.length) {
          for (var j0 = 0; j0 < tg.length; j0++) tg[j0] = normTag(tg[j0]);   // stored "eggs (3)" → "eggs" (idempotent)
          var key = tg.join("\u0001"), hit = tagPool[key];
          if (hit) p.tags = hit;
          else { for (var j = 0; j < tg.length; j++) tg[j] = sh(tg[j]); tagPool[key] = tg; }
        }
      });
    });
    return n;
  }
  // IndexedDB, one record per list ("pts:<name>"), exactly like saved trips
  // (initDetSetStore in app.js). The Drive payload shape is unchanged: buildPayload
  // re-attaches them, so existing backups stay compatible.
  var mpIdbReady = false;
  // ---- Lazy list store (2026-10-04) ------------------------------------------------------
  // A start used to read EVERY saved list in full (twice: the trips step read the whole
  // store too), re-serialise each one for its change signature and walk every record — the
  // same cost for a list never shown as for the one on screen. Now each list has a small
  // META record ("ptm:<name>": its fields except the points, the point count and the
  // signature) beside its data ("pts:<name>"). At start only the metas and the TICKED
  // lists are read; the rest are stubs (`_lazy`, points empty, `_n` = count) that are
  // filled in the background right after the app is up, or at once when one is ticked.
  // While a stub exists nothing may be written or retired for it (see persistMpSets), and
  // sync / import wait for whenAllLoaded().
  function hide(o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, enumerable: false, configurable: true }); }
  function metaOf(c) { var o = {}; Object.keys(c).forEach(function (k) { if (k !== "points") o[k] = c[k]; }); return o; }
  function cheapSig(c) { return ((c.points || []).length) + "|" + JSON.stringify(metaOf(c)); }
  // Fields first, points after: a list filled from a stub has its keys in another order than
  // one read whole, and must still sign the same.
  function fullSig(c) { return mpSig(JSON.stringify(metaOf(c)) + "\n" + JSON.stringify(c.points || [])); }
  function collCount(c) { return c ? (c._lazy ? (c._n || 0) : ((c.points && c.points.length) || 0)) : 0; }
  function anyLazy() { for (var i = 0; i < mpCollections.length; i++) if (mpCollections[i] && mpCollections[i]._lazy) return true; return false; }
  var mpCheap = Object.create(null), mpAllLoadedWaiters = [];
  // Resolves when the background fill has finished. A list that could not be read stays a
  // stub, so callers that need every list whole check anyLazy() afterwards.
  function settleLoaded(force) { if (!force && anyLazy()) return; var w = mpAllLoadedWaiters; mpAllLoadedWaiters = []; w.forEach(function (f) { try { f(); } catch (e) {} }); }
  function whenAllLoaded() {
    if (!anyLazy()) return Promise.resolve();
    hydrateRest();
    return new Promise(function (res) { mpAllLoadedWaiters.push(res); });
  }
  function adopt(c) {   // a list just read from the store, whole
    (c.points || []).forEach(function (p) { delete p._dn; delete p._ot; });
    internPoints([c]);
    mpCheap[c.name] = cheapSig(c);
  }
  // Fill one stub. Points added while it was a stub are kept (appended) and written.
  function hydrateOne(c) {
    if (!c || !c._lazy) return Promise.resolve();
    if (c._loading) return c._loading;
    var pr = window.AppIDB.get(c._key).then(function (rec) {
      if (mpCollections.indexOf(c) < 0) return;          // deleted meanwhile
      var added = c.points || [];
      c.points = ((rec && rec.points) || []).concat(added);
      hide(c, "_lazy", false); hide(c, "_loading", null);
      adopt(c);
      // Renamed / moved / reordered / added to while a stub → the next save writes it.
      if (added.length || cheapSig(c) !== c._cheap0) mpCheap[c.name] = "";
      if (shownColls[c.name]) { try { renderMapPoints(); } catch (e) {} }
      settleLoaded();
    }, function () { hide(c, "_loading", null); hide(c, "_fails", (c._fails || 0) + 1); });
    hide(c, "_loading", pr);
    return pr;
  }
  // An action on a list that is still a stub (its "..." menu, navigate, export, expand in
  // Lists) loads it first and then repeats the click. Ticking it is handled by renderMapPoints.
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-name],[data-coll]") : null;
    if (!el || el.getAttribute("data-type") === "d" || (el.classList && el.classList.contains("mp-coll-cb"))) return;
    var nm = el.getAttribute("data-name") || el.getAttribute("data-coll");
    var c = mpCollections.filter(function (x) { return x && x._lazy && x.name === nm; })[0];
    if (!c) return;
    e.preventDefault(); e.stopPropagation();
    mpLoading(t("kml.reading", { name: nm }));
    hydrateOne(c).then(function () { mpLoading(""); if (!c._lazy && document.contains(el)) el.click(); });
  }, true);
  var mpRestRunning = false;
  function hydrateRest() {
    if (mpRestRunning) return; mpRestRunning = true;
    (function next() {
      var c = mpCollections.filter(function (x) { return x && x._lazy && !x._loading && (x._fails || 0) < 3; })[0];
      if (!c) {
        mpRestRunning = false;
        if (!anyLazy()) persistMpSets(mpCollections, { fast: true, noVerify: true });   // whatever was renamed / deleted / added to meanwhile
        settleLoaded(true);
        return;
      }
      hydrateOne(c).then(function () { setTimeout(next, 40); }, function () { setTimeout(next, 40); });   // one list at a time, the UI breathes in between
    })();
  }
  async function initMpSetStore() {
    if (!(window.AppIDB && window.AppIDB.available())) return;   // no IDB → the blob stays the store
    try {
      var blobSets = window.GeoState.get("mapPointSets", null);
      if (Array.isArray(blobSets) && blobSets.length) {
        for (var i = 0; i < blobSets.length; i++) { var c = blobSets[i]; if (c && c.name) await window.AppIDB.put("pts:" + c.name, c); }
        window.GeoState.save({ mapPointSets: undefined });   // confirmed in IDB → free the blob
      }
      var keys = (await window.AppIDB.keys()).map(String);
      var have = Object.create(null); keys.forEach(function (k) { have[k] = 1; });
      var ptsKeys = keys.filter(function (k) { return k.indexOf("pts:") === 0; });
      var shownNow = Object.create(null);
      (window.GeoState.get("mapPointsShownColls", []) || []).forEach(function (n) { shownNow[n] = 1; });
      var out = [], needMeta = [];
      for (var j = 0; j < ptsKeys.length; j++) {
        var key = ptsKeys[j], nm = key.slice(4), meta = have["ptm:" + nm] ? await window.AppIDB.get("ptm:" + nm) : null;
        if (meta && meta.name === nm && !shownNow[nm]) {             // not shown → a stub now, the records later
          var stub = {}; Object.keys(meta).forEach(function (k) { if (k !== "n" && k !== "sig") stub[k] = meta[k]; });
          stub.points = [];
          hide(stub, "_lazy", true); hide(stub, "_n", +meta.n || 0); hide(stub, "_key", key);
          hide(stub, "_cheap0", (+meta.n || 0) + "|" + JSON.stringify(metaOf(stub)));
          if (meta.sig) mpSetSig[nm] = meta.sig;
          out.push(stub);
          continue;
        }
        var full = await window.AppIDB.get(key);
        if (!full || !full.name) continue;
        if (meta && meta.sig) mpSetSig[full.name] = meta.sig; else needMeta.push(full);
        out.push(full);
      }
      mpCollections = out;
      mpCollections.forEach(function (c) { if (!c._lazy) adopt(c); });
      // First start with this version (or a list written by an older one): one meta each,
      // signed AFTER adopt() so it matches what a later save would serialise.
      needMeta.forEach(function (c) {
        try { mpSetSig[c.name] = fullSig(c); } catch (e) {}
        var m0 = metaOf(c); m0.n = (c.points || []).length; m0.sig = mpSetSig[c.name] || "";
        window.AppIDB.put("ptm:" + c.name, m0).catch(function () {});
      });
      loadListFilters();
      mpIdbReady = true;
      if (anyLazy()) setTimeout(hydrateRest, 1500);   // after the app is up
    } catch (e) {
      mpIdbReady = false;
      // IndexedDB can refuse to open for reasons that pass: another tab holding the
      // database during a version upgrade makes open() fire `onblocked`. Giving up for
      // the session then showed NO lists at all — the blob no longer carries them, it was
      // emptied when they moved into IndexedDB — so the lists looked lost when they were
      // merely unreachable. Try again a few times, and redraw once one succeeds.
      scheduleMpStoreRetry();
    }
  }
  var mpRetryLeft = 4, mpRetryT = null;
  function scheduleMpStoreRetry() {
    if (mpIdbReady || mpRetryLeft <= 0 || mpRetryT) return;
    mpRetryT = setTimeout(function () {
      mpRetryT = null; mpRetryLeft--;
      initMpSetStore().then(function () {
        if (!mpIdbReady) return;
        try { loadMapPoints(); renderMapPoints(); if (typeof refreshMpPanel === "function") refreshMpPanel(); } catch (e) {}
      }, function () {});
    }, (5 - mpRetryLeft) * 1500);
  }
  // Write the current lists to IndexedDB and retire the records of any that are gone.
  // Only the lists that actually CHANGED are written: these run to megabytes, and
  // every pin edit calls through here — rewriting all of them each time would make
  // editing a big list crawl.
  var mpSetSig = Object.create(null);
  function mpSig(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return str.length + ":" + h;
  }
  // Returns a promise that settles when every write has COMMITTED. A sync that reloads
  // the page (or a user closing the app) straight after merging used to abort the writes
  // in flight, so freshly synced lists were never stored — they were on screen and gone
  // on the next open. Callers that are about to navigate await this.
  // `opts.fast` (the everyday save path): a list that is not shown, whose point count and own
  // fields are unchanged, is NOT re-serialised now — that was megabytes of JSON per list on
  // every save. A full check of all lists follows a few seconds after the last save, one list
  // per tick, so an edit made to an unticked list is still written. Callers that are about to
  // navigate (sync, restore) call without `fast` and get the full, awaited check.
  var mpVerifyT = null;
  function flushVerify() {   // the app is being hidden / closed with a check still pending → do it now, in one go
    if (!mpVerifyT) return;
    clearTimeout(mpVerifyT); mpVerifyT = null;
    mpCollections.forEach(function (c) { if (c && c.name && !c._lazy) writeIfChanged(c, false); });
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushVerify(); });
  window.addEventListener("pagehide", flushVerify);
  function scheduleFullVerify() {
    clearTimeout(mpVerifyT);
    mpVerifyT = setTimeout(function () {
      mpVerifyT = null;
      var todo = mpCollections.filter(function (c) { return c && c.name && !c._lazy; });
      (function step() { var c = todo.shift(); if (!c) return; if (mpCollections.indexOf(c) >= 0) writeIfChanged(c, false); setTimeout(step, 30); })();
    }, 4000);
  }
  function writeIfChanged(c, fast) {
    if (fast && !shownColls[c.name] && mpCheap[c.name] === cheapSig(c)) return null;
    var sig;
    try { sig = fullSig(c); } catch (e) { sig = null; }
    mpCheap[c.name] = cheapSig(c);
    if (sig && mpSetSig[c.name] === sig) return null;   // unchanged since the last write
    var meta = metaOf(c); meta.n = (c.points || []).length; meta.sig = sig || "";
    // Both requests are issued now (not one after the other), so a page closing right after
    // a save cannot leave the data written and its meta stale.
    var pm = window.AppIDB.put("ptm:" + c.name, meta).catch(function () {});
    return window.AppIDB.put("pts:" + c.name, c)
      .then(function () { if (sig) mpSetSig[c.name] = sig; return pm; },
            function () { setStatus(t("err.storageFull")); });
  }
  function persistMpSets(list, opts) {
    if (!mpIdbReady || !window.AppIDB) return Promise.resolve();
    var fast = !!(opts && opts.fast), keep = Object.create(null), gone = false, writes = [], lazy = false;
    (list || []).forEach(function (c) {
      if (!c || !c.name) return;
      keep[c.name] = 1;
      if (c._lazy) { lazy = true; return; }               // a stub is never written: its records are still in the store only
      var w = writeIfChanged(c, fast); if (w) writes.push(w);
    });
    if (fast && !(opts && opts.noVerify)) scheduleFullVerify();
    // Nothing is retired while any list is still a stub (a renamed stub would lose its data).
    if (lazy || anyLazy()) return Promise.all(writes);
    Object.keys(mpSetSig).forEach(function (n) { if (!keep[n]) { gone = true; delete mpSetSig[n]; delete mpCheap[n]; } });
    if (!gone) return Promise.all(writes);   // nothing was deleted → no need to scan the store for orphans
    // Never let an EMPTY list wipe the store. A user deleting their last list is one
    // thing; a transient empty mirror (a failed hydrate, a code path that resets it
    // before a save) must not take every saved list with it. Deleting the last list
    // still works — it just leaves its record for the next real save to retire.
    if (!Object.keys(keep).length) return Promise.all(writes);
    writes.push(window.AppIDB.keys().then(function (ks) {
      var dels = [];
      ks.map(String).forEach(function (k) {
        if ((k.indexOf("pts:") === 0 || k.indexOf("ptm:") === 0) && !keep[k.slice(4)]) dels.push(window.AppIDB.del(k).catch(function () {}));
      });
      return Promise.all(dels);
    }).catch(function () {}));
    return Promise.all(writes);
  }
  function loadMapPoints() {
    loadListFilters();   // also when IndexedDB never hydrated (initMpSetStore bailed)
    mapPoints = (window.GeoState.get("mapPoints", []) || []).filter(function (p) { return p && isFinite(p.lat) && isFinite(p.lon); });
    mpFilter = (window.GeoState.get("mapPointsFilter", []) || []).map(normTag).filter(function (t, i, a) { return a.indexOf(t) === i; });
    mpExclude = (window.GeoState.get("mapPointsExclude", []) || []).map(normTag).filter(function (t, i, a) { return a.indexOf(t) === i; });
    // With IndexedDB as the store the lists are already hydrated (initMpSetStore) and
    // the blob no longer carries them — reading it here would wipe them.
    if (!mpIdbReady) mpCollections = (window.GeoState.get("mapPointSets", []) || []).filter(function (c) { return c && c.name; });
    mpActiveName = window.GeoState.get("mapPointSetActive", "") || "";
    mpLastColor = window.GeoState.get("mpLastColor", "") || "";
    mpSort = window.GeoState.get("mapPointsSort", "dist") === "name" ? "name" : "dist";
    shownColls = {}; (window.GeoState.get("mapPointsShownColls", []) || []).forEach(function (k) { shownColls[k] = true; });
    shownDetSets = {}; (window.GeoState.get("mapDetSetsShown", []) || []).forEach(function (k) { shownDetSets[k] = true; });
    // Retire the legacy "active list": older builds loaded a saved list into the
    // live working set (mpActiveName), so its pins drew on the map ALWAYS —
    // independent of the list's show-checkbox, which left them stuck-on when
    // unticked. Fold the working set back into its list, tick the list so the
    // pins stay visible (now controllable), and clear the loose set + flag.
    if (mpActiveName) {
      var ac = mpCollections.filter(function (c) { return c.name === mpActiveName; })[0];
      if (ac) { if (mapPoints.length) ac.points = mapPoints.slice(); shownColls[mpActiveName] = true; }
      mapPoints = []; mpActiveName = "";
      saveChecked({ mapPoints: [], mapPointSetActive: "", mapPointSets: mpCollections, mapPointsShownColls: Object.keys(shownColls) });
    }
  }
  // Persist a patch and, if the write hit the localStorage quota (lastSaveOk false),
  // surface a storage-full toast — otherwise these bulky collections (map points /
  // lists / blogs) fail silently and are gone on reload. Mirrors persistDetSet.
  function saveChecked(patch) {
    // Named lists are IndexedDB's business when it is available: persist them there
    // and let the blob drop the key (undefined removes it), so the ~5 MB cap applies
    // only to the small state again.
    if (patch && Object.prototype.hasOwnProperty.call(patch, "mapPointSets")) {
      if (mpIdbReady) {
        persistMpSets(patch.mapPointSets, { fast: true });
        patch.mapPointSets = undefined;
      } else if (window.AppIDB && window.AppIDB.available()) {
        // The store exists but has not hydrated (yet). `mpCollections` is therefore an
        // empty MIRROR, not the truth — writing it into the blob would record "no lists"
        // over the top of lists that are sitting safely in IndexedDB.
        patch.mapPointSets = undefined;
      }
    }
    window.GeoState.save(patch);
    if (window.GeoState.lastSaveOk && !window.GeoState.lastSaveOk()) { setStatus(t("err.storageFull")); return false; }
    return true;
  }
  function saveShownState() {
    saveChecked({ mapPointsShownColls: Object.keys(shownColls), mapDetSetsShown: Object.keys(shownDetSets) });
  }
  function saveMapPoints() {
    // Keep the loaded collection in lock-step with the working set so a list
    // stays current as the user adds/edits/removes pins after loading it.
    if (mpActiveName) {
      var c = mpCollections.filter(function (x) { return x.name === mpActiveName; })[0];
      if (c) c.points = mapPoints.slice();
    }
    saveChecked({ mapPoints: mapPoints, mapPointsFilter: mpFilter, mapPointsShown: mpShown, mapPointSets: mpCollections, mapPointSetActive: mpActiveName });
  }
  // Replace the working set with a named list and make it the active list.
  function loadCollection(name) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0]; if (!c) return;
    mapPoints = (c.points || []).map(function (p) { return Object.assign({}, p); });
    mpActiveName = name; mpFilter = [];
    saveMapPoints(); renderMapPoints();
    var pts = mapPoints.filter(function (p) { return isFinite(p.lat) && isFinite(p.lon); });
    if (pts.length && getMap()) { try { getMap().fitBounds(L.latLngBounds(pts.map(function (p) { return [p.lat, p.lon]; })).pad(0.2)); } catch (e) {} }
  }
  // Point-lists flagged "protected" can't be deleted (a guard against losing a
  // curated list to a stray ×). Stored as a name list in GeoState.
  function protectedColls() { return window.GeoState.get("mapPointsProtected", []) || []; }
  function isCollProtected(name) { return protectedColls().indexOf(name) >= 0; }
  function setCollProtected(name, on) {
    var list = protectedColls().slice(), i = list.indexOf(name);
    if (on && i < 0) list.push(name); else if (!on && i >= 0) list.splice(i, 1);
    window.GeoState.save({ mapPointsProtected: list });
  }
  // Forget a named list. The pins currently on the map are left untouched.
  function deleteCollection(name) {
    if (isCollProtected(name)) return;   // protected → never deleted
    mpCollections = mpCollections.filter(function (x) { return x.name !== name; });
    if (mpActiveName === name) mpActiveName = "";
    saveMapPoints(); renderMapPoints();
  }
  // "Unsaved" = pins on the map that aren't captured by any named list. Happens
  // when no list is active (a loaded list auto-syncs, so it's always saved).
  function mpHasUnsaved() { return !mpActiveName && mapPoints.length > 0; }
  // Export every pin to plain, interoperable KML (opens in Google Earth etc.):
  // named lists become <Folder>s, loose pins sit at the document root. Just
  // name / description / Point — no app-specific extensions.
  // colls/loose default to "everything" — the per-list download passes just one list.
  function buildPointsKml(colls, loose) {
    var xml = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    colls = colls || mpCollections;
    loose = loose !== undefined ? loose : (mpActiveName ? [] : mapPoints);
    var parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">', "<Document>", "<name>Map points</name>"];
    var placemark = function (p) {
      var isHtml = !!p.noteHtml;
      var desc = String(p.note || "");
      var tags = (p.tags || []).join(", ");
      if (tags) desc += (desc ? (isHtml ? "<br>" : "\n") : "") + "Tags: " + tags;
      parts.push("<Placemark>");
      parts.push("<name>" + xml(p.name || "Point") + "</name>");
      // HTML notes are emitted in a CDATA block (KML's convention for rich text) so
      // they survive the round-trip; plain notes are XML-escaped as before.
      if (desc) parts.push("<description>" + (isHtml ? "<![CDATA[" + desc.replace(/]]>/g, "]]&gt;") + "]]>" : xml(desc)) + "</description>");
      parts.push("<Point><coordinates>" + Number(p.lon).toFixed(6) + "," + Number(p.lat).toFixed(6) + ",0</coordinates></Point>");
      parts.push("</Placemark>");
    };
    colls.forEach(function (c) {
      parts.push("<Folder><name>" + xml(c.name) + "</name>");
      (c.points || []).forEach(placemark);
      parts.push("</Folder>");
    });
    loose.forEach(placemark);
    parts.push("</Document>", "</kml>");
    return parts.join("\n");
  }
  function pointsHasAny() {
    return (mpActiveName ? 0 : mapPoints.length) + mpCollections.reduce(function (n, c) { return n + collCount(c); }, 0);
  }
  function exportPointsKml() {
    if (!pointsHasAny()) { setStatus(t("points.exportEmpty")); return; }
    downloadCsv("map_points_" + new Date().toISOString().slice(0, 10) + ".kml", buildPointsKml());
  }
  // GeoJSON export/import — a lossless, JSON-native alternative to KML so a user can
  // download and keep their points/lists as a standard file: name, tags, note, colour
  // and species key survive in each feature's properties; the saved-list name goes in
  // "list". (KML flattens these into folders + description; GeoJSON keeps them exact.)
  function buildPointsGeoJson(colls, loose) {
    colls = colls || mpCollections;
    loose = loose !== undefined ? loose : (mpActiveName ? [] : mapPoints);
    var feats = [];
    function feat(p, listName) {
      var props = {};
      if (p.name) props.name = p.name;
      if (p.tags && p.tags.length) props.tags = p.tags.slice();
      if (p.note) props.note = p.note;
      if (p.noteHtml) props.noteHtml = true;
      if (p.color) props.color = p.color;
      if (+p.radius > 0) props.uncertainty_m = +p.radius;
      if (p.marker) props.marker = p.marker;
      if (p.spKey) props.spKey = p.spKey;
      if (p.spColor) props.spColor = p.spColor;
      if (p.date) props.date = p.date;
      if (listName) props.list = listName;
      if (p.source === "route" || p._route) props.route = true;   // a route stop stays one through a download + load (owner, 2026-10-04)
      return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [+(+p.lon).toFixed(6), +(+p.lat).toFixed(6)] } };
    }
    colls.forEach(function (c) { var rt = isRouteColl(c); (c.points || []).forEach(function (p) { if (isFinite(+p.lat) && isFinite(+p.lon)) feats.push(feat(rt ? Object.assign({}, p, { _route: true }) : p, c.name)); }); });
    loose.forEach(function (p) { if (isFinite(+p.lat) && isFinite(+p.lon)) feats.push(feat(p, "")); });
    return JSON.stringify({ type: "FeatureCollection", features: feats }, null, 2);
  }
  function exportPointsGeoJson() {
    if (!pointsHasAny()) { setStatus(t("points.exportEmpty")); return; }
    downloadCsv("map_points_" + new Date().toISOString().slice(0, 10) + ".geojson", buildPointsGeoJson());
  }
  // Parse GeoJSON Point features into the SAME {marks, fields, folders} shape the KML
  // importer produces, so the import field-mapping dialog is shared.
  function parseGeoJsonText(text) {
    var gj; try { gj = JSON.parse(text); } catch (e) { throw new Error(t("kml.parseErr")); }
    var feats = (gj && gj.type === "FeatureCollection" && Array.isArray(gj.features)) ? gj.features
              : (gj && gj.type === "Feature") ? [gj] : [];
    var marks = [], fieldSet = {}, folderSet = {};
    feats.forEach(function (f) {
      if (!f || !f.geometry || f.geometry.type !== "Point" || !Array.isArray(f.geometry.coordinates)) return;
      var lon = +f.geometry.coordinates[0], lat = +f.geometry.coordinates[1];
      if (!isFinite(lat) || !isFinite(lon)) return;
      var pr = f.properties || {}, data = {};
      Object.keys(pr).forEach(function (k) {
        if (k === "name" || k === "note" || k === "list") return;
        var v = pr[k]; data[k] = Array.isArray(v) ? v.join(", ") : String(v == null ? "" : v);
        fieldSet[k] = 1;
      });
      var folder = pr.list ? String(pr.list) : "";
      if (folder) folderSet[folder] = 1;
      marks.push({ name: pr.name ? String(pr.name) : "", lat: lat, lon: lon, desc: pr.note ? String(pr.note) : "", data: data, folder: folder });
    });
    return { marks: marks, fields: Object.keys(fieldSet), folders: Object.keys(folderSet) };
  }
  function startGeoJsonImport(text, fileName) {
    var parsed; try { parsed = parseGeoJsonText(text); } catch (e) { setStatus(t("kml.parseErr")); return; }
    if (!parsed.marks.length) { setStatus(t("kml.none")); return; }
    parsed.fileName = fileName || "";
    kmlImport = parsed; openKmlImportDialog();
  }
  // ---- KMZ (a ZIP holding doc.kml) — a tiny single-entry ZIP writer/reader,
  // using the browser's deflate-raw (same as share-link payloads). ----
  var _crcTable = null;
  function crc32(bytes) {
    if (!_crcTable) { _crcTable = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crcTable[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  async function buildKmz(kmlText) {
    var enc = new TextEncoder(), kml = enc.encode(kmlText), name = enc.encode("doc.kml");
    var crc = crc32(kml), uSize = kml.length, method = 0, data = kml;
    if (typeof CompressionStream !== "undefined") {
      try { data = new Uint8Array(await new Response(new Blob([kml]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()); method = 8; }
      catch (e) { data = kml; method = 0; }   // fall back to STORE
    }
    var cSize = data.length;
    var out = new Uint8Array(30 + name.length + cSize + 46 + name.length + 22), dv = new DataView(out.buffer), o = 0;
    dv.setUint32(o, 0x04034b50, true); o += 4; dv.setUint16(o, 20, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, method, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0x21, true); o += 2;   // mod time/date (1980)
    dv.setUint32(o, crc, true); o += 4; dv.setUint32(o, cSize, true); o += 4; dv.setUint32(o, uSize, true); o += 4;
    dv.setUint16(o, name.length, true); o += 2; dv.setUint16(o, 0, true); o += 2; out.set(name, o); o += name.length;
    out.set(data, o); o += cSize;
    var cdStart = o;
    dv.setUint32(o, 0x02014b50, true); o += 4; dv.setUint16(o, 20, true); o += 2; dv.setUint16(o, 20, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, method, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0x21, true); o += 2;
    dv.setUint32(o, crc, true); o += 4; dv.setUint32(o, cSize, true); o += 4; dv.setUint32(o, uSize, true); o += 4;
    dv.setUint16(o, name.length, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0, true); o += 2; dv.setUint32(o, 0, true); o += 4; dv.setUint32(o, 0, true); o += 4;
    out.set(name, o); o += name.length;
    var cdSize = o - cdStart;
    dv.setUint32(o, 0x06054b50, true); o += 4; dv.setUint16(o, 0, true); o += 2; dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, 1, true); o += 2; dv.setUint16(o, 1, true); o += 2; dv.setUint32(o, cdSize, true); o += 4; dv.setUint32(o, cdStart, true); o += 4; dv.setUint16(o, 0, true);
    return out;
  }
  // Pull the (first) .kml entry's text out of a KMZ ArrayBuffer via its central directory.
  async function extractKmlFromKmz(buf) {
    var bytes = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
    var eocd = -1, lim = Math.max(0, bytes.length - 22 - 65536);
    for (var i = bytes.length - 22; i >= lim; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("not a zip");
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), target = null;
    for (var e = 0; e < count && dv.getUint32(p, true) === 0x02014b50; e++) {
      var method = dv.getUint16(p + 10, true), cSize = dv.getUint32(p + 20, true);
      var fnLen = dv.getUint16(p + 28, true), exLen = dv.getUint16(p + 30, true), cmLen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      var fn = td.decode(bytes.subarray(p + 46, p + 46 + fnLen));
      if (/\.kml$/i.test(fn)) { target = { method: method, cSize: cSize, lho: lho }; if (/(^|\/)doc\.kml$/i.test(fn)) break; }
      p += 46 + fnLen + exLen + cmLen;
    }
    if (!target) throw new Error("no kml in kmz");
    var lFnLen = dv.getUint16(target.lho + 26, true), lExLen = dv.getUint16(target.lho + 28, true);
    var start = target.lho + 30 + lFnLen + lExLen, comp = bytes.subarray(start, start + target.cSize);
    if (target.method === 0) return td.decode(comp);
    if (target.method !== 8 || typeof DecompressionStream === "undefined") throw new Error("kmz compression");
    var raw = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    return td.decode(raw);
  }
  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    // Revoke on a timer, not in this tick: mobile browsers start reading the blob
    // after the click handler returns, and a same-tick revoke kills the save.
    setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
  }
  // One download entry point for the three formats, used by the per-list download
  // button. `colls` is the list(s) to write, `loose` the unfiled pins; both default
  // to everything, so the Settings "Export" keeps its old whole-set behaviour.
  var DL_MIME = { kml: "application/vnd.google-earth.kml+xml", geojson: "application/geo+json",
                  kmz: "application/vnd.google-earth.kmz" };
  function exportPointsAs(fmt, baseName, colls, loose) {
    var stamp = new Date().toISOString().slice(0, 10);
    var base = String(baseName || "map_points").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) + "_" + stamp;
    if (fmt === "geojson") {
      downloadBlob(base + ".geojson", new Blob([buildPointsGeoJson(colls, loose)], { type: DL_MIME.geojson }));
      return;
    }
    var kml = buildPointsKml(colls, loose);
    if (fmt !== "kmz") { downloadBlob(base + ".kml", new Blob([kml], { type: DL_MIME.kml })); return; }
    buildKmz(kml).then(function (bytes) {
      downloadBlob(base + ".kmz", new Blob([bytes], { type: DL_MIME.kmz }));
    }).catch(function () { setStatus(t("kml.parseErr")); });
  }
  function exportPointsKmz() {
    if (!pointsHasAny()) { setStatus(t("points.exportEmpty")); return; }
    buildKmz(buildPointsKml()).then(function (bytes) {
      downloadBlob("map_points_" + new Date().toISOString().slice(0, 10) + ".kmz", new Blob([bytes], { type: "application/vnd.google-earth.kmz" }));
    }).catch(function () { setStatus(t("kml.parseErr")); });
  }
  // ---- KML import ----
  // Parse a KML document into plain placemark records. Each carries its name,
  // coordinates, description, the enclosing folder name, and any ExtendedData /
  // SimpleData fields — which become the selectable import "fields".
  // KML writes colour as aabbggrr — alpha first and BLUE before red, the reverse of CSS.
  function kmlColorToHex(v) {
    var c = String(v || "").trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{8}$/.test(c)) return "";
    return "#" + c.slice(6, 8) + c.slice(4, 6) + c.slice(2, 4);   // rr gg bb
  }
  // Every <Style> in the document, by id → its icon colour. <StyleMap> is followed to its
  // "normal" pair, which is how most exporters (Google Earth included) write styles.
  function kmlStyleColors(doc) {
    var out = {}, i, id, st;
    var ss = doc.getElementsByTagName("Style");
    for (i = 0; i < ss.length; i++) {
      id = ss[i].getAttribute("id"); if (!id) continue;
      var ic = ss[i].getElementsByTagName("IconStyle")[0];
      var col = ic && ic.getElementsByTagName("color")[0];
      var hex = col ? kmlColorToHex(col.textContent) : "";
      if (hex) out[id] = hex;
    }
    var sm = doc.getElementsByTagName("StyleMap");
    for (i = 0; i < sm.length; i++) {
      id = sm[i].getAttribute("id"); if (!id) continue;
      var pairs = sm[i].getElementsByTagName("Pair");
      for (var k = 0; k < pairs.length; k++) {
        var key = pairs[k].getElementsByTagName("key")[0];
        if (!key || (key.textContent || "").trim() !== "normal") continue;
        var su = pairs[k].getElementsByTagName("styleUrl")[0];
        var ref = su ? (su.textContent || "").trim().replace(/^#/, "") : "";
        if (ref && out[ref]) out[id] = out[ref];
      }
    }
    return out;
  }
  // Async, and it yields: a 6.5 MB KMZ is 120 MB of KML and 73 891 placemarks, which used
  // to block the main thread long enough that the app looked dead — "Reading …" on screen
  // and nothing else for the better part of a minute on a phone. The DOMParser call itself
  // cannot be split (one native call, ~7 s for that file on a desktop), so the status is
  // painted BEFORE it, and the placemark walk then reports its way through in chunks.
  var PARSE_CHUNK = 4000;
  function yieldToUi() { return new Promise(function (r) { setTimeout(r, 0); }); }
  // A visible "Loading <file>…" while a point list is read, parsed and added (owner, 2026-10-01):
  // the status line alone is easy to miss under an open panel, and a big file blocks the page for
  // seconds. One fixed overlay (spinner + text); null hides it. Also mirrors every status update
  // of the import path, so the text moves with the parse ("Reading records… 12000 of 183588").
  function mpLoading(text) {
    var el = document.getElementById("mp-loading");
    if (!text) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) {
      el = document.createElement("div"); el.id = "mp-loading"; el.className = "kml-modal mp-loading";
      el.innerHTML = '<div class="kml-modal-box mp-loading-box"><div class="mp-hourglass" aria-hidden="true">\u231B</div><span id="mp-loading-txt"></span></div>';
      document.body.appendChild(el);
    }
    el.querySelector("#mp-loading-txt").textContent = text;
  }
  function loadStatus(msg) { setStatus(msg); if (document.getElementById("mp-loading")) mpLoading(msg); }
  async function parseKmlText(text) {
    loadStatus(t("kml.parsing"));
    await yieldToUi();                       // let that message paint before the long call
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error(t("kml.parseErr"));
    var marks = [], fieldSet = {}, folderSet = {};
    var styleCol = kmlStyleColors(doc);
    var pms = doc.getElementsByTagName("Placemark");
    function txt(el, tag) { var n = el.getElementsByTagName(tag)[0]; return n ? (n.textContent || "").trim() : ""; }
    for (var i = 0; i < pms.length; i++) {
      if (i && i % PARSE_CHUNK === 0) {
        loadStatus(t("kml.reading2", { n: i, total: pms.length }));
        await yieldToUi();
      }
      var pm = pms[i];
      // First coordinates found under this placemark (Point, else first vertex).
      var co = pm.getElementsByTagName("coordinates")[0];
      if (!co) continue;
      var first = (co.textContent || "").trim().split(/\s+/)[0] || "";
      var ll = first.split(",");
      var lon = parseFloat(ll[0]), lat = parseFloat(ll[1]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var data = {};
      var ds = pm.getElementsByTagName("Data");
      for (var d = 0; d < ds.length; d++) { var nm = ds[d].getAttribute("name"); var v = txt(ds[d], "value"); if (nm) { data[nm] = v; fieldSet[nm] = 1; } }
      var sds = pm.getElementsByTagName("SimpleData");
      for (var s = 0; s < sds.length; s++) { var snm = sds[s].getAttribute("name"); if (snm) { data[snm] = (sds[s].textContent || "").trim(); fieldSet[snm] = 1; } }
      // Enclosing folder name (nearest ancestor <Folder> with a <name>).
      var folder = "", a = pm.parentNode;
      while (a && a.nodeType === 1) { if (a.tagName === "Folder") { var fn = a.getElementsByTagName("name")[0]; if (fn) { folder = (fn.textContent || "").trim(); break; } } a = a.parentNode; }
      if (folder) folderSet[folder] = 1;
      // The placemark's own colour: an inline <Style> first, else the <styleUrl> it names.
      var pcol = "";
      var inline = pm.getElementsByTagName("Style")[0];
      if (inline) {
        var iic = inline.getElementsByTagName("IconStyle")[0];
        var icol = iic && iic.getElementsByTagName("color")[0];
        if (icol) pcol = kmlColorToHex(icol.textContent);
      }
      if (!pcol) {
        var suEl = pm.getElementsByTagName("styleUrl")[0];
        var sref = suEl ? (suEl.textContent || "").trim().replace(/^#/, "") : "";
        if (sref && styleCol[sref]) pcol = styleCol[sref];
      }
      marks.push({ name: txt(pm, "name"), lat: lat, lon: lon, desc: txt(pm, "description"), data: data, folder: folder, color: pcol });
    }
    return { marks: marks, fields: Object.keys(fieldSet), folders: Object.keys(folderSet) };
  }
  // Resolve a placemark field to text given a mapping token: "name" / "desc" /
  // "folder" / "data:<key>" / "" (none).
  // The same names the dialog's pickers show, for labelling a note built from several
  // fields. Mirrors opts() in openKmlImportDialog -- keep the two in step.
  function noteLabel(token) {
    if (token === "name") return t("kml.fName");
    if (token === "desc") return t("kml.fDesc");
    if (token === "folder") return t("kml.fFolder");
    if (token.indexOf("data:") === 0) return token.slice(5);
    return token;
  }
  function kmlFieldValue(pm, token) {
    if (!token) return "";
    if (token === "name") return pm.name || "";
    if (token === "desc") return pm.desc || "";
    if (token === "folder") return pm.folder || "";
    if (token.indexOf("data:") === 0) return (pm.data && pm.data[token.slice(5)]) || "";
    return "";
  }
  var kmlImport = null;   // { marks, fields, folders } currently staged for import
  async function startKmlImport(text, fileName) {
    var parsed;
    try { parsed = await parseKmlText(text); } catch (e) { mpLoading(null); setStatus(t("kml.parseErr")); return; }
    if (!parsed.marks.length) { mpLoading(null); setStatus(t("kml.none")); return; }
    parsed.fileName = fileName || "";
    kmlImport = parsed;
    setStatus("");
    openKmlImportDialog();
  }
  // ---- Several files in one go ----
  // Each file becomes its own list, named after the file, and the field mapping is asked
  // ONCE and applied to all of them: the files come from one builder run, so per-file
  // questions would be the same answer typed N times. The single-file path is untouched
  // (it still offers the list picker and the share-link fallback).
  function readFileBuf(f) {
    return new Promise(function (res, rej) {
      var rd = new FileReader();
      rd.onerror = function () { rej(new Error("read")); };
      rd.onload = function () { res(rd.result); };
      rd.readAsArrayBuffer(f);
    });
  }
  // Branch on the bytes, not the extension: ZIP magic → KMZ, a leading { or [ → GeoJSON,
  // anything else → KML. Same test the single-file reader uses, minus the share link
  // (a share link is one pasted list, never one of a batch).
  async function parsePointsBuf(buf) {
    var h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength || 0));
    if (h.length >= 4 && h[0] === 0x50 && h[1] === 0x4B && h[2] === 0x03 && h[3] === 0x04)
      return await parseKmlText(await extractKmlFromKmz(buf));
    var txt = new TextDecoder().decode(new Uint8Array(buf)).replace(/^\uFEFF/, "").trim();
    var c0 = txt.charAt(0);
    if (c0 === "{" || c0 === "[") return parseGeoJsonText(txt);
    return await parseKmlText(txt);
  }
  // "grouse_lek_points_2026-09-25.kmz" → "grouse_lek_points_2026-09-25". The list can be
  // renamed afterwards like any other, so keep the file's own name rather than guessing.
  function listNameFromFile(name) {
    return String(name || "").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 60);
  }
  // Two files can carry the same base name (the same builder run from two folders, or a
  // browser's "grouse (1).kmz"), and the name may already belong to a saved list. Suffix
  // "#2", "#3" ... rather than merging them: an import must never silently fold new points
  // into a list the user did not choose.
  function uniqueListName(base, taken) {
    if (taken.indexOf(base) < 0) return base;
    for (var n = 2; ; n++) {
      var cand = base + " #" + n;
      if (taken.indexOf(cand) < 0) return cand;
    }
  }
  async function startMultiImport(files) {
    var items = [], failed = [], shares = [];
    var taken = mpCollections.map(function (c) { return c.name; });
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      loadStatus(t("kml.readingN", { i: i + 1, n: files.length, name: f.name }));
      try {
        var buf = await readFileBuf(f);
        // A BirdsWhere .share observation list among the files (several person lists at
        // once, owner 2026-10-02): it is not a placemark file — "No place markers with
        // coordinates found" was the whole batch's answer. It goes through the share
        // import, saved as a point list like a single .share, without a prompt per file.
        var h = new Uint8Array(buf, 0, Math.min(2, buf.byteLength || 0)), c0 = h.length ? String.fromCharCode(h[0]) : "";
        if ((c0 === "0" || c0 === "1") && !(h.length > 1 && h[1] === 0x4B)) {
          shares.push({ name: f.name, txt: new TextDecoder().decode(new Uint8Array(buf)).replace(/^\uFEFF/, "").trim() });
          continue;
        }
        var parsed = await parsePointsBuf(buf);
        if (parsed.marks.length) {
          var nm = uniqueListName(listNameFromFile(f.name) || f.name, taken);
          taken.push(nm);
          items.push({ name: nm, parsed: parsed });
        }
        else failed.push(f.name);
      } catch (e) { failed.push(f.name); }
    }
    for (var si = 0; si < shares.length; si++) {
      loadStatus(t("kml.readingN", { i: si + 1, n: shares.length, name: shares[si].name }));
      try { await window.AppShare.importShared(shares[si].txt, { asList: true, fileName: shares[si].name, quiet: true }); }
      catch (e) { failed.push(shares[si].name); }
    }
    if (!items.length) {
      mpLoading(null);
      setStatus(shares.length && failed.length < shares.length ? t("share.importedLists", { n: shares.length - failed.length }) : t("kml.none"));
      return;
    }
    // One staged import holding every file: the union of fields/folders drives the
    // pickers (so a field present in only one file is still offerable), and the union
    // of marks drives the count and the "note looks like HTML" default.
    var fieldSet = {}, folderSet = {}, marks = [], batch = [];
    items.forEach(function (it) {
      it.parsed.fields.forEach(function (f) { fieldSet[f] = 1; });
      it.parsed.folders.forEach(function (f) { folderSet[f] = 1; });
      marks = marks.concat(it.parsed.marks);
      batch.push({ name: it.name, marks: it.parsed.marks });
    });
    kmlImport = { marks: marks, fields: Object.keys(fieldSet), folders: Object.keys(folderSet), files: batch };
    setStatus(failed.length ? t("kml.someFailed", { n: failed.length }) : "");
    openKmlImportDialog();
  }
  // A small modal: choose the target list and which placemark field maps to the
  // point's name / tag / note, then import. Built on demand and removed on close.
  function openKmlImportDialog() {
    var p = kmlImport; if (!p) return;
    mpLoading(null);
    closeKmlImportDialog();
    // Field options shared by the name/tag/note pickers.
    function opts(extra) {
      var o = extra.slice();
      o.push({ v: "name", l: t("kml.fName") });
      o.push({ v: "desc", l: t("kml.fDesc") });
      if (p.folders.length) o.push({ v: "folder", l: t("kml.fFolder") });
      p.fields.forEach(function (f) { o.push({ v: "data:" + f, l: f }); });
      return o;
    }
    function sel(id, items, cur) {
      return '<select id="' + id + '">' + items.map(function (it) {
        return '<option value="' + escapeHtml(it.v) + '"' + (it.v === cur ? " selected" : "") + ">" + escapeHtml(it.l) + "</option>";
      }).join("") + "</select>";
    }
    // The note may be built from SEVERAL fields, so it gets a checkbox dropdown rather
    // than a single-choice <select>: a placemark often splits what belongs in one note
    // across description + behaviour + habitat, and picking one threw the rest away.
    function multiSel(id, items, cur) {
      return '<div class="kml-ms" id="' + id + '-ms">' +
        '<button type="button" class="kml-ms-btn" id="' + id + '-btn" aria-expanded="false" aria-haspopup="true"></button>' +
        '<div class="kml-ms-menu" id="' + id + '-menu">' + items.map(function (it) {
          return '<label class="kml-ms-item"><input type="checkbox" value="' + escapeHtml(it.v) + '"' +
            (it.v === cur ? " checked" : "") + ">" + escapeHtml(it.l) + "</label>";
        }).join("") + "</div></div>";
    }
    var listItems = [{ v: "__new__", l: t("detmenu.newList") }].concat(
      mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) { return { v: c.name, l: c.name }; }));
    // A batch has no target picker: the list names are the file names, shown so the user
    // can see what they are about to get (and what each file contributed) before importing.
    var multi = !!(p.files && p.files.length > 1);
    var targetRow = multi
      ? '<div class="kml-row kml-multi">' + escapeHtml(t("kml.perFile", { n: p.files.length })) + "</div>" +
        '<div class="kml-multi-list">' + p.files.map(function (b) {
          return escapeHtml(b.name) + ' <span class="dh-meta">' + b.marks.length + "</span>";
        }).join("<br>") + "</div>"
      : '<label class="kml-row">' + escapeHtml(t("kml.target")) + sel("kml-target", listItems, "__new__") + "</label>";
    // Sensible defaults: name←Name, tag←folder (if any) else none, note←description.
    var defName = "name", defTag = p.folders.length ? "folder" : "", defNote = "desc";
    // Pre-tick "note is HTML" when the descriptions look like markup (common for
    // KML exported by Google Earth, which wraps rich text / tables in the note).
    var htmlish = p.marks.filter(function (m) { return looksLikeHtml(m.desc); }).length;
    var defHtml = htmlish * 2 >= p.marks.length && htmlish > 0;
    var html = '<div class="kml-modal-box">' +
      '<button type="button" id="kml-close" class="kml-close" aria-label="Close">×</button>' +
      "<h3>" + escapeHtml(t("kml.title")) + "</h3>" +
      '<p class="cu-hint">' + escapeHtml(t("kml.found", { n: p.marks.length })) + "</p>" +
      targetRow +
      '<label class="kml-row">' + escapeHtml(t("kml.nameFrom")) + sel("kml-name", opts([]), defName) + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.tagFrom")) + sel("kml-tag", opts([{ v: "", l: t("kml.fNone") }]), defTag) + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.noteFrom")) + multiSel("kml-note", opts([]), defNote) + "</label>" +
      '<label class="kml-row kml-check"><input type="checkbox" id="kml-note-html"' + (defHtml ? " checked" : "") + " />" + escapeHtml(t("points.noteHtml")) + "</label>" +
      '<div class="kml-actions"><button type="button" id="kml-do" class="btn">' + escapeHtml(t("kml.import")) + "</button></div>" +
      "</div>";
    var ov = document.createElement("div");
    ov.id = "kml-import-modal"; ov.className = "kml-modal";
    ov.innerHTML = html;
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeKmlImportDialog(); });
    document.getElementById("kml-close").addEventListener("click", closeKmlImportDialog);
    document.getElementById("kml-do").addEventListener("click", doKmlImport);
    wireNoteMulti(ov);
  }
  function closeKmlImportDialog() { var m = document.getElementById("kml-import-modal"); if (m && m.parentNode) m.parentNode.removeChild(m); }
  // Which fields the note is built from, in the order the dialog lists them (not the order
  // they were ticked) so the note reads the same way every time.
  function noteTokens() {
    var menu = document.getElementById("kml-note-menu");
    if (!menu) return [];
    return [].filter.call(menu.querySelectorAll("input[type=checkbox]"), function (c) { return c.checked; })
             .map(function (c) { return c.value; });
  }
  function wireNoteMulti(root) {
    var btn = root.querySelector("#kml-note-btn"), menu = root.querySelector("#kml-note-menu");
    if (!btn || !menu) return;
    function label() {
      var on = [].filter.call(menu.querySelectorAll("input[type=checkbox]"), function (c) { return c.checked; });
      btn.textContent = (on.length === 0 ? t("kml.fNone")
        : on.length === 1 ? on[0].parentNode.textContent.trim()
        : t("kml.nFields", { n: on.length })) + " \u25BE";
    }
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      var open = menu.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });   // ticking must not close it
    menu.addEventListener("change", label);
    // A click anywhere else in the dialog closes it, like any dropdown.
    root.addEventListener("click", function () {
      menu.classList.remove("is-open"); btn.setAttribute("aria-expanded", "false");
    });
    label();
  }
  // Field names the builders (and GBIF/Google Earth exports generally) use, mapped onto the
  // point's own structured fields. First match wins; a value the user mapped by hand in the
  // dialog is never overwritten.
  var FIELD_ALIASES = {
    sci: ["species", "scientificName", "scientific_name", "sciname", "taxon"],
    date: ["date", "eventDate", "event_date", "observed", "obsDate"],
    observer: ["observer", "recordedBy", "recorded_by", "recorder", "collector"],
    count: ["count", "individualCount", "individual_count", "number"],
    place: ["place", "locality", "location"],
    // The observer's own remark. Without this it survived ONLY inside the placemark's
    // <description> HTML, so dropping that table would have thrown the one piece of free
    // text the file carries away with the duplication.
    note: ["notes", "occurrenceRemarks", "remarks", "fieldNotes", "comment"],
    // What the record SHOWS, plus the rest of what the <description> table displayed. Every
    // one of these travels in ExtendedData on the files the point builders write, and until
    // v1927 NOTHING read them: the value existed only inside that table. So dropping the
    // table -- on import since v1923, and in Compact -- is what took the activity off the
    // card. "evidence" is listed before "category" because a mentions file carries both and
    // evidence is the specific one.
    act: ["activity", "act", "evidence", "behavior", "behaviour",
          "breedingEvidence", "breeding_evidence", "category"],
    stage: ["lifeStage", "life_stage", "lifestage", "age"],
    country: ["country", "countryCode", "country_code"],
    dset: ["dataset", "datasetName", "dataset_name", "collectionCode"],
    // How far off the position may be, in metres — drawn as a transparent circle round the pin
    // (owner, 2026-10-07: "make a point list with radius of transparent dots reflecting uncertainty")
    radius: ["uncertainty_m", "radius_m", "radius", "coordinateUncertaintyInMeters", "uncertainty", "accuracy"],
    // The pin's symbol: "ring" = an unfilled circle in the point's colour (owner, 2026-10-10: the
    // terrain-placed DTM points of the map-dot lists are "unfilled red circles")
    marker: ["marker", "symbol"]
  };
  // Our own point builders write the whole record as an HTML <table> into <description>:
  // species, date, place, country, evidence, count, notes, observer, dataset, a GBIF link.
  // Every one of those is ALSO in the placemark's ExtendedData, which is what the app reads
  // into structured fields — so keeping the table costs ~780 bytes a point (86 MB across the
  // 23 generated files) to say the same thing twice. Recognised by its own shape, so a
  // description written by Google Earth or anyone else is left untouched.
  function isGeneratedTable(note) {
    if (!note || note.length < 40) return false;
    var s = String(note);
    return s.indexOf("<table>") >= 0 && /<td><b>(Species|Date|Place|Breeding evidence)<\/b><\/td>/.test(s);
  }
  // Pull the observer's remark back out of a generated table. On points imported BEFORE the
  // note became a field, that text exists nowhere else — dropping the table without this would
  // destroy it. The builder writes it as the row <td><b>Notes</b></td><td>…</td>.
  function unTable(html) {
    return String(html || "").replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").trim();
  }
  function remarkFromTable(note) {
    var m = /<td><b>Notes<\/b><\/td>\s*<td>([\s\S]*?)<\/td>/i.exec(String(note || ""));
    return m ? unTable(m[1]) : "";
  }
  // Which table rows can fill each structured field, BEST FIRST. Order matters and row order
  // must not decide it: a per-species file writes both "Category" (the palette bucket, whose
  // value is the 4-language legend label) and "Breeding evidence" (what THIS record shows),
  // and the specific one has to win even though the table prints it later.
  var TABLE_FIELD_ROWS = {
    sci: ["species"],
    date: ["date"],
    place: ["place", "locality"],
    country: ["country"],
    count: ["count"],
    stage: ["life stage"],
    note: ["notes"],
    observer: ["observer"],
    dset: ["dataset"],
    act: ["breeding evidence", "evidence", "activity", "behaviour", "behavior", "category"]
  };
  // A point imported before v1923 kept the whole table as its note and has NO fields at all:
  // its activity, life stage, country and dataset live only in these rows. So the table has to
  // be READ before it is dropped -- otherwise compacting is itself what destroys the record.
  function fieldsFromTable(note, pt) {
    var s = String(note || ""), got = 0, m, rows = {};
    var rx = /<td><b>([^<]+)<\/b><\/td>\s*<td>([\s\S]*?)<\/td>/gi;
    while ((m = rx.exec(s))) {
      var lab = m[1].trim().toLowerCase(), v = unTable(m[2]);
      if (v && rows[lab] == null) rows[lab] = v;
    }
    Object.keys(TABLE_FIELD_ROWS).forEach(function (f) {
      if (pt[f] != null && pt[f] !== "") return;
      var cand = TABLE_FIELD_ROWS[f];
      for (var i = 0; i < cand.length; i++) {
        var v = rows[cand[i]];
        if (!v) continue;
        // The Species row carries a binomial in a per-record file but the CATEGORY label in a
        // per-category one -- only take it when it really looks like a scientific name.
        if (f === "sci" && !/^[A-Z][a-z]+ [a-z][a-z-]+$/.test(v)) continue;
        if (f === "date") { var d = /\d{4}-\d{2}-\d{2}/.exec(v); v = d ? d[0] : v.slice(0, 10); }
        // "territory - territory / display / revir / spill" is a legend label, not a value:
        // keep the key and drop the translations it carries for the map legend.
        if (f === "act" && / - /.test(v) && /\//.test(v.split(" - ").slice(1).join(" - "))) v = v.split(" - ")[0].trim();
        pt[f] = v; got++; return;
      }
    });
    // the "Record" row was a link to the source occurrence
    if (!pt.url) {
      var a = /<td><b>Record<\/b><\/td>\s*<td>\s*<a href="([^"]+)"/i.exec(s);
      if (a) { pt.url = a[1]; got++; }
    }
    return got;
  }
  // One-off: bring lists imported before v1923 down to the same size as a fresh import.
  // Returns {points, stripped, before, after} in bytes so the UI can say what it freed.
  async function compactStoredPoints() {
    var before = 0, after = 0, stripped = 0, npts = 0, recovered = 0;
    mpCollections.forEach(function (c) {
      (c.points || []).forEach(function (p) {
        if (!p) return;
        npts++;
        var n = p.note ? String(p.note).length : 0;
        before += n;
        if (isGeneratedTable(p.note)) {
          recovered += fieldsFromTable(p.note, p);   // MUST run before the table goes
          var remark = remarkFromTable(p.note);
          if (remark) p.note = remark; else delete p.note;
          delete p.noteHtml;
          stripped++;
        }
        after += p.note ? String(p.note).length : 0;
      });
    });
    internPoints(mpCollections);
    await persistMpSets(mpCollections);
    renderMapPoints();
    return { points: npts, stripped: stripped, before: before, after: after, recovered: recovered };
  }
  // The key a list point plots under: its stored model key, else the model species its
  // scientific name resolves to, else an "x:<sci>" extra — the same keys fetched data uses.
  // So EVERY record with a species, model or not, goes through the detection pipeline:
  // legend row, translated name, species menu, source link, ⓘ (owner, 2026-10-02: "the popup
  // windows for imported lists … should look the same as fetched data").
  // A stored "x:<sci>" key (a name the model did not know as written — an old genus, say) is
  // looked up again, so lists imported before the resolver existed show the model species too.
  var _xKeyOf = Object.create(null);
  function detKeyOf(p) {
    if (!p) return "";
    if (p.spKey) {
      if (p.spKey.indexOf("x:") !== 0) return p.spKey;
      var xk = p.spKey + "|" + (p.cls || "");
      if (!(xk in _xKeyOf)) { var lx = labelForSci(p.spKey.slice(2), p.cls); _xKeyOf[xk] = lx ? lx.key : p.spKey; }
      return _xKeyOf[xk];
    }
    var sci = String(p.sci || "").trim(); if (!sci) return "";
    var l = labelForSci(sci, p.cls);
    return l ? l.key : "x:" + sci;
  }
  var SRC_OF = { ao: "Artsobs", gbif_sql: "GBIF", gbif_api: "GBIF", parquet: "GBIF", artsobservasjoner: "Artsobs", artportalen: "Artportalen" };
  function applyKmlFields(pt, data) {
    if (!data) return;
    Object.keys(FIELD_ALIASES).forEach(function (field) {
      if (pt[field] != null && pt[field] !== "") return;   // the dialog's mapping wins
      var names = FIELD_ALIASES[field];
      for (var i = 0; i < names.length; i++) {
        var v = data[names[i]];
        if (v == null || String(v).trim() === "") continue;
        v = String(v).trim();
        if (field === "date") { var m = /\d{4}-\d{2}-\d{2}/.exec(v); v = m ? m[0] : v.slice(0, 10); }
        if (field === "radius") { v = parseFloat(v); if (!(v > 0)) continue; }
        pt[field] = v;
        return;
      }
    });
    // The source occurrence link, so the card's "source" row still works once the generated
    // table (whose last row was that link) is gone.
    if (!pt.url) {
      var u = data.url || data.link || data.references || data.occurrenceURL;
      if (!u && data.gbifID) u = "https://www.gbif.org/occurrence/" + String(data.gbifID).trim();
      // The builders' `id`: a GBIF occurrence id, or "AO<n>" = an Artsobservasjoner sighting.
      var rid = String(data.id || "").trim();
      if (!u && /^AO\d+$/.test(rid)) u = "https://mobil.artsobservasjoner.no/sighting/" + rid.slice(2);
      else if (!u && /^\d{5,}$/.test(rid)) u = "https://www.gbif.org/occurrence/" + rid;
      if (u) pt.url = String(u).trim();
    }
    // Source badge + class, so the injected record reads like a fetch (Artsobs / GBIF, Aves …).
    if (!pt.src) {
      var sk = String(data.src || "").trim().toLowerCase(), ds = String(data.dataset || data.datasetName || "").trim().toLowerCase();
      pt.src = SRC_OF[sk] || SRC_OF[ds] || (/artsobs/.test(ds) ? "Artsobs" : (data.gbifID || /^\d{5,}$/.test(String(data.id || "")) ? "GBIF" : ""));
      if (!pt.src) delete pt.src;
    }
    var cl = String(data["class"] || data.klass || data.taxonClass || "").trim();
    if (cl && !pt.spCls) pt.spCls = cl;
    if (!pt.spKey && pt.sci) { var lk = labelForSci(pt.sci); if (lk) pt.spKey = lk.key; }
    if (/^(1|true|yes)$/i.test(String(data.route || "").trim())) pt.source = "route";   // the stop of a downloaded route
    // Tags may travel as a field too ("a; b" or "a, b"), alongside whatever the dialog mapped.
    var tg = data.tags || data.tag;
    if (tg) {
      String(tg).split(/[;,|]/).forEach(function (x) {
        x = x.trim(); if (x && (pt.tags || []).indexOf(x) < 0) (pt.tags = pt.tags || []).push(x);
      });
    }
  }
  function doKmlImport() {
    var p = kmlImport; if (!p) return;
    var targetEl0 = document.getElementById("kml-target"), tsel = targetEl0 ? targetEl0.value : "";
    var into = (p.files && p.files.length) ? p.files.map(function (b) { return b.name; }).join(", ") : (tsel === "__new__" ? (p.fileName || "") : tsel);
    mpLoading(t("kml.importing", { name: into || "…" }));
    setTimeout(function () { try { doKmlImportNow(); } finally { mpLoading(null); } }, 30);   // let the overlay paint before the page blocks
  }
  function doKmlImportNow() {
    var p = kmlImport; if (!p) return;
    var targetEl = document.getElementById("kml-target");
    var target = targetEl ? targetEl.value : "";
    var nameTok = document.getElementById("kml-name").value;
    var tagTok = document.getElementById("kml-tag").value;
    var noteToks = noteTokens();
    var noteHtmlBox = document.getElementById("kml-note-html");
    var noteIsHtml = !!(noteHtmlBox && noteHtmlBox.checked);
    function finish(listName, marks, show) {
      var pts = (marks || p.marks).map(function (pm) {
        var tag = normTag(kmlFieldValue(pm, tagTok));
        // One field → exactly what it always was. Several → each line labelled, because
        // three bare values stacked in a note say nothing about what they are.
        var note = noteToks.length === 1
          ? kmlFieldValue(pm, noteToks[0]).trim()
          : noteToks.map(function (tk) {
              var v = kmlFieldValue(pm, tk).trim();
              return v ? (noteLabel(tk) + ": " + v) : "";
            }).filter(Boolean).join("\n");
        var pt = { id: mpUid(), lat: pm.lat, lon: pm.lon,
          name: kmlFieldValue(pm, nameTok).trim() || pm.name || "",
          tags: tag ? [tag] : [], note: note, source: "kml", createdAt: new Date().toISOString() };
        // Structured fields, taken from the placemark's own ExtendedData when it has them —
        // the point builders already write species / date / observer / count, and throwing
        // them away is what left an imported list unfilterable. Purely additive: a file
        // without them yields exactly the point it did before.
        applyKmlFields(pt, pm.data);
        // The note the dialog mapped is our own generated table → keep only what it was
        // duplicating. applyKmlFields has just put the observer's remark into pt.note when the
        // placemark carried one, so prefer that; otherwise the table said nothing the
        // structured fields do not, and goes.
        var droppedTable = false;
        if (isGeneratedTable(pt.note)) {
          fieldsFromTable(pt.note, pt);   // anything the ExtendedData did not already carry
          var remark = "";
          try { remark = String((pm.data && (pm.data.notes || pm.data.occurrenceRemarks)) || "").trim(); } catch (e) {}
          if (remark) pt.note = remark; else delete pt.note;
          droppedTable = true;
        }
        // A file that says what colour a point should be is obeyed — without this every
        // imported set came out in ONE colour hashed from the list name, whatever the
        // file's own styling said.
        if (pm.color) pt.color = pm.color;
        // …and only flag markup when what SURVIVED is markup. The table we just replaced with
        // a plain remark is not, and setting the flag from the dialog's checkbox regardless
        // marked every point as HTML.
        if (noteIsHtml && pt.note && !droppedTable) pt.noteHtml = true;
        return pt;
      });
      var c = mpCollections.filter(function (x) { return x.name === listName; })[0];
      if (!c) { c = { name: listName, points: [] }; mpCollections.push(c); }
      c.points = c.points.concat(pts);
      if (pts.length && pts.every(function (p) { return p.source === "route"; })) c.route = true;   // a loaded route is a route: numbered stops, arrows, Navigate
      internPoints([c]);   // a fresh import is the other place equal strings arrive unshared
      if (show !== false) shownColls[listName] = true;   // a batch of files is saved UNTICKED (owner, 2026-10-02): tick what you want to see
      return pts.length;
    }
    // Commit once for the whole batch: one saveMapPoints / renderMapPoints for N lists
    // instead of N of each (a ten-file import re-rendered the map ten times otherwise).
    function commit() {
      saveShownState(); saveMapPoints(); renderMapPoints();
      closeKmlImportDialog(); kmlImport = null;
    }
    if (p.files && p.files.length) {
      var total = 0;
      p.files.forEach(function (b) { total += finish(b.name, b.marks, p.files.length === 1); });
      commit();
      setStatus(p.files.length > 1 ? t("kml.importedN", { n: total, lists: p.files.length })
                                   : t("kml.imported", { n: total, name: p.files[0].name }));
      return;
    }
    var one = function (nm) { var n = finish(nm); commit(); setStatus(t("kml.imported", { n: n, name: nm })); };
    if (target === "__new__") {
      var suggest = p.fileName
        ? uniqueListName(listNameFromFile(p.fileName) || p.fileName, mpCollections.map(function (c) { return c.name; }))
        : "";
      modalPrompt(t("detmenu.newListPrompt"), suggest).then(function (n) { n = (n || "").trim(); if (n) one(n); });
    } else one(target);
  }
  // Open Google Maps with a navigable route through the given points (the start
  // is the user's own location). A single point → directions straight to it;
  // several → waypoints. The Maps URL API allows ~10 stops, so we route to the
  // nearest ones to the current map view and note when some are dropped.
  var GMAP_MAX_STOPS = 10;
  function gmapRoute(pts) {
    var ll = function (x) { return (+x.lat).toFixed(6) + "," + (+x.lon).toFixed(6); };
    if (pts.length === 1) return "https://www.google.com/maps/dir/?api=1&destination=" + ll(pts[0]) + "&travelmode=driving";
    var dest = pts[pts.length - 1], wps = pts.slice(0, pts.length - 1).map(ll).join("|");
    return "https://www.google.com/maps/dir/?api=1&destination=" + ll(dest) + "&waypoints=" + encodeURIComponent(wps) + "&travelmode=driving";
  }
  // Reference point for ordering/capping the navigation stops: the current map
  // marker (the clicked/located spot) when it's visible, else the map centre.
  function navRefPoint() {
    if (getMarker() && getMap()) {
      try { var ll = getMarker().getLatLng(); if (getMap().getBounds().contains(ll)) return { lat: ll.lat, lon: ll.lng }; } catch (e) {}
    }
    var c = getMap() && getMap().getCenter();
    return c ? { lat: c.lat, lon: c.lng } : null;
  }
  function navigatePoints(pts) {
    var seen = {}, uniq = [];
    (pts || []).forEach(function (p) {
      if (!p || !isFinite(+p.lat) || !isFinite(+p.lon)) return;
      var k = (+p.lat).toFixed(4) + "," + (+p.lon).toFixed(4);   // collapse co-located points to one stop
      if (seen[k]) return; seen[k] = 1; uniq.push({ lat: +p.lat, lon: +p.lon });
    });
    if (!uniq.length) { setStatus(t("nav.empty")); return; }
    // Keep the stops nearest the current marker (or map centre) so a capped route
    // covers the most relevant spots…
    var ref = navRefPoint();
    if (ref && uniq.length > 1) uniq.sort(function (a, b) { return haversineKm(ref.lat, ref.lon, a.lat, a.lon) - haversineKm(ref.lat, ref.lon, b.lat, b.lon); });
    var dropped = Math.max(0, uniq.length - GMAP_MAX_STOPS);
    var stops = uniq.slice(0, GMAP_MAX_STOPS);
    // …then order them as a greedy nearest-neighbour chain from the reference, so
    // the driving route runs spot-to-spot instead of zig-zagging.
    if (ref && stops.length > 2) {
      var chain = [], rem = stops.slice(), cur = ref;
      while (rem.length) {
        var bi = 0, bd = Infinity;
        for (var i = 0; i < rem.length; i++) { var dd = haversineKm(cur.lat, cur.lon, rem[i].lat, rem[i].lon); if (dd < bd) { bd = dd; bi = i; } }
        cur = rem[bi]; chain.push(cur); rem.splice(bi, 1);
      }
      stops = chain;
    }
    openExternal(gmapRoute(stops));   // Google Maps driving directions → tap Start for car navigation
    setStatus(dropped ? t("nav.capped", { n: GMAP_MAX_STOPS, dropped: dropped }) : t("nav.opened", { n: stops.length }));
  }
  // ---- Route basket: hand-pick stops (in order), then open one driving route ---
  var routePoints = [];
  function loadRoute() { routePoints = (window.GeoState.get("routePoints", []) || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); }); }
  function saveRoute() { window.GeoState.save({ routePoints: routePoints }); }
  function addToRoute(lat, lon, name) {
    if (!isFinite(+lat) || !isFinite(+lon)) return;
    routePoints.push({ lat: +lat, lon: +lon, name: name || "" });
    saveRoute(); updateRouteChip(); renderRoutePoints();
    setStatus(t("route.added", { n: routePoints.length }));
  }
  function clearRoute() { routePoints = []; saveRoute(); updateRouteChip(); renderRoutePoints(); }
  // The stops of every SHOWN saved route list (ticked in the Points panel), in list
  // then point order — used to display + navigate a reloaded saved route.
  function shownRouteStops() {
    var out = [];
    mpCollections.forEach(function (c) {
      if (!shownColls[c.name] || !isRouteColl(c)) return;
      (c.points || []).forEach(function (p) { if (p && isFinite(+p.lat) && isFinite(+p.lon)) out.push({ lat: +p.lat, lon: +p.lon, name: p.name || "" }); });
    });
    return out;
  }
  // The route currently on the map + in the nav bar: the in-progress basket if it has
  // stops, otherwise a reloaded saved route (its shown list). `fromBasket` says which,
  // so the pins offer "remove stop" only while editing the live basket.
  function activeRoute() { return routePoints.length ? routePoints : shownRouteStops(); }
  // Each route stop is drawn on the map as a numbered pin; tapping one (in the live
  // basket) offers to remove it from the route.
  var routeLayer = null;
  function renderRoutePoints() {
    if (!getMap()) return;
    if (!routeLayer) routeLayer = L.layerGroup().addTo(getMap());
    routeLayer.clearLayers();
    var fromBasket = routePoints.length > 0;
    activeRoute().forEach(function (p, i) {
      var icon = L.divIcon({ className: "route-pin-icon", html: '<div class="route-pin">' + (i + 1) + "</div>", iconSize: [26, 26], iconAnchor: [13, 13] });
      var m = L.marker([p.lat, p.lon], { icon: icon, keyboard: false, zIndexOffset: 800 });
      var pop = document.createElement("div"); pop.className = "route-pop";
      var ttl = document.createElement("div"); ttl.className = "route-pop-name";
      ttl.textContent = (i + 1) + ". " + (p.name || t("route.stop", { n: i + 1 }));
      pop.appendChild(ttl);
      if (fromBasket) pop.appendChild(makePopupBtn("🗑 " + t("route.remove"), "btn-light", function () { getMap().closePopup(); removeFromRoute(i); }));
      m.bindPopup(pop, { className: "route-pop-popup" });
      routeLayer.addLayer(m);
    });
    // Travel direction (owner, 2026-10-04): a line from each stop to the next with an arrow
    // at its middle, turned to the segment's screen bearing (constant across zooms in the
    // Web-Mercator view, so one render suffices).
    var stops = activeRoute();
    for (var i = 1; i < stops.length; i++) {
      var a = stops[i - 1], b = stops[i];
      routeLayer.addLayer(L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: "#2e8b74", weight: 3, opacity: 0.75, dashArray: "6 6", interactive: false }));
      var pa = getMap().latLngToLayerPoint([a.lat, a.lon]), pb = getMap().latLngToLayerPoint([b.lat, b.lon]);
      var deg = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      var arrow = L.divIcon({ className: "route-arrow-icon", html: '<div class="route-arrow" style="transform:rotate(' + deg.toFixed(1) + 'deg)">\u27A4</div>', iconSize: [22, 22], iconAnchor: [11, 11] });
      routeLayer.addLayer(L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], { icon: arrow, keyboard: false, interactive: false, zIndexOffset: 700 }));
    }
  }
  function removeFromRoute(i) {
    if (i < 0 || i >= routePoints.length) return;
    routePoints.splice(i, 1);
    saveRoute(); updateRouteChip(); renderRoutePoints();
    setStatus(routePoints.length ? t("route.added", { n: routePoints.length }) : t("route.cleared"));
  }
  // Save the current route's stops (in order) as a named point list, so it's kept
  // and can be re-shown / shared / navigated later from the Points panel.
  function saveRouteAsList() {
    if (!routePoints.length) { setStatus(t("nav.empty")); return; }
    modalPrompt(t("route.savePrompt"), "").then(function (nm) {
      nm = (nm || "").trim(); if (!nm) return;
      var saved = routePoints.length;
      var c = mpCollections.filter(function (x) { return x.name === nm; })[0];
      if (!c) { c = { name: nm, points: [] }; mpCollections.push(c); }
      c.route = true;   // mark it a route so reloading it restores numbered stops + the nav bar
      routePoints.forEach(function (p, i) {
        c.points.push({ id: mpUid(), lat: p.lat, lon: p.lon, name: p.name || t("route.stop", { n: i + 1 }), source: "route", createdAt: new Date().toISOString() });
      });
      shownColls[nm] = true;
      // The route now lives on as this shown saved list — empty the live basket so the
      // stops aren't drawn twice; the saved list keeps the numbered pins + nav bar.
      routePoints = []; saveRoute();
      saveMapPoints(); saveShownState(); renderMapPoints(); refreshMpPanel();
      setStatus(t("route.saved", { name: nm, n: saved }));
    });
  }
  // Open an ordered list of stops as a Google Maps route (add-order = intended
  // order — don't reshuffle). Shared by the route bar and the Points-panel route lists.
  function navigateStops(stops) {
    stops = (stops || []).filter(function (p) { return isFinite(+p.lat) && isFinite(+p.lon); });
    if (!stops.length) { setStatus(t("nav.empty")); return; }
    var use = stops.slice(0, GMAP_MAX_STOPS);
    openExternal(gmapRoute(use));
    if (stops.length > GMAP_MAX_STOPS) setStatus(t("nav.capped", { n: GMAP_MAX_STOPS, dropped: stops.length - GMAP_MAX_STOPS }));
    else setStatus(t("nav.opened", { n: use.length }));
  }
  function navigateRoute() { navigateStops(activeRoute()); }
  // The chip's × clears the live basket, or (for a reloaded saved route) hides it.
  function clearOrHideRoute() {
    if (routePoints.length) { clearRoute(); return; }
    var changed = false;
    mpCollections.forEach(function (c) { if (isRouteColl(c) && shownColls[c.name]) { delete shownColls[c.name]; changed = true; } });
    if (changed) { saveShownState(); renderMapPoints(); }
  }
  // A floating pill (shown only while the basket has stops) with the count, a
  // Navigate button and a Clear ×.
  var routeChipEl = null;
  // The route's stops as a draggable list (owner, 2026-10-04): drag a row (its ⋮⋮ handle, or
  // the row itself on touch) up or down, or use ▲ ▼; the numbered pins are redrawn in the
  // new order. Edits the live basket (the route being entered); a single shown saved route
  // can be reordered too (its list is saved), several shown routes are listed read-only.
  var routeStopsEl = null;
  function routeStopsTarget() {
    if (routePoints.length) return { pts: routePoints, save: function () { saveRoute(); }, basket: true };
    var lists = mpCollections.filter(function (c) { return isRouteColl(c) && shownColls[c.name]; });
    if (lists.length === 1) return { pts: lists[0].points, save: function () { saveMapPoints(); }, basket: false };
    return null;
  }
  function closeRouteStops() { if (routeStopsEl && routeStopsEl.parentNode) routeStopsEl.parentNode.removeChild(routeStopsEl); routeStopsEl = null; }
  function openRouteStops() {
    closeRouteStops();
    var tg = routeStopsTarget(), route = tg ? tg.pts : activeRoute();
    if (!route.length) return;
    var el = document.createElement("div"); el.id = "route-stops"; routeStopsEl = el;
    var html = '<div class="rs-head"><b>' + escapeHtml(t("route.stopsTitle", { n: route.length })) + '</b><button type="button" class="rs-x" aria-label="' + escapeHtml(t("btn.close")) + '">×</button></div>' +
      (tg ? '<div class="rs-hint">' + escapeHtml(t("route.reorderHint")) + "</div>" : "") + '<div class="rs-list">';
    route.forEach(function (p, i) {
      html += '<div class="rs-row" data-i="' + i + '">' + (tg ? '<span class="rs-grip" aria-hidden="true">\u22EE\u22EE</span>' : "") +
        '<span class="rs-n">' + (i + 1) + '</span><span class="rs-name">' + escapeHtml(p.name || t("route.stop", { n: i + 1 })) + "</span>" +
        (tg ? '<button type="button" class="rs-up" data-i="' + i + '" aria-label="\u25B2">\u25B2</button><button type="button" class="rs-down" data-i="' + i + '" aria-label="\u25BC">\u25BC</button>' : "") +
        (tg && tg.basket ? '<button type="button" class="rs-del" data-i="' + i + '" aria-label="' + escapeHtml(t("route.remove")) + '" title="' + escapeHtml(t("route.remove")) + '">×</button>' : "") + "</div>";
    });
    el.innerHTML = html + "</div>";
    document.body.appendChild(el);
    el.querySelector(".rs-x").addEventListener("click", closeRouteStops);
    if (!tg) return;
    function commit(order) {   // order = the old indices in their new positions
      var nw = order.map(function (i) { return route[i]; });
      route.length = 0; Array.prototype.push.apply(route, nw);
      tg.save(); renderRoutePoints(); updateRouteChip(); openRouteStops();
    }
    function domOrder() { return Array.prototype.map.call(el.querySelectorAll(".rs-row"), function (r) { return +r.getAttribute("data-i"); }); }
    el.querySelectorAll(".rs-up, .rs-down").forEach(function (b) {
      b.addEventListener("click", function () {
        var i = +this.getAttribute("data-i"), j = i + (this.classList.contains("rs-up") ? -1 : 1);
        if (j < 0 || j >= route.length) return;
        var order = route.map(function (_, k) { return k; }); order[i] = j; order[j] = i; commit(order);
      });
    });
    el.querySelectorAll(".rs-del").forEach(function (b) {
      b.addEventListener("click", function () { removeFromRoute(+this.getAttribute("data-i")); openRouteStops(); });
    });
    // Pointer drag (mouse and touch alike): the grabbed row follows the pointer through the
    // list — rows swap places as it passes them — and the order is committed on release.
    var list = el.querySelector(".rs-list"), drag = null;
    list.addEventListener("pointerdown", function (e) {
      var row = e.target.closest && e.target.closest(".rs-row"); if (!row || e.target.closest("button")) return;
      if (e.pointerType === "mouse" && !e.target.closest(".rs-grip")) return;   // with a mouse only the handle grabs (text stays selectable)
      e.preventDefault(); drag = row; row.classList.add("rs-dragging");
      try { list.setPointerCapture(e.pointerId); } catch (x) {}
    });
    list.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var over = document.elementFromPoint(e.clientX, e.clientY), r = over && over.closest && over.closest(".rs-row");
      if (!r || r === drag || r.parentNode !== list) return;
      var rb = r.getBoundingClientRect(), before = e.clientY < rb.top + rb.height / 2;
      list.insertBefore(drag, before ? r : r.nextSibling);
    });
    var end = function () { if (!drag) return; drag.classList.remove("rs-dragging"); drag = null; commit(domOrder()); };
    list.addEventListener("pointerup", end); list.addEventListener("pointercancel", end);
  }
  function updateRouteChip() {
    if (!routeChipEl) { routeChipEl = document.createElement("div"); routeChipEl.id = "route-chip"; document.body.appendChild(routeChipEl); }
    var route = activeRoute(), fromBasket = routePoints.length > 0;
    if (!route.length) { routeChipEl.style.display = "none"; closeRouteStops(); return; }
    routeChipEl.style.display = "";
    routeChipEl.innerHTML =
      '<span class="route-chip-lbl">' + ico("nav") + "<span>" + escapeHtml(t("route.count", { n: route.length })) + "</span></span>" +
      '<button type="button" class="route-stops" title="' + escapeHtml(t("route.stops")) + '" aria-label="' + escapeHtml(t("route.stops")) + '">\u2630</button>' +
      '<button type="button" class="route-go">' + escapeHtml(t("route.go")) + "</button>" +
      // "Save route" only applies to the live basket; a reloaded saved route is already saved.
      (fromBasket ? '<button type="button" class="route-save">' + escapeHtml(t("route.save")) + "</button>" : "") +
      '<button type="button" class="route-clear" aria-label="' + escapeHtml(t("route.clear")) + '" title="' + escapeHtml(t("route.clear")) + '">×</button>';
    routeChipEl.querySelector(".route-go").addEventListener("click", navigateRoute);
    routeChipEl.querySelector(".route-stops").addEventListener("click", function () { if (routeStopsEl) closeRouteStops(); else openRouteStops(); });
    var sv = routeChipEl.querySelector(".route-save"); if (sv) sv.addEventListener("click", saveRouteAsList);
    routeChipEl.querySelector(".route-clear").addEventListener("click", clearOrHideRoute);
  }
  // ---- Whole-list overlay: a coloured KML of pins for Google My Maps ----------
  // #RRGGBB → KML aabbggrr, so My Maps tints each pin the app's colour.
  function hexToKml(hex) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "ff1a73e8";
    return ("ff" + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toLowerCase();
  }
  function kmlForPoints(name, pts) {
    var xml = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var styles = {}, styleOrder = [];
    // App symbolism in My Maps: species colour for normal pins, a ★ for starred,
    // and BLACK for rare (the app's black centre-dot) — so rare-only = black dot,
    // starred = coloured star, starred+rare = black star.
    function styleFor(color, star, rare) {
      var kc = rare ? "ff000000" : hexToKml(color);
      var key = (star ? "s" : "d") + (rare ? "r" : "") + kc;
      if (!styles[key]) {
        var icon = star ? "http://maps.google.com/mapfiles/kml/shapes/star.png" : "http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png";
        styles[key] = '<Style id="' + key + '"><IconStyle><color>' + kc + '</color><scale>1.1</scale><Icon><href>' + icon + "</href></Icon></IconStyle></Style>";
        styleOrder.push(key);
      }
      return key;
    }
    var marks = pts.map(function (p) {
      return "<Placemark><name>" + xml(p.name || "Point") + "</name>" +
        (p.desc ? "<description>" + xml(p.desc) + "</description>" : "") +
        (p.source === "route" || p._route ? '<ExtendedData><Data name="route"><value>1</value></Data></ExtendedData>' : "") +
        "<styleUrl>#" + styleFor(p.color, p.star, p.rare) + "</styleUrl>" +
        "<Point><coordinates>" + (+p.lon).toFixed(6) + "," + (+p.lat).toFixed(6) + ",0</coordinates></Point></Placemark>";
    });
    var parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>', "<name>" + xml(name) + "</name>"];
    styleOrder.forEach(function (k) { parts.push(styles[k]); });
    return parts.concat(marks).concat(["</Document></kml>"]).join("\n");
  }
  function sendPointsToGoogle(name, pts) {
    var list = (pts || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); });
    if (!list.length) { setStatus(t("nav.empty")); return; }
    var kml = kmlForPoints(name || "Points", list);
    var safe = String(name || "points").replace(/[^\w-]+/g, "_").slice(0, 40) || "points";
    var fname = "gmaps_" + safe + "_" + new Date().toISOString().slice(0, 10) + ".kml";
    try {   // one-tap native share (Google Earth / Drive) where supported, else download
      var file = new File([kml], fname, { type: "application/vnd.google-earth.kml+xml" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name || "Points" }).then(
          function () { setStatus(t("nav.shared", { n: list.length })); },
          function (e) { if (!e || e.name !== "AbortError") sendKmlFallback(fname, kml, list.length); }
        );
        return;
      }
    } catch (e) {}
    sendKmlFallback(fname, kml, list.length);
  }
  function sendKmlFallback(fname, kml, n) {
    downloadCsv(fname, kml);
    openExternal("https://www.google.com/maps/d/");
    setStatus(t("nav.kml", { n: n }));
  }
  // A point the user just created or edited must never vanish without a word. With a tag
  // chip active, mpVisible hides any pin that does not carry that tag — so the pin was
  // saved and simply not drawn, and saying nothing made it look like the save had failed.
  function mpWarnIfHidden(p) {
    if (!p || mpVisible(p)) return;
    setStatus(t("points.savedHidden", { name: p.name || "" }));
  }
  function addMapPoint(p) {
    p.id = p.id || mpUid();
    p.createdAt = p.createdAt || new Date().toISOString();
    mapPoints.push(p);
    saveMapPoints();
    renderMapPoints();
    mpWarnIfHidden(p);
  }
  function updateMapPoint(id, patch) {
    var p = mapPoints.filter(function (x) { return x.id === id; })[0]; if (!p) return;
    Object.assign(p, patch);
    saveMapPoints();
    renderMapPoints();
    mpWarnIfHidden(p);
  }
  function deleteMapPoint(id) {
    mapPoints = mapPoints.filter(function (x) { return x.id !== id; });
    saveMapPoints();
    renderMapPoints();
  }
  function clearMapPoints() {
    // Detach first so we don't sync the now-empty working set onto the saved
    // list — the named list survives "Delete"; only the live pins are cleared.
    mpActiveName = ""; mapPoints = []; mpFilter = []; saveMapPoints(); renderMapPoints();
  }
  // Distinct tag pool across all stored points, alphabetically sorted.
  function mpAllTags() {
    var s = {};
    var add = function (p) { (p.tags || []).forEach(function (t) { if (t) s[t] = true; }); };
    mapPoints.forEach(add);
    // …and every ticked saved list: an imported list's tags are the ones worth filtering on,
    // and before this they never reached the chip row at all.
    mpCollections.forEach(function (c) { if (shownColls[c.name]) (c.points || []).forEach(add); });
    return Object.keys(s).sort();
  }
  // OR-filter: when no tags active, show everything; otherwise show points
  // whose tag list intersects mpFilter. "(no tag)" is represented by "".
  // ---- per-point comparison keys, and per-LIST filters -----------------------
  // Dates and observer names are compared on every redraw, for every point, so they are
  // reduced ONCE per point and cached on it (leading "_" keys are working state, not saved
  // data — they are rebuilt from `date`/`observer` whenever a list is hydrated).
  //   _dn : the date as an integer, 2015-04-12 -> 20150412, 0 when there is no date.
  //   _ot : the observer as normalised tokens — lowercased, diacritics folded, punctuation
  //         dropped — which is what makes fuzzy matching cheap.
  function pDateNum(p) {
    if (p._dn !== undefined) return p._dn;
    var d = String(p.date || "");
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    p._dn = m ? (+m[1] * 10000 + +m[2] * 100 + +m[3]) : 0;
    return p._dn;
  }
  var DIA = { "å":"a","ä":"a","á":"a","à":"a","â":"a","ã":"a","ø":"o","ö":"o","ó":"o","ò":"o","ô":"o","õ":"o",
              "æ":"ae","é":"e","è":"e","ê":"e","ë":"e","í":"i","ì":"i","î":"i","ï":"i","ú":"u","ù":"u","û":"u",
              "ü":"u","ý":"y","ÿ":"y","ñ":"n","ç":"c","š":"s","ž":"z","ð":"d","þ":"th","ł":"l" };
  function foldName(x) {
    return String(x || "").toLowerCase().replace(/[^\u0000-\u007f]/g, function (ch) { return DIA[ch] || ch; });
  }
  function obsTokens(name) {
    return foldName(name).split(/[^a-z0-9]+/).filter(function (x) { return x.length > 0; });
  }
  function pObsTokens(p) {
    if (p._ot !== undefined) return p._ot;
    p._ot = obsTokens(p.observer || "");
    return p._ot;
  }
  // Fuzzy: every token of the QUERY must be a prefix of some token of the record, so
  // "K Nordmann" finds "Kari Nordmann", "nordmann" finds it too, and "Kari Olsen" does not.
  // Diacritics and punctuation are already folded away on both sides.
  function obsFuzzyHit(recTokens, queryTokens) {
    if (!queryTokens.length) return true;
    for (var i = 0; i < queryTokens.length; i++) {
      var q = queryTokens[i], hit = false;
      for (var j = 0; j < recTokens.length; j++) { if (recTokens[j].indexOf(q) === 0) { hit = true; break; } }
      if (!hit) return false;
    }
    return true;
  }
  // { "<list name>": { from: "YYYY-MM-DD", to: "…", obs: ["name", …] } }
  var listFilters = {};
  function loadListFilters() { listFilters = window.GeoState.get("mapListFilters", {}) || {}; }
  function listFilter(name) { return listFilters[name] || null; }
  function setListFilter(name, f) {
    if (!name) return;
    if (f && (f.from || f.to || (f.obs && f.obs.length))) listFilters[name] = f; else delete listFilters[name];
    window.GeoState.save({ mapListFilters: listFilters });
    renderMapPoints();
    if (typeof refreshMpPanel === "function") refreshMpPanel();
  }
  function listFilterActive(name) { return !!listFilter(name); }
  // Does this point pass its OWN list's filter? Cheap integer and token compares.
  function listOwnFilterPasses(p, f) {
    if (!f) return true;
    if (f.from || f.to) {
      var dn = pDateNum(p);
      if (!dn) return false;                                   // a filtered range excludes undated points
      if (f.from && dn < +f.from.replace(/-/g, "")) return false;
      if (f.to && dn > +f.to.replace(/-/g, "")) return false;
    }
    if (f.obs && f.obs.length) {
      var rec = pObsTokens(p);
      if (!rec.length) return false;
      for (var i = 0; i < f.obs.length; i++) if (obsFuzzyHit(rec, obsTokens(f.obs[i]))) return true;
      return false;
    }
    return true;
  }
  // Every observer named in a list, with a count — what the filter popup offers.
  function listObservers(name) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0];
    if (!c) return [];
    var seen = {};
    (c.points || []).forEach(function (p) {
      var o = String(p.observer || "").trim();
      if (!o) return;
      seen[o] = (seen[o] || 0) + 1;
    });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b); })
      .map(function (k) { return { name: k, n: seen[k] }; });
  }
  // The date span a list actually covers, for the popup's placeholders.
  function listDateSpan(name) {
    var c = mpCollections.filter(function (x) { return x.name === name; })[0];
    var lo = "", hi = "";
    ((c && c.points) || []).forEach(function (p) {
      var d = String(p.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      if (!lo || d < lo) lo = d;
      if (!hi || d > hi) hi = d;
    });
    return { from: lo, to: hi };
  }
  function mpVisible(p) {
    // The pane's own filters (date, observer, …) reach list pins too — see
    // listPointPasses in app.js. A pin is judged only on the fields it HAS, so a list
    // imported before those fields existed is never hidden by them.
    if (listPointPasses && !listPointPasses(p)) return false;
    return mpTagPasses(p);
  }
  // The tag-chip part alone (include / exclude), for the species records a list injects
  // into the map: THEIR date / observer filters are applied where fetched rows get them
  // (detRowPasses at draw time), so a pane filter change never re-injects a list.
  function mpTagPasses(p) {
    var tags = p.tags || [];
    // An EXCLUDED tag hides its points whatever else is ticked ("" = the untagged ones).
    if (mpExclude.length) {
      if (!tags.length) { if (mpExclude.indexOf("") >= 0) return false; }
      else for (var x = 0; x < tags.length; x++) if (mpExclude.indexOf(tags[x]) >= 0) return false;
    }
    if (!mpFilter.length) return true;
    if (!tags.length) return mpFilter.indexOf("") >= 0;
    for (var i = 0; i < tags.length; i++) if (mpFilter.indexOf(tags[i]) >= 0) return true;
    return false;
  }
  // Re-draw the pins after a filter change, at most once per frame: a filter click can
  // touch several controls, and a list of tens of thousands of pins must not be rebuilt
  // once per keystroke. Guarded against re-entry — renderMapPoints runs
  // syncListDetections, which is itself what calls back in here.
  var mpFilterT = null, mpRendering = false, mpBusyEls = [], mpBusyKeys = [];
  // The redraw rebuilds the Points panel's innerHTML, which destroys the very tile we put
  // the blink on — so remember the tile by IDENTITY and re-apply the class to whatever
  // element takes its place.
  function mpBusyKeyOf(el) {
    if (!el || !el.getAttribute) return "";
    if (el.classList && el.classList.contains("mp-chip")) return '.mp-chip[data-tag="' + (el.getAttribute("data-tag") || "") + '"]';
    var cb = el.querySelector ? el.querySelector(".mp-coll-cb") : null;
    var src = cb || el;
    var nm = src.getAttribute && src.getAttribute("data-name"), ty = src.getAttribute && src.getAttribute("data-type");
    if (nm) return '.mp-coll-row:has(.mp-coll-cb[data-name="' + nm + '"][data-type="' + (ty || "p") + '"])';
    return "";
  }
  function mpBusyReapply() {
    mpBusyKeys.forEach(function (sel) {
      if (!sel) return;
      var el = null;
      try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (!el && sel.indexOf(":has(") >= 0) {                       // :has() unsupported → find it the long way
        var m = /data-name="([^"]*)"/.exec(sel);
        if (m) {
          var cb = document.querySelector('.mp-coll-cb[data-name="' + m[1] + '"]');
          el = cb && cb.closest ? cb.closest(".mp-coll-row") : null;
        }
      }
      if (el && mpBusyEls.indexOf(el) < 0) { el.classList.add("filter-busy"); mpBusyEls.push(el); }
    });
  }
  // `el` (optional): the tile that was clicked. It blinks with the app's existing
  // .filter-busy pulse until the redraw is done — with a big list that redraw takes long
  // enough that a click otherwise looked ignored. Held for a moment at minimum, so a fast
  // filter still blinks once rather than flickering invisibly.
  function mpFilterRefresh(el) {
    // The clicked tile blinks, AND so do the funnels — a points filter is a filtering pass
    // like any other, and the funnels are where the user has learned to look for one.
    pulseFunnels();
    if (el && el.classList && mpBusyEls.indexOf(el) < 0) { el.classList.add("filter-busy"); mpBusyEls.push(el); }
    var key = mpBusyKeyOf(el);
    if (key && mpBusyKeys.indexOf(key) < 0) mpBusyKeys.push(key);
    var since = Date.now();
    if (mpRendering || mpFilterT) return;
    // requestAnimationFrame must be CALLED ON window: `(window.requestAnimationFrame || setTimeout)(fn)`
    // throws "Illegal invocation" in Chrome, which left the tag chips blinking and the map
    // unchanged (owner, 2026-10-01: "the map points are not filtered like for fetched data").
    var later = window.requestAnimationFrame ? function (fn) { return window.requestAnimationFrame(fn); } : function (fn) { return setTimeout(fn, 16); };
    mpFilterT = later(function () {
      mpFilterT = null;
      if (mpRendering) { mpFilterBusyDone(since); return; }
      mpRendering = true;
      try { renderMapPoints(); mpBusyReapply(); } catch (e) { console.error("renderMapPoints failed", e); } finally { mpRendering = false; mpFilterBusyDone(since); }
    });
  }
  function mpFilterBusyDone(since) {
    if (!mpBusyEls.length) { mpBusyKeys = []; return; }
    var els = mpBusyEls; mpBusyEls = []; mpBusyKeys = [];
    var wait = Math.max(0, 260 - (Date.now() - since));
    setTimeout(function () {
      els.forEach(function (e) { try { e.classList.remove("filter-busy"); } catch (x) {} });
    }, wait);
  }

  function ensureMpLayer() { if (!mpLayer) { mpLayer = L.layerGroup(); if (getMap()) mpLayer.addTo(getMap()); } return mpLayer; }
  // Rebuild every marker. Cheap enough for hundreds; if it ever becomes slow we
  // can switch to a per-point patch model.
  var mpPins = [];   // {m, p, editable} for every rendered pin — used to fan out overlaps
  // A triangular marker (for shared points) in the given fill colour.
  function mpTriangleIcon(fill) {
    var c = /^[#a-zA-Z0-9(),.%\s]+$/.test(String(fill || "")) ? fill : "#888";   // colour only — no attribute breakout
    var svg = '<svg width="20" height="18" viewBox="0 0 20 18" xmlns="http://www.w3.org/2000/svg">' +
      '<polygon points="10,1.5 18.5,16.5 1.5,16.5" fill="' + c + '" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    return L.divIcon({ className: "mp-tri-icon", html: svg, iconSize: [20, 18], iconAnchor: [10, 11] });
  }
  function renderMpPin(p, editable, color) {
    if (+p.radius > 0) {   // the position's uncertainty: a transparent circle in metres, under the pin
      var rc = p.color || color || mpColorFor(p);
      // faint, so the map stays readable under many overlapping circles (owner, 2026-10-10)
      mpLayer.addLayer(L.circle([p.lat, p.lon], { radius: +p.radius, color: rc, weight: 1, opacity: 0.3, fillColor: rc, fillOpacity: 0.04, interactive: false }));
    }
    // A detection-saved pin (read-only, carries the species' colour) is drawn
    // like the plotted detection — species colour + ★ for interesting + a black
    // centre dot for rare — sitting on a slightly larger list-coloured disc, so
    // the list is recognisable by its background colour.
    if (!editable && p.spColor) {
      var listCol = color || mpColorFor(p);
      // Draw the list-colour disc in the SAME renderer as the species symbol and
      // add it FIRST, so within that one <svg> the DOM order guarantees the disc
      // sits behind the marker pattern/colour (different renderers wouldn't).
      var halo = L.circleMarker([p.lat, p.lon], { radius: 10, color: listCol, weight: 1.5, opacity: 0.95, fillColor: listCol, fillOpacity: 0.5, renderer: detRenderer() });
      var hrec = { m: halo, p: p, editable: false };
      mpPins.push(hrec);
      halo.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); onMpPinClick(hrec); });
      mpLayer.addLayer(halo);
      var sym = p.star
        ? detStarMarker([p.lat, p.lon], { radius: 6.5, color: "#1a1a1a", weight: 1, fillColor: p.spColor, fillOpacity: 0.95, interactive: false, renderer: detRenderer() })
        : L.circleMarker([p.lat, p.lon], { radius: 5, color: "#1a1a1a", weight: 1, fillColor: p.spColor, fillOpacity: 0.95, interactive: false, renderer: detRenderer() });
      mpLayer.addLayer(sym);
      if (p.rare) mpLayer.addLayer(L.circleMarker([p.lat, p.lon], { radius: 1.7, weight: 0, fillColor: "#111", fillOpacity: 1, interactive: false, renderer: detRenderer() }));
      return;
    }
    var fill = p.color || color || mpColorFor(p);   // explicit per-point colour wins over list/tag colour
    // Points that arrived via a shared link are drawn as TRIANGLES so they stand
    // out from your own (circular) pins; everything else stays a circle.
    // marker "ring": an unfilled circle in the point's colour (still clickable inside: fill with opacity 0)
    var m = p.shared
      ? L.marker([p.lat, p.lon], { icon: mpTriangleIcon(fill), keyboard: false })
      : p.marker === "ring"
        ? L.circleMarker([p.lat, p.lon], { radius: 7, color: fill, weight: 2.5, opacity: 0.95, fill: true, fillOpacity: 0 })
        : L.circleMarker([p.lat, p.lon], { radius: 7, color: "#111", weight: 1, opacity: 0.9, fillColor: fill, fillOpacity: editable ? 0.9 : 0.65 });
    var rec = { m: m, p: p, editable: editable };
    mpPins.push(rec);
    // Stop propagation so a marker click doesn't open the species-list popup
    // behind it. Co-located pins (several species at one spot) fan out; a lone
    // pin opens its editor (working pins) or just flies/tooltips (saved lists).
    m.on("click", function (e) {
      if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      onMpPinClick(rec);
    });
    mpLayer.addLayer(m);
  }
  function mpPinAction(rec) {
    var p = rec.p;
    setMpDistOrigin(p.lat, p.lon);   // selecting a pin on the map re-measures + re-sorts the point lists
    if (rec.editable) { openPointEditor(p); return; }
    // Any read-only list pin (detection-saved OR an old manually-tagged point)
    // opens the shared action menu: source link, focus, Navigate here, ＋ Add to
    // route and Add to list — plus the star / year / life / hide toggles when the
    // pin carries a species key. drmRenderMain shows only the rows that apply, so
    // a plain tagged point still gets "Navigate here" / "Add to route".
    // Which saved list owns this pin (by object identity) — the menu's Delete removes it
    // from that list, after asking. Points that never got an id get one now so the
    // removal can address them.
    var coll = null;
    mpCollections.forEach(function (c) { if (!coll && (c.points || []).indexOf(p) >= 0) coll = c; });
    if (coll && !p.id) { p.id = mpUid(); saveMapPoints(); }
    var d = { name: p.name || "", key: p.spKey || "", lat: p.lat, lon: p.lon, url: p.url || "", date: p.date || "", act: p.act || "", count: p.count, color: p.spColor || "",
              fromPin: true, listName: coll ? coll.name : "", mpId: coll ? p.id : "" };
    var ct = getMap().latLngToContainerPoint([p.lat, p.lon]), box = getMap().getContainer().getBoundingClientRect();
    showDetRowMenu(d, box.left + ct.x, box.top + ct.y, function () { renderMapPoints(); });
  }
  // Every rendered pin within `px` screen-pixels of this one (i.e. visually
  // stacked — typically several species saved at the same location/date).
  function mpOverlaps(rec, px) {
    if (!getMap()) return [rec];
    var c = getMap().latLngToLayerPoint([rec.p.lat, rec.p.lon]), thr = px || 16, out = [];
    mpPins.forEach(function (o) {
      if (getMap().latLngToLayerPoint([o.p.lat, o.p.lon]).distanceTo(c) <= thr) out.push(o);
    });
    return out;
  }
  function onMpPinClick(rec) {
    clearSpider();
    var group = mpOverlaps(rec, 16);
    if (group.length <= 1) {
      // A read-only pin shows its record FIRST, as a popup that stays put and carries an
      // × — the details used to live in a hover tooltip, which a touch device never gets.
      // The action menu (source, navigate, add to list …) is one tap further in, on the
      // card itself. An editable working pin still opens its editor straight away.
      if (rec.editable) { mpPinAction(rec); return; }
      openMpStackPopup(L.latLng(rec.p.lat, rec.p.lon), [rec]);
      return;
    }
    // Points that share a coordinate cannot be told apart by fanning them out — the
    // spokes only repeat "several here", which is what the dot already said. Those get
    // listed. A fan still earns its place when the points are genuinely a few metres
    // apart (it shows you WHERE each one is), until there are too many to read.
    var same = 0;
    group.forEach(function (o) { if (mpSamePlace(o.p, rec.p)) same++; });
    if (same > 1 || group.length > MP_FAN_MAX) { openMpStackPopup(L.latLng(rec.p.lat, rec.p.lon), group); return; }
    spiderOutMp(L.latLng(rec.p.lat, rec.p.lon), group);
  }
  var MP_FAN_MAX = 6;
  // ~1e-5 degrees is about a metre — closer than any two genuinely different
  // records, and what repeated reports from one site come in as.
  function mpSamePlace(a, b) { return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5; }
  // When a point carries no explicit date (an imported placemark, say) fall back to
  // the first ISO date in its note — KML descriptions from the point builders put the
  // record's date there — and only then to when the pin was created.
  function mpPointWhen(p) {
    var d = p.date || "";
    if (!d) { var m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(String(p.note || "")); if (m) d = m[1]; }
    var ts = Date.parse(d || p.createdAt || "");
    return isNaN(ts) ? -8640000000000 : ts;
  }
  // ---- per-point tags, edited from the point's own card ---------------------
  // Which saved list owns this point (by object identity), so a tag edit persists to the
  // right place. Loose working pins return null and are saved with the working set.
  function ownerColl(p) {
    var found = null;
    mpCollections.forEach(function (c) { if (!found && (c.points || []).indexOf(p) >= 0) found = c; });
    return found;
  }
  // Every tag in use in the point's own list — what the picker offers, so tagging is
  // mostly one tap rather than typing the same word again.
  function tagsInScope(p) {
    var c = ownerColl(p), seen = {}, out = [];
    ((c && c.points) || mapPoints || []).forEach(function (q) {
      (q.tags || []).forEach(function (tg) { if (tg && !seen[tg]) { seen[tg] = 1; out.push(tg); } });
    });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }
  function pointTagsSave(p) {
    var c = ownerColl(p);
    if (c) { saveMapPoints(); persistMpSets(mpCollections); } else saveMapPoints();
    renderMapPoints();
    if (typeof refreshMpPanel === "function") refreshMpPanel();
  }
  function togglePointTag(p, tag) {
    tag = String(tag || "").trim(); if (!tag) return;
    p.tags = p.tags || [];
    var i = p.tags.indexOf(tag);
    if (i >= 0) p.tags.splice(i, 1); else p.tags.push(tag);
    pointTagsSave(p);
  }
  // The card's tag row: the point's tags as removable chips, then ＋ to open the picker.
  function pointTagsHtml(p) {
    var tags = (p.tags || []).filter(function (x) { return !!x; });
    return '<div class="mp-tagrow">' +
      tags.map(function (tg) {
        return '<button type="button" class="mp-tag-chip" data-tag="' + escapeHtml(tg) + '" title="' +
          escapeHtml(t("points.tagRemove")) + '">' + escapeHtml(tagDisplay(tg)) + " \u00d7</button>";
      }).join("") +
      '<button type="button" class="mp-tag-add" title="' + escapeHtml(t("points.tagAdd")) + '">+</button>' +
      // Copy this one record into another list, and delete it. Both act on the point the
      // card belongs to, so they sit on the card rather than behind the action menu.
      '<span class="mp-card-acts">' +
        '<button type="button" class="mp-card-edit ico-btn" title="' + escapeHtml(t("points.editPoint")) + '" aria-label="' + escapeHtml(t("points.editPoint")) + '">' + ico("edit") + "</button>" +
        '<button type="button" class="mp-card-copy ico-btn" title="' + escapeHtml(t("points.copyTo")) + '" aria-label="' + escapeHtml(t("points.copyTo")) + '">' + ico("copy") + "</button>" +
        '<button type="button" class="mp-card-route ico-btn" title="' + escapeHtml(t("route.add")) + '" aria-label="' + escapeHtml(t("route.add")) + '">' + ico("navplus") + "</button>" +   // ＋➤ on the icon line (owner, 2026-10-04)
        '<button type="button" class="mp-card-del" title="' + escapeHtml(t("points.deleteOne")) + '" aria-label="' + escapeHtml(t("points.deleteOne")) + '">\u00d7</button>' +
      "</span></div>";
  }
  // The picker, opened inside the card itself — no second popup to stack, dismiss or
  // position, and it cannot cover the record it belongs to.
  function pointTagPickerHtml(p) {
    var mine = p.tags || [], opts = tagsInScope(p);
    return '<div class="mp-tagpick">' +
      '<div class="mp-tagpick-opts">' +
        opts.map(function (tg) {
          return '<button type="button" class="mp-tagpick-opt' + (mine.indexOf(tg) >= 0 ? " on" : "") +
            '" data-tag="' + escapeHtml(tg) + '">' + escapeHtml(tagDisplay(tg)) + "</button>";
        }).join("") +
        (opts.length ? "" : '<span class="mp-tagpick-none">' + escapeHtml(t("points.tagNone")) + "</span>") +
      "</div>" +
      '<div class="mp-tagpick-new"><input type="text" class="mp-tagpick-in" placeholder="' +
        escapeHtml(t("points.tagNew")) + '" maxlength="40" />' +
        '<button type="button" class="mp-tagpick-ok">\u2713</button></div>' +
      "</div>";
  }
  function openMpStackPopup(center, group) {
    var items = group.slice().sort(function (a, b) { return mpPointWhen(b.p) - mpPointWhen(a.p); });
    var html = (items.length > 1 ? '<div class="mp-stack-hd">' + escapeHtml(t("points.stackN", { n: items.length })) + "</div>" : "") +
      items.map(function (o, i) {
        return '<div class="mp-stack-it' + (items.length > 1 ? "" : " one") + '" data-i="' + i + '">' +
          '<div class="mp-stack-body" role="button" tabindex="0" title="' + escapeHtml(t("points.cardMore")) + '">' +
            mpTipHtml(o.p) + "</div>" + pointTagsHtml(o.p) + "</div>";
      }).join("");
    // Leaflet's own maxHeight gives the popup its scrollbar (.leaflet-popup-scrolled).
    var pop = L.popup({ className: "area-tip mp-stack-pop", maxWidth: 320, maxHeight: 300, autoPan: true })
      .setLatLng(center).setContent(html).openOn(getMap());
    var el = pop.getElement();
    if (!el) return;
    // The card body opens the point's actions; the tag row is edited in place, so a tag
    // click must not also fire the action menu.
    el.querySelectorAll(".mp-stack-body").forEach(function (b) {
      b.addEventListener("click", function () {
        var o = items[+this.parentNode.getAttribute("data-i")];
        try { getMap().closePopup(pop); } catch (e) {}
        if (o) mpPinAction(o);
      });
    });
    function wireTags() {
      el.querySelectorAll(".mp-tag-chip").forEach(function (ch) {
        ch.addEventListener("click", function (e) {
          e.stopPropagation();
          var o = items[+this.closest(".mp-stack-it").getAttribute("data-i")];
          if (o) { togglePointTag(o.p, this.getAttribute("data-tag")); redraw(); }
        });
      });
      // The pencil opens the same editor a loose pin has always had — name, tags, colour,
      // note — now reaching points that live in a LIST too (see applyPointEdit in app.js).
      el.querySelectorAll(".mp-card-edit").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var o = items[+this.closest(".mp-stack-it").getAttribute("data-i")];
          if (!o || !openPointEditor) return;
          try { getMap().closePopup(pop); } catch (x) {}   // the editor opens its own popup here
          openPointEditor(o.p);
        });
      });
      el.querySelectorAll(".mp-card-copy").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var o = items[+this.closest(".mp-stack-it").getAttribute("data-i")];
          if (o && copyPointToList) copyPointToList(this, o.p);
        });
      });
      el.querySelectorAll(".mp-card-route").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var o = items[+this.closest(".mp-stack-it").getAttribute("data-i")];
          if (!o) return;
          addToRoute(+o.p.lat, +o.p.lon, o.p.name || "");
          try { getMap().closePopup(pop); } catch (x) {}
        });
      });
      el.querySelectorAll(".mp-card-del").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var o = items[+this.closest(".mp-stack-it").getAttribute("data-i")];
          if (!o || !deleteListPoint) return;
          try { getMap().closePopup(pop); } catch (x) {}   // the record is about to go
          deleteListPoint(o.p);
        });
      });
      el.querySelectorAll(".mp-tag-add").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var row = this.parentNode, card = this.closest(".mp-stack-it");
          var o = items[+card.getAttribute("data-i")];
          if (!o || card.querySelector(".mp-tagpick")) return;
          row.insertAdjacentHTML("afterend", pointTagPickerHtml(o.p));
          var pick = card.querySelector(".mp-tagpick");
          pick.addEventListener("click", function (ev) { ev.stopPropagation(); });
          pick.querySelectorAll(".mp-tagpick-opt").forEach(function (opt) {
            opt.addEventListener("click", function () { togglePointTag(o.p, this.getAttribute("data-tag")); redraw(); });
          });
          var inp = pick.querySelector(".mp-tagpick-in");
          var add = function () { var v = inp.value.trim(); if (v) { togglePointTag(o.p, v); redraw(); } };
          pick.querySelector(".mp-tagpick-ok").addEventListener("click", add);
          inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
          try { inp.focus(); } catch (e) {}
        });
      });
    }
    // Re-render the cards in place after a tag change — the popup stays open where it is.
    function redraw() {
      var keep = el.querySelector(".mp-stack-hd");
      el.querySelectorAll(".mp-stack-it").forEach(function (card, idx) {
        var o = items[idx]; if (!o) return;
        var row = card.querySelector(".mp-tagrow");
        if (row) row.outerHTML = pointTagsHtml(o.p);
        var pk = card.querySelector(".mp-tagpick"); if (pk) pk.remove();
      });
      wireTags();
      if (keep) { /* heading unchanged */ }
    }
    wireTags();
  }
  // Fan the co-located pins out around their shared point ("rainbow"), each in
  // its per-species colour, with a leader line and its species/date/activity
  // tooltip. Click a fanned pin to open it (working pins). Dismissed by
  // clearSpider (map click / pan / zoom / Escape).
  function spiderOutMp(center, group) {
    var layer = L.layerGroup();
    var n = group.length, R = Math.min(60, 20 + n * 5);
    var cpt = getMap().latLngToLayerPoint(center);
    group.forEach(function (o, i) {
      o.m._preFanOp = o.m.options.opacity; o.m._preFanFill = o.m.options.fillOpacity;
      try { o.m.setStyle({ opacity: 0.12, fillOpacity: 0.12 }); } catch (e) {}
      getSpiderHidden().push(o.m);
      var a = 2 * Math.PI * i / n - Math.PI / 2;
      var ll = getMap().layerPointToLatLng(L.point(cpt.x + R * Math.cos(a), cpt.y + R * Math.sin(a)));
      layer.addLayer(L.polyline([center, ll], { color: "#888", weight: 1, opacity: 0.6, interactive: false }));
      var fm = L.circleMarker(ll, { radius: 7, color: "#111", weight: 1, fillColor: mpColorFor(o.p), fillOpacity: 0.95 });
      fm.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); clearSpider(); mpPinAction(o); });
      layer.addLayer(fm);
    });
    layer.addTo(getMap());
    setSpiderLayer(layer);
  }
  // Above a few thousand pins Leaflet is the wrong tool: renderMapPoints makes ONE marker
  // per point and runs on every tick, filter change and save. Measured against the
  // generated lek file (64,542 points): 500 pts = 25 ms, 10k = 302 ms, 40k = 1,212 ms,
  // 64.5k = 2,154 ms -- linear, and 2 s of blocked main thread per redraw.
  //
  // So a big list is drawn for the CURRENT VIEW only, with a hard pin budget as a
  // backstop (zoomed out over a whole country, 64k pins are a blob: drawing 4,000 of them
  // looks the same and costs 2 % of the time). The user's own "Max points on map" lowers
  // it further. Small lists are untouched -- no cull, no move-redraw.
  var MP_CULL_MIN = 2000;        // total shown list points below this -> draw everything
  // Pins actually drawn per render when culling is on. Measured cost of renderMpPin alone
  // (draw + clearLayers): 4k = 50 ms, 10k = 118 ms, 30k = 350 ms, 64.5k = 661 ms. 8k keeps a
  // zoomed-out redraw around 100 ms on this machine while showing far more than 4k did.
  var MP_DRAW_MAX = 8000;
  var mpMoveT = null, mpCulling = false;
  function mpPinBudget() {
    var n = +window.GeoState.get("maxMapPoints", 50000);
    return Math.min(MP_DRAW_MAX, (n > 0 ? n : MP_DRAW_MAX));
  }
  function mpViewBounds() {
    var m = getMap(); if (!m) return null;
    try { return m.getBounds().pad(0.3); } catch (e) { return null; }
  }
  // Re-draw after a pan/zoom, but only while a list is actually being culled, and only
  // once the map has been still -- the same shape the legend's redraw uses.
  function mpWatchMoves() {
    var m = getMap(); if (!m || mpWatchMoves.on) return;
    mpWatchMoves.on = true;
    m.on("moveend zoomend", function () {
      if (!mpCulling) return;
      clearTimeout(mpMoveT);
      mpMoveT = setTimeout(function () { if (mpCulling) renderMapPoints(); }, 320);
    });
  }
  function renderMapPoints() {
    if (!getMap()) return;
    mpCollections.forEach(function (c) { if (c && c._lazy && shownColls[c.name]) hydrateOne(c); });   // ticked while still a stub → load it now (it redraws when in)
    mpWatchMoves();
    clearSpider();            // any open fan-out refers to markers about to be replaced
    ensureMpLayer().clearLayers();
    mpPins = [];
    updateDetSetOverlays();   // keep the shown detection-set layers in sync
    mapPoints.forEach(function (p) { if (mpVisible(p)) renderMpPin(p, true); });   // loose working pins (editable, tag colour)
    // Ticked saved point-lists: a list's DETECTION points (those carrying a species
    // key) are plotted through the shared detection pipeline (syncListDetections),
    // so they obey the same legend filters and open the same popups as fetched
    // data. Manually-tagged points (no species key) keep their own pin + editor.
    var routeShows = routePoints.length === 0;   // reloaded saved routes own the numbered-pin display only when the basket is empty
    // How many list points are in play at all? Only that decides whether to cull, so a
    // handful of hand-made lists keep behaving exactly as before.
    var shownTotal = 0, shownLists = [];
    mpCollections.forEach(function (c) {
      if (!shownColls[c.name]) return;
      if (routeShows && isRouteColl(c)) return;
      shownLists.push(c);
      shownTotal += (c.points || []).length;
    });
    mpCulling = shownTotal > MP_CULL_MIN;
    // Every shown list gets a FAIR SHARE of the pin budget, allocated smallest-first so a
    // small list uses less than its share and the surplus rolls on to the bigger ones.
    // Without this the budget went to whichever list came first: 30,000 imported points ate
    // all of it and a hand-made five-point list was never drawn at all, with no filter
    // anywhere near it. Rendering then runs largest-first, so the small lists land on top
    // instead of under a dense import.
    shownLists.sort(function (a, b) { return ((a.points || []).length) - ((b.points || []).length); });
    // Plain numbers, not L.LatLngBounds.contains([lat, lon]) — that allocates a LatLng per
    // point, and this runs 64k times on the generated lek file.
    var vb = mpCulling ? mpViewBounds() : null, bb = null;
    if (vb) { var sw = vb.getSouthWest(), ne = vb.getNorthEast(); bb = [sw.lat, sw.lng, ne.lat, ne.lng]; }
    var budget = mpCulling ? mpPinBudget() : Infinity;
    var drawn = 0, passed = 0;
    // Pass 1: how many pins each list may draw.
    var share = {}, left = budget, nLeft = shownLists.length;
    shownLists.forEach(function (c) {
      var want = nLeft > 0 ? Math.max(1, Math.floor(left / nLeft)) : 0;
      var have = 0;
      (c.points || []).forEach(function (p) { if (p && !detKeyOf(p) && isFinite(p.lat) && isFinite(p.lon)) have++; });
      var give = Math.min(want, have);
      share[c.name] = (budget === Infinity) ? Infinity : give;
      left -= give; nLeft--;
    });
    // Pass 2: draw, largest list first so the smallest end up on top.
    shownLists.slice().reverse().forEach(function (c) {
      var col = collColor(c);
      var lf = listFilter(c.name);
      var quota = share[c.name], used = 0;
      (c.points || []).forEach(function (p) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return;
        if (detKeyOf(p)) return;   // a record with a species → detPlot pipeline (handled below)
        // The view test goes FIRST because it is the cheapest by far: four number
        // comparisons against the filters' string folding and date arithmetic.
        if (bb && (p.lat < bb[0] || p.lat > bb[2] || p.lon < bb[1] || p.lon > bb[3])) return;
        // Until now this loop drew every point in a ticked list unconditionally, so the
        // pane's filters AND the tag chips were no-ops for list pins. Both apply here now,
        // together with the list's own observer / date-range filter.
        if (!mpVisible(p)) return;
        if (!listOwnFilterPasses(p, lf)) return;
        passed++;
        if (used >= quota) return;
        used++; drawn++;
        renderMpPin(p, false, col);
      });
    });
    // Say what is missing rather than quietly drawing a subset.
    if (mpCulling && drawn < passed) setStatus(t("points.capped", { n: drawn, total: passed }));
    syncListDetections();     // merge shown lists' detection points into detPlot
    renderRoutePoints();      // numbered stops for the basket, or a reloaded saved route
    updateRouteChip();        // and its bottom nav bar
    refreshMpPanel();
    updateMpBadge();
  }

  return {
    init: init,
    initMpSetStore: initMpSetStore, persistMpSets: persistMpSets, mpFilterRefresh: mpFilterRefresh,
    listFilter: listFilter, setListFilter: setListFilter, listFilterActive: listFilterActive, listOwnFilterPasses: listOwnFilterPasses,
    listObservers: listObservers, listDateSpan: listDateSpan,
    // ---- points, lists, collections ----
    loadMapPoints: loadMapPoints, saveMapPoints: saveMapPoints, saveChecked: saveChecked,
    saveShownState: saveShownState, addMapPoint: addMapPoint, updateMapPoint: updateMapPoint,
    deleteMapPoint: deleteMapPoint, mpHasUnsaved: mpHasUnsaved, mpVisible: mpVisible,
    mpAllTags: mpAllTags, mpUid: mpUid, mpParseTags: mpParseTags,
    deleteCollection: deleteCollection, isCollProtected: isCollProtected, mpLoading: mpLoading,
    setCollProtected: setCollProtected, isRouteColl: isRouteColl,
    openCollEditModal: openCollEditModal, collColor: collColor,
    // ---- colours ----
    mpHashColor: mpHashColor, mpColorFor: mpColorFor, mpColorRow: mpColorRow,
    mpReadColor: mpReadColor, mpHex6: mpHex6, wireMpColorRow: wireMpColorRow,
    // ---- import / export / share ----
    exportPointsKml: exportPointsKml, exportPointsKmz: exportPointsKmz, exportPointsAs: exportPointsAs,
    buildPointsKml: buildPointsKml, buildPointsGeoJson: buildPointsGeoJson, buildKmz: buildKmz,
    exportPointsGeoJson: exportPointsGeoJson, extractKmlFromKmz: extractKmlFromKmz,
    startKmlImport: startKmlImport, startGeoJsonImport: startGeoJsonImport, startMultiImport: startMultiImport,
    compactStoredPoints: compactStoredPoints,
    sendPointsToGoogle: sendPointsToGoogle,
    // ---- route ----
    loadRoute: loadRoute, addToRoute: addToRoute, renderRoutePoints: renderRoutePoints,
    updateRouteChip: updateRouteChip, navigatePoints: navigatePoints, navigateStops: navigateStops,
    // ---- pins on the map ----
    ensureMpLayer: ensureMpLayer, renderMapPoints: renderMapPoints, renderMpPin: renderMpPin,
    onMpPinClick: onMpPinClick, setMpDistOrigin: setMpDistOrigin,

    // ---- state (app.js reads through these) ----
    mapPoints: function () { return mapPoints; },
    setMapPoints: function (v) { mapPoints = v; },
    mpFilter: function () { return mpFilter; }, normTag: normTag,
    setMpFilter: function (v) { mpFilter = v; }, detKeyOf: detKeyOf, mpTagPasses: mpTagPasses,
    collCount: collCount, anyLazy: anyLazy, whenAllLoaded: whenAllLoaded, hydrateOne: hydrateOne,
    mpExclude: function () { return mpExclude; }, setMpExclude: function (v) { mpExclude = v; },
    mpShown: function () { return mpShown; },
    setMpShown: function (v) { mpShown = v; },
    mpLayer: function () { return mpLayer; },
    mpPins: function () { return mpPins; },
    mpCollections: function () { return mpCollections; },
    mpIdbReady: function () { return mpIdbReady; },
    setMpCollections: function (v) { mpCollections = v; },
    mpActiveName: function () { return mpActiveName; },
    setMpActiveName: function (v) { mpActiveName = v; },
    mpLastColor: function () { return mpLastColor; },
    setMpLastColor: function (v) { mpLastColor = v; },
    mpSort: function () { return mpSort; },
    setMpSort: function (v) { mpSort = v; },
    mpDistOrigin: function () { return mpDistOrigin; },
    shownColls: function () { return shownColls; },
    setShownColls: function (v) { shownColls = v; },
    shownDetSets: function () { return shownDetSets; },
    setShownDetSets: function (v) { shownDetSets = v; },
    detSetOverlays: function () { return detSetOverlays; },
  };
})();
