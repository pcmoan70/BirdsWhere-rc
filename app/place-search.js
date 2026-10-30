/**
 * Place search — the map's search box: place names (Nominatim, within the view),
 * coordinates in every common notation (decimal, DMS, UTM, Open Location Code),
 * recent places, and the species search with its probability-ordered matches
 * (Range / Migration shortcuts for a species).
 *
 * Lifted out of app.js byte-for-byte (v2230). app.js still owns the map, the
 * modes and the views, and injects what this module needs through init() —
 * same identifiers as inside the monolith.
 *
 * Exposed as window.AppPlaceSearch (no module system; loaded via <script>).
 */
window.AppPlaceSearch = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var currentViewRestorer, escapeHtml, inGroup, interestingStar, pushViewBack, renderAnalysis,
      selectMapPoint, showRecent, speciesName, stopAnimation, t, weekOfDate;
  // … the other modules' entry points under their app.js names …
  var fcState, renderRangeMap, runInference;
  // … and getters/setters for app state that changes at runtime.
  var getAnalysisTab, getCurrentMode, getLabels, getLabelsByKey, getLang, getMap,
      getMarker, getPlaceMarker, getFEATURED_SPECIES, setAnalysisTab;

  function init(ctx) {
    currentViewRestorer = ctx.currentViewRestorer;
    escapeHtml = ctx.escapeHtml;
    inGroup = ctx.inGroup;
    interestingStar = ctx.interestingStar;
    pushViewBack = ctx.pushViewBack;
    renderAnalysis = ctx.renderAnalysis;
    selectMapPoint = ctx.selectMapPoint;
    showRecent = ctx.showRecent;
    speciesName = ctx.speciesName;
    stopAnimation = ctx.stopAnimation;
    t = ctx.t;
    weekOfDate = ctx.weekOfDate;
    fcState = ctx.fcState;
    renderRangeMap = ctx.renderRangeMap;
    runInference = ctx.runInference;
    getAnalysisTab = ctx.getAnalysisTab;
    getCurrentMode = ctx.getCurrentMode;
    getLabels = ctx.getLabels;
    getLabelsByKey = ctx.getLabelsByKey;
    getLang = ctx.getLang;
    getMap = ctx.getMap;
    getMarker = ctx.getMarker;
    getPlaceMarker = ctx.getPlaceMarker;
    getFEATURED_SPECIES = ctx.getFEATURED_SPECIES;
    setAnalysisTab = ctx.setAnalysisTab;
  }

  // ---- Place (location) search — geocode within the current map view --------
  // Uses Nominatim with a viewbox of the current bounds + bounded=1 so results
  // stay within what's on screen, matching the user's intent.
  // Keep only genuine placenames (settlements, regions, natural features) — drop
  // businesses/POIs (shops, offices, amenities…) and personal/house addresses.
  var PLACE_CATEGORIES = { place: 1, boundary: 1, natural: 1, waterway: 1, water: 1 };
  function isPlaceName(r) {
    if (!r || !PLACE_CATEGORIES[r.category]) return false;
    return r.type !== "house" && r.type !== "houses" && r.type !== "address";
  }
  // Last 5 place-search texts (most-recent first), shown when the box is empty.
  function getRecentPlaces() { return (window.GeoState.get("placeRecent", []) || []).filter(Boolean); }
  function pushRecentPlace(text) {
    text = (text || "").trim(); if (!text) return;
    var a = getRecentPlaces().filter(function (x) { return x.toLowerCase() !== text.toLowerCase(); });
    a.unshift(text);
    window.GeoState.save({ placeRecent: a.slice(0, 5) });
  }
  // Coordinates typed or pasted into the place box → {lat, lon}, or null when the text
  // is not a coordinate pair. Accepts decimal degrees ("59.9139, 10.7522" · "59,9139 10,7522"
  // · "N59.91 E10.75" · "59.91N 10.75E"), degrees-minutes(-seconds) in any symbol style
  // ("59°54'50\"N 10°45'08\"E" · "59 54.83 N, 10 45.13 E" · "59 54 50 10 45 08") and pasted
  // links (…@59.91,10.75… · ?lat=59.91&lon=10.75 · geo:59.91,10.75). Latitude is taken first
  // unless N/S/E/W letters say otherwise, or only the swapped order is in range.
  // Plus codes (Open Location Code, "9F7V2JX8+QF"). A FULL code decodes on its own; a SHORT one
  // ("2JX8+QF", 2/4/6 leading characters dropped) is recovered against a reference — the
  // locality after it ("2JX8+QF Elverum", geocoded in the search box), else the map centre
  // (owner, 2026-10-03).
  var OLC_ALPHA = "23456789CFGHJMPQRVWX";
  var OLC_FULL_RX = /^([23456789CFGHJMPQRVWX]{8})\+([23456789CFGHJMPQRVWX]{2,7})$/i;
  var OLC_SHORT_RX = /^([23456789CFGHJMPQRVWX]{2}|[23456789CFGHJMPQRVWX]{4}|[23456789CFGHJMPQRVWX]{6})\+([23456789CFGHJMPQRVWX]{2,7})(?:\s+(.+))?$/i;
  function olcDecode(code) {
    var c = String(code || "").toUpperCase().replace(/\+/g, ""), lat = -90, lon = -180, latRes = 400, lonRes = 400, i;
    for (i = 0; i + 1 < Math.min(10, c.length); i += 2) {
      latRes /= 20; lonRes /= 20;
      lat += OLC_ALPHA.indexOf(c[i]) * latRes; lon += OLC_ALPHA.indexOf(c[i + 1]) * lonRes;
    }
    for (i = 10; i < c.length; i++) {
      latRes /= 5; lonRes /= 4;
      var v = OLC_ALPHA.indexOf(c[i]); lat += Math.floor(v / 4) * latRes; lon += (v % 4) * lonRes;
    }
    return { lat: lat + latRes / 2, lon: lon + lonRes / 2 };
  }
  function olcEncode10(lat, lon) {   // the 10-digit code (8 + 2) of a point
    lat = Math.max(-90, Math.min(89.999999, lat)); lon = ((lon + 180) % 360 + 360) % 360 - 180;
    var la = lat + 90, lo = lon + 180, out = "", res = 20;
    for (var i = 0; i < 5; i++) {
      var di = Math.floor(la / res), dj = Math.floor(lo / res);
      out += OLC_ALPHA[Math.min(19, di)] + OLC_ALPHA[Math.min(19, dj)];
      la -= di * res; lo -= dj * res; res /= 20;
    }
    return out.slice(0, 8) + "+" + out.slice(8);
  }
  function olcRecover(shortCode, refLat, refLon) {
    var m = OLC_SHORT_RX.exec(String(shortCode || "").trim()); if (!m) return null;
    var pad = 8 - m[1].length, res = Math.pow(20, 2 - pad / 2), half = res / 2;   // 6 chars dropped → 0.05°, 4 → 1°, 2 → 20°
    var full = olcEncode10(refLat, refLon).replace("+", "").slice(0, pad) + m[1].toUpperCase() + "+" + m[2].toUpperCase();
    var xy = olcDecode(full);
    if (xy.lat < refLat - half && xy.lat + res < 90) xy.lat += res; else if (xy.lat > refLat + half && xy.lat - res > -90) xy.lat -= res;
    if (xy.lon < refLon - half) xy.lon += res; else if (xy.lon > refLon + half) xy.lon -= res;
    return xy;
  }
  function parseCoordText(s) {
    s = (s || "").trim();
    if (!s) return null;
    var pc = OLC_FULL_RX.exec(s);
    if (pc) return olcDecode(s);
    var ps = OLC_SHORT_RX.exec(s);
    if (ps && !ps[3]) { var ctr = (typeof getMap() !== "undefined" && getMap()) ? getMap().getCenter() : null; return ctr ? olcRecover(s, ctr.lat, ctr.lng) : null; }
    if (ps) return null;   // a short code WITH a locality: the search box geocodes the locality first
    // UTM with the latitude band: "33V 357344 6731644" (also "33 V 357344E 6731644N", a comma
    // between). Band letters C–M are the southern hemisphere, N–X the northern (owner, 2026-10-01).
    var u = /^(\d{1,2})\s*([C-HJ-NP-X])\s*[,;]?\s*(\d{5,7}(?:\.\d+)?)\s*E?\s*[,;]?\s+(\d{6,8}(?:\.\d+)?)\s*N?$/i.exec(s);
    if (u) return utmToLatLon(+u[1], u[2].toUpperCase() >= "N", +u[3], +u[4]);
    var m = /[?&#](?:lat|latitude)=(-?\d+(?:\.\d+)?)(?:[^\d-]|-(?!\d))*?(?:lon|lng|longitude)=(-?\d+(?:\.\d+)?)/i.exec(s) ||
            /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s) || /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(s);
    if (m) return coordPair([+m[1]], null, [+m[2]], null);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;   // some other link — not coordinates
    // Decimal commas ("59,9139 10,7522"): commas only between digits, no dots, another separator present.
    if (s.indexOf(".") < 0 && /^[^,]*\d,\d[^,]*[;\s][^,]*\d,\d[^,]*$/.test(s)) s = s.replace(/(\d),(\d)/g, "$1.$2");
    s = s.toUpperCase().replace(/[′’´]/g, "'").replace(/[″”]/g, '"').replace(/º|DEG/g, "°");
    var tokRe = /[NSEW](?![A-Z])|-?\d+(?:\.\d+)?\s*[°'"]?/g;
    if (s.replace(tokRe, "").replace(/[,;\s°'"]/g, "") !== "") return null;   // leftover text → a place name
    if (!/[.°'"NSEW]/.test(s)) return null;   // "12 34": bare integers read as text, not a coordinate
    var comps = [], cur = { n: [], h: null }, toks = s.match(tokRe) || [];
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (/^[NSEW]$/.test(tk)) {
        if (cur.n.length) { cur.h = cur.h || tk; comps.push(cur); cur = { n: [], h: null }; }
        else if (comps.length && !comps[comps.length - 1].h) comps[comps.length - 1].h = tk;   // trailing letter after 3 numbers
        else cur.h = tk;   // leading letter: "N59.91"
      } else {
        cur.n.push(parseFloat(tk));
        if (cur.n.length === 3) { comps.push(cur); cur = { n: [], h: null }; }
      }
    }
    if (cur.n.length) comps.push(cur);
    if (comps.length === 1 && !comps[0].h && comps[0].n.length % 2 === 0) {   // "59.91 10.75" / "59 54 10 45"
      var half = comps[0].n.length / 2;
      comps = [{ n: comps[0].n.slice(0, half), h: null }, { n: comps[0].n.slice(half), h: null }];
    }
    if (comps.length !== 2) return null;
    return coordPair(comps[0].n, comps[0].h, comps[1].n, comps[1].h);
  }
  // UTM (WGS84) → {lat, lon}; the standard transverse-Mercator series (Krüger), good to the cm.
  function utmToLatLon(zone, northern, E, N) {
    if (!(zone >= 1 && zone <= 60) || !isFinite(E) || !isFinite(N)) return null;
    var a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), e = Math.sqrt(e2), ep2 = e2 / (1 - e2);
    var x = E - 500000, y = northern ? N : N - 10000000, lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    var M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    var e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    var phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
             + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    var sp = Math.sin(phi1), cp = Math.cos(phi1), tp = Math.tan(phi1);
    var N1 = a / Math.sqrt(1 - e2 * sp * sp), T1 = tp * tp, C1 = ep2 * cp * cp, R1 = a * (1 - e2) / Math.pow(1 - e2 * sp * sp, 1.5), D = x / (N1 * k0);
    var lat = phi1 - (N1 * tp / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24
              + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
    var lon = lon0 + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / cp;
    lat *= 180 / Math.PI; lon *= 180 / Math.PI;
    if (!(lat >= -80 && lat <= 84) || !(lon >= -180 && lon <= 180)) return null;
    return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
  }
  function coordPair(n1, h1, n2, h2) {
    function val(n, h) {
      if (!n.length || n.length > 3) return NaN;
      for (var i = 1; i < n.length; i++) if (n[i] < 0 || n[i] >= 60) return NaN;
      var v = Math.abs(n[0]) + (n[1] || 0) / 60 + (n[2] || 0) / 3600;
      if (n[0] < 0 || (1 / n[0]) < 0 || h === "S" || h === "W") v = -v;
      return v;
    }
    var a = val(n1, h1), b = val(n2, h2);
    if (isNaN(a) || isNaN(b)) return null;
    var lat = a, lon = b;
    if ((h1 === "E" || h1 === "W") || (h2 === "N" || h2 === "S")) { lat = b; lon = a; }   // letters fix the order
    else if (!h1 && !h2 && Math.abs(a) > 90 && Math.abs(b) <= 90) { lat = b; lon = a; }  // "10.75 59.91" → only this order fits
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
    return { lat: lat, lon: lon };
  }
  function wirePlaceSearch() {
    var inp = document.getElementById("place-search");
    var res = document.getElementById("place-results");
    if (!inp || !res) return;
    var selIdx = -1, timer = null, reqTok = 0;
    function showRecent() {
      var a = getRecentPlaces();
      if (!a.length) { res.style.display = "none"; res.innerHTML = ""; return; }
      res.innerHTML = '<div class="sr-recent-head">' + escapeHtml(t("place.recent")) + "</div>" +
        a.map(function (x) { return '<div class="sr-item sr-recent" data-q="' + escapeHtml(x) + '">🕘 ' + escapeHtml(x) + "</div>"; }).join("");
      res.style.display = "block";
      res.querySelectorAll(".sr-recent").forEach(function (el) {
        el.addEventListener("click", function () { inp.value = this.getAttribute("data-q"); inp.focus(); clearTimeout(timer); run(); });
      });
    }
    var run = function () {
      var q = inp.value.trim();
      if (q.length < 2) { showRecent(); return; }   // empty/short → offer the recent searches
      var xy = parseCoordText(q);   // "59.9139, 10.7522" / DMS / UTM / a full plus code / a pasted map link → one direct result, no geocoder
      if (xy) { selIdx = -1; renderPlaceResults(res, [{ lat: xy.lat, lon: xy.lon, display_name: "📍 " + fmtCoordPair(xy) }]); return; }
      var ps = OLC_SHORT_RX.exec(q);
      if (ps && ps[3]) {   // "2JX8+QF Elverum": the locality fixes the area, the short code the spot inside it
        var myS = ++reqTok;
        fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=" + encodeURIComponent(getLang()) + "&q=" + encodeURIComponent(ps[3]), { headers: { Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : []; })
          .then(function (list) {
            if (myS !== reqTok) return;
            var ref = Array.isArray(list) && list[0]; if (!ref) { res.style.display = "none"; return; }
            var rxy = olcRecover(ps[1] + "+" + ps[2], +ref.lat, +ref.lon);
            selIdx = -1; renderPlaceResults(res, [{ lat: rxy.lat, lon: rxy.lon, display_name: "📍 " + ps[1].toUpperCase() + "+" + ps[2].toUpperCase() + " · " + String(ref.display_name || ps[3]).split(",")[0] }]);
          }).catch(function () { if (myS === reqTok) res.style.display = "none"; });
        return;
      }
      var b = getMap().getBounds();
      var vb = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map(function (n) { return n.toFixed(6); }).join(",");
      // bounded=0: the viewbox only BIASES ranking toward the current area — matches
      // anywhere are still returned (a place outside the view isn't dropped), so the
      // search is forgiving of loose / partial names and off-screen places.
      var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=25&addressdetails=0&bounded=0&viewbox=" +
        vb + "&accept-language=" + encodeURIComponent(getLang()) + "&q=" + encodeURIComponent(q);
      var my = ++reqTok;
      fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (list) {
          if (my !== reqTok) return;   // a newer query superseded this one
          selIdx = -1;
          renderPlaceResults(res, (Array.isArray(list) ? list : []).filter(isPlaceName).slice(0, 8));
        })
        .catch(function () { if (my === reqTok) { res.style.display = "none"; } });
    };
    inp.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(run, 350); });
    inp.addEventListener("focus", function () { if (inp.value.trim().length < 2) showRecent(); else if (res.innerHTML) res.style.display = "block"; });
    inp.addEventListener("keydown", function (e) {
      var items = res.querySelectorAll(".sr-item");
      if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min(selIdx + 1, items.length - 1); highlightItem(items, selIdx); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); highlightItem(items, selIdx); }
      else if (e.key === "Enter") {
        e.preventDefault();
        var xy = parseCoordText(inp.value);
        if (selIdx >= 0 && items[selIdx]) items[selIdx].click();
        else if (xy) { pushRecentPlace(inp.value); gotoPlace(xy.lat, xy.lon); res.style.display = "none"; }   // coordinates: Enter goes straight there
        else { clearTimeout(timer); run(); }
      }
      else if (e.key === "Escape") { res.style.display = "none"; }
    });
    document.addEventListener("click", function (e) {
      if (!res.contains(e.target) && e.target !== inp) res.style.display = "none";
    });
  }
  function fmtCoordPair(xy) { return xy.lat.toFixed(5) + "°, " + xy.lon.toFixed(5) + "°"; }
  function renderPlaceResults(res, list) {
    if (!list.length) { res.innerHTML = '<div class="sr-empty">' + escapeHtml(t("place.none")) + "</div>"; res.style.display = "block"; return; }
    res.innerHTML = list.map(function (r) {
      return '<div class="sr-item" data-lat="' + (+r.lat) + '" data-lon="' + (+r.lon) + '">' + escapeHtml(r.display_name || "") + "</div>";
    }).join("");
    res.style.display = "block";
    res.querySelectorAll(".sr-item").forEach(function (el) {
      el.addEventListener("click", function () {
        var inp = document.getElementById("place-search");
        if (inp) pushRecentPlace(inp.value);   // remember the text that led to a chosen place
        gotoPlace(+el.dataset.lat, +el.dataset.lon, el.textContent);
        res.style.display = "none";
      });
    });
  }
  // Pan to a found place and drop the same interactive pin a map click makes
  // (with the Species list / Checklist options, or the mode's action). Close
  // the search panel so the pin's popup is unobstructed.
  function gotoPlace(lat, lon, label) {
    if (!isFinite(lat) || !isFinite(lon) || !getMap()) return;
    getMap().panTo([lat, lon]);
    var pan = document.querySelector(".place-search-panel");
    if (pan) pan.style.display = "none";
    var btn = document.querySelector(".place-search-btn");
    if (btn) btn.classList.remove("is-open");
    selectMapPoint(lat, lon, true);   // quiet: pointer only, no point popup
  }

  // Per-species probabilities at the current map centre/week, used to rank the
  // species search by local likelihood. Computed lazily (one inference) and
  // cached; a centre/week change triggers a recompute that refreshes the
  // open dropdown (also re-run on map moveend).
  var searchProbs = null, searchProbsKey = null, searchProbsPending = null;
  function searchKeyNow() {
    if (!getMap()) return null;
    var c = getMap().getCenter();
    return c.lat.toFixed(2) + "," + c.lng.toFixed(2) + ":" + (document.getElementById("week-select") || {}).value;
  }
  function searchProbsCurrent() {
    var key = searchKeyNow();
    if (searchProbs && searchProbsKey === key) return searchProbs;
    if (key && searchProbsPending !== key) {
      searchProbsPending = key;
      var c = getMap().getCenter(), wk = +document.getElementById("week-select").value;
      runInference(new Float32Array([c.lat, c.lng, wk]), 1).then(function (out) {
        searchProbs = out; searchProbsKey = key; searchProbsPending = null;
        var inp = document.getElementById("species-search"), res = document.getElementById("species-results");
        if (inp && res && res.style.display === "block") showSearch(inp, res);
      }).catch(function () { searchProbsPending = null; });
    }
    return null;
  }

  function showSearch(inputEl, resultsEl) {
    var q = inputEl.value.trim().toLowerCase();
    var probs = searchProbsCurrent();   // rank by likelihood at the map centre
    var matches;
    if (q.length === 0) {
      matches = getFEATURED_SPECIES().map(function (f) { return getLabelsByKey()[f.key]; })
        .filter(Boolean).filter(function (l) { return inGroup(l.index); });
    } else {
      matches = getLabels().filter(function (l) {
        if (!inGroup(l.index)) return false;
        return speciesName(l).toLowerCase().includes(q) ||
               l.common.toLowerCase().includes(q) ||
               l.sci.toLowerCase().includes(q) || l.key.includes(q);
      });
    }
    if (probs) matches.sort(function (a, b) { return (probs[b.index] || 0) - (probs[a.index] || 0); });
    matches = matches.slice(0, 30);
    resultsEl.innerHTML = matches.map(function (l) {
      return '<div class="sr-item" data-key="' + l.key + '">' + interestingStar(l.key) + escapeHtml(speciesName(l)) + ' <span class="sr-sci">' + escapeHtml(l.sci) + '</span></div>';
    }).join("");
    resultsEl.style.display = matches.length ? "block" : "none";
    resultsEl.querySelectorAll(".sr-item").forEach(function (el) {
      el.addEventListener("click", function () {
        selectSpecies(el.dataset.key);
        inputEl.value = "";
        resultsEl.style.display = "none";
      });
    });
  }

  function highlightItem(items, idx) {
    items.forEach(function (el, i) { el.classList.toggle("active", i === idx); });
    if (items[idx]) items[idx].scrollIntoView({ block: "nearest" });
  }

  // Show the app's own range map for a species: switch to Species Range mode,
  // close any full-screen panel, and select the species (which renders it).
  // Set the week dropdown to the model week of an observation's date (so opening its
  // range/migration lands on the week it was seen). No-op without a valid date.
  function setWeekFromDate(dateStr) {
    if (!dateStr) return;
    var wk = weekOfDate(dateStr); if (!wk || wk < 1 || wk > 48) return;
    var ws = document.getElementById("week-select"); if (ws) ws.value = wk;
    window.GeoState.save({ week: wk });
  }
  function showSpeciesRange(key, dateStr) {
    if (!getLabelsByKey()[key]) return;
    var back = currentViewRestorer();   // where ‹ should return to
    setWeekFromDate(dateStr);   // the map shows the distribution for the observation's week
    var modeEl = document.getElementById("mode-select");
    if (modeEl.value !== "range") { modeEl.value = "range"; modeEl.dispatchEvent(new Event("change", { bubbles: true })); }
    pushViewBack(back, "range");
    var ep = document.getElementById("entry-page"); if (ep) ep.style.display = "none";
    selectSpecies(key);
    if (getMap()) getMap().invalidateSize();
  }

  // The point a per-species migration timeline should be computed at: the open
  // checklist's location, else the placed marker, else the current map centre.
  function migrationPoint() {
    var fp = document.getElementById("field-page");
    if (fp && fp.style.display !== "none" && typeof fcState.fieldLat() === "number") return { lat: fcState.fieldLat(), lon: fcState.fieldLon() };
    if (getMarker()) { var ll = getMarker().getLatLng(); return { lat: ll.lat, lon: ll.lng }; }
    var c = getMap().getCenter(); return { lat: c.lat, lon: c.lng };
  }

  // "Migration": this one species' weekly probability through the year at a
  // single point — i.e. the Migration (barchart) mode's Timeline tab, run at
  // the relevant point and filtered to just this species.
  function showSpeciesMigration(key, dateStr) {
    var lbl = getLabelsByKey()[key];
    if (!lbl) return;
    var back = currentViewRestorer();   // where ‹ should return to
    var detWeek = dateStr ? (weekOfDate(dateStr) || 0) : 0;   // mark the detection week on the timeline
    var pt = migrationPoint();
    var modeEl = document.getElementById("mode-select");
    if (modeEl.value !== "barchart") { modeEl.value = "barchart"; modeEl.dispatchEvent(new Event("change", { bubbles: true })); }
    pushViewBack(back, "migration");
    setAnalysisTab("timeline");
    window.GeoState.save({ analysisTab: getAnalysisTab() });
    document.getElementById("an-filter").value = speciesName(lbl);
    renderAnalysis(pt.lat, pt.lon, detWeek);
  }

  function selectSpecies(key) {
    var lbl = getLabelsByKey()[key];
    if (!lbl) return;
    var el = document.getElementById("species-search");
    el.placeholder = speciesName(lbl) + " (" + lbl.sci + ")";
    el.dataset.selectedKey = key;
    window.GeoState.save({ species: key });
    stopAnimation();
    if (getCurrentMode() === "range") renderRangeMap();
  }

  // (Inference, the prediction cache, the Season cells and the range / richness overlay painting live in inference.js since v2230; aliases at the top of this file.)

  return {
    init: init,
    highlightItem: highlightItem,
    searchProbsCurrent: searchProbsCurrent,
    selectSpecies: selectSpecies,
    showSearch: showSearch,
    showSpeciesMigration: showSpeciesMigration,
    showSpeciesRange: showSpeciesRange,
    wirePlaceSearch: wirePlaceSearch,
  };
})();
