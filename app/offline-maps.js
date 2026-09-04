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
  var getMap, getBaseLayer, getArcOverlays;

  function init(ctx) {
    BASEMAPS = ctx.BASEMAPS; H3_ZOOM_PHASE = ctx.H3_ZOOM_PHASE; H3_ZOOM_STEP = ctx.H3_ZOOM_STEP;
    MAX_ZOOM = ctx.MAX_ZOOM; X_MARK_SVG = ctx.X_MARK_SVG;
    baseUrlFor = ctx.baseUrlFor; closeDropdowns = ctx.closeDropdowns; createModal = ctx.createModal;
    detailedPlaceName = ctx.detailedPlaceName; escapeHtml = ctx.escapeHtml; ico = ctx.ico;
    labelsMode = ctx.labelsMode; labelsSupported = ctx.labelsSupported; modalConfirm = ctx.modalConfirm;
    navOpen = ctx.navOpen; rasterLabelsLayer = ctx.rasterLabelsLayer; setBasemap = ctx.setBasemap;
    setStatus = ctx.setStatus; syncLabelsConnectivity = ctx.syncLabelsConnectivity; t = ctx.t;
    getMap = ctx.getMap; getBaseLayer = ctx.getBaseLayer; getArcOverlays = ctx.getArcOverlays;
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
    navOpen("offline", function () { m.style.display = "none"; offlineEditing = false; renderOfflineFrames(); });
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
    var bm = window.GeoState.get("basemap", "voyager");
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
  function offlineZoomLevels(zStart, zMax) {
    var step = window.h3 ? H3_ZOOM_STEP : 1;
    var maxZ = getMap().getMaxZoom(), seen = {}, out = [];
    // Walk the phased H3 ladder (the exact stops the map settles on) so the cached
    // integer tile zooms match what it will actually request.
    for (var m = window.h3 ? H3_ZOOM_PHASE : 0; m <= maxZ + 1e-6; m += step) {
      var tz = Math.round(m);
      if (tz < zStart || tz > zMax || seen[tz]) continue;
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
      areas.push({ id: id, name: name, basemap: window.GeoState.get("basemap", "voyager"),
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
    var urls = buildOfflineUrls(bounds, area.zStart || 0, area.zMax || area.zStart || 0, layers);
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
    // The max-zoom is chosen IN the dialog (same ladder as the Settings option);
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
      // Remember as the new default (kept in sync with the Settings option).
      offlineMaxZoom = +this.value || offlineMaxZoom;
      window.GeoState.save({ offlineMaxZoom: offlineMaxZoom });
      var oz = document.getElementById("offline-zoom"); if (oz) oz.value = String(offlineMaxZoom);
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
    list.innerHTML = areas.map(function (a, i) {
      var mb = (a.bytes / 1048576).toFixed(a.bytes < 10485760 ? 1 : 0);
      return '<div class="offline-row" data-id="' + escapeHtml(a.id) + '"><span class="offline-sw" style="background:' + offlineColor(i) + '"></span><span class="offline-name" title="z' + a.zStart + "–" + a.zMax + '">' + escapeHtml(a.name) +
        '<span class="offline-purged" title="' + escapeHtml(t("offline.purged")) + '" style="display:none">⚠</span></span>' +
        '<span class="offline-meta">' + a.tiles.toLocaleString() + " · ~" + mb + " MB</span>" +
        '<button type="button" class="offline-redl ico-btn" data-id="' + escapeHtml(a.id) + '" title="' + escapeHtml(t("offline.redownload")) + '" aria-label="' + escapeHtml(t("offline.redownload")) + '">' + ico("refresh") + "</button>" +
        '<button type="button" class="dd-del offline-del" data-id="' + escapeHtml(a.id) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button></div>';
    }).join("");
    list.querySelectorAll(".offline-del").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-id"), a = getOfflineAreas().filter(function (x) { return x.id === id; })[0];
        modalConfirm(t("offline.deletePrompt", { name: a ? a.name : "" })).then(function (ok) { if (ok) deleteOfflineArea(id); });
      });
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
      var rect = L.rectangle([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]], offlineEditing
        ? { className: "offline-frame", color: col, weight: 2.5, opacity: 0.95, fillColor: col, fillOpacity: 0.1, interactive: false }
        : { className: "offline-frame", color: col, weight: 1, opacity: 0.2, dashArray: "3 6", fill: false, interactive: false });
      rect.addTo(offlineFramesLayer);
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
        c.lng >= a.bbox[0] && c.lng <= a.bbox[2] && c.lat >= a.bbox[1] && c.lat <= a.bbox[3];
    });
  }
  // When offline inside a downloaded area, cap the basemap's native zoom to the
  // deepest cached level so Leaflet upscales those tiles (smooth/pixelated zoom)
  // instead of requesting missing deep tiles and leaving broken holes. Restored
  // to the layer's real native max when online or outside any download.
  var offlineTilesFailing = false;   // tiles erroring despite navigator.onLine (dead/captive connection)
  function refreshOfflineZoomCap() {
    if (!getBaseLayer()) return;
    var cap = getBaseLayer()._origMaxNative || MAX_ZOOM;
    if (!navigator.onLine || offlineTilesFailing) {
      var here = coveringAreas(window.GeoState.get("basemap", "voyager"));
      if (here.length) cap = here.reduce(function (m, a) { return Math.max(m, a.zMax || 0); }, 0);
    }
    if (getBaseLayer().options.maxNativeZoom !== cap) {
      getBaseLayer().options.maxNativeZoom = cap;
      getBaseLayer().redraw();
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
    var curBase = window.GeoState.get("basemap", "voyager");
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
        if (!a) return;
        if (a.basemap && a.basemap !== window.GeoState.get("basemap", "voyager")) setBasemap(a.basemap);
        try { getMap().fitBounds([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]], { maxZoom: a.zMax }); } catch (e) {}
      });
    });
  }

  return {
    init: init,
    openOfflineManager: openOfflineManager,
    openAreaDialog: openAreaDialog,
    renderOfflineAreas: renderOfflineAreas,
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
    setTilesFailing: function (v) { offlineTilesFailing = v; },
  };
})();
