/**
 * Inference — the BirdNET Geomodel in its Web Worker (initWorker, runInference,
 * the pending-request table), the per-location prediction cache (predictWeek /
 * predictAllWeeks, an LRU of 0.1° cells), the Season (now vs peak) cells, the
 * range-map and richness renders with their H3 / smooth overlay painting, the
 * viewport grid and the per-cell render cache.
 *
 * Lifted out of app.js byte-for-byte (v2230). app.js still owns the map, the
 * modes and the species views, and injects what this module needs through
 * init() — same identifiers as inside the monolith; shared state goes through
 * getters and setters, the worker / canvas / cache state lives here.
 *
 * Exposed as window.AppInference (no module system; loaded via <script>).
 */
window.AppInference = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var buildSpObs, colormapLookup, curObsSeasonSig, escapeHtml, fmtStep, h3CacheMax,
      h3CacheStore, h3RangeCacheFor, invalidateAnimation, nameLinkHtml, openAnchoredMenu, positionAnchoredMenu,
      probHueColor, richTag, scheduleH3Save, setStatus, showComputingOverlay, sortSpeciesList,
      speciesName, t, triggerRender, updateLegend, updateMapCsv, weekOfToday,
      weekText, wrapLon, maybeComputeDetProbs;
  // … and getters/setters for app state that changes at runtime.
  var getAnimateAll, getHiResFactor, getLabelClass, getSpListGen, getSpObsSort, getSpeciesListSort,
      getCurrentMode, getCurrentSpView, getDetPlot, getLabels, getLabelsByKey, getMap,
      getSpeciesGroup, getH3RangeCache, getCachedRender, getObsSeasonCache, getRendering, getWorker,
      getOrtLegacy, setCachedRender, setObsSeasonCache, setRendering, setWorker, setOrtLegacy,
      getScriptBase;

  function init(ctx) {
    buildSpObs = ctx.buildSpObs;
    colormapLookup = ctx.colormapLookup;
    curObsSeasonSig = ctx.curObsSeasonSig;
    escapeHtml = ctx.escapeHtml;
    fmtStep = ctx.fmtStep;
    h3CacheMax = ctx.h3CacheMax;
    h3CacheStore = ctx.h3CacheStore;
    h3RangeCacheFor = ctx.h3RangeCacheFor;
    invalidateAnimation = ctx.invalidateAnimation;
    nameLinkHtml = ctx.nameLinkHtml;
    openAnchoredMenu = ctx.openAnchoredMenu;
    positionAnchoredMenu = ctx.positionAnchoredMenu;
    probHueColor = ctx.probHueColor;
    richTag = ctx.richTag;
    scheduleH3Save = ctx.scheduleH3Save;
    setStatus = ctx.setStatus;
    showComputingOverlay = ctx.showComputingOverlay;
    sortSpeciesList = ctx.sortSpeciesList;
    speciesName = ctx.speciesName;
    t = ctx.t;
    triggerRender = ctx.triggerRender;
    updateLegend = ctx.updateLegend;
    updateMapCsv = ctx.updateMapCsv;
    weekOfToday = ctx.weekOfToday;
    weekText = ctx.weekText;
    wrapLon = ctx.wrapLon;
    maybeComputeDetProbs = ctx.maybeComputeDetProbs;
    getAnimateAll = ctx.getAnimateAll;
    getHiResFactor = ctx.getHiResFactor;
    getLabelClass = ctx.getLabelClass;
    getSpListGen = ctx.getSpListGen;
    getSpObsSort = ctx.getSpObsSort;
    getSpeciesListSort = ctx.getSpeciesListSort;
    getCurrentMode = ctx.getCurrentMode;
    getCurrentSpView = ctx.getCurrentSpView;
    getDetPlot = ctx.getDetPlot;
    getLabels = ctx.getLabels;
    getLabelsByKey = ctx.getLabelsByKey;
    getMap = ctx.getMap;
    getSpeciesGroup = ctx.getSpeciesGroup;
    getH3RangeCache = ctx.getH3RangeCache;
    getCachedRender = ctx.getCachedRender;
    getObsSeasonCache = ctx.getObsSeasonCache;
    getRendering = ctx.getRendering;
    getWorker = ctx.getWorker;
    getOrtLegacy = ctx.getOrtLegacy;
    setCachedRender = ctx.setCachedRender;
    setObsSeasonCache = ctx.setObsSeasonCache;
    setRendering = ctx.setRendering;
    setWorker = ctx.setWorker;
    setOrtLegacy = ctx.setOrtLegacy;
    getScriptBase = ctx.getScriptBase;
  }

  // ---- constants and state that only the inference / overlay code uses ----
  var MODEL_URL = "geomodel_fp16.onnx";
  var ZOOM_STEP = { 2: 3, 3: 2, 4: 1, 5: 0.5, 6: 0.5, 7: 0.25, 8: 0.25, 9: 0.125, 10: 0.0625, 11: 0.03125,
    12: 0.015625, 13: 0.0078125, 14: 0.00390625, 15: 0.001953125, 16: 0.0009765625, 17: 0.00048828125,
    18: 0.000244140625, 19: 0.0001220703125, 20: 0.00006103515625 };
  var TILE_SIZE_M = 156543.03392;        // web-mercator metres/pixel at zoom 0 (equator)
  var H3_TARGET_EDGE_PX = 15;            // target on-screen H3 cell edge, in px (see h3ResForView)
  var DISPLAY_GAMMA = 0.5;
  var RENDER_CACHE_MAX = 50;
  var inferenceId = 0;
  var pendingInferences = new Map();
  var overlayCanvas = null;
  var offscreenCanvas = null;   // small one-texel-per-cell buffer for smoothing
  var renderCache = new Map();
  var renderGeneration = 0;

  async function initWorker() {
    setStatus("Loading ONNX model\u2026");
    // ?legacyort=1 on the page URL → force the non-SIMD ORT 1.18 fallback (testing the old-Safari path).
    setWorker(new Worker(new URL("inference-worker.js" + (/[?&]legacyort=1/.test(location.search) ? "?legacyort=1" : ""), getScriptBase()).href));
    getWorker().onerror = function (err) {
      console.error("Worker error:", err);
      // A fatal worker error (e.g. wasm OOM/abort) means no `infer` reply will ever
      // arrive — reject every in-flight inference so callers' spinners/overlays clear
      // instead of hanging forever.
      failAllPending(err && err.message ? err.message : "inference worker error");
    };

    await new Promise(function (resolve, reject) {
      getWorker().onmessage = function (e) {
        if (e.data.type === "init") {
          if (e.data.ok) { setOrtLegacy(!!e.data.legacy); resolve(); }
          else reject(new Error(e.data.error || "Worker init failed"));
        }
      };
      getWorker().postMessage({ type: "init", modelUrl: new URL(MODEL_URL, getScriptBase()).href });
    });

    // The plotted-detection probabilities may have been attempted before the model existed
    // (nothing retries that on its own) — ask once now that it does.
    try { maybeComputeDetProbs(); } catch (e2) {}
    getWorker().onmessage = function (e) {
      var msg = e.data;
      if (msg.type !== "infer") return;
      var p = pendingInferences.get(msg.id);
      if (!p) return;
      pendingInferences.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(new Float32Array(msg.data));
    };
  }
  // ---- Inference -----------------------------------------------------------
  // opts.task: "raw" (default, full output) | "column" (opts.speciesIdx) |
  // "richness" (opts.threshold, optional opts.mask). The worker reduces the
  // output so only small arrays cross the thread boundary.
  // Reject + clear every in-flight inference (worker died, or postMessage threw).
  function failAllPending(reason) {
    var e = new Error(reason || "inference worker failed");
    pendingInferences.forEach(function (p) { try { p.reject(e); } catch (_) {} });
    pendingInferences.clear();
  }

  async function runInference(flatInputs, batchSize, opts) {
    opts = opts || {};
    var id = ++inferenceId;
    return new Promise(function (resolve, reject) {
      // A null/terminated worker (init failed) must reject cleanly, not throw inside
      // the executor where callers' .catch() can't see it.
      if (!getWorker()) { reject(new Error("inference worker unavailable")); return; }
      pendingInferences.set(id, { resolve: resolve, reject: reject });
      var buf = new Float32Array(flatInputs).buffer;
      var msg = { type: "infer", id: id, flatInputs: buf, batchSize: batchSize, task: opts.task || "raw" };
      if (opts.task === "column") msg.speciesIdx = opts.speciesIdx;
      if (opts.task === "richness") { msg.threshold = opts.threshold; if (opts.thresholds) msg.thresholds = opts.thresholds; if (opts.mask) msg.mask = opts.mask; }
      if (opts.task === "aggs" || opts.task === "aggsFinish") { msg.aggSession = opts.aggSession; msg.aggMatrix = !!opts.aggMatrix; }
      try {
        getWorker().postMessage(msg, [buf]);   // mask (if any) is cloned, not transferred
      } catch (e) {
        pendingInferences.delete(id);
        reject(e);
      }
    });
  }

  // ---- Location prediction cache -------------------------------------------
  // The model returns the WHOLE species vector for one (lat, lon, week) query, so
  // we keep those vectors in memory keyed by a discrete grid cell + week. The
  // species-list (current week) and the Season column (all 48 weeks) share this
  // cache, and revisiting/close points reuse it — only an un-stored (cell, week)
  // triggers a model run. LRU-capped so memory stays bounded.
  var PRED_GRID_DEG = 0.1;                 // ~11 km grid; queries snap to cell centres
  var PRED_CELL_CAP = 8;                   // keep at most this many cells (each ≤ 48 week-vectors)
  var predCache = Object.create(null);     // "glat,glon" -> { week: Float32Array(nSpecies) }
  var predCellOrder = [];                  // LRU order of cell keys (oldest first)
  function predSnap(v) { return Math.round(v / PRED_GRID_DEG) * PRED_GRID_DEG; }
  function predCellKey(lat, lon) { return predSnap(lat).toFixed(3) + "," + predSnap(lon).toFixed(3); }
  function predTouchCell(k) {
    var i = predCellOrder.indexOf(k); if (i >= 0) predCellOrder.splice(i, 1);
    predCellOrder.push(k);
    while (predCellOrder.length > PRED_CELL_CAP) { var old = predCellOrder.shift(); delete predCache[old]; }
  }
  function predCell(lat, lon) {
    var k = predCellKey(lat, lon);
    if (!predCache[k]) predCache[k] = Object.create(null);
    predTouchCell(k);
    return predCache[k];
  }
  // The full species vector at (grid cell of lat/lon, week) — from cache, else run
  // the model at the cell centre and store it.
  async function predictWeek(lat, lon, week) {
    var cell = predCell(lat, lon);
    if (cell[week]) return cell[week];
    var glat = predSnap(lat), glon = predSnap(lon);
    var out = await runInference(new Float32Array([glat, glon, week]), 1);
    cell[week] = out;
    return out;
  }
  // Ensure all 48 weeks are cached for the point's cell (batch-computing only the
  // missing weeks in ONE model run) and return the cell.
  async function predictAllWeeks(lat, lon) {
    var cell = predCell(lat, lon);
    var missing = [];
    for (var w = 1; w <= 48; w++) if (!cell[w]) missing.push(w);
    if (missing.length) {
      var glat = predSnap(lat), glon = predSnap(lon);
      var inp = new Float32Array(missing.length * 3);
      for (var m = 0; m < missing.length; m++) { inp[m * 3] = glat; inp[m * 3 + 1] = glon; inp[m * 3 + 2] = missing[m]; }
      var flat = await runInference(inp, missing.length);       // (missing × nSpecies), week-major
      var nSp = flat.length / missing.length;
      for (var j = 0; j < missing.length; j++) cell[missing[j]] = flat.subarray(j * nSp, (j + 1) * nSp);
    }
    return cell;
  }
  // ---- Season (now vs peak) -------------------------------------------------
  // Classify one species' 48-week curve at the point: off-season / arriving / at
  // peak / leaving. `ratio` = current ÷ yearly-peak (0..1, the bar length + sort key).
  var SEASON_OFF = 0, SEASON_ARRIVING = 1, SEASON_PEAK = 2, SEASON_LEAVING = 3;
  // Settings → "Compare to". It named the species list's own comparison column; the
  // Yr column beside Season answered to nothing and was always the annual peak, in the
  // list, under the picture cards and in the observation list alike. It now follows this
  // setting everywhere, so one choice governs every surface.
  function cmpRefMode() {
    var el = document.getElementById("compare-select");
    var v = el ? el.value : window.GeoState.get("compare", "annualmax");
    return v == null ? "annualmax" : v;
  }
  // What that column is called, so the header never claims "Yr peak" over another week's
  // number. Modes that are not an absolute probability of their own — Annual Top (a ratio,
  // which is what Season already shows) and "none" — leave it as the annual peak.
  function ytopLabel() {
    var m = cmpRefMode();
    if (m === "mean") return t("compare.mean");
    if (m === "prev") return t("compare.prev");
    if (m === "next") return t("compare.next");
    return t("th.ytop");
  }
  function classifySeason(cell, idx, week) {
    var peak = 0, w, v;
    for (w = 1; w <= 48; w++) { v = cell[w] ? cell[w][idx] : 0; if (v > peak) peak = v; }
    var cur = cell[week] ? cell[week][idx] : 0;
    var ratio = peak > 0 ? cur / peak : 0;
    var pw = ((week - 2 + 48) % 48) + 1, nw = (week % 48) + 1;   // circular neighbours (weeks 1..48)
    var slope = (cell[nw] ? cell[nw][idx] : 0) - (cell[pw] ? cell[pw][idx] : 0);
    var phase = ratio < 0.15 ? SEASON_OFF : ratio >= 0.80 ? SEASON_PEAK : slope >= 0 ? SEASON_ARRIVING : SEASON_LEAVING;
    // `ratio` and `phase` stay measured against the true annual peak — Season means "this
    // week as a share of the species' OWN best week", and that must not move with a setting.
    // `ref` is what the Yr column shows.
    var m = cmpRefMode(), ref = peak;
    if (m === "mean") { var sum = 0; for (w = 1; w <= 48; w++) sum += cell[w] ? cell[w][idx] : 0; ref = sum / 48; }
    else if (m === "prev") ref = cell[pw] ? cell[pw][idx] : 0;
    else if (m === "next") ref = cell[nw] ? cell[nw][idx] : 0;
    return { ratio: ratio, phase: phase, peak: peak, ref: ref };
  }
  var SEASON_META = {};
  SEASON_META[SEASON_OFF] = { g: "·", c: "var(--ink-muted, #9aa0a6)", k: "season.off" };
  SEASON_META[SEASON_ARRIVING] = { g: "↑", c: "#2e9e5b", k: "season.arriving" };
  SEASON_META[SEASON_PEAK] = { g: "●", c: "var(--brand, #3a7bd5)", k: "season.peak" };
  SEASON_META[SEASON_LEAVING] = { g: "↓", c: "#e0872a", k: "season.leaving" };
  // The Yr-peak cell: the species' yearly top probability at the point, as number + bar.
  function ytopCellHtml(s) {
    var r = (s && s.ref != null) ? s.ref : (s ? s.peak : 0);
    var pk = Math.round(r * 100);
    return '<span class="prob-num">' + pk + '%</span><div class="prob-bar" style="width:' + pk + "%;background:" + probHueColor(r) + '"></div>';
  }
  function seasonCellHtml(s) {
    if (!s) return "";
    var meta = SEASON_META[s.phase], pct = Math.round(s.ratio * 100);
    return '<span class="season-glyph" style="color:' + meta.c + '" title="' + escapeHtml(t(meta.k)) + '">' + meta.g + "</span>" +
      '<span class="season-num">' + pct + "%</span>" +
      '<div class="season-bar" style="width:' + pct + '%;background:' + meta.c + '"></div>';
  }
  var seasonKeyIdx = null;                  // species key → model output index (built once)
  function ensureSeasonKeyIdx() {
    if (seasonKeyIdx) return seasonKeyIdx;
    seasonKeyIdx = Object.create(null);
    for (var i = 0; i < getLabels().length; i++) seasonKeyIdx[getLabels()[i].key] = i;
    return seasonKeyIdx;
  }
  // Fill the Season cells of the (non-expanded) Species-list table: ensure the
  // 48-week cache for the point, derive each species' now-vs-peak, write the cell +
  // its sort key, then re-sort if the list is sorted by Season.
  async function fillSeasonCells(lat, lon, gen) {
    var tbody = document.getElementById("sp-tbody"); if (!tbody) return;
    var week = +document.getElementById("week-select").value;
    var cell = await predictAllWeeks(lat, lon);
    if (gen != null && gen !== getSpListGen()) return;   // superseded by a newer render
    var idxMap = ensureSeasonKeyIdx();
    Array.prototype.forEach.call(tbody.querySelectorAll("td.sp-season[data-key]"), function (td) {
      var key = td.getAttribute("data-key"), idx = idxMap[key];
      if (idx == null) return;
      var s = classifySeason(cell, idx, week);
      td.innerHTML = seasonCellHtml(s);
      var tr = td.parentNode; if (tr) tr.setAttribute("data-season", s.ratio);
    });
    if (getSpeciesListSort().col === "season") sortSpeciesList();
  }
  // Fill the Season + year-peak cells in the Observation-list layout at the fetch point —
  // the same 48-week prediction the Species-list Season column uses (memoised per species).
  function fillObsSeasonCells(container, rows) {
    if (!container || !getCurrentSpView()) return;
    var lat = +getCurrentSpView().lat, lon = +getCurrentSpView().lon;
    if (!isFinite(lat) || !isFinite(lon)) return;
    var weekEl = document.getElementById("week-select"), week = weekEl ? +weekEl.value : weekOfToday();
    var sig = curObsSeasonSig();
    predictAllWeeks(lat, lon).then(function (cell) {
      if (!document.body.contains(container)) return;   // list re-rendered meanwhile
      var wasStale = getObsSeasonCache().sig !== sig;   // cache warm already? (re-sort only needed when freshly filled)
      var idxMap = ensureSeasonKeyIdx(), byKey = Object.create(null);
      Object.keys(getDetPlot()).forEach(function (k) { var idx = idxMap[k]; if (idx != null) byKey[k] = classifySeason(cell, idx, week); });
      setObsSeasonCache({ sig: sig, byKey: byKey });   // now the Season/Yr-peak sort has data
      // Re-render (re-sort) only if the values were just computed AND the list is ordered by Season / Yr-peak.
      if (rows && rows.length && wasStale && (getSpObsSort().col === "season" || getSpObsSort().col === "ytop")) buildSpObs(container, rows);
      paintObsSeason(container);
    }).catch(function () {});
  }
  // Season / Yr-peak cells of whatever rows `scope` holds, from the cache (a lazily added
  // slice of the observation list paints its own; nothing happens until the cache is current).
  function paintObsSeason(scope) {
    if (!getCurrentSpView() || getObsSeasonCache().sig !== curObsSeasonSig()) return;
    var byKey = getObsSeasonCache().byKey || {};
    Array.prototype.forEach.call(scope.querySelectorAll("td.sp-season[data-key]"), function (td) {
      var s = byKey[td.getAttribute("data-key")]; if (!s) return;
      td.innerHTML = seasonCellHtml(s);
      var yt = td.parentNode && td.parentNode.querySelector("td.sp-ytop");
      if (yt) yt.innerHTML = ytopCellHtml(s);
    });
  }

  // Progress bar inside the computing overlay (0..1).
  function setComputeProgress(frac) {
    var bar = document.getElementById("computing-progress-bar");
    if (bar) bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + "%";
  }

  // Uint8Array(nSpecies) marking the active group, or null for "all".
  function groupMask() {
    if (getSpeciesGroup() === "all") return null;
    var m = new Uint8Array(getLabels().length);
    for (var i = 0; i < getLabels().length; i++) m[i] = getLabelClass()[i] === getSpeciesGroup() ? 1 : 0;
    return m;
  }

  // Total inference chunks across all weeks (for the progress bar).
  function totalChunks(weekMissing, chunk) {
    var n = 0;
    for (var i = 0; i < weekMissing.length; i++) n += Math.ceil(weekMissing[i].missing.length / chunk) || 1;
    return n;
  }

  // ---- Overlay -------------------------------------------------------------
  function ensureOverlayCanvas() {
    if (overlayCanvas) return;
    overlayCanvas = document.createElement("canvas");
    overlayCanvas.className = "heatmap-overlay";
    overlayCanvas.style.position = "absolute";
    overlayCanvas.style.pointerEvents = "none";
    getMap().getPane("overlayPane").appendChild(overlayCanvas);
  }

  function clearOverlay() {
    // Invalidate any range/richness render still running: its inference resolves
    // LATER and would then set cachedRender and repaint the magma canvas — over
    // whatever mode the user has since moved to. (That is how a dark, magenta-veined
    // rectangle ended up sitting on the Recent map: leaving Range mid-inference.)
    renderGeneration++;
    setCachedRender(null);
    if (overlayCanvas) { overlayCanvas.width = 0; overlayCanvas.height = 0; }
  }

  // Bilinear sample of the cached probability field at a lat/lon — the same
  // mapping the smooth renderer uses (linear in lon, row by latitude).
  function sampleGridProb(g, probs, lat, lon) {
    var rf = (g.north - lat) / g.step - 0.5;
    var r0 = Math.floor(rf), fr = Math.max(0, Math.min(1, rf - r0));
    r0 = Math.max(0, Math.min(g.nLat - 1, r0));
    var r1 = Math.max(0, Math.min(g.nLat - 1, r0 + 1));
    var lonU = lon; while (lonU < g.west) lonU += 360; while (lonU > g.east) lonU -= 360;
    var cf = (lonU - g.west) / g.step - 0.5;
    var c0 = Math.floor(cf), fc = Math.max(0, Math.min(1, cf - c0));
    c0 = Math.max(0, Math.min(g.nLon - 1, c0));
    var c1 = Math.max(0, Math.min(g.nLon - 1, c0 + 1));
    var b0 = r0 * g.nLon, b1 = r1 * g.nLon;
    var top = probs[b0 + c0] + (probs[b0 + c1] - probs[b0 + c0]) * fc;
    var bot = probs[b1 + c0] + (probs[b1 + c1] - probs[b1 + c0]) * fc;
    return top + (bot - top) * fr;
  }

  // H3 resolution for the overlay. The base resolution targets a fixed on-screen
  // hex size (~15px edge) so the tile *count* stays ~constant across zoom; the
  // Resolution setting then shifts it by whole zoom levels (each = one H3
  // resolution, ~7x the tiles).
  function h3ResForView() {
    var z = getMap().getZoom();
    // Metres-per-pixel at the equator (no cos(lat) term): the resolution follows
    // the zoom only, so panning north–south doesn't flip the H3 resolution.
    var mpp = TILE_SIZE_M / Math.pow(2, z);
    var targetM = Math.max(1, H3_TARGET_EDGE_PX * mpp);
    var best = 0, bestD = Infinity;
    for (var r = 0; r <= 14; r++) {
      // Geometric (log) closeness: H3 resolutions are ~2.65x apart in edge, so
      // log distance centres the on-screen size symmetrically around the target.
      var d = Math.abs(Math.log(window.h3.getHexagonEdgeLengthAvg(r, "m") / targetM));
      if (d < bestD) { bestD = d; best = r; }
    }
    return Math.max(0, Math.min(14, best + (getHiResFactor() | 0)));
  }

  // The distribution overlay is always drawn as filled H3 hexagons (the smooth
  // heatmap is used only if the H3 library failed to load at all).
  // Repaints are coalesced to one per animation frame: the inference chunk loop and
  // map "moveend" can each fire many paintOverlay()s in quick succession, and each
  // does a full canvas redraw (re-enumerating in-view hexes + re-projecting every
  // vertex). schedulePaint() collapses a burst to the latest frame; a direct
  // paintOverlay() (the guaranteed final paint) cancels any pending frame so callers
  // that read cachedRender.maxProb right after still observe a completed paint.
  var _paintRAF = 0;
  function schedulePaint() {
    if (_paintRAF) return;
    if (typeof requestAnimationFrame === "undefined") { paintOverlay(); return; }
    _paintRAF = requestAnimationFrame(function () { _paintRAF = 0; paintOverlay(); });
  }
  function paintOverlay() {
    if (_paintRAF) { cancelAnimationFrame(_paintRAF); _paintRAF = 0; }
    if (!getCachedRender() || !getMap()) return;
    if (getCurrentMode() !== "range" && getCurrentMode() !== "richness") { clearOverlay(); return; }   // the heat canvas belongs to those two modes only
    if (!window.h3) { paintOverlaySmooth(); return; }
    try {
      if (getCachedRender().h3richness) paintRichnessH3();
      else if (getCachedRender().h3range) paintRangeH3();
      else paintOverlayH3();
    } catch (e) { console.warn("h3 overlay", e); }
  }

  // Draw the Species-Range overlay from the per-cell H3 cache (Richness still
  // uses the grid-sampling path in paintOverlayH3).
  function paintRangeH3() {
    ensureOverlayCanvas();
    var cache = getH3RangeCache().get(getCachedRender().tag) || {};
    var size = getMap().getSize();
    if (overlayCanvas.width !== size.x || overlayCanvas.height !== size.y) { overlayCanvas.width = size.x; overlayCanvas.height = size.y; }
    L.DomUtil.setPosition(overlayCanvas, getMap().containerPointToLayerPoint([0, 0]));
    var ctx = overlayCanvas.getContext("2d");
    var pjo = h3ProjOffsets();   // one projection origin per paint; hex vertices come from the per-(cell, zoom) memo (P12)
    ctx.clearRect(0, 0, size.x, size.y);
    var targetRes = h3ResForView(), cells = h3CellsInView(targetRes);
    var i, max = 0, v;
    // Normalise to the species' peak across ALL cached cells for this week (not
    // just those in view) so a low-probability region doesn't rescale to full
    // colour when you zoom into it (e.g. an Iberian species "appearing" in
    // Norway). The peak is captured once a broad/zoomed-out view is computed.
    // Important: ignore cells from other H3 resolutions left in the cache from
    // an earlier hiResFactor — they'd skew the max for the cells we actually
    // draw and wash out the colours at the new resolution.
    max = h3CacheMax(cache, targetRes);
    if (max <= 0) max = 0.01;
    getCachedRender().maxProb = max;   // legend reflects this species-wide normalisation
    var pmin = +document.getElementById("prob-min").value / 100;
    var pmax = +document.getElementById("prob-max").value / 100;
    for (i = 0; i < cells.length; i++) {
      var raw = cache[cells[i]];
      if (raw == null || raw < pmin || raw > pmax) continue;   // not computed, or filtered out
      var p = Math.pow(raw / max, DISPLAY_GAMMA);
      if (!(p >= 0.01)) continue;
      var sh = h3Shape(cells[i]); if (sh.straddles) continue;   // skip antimeridian-straddling hexes
      var pj = h3Proj(cells[i], sh, pjo.zoom);
      ctx.beginPath();
      for (var vtx = 0; vtx < pj.length; vtx += 2) {
        if (vtx === 0) ctx.moveTo(pj[vtx] - pjo.ox, pj[vtx + 1] - pjo.oy); else ctx.lineTo(pj[vtx] - pjo.ox, pj[vtx + 1] - pjo.oy);
      }
      ctx.closePath();
      var col = colormapLookup(p);
      ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + Math.min(1, 0.25 + p * 0.75).toFixed(3) + ")";
      ctx.fill();
    }
  }

  // Richness overlay, drawn per H3 cell from the per-cell cache — each hexagon's
  // value is the model evaluated AT THAT HEXAGON'S CENTROID (see renderRichness),
  // so the tiling has no gaps. (The old path sampled a rectangular grid and then
  // re-sampled it onto the hexagons, which left regular "holes" at low zoom where
  // the two grids beat against each other.) Same colour mapping as the Range
  // overlay — normalise by the peak count, then gamma — but no probability-slider
  // filter, since richness is a species COUNT, not a probability.
  function paintRichnessH3() {
    ensureOverlayCanvas();
    var cache = getH3RangeCache().get(getCachedRender().tag) || {};
    var size = getMap().getSize();
    if (overlayCanvas.width !== size.x || overlayCanvas.height !== size.y) { overlayCanvas.width = size.x; overlayCanvas.height = size.y; }
    L.DomUtil.setPosition(overlayCanvas, getMap().containerPointToLayerPoint([0, 0]));
    var ctx = overlayCanvas.getContext("2d");
    var pjo = h3ProjOffsets();   // one projection origin per paint; hex vertices come from the per-(cell, zoom) memo (P12)
    ctx.clearRect(0, 0, size.x, size.y);
    var targetRes = h3ResForView(), cells = h3CellsInView(targetRes);
    // Peak across cached cells of the CURRENT resolution (ignore leftovers from an
    // earlier detail setting), so colours stay stable when zooming into a low area.
    var i, max = h3CacheMax(cache, targetRes);
    if (max <= 0) max = 1;
    getCachedRender().maxVal = max;   // legend shows the peak species count
    for (i = 0; i < cells.length; i++) {
      var raw = cache[cells[i]];
      if (raw == null) continue;
      var p = Math.pow(raw / max, DISPLAY_GAMMA);
      if (!(p >= 0.01)) continue;
      var sh = h3Shape(cells[i]); if (sh.straddles) continue;
      var pj = h3Proj(cells[i], sh, pjo.zoom);
      ctx.beginPath();
      for (var vtx = 0; vtx < pj.length; vtx += 2) {
        if (vtx === 0) ctx.moveTo(pj[vtx] - pjo.ox, pj[vtx + 1] - pjo.oy); else ctx.lineTo(pj[vtx] - pjo.ox, pj[vtx + 1] - pjo.oy);
      }
      ctx.closePath();
      var col = colormapLookup(p);
      ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + Math.min(1, 0.25 + p * 0.75).toFixed(3) + ")";
      ctx.fill();
    }
  }

  // Enumerate the H3 cells (resolution `res`) covering the current viewport by
  // sampling screen points and mapping each to its cell. This is bounded by the
  // screen and never throws — unlike polygonToCells, which fails on large areas
  // at some resolutions and previously forced a fall back to square cells.
  // The in-view cell list depends only on (res, zoom, viewport size, center), and
  // is asked for several times per render (renderRangeMap, then paintRangeH3 on each
  // coalesced repaint, plus the CSV builder). Memoise the last result so those repeat
  // calls reuse it instead of re-sampling the screen (thousands of latLngToCell wasm
  // calls). Callers only read the array, so returning the shared reference is safe.
  var _civKey = "", _civCells = null;
  function h3CellsInView(res) {
    var size0 = getMap().getSize(), c0 = getMap().getCenter();
    var ck = res + ":" + getMap().getZoom() + ":" + size0.x + "x" + size0.y + ":" + c0.lat.toFixed(5) + "," + c0.lng.toFixed(5);
    if (ck === _civKey && _civCells) return _civCells;
    var size = getMap().getSize(), c = getMap().getCenter();
    var mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, getMap().getZoom());
    var edgePx = Math.max(4, window.h3.getHexagonEdgeLengthAvg(res, "m") / mpp);
    var stepPx = Math.max(5, edgePx * 0.6);   // sample finer than a hex so none is missed
    var seen = {}, out = [];
    for (var y = 0; y <= size.y + stepPx; y += stepPx) {
      var yy = Math.min(y, size.y);
      for (var x = 0; x <= size.x + stepPx; x += stepPx) {
        var ll = getMap().containerPointToLatLng([Math.min(x, size.x), yy]);
        var cell = window.h3.latLngToCell(Math.max(-89.9, Math.min(89.9, ll.lat)), wrapLon(ll.lng), res);
        if (!seen[cell]) { seen[cell] = 1; out.push(cell); }
      }
    }
    // Screen-sampling on a fixed step can skip a cell that no sample point happened
    // to land inside — H3 cells are distorted, and Mercator scale varies with
    // latitude across a zoomed-out view — leaving a regular pattern of gaps in the
    // heatmap. Each skipped cell is surrounded by found ones, so add the 1-ring
    // neighbours of every sampled cell: that fills the gaps (and adds a thin border
    // of just-off-screen cells, which is harmless — they draw off-canvas).
    if (window.h3.gridDisk) {
      var nBase = out.length;
      for (var bi = 0; bi < nBase; bi++) {
        var ring = window.h3.gridDisk(out[bi], 1);
        for (var ri = 0; ri < ring.length; ri++) {
          var nb = ring[ri];
          if (!seen[nb]) { seen[nb] = 1; out.push(nb); }
        }
      }
    }
    _civKey = ck; _civCells = out;
    return out;
  }

  // Memoise H3 cell geometry: cellToBoundary + the antimeridian-straddle flag are
  // deterministic per cell id (zoom-independent), and getResolution likewise — so
  // cache them instead of calling the H3 wasm per hex on every repaint (paint runs
  // per inference chunk and on every pan/zoom). Capped so a long pan session can't
  // grow them without bound.
  var _h3Shape = Object.create(null), _h3Res = Object.create(null), _h3N = 0;
  function h3Shape(cell) {
    var s = _h3Shape[cell];
    if (s === undefined) {
      if (_h3N > 60000) { _h3Shape = Object.create(null); _h3Res = Object.create(null); _h3N = 0; }   // bound memory
      var bnd = window.h3.cellToBoundary(cell), minLon = 999, maxLon = -999;
      for (var w = 0; w < bnd.length; w++) { var lo = bnd[w][1]; if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo; }
      s = { bnd: bnd, straddles: (maxLon - minLon > 180) };
      _h3Shape[cell] = s; _h3N++;
    }
    return s;
  }
  // Hex vertices projected to world pixels, memoised per (cell, zoom): a paint then only subtracts
  // the pan/origin offset per vertex instead of projecting every vertex of every cell again (P12).
  var _h3Proj = Object.create(null), _h3ProjN = 0;
  function h3ProjOffsets() {
    var po = getMap().getPixelOrigin(), o0 = getMap().containerPointToLayerPoint([0, 0]);
    return { zoom: getMap().getZoom(), ox: po.x + o0.x, oy: po.y + o0.y };   // container = project(ll, zoom) − pixelOrigin + panePos
  }
  function h3Proj(cell, sh, zoom) {
    var k = cell + "@" + zoom, p = _h3Proj[k];
    if (p === undefined) {
      if (_h3ProjN > 60000) { _h3Proj = Object.create(null); _h3ProjN = 0; }
      var bnd = sh.bnd; p = new Float64Array(bnd.length * 2);
      for (var w = 0; w < bnd.length; w++) { var q = getMap().project([bnd[w][0], bnd[w][1]], zoom); p[w * 2] = q.x; p[w * 2 + 1] = q.y; }
      _h3Proj[k] = p; _h3ProjN++;
    }
    return p;
  }
  function h3ResOf(cell) {
    var r = _h3Res[cell];
    if (r === undefined) r = _h3Res[cell] = window.h3.getResolution(cell);
    return r;
  }

  function paintOverlayH3() {
    ensureOverlayCanvas();
    var g = getCachedRender().grid, probs = getCachedRender().probs;
    var size = getMap().getSize();
    if (overlayCanvas.width !== size.x || overlayCanvas.height !== size.y) { overlayCanvas.width = size.x; overlayCanvas.height = size.y; }
    L.DomUtil.setPosition(overlayCanvas, getMap().containerPointToLayerPoint([0, 0]));
    var ctx = overlayCanvas.getContext("2d");
    var pjo = h3ProjOffsets();   // one projection origin per paint; hex vertices come from the per-(cell, zoom) memo (P12)
    ctx.clearRect(0, 0, size.x, size.y);

    var cells = h3CellsInView(h3ResForView());
    // Only draw hexes whose centre lies within the computed data region, so the
    // overlay never spills predicted colour outside what was actually evaluated.
    for (var i = 0; i < cells.length; i++) {
      var ll = window.h3.cellToLatLng(cells[i]);
      var lonU = ll[1]; while (lonU < g.west) lonU += 360; while (lonU > g.east) lonU -= 360;
      if (ll[0] > g.north + 1e-9 || ll[0] < g.south - 1e-9 || lonU < g.west - 1e-9 || lonU > g.east + 1e-9) continue;
      var p = sampleGridProb(g, probs, ll[0], ll[1]);
      if (!(p >= 0.01)) continue;
      // Skip hexes straddling the antimeridian (would smear across the map).
      var sh = h3Shape(cells[i]); if (sh.straddles) continue;
      var pj = h3Proj(cells[i], sh, pjo.zoom);
      ctx.beginPath();
      for (var v = 0; v < pj.length; v += 2) {
        if (v === 0) ctx.moveTo(pj[v] - pjo.ox, pj[v + 1] - pjo.oy); else ctx.lineTo(pj[v] - pjo.ox, pj[v + 1] - pjo.oy);
      }
      ctx.closePath();
      var col = colormapLookup(p);
      ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + Math.min(1, 0.25 + p * 0.75).toFixed(3) + ")";
      ctx.fill();
    }
  }

  // Smooth-heatmap fallback: bilinearly interpolate the PROBABILITY SCALAR (in
  // longitude, linear in screen-x, and latitude, mapped back per Mercator row),
  // then colourise each pixel. Built at ~screen resolution, drawn ~1:1.
  function paintOverlaySmooth() {
    if (!getCachedRender() || !getMap()) return;
    ensureOverlayCanvas();

    var g = getCachedRender().grid, probs = getCachedRender().probs;
    var size = getMap().getSize();
    if (overlayCanvas.width !== size.x || overlayCanvas.height !== size.y) {
      overlayCanvas.width = size.x;
      overlayCanvas.height = size.y;
    }
    L.DomUtil.setPosition(overlayCanvas, getMap().containerPointToLayerPoint([0, 0]));
    var ctx = overlayCanvas.getContext("2d");
    ctx.clearRect(0, 0, size.x, size.y);

    var nw = getMap().latLngToContainerPoint([g.north, g.west]);
    var se = getMap().latLngToContainerPoint([g.south, g.east]);
    var destX = nw.x, destW = se.x - nw.x, destY = nw.y, destH = se.y - nw.y;
    if (destW <= 0 || destH <= 0) return;

    // Output buffer at (capped) screen resolution.
    var BW = Math.max(2, Math.min(Math.round(destW), 1100));
    var BH = Math.max(2, Math.min(Math.round(destH), 760));
    if (!offscreenCanvas) offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = BW;
    offscreenCanvas.height = BH;
    var octx = offscreenCanvas.getContext("2d");
    var img = octx.createImageData(BW, BH);
    var data = img.data;

    // Fractional cell-COLUMN index per output column (lon is linear in x).
    var col0 = new Int32Array(BW), col1 = new Int32Array(BW), colFrac = new Float64Array(BW);
    for (var ox = 0; ox < BW; ox++) {
      var cf = (ox + 0.5) / BW * g.nLon - 0.5;
      var c0 = Math.floor(cf);
      colFrac[ox] = Math.max(0, Math.min(1, cf - c0));
      col0[ox] = Math.max(0, Math.min(g.nLon - 1, c0));
      col1[ox] = Math.max(0, Math.min(g.nLon - 1, c0 + 1));
    }

    for (var oy = 0; oy < BH; oy++) {
      var sy = destY + (oy + 0.5) / BH * destH;
      var lat = getMap().containerPointToLatLng([destX, sy]).lat;   // Mercator-correct latitude
      var rf = (g.north - lat) / g.step - 0.5;
      var r0 = Math.floor(rf), fr = Math.max(0, Math.min(1, rf - r0));
      r0 = Math.max(0, Math.min(g.nLat - 1, r0));
      var r1 = Math.max(0, Math.min(g.nLat - 1, r0 + 1));
      var base0 = r0 * g.nLon, base1 = r1 * g.nLon, rowOff = oy * BW * 4;
      for (var ox2 = 0; ox2 < BW; ox2++) {
        var a = col0[ox2], b = col1[ox2], fc = colFrac[ox2];
        // bilinear on the scalar probability
        var top = probs[base0 + a] + (probs[base0 + b] - probs[base0 + a]) * fc;
        var bot = probs[base1 + a] + (probs[base1 + b] - probs[base1 + a]) * fc;
        var p = top + (bot - top) * fr;
        var col = colormapLookup(p);
        var o = rowOff + ox2 * 4;
        data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2];
        data[o + 3] = p >= 0.01 ? Math.round(Math.min(1, 0.25 + p * 0.75) * 255) : 0;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offscreenCanvas, destX, destY, destW, destH);
  }

  // ---- Viewport grid -------------------------------------------------------
  function viewportGrid() {
    var b = getMap().getBounds();
    var south = Math.max(b.getSouth(), -90), north = Math.min(b.getNorth(), 90);
    var west = b.getWest(), east = b.getEast();
    if (east - west >= 360) { west = -180; east = 180; }
    else { west = wrapLon(west); east = wrapLon(east); if (east <= west) east += 360; }
    if (north - south < 0.1) north = south + 0.1;
    if (east - west < 0.1) east = west + 0.1;
    // The detail offset shifts sampling by whole zoom levels (one H3 resolution
    // ≈ 2.6458x finer per step), matching the range overlay's resolution steps.
    var step = (ZOOM_STEP[Math.round(getMap().getZoom())] || 3) / Math.pow(2.6458, getHiResFactor() | 0);
    south = Math.max(Math.floor(south / step) * step, -90);
    north = Math.min(Math.ceil(north / step) * step, 90);
    west = Math.floor(west / step) * step;
    east = Math.ceil(east / step) * step;
    return { south: south, north: north, west: west, east: east, step: step,
             nLat: Math.round((north - south) / step), nLon: Math.round((east - west) / step) };
  }

  // ---- Cell cache ----------------------------------------------------------
  function cacheKey(speciesKey, week) { return speciesKey + ":" + week; }
  function cellId(lat, lon) { return Math.round(lat * 100) + "," + Math.round(lon * 100); }

  function getCellMap(key, step) {
    var entry = renderCache.get(key);
    if (!entry || entry.step !== step) {
      entry = { step: step, cells: new Map() };
      renderCache.set(key, entry);
      if (renderCache.size > RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value);
    }
    return entry.cells;
  }

  function viewportMissing(cellMap, grid) {
    var pts = [];
    for (var iLat = 0; iLat < grid.nLat; iLat++) {
      var lat = grid.north - (iLat + 0.5) * grid.step;
      for (var iLon = 0; iLon < grid.nLon; iLon++) {
        var lon = wrapLon(grid.west + (iLon + 0.5) * grid.step);
        if (!cellMap.has(cellId(lat, lon))) pts.push({ lat: lat, lon: lon });
      }
    }
    return pts;
  }

  function buildViewportArray(cellMap, grid) {
    var arr = new Float32Array(grid.nLat * grid.nLon);
    var i = 0;
    for (var iLat = 0; iLat < grid.nLat; iLat++) {
      var lat = grid.north - (iLat + 0.5) * grid.step;
      for (var iLon = 0; iLon < grid.nLon; iLon++) {
        var lon = wrapLon(grid.west + (iLon + 0.5) * grid.step);
        arr[i++] = cellMap.get(cellId(lat, lon)) || 0;
      }
    }
    return arr;
  }

  // Weeks to compute for a range/richness render: just the selected week
  // normally, or all 48 when precomputing for migration animation.
  function weeksToCompute() {
    if (getAnimateAll()) {
      var a = [];
      for (var w = 1; w <= 48; w++) a.push(w);
      return a;
    }
    return [+document.getElementById("week-select").value];
  }

  // Cells per inference call. The model emits labels.length (~12k) floats per
  // cell, so we cap the output buffer at ~32 MB to bound worker memory and
  // avoid tab crashes when sweeping large viewports / all 48 weeks.
  function inferChunk() {
    return Math.max(256, Math.floor(8000000 / getLabels().length));
  }

  // ---- Range map -----------------------------------------------------------
  // The selected species' name shown above the map in Range mode — clickable
  // (same context menu as a species-list name).
  function updateRangeSpecies() {
    var el = document.getElementById("range-species");
    if (!el) return;
    var key = document.getElementById("species-search").dataset.selectedKey;
    if (getCurrentMode() === "range" && key && getLabelsByKey()[key]) {
      var wk = +document.getElementById("week-select").value;
      // The week is a tap target: it opens a small anchored week SLIDER, so the
      // range map's week can be changed without opening the controls panel.
      el.innerHTML = nameLinkHtml(getLabelsByKey()[key]) +
        ' <span class="rng-wk rng-wk-click" role="button" tabindex="0" title="' + escapeHtml(t("ctrl.week")) + '">· ' + escapeHtml(weekText(wk)) + "</span>";
      var wkEl = el.querySelector(".rng-wk-click");
      wkEl.addEventListener("click", function (e) {
        e.stopPropagation();
        var r = this.getBoundingClientRect();
        showWeekMenu(r.left, r.bottom + 6);
      });
      el.style.display = "block";
    } else {
      el.innerHTML = "";
      el.style.display = "none";
    }
  }
  // Anchored week slider (opened from the range map's "· Week N" label). While
  // dragging, only the CHEAP updates run (label + re-filtering the cached range
  // cells); the full week-change pipeline (fetches, best-sites reload, legend)
  // fires once on release via the week-select's own change event.
  function showWeekMenu(x, y) {
    var sel = document.getElementById("week-select");
    var el = openAnchoredMenu("bird-zoom-pop week-pop");
    var wk = +sel.value || 1;
    el.innerHTML = '<div class="bzp-lbl">' + escapeHtml(weekText(wk)) + "</div>" +
      '<input type="range" min="1" max="48" step="1" value="' + wk + '" class="bzp-range" aria-label="' + escapeHtml(t("ctrl.week")) + '">';
    var rng = el.querySelector(".bzp-range"), lbl = el.querySelector(".bzp-lbl");
    rng.addEventListener("input", function () {
      var nv = Math.max(1, Math.min(48, Math.round(+this.value)));
      lbl.textContent = weekText(nv);
      sel.value = String(nv);
      if (getCurrentMode() === "range" || getCurrentMode() === "richness") showCachedWeek();   // cheap: cached cells only
      var rs = document.querySelector("#range-species .rng-wk-click");
      if (rs) rs.textContent = "· " + weekText(nv);
    });
    rng.addEventListener("change", function () {
      try { sel.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
    });
    positionAnchoredMenu(el, x, y);
  }

  // Species Range overlay, computed and cached per H3 cell. Only the cells
  // visible at the current zoom that aren't already cached are inferred, so
  // zooming/panning back over an area costs nothing.
  async function renderRangeMap() {
    if (!getAnimateAll()) invalidateAnimation();   // a fresh single-week render makes any precomputed animation stale
    var key = document.getElementById("species-search").dataset.selectedKey;
    updateRangeSpecies();
    if (!key || !getLabelsByKey()[key] || !window.h3) return;
    if (getRendering()) { renderGeneration++; return; }
    var gen = ++renderGeneration;
    var lbl = getLabelsByKey()[key], speciesIdx = lbl.index, name = speciesName(lbl);
    var selectedWeek = +document.getElementById("week-select").value;
    var weeks = weeksToCompute(), CHUNK = inferChunk();
    var res = h3ResForView(), cells = h3CellsInView(res);
    var approxStep = +(window.h3.getHexagonEdgeLengthAvg(res, "m") / 111320).toFixed(3);

    // Collect the (week, cell) pairs not yet in the cache.
    var missing = [];
    weeks.forEach(function (w) {
      var cache = h3RangeCacheFor(key + ":" + w);
      for (var i = 0; i < cells.length; i++) if (!(cells[i] in cache)) missing.push({ w: w, c: cells[i], cache: cache });
    });

    if (missing.length === 0) {   // fully cached for this view
      setCachedRender({ h3range: true, tag: key + ":" + selectedWeek });
      paintOverlay();
      setStatus(t("status.rangeCached", { name: name, week: weekText(selectedWeek), n: cells.length.toLocaleString(), step: approxStep }));
      updateLegend(); updateMapCsv();
      return;
    }

    setRendering(true);
    showComputingOverlay(true, name);
    var total = Math.ceil(missing.length / CHUNK), done = 0;
    try {
      for (var s = 0; s < missing.length; s += CHUNK) {
        if (gen !== renderGeneration) return;
        var batch = missing.slice(s, s + CHUNK);
        var inputs = new Float32Array(batch.length * 3);
        for (var j = 0; j < batch.length; j++) {
          var ll = window.h3.cellToLatLng(batch[j].c);
          inputs[j * 3] = ll[0]; inputs[j * 3 + 1] = ll[1]; inputs[j * 3 + 2] = batch[j].w;
        }
        // Worker returns just this species' column (batch.length floats).
        var out = await runInference(inputs, batch.length, { task: "column", speciesIdx: speciesIdx });
        for (var k = 0; k < batch.length; k++) h3CacheStore(batch[k].cache, batch[k].c, out[k]);
        setComputeProgress(++done / total);
        setStatus(t("status.computing", { name: name, week: weekText(selectedWeek), n: missing.length, i: done, total: total }));
        if (gen === renderGeneration) { setCachedRender({ h3range: true, tag: key + ":" + selectedWeek }); schedulePaint(); }
      }
      if (gen !== renderGeneration) return;
      setCachedRender({ h3range: true, tag: key + ":" + selectedWeek });
      paintOverlay();
      setStatus(t("status.rangeDone", { name: name, week: weekText(selectedWeek), n: cells.length.toLocaleString(), step: approxStep }));
      updateLegend(); updateMapCsv(); scheduleH3Save();
    } catch (e) { setStatus(t("status.error", { msg: e.message }), true); console.error(e); }
    finally { setRendering(false); showComputingOverlay(false); if (gen !== renderGeneration) triggerRender(); }
  }

  // ---- Cached week switch --------------------------------------------------
  // weekOverride lets animation playback render a frame WITHOUT touching the
  // week-select control (so the user's chosen week — and the persisted setting —
  // stay put during Play); omitted, it reads the selected week as usual.
  function showCachedWeek(weekOverride) {
    var week = weekOverride != null ? weekOverride : +document.getElementById("week-select").value;

    if (getCurrentMode() === "richness") {
      // Paint from the per-cell H3 cache when every visible hexagon for this week is
      // cached (e.g. animation playback); otherwise compute the missing cells.
      var rcache = window.h3 && getH3RangeCache().get(richTag(week));
      var rcells = window.h3 ? h3CellsInView(h3ResForView()) : [];
      var allR = rcache && rcells.every(function (c) { return c in rcache; });
      if (allR) {
        setCachedRender({ h3richness: true, tag: richTag(week) });
        paintOverlay();
        setStatus(t("status.richnessCached", { week: weekText(week), n: rcells.length, step: "" }));
        updateLegend();
        updateMapCsv();
      } else { renderRichness(); }
      return;
    }

    var key = document.getElementById("species-search").dataset.selectedKey;
    if (!key || !getLabelsByKey()[key] || !window.h3) return;
    // Range: paint from the H3 cache if every visible cell for this week is
    // cached (e.g. animation playback); otherwise compute the missing cells.
    var cache = getH3RangeCache().get(key + ":" + week);
    var cells = h3CellsInView(h3ResForView());
    var allCached = cache && cells.every(function (c) { return c in cache; });
    if (allCached) {
      setCachedRender({ h3range: true, tag: key + ":" + week });
      paintOverlay();
      setStatus(t("status.rangeCached", { name: speciesName(getLabelsByKey()[key]), week: weekText(week), n: cells.length, step: "" }));
      updateLegend();
      updateMapCsv();
    } else { renderRangeMap(); }
  }

  // ---- Species richness ----------------------------------------------------
  var RICHNESS_THRESHOLD = 0.05;

  // Richness is now computed per H3 cell — the model is evaluated at each visible
  // hexagon's CENTROID (window.h3.cellToLatLng), exactly like the Range overlay,
  // and cached per cell. This replaces the old rectangular-grid sampling that, once
  // re-sampled onto the hex tiling, left regular holes over a large area.
  async function renderRichness() {
    if (!getAnimateAll()) invalidateAnimation();   // a fresh single-week render makes any precomputed animation stale
    if (!window.h3) return;                    // richness draws per H3 cell (like Range)
    if (getRendering()) { renderGeneration++; return; }
    var gen = ++renderGeneration;
    var selectedWeek = +document.getElementById("week-select").value;
    var weeks = weeksToCompute(), CHUNK = inferChunk();
    var res = h3ResForView(), cells = h3CellsInView(res);
    var approxStep = fmtStep(+(window.h3.getHexagonEdgeLengthAvg(res, "m") / 111320).toFixed(3));
    var mask = groupMask();
    var richName = t("legend.count");

    // Collect the (week, cell) pairs not yet cached.
    var missing = [];
    weeks.forEach(function (w) {
      var cache = h3RangeCacheFor(richTag(w));
      for (var i = 0; i < cells.length; i++) if (!(cells[i] in cache)) missing.push({ w: w, c: cells[i], cache: cache });
    });

    if (missing.length === 0) {   // fully cached for this view
      setCachedRender({ h3richness: true, tag: richTag(selectedWeek) });
      paintOverlay();
      setStatus(t("status.richnessCached", { week: weekText(selectedWeek), n: cells.length.toLocaleString(), step: approxStep }));
      updateLegend();
      updateMapCsv();
      return;
    }

    setRendering(true);
    showComputingOverlay(true, richName);
    var total = Math.ceil(missing.length / CHUNK), done = 0;
    try {
      for (var s = 0; s < missing.length; s += CHUNK) {
        if (gen !== renderGeneration) return;
        var batch = missing.slice(s, s + CHUNK);
        var inputs = new Float32Array(batch.length * 3);
        for (var j = 0; j < batch.length; j++) {
          var ll = window.h3.cellToLatLng(batch[j].c);   // sample the hexagon's centre
          inputs[j * 3] = ll[0]; inputs[j * 3 + 1] = ll[1]; inputs[j * 3 + 2] = batch[j].w;
        }
        // Worker counts species ≥ threshold (optionally masked to a group) per cell.
        var out = await runInference(inputs, batch.length, { task: "richness", threshold: RICHNESS_THRESHOLD, mask: mask });
        for (var k = 0; k < batch.length; k++) h3CacheStore(batch[k].cache, batch[k].c, out[k]);
        setComputeProgress(++done / total);
        setStatus(t("status.computing", { name: richName, week: weekText(selectedWeek), n: missing.length, i: done, total: total }));
        if (gen === renderGeneration) { setCachedRender({ h3richness: true, tag: richTag(selectedWeek) }); schedulePaint(); }
      }
      if (gen !== renderGeneration) return;
      setCachedRender({ h3richness: true, tag: richTag(selectedWeek) });
      paintOverlay();
      setStatus(t("status.richnessDone", { week: weekText(selectedWeek), n: cells.length.toLocaleString(), step: approxStep }));
      updateLegend();
      updateMapCsv();
      scheduleH3Save();
    } catch (e) { setStatus(t("status.error", { msg: e.message }), true); console.error(e); }
    finally { setRendering(false); showComputingOverlay(false); if (gen !== renderGeneration) triggerRender(); }
  }


  return {
    init: init,
    initWorker: initWorker,
    SEASON_META: SEASON_META,
    cacheKey: cacheKey,
    cellId: cellId,
    classifySeason: classifySeason,
    clearOverlay: clearOverlay,
    cmpRefMode: cmpRefMode,
    ensureSeasonKeyIdx: ensureSeasonKeyIdx,
    failAllPending: failAllPending,
    fillObsSeasonCells: fillObsSeasonCells,
    fillSeasonCells: fillSeasonCells,
    getCellMap: getCellMap,
    h3CellsInView: h3CellsInView,
    h3ResForView: h3ResForView,
    h3ResOf: h3ResOf,
    inferChunk: inferChunk,
    paintObsSeason: paintObsSeason,
    paintOverlay: paintOverlay,
    predCell: predCell,
    predSnap: predSnap,
    predictAllWeeks: predictAllWeeks,
    predictWeek: predictWeek,
    renderRangeMap: renderRangeMap,
    renderRichness: renderRichness,
    runInference: runInference,
    schedulePaint: schedulePaint,
    seasonCellHtml: seasonCellHtml,
    setComputeProgress: setComputeProgress,
    showCachedWeek: showCachedWeek,
    updateRangeSpecies: updateRangeSpecies,
    viewportGrid: viewportGrid,
    ytopCellHtml: ytopCellHtml,
    ytopLabel: ytopLabel,
    DISPLAY_GAMMA: DISPLAY_GAMMA,
    H3_TARGET_EDGE_PX: H3_TARGET_EDGE_PX,
    TILE_SIZE_M: TILE_SIZE_M,
  };
})();
