/**
 * Shareable links — encode a point / point-list / detection set into a
 * self-contained URL (deflate + base64url in the hash, never sent to a server)
 * and decode/import it on the receiving side.
 *
 * Lifted out of app.js byte-for-byte (v1263): the codec, the share builders
 * (point · point list · saved detection set · currently-plotted detections),
 * the share-as-file fallback, and the whole import path (open-from-URL, the
 * import dialog, plotting shared detections, filing shared point lists).
 * app.js still owns the map, detections and views, and injects what this
 * module needs through init() — same identifiers as inside the monolith.
 *
 * Exposed as window.AppShare (no module system; loaded via <script>).
 */
window.AppShare = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var clearAllFilters, clearDetections, closeModals, detName, detSets, modalConfirm,
      navClose, onListView, plotSightingsResult, recordFamily, refreshGroupModeOptions,
      saveFamIndex, selectMapPoint, serializeVisibleDetPlot, setPointMarker, setStatus,
      showListView, t, uiDialog, updateSettingsIcon, updateViewToggle, wrapLon,
      mpState, saveMapPoints, saveShownState, renderMapPoints, mpColorFor, collColor, setMpDistOrigin;
  // … and getters/setters for app state that changes at runtime.
  var getMap, getCurrentMode, getDetPlot, getFamIndex, getLabelsByKey, getSpeciesGroup, setSpeciesGroup, getSpLayout, setSpLayout;
  var getCurrentSpView, getWeek, setWeek, seedSightingsCache, renderSpeciesList, getFam, hasBundledFam;

  function init(ctx) {
    clearAllFilters = ctx.clearAllFilters; clearDetections = ctx.clearDetections;
    closeModals = ctx.closeModals; detName = ctx.detName; detSets = ctx.detSets;
    modalConfirm = ctx.modalConfirm; navClose = ctx.navClose; onListView = ctx.onListView;
    plotSightingsResult = ctx.plotSightingsResult; recordFamily = ctx.recordFamily;
    refreshGroupModeOptions = ctx.refreshGroupModeOptions; saveFamIndex = ctx.saveFamIndex;
    selectMapPoint = ctx.selectMapPoint; serializeVisibleDetPlot = ctx.serializeVisibleDetPlot;
    getSpLayout = ctx.getSpLayout; setSpLayout = ctx.setSpLayout;
    getCurrentSpView = ctx.getCurrentSpView; getWeek = ctx.getWeek; setWeek = ctx.setWeek;
    seedSightingsCache = ctx.seedSightingsCache; renderSpeciesList = ctx.renderSpeciesList;
    getFam = ctx.getFam; hasBundledFam = ctx.hasBundledFam;
    setPointMarker = ctx.setPointMarker; setStatus = ctx.setStatus;
    showListView = ctx.showListView; t = ctx.t; uiDialog = ctx.uiDialog;
    updateSettingsIcon = ctx.updateSettingsIcon; updateViewToggle = ctx.updateViewToggle;
    wrapLon = ctx.wrapLon;
    mpState = ctx.mpState; saveMapPoints = ctx.saveMapPoints;
    saveShownState = ctx.saveShownState; renderMapPoints = ctx.renderMapPoints;
    mpColorFor = ctx.mpColorFor; collColor = ctx.collColor; setMpDistOrigin = ctx.setMpDistOrigin;
    getMap = ctx.getMap; getCurrentMode = ctx.getCurrentMode; getDetPlot = ctx.getDetPlot;
    getFamIndex = ctx.getFamIndex; getLabelsByKey = ctx.getLabelsByKey;
    getSpeciesGroup = ctx.getSpeciesGroup; setSpeciesGroup = ctx.setSpeciesGroup;
  }

  // ---- Shareable links -------------------------------------------------------
  // Encode a point / location-list / detection set into a self-contained URL so a
  // recipient sees the embedded data WITHOUT any API keys (nothing is re-fetched).
  // Payload is deflated (CompressionStream, when available) + base64url in the URL
  // hash — the hash is never sent to the server and keeps big sets out of the query.
  function b64urlFromBytes(bytes) {
    var bin = ""; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function bytesFromB64url(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    var bin = atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function encodeShare(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== "undefined") {
      try {
        return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()
          .then(function (buf) { return "1" + b64urlFromBytes(new Uint8Array(buf)); });
      } catch (e) { /* fall through to raw */ }
    }
    return Promise.resolve("0" + b64urlFromBytes(bytes));
  }
  function decodeShare(str) {
    var tag = String(str).charAt(0), bytes = bytesFromB64url(String(str).slice(1));
    if (tag === "1") {
      if (typeof DecompressionStream === "undefined") return Promise.reject(new Error("no-decompress"));
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()
        .then(function (buf) { return JSON.parse(new TextDecoder().decode(new Uint8Array(buf))); });
    }
    return Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)));
  }
  // Fallback for shares too big for a URL: hand the encoded payload over as a small
  // file (native share sheet if available, else download). The recipient opens it
  // with "Import shared file" in the Points panel.
  function shareAsFile(enc, title) {
    var fname = "birdswhere_share-" + fmtDateFile(new Date()) + ".share";
    try {
      var file = new File([enc], fname, { type: "text/plain" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: title || t("share.mapName") }).then(
          function () { setStatus(t("share.fileShared")); },
          function (e) { if (!e || e.name !== "AbortError") shareFileDownload(fname, enc); });
        return;
      }
    } catch (e) {}
    shareFileDownload(fname, enc);
  }
  function fmtDateFile(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function shareFileDownload(fname, text) {
    try {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = fname; document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1500);
      setStatus(t("share.fileSaved"));
    } catch (e) { uiDialog({ message: t("share.copyManual"), input: true, value: text, alert: true }); }
  }
  // Hosts (GitHub Pages / their CDN) reject request URLs longer than ~8 KB with a
  // 414, so a ?s= link past this can't be opened. Under it we hand back the plain
  // pastable string; over it we say so and OFFER the .share file instead.
  var SHARE_URL_MAX = 8100;
  var TINY_MAX = 14000;   // hash-link (#s=) cap — bigger payloads go as the .share file
  // TinyURL asynchronously FLAGS short links whose target is a large opaque
  // base64 blob (messenger link-scanners visit them; flagged links then serve a
  // tinyurl.com interstitial instead of redirecting — "the link doesn't work").
  // Small targets (a point / a small point list) are never flagged in practice,
  // so only those are shortened; anything bigger gets a plain, reliable link.
  var TINY_SAFE = 2000;
  // Shorten a URL via TinyURL's keyless api-create. Resolves to the short URL, or null
  // on offline / failure. NOTE: this sends the URL (incl. the shared data payload) to a
  // third party — see the "Shorten share links" setting's warning.
  function tinyToken() { return String(window.GeoState.get("tinyApiToken", "") || "").trim(); }
  function shortenUrl(url) {
    if (navigator.onLine === false || typeof fetch !== "function") return Promise.resolve(null);
    var fwt = window.AppFetch.fetchWithTimeout;
    var tok = tinyToken();
    // With a personal token: the modern api.tinyurl.com (CORS-enabled) — its links
    // redirect cleanly. The keyless api-create.php is DEPRECATED by TinyURL: its
    // links now bounce through a tinyurl.com notice page first, so it's only the
    // no-token fallback (and doShare only sends small links this way).
    if (tok) {
      return fwt("https://api.tinyurl.com/create", { method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok },
        body: JSON.stringify({ url: url, domain: "tinyurl.com" }) }, 10000)
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) { var u = j && j.data && j.data.tiny_url; return /^https?:\/\/\S+$/.test(u || "") ? u : null; })
        .catch(function () { return null; });
    }
    var api = "https://tinyurl.com/api-create.php?url=" + encodeURIComponent(url);
    return fwt(api, {}, 10000)
      .then(function (r) { return r && r.ok ? r.text() : null; })
      .then(function (txt) { txt = (txt || "").trim(); return /^https?:\/\/\S+$/.test(txt) ? txt : null; })
      .catch(function () { return null; });
  }
  // `rebuild(noUrls)` (optional) re-encodes the SAME share without the per-record
  // verification links — offered as an alternative to the .share file when the
  // link is too long (those links are ~45% of a detection payload).
  function doShare(obj, title, rebuild) {
    function warn() { uiDialog({ message: t("share.failed"), alert: true }); }
    // Too long for a link: offer BOTH ways out — drop the record links (still a
    // link, one tap) or save the full share as a file.
    function offerTooBig(enc) {
      if (!rebuild) return modalConfirm(t("share.tooBigOfferFile")).then(function (ok) { if (ok) shareAsFile(enc, title); });
      return uiDialog({ message: t("share.tooBigChoice"), okLabel: t("share.saveFile"),
        action: { label: t("share.dropLinks"), handler: function () { doShare(rebuild(true), title, null); } } })
        .then(function (ok) { if (ok) shareAsFile(enc, title); });
    }
    encodeShare(obj).then(function (enc) {
      // base64url is query-safe, so no extra encoding is needed.
      var queryUrl = location.origin + location.pathname + "?s=" + enc;
      // Verify the link BEFORE handing it over: parse ?s= back out and decode — if the
      // URL doesn't carry the data intact or it doesn't reconstruct, warn instead.
      var got = ""; try { got = new URLSearchParams(new URL(queryUrl).search).get("s") || ""; } catch (e) {}
      if (got !== enc) { warn(); return; }
      decodeShare(enc).then(function (payload) {
        if (!payload || (!payload.type && !payload.t)) { warn(); return; }
        // Default (query link): pasteable under the host's ~8 kB limit, else the file.
        // The #fragment isn't used here because some share targets strip it.
        function shareQueryOrFile() {
          if (queryUrl.length > SHARE_URL_MAX) offerTooBig(enc);
          else offerShareUrl(queryUrl);
        }
        // TinyURL mode (default-on): shorten SMALL payloads only (see TINY_SAFE).
        // Bigger ones: the plain query link while it fits the host's URL limit,
        // else the direct #s= hash link (the fragment never reaches the host, so
        // no limit applies) — both work without trusting a third party. Falls
        // back to the plain link if shortening fails.
        if (window.GeoState.get("shareTinyUrl", true) !== false) {
          var hashUrl = location.origin + location.pathname + "#s=" + enc;
          // A personal token unlocks shortening for EVERYTHING up to TINY_MAX;
          // keyless (deprecated API, notice page) stays limited to small links.
          if (hashUrl.length <= (tinyToken() ? TINY_MAX : TINY_SAFE)) {
            setStatus(t("share.shortening"));
            shortenUrl(hashUrl).then(function (short) { if (short) offerShareUrl(short); else shareQueryOrFile(); });
            return;
          }
          if (queryUrl.length <= SHARE_URL_MAX) { offerShareUrl(queryUrl); return; }
          if (hashUrl.length <= TINY_MAX) { offerShareUrl(hashUrl); return; }
          offerTooBig(enc);
          return;
        }
        shareQueryOrFile();
      }, warn);
    }).catch(warn);
  }
  function packPoints(list) {
    return (list || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); }).map(function (p) {
      var o = { lat: p.lat, lon: p.lon };
      if (p.name) o.name = p.name;
      if (p.tags && p.tags.length) o.tags = p.tags;
      if (p.note) o.note = p.note;
      if (p.noteHtml) o.noteHtml = true;
      if (p.spKey) o.spKey = p.spKey;
      if (p.spColor) o.spColor = p.spColor;
      if (p.color) o.color = p.color;   // keep the point's on-screen colour so a share looks the same
      if (p.date) o.date = p.date;
      if (p.count != null && p.count !== "") o.count = p.count;
      return o;
    });
  }
  // Is a coordinate inside the current map viewport (what's on screen)? A share only
  // carries what's visible — pan/zoom to frame exactly what you want to send.
  function inMapView(lat, lon) { var b = getMap() && getMap().getBounds(); return !isFinite(+lat) || !isFinite(+lon) ? false : (!b || b.contains([+lat, +lon])); }
  // Share a saved point list (the ONLY way to share user points — via the 🔗 icon
  // next to the list). Each point carries its ON-SCREEN colour (explicit, else the
  // list colour) so it looks the same for the recipient, drawn there as a triangle.
  // Only the points currently ON SCREEN are shared, not the whole list.
  function sharePointList(name) {
    var c = mpState.mpCollections().filter(function (x) { return x.name === name; })[0]; if (!c) return;
    var col = collColor(c);
    var vis = (c.points || []).filter(function (p) { return p && inMapView(p.lat, p.lon); });
    if (!vis.length) { setStatus(t("share.noneVisible")); return; }
    var pts = packPoints(vis.map(function (p) { return Object.assign({}, p, { color: p.color || col || mpColorFor(p) }); }));
    doShare({ v: 1, type: "points", name: name, points: pts }, name);
  }
  // Per-source record-URL prefixes, so a link is stored as just its ID tail (the
  // prefix is re-added on decode) — keeps the "verify" links compact.
  var SRC_URL_PREFIX = {
    eBird: "https://ebird.org/checklist/",
    iNaturalist: "https://www.inaturalist.org/observations/",
    GBIF: "https://www.gbif.org/occurrence/",
    Artsobs: "https://mobil.artsobservasjoner.no/sighting/",
    Artportalen: "https://www.artportalen.se/sighting/",
    BirdWeather: "https://app.birdweather.com/stations/"
  };
  // Numeric record-id tails ride as base36 ("~" marker): GBIF/iNat ids are 9–11
  // decimal digits and make up nearly half the payload — base36 cuts ~35% of it.
  function tail36(tl) { return (/^[1-9]\d{0,14}$/.test(tl)) ? "~" + parseInt(tl, 10).toString(36) : tl; }
  function untail36(tl) { return (tl && tl.charAt(0) === "~") ? String(parseInt(tl.slice(1), 36)) : tl; }
  function urlTail(url, src) {
    url = String(url || ""); if (!url) return "";
    var pfx = SRC_URL_PREFIX[src];
    return (pfx && url.indexOf(pfx) === 0) ? url.slice(pfx.length) : url;   // tail only, else the full url
  }
  function urlFromTail(tail, src) {
    tail = String(tail || ""); if (!tail) return "";
    if (/^https?:\/\//i.test(tail)) return tail;   // a full url was stored
    var pfx = SRC_URL_PREFIX[src]; return pfx ? pfx + tail : tail;
  }
  // Compact share payload for a detections set (v2): dictionaries for species,
  // dates, observers and SOURCES (each unique value stored once), per-observation
  // rows of small integers — [speciesIdx, latΔ, lonΔ, dateIdx, count, observerIdx,
  // sourceIdx] — with ×1e5 (~1 m) integer delta coordinates, plus a parallel `u`
  // array of record-URL tails so the recipient can verify each record at its
  // source. Far smaller than the verbose form and deflates well.
  // Compact share (v3): COLUMNAR — each field is its own array (all species indices,
  // all lat-deltas, …) so deflate finds far more repetition than interleaved rows.
  // Coordinates are ×1e4 (~11 m) integer deltas from a base. Species stored by
  // language-independent KEY + class (recipient localises the name), plus date /
  // observer / source dictionaries and a parallel url-tail column for verification.
  function compactDet(name, detections, noUrls) {
    var sp = [], spI = {}, dt = [], dtI = {}, ob = [], obI = {}, sr = [], srI = {};
    var pl = [], plI = {}, ac = [], acI = {}, nn = [], nnI = {}, fl = [], flI = {}, og = [], ogI = {};
    var cSp = [], cLa = [], cLo = [], cDt = [], cCn = [], cOb = [], cSc = [], urls = [], baseLat = null, baseLon = null;
    var cPl = [], cAc = [], cNt = [], cFl = [], cOg = [], cPc = [], cFz = [];
    function idx(arr, map, v) { if (map[v] == null) { map[v] = arr.length; arr.push(v); } return map[v]; }
    Object.keys(detections || {}).forEach(function (k) {
      var en = detections[k] || {};
      // Per-species: key + FAMILY, and cls/name ONLY for non-model extras — the
      // receiver derives everything else itself (model species' name/class come
      // from its own taxonomy, and every colour is a deterministic function of
      // the family name, which seeds the recipient's family index). Never send
      // what the receiver can calculate.
      var isModel = !!getLabelsByKey()[en.key || k];
      // Family rides along ONLY when the receiver can't derive it: model species
      // in the bundled families.csv map are sent famless — the receiver looks the
      // family (→ colour) up locally, in any language, from the species key.
      var famv = getFam ? getFam(en.key || k) : (getFamIndex()[en.key || k] || "");
      if (isModel && hasBundledFam && hasBundledFam(en.key || k)) famv = "";
      var si = idx(sp, spI, (en.key || k) + "\t" + (isModel ? "" : (en.cls || "")) + "\t\t" + famv + "\t" + (isModel ? "" : (en.name || "")));
      // Row order carries no meaning (the receiver re-aggregates) — sort each
      // species' rows so the per-row index columns (date/observer/place/source)
      // become long runs, which deflate compresses far better than jumbles.
      (en.rows || []).slice().sort(function (a, b) {
        return String(a.date || "").localeCompare(String(b.date || "")) ||
               String(a.observer || "").localeCompare(String(b.observer || "")) ||
               String(a.place || "").localeCompare(String(b.place || "")) ||
               (+a.lat - +b.lat) || (+a.lon - +b.lon);
      }).forEach(function (r) {
        if (r.lat == null || r.lon == null) return;
        if (baseLat == null) { baseLat = Math.round(r.lat * 1e4) / 1e4; baseLon = Math.round(r.lon * 1e4) / 1e4; }
        cSp.push(si);
        cLa.push(Math.round((r.lat - baseLat) * 1e4));
        cLo.push(Math.round((r.lon - baseLon) * 1e4));
        cDt.push((r.date) ? idx(dt, dtI, r.date) : -1);
        cCn.push((r.count != null && r.count !== "") ? +r.count : 0);
        cOb.push((r.observer && String(r.observer).trim()) ? idx(ob, obI, String(r.observer).trim()) : -1);
        cSc.push((r.src) ? idx(sr, srI, r.src) : -1);
        // The rest of the canonical detSlim row — place, activity, note, flags,
        // origin, the coarse-place marker and the position-fuzz radius — so the
        // recipient's rows are IDENTICAL to the sender's and every list/popup
        // renders the same (pooled+indexed; -1 / 0 = absent).
        cPl.push((r.place) ? idx(pl, plI, String(r.place)) : -1);
        cAc.push((r.act) ? idx(ac, acI, String(r.act)) : -1);
        cNt.push((r.note) ? idx(nn, nnI, String(r.note).slice(0, 1000)) : -1);
        cFl.push((r.flags) ? idx(fl, flI, String(r.flags)) : -1);
        cOg.push((r.origin) ? idx(og, ogI, String(r.origin)) : -1);
        cPc.push(r.placeCoarse ? 1 : 0);
        cFz.push((+r.posFuzzM > 0) ? Math.round(+r.posFuzzM) : 0);
        urls.push(noUrls ? "" : tail36(urlTail(r.url, r.src)));
      });
    });
    // lv=1 → the sender was viewing the LIST when they shared, so the recipient
    // opens on the list too rather than always the map; ly carries WHICH list
    // (species table vs the "Per observation" records layout).
    // pt/wk: the sender's list is the per-point "species at location" list — its
    // model columns need the POINT and WEEK, so the recipient can rebuild it with
    // the very same renderSpeciesList call (see importSharedAsPointList).
    var sv = getCurrentSpView ? getCurrentSpView() : null;
    var pt = (sv && sv.mode === "point" && isFinite(+sv.lat) && isFinite(+sv.lon))
      ? [Math.round(sv.lat * 1e5) / 1e5, Math.round(sv.lon * 1e5) / 1e5] : undefined;
    return { v: 5, t: "d", n: name, g: getSpeciesGroup(), lv: onListView() ? 1 : 0, ly: onListView() && getSpLayout ? getSpLayout() : undefined, pt: pt, wk: (pt && getWeek) ? getWeek() : undefined, s: sp.map(function (x) { var p = x.split("\t"); return [p[0], p[1], p[2], p[3] || "", p[4] || ""]; }), d: dt, o: ob, sr: sr,
      p: pl, a: ac, nn: nn, f: fl, og: og,
      b: [baseLat || 0, baseLon || 0], c: { sp: cSp, la: cLa, lo: cLo, dt: cDt, cn: cCn, ob: cOb, sc: cSc, pl: cPl, ac: cAc, nt: cNt, fl: cFl, og: cOg, pc: cPc, fz: cFz }, u: urls };
  }
  function shareDetSet(name) {
    var s = detSets().filter(function (x) { return x.name === name; })[0]; if (!s) return;
    // Only the records currently ON SCREEN, not the whole saved set.
    var dets = {};
    Object.keys(s.detections || {}).forEach(function (k) {
      var e = s.detections[k], rows = (e.rows || []).filter(function (r) { return inMapView(r.lat, r.lon); });
      if (rows.length) dets[k] = { key: e.key, name: e.name, color: e.color, cls: e.cls || "", rows: rows };
    });
    if (!Object.keys(dets).length) { setStatus(t("share.noneVisible")); return; }
    doShare(compactDet(name, dets), name, function (noUrls) { return compactDet(name, dets, noUrls); });
  }
  // Share the detections currently loaded from data sources (the live plot), no
  // need to save them as a trip first. When user-defined map points are also on
  // screen, ask whether to include them — if yes, a combined "m" payload (detections
  // + points) the importer already understands; if no, a detections-only share.
  function shareCurrentDetections() {
    var det = serializeVisibleDetPlot();   // only what's visible on the map right now
    if (!det || !Object.keys(det).length) { setStatus(t("det.none")); return; }
    var name = t("share.detName");
    var pts = packPoints(allShownUserPoints().filter(function (p) { return inMapView(p.lat, p.lon); }));   // on-screen user points
    function detShare(noUrls) { return compactDet(name, det, noUrls); }
    if (!pts.length) { doShare(compactDet(name, det), name, detShare); return; }
    modalConfirm(t("share.inclPoints", { n: pts.length })).then(function (incl) {
      if (incl) doShare({ v: 1, t: "m", n: name, d: compactDet(name, det), p: pts }, name, function (noUrls) { return { v: 1, t: "m", n: name, d: compactDet(name, det, noUrls), p: pts }; });
      else doShare(compactDet(name, det), name, detShare);
    });
  }
  // Every user-defined point currently ON the map: loose working pins + shown
  // saved-list points that aren't detections (list detection points already ride
  // in the detections via detPlot).
  function allShownUserPoints() {
    var out = (mpState.mapPoints() || []).slice();
    (mpState.mpCollections() || []).forEach(function (c) { if (mpState.shownColls()[c.name]) (c.points || []).forEach(function (p) { if (p && !p.spKey) out.push(p); }); });
    return out;
  }
  // Reverse compactDet (v2) back into the { type:"det", name, detections } shape the
  // importer expects; other payloads (v1 / point / points) pass through unchanged.
  function expandShared(obj) {
    if (obj && obj.t === "d" && obj.v >= 2 && obj.v <= 5) return expandDetShare(obj);
    return obj;   // v1 / point / points / map wrapper pass through
  }
  // Rebuild the { type:"det", name, detections } shape from v3 (columnar, ×1e4) or
  // legacy v2 (row-oriented, ×1e5). Species keep KEY + class so detName() localises
  // the name for the recipient; src + record url are restored for verification.
  function expandDetShare(obj) {
    var b = obj.b || [0, 0], baseLat = +b[0] || 0, baseLon = +b[1] || 0, dets = {};
    var v3 = obj.v >= 3, v4 = obj.v >= 4, v5 = obj.v >= 5, SC = v3 ? 1e4 : 1e5, c = obj.c || {};
    var n = v3 ? (c.sp || []).length : (obj.r || []).length;
    for (var i = 0; i < n; i++) {
      var si, laI, loI, di, cnt, oi, ri;
      if (v3) { si = c.sp[i] || 0; laI = c.la[i] || 0; loI = c.lo[i] || 0; di = (c.dt && c.dt[i] != null) ? c.dt[i] : -1; cnt = (c.cn && c.cn[i]) || 0; oi = (c.ob && c.ob[i] != null) ? c.ob[i] : -1; ri = (c.sc && c.sc[i] != null) ? c.sc[i] : -1; }
      else { var row = obj.r[i] || []; si = row[0] || 0; laI = row[1] || 0; loI = row[2] || 0; di = (row[3] == null ? -1 : row[3]); cnt = row[4] || 0; oi = (row[5] == null ? -1 : row[5]); ri = (row[6] == null ? -1 : row[6]); }
      var spx = (obj.s && obj.s[si]) || ["", "", "#888"], key = "s" + si;
      if (!dets[key]) dets[key] = { key: spx[0] || "", cls: spx[1] || "", color: spx[2] || "#888", fam: spx[3] || "", name: spx[4] || "", rows: [] };
      var rr = { lat: baseLat + laI / SC, lon: baseLon + loI / SC };
      if (di >= 0 && obj.d && obj.d[di]) rr.date = obj.d[di];
      if (cnt) rr.count = cnt;
      if (oi >= 0 && obj.o && obj.o[oi]) rr.observer = obj.o[oi];
      var src = (ri >= 0 && obj.sr && obj.sr[ri]) ? obj.sr[ri] : "";
      if (src) rr.src = src;
      var tail = obj.u && obj.u[i]; if (v5) tail = untail36(tail);
      if (tail) rr.url = urlFromTail(tail, src);
      if (v4) {
        // The rest of the canonical detSlim row — the recipient's rows become
        // byte-identical to the sender's, so the same list/popup code shows the
        // same place, note, activity, flags and position-fuzz.
        var pi = (c.pl && c.pl[i] != null) ? c.pl[i] : -1; if (pi >= 0 && obj.p && obj.p[pi]) rr.place = obj.p[pi];
        var ai = (c.ac && c.ac[i] != null) ? c.ac[i] : -1; if (ai >= 0 && obj.a && obj.a[ai]) rr.act = obj.a[ai];
        var ni = (c.nt && c.nt[i] != null) ? c.nt[i] : -1; if (ni >= 0 && obj.nn && obj.nn[ni]) rr.note = obj.nn[ni];
        var fi = (c.fl && c.fl[i] != null) ? c.fl[i] : -1; if (fi >= 0 && obj.f && obj.f[fi]) rr.flags = obj.f[fi];
        var gi = (c.og && c.og[i] != null) ? c.og[i] : -1; if (gi >= 0 && obj.og && obj.og[gi]) rr.origin = obj.og[gi];
        if (c.pc && c.pc[i]) rr.placeCoarse = 1;
        if (c.fz && c.fz[i] > 0) rr.posFuzzM = c.fz[i];
      }
      dets[key].rows.push(rr);
    }
    return { type: "det", name: obj.n || "", group: obj.g || "all", view: obj.lv ? "list" : "map", listLayout: obj.ly || "", pt: (obj.pt && obj.pt.length === 2) ? obj.pt : null, wk: +obj.wk || 0, detections: dets };   // legacy links (no g) → "all", so nothing is group-filtered away
  }
  function uniqueShareName(base, taken) { var n = base, i = 2; while (taken(n)) n = base + " (" + (i++) + ")"; return n; }
  // A shared link should land the recipient ON THE MAP with the shared points visible —
  // the restored session may have left the full-screen species list covering it.
  function ensureMapViewForShare() {
    try { if (onListView()) navClose("page"); } catch (e) {}
    try { closeModals(); } catch (e) {}
    try { updateViewToggle(); } catch (e) {}
  }
  function fitLatLngs(pts) {
    if (!getMap() || !pts.length) return;
    try { getMap().fitBounds(L.latLngBounds(pts).pad(0.2)); } catch (e) {}
  }
  function fitSharedLatLngs(pts) {
    ensureMapViewForShare();
    fitLatLngs(pts);
  }
  // The sender was on the LIST when they shared → open the recipient on the same
  // list. No clicked point rides in a share, so this is the standalone "By
  // observation" page of the plotted (shared) detections. Switch into Species-List
  // mode first (a fresh open lands in Range mode, where the list toggle is unavailable).
  function showSharedList(pts, layout) {
    try { closeModals(); } catch (e) {}
    var modeEl = document.getElementById("mode-select");
    if (modeEl && getCurrentMode() !== "list") { modeEl.value = "list"; try { modeEl.dispatchEvent(new Event("change")); } catch (e) {} }
    // Land on the SAME list the sender shared from (species table vs Per observation).
    if (layout && setSpLayout) try { setSpLayout(layout); } catch (e) {}
    fitLatLngs(pts);   // fit the map behind the list so toggling to Map shows the shared area
    try { showListView(); } catch (e) {}
  }
  // Apply a payload decoded from #s= at boot. Points / detection sets are imported
  // (after a confirm) into the recipient's saved lists, shown, and fitted; a single
  // point just drops a marker and opens its popup.
  // The previously-imported copy of a shared list, matched by name. Only lists
  // that themselves came from a share qualify — a same-named list the user built
  // is never touched.
  function sharedCollByName(nm) {
    return mpState.mpCollections().filter(function (c) {
      return c.name === nm && (c.shared || (c.points || []).some(function (p) { return p && p.shared; }));
    })[0] || null;
  }
  // Add a shared point-list collection (shown); returns { name, updated, ll }.
  // Re-importing the SAME shared list replaces that copy's points instead of
  // stacking up "name (2)" duplicates — so the recipient's list stays equal to
  // the sender's and the two can compare notes point by point.
  function importPointsColl(nm, pts) {
    var mk = function (p) { return Object.assign({}, p, { lat: +p.lat, lon: +p.lon, shared: true }); };
    var ex = sharedCollByName(nm);
    if (ex) {
      ex.points = pts.map(mk); ex.shared = true;
      mpState.shownColls()[nm] = true;
      return { name: nm, updated: true, ll: pts.map(function (p) { return [+p.lat, +p.lon]; }) };
    }
    var name = uniqueShareName(nm, function (x) { return mpState.mpCollections().some(function (c) { return c.name === x; }); });
    // Added as a NEW shown collection alongside whatever's already on the map, and
    // flagged `shared` so the pins render as triangles (see renderMpPin).
    mpState.mpCollections().push({ name: name, shared: true, points: pts.map(mk) });
    mpState.shownColls()[name] = true;
    return { name: name, updated: false, ll: pts.map(function (p) { return [+p.lat, +p.lon]; }) };
  }
  function detRowCount(detections) {
    var n = 0; Object.keys(detections || {}).forEach(function (k) { n += ((detections[k] || {}).rows || []).length; }); return n;
  }
  // Plot shared detections EXACTLY like a self-fetch: rebuild the same `result`
  // shape that a live fetch produces ({agg, extras, …}) and run it through the very
  // same plotSightingsResult pipeline — so the legend and the co-located list build
  // up identically. Model species go in `agg` (localised name), non-model in
  // `extras`. Rows come straight from the link, so NO source is fetched. Returns the
  // [lat,lon] list for fit-to-bounds.
  // The recipient may have leftover legend filters — a species selection, an
  // observer filter, a ★/rare/year/life mode, or a recency/date window — that would
  // hide the imported dots and leave a wrong or empty legend. Clear them all so the
  // shared detections show cleanly. (clearAllFilters also opens the recency window to
  // "All", so historic shared dots aren't hidden by the recipient's default 30-day
  // window, as pinning historic does.) Also switch to the SENDER's species group and
  // seed the family index so dot colours match the sender's exactly.
  function applySharedContext(detections, group) {
    clearAllFilters();
    if (group && group !== getSpeciesGroup()) {
      setSpeciesGroup(group);
      window.GeoState.save({ group: getSpeciesGroup() });
      var gs = document.getElementById("group-select"); if (gs) gs.value = getSpeciesGroup();
      try { updateSettingsIcon(); refreshGroupModeOptions(); } catch (e) {}
    }
    var famChanged = false;
    Object.keys(detections || {}).forEach(function (k) {
      var e = detections[k];
      if (e && e.fam && e.key && recordFamily(e.key, e.fam)) famChanged = true;
    });
    if (famChanged) saveFamIndex();
  }
  // Shared detections → the {agg, extras} shape a live fetchAllSightingsAt resolves
  // with — model species keyed by species key, the rest as extras keyed by sci name.
  function buildSharedAgg(detections) {
    var agg = {}, extras = {}, ll = [], bySrc = {}, total = 0;
    Object.keys(detections || {}).forEach(function (k) {
      var e = detections[k]; if (!e || !e.rows || !e.rows.length) return;
      var spKey = e.key || k, count = 0, latest = 0;
      e.rows.forEach(function (r) {
        var n = parseInt(r.count, 10); count += (isFinite(n) && n > 0) ? n : 1;   // total specimens (no count = 1)
        var ts = Date.parse(String(r.date || "").slice(0, 10) + "T00:00:00"); if (ts && ts > latest) latest = ts;   // local-midnight date
        if (isFinite(+r.lat) && isFinite(+r.lon)) ll.push([+r.lat, +r.lon]);
        if (r.src) bySrc[r.src] = (bySrc[r.src] || 0) + 1;
      });
      total += count;
      if (spKey.indexOf("x:") === 0 || !getLabelsByKey()[spKey]) {   // non-model → extras (keyed by sci)
        var sci = spKey.indexOf("x:") === 0 ? spKey.slice(2) : spKey;
        var ex = extras[sci] || (extras[sci] = { rows: [], count: 0, name: e.name || sci, sci: sci, cls: e.cls || "", latestTs: 0 });
        ex.rows = ex.rows.concat(e.rows); ex.count += count; if (latest > ex.latestTs) ex.latestTs = latest;
      } else {
        var a = agg[spKey] || (agg[spKey] = { rows: [], count: 0, latestTs: 0 });
        a.rows = a.rows.concat(e.rows); a.count += count; if (latest > a.latestTs) a.latestTs = latest;
      }
    });
    return { agg: agg, extras: extras, ll: ll, bySrc: bySrc, total: total };
  }
  function plotSharedDetections(detections, group) {
    applySharedContext(detections, group);
    var b = buildSharedAgg(detections);
    plotSightingsResult({ agg: b.agg, extras: b.extras, bySrc: b.bySrc, failed: [], timedOut: [], group: group || "all" });
    return b.ll;
  }
  // A share made FROM the per-point species list rebuilds that list with the very
  // same routine the sender used: the shared rows are seeded into the sightings
  // cache as a completed fetch result, then renderSpeciesList(point) runs — the
  // identical code path computes the model columns, fills the n(d) counts, plots
  // the dots (map-first flow) and opens the list. No network, no divergence.
  function importSharedAsPointList(obj) {
    var lat = +obj.pt[0], lon = +obj.pt[1];
    applySharedContext(obj.detections, obj.group);
    if (obj.wk >= 1 && obj.wk <= 48 && setWeek) try { setWeek(obj.wk); } catch (e) {}   // the sender's week drives the model columns
    var b = buildSharedAgg(obj.detections);
    seedSightingsCache(lat, lon, { agg: b.agg, extras: b.extras, dedupTotal: b.total, bySrc: b.bySrc, group: obj.group || "all", failed: [], timedOut: [] });
    try { selectMapPoint(lat, lon, true); } catch (e) {}   // the sender's point marker (quiet: no popup)
    if (obj.listLayout && setSpLayout) try { setSpLayout(obj.listLayout); } catch (e) {}
    Promise.resolve(renderSpeciesList(lat, lon)).then(function () { try { showListView(); } catch (e) {} });
    return b.ll;
  }
  // A list-view share with a point context goes through the same-routine rebuild;
  // everything else keeps the plot-then-fit/list flow.
  function showSharedDetections(obj) {
    if (obj.view === "list" && obj.pt && renderSpeciesList && seedSightingsCache) return importSharedAsPointList(obj);
    var ll = plotSharedDetections(obj.detections, obj.group);
    if (obj.view === "list") showSharedList(ll, obj.listLayout); else fitSharedLatLngs(ll);
    return ll;
  }
  // Before importing a share, offer to start from a CLEAN map: remove already-plotted
  // dots (any fetch still in flight keeps running, but its result would repopulate the
  // map, so we also invalidate the current list token). Declining keeps everything —
  // the shared dots simply accumulate on top.
  function maybeClearBeforeShare() {
    if (!getDetPlot() || !Object.keys(getDetPlot()).length) return Promise.resolve();
    return modalConfirm(t("share.clearFirst")).then(function (yes) {
      if (!yes) return;
      var tb = document.getElementById("sp-tbody"); if (tb) tb.dataset.sightingsToken = "";   // orphan in-flight fetches (their late results won't replot)
      clearDetections();
    });
  }
  function importShared(str) {
    decodeShare(str).then(function (raw) {
      // Whole-map share: detections + user points in one payload.
      if (raw && raw.t === "m") {
        var detObj = raw.d ? expandShared(raw.d) : null;
        var mpts = (raw.p || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); });
        var nDet = detObj ? detRowCount(detObj.detections) : 0, nPts = mpts.length;
        if (!nDet && !nPts) { setStatus(t("share.badLink")); return; }
        var mnm = String(raw.n || t("share.mapName"));
        modalConfirm(t("share.importMapPrompt", { d: nDet, p: nPts })).then(function (ok) {
          if (!ok) return;
          maybeClearBeforeShare().then(function () {
            var ll = [];
            if (nPts) { ll = ll.concat(importPointsColl(mnm, mpts).ll); saveMapPoints(); }
            saveShownState(); renderMapPoints();
            if (nDet) {
              // Same-routine rebuild for list-view shares (also opens the list);
              // otherwise plot and fall through to the fit/list below.
              if (detObj.view === "list" && detObj.pt && renderSpeciesList && seedSightingsCache) { importSharedAsPointList(detObj); setStatus(t("share.imported", { name: mnm })); return; }
              ll = ll.concat(plotSharedDetections(detObj.detections, detObj.group));
            }
            // Open the view the sender was on: their list (if they shared from it), else the map.
            if (detObj && detObj.view === "list") showSharedList(ll, detObj.listLayout); else fitSharedLatLngs(ll);
            setStatus(t("share.imported", { name: mnm }));
          });
        });
        return;
      }
      var obj = expandShared(raw);
      if (!obj || !obj.type) { setStatus(t("share.badLink")); return; }
      if (obj.type === "point") {
        var la = Math.max(-90, Math.min(90, +obj.lat)), lo = wrapLon(+obj.lon);
        if (!isFinite(la) || !isFinite(lo)) { setStatus(t("share.badLink")); return; }
        ensureMapViewForShare();
        if (getMap()) getMap().setView([la, lo], Math.max(getMap().getZoom() || 0, 12));
        selectMapPoint(la, lo, true);   // quiet: pointer only, no point popup
        return;
      }
      var nm = String(obj.name || t("share.defaultName"));
      if (obj.type === "points") {
        var pts = (obj.points || []).filter(function (p) { return p && isFinite(+p.lat) && isFinite(+p.lon); });
        if (!pts.length) { setStatus(t("share.badLink")); return; }
        var upd = !!sharedCollByName(nm);   // re-import → update that copy in place
        modalConfirm(t(upd ? "share.updatePrompt" : "share.importPrompt", { name: nm, n: pts.length })).then(function (ok) {
          if (!ok) return;
          var r = importPointsColl(nm, pts); saveMapPoints(); saveShownState(); renderMapPoints();
          fitSharedLatLngs(r.ll); setStatus(t(r.updated ? "share.updated" : "share.imported", { name: r.name }));
        });
        return;
      }
      if (obj.type === "det") {
        var n = detRowCount(obj.detections);
        if (!n) { setStatus(t("share.badLink")); return; }
        modalConfirm(t("share.importPrompt", { name: nm, n: n })).then(function (ok) {
          if (!ok) return;
          maybeClearBeforeShare().then(function () {
            // List-view shares with a point context rebuild the sender's list with the
            // SAME renderSpeciesList routine; map shares plot-and-fit as before.
            showSharedDetections(obj);
            setStatus(t("share.imported", { name: nm }));
          });
        });
        return;
      }
      setStatus(t("share.badLink"));
    }).catch(function () { setStatus(t("share.badLink")); });
  }
  function maybeImportShared() {
    var enc = "";
    try { enc = new URLSearchParams(location.search).get("s") || ""; } catch (e) {}
    if (!enc) { var m = (location.hash || "").match(/[#&]s=([^&]+)/); if (m) enc = m[1]; }   // legacy hash links
    if (!enc) return;
    try { history.replaceState(null, "", location.pathname); } catch (e) {}   // consume it → no re-import on reload
    importShared(enc);
  }
  // ---- Sharing a bare location ------------------------------------------------
  // A point carries nothing but its coordinates, so it gets a PLAIN, readable URL
  // (?lat=&lon=&zoom=) rather than the opaque compressed ?s= payload the richer
  // shares need. It is a third the length, survives being retyped or edited by
  // hand, and a recipient can see where they are being sent before opening it.
  // ?s= links still work — decodeShare stays for detection sets, point lists and
  // whole-map shares.
  function pointShareUrl(lat, lon) {
    var z = getMap() ? Math.round(getMap().getZoom()) : 12;
    return location.origin + location.pathname +
      "?lat=" + (+lat).toFixed(5) + "&lon=" + wrapLon(+lon).toFixed(5) + "&zoom=" + z;
  }
  // Hand a finished link to the user: copy it, and show it in a copyable dialog
  // too (the native share sheet silently dropped long URLs on some devices).
  function offerShareUrl(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { navigator.clipboard.writeText(url).then(function () { setStatus(t("share.copied")); }, function () {}); } catch (e) {}
    }
    uiDialog({ message: t("share.copyManual"), input: true, value: url, alert: true });
  }
  // ?lat=&lon=[&zoom=] on load → go there and drop the point pin, so a shared
  // location opens exactly where it was shared from. Left in the address bar (it
  // is idempotent and bookmarkable), unlike the one-shot ?s= import.
  function maybeOpenSharedPoint() {
    var q; try { q = new URLSearchParams(location.search); } catch (e) { return false; }
    var lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90) return false;
    lat = Math.max(-90, Math.min(90, lat)); lon = wrapLon(lon);
    var z = parseInt(q.get("zoom"), 10);
    if (getMap()) getMap().setView([lat, lon], isFinite(z) && z > 0 ? z : Math.max(getMap().getZoom() || 0, 12));
    setPointMarker(lat, lon);
    setMpDistOrigin(lat, lon);
    return true;
  }

  return {
    init: init,
    sharePointList: sharePointList,
    shareDetSet: shareDetSet,
    shareCurrentDetections: shareCurrentDetections,
    pointShareUrl: pointShareUrl,
    offerShareUrl: offerShareUrl,
    importShared: importShared,
    maybeImportShared: maybeImportShared,
    maybeOpenSharedPoint: maybeOpenSharedPoint,
    detRowCount: detRowCount,
    fmtDateFile: fmtDateFile,
  };
})();
