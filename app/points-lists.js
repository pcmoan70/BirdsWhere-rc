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
      looksLikeHtml, makePopupBtn, modalPrompt, mpTipHtml, openExternal, openPointEditor,
      refreshMpPanel, renderMpAdmin, setStatus, showDetRowMenu, syncListDetections,
      updateDetSetOverlays, updateMpBadge, updateSpDistances, t;
  // … and accessors for app state that is replaced at runtime (the map and the
  // clicked-spot marker are built later; the spider layer is app.js's).
  var getMap, getMarker, getSpiderHidden, setSpiderLayer;

  function init(ctx) {
    clearSpider = ctx.clearSpider; detRenderer = ctx.detRenderer; detStarMarker = ctx.detStarMarker;
    downloadCsv = ctx.downloadCsv; escapeHtml = ctx.escapeHtml; haversineKm = ctx.haversineKm;
    ico = ctx.ico; looksLikeHtml = ctx.looksLikeHtml; makePopupBtn = ctx.makePopupBtn;
    modalPrompt = ctx.modalPrompt; mpTipHtml = ctx.mpTipHtml; openExternal = ctx.openExternal;
    openPointEditor = ctx.openPointEditor; refreshMpPanel = ctx.refreshMpPanel;
    renderMpAdmin = ctx.renderMpAdmin; setStatus = ctx.setStatus; showDetRowMenu = ctx.showDetRowMenu;
    syncListDetections = ctx.syncListDetections; updateDetSetOverlays = ctx.updateDetSetOverlays;
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
      '<p class="cu-hint">' + esc(t("points.editListHint")) + "</p>" +
      '<div class="kml-actions"><button type="button" id="ce-save" class="demo-btn">' + esc(t("points.save")) + "</button></div>" +
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
  function mpParseTags(s) {
    return String(s || "").split(",").map(function (t) { return t.trim(); }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
  }
  function mpUid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function loadMapPoints() {
    mapPoints = (window.GeoState.get("mapPoints", []) || []).filter(function (p) { return p && isFinite(p.lat) && isFinite(p.lon); });
    mpFilter = window.GeoState.get("mapPointsFilter", []) || [];
    mpCollections = (window.GeoState.get("mapPointSets", []) || []).filter(function (c) { return c && c.name; });
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
      window.GeoState.save({ mapPoints: [], mapPointSetActive: "", mapPointSets: mpCollections, mapPointsShownColls: Object.keys(shownColls) });
    }
  }
  // Persist a patch and, if the write hit the localStorage quota (lastSaveOk false),
  // surface a storage-full toast — otherwise these bulky collections (map points /
  // lists / blogs) fail silently and are gone on reload. Mirrors persistDetSet.
  function saveChecked(patch) {
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
  function buildPointsKml() {
    var xml = function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var loose = mpActiveName ? [] : mapPoints;
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
    mpCollections.forEach(function (c) {
      parts.push("<Folder><name>" + xml(c.name) + "</name>");
      (c.points || []).forEach(placemark);
      parts.push("</Folder>");
    });
    loose.forEach(placemark);
    parts.push("</Document>", "</kml>");
    return parts.join("\n");
  }
  function pointsHasAny() {
    return (mpActiveName ? 0 : mapPoints.length) + mpCollections.reduce(function (n, c) { return n + ((c.points && c.points.length) || 0); }, 0);
  }
  function exportPointsKml() {
    if (!pointsHasAny()) { setStatus(t("points.exportEmpty")); return; }
    downloadCsv("map_points_" + new Date().toISOString().slice(0, 10) + ".kml", buildPointsKml());
  }
  // GeoJSON export/import — a lossless, JSON-native alternative to KML so a user can
  // download and keep their points/lists as a standard file: name, tags, note, colour
  // and species key survive in each feature's properties; the saved-list name goes in
  // "list". (KML flattens these into folders + description; GeoJSON keeps them exact.)
  function buildPointsGeoJson() {
    var loose = mpActiveName ? [] : mapPoints, feats = [];
    function feat(p, listName) {
      var props = {};
      if (p.name) props.name = p.name;
      if (p.tags && p.tags.length) props.tags = p.tags.slice();
      if (p.note) props.note = p.note;
      if (p.noteHtml) props.noteHtml = true;
      if (p.color) props.color = p.color;
      if (p.spKey) props.spKey = p.spKey;
      if (p.spColor) props.spColor = p.spColor;
      if (p.date) props.date = p.date;
      if (listName) props.list = listName;
      return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [+(+p.lon).toFixed(6), +(+p.lat).toFixed(6)] } };
    }
    mpCollections.forEach(function (c) { (c.points || []).forEach(function (p) { if (isFinite(+p.lat) && isFinite(+p.lon)) feats.push(feat(p, c.name)); }); });
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
  function startGeoJsonImport(text) {
    var parsed; try { parsed = parseGeoJsonText(text); } catch (e) { setStatus(t("kml.parseErr")); return; }
    if (!parsed.marks.length) { setStatus(t("kml.none")); return; }
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
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
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
  function parseKmlText(text) {
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error(t("kml.parseErr"));
    var marks = [], fieldSet = {}, folderSet = {};
    var pms = doc.getElementsByTagName("Placemark");
    function txt(el, tag) { var n = el.getElementsByTagName(tag)[0]; return n ? (n.textContent || "").trim() : ""; }
    for (var i = 0; i < pms.length; i++) {
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
      marks.push({ name: txt(pm, "name"), lat: lat, lon: lon, desc: txt(pm, "description"), data: data, folder: folder });
    }
    return { marks: marks, fields: Object.keys(fieldSet), folders: Object.keys(folderSet) };
  }
  // Resolve a placemark field to text given a mapping token: "name" / "desc" /
  // "folder" / "data:<key>" / "" (none).
  function kmlFieldValue(pm, token) {
    if (!token) return "";
    if (token === "name") return pm.name || "";
    if (token === "desc") return pm.desc || "";
    if (token === "folder") return pm.folder || "";
    if (token.indexOf("data:") === 0) return (pm.data && pm.data[token.slice(5)]) || "";
    return "";
  }
  var kmlImport = null;   // { marks, fields, folders } currently staged for import
  function startKmlImport(text) {
    var parsed;
    try { parsed = parseKmlText(text); } catch (e) { setStatus(t("kml.parseErr")); return; }
    if (!parsed.marks.length) { setStatus(t("kml.none")); return; }
    kmlImport = parsed;
    openKmlImportDialog();
  }
  // A small modal: choose the target list and which placemark field maps to the
  // point's name / tag / note, then import. Built on demand and removed on close.
  function openKmlImportDialog() {
    var p = kmlImport; if (!p) return;
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
    var listItems = [{ v: "__new__", l: t("detmenu.newList") }].concat(
      mpCollections.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) { return { v: c.name, l: c.name }; }));
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
      '<label class="kml-row">' + escapeHtml(t("kml.target")) + sel("kml-target", listItems, "__new__") + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.nameFrom")) + sel("kml-name", opts([]), defName) + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.tagFrom")) + sel("kml-tag", opts([{ v: "", l: t("kml.fNone") }]), defTag) + "</label>" +
      '<label class="kml-row">' + escapeHtml(t("kml.noteFrom")) + sel("kml-note", opts([{ v: "", l: t("kml.fNone") }]), defNote) + "</label>" +
      '<label class="kml-row kml-check"><input type="checkbox" id="kml-note-html"' + (defHtml ? " checked" : "") + " />" + escapeHtml(t("points.noteHtml")) + "</label>" +
      '<div class="kml-actions"><button type="button" id="kml-do" class="demo-btn">' + escapeHtml(t("kml.import")) + "</button></div>" +
      "</div>";
    var ov = document.createElement("div");
    ov.id = "kml-import-modal"; ov.className = "kml-modal";
    ov.innerHTML = html;
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeKmlImportDialog(); });
    document.getElementById("kml-close").addEventListener("click", closeKmlImportDialog);
    document.getElementById("kml-do").addEventListener("click", doKmlImport);
  }
  function closeKmlImportDialog() { var m = document.getElementById("kml-import-modal"); if (m && m.parentNode) m.parentNode.removeChild(m); }
  function doKmlImport() {
    var p = kmlImport; if (!p) return;
    var target = document.getElementById("kml-target").value;
    var nameTok = document.getElementById("kml-name").value;
    var tagTok = document.getElementById("kml-tag").value;
    var noteTok = document.getElementById("kml-note").value;
    var noteHtmlBox = document.getElementById("kml-note-html");
    var noteIsHtml = !!(noteHtmlBox && noteHtmlBox.checked);
    function finish(listName) {
      var pts = p.marks.map(function (pm) {
        var tag = kmlFieldValue(pm, tagTok).trim();
        var note = kmlFieldValue(pm, noteTok).trim();
        var pt = { id: mpUid(), lat: pm.lat, lon: pm.lon,
          name: kmlFieldValue(pm, nameTok).trim() || pm.name || "",
          tags: tag ? [tag] : [], note: note, source: "kml", createdAt: new Date().toISOString() };
        if (noteIsHtml && note) pt.noteHtml = true;
        return pt;
      });
      var c = mpCollections.filter(function (x) { return x.name === listName; })[0];
      if (!c) { c = { name: listName, points: [] }; mpCollections.push(c); }
      c.points = c.points.concat(pts);
      shownColls[listName] = true; saveShownState();
      saveMapPoints(); renderMapPoints();
      closeKmlImportDialog(); kmlImport = null;
      setStatus(t("kml.imported", { n: pts.length, name: listName }));
    }
    if (target === "__new__") {
      modalPrompt(t("detmenu.newListPrompt"), "").then(function (n) { n = (n || "").trim(); if (n) finish(n); });
    } else finish(target);
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
      if (fromBasket) pop.appendChild(makePopupBtn("🗑 " + t("route.remove"), "demo-btn-light", function () { getMap().closePopup(); removeFromRoute(i); }));
      m.bindPopup(pop, { className: "route-pop-popup" });
      routeLayer.addLayer(m);
    });
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
  function updateRouteChip() {
    if (!routeChipEl) { routeChipEl = document.createElement("div"); routeChipEl.id = "route-chip"; document.body.appendChild(routeChipEl); }
    var route = activeRoute(), fromBasket = routePoints.length > 0;
    if (!route.length) { routeChipEl.style.display = "none"; return; }
    routeChipEl.style.display = "";
    routeChipEl.innerHTML =
      '<span class="route-chip-lbl">' + ico("nav") + "<span>" + escapeHtml(t("route.count", { n: route.length })) + "</span></span>" +
      '<button type="button" class="route-go">' + escapeHtml(t("route.go")) + "</button>" +
      // "Save route" only applies to the live basket; a reloaded saved route is already saved.
      (fromBasket ? '<button type="button" class="route-save">' + escapeHtml(t("route.save")) + "</button>" : "") +
      '<button type="button" class="route-clear" aria-label="' + escapeHtml(t("route.clear")) + '" title="' + escapeHtml(t("route.clear")) + '">×</button>';
    routeChipEl.querySelector(".route-go").addEventListener("click", navigateRoute);
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
  function addMapPoint(p) {
    p.id = p.id || mpUid();
    p.createdAt = p.createdAt || new Date().toISOString();
    mapPoints.push(p);
    saveMapPoints();
    renderMapPoints();
  }
  function updateMapPoint(id, patch) {
    var p = mapPoints.filter(function (x) { return x.id === id; })[0]; if (!p) return;
    Object.assign(p, patch);
    saveMapPoints();
    renderMapPoints();
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
    mapPoints.forEach(function (p) { (p.tags || []).forEach(function (t) { if (t) s[t] = true; }); });
    return Object.keys(s).sort();
  }
  // OR-filter: when no tags active, show everything; otherwise show points
  // whose tag list intersects mpFilter. "(no tag)" is represented by "".
  function mpVisible(p) {
    if (!mpFilter.length) return true;
    var tags = p.tags || [];
    if (!tags.length) return mpFilter.indexOf("") >= 0;
    for (var i = 0; i < tags.length; i++) if (mpFilter.indexOf(tags[i]) >= 0) return true;
    return false;
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
      halo.bindTooltip(mpTipHtml(p), { direction: "top", className: "det-hover-tip" });
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
    var m = p.shared
      ? L.marker([p.lat, p.lon], { icon: mpTriangleIcon(fill), keyboard: false })
      : L.circleMarker([p.lat, p.lon], { radius: 7, color: "#111", weight: 1, opacity: 0.9, fillColor: fill, fillOpacity: editable ? 0.9 : 0.65 });
    m.bindTooltip(mpTipHtml(p), { direction: "top", className: p.spColor ? "det-hover-tip" : "area-tip" });
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
    var d = { name: p.name || "", key: p.spKey || "", lat: p.lat, lon: p.lon, url: p.url || "", date: p.date || "", act: p.act || "", count: p.count, color: p.spColor || "" };
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
    if (group.length <= 1) { mpPinAction(rec); return; }
    spiderOutMp(L.latLng(rec.p.lat, rec.p.lon), group);
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
      fm.bindTooltip(mpTipHtml(o.p), { direction: "top", className: o.p && o.p.spColor ? "det-hover-tip" : "area-tip" });
      fm.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); clearSpider(); mpPinAction(o); });
      layer.addLayer(fm);
    });
    layer.addTo(getMap());
    setSpiderLayer(layer);
  }
  function renderMapPoints() {
    if (!getMap()) return;
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
    mpCollections.forEach(function (c) {
      if (!shownColls[c.name]) return;
      if (routeShows && isRouteColl(c)) return;   // drawn as numbered route stops (renderRoutePoints), not plain pins
      var col = collColor(c);
      (c.points || []).forEach(function (p) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return;
        if (p.spKey) return;   // detection point → detPlot pipeline (handled below)
        renderMpPin(p, false, col);
      });
    });
    syncListDetections();     // merge shown lists' detection points into detPlot
    renderRoutePoints();      // numbered stops for the basket, or a reloaded saved route
    updateRouteChip();        // and its bottom nav bar
    refreshMpPanel();
    updateMpBadge();
  }

  return {
    init: init,
    // ---- points, lists, collections ----
    loadMapPoints: loadMapPoints, saveMapPoints: saveMapPoints, saveChecked: saveChecked,
    saveShownState: saveShownState, addMapPoint: addMapPoint, updateMapPoint: updateMapPoint,
    deleteMapPoint: deleteMapPoint, mpHasUnsaved: mpHasUnsaved, mpVisible: mpVisible,
    mpAllTags: mpAllTags, mpUid: mpUid, mpParseTags: mpParseTags,
    deleteCollection: deleteCollection, isCollProtected: isCollProtected,
    setCollProtected: setCollProtected, isRouteColl: isRouteColl,
    openCollEditModal: openCollEditModal, collColor: collColor,
    // ---- colours ----
    mpHashColor: mpHashColor, mpColorFor: mpColorFor, mpColorRow: mpColorRow,
    mpReadColor: mpReadColor, mpHex6: mpHex6, wireMpColorRow: wireMpColorRow,
    // ---- import / export / share ----
    exportPointsKml: exportPointsKml, exportPointsKmz: exportPointsKmz,
    exportPointsGeoJson: exportPointsGeoJson, extractKmlFromKmz: extractKmlFromKmz,
    startKmlImport: startKmlImport, startGeoJsonImport: startGeoJsonImport,
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
    mpFilter: function () { return mpFilter; },
    setMpFilter: function (v) { mpFilter = v; },
    mpShown: function () { return mpShown; },
    setMpShown: function (v) { mpShown = v; },
    mpLayer: function () { return mpLayer; },
    mpPins: function () { return mpPins; },
    mpCollections: function () { return mpCollections; },
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
