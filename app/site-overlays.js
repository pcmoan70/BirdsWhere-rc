/**
 * Map site overlays — the three "where to go birding" layers.
 *
 * Lifted out of app.js byte-for-byte (v1263):
 *   Birding spots  – OSM bird hides / towers / viewpoints via Overpass, with the
 *                    pre-tiled index under birding-spots/, the spots pane and the
 *                    marker fan for overlapping spots.
 *   Best sites     – the GBIF hotspots dataset under best-sites/ (multi-level
 *                    quadtree tiles), week ranking + smoothing, the site cards
 *                    and their three year-charts.
 *   eBird hotspots – the live eBird hotspot layer with its persisted store.
 * Plus the shared bits these use: overpassPost (mirror fallback), the popup
 * title fitter, and the AI-model week-curves chart for map-click/site popups.
 *
 * app.js still owns the map and everything around it, and injects what this
 * module needs through init() — the injected names are the SAME identifiers the
 * code used inside the monolith, so the bodies below are unchanged.
 *
 * Exposed as window.AppSites (no module system; loaded via <script>).
 */
window.AppSites = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Functions and constants (stable references) …
  var BIRD_SPOTS_ATTR, EBIRD_HS_ATTR, SCRIPT_BASE;
  var addToRoute, detailedPlaceName, ebirdKey, escapeHtml, fitNearbyNames, haversineKm,
      ico, makePopupBtn, navigatePoints, openExternal, openPointEditor, overlayLoadStatus, overlayBusy,
      runInference, setStatus, showLocPointMenu, t, tLabel, weekOfToday, getWeek;
  // … and accessors for app state that is replaced at runtime (the map is built
  // after this file loads; the hotspot layer is app.js's; the click guard is a
  // timestamp app.js re-arms all over).
  var getMap, getHotspotsLayer, setMapClickGuard;

  function init(ctx) {
    BIRD_SPOTS_ATTR = ctx.BIRD_SPOTS_ATTR; EBIRD_HS_ATTR = ctx.EBIRD_HS_ATTR;
    SCRIPT_BASE = ctx.SCRIPT_BASE;
    addToRoute = ctx.addToRoute; detailedPlaceName = ctx.detailedPlaceName;
    ebirdKey = ctx.ebirdKey; navigatePoints = ctx.navigatePoints; escapeHtml = ctx.escapeHtml;
    fitNearbyNames = ctx.fitNearbyNames; haversineKm = ctx.haversineKm; ico = ctx.ico;
    makePopupBtn = ctx.makePopupBtn; openExternal = ctx.openExternal;
    openPointEditor = ctx.openPointEditor; overlayLoadStatus = ctx.overlayLoadStatus;
    overlayBusy = ctx.overlayBusy;
    runInference = ctx.runInference; setStatus = ctx.setStatus;
    showLocPointMenu = ctx.showLocPointMenu; t = ctx.t; tLabel = ctx.tLabel;
    weekOfToday = ctx.weekOfToday; getWeek = ctx.getWeek;
    getMap = ctx.getMap; getHotspotsLayer = ctx.getHotspotsLayer;
    setMapClickGuard = ctx.setMapClickGuard;
  }

  // Live OSM birding-navigation points: bird hides, observation towers and viewpoints —
  // where to actually stand and watch. Same Overpass pattern as osmProtectedLayer (zoom-
  // gated + debounced so we don't trip the rate limiter). Each is a clickable marker.
  // These are lightweight POINTS, so they load from a fairly low zoom. Bird hides +
  // observation towers are rare enough to query over a wide area; VIEWPOINTS are far
  // denser (a continent-wide query times out), so they're added only once zoomed in.
  // Zoom level FROM which spots are shown (and loaded). User-adjustable via the
  // overlay row's ⚙/long-press. Floor 5: the max-N priority cap keeps wide views
  // legible now (pre-cap the floor was 11 to avoid thousands of markers).
  // Cap on birding spots drawn in the viewport (0 = all): the view's spots
  // compete for the slots by baked-in priority (explicit birding tags → near an
  // eBird hotspot → general towers), so zooming in gradually reveals the rest.
  function birdSpotMax() { var n = +window.GeoState.get("birdSpotMax", 100); return (isFinite(n) && n >= 0) ? n : 100; }
  function birdSpotZoomFrom() {
    var z = Math.round(+window.GeoState.get("birdSpotZoom", 12));   // was 16 — so deep the layer looked broken (on, yet empty)
    return (isFinite(z) && z >= 5 && z <= 17) ? z : 12;
  }
  // White line-glyphs on a teal badge (see .bird-spot-mk) so the spots match the app's
  // marker language: binoculars = bird hide/lookout, a lookout tower = bird-watching
  // tower, an eye = birdwatching viewpoint (incl. eBird-hotspot-validated ones).
  var BIRD_SPOT_SVG = {
    bird_hide:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="15" r="3.6"/><circle cx="17" cy="15" r="3.6"/><path d="M7 11.4V6.5M17 11.4V6.5M7 6.5h3l1 2.6h2l1-2.6h3"/></svg>',
    observation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="3" width="7" height="4" rx="1"/><path d="M9 7L6 21M15 7l3 14"/><path d="M8 12h8M7 16.5h10"/></svg>',
    viewpoint:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>'
  };
  var BIRD_SPOT_KINDS = {
    bird_hide:   { i18n: "birdspot.hide" },
    observation: { i18n: "birdspot.tower" },
    viewpoint:   { i18n: "birdspot.viewpoint" }
  };
  // Bundled spot data (docs/birding-spots/): a pre-built worldwide OSM snapshot
  // (tools/fetch-birding-spots.mjs + tile-birding-spots.mjs), served from our own
  // origin as quadtree tiles of ~equal size. The service worker keeps the index
  // and every visited tile in its persistent DATA cache, so previously seen
  // areas keep working fully offline — no Overpass and no localStorage cache.
  var birdStore = {};                          // osm id → spot, from this session's loaded tiles
  var birdSpotIndex = null, birdSpotIndexReq = null;
  var birdTilesLoaded = Object.create(null);   // tile key → Promise (in flight) | true (merged)
  function loadBirdStore() { return birdStore; }
  // One-time cleanup: drop the old Overpass-era localStorage cache (~hundreds of KB).
  var _oldBirdCache = window.GeoState.get("birdSpots", null);
  if (_oldBirdCache && Object.keys(_oldBirdCache).length) window.GeoState.save({ birdSpots: {}, birdTiles: {} });
  function fetchBirdSpotIndex() {
    if (birdSpotIndex) return Promise.resolve(birdSpotIndex);
    if (!birdSpotIndexReq) birdSpotIndexReq = fetch(new URL("birding-spots/index.json", SCRIPT_BASE).href)
      .then(function (r) { if (!r.ok) throw new Error("index " + r.status); return r.json(); })
      .then(function (j) { birdSpotIndex = j; return j; })
      .catch(function (e) { birdSpotIndexReq = null; throw e; });
    return birdSpotIndexReq;
  }
  function fetchBirdSpotTile(key) {
    if (birdTilesLoaded[key]) return Promise.resolve(birdTilesLoaded[key]);
    // The index's generation date is part of the tile URL, so a regenerated
    // dataset gets FRESH cache entries — the SW's cache-first data cache can
    // never pin a stale tile against a newer index.
    var gen = (birdSpotIndex && birdSpotIndex.generated) ? "?g=" + encodeURIComponent(birdSpotIndex.generated) : "";
    birdTilesLoaded[key] = fetch(new URL("birding-spots/" + key + ".json" + gen, SCRIPT_BASE).href)
      .then(function (r) { if (!r.ok) throw new Error(key + " " + r.status); return r.json(); })
      .then(function (j) { (j.spots || []).forEach(function (s) { birdStore[s.osm] = s; }); birdTilesLoaded[key] = true; })
      .catch(function (e) { delete birdTilesLoaded[key]; throw e; });   // retried on the next pan
    return birdTilesLoaded[key];
  }
  // Settings → Clear cached data → Birding spots: the session store AND the
  // SW-cached tile files (so the next enable re-downloads fresh data).
  function clearBirdSpotCache() {
    birdStore = {}; birdTilesLoaded = Object.create(null); birdSpotIndex = null; birdSpotIndexReq = null;
    if (!window.caches) return Promise.resolve();
    return caches.keys().then(function (names) {
      return Promise.all(names.map(function (nm) {
        return caches.open(nm).then(function (c) {
          return c.keys().then(function (reqs) {
            return Promise.all(reqs.filter(function (rq) { return rq.url.indexOf("/birding-spots/") !== -1; })
              .map(function (rq) { return c.delete(rq); }));
          });
        });
      }));
    }).catch(function () {});
  }
  // Overpass is frequently overloaded on any one host (429/504) or simply hangs, so a
  // single fetch with no timeout would spin forever showing nothing. POST the query to
  // each mirror in turn, each with its own abort timeout; return the first body that
  // comes back, or throw a combined error naming what failed on each host.
  // Only CORS-enabled, full-planet public instances (verified to answer this query and
  // return data within the timeout). overpass.openstreetmap.fr is whitelist-only (403)
  // and overpass.osm.ch returns 0 results outside its region — both were dropped.
  // kumi.systems went unreachable (2026-08) so it was dropped; mail.ru + private.coffee
  // added as CORS-enabled fallbacks (overpass-api.de is fast when up but often 504s).
  // Ordered by measured speed (2026-08-13): mail.ru answers in ~1 s and carries current
  // data; overpass-api.de is fast when up but often 504s under load; private.coffee
  // works but its OSM copy lags months behind — kept as the last resort.
  var OVERPASS_MIRRORS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];
  var overpassPreferred = 0;   // last mirror that ANSWERED this session — tried first next time
  function overpassPost(query, timeoutMs) {
    var errs = [];
    // Sticky ordering: start with the mirror that last succeeded, then the rest in list order.
    var order = [overpassPreferred];
    for (var oi = 0; oi < OVERPASS_MIRRORS.length; oi++) if (oi !== overpassPreferred) order.push(oi);
    function tryOne(i) {
      if (i >= order.length) throw new Error("all Overpass servers failed — " + errs.join(" · "));
      var mi = order[i], url = OVERPASS_MIRRORS[mi], host = url.replace(/^https?:\/\//, "").split("/")[0];
      return window.AppFetch.fetchWithTimeout(url, { method: "POST", body: "data=" + encodeURIComponent(query) }, timeoutMs || 20000)
        .then(function (r) {
          return r.text().then(function (txt) {
            if (!r.ok) throw new Error("HTTP " + r.status + (txt ? " " + String(txt).replace(/\s+/g, " ").trim().slice(0, 120) : ""));
            overpassPreferred = mi;   // this mirror works — lead with it from now on
            return txt;
          });
        })
        .catch(function (err) {
          errs.push(host + ": " + ((err && err.name === "AbortError") ? "timeout" : ((err && err.message) || String(err))));
          return tryOne(i + 1);   // next mirror
        });
    }
    return tryOne(0);
  }
  // Both spot layers (birding spots, eBird hotspots) render in a dedicated pane
  // UNDER the observation dots' SVG (overlayPane, z 400) — so observation dots
  // always draw ON TOP of the spot icons and receive their own clicks; a spot
  // icon only gets the click where no dot covers it.
  function ensureSpotsPane() {
    if (!getMap().getPane("spotsPane")) {
      getMap().createPane("spotsPane");
      getMap().getPane("spotsPane").style.zIndex = 390;
    }
  }
  // ---- Overlapping spot markers fan out on hover ----------------------------
  // Hovering a spot marker (eBird hotspot disc, Best-site dot, birding-spot icon)
  // that overlaps others spreads ALL of them in a ring of clones — in the marker
  // pane, above everything — so each one can be clicked; clicking a clone acts as
  // clicking the marker it stands for. The fan clears on map interaction, Escape,
  // or hovering a free-standing spot. Hover-capable pointers only.
  var spotFanLayer = null, spotFanKey = "";
  var spotFanGraceTs = 0;   // the click that OPENED the fan must not clear it (map click fires right after)
  function clearSpotFan(force) {
    if (force !== true && Date.now() < spotFanGraceTs) return;
    spotFanKey = "";
    if (spotFanLayer) { try { getMap().removeLayer(spotFanLayer); } catch (e) {} spotFanLayer = null; }
  }
  function spotFanGroups() {
    var gs = [];
    if (getHotspotsLayer() && getMap().hasLayer(getHotspotsLayer())) gs.push(getHotspotsLayer());
    if (bestSitesLayerRef && getMap().hasLayer(bestSitesLayerRef)) gs.push(bestSitesLayerRef);
    if (birdSpotsLayerRef && getMap().hasLayer(birdSpotsLayerRef)) gs.push(birdSpotsLayerRef);
    return gs;
  }
  function wireSpotFan(mk) {
    // Hover fans the stack on a PC. Touch has no hover, so a long-press does it there
    // (Leaflet 1.9 turns a touch hold into "contextmenu", which is also the desktop
    // right-click) — otherwise a marker buried under another can never be reached on a
    // phone. A plain tap keeps doing the top marker's own action.
    mk.on("mouseover", function () {
      if (!window.matchMedia || !window.matchMedia("(hover: hover)").matches) return;
      openSpotFan(mk);
    });
    mk.on("contextmenu", function (e) {
      if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);   // not the map's "add point" menu
      setMapClickGuard(Date.now() + 400);
      openSpotFan(mk);
    });
  }
  function openSpotFan(mk) { openSpotFanAt(mk.getLatLng(), 2); }
  // Fan the spot markers around a point. minN = 2 when anchored ON one of the
  // spot markers itself (it is inside the cluster, so 2 = itself + a neighbour);
  // 1 when anchored on an OBSERVATION dot, which sits in a pane ABOVE the spot
  // markers and swallows their clicks — even a single covered symbol needs the
  // fan to be reachable. The fan is sticky: it stays until the next map
  // interaction (pan / zoom / another click) or Escape clears it.
  function openSpotFanAt(latlng, minN) {
    {
      var p0 = getMap().latLngToContainerPoint(latlng);
      var near = [];
      spotFanGroups().forEach(function (g) {
        g.eachLayer(function (m) {
          if (!m.getLatLng || !m.options || !m.options.icon) return;   // markers only (skips e.g. the 500 km cap circle)
          var p = getMap().latLngToContainerPoint(m.getLatLng());
          var dx = p.x - p0.x, dy = p.y - p0.y;
          if (dx * dx + dy * dy <= 22 * 22) near.push(m);
        });
      });
      if (near.length < (minN || 2)) { clearSpotFan(true); return; }
      var key = near.map(function (m) { var ll = m.getLatLng(); return ll.lat.toFixed(5) + "," + ll.lng.toFixed(5); }).sort().join("|");
      if (key === spotFanKey && spotFanLayer) return;   // this cluster is already fanned
      clearSpotFan(true);
      spotFanKey = key;
      spotFanGraceTs = Date.now() + 400;
      spotFanLayer = L.layerGroup();
      var R = Math.max(34, 10 + near.length * 6);   // ring radius grows with the count
      near.forEach(function (m, i) {
        var ang = (2 * Math.PI * i) / near.length - Math.PI / 2;
        var ll = getMap().containerPointToLatLng([p0.x + Math.cos(ang) * R, p0.y + Math.sin(ang) * R]);
        spotFanLayer.addLayer(L.polyline([m.getLatLng(), ll], { color: "#555", weight: 1, dashArray: "2 2", opacity: 0.7, interactive: false }));
        var io = m.options.icon.options;   // clone the original's divIcon look 1:1
        var c = L.marker(ll, {
          icon: L.divIcon({ className: (io.className || "") + " spot-fan-clone", html: io.html, iconSize: io.iconSize, iconAnchor: io.iconAnchor }),
          keyboard: false, zIndexOffset: 3000
        });
        var tip = m.getTooltip && m.getTooltip();
        if (tip) c.bindTooltip(tip.getContent(), { direction: "top", className: "area-tip" });
        else if (m.options.title) c.bindTooltip(escapeHtml(m.options.title), { direction: "top", className: "area-tip" });
        (function (orig) {
          c.on("click", function (e) {
            if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
            setMapClickGuard(Date.now() + 300);
            var oe = e && e.originalEvent;
            clearSpotFan();
            // Act as a click on the covered marker (popup / menu open at ITS spot).
            orig.fire("click", { latlng: orig.getLatLng(), originalEvent: oe });
          });
        })(m);
        spotFanLayer.addLayer(c);
      });
      spotFanLayer.addTo(getMap());
    }
  }
  // "Bird" in a spot name, across the app's languages (+ common cognates), so bird-titled spots
  // are preferred when the viewport cap trims the list. Matched on the lower-cased name; roots are
  // distinctive enough to avoid false hits, and accent-free fallbacks catch diacritic-less names.
  var BIRD_WORD_RE = /(bird|fågel|fagel|fogel|fugl|vogel|oiseau|ornitho|ornitolog|pájaro|pajaro|uccell|ptak|ptač|ptac|ptas|lintu|linnu|paukšč|pauksc|pássaro|passaro)/;
  function hasBirdWord(name) { return !!name && BIRD_WORD_RE.test(String(name).toLowerCase()); }
  function birdingSpotsLayer() {
    var grp = L.layerGroup(), active = false, timer = null, lastGateZoom = null;
    ensureSpotsPane();
    // The popup's info block: labelled lines + Website / OpenStreetMap links, from a stored spot.
    function birdSpotMenuInfo(s) {
      var i = s.info || {}, lines = [], links = [], num = function (v) { return /[a-z'"]/i.test(v) ? v : v + " m"; };
      function ln(key, val) { if (val) lines.push({ label: t("birdspot." + key), value: String(val) }); }
      ln("operator", i.operator); ln("access", i.access); ln("wheelchair", i.wheelchair);
      ln("hours", i.hours); ln("fee", i.fee);
      if (i.height) lines.push({ label: t("birdspot.height"), value: num(i.height) });
      ln("direction", i.direction);
      if (i.ele) lines.push({ label: t("birdspot.elevation"), value: num(i.ele) });
      if (i.desc) lines.push({ label: "", value: i.desc });
      if (i.web) links.push({ label: t("birdspot.website"), url: i.web });
      // OpenStreetMap link: the exact element when we have its id, else just the spot on the map
      // (so even an older cached spot without an id still gets a link).
      links.push({ label: t("birdspot.osm"), url: s.osm ? "https://www.openstreetmap.org/" + s.osm : "https://www.openstreetmap.org/#map=18/" + s.lat + "/" + s.lon });
      return { lines: lines, links: links, noFind: true };   // the spot IS on the map already
    }
    function drawAll() {
      grp.clearLayers();
      if (getMap().getZoom() < birdSpotZoomFrom()) return;   // only shown from the user-set zoom level
      // Only render spots near the current view. The cache can hold thousands (they
      // accumulate as you pan); rebuilding every marker on each pan is what made the
      // overlay feel slow. Off-screen spots aren't visible anyway and are redrawn as
      // the view moves over them.
      var vb = getMap().getBounds().pad(0.1);
      var store = loadBirdStore();
      // Gradual best-first reveal (like the eBird hotspots): the view's spots
      // compete for at most birdSpotMax() slots, ranked by the dataset's baked-in
      // priority — 1 explicitly birding-tagged, 2 validated by eBird-hotspot
      // proximity, 3 (or absent) general observation towers — named spots first
      // within a tier. Zooming in frees slots for the lower tiers.
      var cand = [];
      Object.keys(store).forEach(function (id) {
        var s = store[id]; if (s.lat == null || s.lon == null) return;
        if (!vb.contains([s.lat, s.lon])) return;
        cand.push(s);
      });
      var maxN = birdSpotMax();
      if (maxN && cand.length > maxN) {
        cand.sort(function (a, b) {
          // Prefer spots whose NAME says "bird" in some language (Fågeltorn / Fugletårn / Bird hide …)
          // when trimming to the cap — the clearest signal a spot is actually about birds.
          var wa = hasBirdWord(a.name), wb = hasBirdWord(b.name);
          if (wa !== wb) return wa ? -1 : 1;
          var pa = a.p || 3, pb = b.p || 3;
          if (pa !== pb) return pa - pb;
          if (!a.name !== !b.name) return a.name ? -1 : 1;
          return String(a.osm || "").localeCompare(String(b.osm || ""));   // stable across redraws
        });
        cand.length = maxN;
      }
      cand.forEach(function (s) {
        var kind = BIRD_SPOT_KINDS[s.kind] ? s.kind : "bird_hide";
        var typeLbl = t(BIRD_SPOT_KINDS[kind].i18n), svg = BIRD_SPOT_SVG[kind];
        var nm = s.name || typeLbl;
        var mk = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "bird-spot-mk bird-spot-" + kind, html: svg, iconSize: [20, 20], iconAnchor: [10, 10] }), title: nm, pane: "spotsPane" });
        // Click → the location menu (title + type/coords, then find · add point · route),
        // the same menu a place-name opens elsewhere. Observation dots draw ABOVE
        // this icon (spotsPane) and take their own clicks, so no interception here.
        (function (lat, lon, name, tLbl, spot) {
          mk.on("click", function (e) {
            if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
            setMapClickGuard(Date.now() + 300);   // don't let the map click dismiss the menu
            var oe = e && e.originalEvent, sx = oe ? oe.clientX : 0, sy = oe ? oe.clientY : 0;
            showLocPointMenu(lat, lon, name, sx, sy, tLbl + " · " + lat.toFixed(5) + ", " + lon.toFixed(5), birdSpotMenuInfo(spot));
          });
        })(s.lat, s.lon, nm, typeLbl, s);
        wireSpotFan(mk);   // overlapping spot markers fan out on hover
        grp.addLayer(mk);
      });
    }
    // Load the bundled quadtree tiles intersecting the view: an index-bounds test
    // picks them, each is fetched once per session (the SW keeps it for offline),
    // and a failed tile simply retries on the next pan.
    function load(fromAdd) {
      if (!active) return;
      drawAll();   // show whatever's already loaded immediately
      if (getMap().getZoom() < birdSpotZoomFrom()) {   // too zoomed out to show
        // Tell the user WHY nothing shows — on enable, and again whenever the zoom
        // changes while still below the reveal level (panning alone stays quiet).
        var gz = Math.round(getMap().getZoom());
        if (fromAdd || gz !== lastGateZoom) setStatus(t("birdspot.zoomIn", { n: Object.keys(birdStore).length }));
        lastGateZoom = gz;
        return;
      }
      lastGateZoom = null;
      fetchBirdSpotIndex().then(function (idx) {
        if (!active) return;
        var b = getMap().getBounds().pad(0.3), pend = [];
        Object.keys(idx.tiles || {}).forEach(function (k) {
          var tb = idx.tiles[k];   // [lat0, lon0, dLat, dLon, n]
          if (birdTilesLoaded[k] !== true &&
              b.getSouth() < tb[0] + tb[2] && b.getNorth() > tb[0] &&
              b.getWest() < tb[1] + tb[3] && b.getEast() > tb[1]) pend.push(k);
        });
        if (!pend.length) return;
        // Loading feedback is the BLINKING overlay button / panel row only —
        // the status line speaks only on failure.
        overlayBusy(t("layer.birdSpots"), true);
        var bad = 0;
        return Promise.all(pend.map(function (k) { return fetchBirdSpotTile(k).catch(function () { bad++; }); }))
          .then(function () {
            overlayBusy(t("layer.birdSpots"), false);
            if (!active) return;
            drawAll();
            if (bad) setStatus(t("birdspot.loadFail", { err: bad + "/" + pend.length }), true);
          });
      }).catch(function (err) {
        overlayBusy(t("layer.birdSpots"), false);
        if (active) setStatus(t("birdspot.loadFail", { err: (err && err.message) ? String(err.message) : String(err) }), true);
      });
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(load, 500); }
    grp._reload = function () { if (active) drawAll(); };   // max-N setting change → re-rank, no refetch
    grp.on("add", function () { active = true; getMap().attributionControl.addAttribution(BIRD_SPOTS_ATTR); load(true); });
    grp.on("remove", function () { active = false; clearTimeout(timer); getMap().attributionControl.removeAttribution(BIRD_SPOTS_ATTR); });
    getMap().on("moveend", function () { if (active) schedule(); });
    birdSpotsLayerRef = grp;
    return grp;
  }
  var birdSpotsLayerRef = null;   // the live birding-spots layer (settings re-rank hook)

  // ---- "Best sites" overlay (weekly GBIF site ranking) -----------------------
  // Bundled data (docs/best-sites/): ~99k European birding sites derived from GBIF
  // occurrences 2010–2026 (the Artsdata pipeline), each carrying its FULL 53-week
  // profile — species-per-visit + visits per ISO week — packaged as quadtree tiles
  // by tools/tile-best-sites.py. The sites come at THREE clustering radii
  // (index.levelsM = 500 m spots · 3 km areas · 25 km regions), each with its own
  // tile set, so only the level being shown is downloaded. The SW keeps the index
  // and every visited tile in its persistent DATA cache (offline, like birding
  // spots). Blue count dots show species-per-visit for the CURRENT model week;
  // clicking a dot opens the site's year profile chart.
  function bestSiteMax() { var n = +window.GeoState.get("bestSiteMax", 50); return (isFinite(n) && n >= 0) ? n : 50; }
  // What the number in a dot means: 0 = species per VISIT that week (the average a
  // visitor logs), 1 = how many DIFFERENT species were seen there that week,
  // 2 = the site's TOTAL species over the whole record (2010–2026), 3 = the VISITS
  // made that week. Everything needed rides in every tile, so switching only
  // changes what is read — no refetch.
  function bestSiteMetric() { var m = Math.round(+window.GeoState.get("bestSiteMetric", 0)); return (m === 1 || m === 2 || m === 3) ? m : 0; }
  function bestSiteSeries(s) { var m = bestSiteMetric(); return m === 1 ? (s.n || []) : m === 3 ? (s.v || []) : (s.s || []); }
  // Big record counts: 1234 → "1234", 15600 → "16k", 1 500 000 → "1.5M".
  function fmtBig(n) {
    n = +n || 0;
    return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : String(n);
  }
  // {v} for display: one decimal below 10 ("0.4", "3.2"), whole numbers above.
  function fmtVis(x) { return x >= 9.95 ? String(Math.round(x)) : String(Math.round(x * 10) / 10); }
  // Visits across the whole year — since the v series is per-year (data v1292),
  // this sums to the site's visits in a typical YEAR.
  function bestSiteVisitsTotal(s) {
    var v = s.v || [], tot = 0;
    for (var w = 0; w < v.length; w++) tot += v[w] || 0;
    return tot;
  }
  // -1 = Auto (follow the map zoom), 0/1/2 pin one level from the overlay's ⚙.
  function bestSiteLevelPref() {
    var v = Math.round(+window.GeoState.get("bestSiteLevel", -1));
    return (v === 0 || v === 1 || v === 2) ? v : -1;
  }
  // Auto: the FINEST level the current zoom is dense enough for. Each level carries
  // its own minZoom in the index (the data pipeline's own figure — the same one its
  // reference viewer uses), so re-tiling with different radii needs no app change.
  function bestSiteLevel() {
    var p = bestSiteLevelPref();
    if (p >= 0) return p;
    var z = getMap() ? getMap().getZoom() : 10, lv = bestSiteIndex && bestSiteIndex.levels;
    if (lv && lv.length) {
      for (var i = 0; i < lv.length; i++) if (z >= (lv[i].minZoom || 0)) return i;
      return lv.length - 1;
    }
    return z >= 12 ? 0 : (z >= 9 ? 1 : 2);   // index not loaded yet
  }
  // A level's clustering radius as a short label ("500 m" / "25 km"), from the index.
  function bestSiteLevelLabel(lvl) {
    var lv = (bestSiteIndex && bestSiteIndex.levels && bestSiteIndex.levels[lvl]) || null;
    if (lv && lv.label) return lv.label;
    var m = (bestSiteIndex && bestSiteIndex.levelsM && bestSiteIndex.levelsM[lvl]) || [500, 25000, 75000][lvl] || 0;
    return m >= 1000 ? (m / 1000) + " km" : m + " m";
  }
  function bestSiteZoomFrom() {
    var z = Math.round(+window.GeoState.get("bestSiteZoom", 5));
    return (isFinite(z) && z >= 3 && z <= 17) ? z : 5;
  }
  // A week's value with its neighbours half-weighted in: ½ this week + ¼ the week
  // before + ¼ the week after (the year wraps). Weekly counts at a single site are
  // noisy — one thin week shouldn't decide whether a dot shows or what number it
  // carries. Used for the dot filter, the ranking and the numbers on the dot/tooltip;
  // the charts keep drawing the RAW series, with the smoothed one marked separately.
  function smoothWeek(arr, i) {
    if (!arr) return 0;
    var n = 53;
    return 0.5 * (arr[i] || 0) + 0.25 * (arr[(i + n - 1) % n] || 0) + 0.25 * (arr[(i + 1) % n] || 0);
  }
  // Is the current ISO week a LOCAL peak for this site on a series — AND near
  // the site's real extreme? Ranked within the 13-week window centred on the
  // week (±6, wrapping): 1 = the best of those 13, 3 = among the window's top
  // 3. A local bump alone is NOT enough: the week must also carry real
  // amplitude — ≥90 % of the site's annual (smoothed) maximum for purple,
  // ≥75 % for blue-purple — and the site must have both enough data (≥8 active
  // weeks) and actual seasonality (annual max ≥1.4 × its median active week).
  // Flat windows still don't qualify (max shared by >3 weeks / third by >5).
  function weekTopRank(arr, iso) {
    var cur = smoothWeek(arr, iso - 1);
    if (!(cur > 0)) return 0;
    var eps = 1e-9, year = [], active = [];
    for (var w = 0; w < 53; w++) { var x = smoothWeek(arr, w); year.push(x); if (x > 0) active.push(x); }
    if (active.length < 8) return 0;                       // too sparse to call anything a peak
    active.sort(function (a, b) { return a - b; });
    var annMax = active[active.length - 1];
    var med = active[Math.floor(active.length / 2)];
    if (annMax < 1.4 * med) return 0;                      // no real seasonality → no extremes
    var vals = [];
    for (var d = -6; d <= 6; d++) vals.push(year[(iso - 1 + d + 53) % 53]);
    vals.sort(function (a, b) { return b - a; });
    var third = vals[2];
    var atTop3 = 0, atMax = 0;
    for (var i = 0; i < vals.length; i++) { if (vals[i] >= third - eps) atTop3++; if (vals[i] >= vals[0] - eps) atMax++; }
    if (cur >= vals[0] - eps && atMax <= 3 && cur >= 0.9 * annMax) return 1;
    if (cur >= third - eps && atTop3 <= 5 && cur >= 0.75 * annMax) return 3;
    return 0;
  }
  // Combined rank over the three metrics (species/visit · visits · species
  // seen). s/v are ranked live from the series in hand; species seen uses the
  // tiler-precomputed per-week window masks w3/wb (bit w-1 = ISO week w;
  // union over a merged dot's members).
  function maskHasWeek(mask, w) {
    return !!mask && Math.floor(mask / Math.pow(2, w - 1)) % 2 === 1;
  }
  function siteWeekTop(s, iso) {
    var best = 0;
    function acc(r) { if (r && (!best || r < best)) best = r; }
    acc(weekTopRank(bestSiteSeries(s), iso));
    acc(weekTopRank(s.v, iso));
    (s.members || [s]).forEach(function (m) {
      if (maskHasWeek(m.wb, iso)) acc(1);
      else if (maskHasWeek(m.w3, iso)) acc(3);
    });
    return best;   // 0 | 1 | 3
  }
  // Model week (1–48, four per month) → the dataset's ISO-ish week 1–53.
  function isoWeekFromModelWeek(w) {
    var doy = ((w - 0.5) / 48) * 365;
    return Math.max(1, Math.min(53, Math.floor(doy / 7) + 1));
  }
  // The UI's week (via the injected getter) — NOT the possibly-stale stored one.
  function currentIsoWeek() { return isoWeekFromModelWeek(getWeek ? getWeek() : weekOfToday()); }
  var bestTiles = Object.create(null);   // "L<level>/<key>" → sites[] loaded this session
  var bestSiteIndex = null, bestSiteIndexReq = null, bestTilesLoaded = Object.create(null);
  function fetchBestSiteIndex() {
    if (bestSiteIndex) return Promise.resolve(bestSiteIndex);
    if (!bestSiteIndexReq) bestSiteIndexReq = fetch(new URL("best-sites/index.json", SCRIPT_BASE).href)
      .then(function (r) { if (!r.ok) throw new Error("index " + r.status); return r.json(); })
      .then(function (j) { bestSiteIndex = j; return j; })
      .catch(function (e) { bestSiteIndexReq = null; throw e; });
    return bestSiteIndexReq;
  }
  // Cache-bust a tile with its OWN content hash (index entry [..., n, h, dh]) so a
  // regeneration only re-downloads the tiles whose bytes changed. Falls back to
  // the dataset's generation stamp for indexes from before the hashes existed.
  function bestTileGen(lvl, key, detail) {
    try {
      var e = bestSiteIndex.levels[lvl].tiles[key];
      var h = e && e[detail ? 6 : 5];
      if (h) return "?g=" + h;
    } catch (e2) {}
    return (bestSiteIndex && bestSiteIndex.generated) ? "?g=" + encodeURIComponent(bestSiteIndex.generated) : "";
  }
  function fetchBestSiteTile(lvl, key) {
    var lk = "L" + lvl + "/" + key;
    if (bestTilesLoaded[lk]) return Promise.resolve(bestTilesLoaded[lk]);
    var gen = bestTileGen(lvl, key, false);
    bestTilesLoaded[lk] = fetch(new URL("best-sites/" + lk + ".json" + gen, SCRIPT_BASE).href)
      .then(function (r) { if (!r.ok) throw new Error(lk + " " + r.status); return r.json(); })
      .then(function (j) {
        var _sites = j.sites || [];
        // Each site remembers its tile so the card can lazily pull the DETAIL file.
        _sites.forEach(function (st) { st._t = lk; st.s = bswUnpack(st.s); st.v = bswUnpack(st.v, 10); });
        bestTiles[lk] = _sites;
        bestTilesLoaded[lk] = true;
      })
      .catch(function (e) { delete bestTilesLoaded[lk]; throw e; });   // retried on the next pan
    return bestTilesLoaded[lk];
  }
  // The tile's sibling ".d.json" DETAIL file: the n / o / f / r week series that
  // only the opened card's 2nd and 3rd chart views need. Fetched on card open,
  // merged into the loaded tile's site objects by index. Tolerates absence (a
  // pre-split cached tile carries the series inline — nothing to fetch then).
  // Week-arrays in the tiles are base64-packed ('B'=uint8, 'W'=uint16 LE) to shrink
  // the deploy; decode back to plain arrays on load so the chart code is unchanged.
  // Plain arrays (older tiles) pass through untouched. Visits carry a tenth (scale 10).
  function bswUnpack(x, scale) {
    if (x == null) return [];
    if (typeof x !== "string") return x;          // old plain-array tile
    if (x === "") return [];
    var t = x.charCodeAt(0), b = atob(x.slice(1)), out = [], i;
    if (t === 66) { for (i = 0; i < b.length; i++) out.push(b.charCodeAt(i)); }             // 'B'
    else { for (i = 0; i < b.length; i += 2) out.push(b.charCodeAt(i) | (b.charCodeAt(i + 1) << 8)); }  // 'W'
    if (scale) for (i = 0; i < out.length; i++) out[i] /= scale;
    return out;
  }
  var bestDetailLoaded = Object.create(null);
  function fetchBestSiteDetail(lk) {
    if (bestDetailLoaded[lk]) return bestDetailLoaded[lk] === true ? Promise.resolve() : bestDetailLoaded[lk];
    var m = lk.match(/^L(\d+)\/(.+)$/);
    var gen = m ? bestTileGen(+m[1], m[2], true)
      : ((bestSiteIndex && bestSiteIndex.generated) ? "?g=" + encodeURIComponent(bestSiteIndex.generated) : "");
    bestDetailLoaded[lk] = fetch(new URL("best-sites/" + lk + ".d.json" + gen, SCRIPT_BASE).href)
      .then(function (r) { if (!r.ok) throw new Error(lk + ".d " + r.status); return r.json(); })
      .then(function (j) {
        var arr = bestTiles[lk] || [], det = j.sites || [];
        for (var i = 0; i < arr.length && i < det.length; i++) {
          arr[i].n = bswUnpack(det[i].n); arr[i].o = bswUnpack(det[i].o);
          arr[i].a = bswUnpack(det[i].a); arr[i].d = bswUnpack(det[i].d);
        }
        bestDetailLoaded[lk] = true;
      })
      .catch(function () { bestDetailLoaded[lk] = true; });   // 404 → inline data (old tiles) or nothing; don't retry-loop
    return bestDetailLoaded[lk] === true ? Promise.resolve() : bestDetailLoaded[lk];
  }
  // Make sure a card's site (plain or screen-merged) has its detail series: fetch
  // the involved tiles' .d files, and for a merged site recompute the pooled
  // n / o / f / r from its members afterwards.
  function ensureSiteDetail(s) {
    var members = s.members || [s];
    var keys = {};
    members.forEach(function (m) { if (m._t) keys[m._t] = 1; });
    return Promise.all(Object.keys(keys).map(fetchBestSiteDetail)).then(function () {
      if (!s.members) return;
      var mn = new Array(53), mo = new Array(53), ma = new Array(53), md = new Array(53);
      for (var w = 0; w < 53; w++) {
        var mxn = 0, mxo = 0, sa = 0, sd = 0, cnt = 0;
        members.forEach(function (m) {
          if ((m.n ? m.n[w] || 0 : 0) > mxn) mxn = m.n[w] || 0;   // distinct species → best member (can't be summed)
          if ((m.o ? m.o[w] || 0 : 0) > mxo) mxo = m.o[w] || 0;   // observers overlap across neighbouring spots → best member
          sa += (m.a ? m.a[w] || 0 : 0); sd += (m.d ? m.d[w] || 0 : 0); cnt++;   // turnover: simple average across the merged sites
        });
        mn[w] = mxn; mo[w] = mxo; ma[w] = cnt ? sa / cnt : 0; md[w] = cnt ? sd / cnt : 0;
      }
      s.n = mn; s.o = mo; s.a = ma; s.d = md;
    });
  }
  // The loaded tiles of ONE level (the tile store is keyed "L<level>/<quadkey>").
  function bestTileKeysFor(lvl) {
    var pre = "L" + lvl + "/";
    return Object.keys(bestTiles).filter(function (k) { return k.indexOf(pre) === 0; });
  }
  // Settings → Clear cached data → Best sites: session store + SW-cached tiles.
  function clearBestSiteCache() {
    bestTiles = Object.create(null); bestTilesLoaded = Object.create(null); bestSiteIndex = null; bestSiteIndexReq = null;
    if (!window.caches) return Promise.resolve();
    return caches.keys().then(function (names) {
      return Promise.all(names.map(function (nm) {
        return caches.open(nm).then(function (c) {
          return c.keys().then(function (reqs) {
            return Promise.all(reqs.filter(function (rq) { return rq.url.indexOf("/best-sites/") !== -1; })
              .map(function (rq) { return c.delete(rq); }));
          });
        });
      }));
    }).catch(function () {});
  }
  var BEST_SITES_ATTR = 'Top sites: <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF.org</a>';
  // Shrink a one-line popup title just enough to fit the card width (mirrors
  // fitNearbyNames). Floor of 10.5 px keeps it readable — a name still too long
  // at that size ellipsises rather than shrinking into illegibility.
  var POPUP_TITLE_MIN = 10.5;
  function fitPopupTitle(el) {
    if (!el) return;
    el.style.fontSize = "";
    var base = parseFloat(getComputedStyle(el).fontSize) || 15;
    var avail = el.clientWidth, full = el.scrollWidth;
    if (!avail) return;                       // not laid out yet — the caller retries
    if (full > avail) {
      var size = Math.max(POPUP_TITLE_MIN, Math.floor(base * avail / full * 10) / 10);
      el.style.fontSize = size + "px";
      // One corrective step (rounding / kerning), never below the floor.
      if (el.scrollWidth > el.clientWidth && size > POPUP_TITLE_MIN) {
        el.style.fontSize = Math.max(POPUP_TITLE_MIN, size - 0.5) + "px";
      }
    }
  }
  // Leaflet positions/animates the popup after popupopen, so the title can have
  // no layout on the first tick — retry over a few frames until it measures.
  function wireFitPopupTitle(m) {
    m.on("popupopen", function () {
      var tries = 0;
      (function attempt() {
        var el = document.querySelector(".leaflet-popup .hs-pop-head b");
        if (el && el.clientWidth) { fitPopupTitle(el); return; }
        if (++tries < 8) requestAnimationFrame(attempt);
      })();
    });
  }
  // A site's ANNUAL headline: visit-weighted average species-per-visit + total
  // visits over the whole year — the card's second line.
  function bestAvgLine(s) {
    var tot = 0, wsum = 0;
    for (var w = 0; w < 53; w++) { var vw = s.v[w] || 0; tot += vw; wsum += (s.s[w] || 0) * vw; }   // series are trailing-zero trimmed
    return t("best.avgLine", { n: tot ? Math.round(wsum / tot) : 0, v: tot });
  }
  // Display-name cleanup (also covers tiles cached before the tiler learned it):
  // left→right, drop any word already seen earlier in the name — the dataset's
  // joined sub-localities repeat words ("Nordre Øyeren NR, Nordre Øyeren,
  // Årnestangen" → "Nordre Øyeren NR, Årnestangen").
  function bestSiteDisplayName(name) {
    if (!name) return "";
    var seen = Object.create(null), out = [];
    String(name).split(/\s+/).forEach(function (w) {
      var k = w.toLowerCase().replace(/^[,;:()\-]+|[,;:()\-]+$/g, "");
      if (!k || seen[k]) return;
      seen[k] = 1; out.push(w);
    });
    return out.join(" ").replace(/(,\s*)+/g, ", ").replace(/[\s,;:-]+$/, "");
  }
  // Nearest best-site record within 300 m of a point (loaded tiles only).
  function bestSiteNear(lat, lon) {
    var found = null, bd = 1e9;
    bestTileKeysFor(bestSiteLevel()).forEach(function (k) {
      var arr = bestTiles[k];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (Math.abs(s.lat - lat) > 0.004 || Math.abs(s.lon - lon) > 0.008) continue;
        var d = haversineKm(lat, lon, s.lat, s.lon) * 1000;
        if (d < 300 && d < bd) { bd = d; found = s; }
      }
    });
    return found;
  }
  // The leaf quadtree tile covering a point (leaves don't overlap).
  function bestTileKeyForPoint(idx, lvl, lat, lon) {
    var bestK = null, tiles = ((idx.levels || [])[lvl] || {}).tiles || {};
    Object.keys(tiles).forEach(function (k) {
      var tb = tiles[k];
      if (lat >= tb[0] && lat < tb[0] + tb[2] && lon >= tb[1] && lon < tb[1] + tb[3]) {
        if (!bestK || k.length > bestK.length) bestK = k;
      }
    });
    return bestK;
  }
  // The click-through year profile. FOUR views, cycled by clicking the chart
  // (bestChartView is remembered across popups):
  //   0 — species per visit (bars) + the max-biased "upper estimate" trend line
  //   1 — species actually observed (bars) + observers on their own axis
  //   2 — the AI model's own year profile for this spot (async, map-click parity)
  //   3 — species TURNOVER: arrivals (green, up) vs departures (rust, down) against
  //       the week before, from the FLICKER-SMOOTHED series (n_arrived_s/n_departed_s
  //       — presence median-filtered over 3 weeks, so a species must hold a place for
  //       more than one week to count; the raw series measures sampling as much as
  //       birds). Tall both ways = a migration turnstile; flat = a resident site the
  //       richness total rates the same. ISO week 53 deliberately carries no flux.
  var bestChartView = 0;
  // Whittaker beta turnover: total species over the mean active week. The tiles
  // ship it per single site (s.tb); a screen-merged site has none, so fall back to
  // its pooled total over its own weekly-species mean.
  function siteTurnover(s) {
    if (s.tb != null) return s.tb;
    var n = s.n || [], sum = 0, cnt = 0;
    for (var i = 0; i < n.length; i++) if (n[i] > 0) { sum += n[i]; cnt++; }
    return (s.sp && cnt) ? s.sp / (sum / cnt) : null;
  }
  function bestYearChartSvg(site, isoNow, view) {
    var W = 248, H = 88, base = H - 12, top = 10, i;
    var bw = Math.max(2, Math.floor(W / 53) - 1);
    function maxOf(a) { var m = 1; for (var j = 0; j < (a || []).length; j++) if (a[j] > m) m = a[j]; return m; }
    function barsSvg(arr, mx, col, hi) {
      var out = "";
      for (var j = 0; j < 53; j++) {
        var x = Math.round(j * W / 53), h = Math.round(((arr[j] || 0) / mx) * (base - top));
        if (h > 0) out += '<rect x="' + x + '" y="' + (base - h) + '" width="' + bw + '" height="' + h + '" fill="' + (j === hi ? "#e8801f" : col) + '"/>';
      }
      return out;
    }
    function lineSvg(arr, mx, col, wdt, op, dash) {
      var pts = [];
      for (var j = 0; j < 53; j++) pts.push((Math.round(j * W / 53) + bw / 2) + "," + (base - ((arr[j] || 0) / mx) * (base - top)).toFixed(1));
      return '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + col + '" stroke-width="' + wdt + '" stroke-linejoin="round" stroke-linecap="round" opacity="' + op + '"' +
        (dash ? ' stroke-dasharray="' + dash + '"' : "") + "/>";
    }
    var body, lblL, lblR = "";
    if (view === 1) {
      var obs = site.n || [], obsv = site.o || [];
      var maxSp = maxOf(obs), maxO = maxOf(obsv);
      // Raw bars, with the same ½ + ¼/¼ weighting drawn over them as a dashed line.
      var obsSm = [];
      for (i = 0; i < 53; i++) obsSm.push(smoothWeek(obs, i));
      body = barsSvg(obs, maxSp, "#2f6fb0", isoNow - 1) +
        lineSvg(obsSm, maxSp, "#2f6fb0", 1.6, 0.95, "3 2") +
        lineSvg(obsv, maxO, "#666", 1, 0.75);
      lblL = '<text x="2" y="8" font-size="7" fill="#2f6fb0">' + Math.round(maxSp) + "</text>";
      lblR = '<text x="' + (W - 2) + '" y="8" font-size="7" fill="#666" text-anchor="end">' + maxO + "</text>";
    } else if (view === 3) {
      // TURNOVER: species gained (green, up) vs lost (rust, down) against the week
      // before, flicker-smoothed. Tall both ways = a migration turnstile; flat = a
      // resident site the richness total would rate the same.
      var arr = site.a || [], dep = site.d || [], mid = Math.round((top + base) / 2);
      var mxT = Math.max(1, maxOf(arr), maxOf(dep)), up = "", dn = "";
      for (i = 0; i < 53; i++) {
        var xt = Math.round(i * W / 53), hlt = (i === isoNow - 1);
        var ha = Math.round(((arr[i] || 0) / mxT) * (mid - top));
        var hd = Math.round(((dep[i] || 0) / mxT) * (base - mid));
        if (ha > 0) up += '<rect x="' + xt + '" y="' + (mid - ha) + '" width="' + bw + '" height="' + ha + '" fill="' + (hlt ? "#e8801f" : "#2e9e5b") + '"/>';
        if (hd > 0) dn += '<rect x="' + xt + '" y="' + mid + '" width="' + bw + '" height="' + hd + '" fill="' + (hlt ? "#e8801f" : "#b5532a") + '"/>';
      }
      body = up + dn + '<line x1="0" y1="' + mid + '" x2="' + W + '" y2="' + mid + '" stroke="#aaa" stroke-width="1"/>';
      lblL = '<text x="2" y="8" font-size="7" fill="#2e9e5b">+' + Math.round(mxT) + "</text>" +
             '<text x="2" y="' + (H - 14) + '" font-size="7" fill="#b5532a">\u2212' + Math.round(mxT) + "</text>";
    } else {
      var spv = site.s, maxS = maxOf(spv);
      // Upper estimate: each week takes the MAX over its ±2 neighbours (the year
      // wraps), then a light 1-2-1 smoothing — the line rides the peaks.
      var env = [], sm = [];
      for (i = 0; i < 53; i++) {
        var mx2 = 0;
        for (var j2 = -2; j2 <= 2; j2++) { var v2 = spv[(i + j2 + 53) % 53]; if (v2 > mx2) mx2 = v2; }
        env.push(mx2);
      }
      for (i = 0; i < 53; i++) sm.push((env[(i + 52) % 53] + 2 * env[i] + env[(i + 1) % 53]) / 4);
      // The dashed line is the weighted measure the dots and their numbers use
      // (½ this week + ¼ either side) — the bars stay raw.
      var sm3 = [];
      for (i = 0; i < 53; i++) sm3.push(smoothWeek(spv, i));
      body = barsSvg(spv, maxS, "#2f6fb0", isoNow - 1) + lineSvg(sm, maxS, "#1b4d80", 2.5, 0.85) +
        lineSvg(sm3, maxS, "#2f6fb0", 1.6, 0.95, "3 2");
      lblL = '<text x="2" y="8" font-size="7" fill="#2f6fb0">' + maxS + "</text>";
    }
    var months = "JFMAMJJASOND", mt = "";
    for (i = 0; i < 12; i++) mt += '<text x="' + ((i + 0.5) / 12 * W).toFixed(0) + '" y="' + (H - 2) + '" font-size="7" fill="#888" text-anchor="middle">' + months[i] + "</text>";
    return '<svg viewBox="0 0 ' + W + " " + H + '" class="bsw-chart">' + body +
      '<line x1="0" y1="' + base + '" x2="' + W + '" y2="' + base + '" stroke="#aaa" stroke-width="1"/>' +
      lblL + lblR + mt + "</svg>";
  }
  // The AI model's year profile for a POINT: how many species the model puts at or
  // above each of these probabilities, for every one of the 48 model weeks. The
  // curves nest (a stricter cutoff can only count fewer species), so they read as a
  // band — light green = "possible here", dark = "near certain".
  // Band edges, ascending. The bands drawn are [80,100] · [60,80] · [40,60] · [20,40]
  // · [1,20]; the lowest starts at 1 %, not 0 — at any point most of the model's
  // 12,012 species sit near zero, and a [0,20] slab of ~11k would bury every band
  // above it (and make a "every 50 species" grid meaningless).
  var PT_MODEL_CUTOFFS = [0.01, 0.20, 0.40, 0.60, 0.80];
  var PT_MODEL_COLORS = ["#cfe9de", "#9ed4bd", "#63bd9a", "#2e8b74", "#14584a"];   // light → dark
  var ptModelCache = Object.create(null);
  // All six cutoffs come out of ONE 48-row model run (the worker counts every
  // cutoff in a single pass), cached per rounded location.
  function pointModelCurves(lat, lon) {
    var k = lat.toFixed(3) + "," + lon.toFixed(3);
    if (ptModelCache[k]) return Promise.resolve(ptModelCache[k]);
    var flat = [];
    for (var w = 1; w <= 48; w++) flat.push(lat, lon, w);
    return runInference(flat, 48, { task: "richness", thresholds: PT_MODEL_CUTOFFS }).then(function (out) {
      var series = [];   // threshold-major: 48 counts per cutoff, in cutoff order
      for (var c = 0; c < PT_MODEL_CUTOFFS.length; c++) series.push(Array.prototype.slice.call(out, c * 48, (c + 1) * 48));
      ptModelCache[k] = series;
      return series;
    });
  }
  function modelYearChartSvg(series, curWeek) {
    var W = 200, H = 62, base = H - 12, top = 8, i, j, mx = 1;   // 200 wide: drawn 1:1, never widens the popup
    for (i = 0; i < series.length; i++) for (j = 0; j < series[i].length; j++) if (series[i][j] > mx) mx = series[i][j];
    // Each series is a CUMULATIVE count (species at or above that cutoff), so filling
    // every one from the baseline — loosest first, strictest last — paints exactly the
    // bands between consecutive cutoffs: the darkest slab at the bottom is 80–100 %,
    // each lighter slab above it the next band down.
    function pathTop(arr) {
      var d = [], span = Math.max(1, arr.length - 1), x;
      for (var q = 0; q < arr.length; q++) {
        x = (q / span) * (W - 4) + 2;
        d.push((q ? "L" : "M") + x.toFixed(1) + "," + (base - (arr[q] / mx) * (base - top)).toFixed(1));
      }
      return d;
    }
    function areaFor(arr, col) {
      var d = pathTop(arr);
      d.push("L" + (W - 2).toFixed(1) + "," + base, "L2," + base, "Z");
      return '<path d="' + d.join(" ") + '" fill="' + col + '" stroke="none"/>';
    }
    // A thin edge line on every band top makes the stacking legible — without it
    // the same-hue slabs blend and the chart doesn't LOOK stacked, even though
    // the cumulative fills are exactly the stacked interval counts.
    function edgeFor(arr) {
      return '<path d="' + pathTop(arr).join(" ") + '" fill="none" stroke="#0c3f34" stroke-width="0.7" opacity="0.55"/>';
    }
    var body = "";
    for (i = 0; i < series.length; i++) body += areaFor(series[i], PT_MODEL_COLORS[i] || "#2e8b74");
    for (i = 0; i < series.length; i++) body += edgeFor(series[i]);
    var cx = ((Math.max(1, Math.min(48, curWeek)) - 1) / 47) * (W - 4) + 2;
    // A thin rule every 50 species gives the curves a scale without cluttering the
    // chart with numbers — only the maximum stays labelled.
    var grid = "";
    for (i = 50; i <= mx; i += 50) {
      // DASHED so a rule crossing a band can't be mistaken for a band boundary
      // (the solid band edges are the real interval borders).
      grid += '<line x1="0" y1="' + (base - (i / mx) * (base - top)).toFixed(1) + '" x2="' + W +
        '" y2="' + (base - (i / mx) * (base - top)).toFixed(1) + '" stroke="#ccc" stroke-width="0.5" stroke-dasharray="2 3"/>';
    }
    var months = "JFMAMJJASOND", mt = "";
    for (i = 0; i < 12; i++) mt += '<text x="' + ((i + 0.5) / 12 * W).toFixed(0) + '" y="' + (H - 2) + '" font-size="7" fill="#888" text-anchor="middle">' + months[i] + "</text>";
    return '<svg viewBox="0 0 ' + W + " " + H + '" class="bsw-chart pt-chart">' +
      body +
      grid +
      '<line x1="' + cx.toFixed(1) + '" y1="' + top + '" x2="' + cx.toFixed(1) + '" y2="' + base + '" stroke="#e8801f" stroke-width="1.5" opacity="0.9"/>' +
      '<line x1="0" y1="' + base + '" x2="' + W + '" y2="' + base + '" stroke="#aaa" stroke-width="1"/>' +
      '<text x="2" y="8" font-size="7" fill="#2e8b74">' + Math.round(mx) + "</text>" + mt + "</svg>";
  }
  function bestSitesLayer() {
    // openCards counts the layer's OPEN popups. A redraw clears every marker — and
    // Leaflet's autoPan fires `moveend` the moment a card opens, which schedules
    // exactly such a redraw — so the card would vanish a moment after being tapped.
    // While one is open the layer holds still and redraws once it closes.
    var grp = L.layerGroup(), active = false, timer = null, openCards = 0, pendingDraw = false;
    ensureSpotsPane();
    function makeBestMarker(s, iso) {
      var tot = bestSiteMetric() === 2, m3 = bestSiteMetric() === 3;
      var spvRaw = smoothWeek(bestSiteSeries(s), iso - 1);
      var visRaw = tot ? bestSiteVisitsTotal(s) : smoothWeek(s.v, iso - 1);
      var spv = tot ? (s.sp || 0) : (m3 ? fmtVis(spvRaw) : Math.round(spvRaw));
      var vis = fmtVis(visRaw);
      var dispName = bestSiteDisplayName(s.name);
      // Dot SIZE follows the visit count (log scale: 1 visit → small, ~10 → mid,
      // 100+ → large), so well-watched sites read bigger; the NUMBER inside
      // stays the selected metric (species/visit · species · total).
      var rad = 4 + Math.min(10, Math.round(6 * Math.log10((visRaw || 0) + 1)));
      var txt = String(spv);
      var D = Math.max(2 * rad + 2, Math.ceil(8 + 5.5 * txt.length));
      var F = Math.max(7, Math.min(10, Math.round(D / 2) - 2));
      var m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: "hs-div", html: '<span class="bsw-mk' + (s.k > 1 ? " bsw-merged" : "") +
          (function (r) { return r === 1 ? " bsw-top1" : r === 3 ? " bsw-top3" : ""; })(siteWeekTop(s, iso)) +
          '" style="width:' + D + 'px;height:' + D + 'px;font-size:' + F + 'px">' + txt + "</span>", iconSize: [D, D], iconAnchor: [D / 2, D / 2] }),
        keyboard: false, pane: "spotsPane",
        // Best sites often SHARE a spot with an eBird hotspot / birding spot, and all
        // three live in spotsPane. The best-site badge is the smallest and the most
        // informative marker (its popup carries the year chart), so it takes the top
        // of that pile and the click; the hotspot disc under it is bigger and stays
        // clickable around the badge. (Observation dots are in their own pane above
        // spotsPane, so they still cover every spot marker.)
        zIndexOffset: 2000
      });
      // Same guard as the hotspot discs: the dot's click must not fall through to
      // the map-click pipeline (which would close the popup + run an inference).
      m.on("click", function (e) {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        setMapClickGuard(Date.now() + 300);
      });
      wireSpotFan(m);   // overlapping spot markers fan out on hover
      wireFitPopupTitle(m);   // scale the card title to the card width
      m.on("popupopen", function () { openCards++; });
      m.on("popupclose", function () {
        openCards = Math.max(0, openCards - 1);
        if (!openCards && pendingDraw) { pendingDraw = false; drawAll(); }
      });
      var mergedNote = (s.k > 1) ? " · " + t("best.sitesN", { k: s.k }) : "";
      m.bindTooltip("<b>" + escapeHtml(dispName) + "</b><span class='area-tip-sub'>" +
        escapeHtml(t(tot ? "best.weekNowTot" : (bestSiteMetric() === 1 ? "best.weekNowSp" : bestSiteMetric() === 3 ? "best.weekNowVis" : "best.weekNow"), { n: spv, v: vis }) + mergedNote) + "</span>",
        { direction: "top", className: "area-tip" });
      m.bindPopup(function () {
        var pop = document.createElement("div"); pop.className = "map-choose hs-popup";
        var hd = document.createElement("div"); hd.className = "hs-pop-head";
        // Card layout: bold name (font scaled to the card width on popupopen),
        // then ONE stat line that FOLLOWS the chart view (filled by drawChart —
        // no duplication with what the visible graph shows), then country · level.
        hd.innerHTML = "<b>" + escapeHtml(dispName || t("layer.bestSites")) + "</b>" +
          "<span class='hs-pop-sub bsw-stat'></span>" +
          "<span class='hs-pop-sub'>" + escapeHtml((s.c ? s.c + " · " : "") + bestSiteLevelLabel(bestSiteLevel()) +
            " · " + t("best.records", { n: fmtBig(s.ob) }) +
            (s.fd ? " · " + t("best.since", { d: s.fd }) : "")) + "</span>";
        var statEl = hd.querySelector(".bsw-stat");
        if (!s.name) {   // nameless site (coordinate-only GBIF label) → map-derived title
          var tb = hd.querySelector("b");
          detailedPlaceName(s.lat, s.lon).then(function (nm) {
            if (nm && tb) { tb.textContent = "≈ " + nm; fitPopupTitle(tb); }
          }).catch(function () {});
        }
        pop.appendChild(hd);
        var ch = document.createElement("div"); ch.className = "bsw-chart-wrap";
        ch.setAttribute("role", "button"); ch.title = t("best.chartSwitch");
        pop.appendChild(ch);
        var lg = document.createElement("div"); lg.className = "bsw-legend";
        pop.appendChild(lg);
        // The stat line matches WHAT THE CHART SHOWS:
        //   species/visit view → this week's species per visit · merged · pooled
        //   species-seen view  → the year's total species · merged · this week's visits
        //   flux view          → this week's species gain/loss · merged · pooled
        function statLine() {
          var parts = [], pooled = (s.nc > (s.k || 1)) ? t("best.pooledN", { n: s.nc }) : "";
          var merged = (s.k > 1) ? t("best.sitesN", { k: s.k }) : "";
          if (bestChartView === 3) {
            var bT = siteTurnover(s);
            parts.push(t("best.statTurn", { b: bT != null ? bT.toFixed(1) : "\u2013" }), merged);
          } else if (bestChartView === 2) {
            parts.push(t("best.statTotSp", { n: s.sp || 0 }), merged);
          } else if (bestChartView === 1) {
            parts.push(t("best.statTotSp", { n: s.sp || 0 }), merged,
              t("best.statVWeek", { v: fmtVis(smoothWeek(s.v, iso - 1)) }));
          } else {
            parts.push(t("best.statSpv", { n: Math.round(smoothWeek(bestSiteSeries(s), iso - 1)) }), merged, pooled);
          }
          return parts.filter(Boolean).join(" · ");
        }
        // "● ○ ○" position dots in the legend line — the tap-to-cycle chart has
        // three views, and nothing else tells a touch user that.
        function viewDots() {
          var out = "";
          for (var vi = 0; vi < 4; vi++) out += (vi === bestChartView ? "\u25cf" : "\u25cb");
          return out + "  ";
        }
        function drawChart() {
          if (bestChartView > 3) bestChartView = 0;
          if (bestChartView === 2) {
            // Third view (moved here from the point popup): the AI model's year
            // profile for this exact spot — species at/above six probabilities,
            // week by week. Async (one cached 48-week inference per location).
            var mw = getWeek();
            pointModelCurves(s.lat, s.lon).then(function (series) {
              if (bestChartView !== 2 || !pop.isConnected || !series || !series.length) return;
              ch.innerHTML = modelYearChartSvg(series, mw);
            }).catch(function () {});
            lg.textContent = viewDots() + t("model.weekChart");
            if (statEl) statEl.textContent = statLine();
            return;
          }
          ch.innerHTML = bestYearChartSvg(s, iso, bestChartView);
          lg.textContent = viewDots() + t(["best.chartHint", "best.chartHint2", "best.chartHint", "best.chartTurnHint"][bestChartView] || "best.chartHint");
          if (statEl) statEl.textContent = statLine();
        }
        drawChart();
        // The species-seen view reads the lazily-fetched detail series —
        // redraw once they land (view 0 and the stat line's week values are
        // complete already, so the card never waits).
        ensureSiteDetail(s).then(function () { if (pop.isConnected && bestChartView !== 2) drawChart(); });
        ch.addEventListener("click", function (e) {
          e.stopPropagation();
          bestChartView = (bestChartView + 1) % 4;   // click the chart → next view (remembered)
          drawChart();
        });
        // The app's standard icon trio: save point · navigate · add to route.
        var irow = document.createElement("div"); irow.className = "hs-pop-icons";
        function ib(icon, title, fn) {
          var b = document.createElement("button");
          b.type = "button"; b.className = "btn-light ico-btn hs-ico-btn";
          b.title = title; b.setAttribute("aria-label", title);
          b.innerHTML = ico(icon); b.addEventListener("click", fn);
          return b;
        }
        irow.appendChild(ib("dotsplus", t("locmenu.add"), function () { m.closePopup(); openPointEditor({ lat: s.lat, lon: s.lon, name: dispName }); }));
        irow.appendChild(ib("nav", t("nav.title"), function () { m.closePopup(); navigatePoints([{ lat: s.lat, lon: s.lon }]); }));
        irow.appendChild(ib("navplus", tLabel("route.add"), function () { m.closePopup(); addToRoute(s.lat, s.lon, dispName); }));
        pop.appendChild(irow);
        return pop;
      }, { closeButton: true, className: "choose-popup", offset: [0, -4] });
      return m;
    }
    // Sites that overlap on screen merge into ONE dot: a rich locality is often
    // several 100 m "sites" in the dataset, and zoomed out those should read as
    // one place with the AREA's overall stats — week-wise MAX species-per-visit
    // (the best you could do there), SUMMED visits, fronted by this week's best
    // member's name/position. Zooming in pulls them apart again (leader
    // clustering in projected pixel space, ±MERGE_PX).
    var MERGE_PX = 26;
    function mergeBestSites(cand, iso) {
      var z = getMap().getZoom(), clusters = [], grid = Object.create(null);
      cand.forEach(function (s) {
        var p = getMap().project([s.lat, s.lon], z);
        var cx = Math.floor(p.x / MERGE_PX), cy = Math.floor(p.y / MERGE_PX), c = null;
        outer:
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
          var lst = grid[(cx + dx) + ":" + (cy + dy)];
          if (!lst) continue;
          for (var i = 0; i < lst.length; i++) {
            var q = lst[i], ex = p.x - q.px, ey = p.y - q.py;
            if (ex * ex + ey * ey <= MERGE_PX * MERGE_PX) { c = q; break outer; }
          }
        }
        if (!c) {
          c = { px: p.x, py: p.y, members: [] };
          clusters.push(c);
          var gk = cx + ":" + cy;
          (grid[gk] || (grid[gk] = [])).push(c);
        }
        c.members.push(s);
      });
      return clusters.map(function (c) {
        if (c.members.length === 1) return c.members[0];
        var best = c.members[0];
        c.members.forEach(function (s) { if (smoothWeek(s.s, iso - 1) > smoothWeek(best.s, iso - 1)) best = s; });
        var ms = new Array(53), mv = new Array(53), mn = new Array(53), mo = new Array(53);
        for (var w = 0; w < 53; w++) {
          var mx = 0, mxv = 0, mxn = 0, mxo = 0;
          c.members.forEach(function (s) {
            if ((s.s[w] || 0) > mx) mx = s.s[w] || 0;
            // Visits & observers take the BEST member, not the sum: neighbouring
            // spots share their visitors, so summing would count one person's
            // day once per spot they logged. The true distinct observer-day
            // count lies between max and sum — max never double-counts.
            if ((s.v[w] || 0) > mxv) mxv = s.v[w] || 0;
            if ((s.n ? s.n[w] || 0 : 0) > mxn) mxn = s.n[w] || 0;   // distinct species can't be summed across sites → best member
            if ((s.o ? s.o[w] || 0 : 0) > mxo) mxo = s.o[w] || 0;
          });
          ms[w] = mx; mv[w] = mxv; mn[w] = mxn; mo[w] = mxo;
        }
        var fd = null;
        c.members.forEach(function (s) { if (s.fd && (!fd || s.fd < fd)) fd = s.fd; });
        return { lat: best.lat, lon: best.lon, name: best.name, c: best.c, fd: fd,
          sp: Math.max.apply(null, c.members.map(function (s) { return s.sp; })),
          ob: c.members.reduce(function (a, s) { return a + s.ob; }, 0),
          nc: c.members.reduce(function (a, s) { return a + (s.nc || 1); }, 0),
          s: ms, v: mv, n: mn, o: mo, k: c.members.length,
          members: c.members };   // → ensureSiteDetail re-merges n/o once the .d files land
      });
    }
    function drawAll() {
      if (openCards) { pendingDraw = true; return; }   // an open card owns its marker
      grp.clearLayers();
      if (getMap().getZoom() < bestSiteZoomFrom()) return;
      var iso = currentIsoWeek(), vb = getMap().getBounds().pad(0.1), cand = [], allYear = bestSiteMetric() === 2;
      bestTileKeysFor(bestSiteLevel()).forEach(function (k) {
        var arr = bestTiles[k];
        for (var i = 0; i < arr.length; i++) {
          var s = arr[i];
          // "Total species" is an all-year figure, so those dots don't depend on the
          // week — every site in view carries its own total. The weekly metrics keep
          // the week gate (and never draw a dot that would read "0").
          if (allYear) { if (!(s.sp > 0)) continue; }
          else {
            var wv = smoothWeek(bestSiteSeries(s), iso - 1);
            // Visits are per-year decimals — a 0.1 dot is real; the other metrics round.
            if (bestSiteMetric() === 3 ? wv < 0.05 : Math.round(wv) < 1) continue;
          }
          if (!vb.contains([s.lat, s.lon])) continue;
          cand.push(s);
        }
      });
      cand = mergeBestSites(cand, iso);   // overlapping sites → one dot with area stats
      // Best-first (species-per-visit, then visits) up to the max-N cap — the
      // same gradual reveal the hotspots and birding spots use.
      var maxN = bestSiteMax();
      cand.sort(allYear
        ? function (a, b) { return ((b.sp || 0) - (a.sp || 0)) || (bestSiteVisitsTotal(b) - bestSiteVisitsTotal(a)); }
        : function (a, b) { return (smoothWeek(bestSiteSeries(b), iso - 1) - smoothWeek(bestSiteSeries(a), iso - 1)) || (smoothWeek(b.v, iso - 1) - smoothWeek(a.v, iso - 1)); });
      if (maxN && cand.length > maxN) cand.length = maxN;
      cand.forEach(function (s) { grp.addLayer(makeBestMarker(s, iso)); });
    }
    function load(fromAdd) {
      if (!active) return;
      drawAll();   // whatever is already loaded, immediately
      if (getMap().getZoom() < bestSiteZoomFrom()) {
        if (fromAdd) setStatus(t("layer.zoomHint", { z: bestSiteZoomFrom() }));
        return;
      }
      fetchBestSiteIndex().then(function (idx) {
        if (!active) return;
        // A data/format mismatch (e.g. an old cached app meeting a regenerated
        // dataset) used to fail SILENTLY — no dots, no hint. Say what to do.
        if (!idx || !idx.levels || !idx.levels.length) { setStatus(t("best.loadFail"), true); return; }
        var lvl = bestSiteLevel(), lev = (idx.levels || [])[lvl];
        if (!lev) return;
        var tiles = lev.tiles || {}, b = getMap().getBounds().pad(0.3), pend = [];
        Object.keys(tiles).forEach(function (k) {
          if (bestTilesLoaded["L" + lvl + "/" + k] === true) return;
          var tb = tiles[k];
          if (b.intersects(L.latLngBounds([tb[0], tb[1]], [tb[0] + tb[2], tb[1] + tb[3]]))) pend.push(k);
        });
        if (!pend.length) { drawAll(); return; }   // level switched to one already cached
        // Loading feedback is the BLINKING overlay button / panel row only —
        // no status text (that is reserved for failures).
        overlayBusy(t("layer.bestSites"), true);
        Promise.all(pend.map(function (k) { return fetchBestSiteTile(lvl, k).catch(function () {}); }))
          .then(function () {
            overlayBusy(t("layer.bestSites"), false);
            if (!active) return;
            // Every tile of the level failed and nothing is loaded → offline, or an
            // app/data version mismatch. Either way: tell the user, don't go blank.
            if (!bestTileKeysFor(lvl).length) setStatus(t("best.loadFail"), true);
            drawAll();
          });
      }).catch(function (err) {
        overlayBusy(t("layer.bestSites"), false);
        if (active) setStatus(t("status.error", { msg: "best sites " + ((err && err.message) ? err.message : err) }), true);
      });
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(load, 500); }
    // An open card freezes the dot redraw (openCards guards drawAll). If the user pans so
    // the open card's dot leaves the view, close it — the redraw then runs and the dots
    // refresh for the new area instead of staying stuck on the old one.
    function closeCardsOutOfView() {
      if (!openCards) return;
      var vb = getMap().getBounds();
      grp.eachLayer(function (m) {
        if (m.isPopupOpen && m.isPopupOpen() && m.getLatLng && !vb.contains(m.getLatLng())) m.closePopup();
      });
    }
    grp._reload = function () { if (active) load(); };   // week / setting change → re-rank, and fetch the level's tiles if it changed
    grp.on("add", function () { active = true; getMap().attributionControl.addAttribution(BEST_SITES_ATTR); load(true); });
    grp.on("remove", function () { active = false; clearTimeout(timer); getMap().attributionControl.removeAttribution(BEST_SITES_ATTR); });
    getMap().on("moveend", function () { if (active) { closeCardsOutOfView(); schedule(); } });
    bestSitesLayerRef = grp;
    return grp;
  }
  var bestSitesLayerRef = null;   // the live best-sites layer (week/settings re-rank hook)

  // Minimum all-time species for a hotspot to be shown ("real hotspots" filter).
  // Default OFF: the max-N viewport cap (v1188) already keeps the map readable
  // best-first, whereas a species floor hides ENTIRE regions — nothing within
  // 25 km of Hommelvik (NO) reaches 200 species, so the old 200 default made the
  // hotspots overlay look empty there. A user-set value is still honoured.
  function hotspotMin() { return +window.GeoState.get("hotspotMin", 0) || 0; }
  // Cap on hotspots drawn in the viewport (0 = all). The best (highest all-time
  // species count) win the slots, so zooming in gradually reveals smaller-but-good
  // localities as the big ones leave the view.
  function hotspotMax() { var n = +window.GeoState.get("hotspotMax", 50); return (isFinite(n) && n >= 0) ? n : 50; }
  // Zoom level FROM which hotspot markers are shown — long-press the overlay
  // row to change. Default 3 = effectively always (the historical behaviour).
  function hotspotZoomFrom() {
    var z = Math.round(+window.GeoState.get("hotspotZoom", 3));
    return (isFinite(z) && z >= 3 && z <= 17) ? z : 3;
  }
  // Persistent hotspot store (dedup by locId) so hotspots ACCUMULATE as you pan and
  // survive reloads — the layer shows every cached hotspot, not just the current
  // view's query. UNLIMITED: lives in IndexedDB (part of the general cache),
  // hydrated into memory at boot; the old capped localStorage copy is migrated
  // over once and dropped to free quota. No IndexedDB (private mode) → the
  // legacy localStorage path, memory-first.
  var hotspotStoreMem = null;
  function loadHotspotStore() {
    if (!hotspotStoreMem) hotspotStoreMem = window.GeoState.get("ebirdHotspots", {}) || {};   // pre-hydration / no-IDB fallback
    return hotspotStoreMem;
  }
  function saveHotspotStore(store) {
    hotspotStoreMem = store;
    if (window.AppIDB && AppIDB.available()) AppIDB.put("ebirdHotspots", store).catch(function () {});
    else window.GeoState.save({ ebirdHotspots: store });
    return store;
  }
  function hydrateHotspotStore() {
    if (!(window.AppIDB && AppIDB.available())) return Promise.resolve();
    return AppIDB.get("ebirdHotspots").then(function (m) {
      var mem = (m && typeof m === "object") ? m : {};
      // One-time migration: fold the legacy localStorage copy in, then drop it.
      var old = window.GeoState.get("ebirdHotspots", null);
      if (old && Object.keys(old).length) {
        Object.keys(old).forEach(function (id) { if (!mem[id]) mem[id] = old[id]; });
        AppIDB.put("ebirdHotspots", mem).catch(function () {});
        window.GeoState.save({ ebirdHotspots: null });
      }
      // Keep anything fetched before hydration finished.
      if (hotspotStoreMem) Object.keys(hotspotStoreMem).forEach(function (id) { mem[id] = hotspotStoreMem[id]; });
      hotspotStoreMem = mem;
      if (getHotspotsLayer() && getHotspotsLayer()._reload) getHotspotsLayer()._reload();   // redraw with the full store
    }).catch(function () {});
  }
  // eBird birding hotspots as clickable markers (name + all-time species count +
  // last-seen). Uses the user's eBird key; panning fetches new areas and MERGES them
  // into the persistent store, then all cached hotspots are (re)drawn.
  function ebirdHotspotLayer() {
    // Same as the best-sites layer: a redraw clears every marker, and a popup's
    // autoPan schedules one — so hold still while a popup is open (see openCards).
    var grp = L.layerGroup(), active = false, tok = 0, openCards = 0, pendingDraw = false;
    ensureSpotsPane();
    var store = loadHotspotStore();          // locId → { locId, locName, lat, lng, numSpeciesAllTime, latestObsDt, ts }
    var lastCtx = { capped: false, c: null, dist: 0 };
    // Which ~0.25° grid cells were fetched this session (1 h TTL) so panning back
    // over an area doesn't re-query eBird — the hotspots are already in the store.
    var fetched = {}, fetchedOrder = [];
    function hsKey(lat, lng, dist) { return (Math.round(lat * 4) / 4) + "," + (Math.round(lng * 4) / 4) + ":" + dist; }
    function markFetched(k) {
      fetched[k] = Date.now(); fetchedOrder.push(k);
      while (fetchedOrder.length > 200) { var old = fetchedOrder.shift(); if (fetchedOrder.indexOf(old) < 0) delete fetched[old]; }
    }
    function mergeRows(rows) {
      var now = Date.now(), changed = false;
      (rows || []).forEach(function (h) {
        if (!h || h.locId == null || h.lat == null || h.lng == null) return;
        store[h.locId] = { locId: h.locId, locName: h.locName || "", lat: h.lat, lng: h.lng,
          numSpeciesAllTime: h.numSpeciesAllTime || 0, latestObsDt: h.latestObsDt || "", ts: now };
        changed = true;
      });
      if (changed) store = saveHotspotStore(store);
    }
    // eBird's own figures for the hotspot: numSpeciesAllTime (every species ever
    // reported there) and latestObsDt (the date of the most recent observation
    // submitted there) — both labelled, so the bare date can't be misread.
    function hotspotMeta(h) {
      var n = h.numSpeciesAllTime || 0;
      var sp = h.numSpeciesAllTime != null ? " · " + t("hs.totalSpecies", { n: n }) : "";
      var last = h.latestObsDt ? " · " + t("hs.lastObs", { d: String(h.latestObsDt).slice(0, 10) }) : "";
      return sp + last;
    }
    function makeHotspotMarker(h) {
      var n = h.numSpeciesAllTime || 0;
      // The all-time species count sits INSIDE the dot as small text; the dot keeps
      // growing with the count as before, but never smaller than its digits need.
      var rad = 4 + Math.min(7, Math.round(n / 40));
      var txt = n > 0 ? String(n) : "";
      var D = Math.max(2 * rad + 2, Math.ceil(8 + 5.5 * txt.length));
      var F = Math.max(7, Math.min(10, Math.round(D / 2) - 2));
      var m = L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: "hs-div", html: '<span class="hs-mk" style="width:' + D + 'px;height:' + D + 'px;font-size:' + F + 'px">' + txt + "</span>", iconSize: [D, D], iconAnchor: [D / 2, D / 2] }),
        keyboard: false, pane: "spotsPane"
      });
      m.bindTooltip("<b>" + escapeHtml(h.locName || "") + "</b><span class='area-tip-sub'>" + escapeHtml(hotspotMeta(h)) + "</span>", { direction: "top", className: "area-tip" });
      // Build the popup lazily (only when clicked) — with up to a few thousand cached
      // hotspots drawn, eagerly creating a popup DOM per marker would be wasteful.
      m.bindPopup(function () {
        var meta = hotspotMeta(h);
        var pop = document.createElement("div"); pop.className = "map-choose hs-popup";
        var hd = document.createElement("div"); hd.className = "hs-pop-head";
        // Card layout: bold name (scaled to fit on popupopen); a species/visit +
        // visits line from the Best-sites dataset when a site record lies within
        // 300 m (looked up in loaded tiles, else the covering tile is fetched and
        // the line fills in); then the eBird meta (species total · last obs).
        hd.innerHTML = "<b>" + escapeHtml(h.locName || "") + "</b>" +
          "<span class='hs-pop-main'></span>" +
          (meta ? "<span class='hs-pop-sub'>" + escapeHtml(meta.replace(/^ · /, "")) + "</span>" : "");
        var mainEl = hd.querySelector(".hs-pop-main");
        function fillAvg() {
          var bs2 = bestSiteNear(h.lat, h.lng);
          if (bs2 && mainEl) mainEl.textContent = bestAvgLine(bs2);
          return !!bs2;
        }
        if (!fillAvg()) {
          fetchBestSiteIndex().then(function (idx) {
            var lvl = bestSiteLevel(), k = bestTileKeyForPoint(idx, lvl, h.lat, h.lng);
            return k ? fetchBestSiteTile(lvl, k) : null;
          }).then(fillAvg).catch(function () {});
        }
        pop.appendChild(hd);
        pop.appendChild(makePopupBtn("eBird ↗", "btn-light", function () { m.closePopup(); openExternal("https://ebird.org/hotspot/" + h.locId); }));
        // The hotspot's full species list on eBird (public page, no login needed).
        pop.appendChild(makePopupBtn(t("hs.spList") + " ↗", "btn-light", function () { m.closePopup(); openExternal("https://ebird.org/hotspot/" + encodeURIComponent(h.locId) + "/bird-list"); }));
        // The app's standard icon pair: navigate in Google Maps + add to route.
        var irow = document.createElement("div"); irow.className = "hs-pop-icons";
        function hsIco(icon, title, fn) {
          var b = document.createElement("button");
          b.type = "button"; b.className = "btn-light ico-btn hs-ico-btn";
          b.title = title; b.setAttribute("aria-label", title);
          b.innerHTML = ico(icon);
          b.addEventListener("click", fn);
          return b;
        }
        irow.appendChild(hsIco("dotsplus", t("locmenu.add"), function () {
          // Save the hotspot as a map point: the full editor, name prefilled.
          m.closePopup();
          openPointEditor({ lat: h.lat, lon: h.lng, name: h.locName || "" });
        }));
        irow.appendChild(hsIco("nav", t("nav.title"), function () { m.closePopup(); navigatePoints([{ lat: h.lat, lon: h.lng }]); }));
        irow.appendChild(hsIco("navplus", tLabel("route.add"), function () { m.closePopup(); addToRoute(h.lat, h.lng, h.locName || ""); }));
        pop.appendChild(irow);
        return pop;
      }, { closeButton: true, className: "choose-popup", offset: [0, -4] });
      // Observation dots draw ABOVE the hotspot disc (spotsPane) and take their
      // own clicks — the disc only gets the click where no dot covers it. The
      // disc's OWN click must not fall through to the map though: without this
      // guard the map-click pipeline (species-at-point in Recent mode) also runs,
      // closing the just-opened popup and kicking off a heavy inference.
      m.on("click", function (e) {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        setMapClickGuard(Date.now() + 300);
      });
      wireSpotFan(m);   // overlapping spot markers fan out on hover
      wireFitPopupTitle(m);   // scale the card title to the card width
      m.on("popupopen", function () { openCards++; });
      m.on("popupclose", function () {
        openCards = Math.max(0, openCards - 1);
        if (!openCards && pendingDraw) { pendingDraw = false; drawAllHotspots(lastCtx.capped, lastCtx.c, lastCtx.dist); }
      });
      return m;
    }
    // Redraw the cached hotspots in the CURRENT VIEW passing the min-species filter,
    // best-first up to the "Max hotspots shown" cap — a gradual reveal: at wide zoom
    // only the strongest localities claim the slots; zooming in shrinks the viewport
    // so smaller-but-good spots surface. Redrawn on every moveend (pan AND zoom).
    function drawAllHotspots(capped, c, dist) {
      if (openCards) { pendingDraw = true; return; }   // an open card owns its marker
      grp.clearLayers();
      if (getMap().getZoom() < hotspotZoomFrom()) return;   // below the user-set visibility zoom
      var minSp = hotspotMin(), maxN = hotspotMax(), shown = 0;
      var vb = getMap().getBounds().pad(0.1);
      var cand = [];
      Object.keys(store).forEach(function (id) {
        var h = store[id]; if (!h || h.lat == null || h.lng == null) return;
        if (minSp && (h.numSpeciesAllTime || 0) < minSp) return;
        if (!vb.contains([h.lat, h.lng])) return;   // only the view's hotspots compete for slots
        cand.push(h);
      });
      if (maxN && cand.length > maxN) {
        cand.sort(function (a, b) { return (b.numSpeciesAllTime || 0) - (a.numSpeciesAllTime || 0); });
        cand.length = maxN;
      }
      cand.forEach(function (h) { grp.addLayer(makeHotspotMarker(h)); shown++; });
      // eBird caps a query at 500 km, so a bigger view only covered a 500 km radius
      // round the centre — draw that boundary so the partial fetch is clear.
      if (capped && c) grp.addLayer(L.circle([c.lat, c.lng], { radius: dist * 1000, color: "#8a4b12", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }));
      if (capped) setStatus(t("layer.hotspotsCapped"));
      else if (!shown) setStatus(t("layer.hotspotsNone"));
    }
    function load() {
      if (getMap().getZoom() < hotspotZoomFrom()) { grp.clearLayers(); return; }   // gated → don't fetch either
      var key = ebirdKey();
      if (!key) { grp.clearLayers(); setStatus(t("layer.hotspotsKey")); return; }
      var c = getMap().getCenter();
      var dist = 500;       // fixed 500 km radius around the view centre (eBird ref/hotspot/geo max)
      var capped = false;   // 500 km is eBird's max; hotspots accumulate as you pan
      lastCtx = { capped: capped, c: c, dist: dist };
      var ck = hsKey(c.lat, c.lng, dist);
      // This cell was already fetched recently → its hotspots are in the store; just
      // redraw the full accumulated set (no re-query).
      if (fetched[ck] && (Date.now() - fetched[ck]) < 3600000) { drawAllHotspots(capped, c, dist); return; }
      var mine = ++tok;
      var url = "https://api.ebird.org/v2/ref/hotspot/geo?lat=" + c.lat.toFixed(4) + "&lng=" + c.lng.toFixed(4) + "&dist=" + dist + "&fmt=json";
      overlayBusy(t("layer.hotspots"), true);   // blinking overlay button / panel row (status text only on failure)
      fetch(url, { headers: { "X-eBirdApiToken": key } })
        .then(function (r) { if (!r.ok) { var er = new Error("HTTP " + r.status); er.status = r.status; throw er; } return r.json(); })
        .then(function (rows) {
          overlayBusy(t("layer.hotspots"), false);
          if (mine !== tok || !active) return;
          markFetched(ck);
          mergeRows(rows);
          drawAllHotspots(capped, c, dist);
        }).catch(function (e) {
          overlayBusy(t("layer.hotspots"), false);
          if (!active) return;
          drawAllHotspots(capped, c, dist);   // keep showing the cached hotspots even if this fetch failed
          // 401/403 = eBird rejected the key (invalid/expired). Point the user at it
          // rather than showing a raw "HTTP 403".
          if (e.status === 401 || e.status === 403) setStatus(t("layer.hotspotsKeyBad"), true);
          else setStatus(t("status.error", { msg: "eBird hotspots " + e.message }), true);
        });
    }
    grp._reload = function () { if (active) { store = loadHotspotStore(); drawAllHotspots(lastCtx.capped, lastCtx.c, lastCtx.dist); } };   // setting change / store hydration → re-filter, no refetch
    grp.on("add", function () {
      active = true; getMap().attributionControl.addAttribution(EBIRD_HS_ATTR);
      store = loadHotspotStore();
      drawAllHotspots(false, null, 0);   // show cached hotspots instantly…
      load();                            // …then fetch the current view and accumulate
    });
    grp.on("remove", function () { active = false; getMap().attributionControl.removeAttribution(EBIRD_HS_ATTR); });
    // An open hotspot card freezes the redraw; if the user pans its dot out of view, close it
    // so the dots refresh for the new area (same as best sites).
    getMap().on("moveend", function () {
      if (!active) return;
      if (openCards) {
        var vb = getMap().getBounds();
        grp.eachLayer(function (m) { if (m.isPopupOpen && m.isPopupOpen() && m.getLatLng && !vb.contains(m.getLatLng())) m.closePopup(); });
      }
      load();
    });
    return grp;
  }


  return {
    init: init,
    // ---- layer factories ----
    birdingSpotsLayer: birdingSpotsLayer,
    bestSitesLayer: bestSitesLayer,
    ebirdHotspotLayer: ebirdHotspotLayer,
    // ---- settings-backed knobs ----
    birdSpotMax: birdSpotMax, birdSpotZoomFrom: birdSpotZoomFrom,
    bestSiteMax: bestSiteMax, bestSiteZoomFrom: bestSiteZoomFrom,
    bestSiteMetric: bestSiteMetric, bestSiteLevel: bestSiteLevel,
    bestSiteLevelPref: bestSiteLevelPref, bestSiteLevelLabel: bestSiteLevelLabel,
    hotspotMin: hotspotMin, hotspotMax: hotspotMax, hotspotZoomFrom: hotspotZoomFrom,
    // ---- caches / stores ----
    loadBirdStore: loadBirdStore, clearBirdSpotCache: clearBirdSpotCache,
    clearBestSiteCache: clearBestSiteCache,
    loadHotspotStore: loadHotspotStore, hydrateHotspotStore: hydrateHotspotStore,
    clearHotspotStore: function () { hotspotStoreMem = {}; },
    // ---- shared helpers ----
    overpassPost: overpassPost, clearSpotFan: clearSpotFan,
    // Fan out the site markers covered by an observation dot (marker level, one
    // fan item per covered best-site badge / hotspot disc / birding-spot icon).
    fanSpotsAt: function (lat, lon) { try { openSpotFanAt(L.latLng(lat, lon), 1); } catch (e) {} },
    pointModelCurves: pointModelCurves, modelYearChartSvg: modelYearChartSvg,
    // live layer refs (the settings ⚙ re-rank hooks read these to _reload)
    bestSitesRef: function () { return bestSitesLayerRef; },
    birdSpotsRef: function () { return birdSpotsLayerRef; },
  };
})();
