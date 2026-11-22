/**
 * Offline maps — download a drawn rectangle's map tiles for use without a network.
 *
 * Lifted out of app.js byte-for-byte (v1262): the area list and its modal, the
 * tile-range maths, the download/refill/delete loop into the service worker's
 * pinned cache, the on-map frames, the zoom cap while tiles are failing, and the
 * "you are offline — open a downloaded area?" prompt. app.js still owns the map,
 * the basemap and the overlays, and injects them through init() — the injected
 * names are the SAME identifiers the code used inside the monolith, so the
 * bodies below are unchanged.
 *
 * Exposed as window.AppOffline (no module system; loaded via <script>).
 */
window.AppOffline = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Functions and constants (stable references) …
  var BASEMAPS, H3_ZOOM_PHASE, H3_ZOOM_STEP, MAX_ZOOM, X_MARK_SVG;
  var baseUrlFor, closeDropdowns, createModal, detailedPlaceName, escapeHtml, ico,
      labelsMode, labelsSupported, modalConfirm, navOpen, rasterLabelsLayer,
      setBasemap, setStatus, syncLabelsConnectivity, t;
  // … and getters for app state that is replaced at runtime (the map is built
  // after this file loads; the base layer is rebuilt on every basemap change).
  var getMap, getBaseLayer, getArcOverlays, getRenderedBasemap;

  function init(ctx) {
    BASEMAPS = ctx.BASEMAPS; H3_ZOOM_PHASE = ctx.H3_ZOOM_PHASE; H3_ZOOM_STEP = ctx.H3_ZOOM_STEP;
    MAX_ZOOM = ctx.MAX_ZOOM; X_MARK_SVG = ctx.X_MARK_SVG;
    baseUrlFor = ctx.baseUrlFor; closeDropdowns = ctx.closeDropdowns; createModal = ctx.createModal;
    detailedPlaceName = ctx.detailedPlaceName; escapeHtml = ctx.escapeHtml; ico = ctx.ico;
    labelsMode = ctx.labelsMode; labelsSupported = ctx.labelsSupported; modalConfirm = ctx.modalConfirm;
    navOpen = ctx.navOpen; rasterLabelsLayer = ctx.rasterLabelsLayer; setBasemap = ctx.setBasemap;
    setStatus = ctx.setStatus; syncLabelsConnectivity = ctx.syncLabelsConnectivity; t = ctx.t;
    getMap = ctx.getMap; getBaseLayer = ctx.getBaseLayer; getArcOverlays = ctx.getArcOverlays;
    getRenderedBasemap = ctx.getRenderedBasemap || function () { return window.GeoState.get("basemap", "voyager"); };
  }

  // Download the basemap + active overlay tiles for a drawn rectangle into a
  // pinned cache (kept until the user deletes it). The SW serves them offline.
  var OFFLINE_TILE_BYTES = 22000;   // rough per-tile size for the estimate
  var OFFLINE_MAX_TILES = 12000;    // guard against an unreasonably huge download
  var offlineMaxZoom = 19;          // max zoom for area downloads — the app's deepest tile zoom (set in Settings)
  var offlineFramesLayer = null;    // frames showing downloaded areas
  var offlineEditing = false;       // true while the "Manage offline maps" modal is open
  // Open the "Manage offline maps" list modal (from Settings, or a long-press on the
  // map-download button). Shared so both entry points behave identically.
  function openOfflineManager() {
    var m = document.getElementById("offline-modal"); if (!m) return;
    closeDropdowns();
    offlineEditing = true;            // bold frames + on-map "×" delete handles
    renderOfflineAreas();             // also re-renders the frames
    m.style.display = "flex";
    // The list follows the map while the manager is open (areas in view first) —
    // skipped while a re-download writes its progress into a row.
    var follow = function () { if (!document.querySelector("#offline-list .offline-redl.busy")) renderOfflineAreas(); };
    if (getMap()) getMap().on("moveend", follow);
    navOpen("offline", function () {
      m.style.display = "none"; offlineEditing = false; renderOfflineFrames();
      if (getMap()) getMap().off("moveend", follow);
    });
  }
  // Distinct border colours so adjacent downloaded areas are easy to tell apart.
  var OFFLINE_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#9a6324", "#e6ab02"];
  function offlineColor(i) { return OFFLINE_COLORS[i % OFFLINE_COLORS.length]; }
  function getOfflineAreas() { return window.GeoState.get("offlineAreas", []) || []; }
  function saveOfflineAreas(a) { window.GeoState.save({ offlineAreas: a }); }
  // Ask the browser to mark our storage PERSISTENT so it isn't evicted under
  // pressure — without this, mobile browsers can clear the cached offline-map
  // tiles after a while, so they stop loading (there is no time-expiry in our
  // code). Best-effort: Chrome grants by heuristic, Firefox prompts; a denial just
  // leaves the default (evictable) state. Called on the strong "download an area"
  // signal and once at startup.
  function ensurePersistentStorage() {
    try {
      if (!(navigator.storage && navigator.storage.persist && navigator.storage.persisted)) return;
      navigator.storage.persisted().then(function (already) { if (!already) navigator.storage.persist().catch(function () {}); }).catch(function () {});
    } catch (e) {}
  }
  function tileRangeFor(bounds, z) {
    var n = Math.pow(2, z);
    var lon2x = function (lon) { return (lon + 180) / 360 * n; };
    var lat2y = function (lat) { var r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; };
    var clamp = function (v) { return Math.max(0, Math.min(n - 1, Math.floor(v))); };
    return { xMin: clamp(lon2x(bounds.getWest())), xMax: clamp(lon2x(bounds.getEast())),
             yMin: clamp(lat2y(bounds.getNorth())), yMax: clamp(lat2y(bounds.getSouth())) };
  }
  function activeOverlayLayers() {
    return (getArcOverlays() || []).filter(function (o) {
      return o.layer && o.layer._base && getMap().hasLayer(o.layer);
    }).map(function (o) { return o.layer; });
  }
  function offlineLayers() {
    var arr = [getBaseLayer()].concat(activeOverlayLayers());
    // Labels: the live overlay may be vector (MapLibre), whose tiles can't be cached.
    // Cache the aligned raster labels instead so names show offline for any label-
    // capable basemap, in both "on" and "more" modes. (With labels active the CARTO
    // base is already the labels-FREE variant, so no duplication.)
    var bm = getRenderedBasemap();   // the map actually drawn — labels must match it
    if (labelsMode() !== "off" && labelsSupported(bm)) arr.push(rasterLabelsLayer(bm));
    return arr.filter(Boolean);
  }
  // Generate the exact tile URL Leaflet would request for (x,y,z) — set the
  // layer's tileZoom so the base layer's getTileUrl uses z, not its live zoom.
  function layerTileUrl(layer, x, y, z) {
    var c = L.point(x, y); c.z = z;
    var prev = layer._tileZoom; layer._tileZoom = z;
    var u = null; try { u = layer.getTileUrl(c); } catch (e) {}
    layer._tileZoom = prev;
    return u;
  }
  // The integer tile zooms the app actually requests = round(zoom-snap steps).
  // zoomSnap is one H3 resolution, so it skips some integers (e.g. 16) — only
  // cache the levels the map will ever ask for, else offline tiles never match.
  // Also cache the zoomed-OUT levels down to here: a handful of tiles per level for any
  // bbox, and without them the map is blank the moment you zoom out past the area's start
  // zoom — which reads as "my downloaded map isn't there" even though it is.
  var OVERVIEW_MIN_Z = 4;
  function offlineZoomLevels(zStart, zMax) {
    var step = window.h3 ? H3_ZOOM_STEP : 1;
    var maxZ = getMap().getMaxZoom(), seen = {}, out = [];
    var lo = Math.min(zStart, OVERVIEW_MIN_Z);
    // Walk the phased H3 ladder (the exact stops the map settles on) so the cached
    // integer tile zooms match what it will actually request.
    for (var m = window.h3 ? H3_ZOOM_PHASE : 0; m <= maxZ + 1e-6; m += step) {
      var tz = Math.round(m);
      if (tz < lo || tz > zMax || seen[tz]) continue;
      seen[tz] = 1; out.push(tz);
    }
    if (!out.length) out.push(zStart);
    return out;
  }
  function offlineTileCount(bounds, zStart, zMax) {
    var n = 0;
    offlineZoomLevels(zStart, zMax).forEach(function (z) { var r = tileRangeFor(bounds, z); n += (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1); });
    return n;
  }
  function buildOfflineUrls(bounds, zStart, zMax, layers) {
    var urls = [];
    offlineZoomLevels(zStart, zMax).forEach(function (z) {
      var r = tileRangeFor(bounds, z);
      for (var x = r.xMin; x <= r.xMax; x++) for (var y = r.yMin; y <= r.yMax; y++) {
        for (var li = 0; li < layers.length; li++) { var u = layerTileUrl(layers[li], x, y, z); if (u) urls.push(u); }
      }
    });
    return urls;
  }
  // Fetch one tile for caching. Cross-origin tiles fetched no-cors come back as
  // *opaque* responses, which browsers pad to a fixed ~7 MB each against the
  // storage quota — a deep area would blow the quota and start failing puts.
  // The tile CDNs send `Access-Control-Allow-Origin: *`, so try a real CORS
  // fetch first (stored at true size) and only fall back to opaque for hosts
  // (some overlays) that don't allow CORS.
  function cacheOneTile(cache, url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw 0;
      return cache.put(url, res);
    }).catch(function () {
      return fetch(url, { mode: "no-cors" }).then(function (res) { return cache.put(url, res); });
    });
  }
  function downloadOfflineArea(bounds, zStart, zMax, layers, name, onProgress, isAborted) {
    var id = "area-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    var urls = buildOfflineUrls(bounds, zStart, zMax, layers);
    var total = urls.length, done = 0, ok = 0;
    function aborted() { return !!(isAborted && isAborted()); }
    return caches.open("pinned-" + id).then(function (cache) {
      return new Promise(function (resolve) {
        var i = 0, active = 0, CONC = 6;
        function pump() {
          if ((i >= urls.length || aborted()) && active === 0) { resolve(); return; }
          while (active < CONC && i < urls.length && !aborted()) {
            var url = urls[i++]; active++;
            cacheOneTile(cache, url).then(function () { ok++; })
              .catch(function () {})
              .then(function () { active--; done++; if (onProgress) onProgress(done, total); pump(); });
          }
        }
        pump();
      });
    }).then(function () {
      if (aborted()) { return caches.delete("pinned-" + id).then(function () { return -1; }); }
      var areas = getOfflineAreas();
      areas.push({ id: id, name: name, basemap: getRenderedBasemap(),
                   labels: labelsMode(),   // so a refill re-fetches the raster labels + the matching base variant
                   bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                   zStart: zStart, zMax: zMax, tiles: ok, bytes: ok * OFFLINE_TILE_BYTES, createdAt: Date.now() });
      saveOfflineAreas(areas);
      return ok;
    });
  }
  function deleteOfflineArea(id) {
    return caches.delete("pinned-" + id).then(function () {
      saveOfflineAreas(getOfflineAreas().filter(function (a) { return a.id !== id; }));
      renderOfflineAreas();
      renderOfflineFrames();
    });
  }
  // Delete EVERY downloaded offline area (pinned caches + records + on-map frames) —
  // used by the Settings "Clear cached data → Offline areas" button.
  function clearAllOfflineAreas() {
    var areas = getOfflineAreas();
    return Promise.all(areas.map(function (a) { return caches.delete("pinned-" + a.id).catch(function () {}); }))
      .then(function () { saveOfflineAreas([]); renderOfflineAreas(); renderOfflineFrames(); });
  }
  // Count of downloaded offline areas + approx bytes (pinned tiles, ~22 KB each).
  function offlineAreaStats() {
    var areas = getOfflineAreas();
    return Promise.all(areas.map(function (a) {
      return caches.open("pinned-" + a.id).then(function (c) { return c.keys(); }).then(function (k) { return k.length; }).catch(function () { return 0; });
    })).then(function (counts) {
      var tiles = counts.reduce(function (s, n) { return s + n; }, 0);
      return { n: areas.length, bytes: tiles * 22000 };
    });
  }
  // A tile layer for an arbitrary basemap (not necessarily the live one), used to
  // rebuild the exact tile URLs when re-downloading a purged area.
  function offlineLayerFor(basemap, labelsModeOverride) {
    var cfg = BASEMAPS[basemap] || BASEMAPS.streets || BASEMAPS[Object.keys(BASEMAPS)[0]];
    return L.tileLayer(baseUrlFor(basemap, labelsModeOverride), { maxZoom: MAX_ZOOM, maxNativeZoom: cfg.maxNativeZoom || MAX_ZOOM, subdomains: cfg.subdomains || "abc", noWrap: true });   // match the base variant used at download (CARTO _nolabels when labels were on)
  }
  // Re-fetch a recorded area's tiles back into its OWN pinned cache (same id), e.g.
  // after the browser evicted them. Rebuilds URLs from the stored bbox/zoom/basemap.
  function refillOfflineArea(area, onProgress, isAborted) {
    var bb = area && area.bbox; if (!bb || bb.length < 4) return Promise.resolve(-1);
    var bounds = L.latLngBounds([[bb[1], bb[0]], [bb[3], bb[2]]]);
    var layers = [offlineLayerFor(area.basemap, area.labels)];
    if (area.labels && area.labels !== "off" && labelsSupported(area.basemap)) layers.push(rasterLabelsLayer(area.basemap));
    var urls = area.boxes ? buildBoxUrls(area.boxes, layers) : buildOfflineUrls(bounds, area.zStart || 0, area.zMax || area.zStart || 0, layers);
    function aborted() { return !!(isAborted && isAborted()); }
    return caches.open("pinned-" + area.id).then(function (cache) {
      return new Promise(function (resolve) {
        var i = 0, active = 0, done = 0, ok = 0, total = urls.length, CONC = 6;
        function pump() {
          if ((i >= urls.length || aborted()) && active === 0) { resolve(ok); return; }
          while (active < CONC && i < urls.length && !aborted()) {
            var url = urls[i++]; active++;
            cacheOneTile(cache, url).then(function () { ok++; }).catch(function () {})
              .then(function () { active--; done++; if (onProgress) onProgress(done, total); pump(); });
          }
        }
        pump();
      });
    }).then(function (ok) {
      if (aborted()) return -1;
      var areas = getOfflineAreas();
      for (var j = 0; j < areas.length; j++) { if (areas[j].id === area.id) { areas[j].tiles = ok; areas[j].bytes = ok * OFFLINE_TILE_BYTES; break; } }
      saveOfflineAreas(areas);
      return ok;
    });
  }
  // Detect recorded areas whose tile cache is gone/empty (evicted by the browser):
  // the localStorage metadata can survive while CacheStorage is purged.
  function checkPurgedOfflineAreas() {
    var areas = getOfflineAreas();
    if (!areas.length || !window.caches) return Promise.resolve([]);
    return Promise.all(areas.map(function (a) {
      if (!(a.tiles > 0)) return Promise.resolve(null);   // nothing was stored → not a purge
      return caches.open("pinned-" + a.id).then(function (c) { return c.keys(); })
        .then(function (keys) { return keys.length === 0 ? a : null; })   // empty cache → purged
        .catch(function () { return a; });                                // cache unreadable/missing → purged
    })).then(function (res) { return res.filter(Boolean); });
  }
  // Re-download a set of purged areas, one at a time, with a status line.
  function redownloadPurgedAreas(areas) {
    ensurePersistentStorage();
    var i = 0;
    (function next() {
      if (i >= areas.length) { setStatus(t("offline.redone")); renderOfflineAreas(); renderOfflineFrames(); return; }
      var a = areas[i++];
      setStatus(t("offline.redownloading", { name: a.name }));
      refillOfflineArea(a, null, function () { return false; }).then(next, next);
    })();
  }
  // Once per session, when online, ask whether to re-download any evicted areas.
  var offlinePurgeCheckDone = false;
  function maybeAskRedownloadOffline() {
    if (offlinePurgeCheckDone || navigator.onLine === false) return;
    offlinePurgeCheckDone = true;
    checkPurgedOfflineAreas().then(function (purged) {
      if (!purged.length) return;
      modalConfirm(t("offline.purgedAsk", { n: purged.length })).then(function (ok) { if (ok) redownloadPurgedAreas(purged); });
    });
  }
  function openAreaDialog(bounds) {
    var layers = offlineLayers();
    // Cap at the app's max tile zoom and the basemap's native max; the chosen
    // depth comes from the Settings "Download max zoom" option.
    var appMaxZoom = Math.round(getMap().getMaxZoom());
    var baseMaxNative = Math.min((getBaseLayer() && getBaseLayer().options.maxNativeZoom) || MAX_ZOOM, appMaxZoom);
    var zStart = Math.max(0, Math.min(baseMaxNative, Math.round(getMap().getZoom())));
    var zMax = Math.max(zStart, Math.min(baseMaxNative, offlineMaxZoom));
    var tiles = offlineTileCount(bounds, zStart, zMax) * layers.length;
    var m = createModal({ boxClass: "area-dl", backdropClose: false });   // no backdrop close mid-download
    var box = m.box, close = m.close;
    // The max-zoom is chosen IN the dialog (the only place it is set; remembered as the default);
    // levels below the current view zoom are pointless and left out.
    var Z_STEPS = [11, 13, 15, 17, 19];
    var zOpts = Z_STEPS.filter(function (z) { return z >= zStart && z <= baseMaxNative; });
    if (!zOpts.length) zOpts = [baseMaxNative];
    var zSel = '<select id="area-zoom">' + zOpts.map(function (z) { return '<option value="' + z + '">' + z + "</option>"; }).join("") + "</select>";
    box.innerHTML =
      '<div class="ui-modal-msg">' + escapeHtml(t("offline.title")) + "</div>" +
      '<div class="area-dl-row">' + escapeHtml(t("offline.maxzoom")) + ": " + zSel + "</div>" +
      '<div class="area-dl-est" id="area-est"></div>' +
      '<input class="ui-modal-input" id="area-name" type="text" placeholder="' + escapeHtml(t("offline.namePh")) + '">' +
      '<div class="area-dl-prog" id="area-prog" style="display:none"></div>' +
      '<div class="ui-modal-btns"><button type="button" class="btn btn-light" id="area-cancel">' + escapeHtml(t("btn.cancel")) + '</button>' +
        '<button type="button" class="btn" id="area-go">' + escapeHtml(t("offline.download")) + "</button></div>";
    var est = box.querySelector("#area-est");
    function refreshEstimate() {
      est.textContent = t("offline.estimate", { n: tiles.toLocaleString(), mb: (tiles * OFFLINE_TILE_BYTES / 1048576).toFixed(tiles * OFFLINE_TILE_BYTES < 10485760 ? 1 : 0) });
      est.classList.toggle("area-dl-warn", tiles > OFFLINE_MAX_TILES);
    }
    refreshEstimate();
    var zoomSel = box.querySelector("#area-zoom");
    // Preselect the closest available level at or below the stored default.
    var pre = zOpts[0];
    zOpts.forEach(function (z) { if (z <= zMax) pre = z; });
    zoomSel.value = String(pre); zMax = pre;
    tiles = offlineTileCount(bounds, zStart, zMax) * layers.length;
    refreshEstimate();
    zoomSel.addEventListener("change", function () {
      zMax = Math.max(zStart, Math.min(baseMaxNative, +this.value || zMax));
      tiles = offlineTileCount(bounds, zStart, zMax) * layers.length;
      refreshEstimate();
      // Remember as the new default for the next download.
      offlineMaxZoom = +this.value || offlineMaxZoom;
      window.GeoState.save({ offlineMaxZoom: offlineMaxZoom });
    });
    // Suggest the most specific place name at the view centre (locality, not
    // country) — unless the user starts typing their own.
    var nameInput = box.querySelector("#area-name");
    nameInput.addEventListener("input", function () { nameInput.dataset.user = "1"; });
    var ctr = bounds.getCenter();
    detailedPlaceName(ctr.lat, ctr.lng).then(function (nm) {
      if (nm && !nameInput.dataset.user && !nameInput.value) nameInput.value = nm;
    });
    var downloading = false, aborted = false;
    // Cancel must always work — before a download it just closes; during one it
    // aborts the in-flight transfer (the button is never disabled).
    box.querySelector("#area-cancel").addEventListener("click", function () {
      if (downloading) aborted = true;
      close();
    });
    box.querySelector("#area-go").addEventListener("click", function () {
      if (tiles > OFFLINE_MAX_TILES) { modalConfirm(t("offline.tooMany", { n: tiles.toLocaleString() })).then(function (okc) { if (okc) run(zMax); }); }
      else run(zMax);
    });
    function run(zMax) {
      ensurePersistentStorage();   // downloading is strong intent — ask to keep it
      var name = (box.querySelector("#area-name").value || "").trim() || (t("offline.area") + " " + (getOfflineAreas().length + 1));
      var prog = box.querySelector("#area-prog"); prog.style.display = "block";
      box.querySelector("#area-go").disabled = true;
      downloading = true;
      downloadOfflineArea(bounds, zStart, zMax, layers, name, function (d, total) {
        prog.textContent = t("offline.downloading", { done: d.toLocaleString(), total: total.toLocaleString() });
      }, function () { return aborted; }).then(function (res) {
        if (aborted) return;
        close(); renderOfflineAreas();
        if (res === 0) setStatus(t("offline.failed", { name: name }));
        else setStatus(t("offline.saved", { name: name }));
      });
    }
  }
  function renderOfflineAreas() {
    var list = document.getElementById("offline-list"); if (!list) return;
    var areas = getOfflineAreas();
    if (!areas.length) { list.innerHTML = '<p class="dd-empty">' + escapeHtml(t("offline.empty")) + "</p>"; return; }
    // Areas overlapping the current map view come first and are marked "in view";
    // the colour key stays tied to the area's position in the saved list.
    var vb = null; try { vb = getMap() && getMap().getBounds(); } catch (e) {}
    function inView(a) {
      return !!(vb && a.bbox && a.bbox[0] <= vb.getEast() && a.bbox[2] >= vb.getWest() && a.bbox[1] <= vb.getNorth() && a.bbox[3] >= vb.getSouth());
    }
    var rows = areas.map(function (a, i) { return { a: a, i: i, here: inView(a) }; });
    rows.sort(function (x, y) { return (y.here - x.here) || (x.i - y.i); });
    list.innerHTML = rows.map(function (r) {
      var a = r.a, i = r.i;
      var mb = (a.bytes / 1048576).toFixed(a.bytes < 10485760 ? 1 : 0);
      // Two lines per area: name (with the colour key) on top, tiles · size · zoom range
      // below, so long names get the panel's width; ⟳ / × sit at the right edge.
      // The name is a button: tap to show the area on the map (switching basemap if needed).
      return '<div class="offline-row' + (r.here ? " offline-row-here" : "") + '" data-id="' + escapeHtml(a.id) + '"><span class="offline-sw" style="background:' + offlineColor(i) + '"></span>' +
        '<button type="button" class="offline-name offline-show" data-id="' + escapeHtml(a.id) + '" title="' + escapeHtml(t("offline.show")) + '">' + escapeHtml(a.name) +
        '<span class="offline-purged" title="' + escapeHtml(t("offline.purged")) + '" style="display:none">⚠</span></button>' +
        '<span class="offline-meta">' + (r.here ? '<span class="offline-here">' + escapeHtml(t("offline.inView")) + "</span> · " : "") + a.tiles.toLocaleString() + " · ~" + mb + " MB · z" + a.zStart + "–" + a.zMax + "</span>" +
        '<button type="button" class="offline-redl ico-btn" data-id="' + escapeHtml(a.id) + '" title="' + escapeHtml(t("offline.redownload")) + '" aria-label="' + escapeHtml(t("offline.redownload")) + '">' + ico("refresh") + "</button>" +
        '<button type="button" class="dd-del offline-del" data-id="' + escapeHtml(a.id) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button></div>';
    }).join("");
    list.querySelectorAll(".offline-del").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-id"), a = getOfflineAreas().filter(function (x) { return x.id === id; })[0];
        modalConfirm(t("offline.deletePrompt", { name: a ? a.name : "" })).then(function (ok) { if (ok) deleteOfflineArea(id); });
      });
    });
    list.querySelectorAll(".offline-show").forEach(function (b) {
      b.addEventListener("click", function () { var a = getOfflineAreas().filter(function (x) { return x.id === b.getAttribute("data-id"); })[0]; if (a) showOfflineArea(a); });
    });
    list.querySelectorAll(".offline-redl").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-id"), a = getOfflineAreas().filter(function (x) { return x.id === id; })[0];
        if (!a) return;
        if (navigator.onLine === false) { setStatus(t("offline.failed", { name: a.name })); return; }
        ensurePersistentStorage();
        var btn = this; btn.disabled = true; btn.classList.add("busy");
        var meta = btn.parentNode.querySelector(".offline-meta");
        refillOfflineArea(a, function (d, total) { if (meta) meta.textContent = d.toLocaleString() + " / " + total.toLocaleString(); }, function () { return false; })
          .then(function (ok) { setStatus(ok > 0 ? t("offline.saved", { name: a.name }) : t("offline.failed", { name: a.name })); renderOfflineAreas(); },
                function () { setStatus(t("offline.failed", { name: a.name })); renderOfflineAreas(); });
      });
    });
    // Flag any area whose tiles the browser has purged (async cache check).
    checkPurgedOfflineAreas().then(function (purged) {
      purged.forEach(function (a) {
        var row = list.querySelector('.offline-row[data-id="' + a.id + '"]');
        if (row) { row.classList.add("offline-row-purged"); var w = row.querySelector(".offline-purged"); if (w) w.style.display = ""; }
      });
    });
    renderOfflineFrames();
  }
  // Show a downloaded area: its basemap (if different) and the map fitted to its frame.
  function showOfflineArea(a) {
    if (!getMap() || !a.bbox) return;
    if (a.basemap && a.basemap !== getRenderedBasemap()) setBasemap(a.basemap);
    try { getMap().fitBounds([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]], { maxZoom: a.zMax }); } catch (e) {}
  }
  // Coloured frames on the map marking the downloaded areas. Subtle normally;
  // while the "Manage offline maps" modal is open they're bold + each carries a
  // tappable "×" at its top-right corner for direct deletion.
  function renderOfflineFrames() {
    if (!getMap() || !L.rectangle) return;
    if (!offlineFramesLayer) offlineFramesLayer = L.layerGroup().addTo(getMap());
    offlineFramesLayer.clearLayers();
    getOfflineAreas().forEach(function (a, i) {
      if (!a.bbox) return;
      var col = offlineColor(i);
      areaBoxes(a).forEach(function (b) {   // a poor-coverage area is several small boxes
        L.rectangle([[b[1], b[0]], [b[3], b[2]]], offlineEditing
          ? { className: "offline-frame", color: col, weight: 2.5, opacity: 0.95, fillColor: col, fillOpacity: 0.1, interactive: false }
          : { className: "offline-frame", color: col, weight: 1, opacity: 0.2, dashArray: "3 6", fill: false, interactive: false }).addTo(offlineFramesLayer);
      });
      if (offlineEditing) {
        var del = L.marker([a.bbox[3], a.bbox[2]], {   // NE corner (N lat, E lon)
          icon: L.divIcon({ className: "offline-x", html: X_MARK_SVG, iconSize: [22, 22], iconAnchor: [11, 11] }),
          interactive: true, keyboard: false, title: t("offline.delete"),
        });
        del.on("click", (function (area) {
          return function (ev) {
            if (ev && ev.originalEvent) L.DomEvent.stop(ev.originalEvent);
            modalConfirm(t("offline.deletePrompt", { name: area.name })).then(function (ok) { if (ok) deleteOfflineArea(area.id); });
          };
        })(a));
        del.addTo(offlineFramesLayer);
      }
    });
  }
  // When offline and the current view has no cached tiles, but a downloaded
  // area covers this spot, offer to switch to one of those cached maps.
  var offlinePromptBusy = false, offlineCheckTimer = null;
  // Downloaded areas covering the map centre that use a given basemap.
  function coveringAreas(basemap) {
    if (!getMap()) return [];
    var c = getMap().getCenter();
    return getOfflineAreas().filter(function (a) {
      return a.bbox && (basemap == null || (a.basemap || "light") === basemap) &&
        areaBoxes(a).some(function (b) { return c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3]; });
    });
  }
  // An area's boxes [w, s, e, n, zMax]: its bbox, or the cells of a poor-coverage download.
  function areaBoxes(a) { return a.boxes || [a.bbox.concat([a.zMax])]; }
  // When offline inside a downloaded area, cap the basemap's native zoom to the
  // deepest cached level so Leaflet upscales those tiles (smooth/pixelated zoom)
  // instead of requesting missing deep tiles and leaving broken holes. Restored
  // to the layer's real native max when online or outside any download.
  var offlineTilesFailing = false;   // tiles erroring despite navigator.onLine (dead/captive connection)
  // Re-request a tile layer's tiles after its zoom cap changed. NOT layer.redraw():
  // Leaflet's redraw sets `_tileZoom = _clampZoom(map.getZoom())` WITHOUT rounding, and
  // this app snaps zoom to the fractional H3 ladder — so redraw left a fractional tile
  // zoom and every tile URL came out as ".../12.313357887945102/x/y.png", which no tile
  // server and no offline cache can answer: the base map went blank the moment the cap
  // changed (i.e. the moment you went offline). _resetView takes Leaflet's normal path,
  // which rounds the zoom before clamping it.
  function redrawTiles(layer) {
    if (!layer || !layer._map) return;
    try { layer._removeAllTiles(); layer._resetView(); }
    catch (e) { try { layer.redraw(); } catch (e2) {} }
  }
  function refreshOfflineZoomCap() {
    if (!getBaseLayer()) return;
    var cap = getBaseLayer()._origMaxNative || MAX_ZOOM;
    if (!navigator.onLine || offlineTilesFailing) {
      var here = coveringAreas(getRenderedBasemap());
      if (here.length) cap = here.reduce(function (m, a) { return Math.max(m, a.zMax || 0); }, 0);
    }
    // ALWAYS an integer: a fractional maxNativeZoom (an area saved at a fractional map zoom)
    // became a fractional tile zoom in every tile URL — "…/cyclosm/2.487615…/2/2.png" — so not
    // one tile loaded and the map stayed blank for good (measured 2026-10-01 on the RC profile).
    cap = Math.max(1, Math.floor(+cap || MAX_ZOOM));
    if (getBaseLayer().options.maxNativeZoom !== cap) {
      getBaseLayer().options.maxNativeZoom = cap;
      redrawTiles(getBaseLayer());
    }
    syncLabelsConnectivity();   // flip labels vector↔raster if connectivity changed (guarded: no-op otherwise)
  }
  function scheduleOfflineCheck() {
    refreshOfflineZoomCap();   // immediate: upscale cached tiles rather than fetch missing ones
    if (navigator.onLine) return;
    clearTimeout(offlineCheckTimer);
    offlineCheckTimer = setTimeout(checkOfflineCoverage, 600);
  }
  function checkOfflineCoverage() {
    if (navigator.onLine || offlinePromptBusy || !getMap() || !window.caches) return;
    var covering = coveringAreas(null);
    if (!covering.length) return;
    var curBase = getRenderedBasemap();
    // The current basemap is downloaded here → its tiles upscale (handled by the
    // zoom cap); don't interrupt with a prompt. Only offer a switch when *only*
    // a different basemap covers this view.
    if (covering.some(function (a) { return (a.basemap || "light") === curBase; })) return;
    promptOfflineAreas(covering, curBase);
  }
  function promptOfflineAreas(areas, curBase) {
    offlinePromptBusy = true;
    var m = createModal({ onClose: function () { offlinePromptBusy = false; } });
    var box = m.box, close = m.close;
    box.innerHTML = '<div class="ui-modal-msg">' + escapeHtml(t("offline.coverPrompt")) + "</div>" +
      '<div class="offline-pick">' + areas.map(function (a) {
        var bm = a.basemap && a.basemap !== curBase ? " (" + escapeHtml(t("basemap." + a.basemap) || a.basemap) + ")" : "";
        return '<button type="button" class="btn offline-pick-btn" data-id="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + bm + "</button>";
      }).join("") + "</div>" +
      '<div class="ui-modal-btns"><button type="button" class="btn btn-light" id="offc-cancel">' + escapeHtml(t("btn.cancel")) + "</button></div>";
    box.querySelector("#offc-cancel").addEventListener("click", close);
    box.querySelectorAll(".offline-pick-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var a = getOfflineAreas().filter(function (x) { return x.id === this.getAttribute("data-id"); }.bind(this))[0];
        close();
        if (a) showOfflineArea(a);
      });
    });
  }

  // ---- Poor-coverage spots ---------------------------------------------------
  // Owner (2026-11-22): log where map tiles failed to load and, later on a working
  // connection, offer to download those spots — coverage there is bad, so they are
  // better cached. A failed base tile is logged as a cell — its ancestor tile at
  // z ≤ 13 and at most 4 levels up, so one cell costs a few hundred tiles — with the
  // deepest zoom that failed there. GeoState "tileGaps" (this device's own, never
  // synced): { "cz/x/y": [zoom, time] }.
  var GAP_CELL_Z = 13, GAP_DEPTH = 4, GAP_MAX = 300, GAP_CALM_MS = 10000;
  var lastTileErr = 0, gapTimer = null, gapAskedN = 0;
  function getGaps() { return window.GeoState.get("tileGaps", {}) || {}; }
  function noteTileGap(c) {
    lastTileErr = Date.now();
    if (!c || !(c.z >= 0)) return;
    var z = Math.round(c.z), cz = Math.max(Math.min(z, GAP_CELL_Z), z - GAP_DEPTH), k = Math.pow(2, z - cz);
    var key = cz + "/" + Math.floor(c.x / k) + "/" + Math.floor(c.y / k), g = getGaps();
    if (g[key] && g[key][0] >= z) return;   // known: no write
    g[key] = [z, Date.now()];
    var keys = Object.keys(g);
    if (keys.length > GAP_MAX) keys.sort(function (a, b) { return g[a][1] - g[b][1]; }).slice(0, keys.length - GAP_MAX).forEach(function (o) { delete g[o]; });
    window.GeoState.save({ tileGaps: g });
  }
  function gapBox(key, z) {
    var p = key.split("/"), n = Math.pow(2, +p[0]), x = +p[1], y = +p[2];
    function lat(t) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI; }
    return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y), z];
  }
  // The logged cells not already inside a downloaded area of this basemap (deep enough),
  // each as a box down to its failed zoom (capped at the basemap's native max).
  function pendingGaps() {
    var g = getGaps(), bm = getRenderedBasemap(), have = getOfflineAreas().filter(function (a) { return a.bbox && (a.basemap || "light") === bm; });
    var cap = Math.min((getBaseLayer() && getBaseLayer()._origMaxNative) || MAX_ZOOM, Math.round(getMap().getMaxZoom()));
    return Object.keys(g).map(function (key) { return { key: key, box: gapBox(key, Math.min(g[key][0], cap)) }; }).filter(function (o) {
      var b = o.box, lng = (b[0] + b[2]) / 2, la = (b[1] + b[3]) / 2;
      return !have.some(function (a) { return areaBoxes(a).some(function (h) { return h[4] >= b[4] && lng >= h[0] && lng <= h[2] && la >= h[1] && la <= h[3]; }); });
    });
  }
  function buildBoxUrls(boxes, layers) {
    var seen = {}, out = [];
    boxes.forEach(function (b) {
      buildOfflineUrls(L.latLngBounds([[b[1], b[0]], [b[3], b[2]]]), b[4], b[4], layers).forEach(function (u) { if (!seen[u]) { seen[u] = 1; out.push(u); } });
    });
    return out;
  }
  // Called at start, on "online" and when tiles load again after failing: once the
  // tiles have loaded for GAP_CALM_MS without an error, ask (again only when new spots
  // were logged since). Later / × = ask next time; Forget clears the log.
  function offerGaps() {
    clearTimeout(gapTimer);
    gapTimer = setTimeout(function () {
      if (navigator.onLine === false || offlineTilesFailing || !getMap() || !window.caches) return;
      if (Date.now() - lastTileErr < GAP_CALM_MS || document.querySelector(".ui-modal-overlay")) { offerGaps(); return; }
      var gaps = pendingGaps(); if (!gaps.length || gaps.length <= gapAskedN) return;
      gapAskedN = gaps.length;
      var mb = buildBoxUrls(gaps.map(function (o) { return o.box; }), offlineLayers()).length * OFFLINE_TILE_BYTES / 1048576;
      var m = createModal({ backdropClose: false }), box = m.box, close = m.close;
      box.innerHTML = '<div class="ui-modal-msg">' + escapeHtml(t("offline.gapAsk", { n: gaps.length, mb: mb.toFixed(mb < 10 ? 1 : 0) })) + "</div>" +
        '<div class="ui-modal-btns"><button type="button" class="btn btn-light" id="gap-forget">' + escapeHtml(t("offline.gapForget")) + "</button>" +
        '<button type="button" class="btn btn-light" id="gap-later">' + escapeHtml(t("offline.gapLater")) + "</button>" +
        '<button type="button" class="btn" id="gap-go">' + escapeHtml(t("offline.download")) + "</button></div>";
      box.querySelector("#gap-later").addEventListener("click", close);
      box.querySelector("#gap-forget").addEventListener("click", function () { close(); window.GeoState.save({ tileGaps: {} }); gapAskedN = 0; });
      box.querySelector("#gap-go").addEventListener("click", function () { close(); downloadGaps(gaps); });
    }, GAP_CALM_MS);
  }
  // One offline area holding every cell (listed, framed, refilled and deleted like any other).
  function downloadGaps(gaps) {
    ensurePersistentStorage();
    var boxes = gaps.map(function (o) { return o.box; });
    var bb = boxes.reduce(function (u, b) { return [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])]; }, [180, 90, -180, -90]);
    var a = { id: "area-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: t("offline.gapName") + " " + new Date().toLocaleDateString(),
              basemap: getRenderedBasemap(), labels: labelsMode(), bbox: bb, boxes: boxes,
              zStart: Math.min.apply(null, boxes.map(function (b) { return b[4]; })), zMax: Math.max.apply(null, boxes.map(function (b) { return b[4]; })),
              tiles: 0, bytes: 0, createdAt: Date.now() };
    saveOfflineAreas(getOfflineAreas().concat([a]));
    refillOfflineArea(a, function (d, total) { setStatus(t("offline.downloading", { done: d.toLocaleString(), total: total.toLocaleString() })); }, function () { return false; })
      .then(function (ok) {
        if (ok > 0) {
          var g = getGaps(); gaps.forEach(function (o) { delete g[o.key]; }); window.GeoState.save({ tileGaps: g });
          gapAskedN = 0; setStatus(t("offline.saved", { name: a.name }));
        } else { deleteOfflineArea(a.id); setStatus(t("offline.failed", { name: a.name })); }
        renderOfflineAreas(); renderOfflineFrames();
      });
  }
  window.addEventListener("online", function () { offerGaps(); });

  return {
    init: init,
    openOfflineManager: openOfflineManager,
    openAreaDialog: openAreaDialog,
    renderOfflineAreas: renderOfflineAreas,
    clearAllAreas: clearAllOfflineAreas,
    areaStats: offlineAreaStats,
    offlineLayers: offlineLayers,
    scheduleOfflineCheck: scheduleOfflineCheck,
    refreshOfflineZoomCap: refreshOfflineZoomCap,
    maybeAskRedownloadOffline: maybeAskRedownloadOffline,
    ensurePersistentStorage: ensurePersistentStorage,
    // deepest zoom an area download goes to (a Settings slider owns the value)
    maxZoom: function () { return offlineMaxZoom; },
    setMaxZoom: function (v) { offlineMaxZoom = v; },
    // the basemap is erroring out → the app treats itself as offline
    tilesFailing: function () { return offlineTilesFailing; },
    redrawTiles: redrawTiles,   // rounding-safe re-request (layer.redraw() leaves a fractional tile zoom under zoomSnap 0)
    setTilesFailing: function (v) { offlineTilesFailing = v; },
    noteTileGap: noteTileGap,   // a base tile failed (Leaflet's tileerror coords)
    offerGaps: offerGaps,       // tiles load again / app start: offer the logged poor-coverage spots
  };
})();
