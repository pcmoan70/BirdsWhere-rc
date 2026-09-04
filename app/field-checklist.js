/**
 * Field checklist — mobile live entry of a birding session, plus its exports.
 *
 * Lifted out of app.js byte-for-byte (v1264): the append-only observation log
 * and its record store, the checklist page renderers (species rows, count /
 * activity / sex pickers, per-entry edit page), photo attachments, the review
 * page with eBird-ready groups, the CSV / eBird-CSV / PDF / print exports, the
 * geolocation watch, the place picker for titles, and the country checklist
 * card. app.js still owns the map, the model outputs and the navigation, and
 * injects what this module needs through init() — same identifiers as inside
 * the monolith. The feature's own state (the open list id, filters, the
 * geo-watch, the entry-edit key) lives HERE now; app.js reads it through the
 * fcState-style accessors at the bottom.
 *
 * Exposed as window.AppField (no module system; loaded via <script>).
 */
window.AppField = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  var buildChecklistItems, closeAnyFullPage, csvEsc, detailedPlaceName, escapeHtml,
      fmtDateFile, haversineKm, ico, inGroup, interestingStar, isBirdKey, isHidden,
      isInteresting, navClose, navOpen, nearbyPlaces, placeKey, recordSpeciesSeen,
      refreshChecklists, runInference, setStatus, speciesName, t, tLabel;
  // … and getters for app state that changes at runtime.
  var getLabels, getLabelsByKey, getLang;

  function init(ctx) {
    buildChecklistItems = ctx.buildChecklistItems; closeAnyFullPage = ctx.closeAnyFullPage;
    csvEsc = ctx.csvEsc; detailedPlaceName = ctx.detailedPlaceName; escapeHtml = ctx.escapeHtml;
    fmtDateFile = ctx.fmtDateFile; haversineKm = ctx.haversineKm; ico = ctx.ico;
    inGroup = ctx.inGroup; interestingStar = ctx.interestingStar; isBirdKey = ctx.isBirdKey;
    isHidden = ctx.isHidden; isInteresting = ctx.isInteresting; navClose = ctx.navClose;
    navOpen = ctx.navOpen; nearbyPlaces = ctx.nearbyPlaces; placeKey = ctx.placeKey;
    recordSpeciesSeen = ctx.recordSpeciesSeen; refreshChecklists = ctx.refreshChecklists;
    runInference = ctx.runInference; setStatus = ctx.setStatus; speciesName = ctx.speciesName;
    t = ctx.t; tLabel = ctx.tLabel;
    getLabels = ctx.getLabels; getLabelsByKey = ctx.getLabelsByKey; getLang = ctx.getLang;
  }

  // ---- the feature's own state (moved with it from app.js) ----------------
  var fieldData = null;       // current probability-ranked species for the field checklist
  var fieldQuery = "";        // fuzzy filter text for the field checklist
  var fieldFilter = "all";    // checklist row filter: "all" | "seen" | "missing"
  var fieldPlaceToken = 0;    // guards against stale field-place lookups
  var fieldLat = 0, fieldLon = 0;   // current field-checklist point
  var fieldKey = null;        // listId (placeKey@day) of the field checklist currently open
  var fieldNameCache = {};    // placeKey -> resolved place name (auto-title for new lists)
  var fieldGeoWatch = null;   // geolocation watch id while a checklist is open
  var fieldGeoLast = null;    // freshest device position {lat,lon,ts} while a checklist is open
  var entryEditKey = null;    // species whose observations the entry-edit page is showing

  function hidePlacePicker() { var p = document.getElementById("place-picker"); if (p) p.style.display = "none"; }
  // Set (and persist for this point) the field-checklist title.
  function setFieldTitle(name) {
    document.getElementById("field-coords").value = name;
    persistFieldTitle((name || "").trim());
  }
  function openPlacePicker() {
    var p = document.getElementById("place-picker"), list = document.getElementById("place-list");
    p.style.display = "block";
    // Section 1: your other checklists — selecting one merges it into this list.
    var lists = buildChecklistItems(getFieldChecklists()).filter(function (it) { return it.pkey !== fieldKey; });
    lists.forEach(function (it) { it.dist = (typeof fieldLat === "number" && it.lat != null) ? haversineKm(fieldLat, fieldLon, it.lat, it.lon) : null; });
    lists.sort(function (a, b) { return (a.dist == null ? Infinity : a.dist) - (b.dist == null ? Infinity : b.dist); });
    var distLabel = function (d) { return d == null ? "" : (d < 1 ? Math.round(d * 1000) + " m" : d.toFixed(1) + " km"); };
    var listsHtml = lists.length ? ('<div class="pp-head">' + escapeHtml(t("ctrl.checklists")) + "</div>" +
      lists.map(function (it) {
        return '<button type="button" class="pp-item pp-merge" data-id="' + escapeHtml(it.pkey) + '">⤭ ' + escapeHtml(it.name) + '<span class="pp-dist">' + distLabel(it.dist) + "</span></button>";
      }).join("")) : "";
    var placesHead = '<div class="pp-head">' + escapeHtml(t("place.nearby")) + "</div>";
    list.innerHTML = listsHtml + placesHead + '<div class="spinner" style="margin:18px auto"></div>';
    nearbyPlaces(fieldLat, fieldLon).then(function (rows) {
      var placesHtml = rows.length ? rows.map(function (r) {
        return '<button type="button" class="pp-item" data-name="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '<span class="pp-dist">' + distLabel(r.dist) + "</span></button>";
      }).join("") : '<p class="recent-none">' + escapeHtml(t("place.none")) + "</p>";
      list.innerHTML = listsHtml + placesHead + placesHtml;
    }).catch(function () { list.innerHTML = listsHtml + placesHead + '<p class="recent-none">' + escapeHtml(t("place.none")) + "</p>"; });
  }

  // ---- Field checklist (mobile live entry) ---------------------------------
  // A checklist is a day-scoped record per location, keyed by placeKey@DAY, and
  // is *built from an append-only observation log*: every sighting (a tick, a
  // count change, or an explicit ＋) appends an entry stamped with its time and
  // coordinates. The visible per-species rows are an aggregation of that log,
  // so no detail (when/where each observation happened) is ever lost.
  //   record = { id, title, lat, lon, day, createdAt, log: [ entry, … ] }
  //   entry  = { ts, lat, lon, key, count, act, note }
  function getFieldChecklists() { return window.GeoState.get("fieldChecklists", {}) || {}; }
  function saveFieldChecklists(o) { window.GeoState.save({ fieldChecklists: o }); }
  function todayStr() { return fmtDateFile(new Date()); }   // same local-date format as fmtDateFile
  function listIdFor(lat, lon, day) { return placeKey(lat, lon) + "@" + (day || todayStr()); }
  function dayOf(rec) { return rec.day || (rec.createdAt ? String(rec.createdAt).slice(0, 10) : todayStr()); }

  // Migrate a legacy {entries:{key:{seen,count,act,note}}} record to the
  // log-based shape, synthesising one log entry per recorded species.
  function migrateFieldRecord(rec, id) {
    if (!rec || rec.log) return rec;
    var ts = rec.createdAt ? (Date.parse(rec.createdAt) || Date.now()) : Date.now();
    var day = rec.createdAt ? String(rec.createdAt).slice(0, 10) : todayStr();
    var log = [], seen = {}, entries = rec.entries || {};
    Object.keys(entries).forEach(function (key) {
      var e = entries[key] || {};
      if (!e.seen && (e.count == null || e.count === "") && !e.act && !e.note) return;
      log.push({ id: "e" + (ts).toString(36) + Math.random().toString(36).slice(2, 6), ts: ts, lat: rec.lat, lon: rec.lon, key: key, count: e.count != null ? +e.count : null, act: e.act || "", note: e.note || "" });
      seen[key] = true;
    });
    return { id: id, title: rec.title || "", lat: rec.lat, lon: rec.lon, day: day, createdAt: rec.createdAt || new Date(ts).toISOString(), log: log, seen: seen };
  }
  function getFieldRecord(id) {
    var all = getFieldChecklists(), rec = all[id], changed = false;
    if (!rec) return null;
    if (!rec.log) { rec = migrateFieldRecord(rec, id); all[id] = rec; changed = true; }
    if (!rec.seen) { rec.seen = {}; rec.log.forEach(function (e) { rec.seen[e.key] = true; }); changed = true; }   // backfill seen flags
    rec.log.forEach(function (e) { if (!e.id) { e.id = "e" + (e.ts || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6); changed = true; } });
    if (changed) { all[id] = rec; saveFieldChecklists(all); }
    return rec;
  }
  function newFieldRecord(id, lat, lon) {
    return { id: id, title: "", lat: lat, lon: lon, day: todayStr(), createdAt: new Date().toISOString(), log: [], seen: {} };
  }
  // The currently open record (optionally creating it on first write).
  function curFieldRecord(create) {
    if (!fieldKey) return null;
    return getFieldRecord(fieldKey) || (create ? newFieldRecord(fieldKey, fieldLat, fieldLon) : null);
  }
  function putFieldRecord(rec) {
    // Give a freshly-recorded list a real place name (not coordinates) as soon
    // as it has content, using the resolved name for its location when known.
    if (!(rec.title || "").trim() && rec.log.length) {
      var nm = fieldNameCache[String(rec.id).split("@")[0]];
      if (nm) rec.title = nm;
    }
    var all = getFieldChecklists();
    var hasSeen = rec.seen && Object.keys(rec.seen).length;
    if (!rec.log.length && !hasSeen && !(rec.title || "").trim()) delete all[rec.id];   // drop empty + untitled
    else all[rec.id] = rec;
    saveFieldChecklists(all);
    refreshChecklists();
  }

  // Sum a (possibly merged, comma-listed) count value numerically.
  function countNum(c) {
    if (c == null || c === "") return 0;
    if (typeof c === "number") return c;
    return String(c).split(/[^0-9.]+/).reduce(function (s, x) { return s + (+x || 0); }, 0);
  }
  // Aggregate a record's log into per-species rows (summed count, latest
  // activity/note, number of distinct observations). Seen is a separate flag.
  function fcAggregate(rec) {
    var agg = {};
    ((rec && rec.log) || []).forEach(function (e) {
      var a = agg[e.key] || (agg[e.key] = { count: 0, n: 0, act: "", note: "", lastTs: -1 });
      a.count += countNum(e.count); a.n++;
      if ((e.ts || 0) >= a.lastTs) { a.lastTs = e.ts || 0; a.act = e.act || ""; a.note = e.note || ""; }
    });
    return agg;
  }
  // Render-shaped view ({key:{seen,count,act,note,n}}) used by exports/badge.
  // `seen` is the checkbox flag (rec.seen), independent of having entries.
  function getFieldEntries() {
    var rec = curFieldRecord(false); if (!rec) return {};
    var agg = fcAggregate(rec), seenSet = rec.seen || {}, out = {};
    Object.keys(agg).forEach(function (k) {
      var a = agg[k], c = a.count > 0 ? a.count : 0;
      out[k] = { seen: !!seenSet[k], count: c > 0 ? c : null, act: a.act || undefined, note: a.note || undefined, n: a.n };
    });
    Object.keys(seenSet).forEach(function (k) { if (!out[k]) out[k] = { seen: true, count: null, n: 0 }; });
    return out;
  }
  // A species' log entries (chronological).
  function fcEntriesFor(rec, key) { return ((rec && rec.log) || []).filter(function (e) { return e.key === key; }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }); }
  function fcIsSeen(key) { var rec = curFieldRecord(false); return !!(rec && rec.seen && rec.seen[key]); }

  // Transient per-species compose draft backing the top-line inputs (count,
  // activity, note); not persisted until committed via ＋ or a first tick.
  var composeDraft = {};
  function cd(key) { return composeDraft[key] || (composeDraft[key] = { count: null, act: "", note: "", sex: "" }); }
  function eid() { return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---- Per-entry photos -----------------------------------------------------
  // Photos attach to a checklist log entry (e.imgs = [imgId, …]). The image data
  // is far too big for localStorage (a phone photo is several MB), so each
  // downscaled JPEG data-URL is stored in IndexedDB under "img:<id>" and the entry
  // keeps only the small id. Local-only — NOT part of the Drive-sync payload.
  function imgId() { return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function imgKey(id) { return "img:" + id; }
  // Lightweight toast for photo add feedback — shown in-page (the status bar is
  // hidden behind the full-screen field page on mobile).
  function photoDbg(msg) {
    try {
      var d = document.getElementById("photo-dbg");
      if (!d) { d = document.createElement("div"); d.id = "photo-dbg"; d.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:99999;background:#0b3a3a;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:pre-wrap;"; document.body.appendChild(d); }
      d.textContent = "📷 " + msg;
      if (d._t) clearTimeout(d._t); d._t = setTimeout(function () { try { d.parentNode.removeChild(d); } catch (e) {} }, 9000);
    } catch (e) {}
  }
  // Decode a picked file, downscale its longest side to maxPx, and return a JPEG
  // data-URL. Tries createImageBitmap (honours EXIF orientation), but falls back
  // to a FileReader + <img> + canvas path on ANY failure — Safari/iOS often
  // rejects createImageBitmap with the orientation option (or on HEIC), and the
  // <img> path also handles HEIC photos the picker hands over.
  function fcResizeImage(file, maxPx, quality) {
    maxPx = maxPx || 1600; quality = quality || 0.72;
    function draw(src, w, h) {
      var m = Math.max(w, h), scale = m > maxPx ? maxPx / m : 1;
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", quality);
    }
    function fileReaderPath() {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { var im = new Image(); im.onload = function () { try { resolve(draw(im, im.width, im.height)); } catch (e) { reject(e); } }; im.onerror = function () { reject(new Error("decode")); }; im.src = fr.result; };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsDataURL(file);
      });
    }
    if (window.createImageBitmap) {
      try {
        return createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
          var url = draw(bmp, bmp.width, bmp.height);
          if (bmp.close) { try { bmp.close(); } catch (e) {} }
          return url;
        }, fileReaderPath);   // createImageBitmap rejected (Safari/options/HEIC) → fall back
      } catch (e) { return fileReaderPath(); }   // threw synchronously
    }
    return fileReaderPath();
  }
  // Add picked photos to an entry: downscale, store each in IndexedDB, append the
  // id onto the entry, then persist. Resolves when all are stored.
  function fcAddEntryImages(entryId, files) {
    if (!(window.AppIDB && window.AppIDB.available())) { photoDbg("Storage unavailable (no IndexedDB — private mode?)"); return Promise.resolve(); }
    var rec = curFieldRecord(false); if (!rec) { photoDbg("No open checklist to attach to"); return Promise.resolve(); }
    var e = rec.log.filter(function (x) { return x.id === entryId; })[0]; if (!e) { photoDbg("Observation not found (" + entryId + ")"); return Promise.resolve(); }
    // Accept whatever the picker returns: the input is accept="image/*", and a picked
    // photo can arrive with an EMPTY (or non-image) MIME type — filtering on /^image\//
    // silently dropped those, so nothing was stored.
    var dbg = "picked=" + (files ? files.length : "null") + (files && files[0] ? " type='" + (files[0].type || "(empty)") + "' " + Math.round((files[0].size || 0) / 1024) + "KB" : "");
    var arr = Array.prototype.slice.call(files || []).filter(function (f) { return f && (!f.type || /^image\//i.test(f.type)); });
    if (!arr.length) { photoDbg("No photo received. " + dbg); return Promise.resolve(); }
    var added = 0, lastErr = "";
    return arr.reduce(function (p, f) {
      return p.then(function () {
        return fcResizeImage(f).then(function (url) {
          var id = imgId();
          return window.AppIDB.put(imgKey(id), url).then(function () { e.imgs = e.imgs || []; e.imgs.push(id); added++; });
        });
      }).catch(function (err) { lastErr = (err && err.message) || "" + err; });
    }, Promise.resolve()).then(function () {
      putFieldRecord(rec);
      photoDbg(added ? t("chk.photoSaved", { n: added }) : ("⚠ " + (lastErr || "photo failed") + "  [" + dbg + "]"));
    });
  }
  // Remove one photo from an entry (and delete its IndexedDB blob).
  function fcRemoveEntryImage(entryId, id) {
    var rec = curFieldRecord(false); if (!rec) return;
    var e = rec.log.filter(function (x) { return x.id === entryId; })[0]; if (!e || !e.imgs) return;
    e.imgs = e.imgs.filter(function (x) { return x !== id; });
    if (!e.imgs.length) delete e.imgs;
    if (window.AppIDB) window.AppIDB.del(imgKey(id)).then(null, function () {});
    putFieldRecord(rec);
  }
  // Delete every stored photo referenced by these entries (orphan cleanup on
  // entry delete / list clear).
  function fcDropEntryImages(entries) {
    if (!window.AppIDB) return;
    (entries || []).forEach(function (e) { ((e && e.imgs) || []).forEach(function (id) { window.AppIDB.del(imgKey(id)).then(null, function () {}); }); });
  }
  // Load image data-URLs for a set of ids → { id: dataURL } (missing ids omitted).
  function fcLoadImages(ids) {
    if (!ids || !ids.length || !(window.AppIDB && window.AppIDB.available())) return Promise.resolve({});
    var uniq = [], seen = {}; ids.forEach(function (id) { if (id && !seen[id]) { seen[id] = 1; uniq.push(id); } });
    var out = {};
    return Promise.all(uniq.map(function (id) {
      return window.AppIDB.get(imgKey(id)).then(function (v) { if (v) out[id] = v; }, function () {});
    })).then(function () { return out; });
  }
  // Fill an entry row's thumbnail strip (async — images live in IndexedDB).
  function fcRenderEntryThumbs(entryId, ids) {
    var box = document.querySelector('#entry-list .ent-imgs[data-id="' + entryId + '"]');
    if (!box) return;
    fcLoadImages(ids).then(function (map) {
      box.innerHTML = ids.map(function (id) {
        if (!map[id]) return "";
        return '<span class="ent-thumb"><img src="' + map[id] + '" alt="" />' +
          '<button type="button" class="ent-img-del" data-id="' + escapeHtml(entryId) + '" data-img="' + escapeHtml(id) + '" aria-label="' + escapeHtml(t("btn.delete")) + '">×</button></span>';
      }).join("");
    });
  }
  // Card 📷 button: attach photo(s) to a species' most recent observation,
  // creating one (and ticking it seen) if it has none yet, then refresh the card.
  function fcAddPhotoToSpecies(key, files) {
    if (!files || !files.length) return;
    var rec = curFieldRecord(true); if (!rec) return;
    var ents = fcEntriesFor(rec, key);
    if (!ents.length) { fcCommitCompose(key); rec = curFieldRecord(false); ents = rec ? fcEntriesFor(rec, key) : []; }
    if (!ents.length) return;
    var entryId = ents[ents.length - 1].id;
    setStatus(t("chk.savingPhoto"));
    fcAddEntryImages(entryId, files).then(function () { renderFieldList(); });
  }

  // Sex/age toggle on each log entry. Cycle order: none → male → female →
  // couple → looks-female (female-type) → back to none. Default is none.
  var SEX_CYCLE = ["", "m", "f", "p", "fl"];
  function sexGlyph(s) {
    return s === "m" ? "♂" : s === "f" ? "♀" : s === "p" ? "⚥" : s === "fl" ? "♀?" : "·";
  }
  // Female-like ("looks female") marker: a single composed gender symbol — a
  // question mark sitting atop the female sign's cross — shown instead of a
  // two-character "♀?". Used wherever the glyph is rendered as HTML; text-only
  // sinks (CSV export, native <option>) fall back to sexGlyph()'s "♀?".
  var FL_GLYPH_SVG = '<svg class="sx-fl" viewBox="0 0 18 28" aria-label="♀?" role="img">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4.67 4.5 A5 5 0 1 1 9 12"/>' +  // female circle, open ~120deg from the stem toward the left (question-mark hook)
      '<line x1="9" y1="12" x2="9" y2="21"/>' +        // female cross — vertical
      '<line x1="5" y1="16.5" x2="13" y2="16.5"/>' +   // female cross — horizontal
    '</g>' +
    '<circle cx="9" cy="24.6" r="1.4" fill="currentColor"/>' +   // dot underneath
    '</svg>';
  function sexGlyphHtml(s) {
    return s === "fl" ? FL_GLYPH_SVG : escapeHtml(sexGlyph(s));
  }
  function nextSex(cur) {
    var i = SEX_CYCLE.indexOf(cur || ""); return SEX_CYCLE[(i + 1) % SEX_CYCLE.length];
  }
  function setFcSex(key, sex) {
    cd(key).sex = sex || "";
    var btn = document.querySelector('#field-list .fc-card[data-key="' + key + '"] .fc-sex-btn');
    if (btn) { btn.innerHTML = sexGlyphHtml(sex); btn.classList.toggle("has-sex", !!sex); }
  }

  // Append an observation entry to the open list (with id, time, location).
  function fcAppend(key, count, note, act, sex) {
    var rec = curFieldRecord(true); if (!rec) return;
    var loc = regLocation(), eId = eid();
    rec.log.push({ id: eId, ts: Date.now(), lat: loc.lat, lon: loc.lon, key: key, count: (count != null && count !== "" ? count : null), act: act || "", note: (note || "").trim(), sex: sex || "" });
    rec.seen = rec.seen || {}; rec.seen[key] = true;
    rec.lat = fieldLat; rec.lon = fieldLon;
    putFieldRecord(rec);
    freshenEntryLocation(eId);
    recordSpeciesSeen(key);   // logging a species ticks it on the year + life lists
  }
  // ＋ : commit the species' compose draft as a new entry, then clear it.
  function fcCommitCompose(key) {
    var d = composeDraft[key] || {};
    fcAppend(key, d.count, d.note, d.act, d.sex);
    composeDraft[key] = { count: null, act: "", note: "", sex: "" };
  }
  function fcUpdateEntry(id, patch) {
    var rec = curFieldRecord(false); if (!rec) return;
    var e = rec.log.filter(function (x) { return x.id === id; })[0]; if (!e) return;
    for (var k in patch) e[k] = patch[k];
    putFieldRecord(rec);
  }
  function fcDeleteEntry(id) {
    var rec = curFieldRecord(false); if (!rec) return;
    var e = rec.log.filter(function (x) { return x.id === id; })[0];
    if (e) fcDropEntryImages([e]);   // remove its photos from IndexedDB
    rec.log = rec.log.filter(function (x) { return x.id !== id; });
    // If that was the species' last entry it's no longer "seen" — clear the
    // flag so the card's tint goes back to white.
    if (e && rec.seen && rec.seen[e.key] && !fcEntriesFor(rec, e.key).length) delete rec.seen[e.key];
    putFieldRecord(rec);
  }
  // Merge selected entries into one that LISTS the values (counts/activities/
  // notes joined), keeping the earliest time and its location.
  function fcMergeEntries(ids) {
    var rec = curFieldRecord(false); if (!rec) return;
    var sel = rec.log.filter(function (e) { return ids.indexOf(e.id) >= 0; });
    if (sel.length < 2) return;
    sel.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    var counts = [], acts = [], notes = [], imgs = [];
    sel.forEach(function (e) {
      if (e.count != null && e.count !== "") counts.push(String(e.count));
      String(e.act || "").split(" / ").forEach(function (a) { if (a && acts.indexOf(a) < 0) acts.push(a); });
      if (e.note) notes.push(e.note);
      (e.imgs || []).forEach(function (id) { if (imgs.indexOf(id) < 0) imgs.push(id); });   // keep merged entries' photos
    });
    var merged = { id: eid(), key: sel[0].key, ts: sel[0].ts, lat: sel[0].lat, lon: sel[0].lon,
      count: counts.length ? counts.join(", ") : null, act: acts.join(" / "), note: notes.join(" | ") };
    if (imgs.length) merged.imgs = imgs;
    var first = rec.log.indexOf(sel[0]);
    rec.log = rec.log.filter(function (e) { return ids.indexOf(e.id) < 0; });
    rec.log.splice(Math.max(0, first), 0, merged);
    putFieldRecord(rec);
  }
  function fcClear() { var rec = curFieldRecord(false); if (!rec) return; fcDropEntryImages(rec.log); rec.log = []; rec.seen = {}; putFieldRecord(rec); }
  // Merge another list's observations into the open one, then delete the other.
  function fcMerge(otherId) {
    if (!fieldKey || otherId === fieldKey) return;
    var rec = curFieldRecord(true), other = getFieldRecord(otherId);
    if (!rec || !other) return;
    rec.log = rec.log.concat(other.log).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    var all = getFieldChecklists(); delete all[otherId]; all[rec.id] = rec; saveFieldChecklists(all);
    refreshChecklists();
  }
  // Persist the title for the current list (creating its record).
  function persistFieldTitle(v) {
    var rec = curFieldRecord(true); if (!rec) return;
    rec.title = v; rec.lat = fieldLat; rec.lon = fieldLon;
    putFieldRecord(rec);
  }
  // Old per-point titles (pre per-location records); read-only migration fallback.
  function getFieldTitles() { return window.GeoState.get("fieldTitles", {}) || {}; }

  // Subsequence fuzzy match: query chars must appear in order in the name.
  function fuzzyMatch(name, q) {
    if (!q) return true;
    name = name.toLowerCase(); q = q.toLowerCase().replace(/\s+/g, "");
    var i = 0;
    for (var c = 0; c < name.length && i < q.length; c++) if (name[c] === q[i]) i++;
    return i === q.length;
  }

  // ---- "Far from checklist point" warning ----------------------------------
  // While a checklist is open, watch the device location; if it is more than
  // 2 km from the checklist's point, show a red "!" the user can tap to read a
  // short, localized explanation.
  var FIELD_FAR_KM = 2;
  function showFieldFar(on) {
    var b = document.getElementById("field-far");
    if (b) { b.style.display = on ? "" : "none"; b.title = t("chk.far"); }
    if (!on) { var m = document.getElementById("field-far-msg"); if (m) m.style.display = "none"; }
  }
  function stopFieldGeoWatch() {
    if (fieldGeoWatch != null && navigator.geolocation) navigator.geolocation.clearWatch(fieldGeoWatch);
    fieldGeoWatch = null;
    fieldGeoLast = null;
    showFieldFar(false);
  }
  function startFieldGeoWatch() {
    stopFieldGeoWatch();
    if (!navigator.geolocation) return;
    fieldGeoWatch = navigator.geolocation.watchPosition(function (pos) {
      // Stop once the checklist page is no longer showing.
      if (document.getElementById("field-page").style.display !== "flex") { stopFieldGeoWatch(); return; }
      fieldGeoLast = { lat: pos.coords.latitude, lon: pos.coords.longitude, ts: Date.now() };
      var d = haversineKm(pos.coords.latitude, pos.coords.longitude, fieldLat, fieldLon);
      showFieldFar(d > FIELD_FAR_KM);
    }, function () { /* denied / unavailable — no warning */ }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }
  // Location to stamp on a new registration: the live device fix when available,
  // else the checklist's anchor point.
  function regLocation() {
    return fieldGeoLast ? { lat: fieldGeoLast.lat, lon: fieldGeoLast.lon } : { lat: fieldLat, lon: fieldLon };
  }
  // Request a one-shot high-accuracy fix and patch the just-logged entry with it,
  // so each registration ends up with a fresh position (not the open-time anchor).
  function freshenEntryLocation(entryId) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      fieldGeoLast = { lat: pos.coords.latitude, lon: pos.coords.longitude, ts: Date.now() };
      var rec = curFieldRecord(false); if (!rec) return;
      var e = (rec.log || []).filter(function (x) { return x.id === entryId; })[0];
      if (e) { e.lat = pos.coords.latitude; e.lon = pos.coords.longitude; putFieldRecord(rec); }
    }, function () { /* denied / unavailable — keep best-known location */ }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  // Build the probability-ranked species list for the clicked/located point.
  // listId pins a specific (possibly past-day) list; otherwise today's list at
  // this place is started/continued.
  async function renderFieldChecklist(lat, lon, listId) {
    fieldQuery = ""; fieldFilter = "all"; composeDraft = {};   // fresh filters + compose drafts each open
    var fs = document.getElementById("field-search"); if (fs) fs.value = "";
    var fsc = document.getElementById("field-search-clear"); if (fsc) fsc.hidden = true;
    if (window.__refreshFilterCycle) window.__refreshFilterCycle();
    var week = +document.getElementById("week-select").value;
    var pmin = +document.getElementById("prob-min").value / 100;
    var pmax = +document.getElementById("prob-max").value / 100;
    setStatus(t("status.predicting", { lat: lat.toFixed(2), lon: lon.toFixed(2), week: week }));
    try {
      var out = await runInference(new Float32Array([lat, lon, week]), 1);
      var rows = [];
      for (var i = 0; i < getLabels().length; i++) {
        if (out[i] >= pmin && out[i] <= pmax && inGroup(i) && !isHidden(getLabels()[i].key)) {
          rows.push({ key: getLabels()[i].key, name: speciesName(getLabels()[i]), prob: out[i] });
        }
      }
      rows.sort(function (a, b) { return b.prob - a.prob; });
      fieldData = rows;
      fieldLat = lat; fieldLon = lon;
      // Editable title = the user's saved name for this point, else the actual
      // detailed location (resolved async; coordinates meanwhile).
      var fcEl = document.getElementById("field-coords");
      var pkey = placeKey(lat, lon);
      var id = listId || listIdFor(lat, lon);   // today's list at this place by default
      fcEl.dataset.pkey = id;
      fieldKey = id;
      // Stamp last-accessed (for the recency dots in the checklist list); only
      // for lists that already exist in storage — don't create an empty one.
      var allFcs = getFieldChecklists();
      if (allFcs[id]) { allFcs[id].accessedAt = Date.now(); saveFieldChecklists(allFcs); }
      var rec = getFieldRecord(id);
      var saved = (rec && rec.title) || getFieldTitles()[pkey] || fieldNameCache[pkey];
      fcEl.value = saved || (lat.toFixed(4) + "°, " + lon.toFixed(4) + "°");
      var ptok = ++fieldPlaceToken;
      if (!saved) {
        // Resolve a proper place name; show it, remember it as the auto-title,
        // and persist it onto the open list once it has observations so the
        // dropdown never shows raw coordinates.
        detailedPlaceName(lat, lon).then(function (name) {
          if (!name) return;
          fieldNameCache[pkey] = name;
          if (ptok !== fieldPlaceToken) return;          // user moved on
          if (getFieldTitles()[pkey]) return;            // user already named it
          if (!(fcEl.value || "").trim() || /^-?\d.*°/.test(fcEl.value)) fcEl.value = name;
          var r2 = getFieldRecord(id);
          if (r2 && r2.log && r2.log.length && !(r2.title || "").trim()) persistFieldTitle(name);
        });
      }
      document.getElementById("field-page").style.display = "flex";   // full-screen entry page
      navOpen("page", closeAnyFullPage);
      hideFcPicker(); hidePlacePicker();
      showFieldFar(false); startFieldGeoWatch();   // re-check distance for this point
      renderFieldList();
      setStatus(t("status.spResult", { n: rows.length, p: (pmin * 100).toFixed(0), lat: lat.toFixed(2), lon: lon.toFixed(2) }));
    } catch (e) { setStatus(t("status.error", { msg: e.message })); console.error(e); }
  }

  // Country-wide checklist: same UI as the point-anchored checklist but its
  // species rows are the country-wide merged list (model + eBird country list),
  // its id is country:CC@day, the location warning is off (you can be
  // anywhere in the country), and the row snapshot is persisted on the record
  // so reopening from the list shows the species instantly without re-sampling.
  function renderCountryChecklist(cc, name, lat, lon, results, rowsSnapshot) {
    fieldQuery = ""; fieldFilter = "all"; composeDraft = {};
    var fs = document.getElementById("field-search"); if (fs) fs.value = "";
    var fsc = document.getElementById("field-search-clear"); if (fsc) fsc.hidden = true;
    if (window.__refreshFilterCycle) window.__refreshFilterCycle();
    var rows = rowsSnapshot || (results || []).map(function (r) { return { key: r.label.key, name: speciesName(r.label), prob: r.prob || 0 }; });
    fieldData = rows;
    fieldLat = lat; fieldLon = lon;
    var day = todayStr();
    var id = "country:" + cc + "@" + day;
    var fcEl = document.getElementById("field-coords");
    fcEl.dataset.pkey = id;
    fieldKey = id;
    fcEl.value = name || cc;
    // Persist the record (so it shows in the checklist list, survives reload,
    // and reopens instantly with the same species rows snapshot).
    var allFcs = getFieldChecklists();
    var rec = allFcs[id];
    if (!rec) rec = { id: id, title: name || cc, lat: lat, lon: lon, day: day, createdAt: new Date().toISOString(), log: [], seen: {}, kind: "country", cc: cc, rows: rows };
    else { rec.title = name || cc; rec.kind = "country"; rec.cc = cc; rec.rows = rows; rec.accessedAt = Date.now(); }
    allFcs[id] = rec; saveFieldChecklists(allFcs);
    document.getElementById("field-page").style.display = "flex";
    navOpen("page", closeAnyFullPage);
    hideFcPicker(); hidePlacePicker();
    showFieldFar(false); stopFieldGeoWatch();   // country-wide → no point anchor, no "far" warning
    renderFieldList();
    setStatus(t("status.countryChk", { country: name || cc, n: rows.length }));
    refreshChecklists();
  }

  // Checklist activity options. Each value is a stable key; ACT holds the label
  // per language [en, sv, de, es, fr, nl, no, it]. FIELD_ACTS is the dropdown
  // order — sorted from most to least commonly recorded.
  var ACT_LANGS = ["en", "sv", "de", "es", "fr", "nl", "no", "it"];
  var ACT = {
    // — everyday —
    stationary: ["Stationary", "Stationär", "Stationär", "Estacionario", "Stationnaire", "Stationair", "Stasjonær", "Stazionario"],
    resting: ["Resting", "Rastande", "Rastend", "En descanso", "En halte", "Rustend", "Rastende", "In sosta"],
    foraging: ["Foraging", "Födosökande", "Nahrungssuchend", "Alimentándose", "En quête de nourriture", "Foeragerend", "Næringssøkende", "In foraggiamento"],
    flyover: ["Flying over", "Överflygande", "Überfliegend", "Sobrevolando", "Survol", "Overvliegend", "Overflygende", "In volo sopra"],
    song: ["Song/display, not breeding", "Sång/spel, ej häckning", "Gesang/Balz, nicht brütend", "Canto/exhibición, no nidificante", "Chant/parade, hors nidification", "Zang/baltsen, niet broedend", "Sang/spill, ikke hekking", "Canto/parata, non nidificante"],
    call: ["Call/other sounds", "Lockläte/övriga ljud", "Ruf/sonstige Laute", "Reclamo/otros sonidos", "Cri/autres sons", "Roep/overige geluiden", "Lokkelyd, øvrige lyder", "Richiamo/altri suoni"],
    migrating: ["Migrating", "Sträckande", "Ziehend", "Migrando", "En migration", "Trekkend", "Trekkende", "In migrazione"],
    atfeeder: ["At feeder", "Vid matning", "Am Futterplatz", "En comedero", "À la mangeoire", "Bij voederplaats", "Ved fôring", "Alla mangiatoia"],
    // — breeding —
    obshab: ["Seen in breeding season, suitable habitat", "Obs. i häckningstid, lämplig biotop", "Beobachtung zur Brutzeit, geeignetes Habitat", "Observación en época de cría, hábitat adecuado", "Observé en période de nidification, habitat favorable", "Waarneming in broedtijd, geschikt biotoop", "Observasjon i hekketid, passende biotop", "Osservazione in periodo riproduttivo, habitat idoneo"],
    songhab: ["Song/display in breeding season & habitat", "Sång/spel i häckningstid, lämplig biotop", "Gesang/Balz zur Brutzeit, geeignetes Habitat", "Canto/exhibición en época y hábitat de cría", "Chant/parade en période et habitat de nidification", "Zang/baltsen in broedtijd, geschikt biotoop", "Sang/spill i hekketid og passende hekkebiotop", "Canto/parata in periodo e habitat riproduttivo"],
    pairhab: ["Pair in suitable breeding habitat", "Par i lämplig häckbiotop", "Paar im geeigneten Bruthabitat", "Pareja en hábitat de cría adecuado", "Couple en habitat de nidification favorable", "Paar in geschikt broedbiotoop", "Par i passende hekkebiotop", "Coppia in habitat riproduttivo idoneo"],
    permterr: ["Permanent territory", "Permanent revir", "Dauerrevier", "Territorio permanente", "Territoire permanent", "Permanent territorium", "Permanent revir", "Territorio permanente"],
    agitated: ["Agitated behaviour (breeding indication)", "Oroligt beteende (häckningsindikation)", "Erregtes Verhalten (Brutverdacht)", "Comportamiento de alarma (indicio de cría)", "Comportement inquiet (indice de nidification)", "Alarmgedrag (broedindicatie)", "Engstelig adferd, indikasjon på hekking", "Comportamento agitato (indizio di nidificazione)"],
    courtship: ["Mating/courtship at possible site", "Parning/uppvaktning på möjlig plats", "Paarung/Balz am möglichen Brutplatz", "Cópula/cortejo en posible lugar", "Accouplement/parade sur site possible", "Paring/balts op mogelijke plek", "Paring/kurtise på mulig hekkeplass", "Accoppiamento/corteggiamento su sito possibile"],
    nestbuild: ["Nest building", "Bobygge", "Nestbau", "Construcción de nido", "Construction du nid", "Nestbouw", "Reirbygging", "Costruzione del nido"],
    incubating: ["Incubating", "Ruvande", "Brütend", "Incubando", "En incubation", "Broedend", "Rugende", "In cova"],
    foodyoung: ["Food for young", "Mat till ungar", "Futter für Junge", "Alimento para crías", "Nourriture pour les jeunes", "Voer voor jongen", "Mat til unger", "Cibo per i piccoli"],
    nesteggsyoung: ["Nest with eggs or young", "Bo med ägg eller ungar", "Nest mit Eiern oder Jungen", "Nido con huevos o crías", "Nid avec œufs ou jeunes", "Nest met eieren of jongen", "Reir med egg eller unger", "Nido con uova o piccoli"],
    nestyoungheard: ["Nest, young heard", "Bo, ungar hörda", "Nest, Junge gehört", "Nido, crías oídas", "Nid, jeunes entendus", "Nest, jongen gehoord", "Reir, unger hørt", "Nido, piccoli uditi"],
    fledglings: ["Fledglings outside nest, not full-grown", "Ungar utanför bo, ej flygga", "Junge außerhalb des Nests, nicht flügge", "Pollos fuera del nido, no volantones", "Jeunes hors du nid, non volants", "Jongen buiten nest, niet vliegvlug", "Unger utenfor reir, ikke utvokste", "Giovani fuori dal nido, non involati"],
    nestinuse: ["Nest in use", "Bo i bruk", "Nest in Benutzung", "Nido en uso", "Nid utilisé", "Nest in gebruik", "Reir i bruk", "Nido in uso"],
    visitnest: ["Visiting occupied nest", "Besöker bebott bo", "Besucht besetztes Nest", "Visita nido ocupado", "Visite un nid occupé", "Bezoekt bewoond nest", "Besøker bebodd reir", "Visita nido occupato"],
    nestvisitq: ["Nest visit?", "Bobesök?", "Nestbesuch?", "¿Visita al nido?", "Visite du nid ?", "Nestbezoek?", "Reirbesøk?", "Visita al nido?"],
    faecalsac: ["Carrying faecal sac", "Bär exkrementsäck", "Kotballen tragend", "Transportando saco fecal", "Transport de sac fécal", "Draagt uitwerpselzakje", "Bar ekskrementpose", "Trasporto sacca fecale"],
    broodpatch: ["Brood patch", "Ruvfläckar", "Brutfleck", "Placa incubatriz", "Plaque incubatrice", "Broedvlek", "Rugeflekker", "Placca incubatrice"],
    usednest: ["Used nest", "Använt bo", "Benutztes Nest", "Nido usado", "Ancien nid utilisé", "Gebruikt nest", "Brukt reir", "Nido usato"],
    eggshell: ["Eggshell", "Äggskal", "Eierschale", "Cáscara de huevo", "Coquille d'œuf", "Eierschaal", "Eggeskall", "Guscio d'uovo"],
    distraction: ["Distraction display", "Avledningsbeteende", "Ablenkungsverhalten", "Distracción (simula herida)", "Comportement de diversion", "Afleidingsgedrag", "Avledningsmanøver", "Comportamento di distrazione"],
    failed: ["Failed breeding", "Misslyckad häckning", "Fehlgeschlagene Brut", "Cría fallida", "Nidification échouée", "Mislukte broedpoging", "Mislykket hekking", "Nidificazione fallita"],
    // — territory / marking —
    terrnonbreed: ["Territory, not breeding", "Revir, ej häckning", "Revier, nicht brütend", "Territorio, no reproductor", "Territoire, hors nidification", "Territorium, niet broedend", "Revir, ikke hekking", "Territorio, non nidificante"],
    ringed: ["Ringed", "Ringmärkt", "Beringt", "Anillado", "Bagué", "Geringd", "Ringmerket", "Inanellato"],
    marked: ["Individually marked (control)", "Individmärkt (kontroll)", "Individuell markiert (Kontrolle)", "Marcado individual (control)", "Marqué individuellement (contrôle)", "Individueel gemerkt (controle)", "Individmerket (kontroll)", "Marcato individualmente (controllo)"],
    // — migration —
    migattempt: ["Attempted migration", "Sträckförsök", "Zugversuch", "Intento de migración", "Tentative de migration", "Trekpoging", "Trekkforsøk", "Tentativo di migrazione"],
    mign: ["Migrating ↑", "Sträckande ↑", "Ziehend ↑", "Migrando ↑", "En migration ↑", "Trekkend ↑", "Trekkende ↑", "In migrazione ↑"],
    migne: ["Migrating ↗", "Sträckande ↗", "Ziehend ↗", "Migrando ↗", "En migration ↗", "Trekkend ↗", "Trekkende ↗", "In migrazione ↗"],
    mige: ["Migrating →", "Sträckande →", "Ziehend →", "Migrando →", "En migration →", "Trekkend →", "Trekkende →", "In migrazione →"],
    migse: ["Migrating ↘", "Sträckande ↘", "Ziehend ↘", "Migrando ↘", "En migration ↘", "Trekkend ↘", "Trekkende ↘", "In migrazione ↘"],
    migs: ["Migrating ↓", "Sträckande ↓", "Ziehend ↓", "Migrando ↓", "En migration ↓", "Trekkend ↓", "Trekkende ↓", "In migrazione ↓"],
    migsw: ["Migrating ↙", "Sträckande ↙", "Ziehend ↙", "Migrando ↙", "En migration ↙", "Trekkend ↙", "Trekkende ↙", "In migrazione ↙"],
    migw: ["Migrating ←", "Sträckande ←", "Ziehend ←", "Migrando ←", "En migration ←", "Trekkend ←", "Trekkende ←", "In migrazione ←"],
    mignw: ["Migrating ↖", "Sträckande ↖", "Ziehend ↖", "Migrando ↖", "En migration ↖", "Trekkend ↖", "Trekkende ↖", "In migrazione ↖"],
    // — mortality —
    sick: ["Sick", "Sjuk", "Krank", "Enfermo", "Malade", "Ziek", "Syk", "Malato"],
    shot: ["Shot/culled", "Skjuten/avlivad", "Geschossen/getötet", "Disparado/sacrificado", "Tiré/abattu", "Geschoten/gedood", "Skutt/avlivet", "Abbattuto/soppresso"],
    roadkill: ["Roadkill", "Trafikdödad", "Verkehrsopfer", "Atropellado", "Tué sur la route", "Verkeersslachtoffer", "Trafikkdrept", "Investito su strada"],
    predator: ["Killed by predator", "Dödad av predator", "Von Prädator getötet", "Muerto por depredador", "Tué par un prédateur", "Gedood door predator", "Drept av predator", "Ucciso da predatore"],
    disease: ["Died of disease/starvation", "Död av sjukdom/svält", "An Krankheit/Hunger gestorben", "Muerto por enfermedad/inanición", "Mort de maladie/famine", "Gestorven door ziekte/honger", "Død av sykdom/sult", "Morto per malattia/fame"],
    oil: ["Killed by oil", "Dödad av olja", "Durch Öl getötet", "Muerto por petróleo", "Tué par le pétrole", "Gedood door olie", "Drept av olje", "Ucciso dal petrolio"],
    electro: ["Electrocuted", "Dödad av elstöt", "Durch Stromschlag getötet", "Electrocutado", "Électrocuté", "Geëlektrocuteerd", "Drept av elektrokusjon (strømslag)", "Folgorato"],
    net: ["Died in net", "Nätdöd", "Im Netz verendet", "Muerto en red", "Mort dans un filet", "Gestorven in net", "Garndød", "Morto in rete"],
    fishgear: ["Injured by fishing gear", "Skadad av fiskeredskap", "Durch Fanggerät verletzt", "Herido por arte de pesca", "Blessé par engin de pêche", "Verwond door vistuig", "Skadet av fiskeredskap", "Ferito da attrezzi da pesca"],
    collwindow: ["Dead – window collision", "Död – kollision med fönster", "Tot – Kollision mit Fenster", "Muerto – colisión con ventana", "Mort – collision avec vitre", "Dood – botsing met raam", "Død - kollisjon med vindu", "Morto – collisione con vetro"],
    collpower: ["Dead – power line collision", "Död – kollision med kraftledning", "Tot – Kollision mit Stromleitung", "Muerto – colisión con línea eléctrica", "Mort – collision avec ligne électrique", "Dood – botsing met hoogspanningslijn", "Død - kollisjon med kraftledning", "Morto – collisione con linea elettrica"],
    collturbine: ["Dead – wind turbine collision", "Död – kollision med vindkraftverk", "Tot – Kollision mit Windrad", "Muerto – colisión con aerogenerador", "Mort – collision avec éolienne", "Dood – botsing met windturbine", "Død - kollisjon med vindturbin", "Morto – collisione con turbina eolica"],
    colllighthouse: ["Dead – lighthouse collision", "Död – kollision med fyr", "Tot – Kollision mit Leuchtturm", "Muerto – colisión con faro", "Mort – collision avec phare", "Dood – botsing met vuurtoren", "Død - kollisjon med fyr", "Morto – collisione con faro"],
    collaircraft: ["Dead – aircraft collision", "Död – kollision med flygplan", "Tot – Kollision mit Flugzeug", "Muerto – colisión con avión", "Mort – collision avec avion", "Dood – botsing met vliegtuig", "Død - kollisjon med fly", "Morto – collisione con aereo"],
    collfence: ["Dead – fence collision", "Död – kollision med stängsel", "Tot – Kollision mit Zaun", "Muerto – colisión con valla", "Mort – collision avec clôture", "Dood – botsing met hek", "Død - kollisjon med gjerde", "Morto – collisione con recinzione"],
    deadunknown: ["Dead – unknown cause", "Död – okänd dödsorsak", "Tot – unbekannte Ursache", "Muerto – causa desconocida", "Mort – cause inconnue", "Dood – onbekende oorzaak", "Død - ukjent dødsårsak", "Morto – causa sconosciuta"],
    // — traces —
    tracksfresh: ["Fresh tracks", "Färska spår", "Frische Spuren", "Rastros frescos", "Traces fraîches", "Verse sporen", "Ferske spor", "Tracce fresche"],
    tracksold: ["Old tracks", "Äldre spår", "Alte Spuren", "Rastros antiguos", "Traces anciennes", "Oude sporen", "Eldre spor", "Tracce vecchie"],
    droppingsfresh: ["Fresh droppings", "Färsk spillning", "Frischer Kot", "Excrementos frescos", "Crottes fraîches", "Verse uitwerpselen", "Fersk møkk", "Escrementi freschi"],
    droppingsold: ["Old droppings", "Äldre spillning", "Alter Kot", "Excrementos antiguos", "Crottes anciennes", "Oude uitwerpselen", "Eldre møkk", "Escrementi vecchi"],
  };
  // Dropdown order: most → least commonly recorded.
  var FIELD_ACTS = [
    "stationary", "resting", "foraging", "flyover", "song", "call", "migrating", "atfeeder",
    "obshab", "songhab", "pairhab", "permterr", "agitated", "courtship", "nestbuild", "incubating",
    "foodyoung", "nesteggsyoung", "nestyoungheard", "fledglings", "nestinuse", "visitnest",
    "nestvisitq", "faecalsac", "broodpatch", "usednest", "eggshell", "distraction", "failed",
    "terrnonbreed", "ringed", "marked",
    "migattempt", "mign", "migne", "mige", "migse", "migs", "migsw", "migw", "mignw",
    "sick", "shot", "roadkill", "predator", "disease", "oil", "electro", "net", "fishgear",
    "collwindow", "collpower", "collturbine", "colllighthouse", "collaircraft", "collfence", "deadunknown",
    "tracksfresh", "tracksold", "droppingsfresh", "droppingsold",
  ];
  // Localized label for an activity key (current UI language, English fallback).
  function actName(key) {
    var a = ACT[key];
    if (!a) return key;
    var i = ACT_LANGS.indexOf(getLang());
    return a[i >= 0 ? i : 0] || a[0];
  }

  // Render the (filtered, probability-sorted) field-entry rows.
  function fmtClock(ts) { var d = new Date(ts || Date.now()); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function actLabel(act) { return String(act || "").split(" / ").filter(Boolean).map(function (a) { return actName(a); }).join(" / "); }
  // Compact one-line summary of a logged observation for the card.
  // Compact one-line summary as HTML (the sex marker is a composed SVG glyph).
  function fcEntryHtml(e) {
    var parts = [];
    if (e.count != null && e.count !== "") parts.push(escapeHtml("×" + e.count));
    if (e.sex) parts.push(sexGlyphHtml(e.sex));
    var al = actLabel(e.act); if (al) parts.push(escapeHtml(al));
    parts.push(escapeHtml(fmtClock(e.ts)));
    if (e.note) parts.push(escapeHtml("“" + e.note + "”"));
    return parts.join(" · ");
  }

  // A card per species: a top "compose" line (checkbox, #, activity, note, ＋)
  // plus the most recent logged observations as small lines you can tap to edit.
  function renderFieldList() {
    if (!fieldData) return;
    var entries = getFieldEntries();
    var rec = curFieldRecord(false);
    var list = document.getElementById("field-list");
    var rows = fieldData.slice(), have = {};
    fieldData.forEach(function (r) { have[r.key] = 1; });
    Object.keys(entries).forEach(function (k) {
      if (have[k]) return;
      var lbl = getLabelsByKey()[k];
      rows.push({ key: k, name: lbl ? speciesName(lbl) : k, prob: null });
    });
    var shown = rows.filter(function (r) {
      if (!fuzzyMatch(r.name, fieldQuery)) return false;
      if (fieldFilter === "interesting") return isInteresting(r.key);
      if (fieldFilter === "all") return true;
      var seen = !!(entries[r.key] && entries[r.key].seen);
      return fieldFilter === "seen" ? seen : !seen;
    });
    list.innerHTML = shown.map(function (r) {
      var en = entries[r.key] || {}, d = cd(r.key), lbl = getLabelsByKey()[r.key];
      var ents = rec ? fcEntriesFor(rec, r.key) : [], n = ents.length;
      var hasN = (d.count != null && d.count !== "");
      var entLines = ents.slice(-2).reverse().map(function (e) {
        return '<div class="fc-eline">' + fcEntryHtml(e) + "</div>";
      }).join("");
      if (n > 2) entLines += '<div class="fc-eline fc-emore">' + escapeHtml(t("chk.more", { n: n - 2 })) + "</div>";
      var entriesBlock = n ? '<div class="fc-entries" data-key="' + escapeHtml(r.key) + '">' + entLines + "</div>" : "";
      var badge = n > 1 ? '<span class="fc-ncount" title="' + n + '">×' + n + "</span>" : "";
      var nImg = ents.reduce(function (s, e) { return s + ((e.imgs && e.imgs.length) || 0); }, 0);
      var imgBadge = nImg ? '<span class="fc-imgcount" title="' + nImg + '">📷' + nImg + "</span>" : "";
      return '<div class="fc-card' + (en.seen ? " fc-on" : "") + (d.note ? " fc-note-on" : "") + '" data-key="' + escapeHtml(r.key) + '">' +
        '<div class="fc-top">' +
          '<span class="fc-name sp-link" data-key="' + escapeHtml(r.key) + '" data-name="' + escapeHtml(r.name) + '" data-sci="' + escapeHtml(lbl ? (lbl.sci || "") : "") + '">' + interestingStar(r.key) + escapeHtml(r.name) + badge + imgBadge + "</span>" +
          '<div class="fc-actions">' +
            '<button type="button" class="fc-count' + (hasN ? " has-n" : "") + '" data-key="' + escapeHtml(r.key) + '">' + (hasN ? d.count : "#") + "</button>" +
            '<button type="button" class="fc-act-btn' + (d.act ? " has-act" : "") + '" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("chk.activity")) + '">' + (d.act ? escapeHtml(actName(d.act)) : ico("tag")) + "</button>" +
            '<button type="button" class="fc-sex-btn' + (d.sex ? " has-sex" : "") + '" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("chk.sex")) + '">' + sexGlyphHtml(d.sex || "") + "</button>" +
            '<label class="fc-img-add" title="' + escapeHtml(t("chk.addPhoto")) + '" aria-label="' + escapeHtml(t("chk.addPhoto")) + '">📷<input type="file" accept="image/*" class="fc-img-file" data-key="' + escapeHtml(r.key) + '" multiple hidden /></label>' +
            '<button type="button" class="fc-add" data-key="' + escapeHtml(r.key) + '" title="' + escapeHtml(t("fc.add")) + '" aria-label="' + escapeHtml(t("fc.add")) + '">＋</button>' +
          "</div>" +
          '<input type="text" class="fc-note" data-key="' + escapeHtml(r.key) + '" placeholder="' + escapeHtml(t("th.notes")) + '" value="' + escapeHtml(d.note || "") + '" />' +
        "</div>" + entriesBlock +
        "</div>";
    }).join("");
    if (!shown.length) list.innerHTML = '<p class="fc-empty">' + escapeHtml(t("analysis.empty")) + "</p>";
    updateFieldSeen();
  }

  // Update the "✓ N" seen-count badge in the field page bar.
  function updateFieldSeen() {
    var el = document.getElementById("field-seen");
    if (!el) return;
    var entries = getFieldEntries(), n = 0;
    for (var k in entries) if (entries[k] && entries[k].seen) n++;
    el.textContent = n ? "✓ " + n : "";
  }

  // ---- Count quick-select (field checklist) --------------------------------
  var fcPickerKey = null;
  // The # picker now edits the species' compose-draft count (committed only by
  // ＋ or the checkbox), not the log.
  function openFcPicker(key, name) {
    fcPickerKey = key;
    document.getElementById("fcp-name").textContent = name || "";
    document.getElementById("fcp-val").textContent = countNum(cd(key).count);
    document.getElementById("fc-picker").style.display = "block";
  }
  function hideFcPicker() { fcPickerKey = null; var p = document.getElementById("fc-picker"); if (p) p.style.display = "none"; }
  function setFcCount(key, val) {
    val = Math.max(0, val | 0);
    cd(key).count = val > 0 ? val : null;
    var btn = document.querySelector('#field-list .fc-card[data-key="' + key + '"] .fc-count');
    if (btn) { btn.textContent = val > 0 ? val : "#"; btn.classList.toggle("has-n", val > 0); }
    var v = document.getElementById("fcp-val"); if (v) v.textContent = val;
  }

  // ---- Activity picker (field checklist) -----------------------------------
  // A scrollable bottom sheet of the (long) activity list, opened from the
  // card's activity button — replaces a cramped <select>. Edits the species'
  // compose-draft activity (committed only by ＋ or the checkbox).
  var fcActKey = null;
  // Resolve a typed query to an activity value: an existing code if the text
  // matches a localized name exactly, otherwise the raw text (a custom value).
  function resolveActQuery(raw) {
    raw = (raw || "").trim(); if (!raw) return "";
    var lc = raw.toLowerCase();
    for (var i = 0; i < FIELD_ACTS.length; i++) if (actName(FIELD_ACTS[i]).toLowerCase() === lc) return FIELD_ACTS[i];
    return raw;
  }
  // (Re)build the list, filtered by the search box. A non-matching query also
  // offers a "＋ <text>" item so a custom activity can be written.
  function renderFcActList() {
    if (!fcActKey) return;
    var cur = cd(fcActKey).act || "";
    var raw = document.getElementById("fca-search").value.trim(), q = raw.toLowerCase();
    var exact = false;
    var matches = FIELD_ACTS.filter(function (a) { var nm = actName(a).toLowerCase(); if (nm === q) exact = true; return !q || nm.indexOf(q) >= 0; });
    var h = '<button type="button" class="fca-item fca-none' + (!cur ? " is-active" : "") + '" data-act="">—</button>';
    if (raw && !exact) h += '<button type="button" class="fca-item fca-custom' + (cur === raw ? " is-active" : "") + '" data-act="' + escapeHtml(raw) + '">＋ ' + escapeHtml(raw) + "</button>";
    matches.forEach(function (a) {
      h += '<button type="button" class="fca-item' + (cur === a ? " is-active" : "") + '" data-act="' + escapeHtml(a) + '">' + escapeHtml(actName(a)) + "</button>";
    });
    document.getElementById("fca-list").innerHTML = h;
  }
  function openFcActPicker(key, name) {
    fcActKey = key;
    document.getElementById("fca-name").textContent = name || "";
    var cur = cd(key).act || "";
    // Prefill the box with a custom value so it stays visible/editable.
    document.getElementById("fca-search").value = (cur && FIELD_ACTS.indexOf(cur) < 0) ? cur : "";
    renderFcActList();
    var p = document.getElementById("fc-act-picker");
    p.style.display = "block";
    var active = p.querySelector(".fca-item.is-active");
    if (active) active.scrollIntoView({ block: "center" });
  }
  function hideFcActPicker() { fcActKey = null; var p = document.getElementById("fc-act-picker"); if (p) p.style.display = "none"; }
  function setFcAct(key, a) {
    var draft = cd(key);
    draft.act = a || "";
    // Picking an activity implies "I saw at least one" — default the count to 1
    // when the user hasn't entered one yet, so they don't have to tap twice.
    if (a && (draft.count == null || draft.count === "" || +draft.count === 0)) {
      setFcCount(key, 1);
    }
    var btn = document.querySelector('#field-list .fc-card[data-key="' + key + '"] .fc-act-btn');
    if (btn) { if (a) btn.textContent = actName(a); else btn.innerHTML = ico("tag"); btn.classList.toggle("has-act", !!a); }
  }

  // ---- Entry-edit page (per species) ---------------------------------------
  function openEntryEdit(key) { entryEditKey = key; renderEntryEdit(); document.getElementById("entry-page").style.display = "flex"; navOpen("entry", hideEntryEdit); }
  function hideEntryEdit() { document.getElementById("entry-page").style.display = "none"; entryEditKey = null; renderFieldList(); }
  function closeEntryEdit() { navClose("entry"); }
  function renderEntryEdit() {
    var key = entryEditKey, rec = curFieldRecord(false);
    var lbl = getLabelsByKey()[key];
    document.getElementById("entry-title").textContent = lbl ? speciesName(lbl) : key;
    var list = document.getElementById("entry-list");
    var ents = rec ? fcEntriesFor(rec, key).slice().reverse() : [];   // newest first
    if (!ents.length) { list.innerHTML = '<p class="fc-empty">' + escapeHtml(t("analysis.empty")) + "</p>"; return; }
    var actOpts = function (sel) {
      var h = '<option value=""></option>';
      FIELD_ACTS.forEach(function (a) { h += '<option value="' + a + '"' + (sel === a ? " selected" : "") + ">" + escapeHtml(actName(a)) + "</option>"; });
      return h;
    };
    var sexOpts = function (sel) {
      return SEX_CYCLE.map(function (s) {
        return '<option value="' + s + '"' + (sel === s ? " selected" : "") + ">" + sexGlyph(s) + "</option>";
      }).join("");
    };
    list.innerHTML = ents.map(function (e) {
      var meta = fmtClock(e.ts) + (e.lat != null ? " · " + e.lat.toFixed(3) + "," + e.lon.toFixed(3) : "");
      var singleAct = e.act && e.act.indexOf(" / ") < 0 ? e.act : "";   // merged activities aren't editable in the dropdown
      return '<div class="ent-row" data-id="' + escapeHtml(e.id) + '">' +
        '<label class="ent-sel-wrap"><input type="checkbox" class="ent-sel" data-id="' + escapeHtml(e.id) + '"></label>' +
        '<input type="text" class="ent-count" data-id="' + escapeHtml(e.id) + '" inputmode="numeric" value="' + escapeHtml(e.count != null ? String(e.count) : "") + '" placeholder="#" />' +
        '<select class="ent-sex" data-id="' + escapeHtml(e.id) + '" title="' + escapeHtml(t("chk.sex")) + '">' + sexOpts(e.sex || "") + "</select>" +
        '<select class="ent-act" data-id="' + escapeHtml(e.id) + '">' + actOpts(singleAct) + "</select>" +
        '<input type="text" class="ent-note" data-id="' + escapeHtml(e.id) + '" value="' + escapeHtml(e.note || "") + '" placeholder="' + escapeHtml(t("th.notes")) + '" />' +
        '<label class="ent-img-add" title="' + escapeHtml(t("chk.addPhoto")) + '" aria-label="' + escapeHtml(t("chk.addPhoto")) + '">📷' +
          '<input type="file" accept="image/*" class="ent-img-file" data-id="' + escapeHtml(e.id) + '" multiple hidden /></label>' +
        '<span class="ent-meta">' + escapeHtml(meta) + "</span>" +
        '<button type="button" class="ent-del" data-id="' + escapeHtml(e.id) + '" aria-label="' + escapeHtml(t("btn.delete")) + '">×</button>' +
        "</div>" +
        '<div class="ent-imgs" data-id="' + escapeHtml(e.id) + '"></div>';
    }).join("");
    ents.forEach(function (e) { if (e.imgs && e.imgs.length) fcRenderEntryThumbs(e.id, e.imgs); });
  }

  // ---- Review & upload page ------------------------------------------------
  // Lets the user split/merge the open record's log entries into ad-hoc
  // "checklists" (groups) and download an eBird Record-Format CSV per group
  // for manual upload at ebird.org/import/upload. A submit-API hook exists
  // but is gated off — eBird's submit endpoint is partner-only.

  // FIELD_ACTS code → eBird breeding/behaviour code. Activities not in this
  // table are emitted as plain text in the species "Identification details".
  var EBIRD_BREEDING = {
    flyover: "F", song: "S",
    obshab: "H", songhab: "S7", pairhab: "P", permterr: "T",
    agitated: "A", courtship: "C",
    nestbuild: "NB", incubating: "ON", foodyoung: "FY",
    nesteggsyoung: "NY", nestyoungheard: "NY", fledglings: "FL",
    nestinuse: "ON", visitnest: "N", nestvisitq: "N",
    faecalsac: "FS", usednest: "UN", eggshell: "UN",
    distraction: "DD", broodpatch: "PE"
  };
  var EBIRD_PROTOCOLS = ["Stationary", "Traveling", "Casual", "Incidental", "Historical"];
  var DEFAULT_GRP = "a";

  function entryGrp(e) { return (e && e.grp) || DEFAULT_GRP; }
  // Sorted list of group keys present in the record's log + persisted upload
  // meta. Empty groups disappear next render — keeps the UI honest.
  function recordGroups(rec) {
    var seen = {};
    ((rec && rec.log) || []).forEach(function (e) { seen[entryGrp(e)] = true; });
    if (rec && rec.upload) Object.keys(rec.upload).forEach(function (g) { seen[g] = true; });
    var keys = Object.keys(seen);
    if (!keys.length) keys.push(DEFAULT_GRP);
    keys.sort();
    return keys;
  }
  function entriesInGroup(rec, grp) {
    return ((rec && rec.log) || []).filter(function (e) { return entryGrp(e) === grp; })
      .sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  }
  // Per-species aggregate within a group. `count` is the sum of numeric counts
  // (countNum tolerates merged "3, 1" strings); `notes` is "|"-joined uniques;
  // `breedingHint` is the eBird code from the highest-priority activity seen.
  function aggregateForUpload(entries) {
    var by = {}, order = [];
    entries.forEach(function (e) {
      var a = by[e.key];
      if (!a) { a = by[e.key] = { key: e.key, count: 0, hadCount: false, notes: [], acts: [], sexCounts: {}, firstTs: e.ts || 0, lastTs: e.ts || 0 }; order.push(e.key); }
      var n = (e.count != null && e.count !== "") ? countNum(e.count) : 0;
      if (n > 0) { a.count += n; a.hadCount = true; }
      if (e.sex) a.sexCounts[e.sex] = (a.sexCounts[e.sex] || 0) + (n > 0 ? n : 1);
      if (e.note) { var nt = String(e.note).trim(); if (nt && a.notes.indexOf(nt) < 0) a.notes.push(nt); }
      String(e.act || "").split(" / ").forEach(function (x) { x = x.trim(); if (x && a.acts.indexOf(x) < 0) a.acts.push(x); });
      a.firstTs = Math.min(a.firstTs, e.ts || a.firstTs);
      a.lastTs = Math.max(a.lastTs, e.ts || a.lastTs);
    });
    return order.map(function (k) { return by[k]; });
  }
  // Render a species' sex-count breakdown as e.g. "3 ♂, 2 ♀" for the CSV
  // Identification-details column. Empty when no sex info was recorded.
  function sexBreakdown(sexCounts) {
    var parts = [];
    SEX_CYCLE.forEach(function (s) {
      if (!s) return;
      var n = sexCounts[s]; if (n) parts.push(n + " " + sexGlyph(s));
    });
    return parts.join(", ");
  }
  // Translate the species' joined activity codes into (breedingCode, residualText).
  // Breeding code is the first matching mapped activity; residual is plain
  // text for unmapped activities (foraging/stationary/migrating-… etc) so the
  // info isn't lost in the CSV.
  function ebirdActSplit(actCodes) {
    var code = "", residual = [];
    actCodes.forEach(function (a) {
      if (EBIRD_BREEDING[a] && !code) code = EBIRD_BREEDING[a];
      else if (a) residual.push(actName(a));
    });
    return { code: code, residual: residual.join(", ") };
  }

  // Default time pulled from the entries; falls back to local clock.
  function ebirdStartTime(entries) {
    if (!entries.length) return "08:00";
    var t0 = entries[0].ts || Date.now();
    return fmtClock(t0);
  }
  function ebirdDurationMin(entries) {
    if (entries.length < 2) return 0;
    var span = (entries[entries.length - 1].ts || 0) - (entries[0].ts || 0);
    return Math.max(0, Math.round(span / 60000));
  }

  var REVIEW_FIELDS = ["protocol", "start", "duration", "distance", "area", "observers", "allObs",
                       "locName", "state", "country", "effortNotes", "submitNotes"];
  function defaultMeta(rec, entries) {
    return {
      protocol: "Stationary",
      start: ebirdStartTime(entries),
      duration: ebirdDurationMin(entries) || (entries.length ? 1 : 0),
      distance: "",
      area: "",
      observers: 1,
      allObs: "Y",
      locName: rec.title || "",
      state: "",
      country: "",
      effortNotes: "",
      submitNotes: ""
    };
  }
  function readGroupMeta(rec, grp, entries) {
    var dflt = defaultMeta(rec, entries);
    var saved = (rec.upload && rec.upload[grp]) || {};
    var out = {};
    REVIEW_FIELDS.forEach(function (f) { out[f] = (saved[f] !== undefined && saved[f] !== null) ? saved[f] : dflt[f]; });
    return out;
  }
  function writeGroupMeta(rec, grp, patch) {
    rec.upload = rec.upload || {};
    rec.upload[grp] = Object.assign(rec.upload[grp] || {}, patch);
    putFieldRecord(rec);
  }
  function nextGroupKey(rec) {
    // Group keys are single lowercase letters a–z; jump to the lowest unused.
    var used = {}; recordGroups(rec).forEach(function (g) { used[g] = true; });
    for (var i = 0; i < 26; i++) { var k = String.fromCharCode(97 + i); if (!used[k]) return k; }
    return "z";   // unlikely
  }

  // eBird Record-Format CSV — header row + one row per species. Columns and
  // order from eBird's documented import schema; "All observations reported"
  // and "Number" semantics per their import help ("X" for present-no-count).
  function ebirdRecordCsv(rec, grp) {
    var entries = entriesInGroup(rec, grp);
    var meta = readGroupMeta(rec, grp, entries);
    var rows = aggregateForUpload(entries);
    var esc = csvEsc;   // shared module-level CSV escaper
    var headers = ["Common Name", "Genus", "Species", "Number", "Identification details",
      "Observation Date", "Observation Time", "State", "Country", "Location Name",
      "Latitude", "Longitude", "Protocol", "Duration (min)", "All observations reported",
      "Distance Covered (km)", "Area Covered (ha)", "Number of Observers",
      "Effort Comments", "Submission Comments"];
    var date = rec.day || todayStr();
    var lines = [headers.join(",")];
    var skipped = 0;
    rows.forEach(function (a) {
      var lbl = getLabelsByKey()[a.key] || {};
      // eBird only accepts birds. Skip non-bird rows so the import doesn't
      // 400; we report the count back so the caller can warn the user.
      var isBird = !!getLabelsByKey()[a.key] || isBirdKey(a.key);
      if (!isBird) { skipped++; return; }
      var sci = (lbl.sci || "").split(/\s+/);
      var genus = sci[0] || "", species = sci.slice(1).join(" ") || "";
      var common = lbl.common || lbl.key || a.key;
      var split = ebirdActSplit(a.acts);
      var detailBits = [];
      if (split.code) detailBits.push(split.code);
      var sx = sexBreakdown(a.sexCounts || {});
      if (sx) detailBits.push(sx);
      if (split.residual) detailBits.push(split.residual);
      if (a.notes.length) detailBits.push(a.notes.join(" | "));
      var num = a.hadCount && a.count > 0 ? String(a.count) : "X";
      lines.push([
        esc(common), esc(genus), esc(species), num, esc(detailBits.join(" — ")),
        date, meta.start || "",
        esc(meta.state || ""), esc(meta.country || ""), esc(meta.locName || rec.title || ""),
        (rec.lat != null ? rec.lat.toFixed(6) : ""), (rec.lon != null ? rec.lon.toFixed(6) : ""),
        meta.protocol || "Stationary",
        (meta.duration === "" || meta.duration == null) ? "" : String(meta.duration),
        (meta.allObs === "N") ? "N" : "Y",
        (meta.protocol === "Traveling" && meta.distance !== "") ? String(meta.distance) : "",
        (meta.protocol === "Area" && meta.area !== "") ? String(meta.area) : "",
        String(meta.observers || 1),
        esc(meta.effortNotes || ""), esc(meta.submitNotes || "")
      ].join(","));
    });
    return { csv: lines.join("\n"), skipped: skipped };
  }

  // Placeholder for an eventual API submit. Kept as a function so the call
  // site doesn't need to change once eBird grants partner credentials.

  var REVIEW_RECID = null;
  function openReviewPage() {
    var rec = curFieldRecord(false);
    if (!rec || !rec.log || !rec.log.length) { setStatus(t("review.empty")); return; }
    REVIEW_RECID = rec.id;
    document.getElementById("review-page").style.display = "flex";
    renderReviewPage();
  }
  function closeReviewPage() {
    document.getElementById("review-page").style.display = "none";
    REVIEW_RECID = null;
  }

  function renderReviewPage() {
    var rec = getFieldRecord(REVIEW_RECID);
    var list = document.getElementById("review-list");
    if (!rec) { list.innerHTML = '<p class="fc-empty">' + escapeHtml(t("review.empty")) + "</p>"; return; }
    var groups = recordGroups(rec);
    var html = groups.map(function (g) { return renderGroupCardHtml(rec, g, groups); }).join("");
    if (!html) html = '<p class="fc-empty">' + escapeHtml(t("review.empty")) + "</p>";
    list.innerHTML = html;
  }

  function renderGroupCardHtml(rec, grp, allGroups) {
    var entries = entriesInGroup(rec, grp);
    var meta = readGroupMeta(rec, grp, entries);
    var rows = aggregateForUpload(entries);
    var esc = escapeHtml;
    var protoOpts = EBIRD_PROTOCOLS.map(function (p) {
      var lab = t("review.proto" + p);
      return '<option value="' + p + '"' + (meta.protocol === p ? " selected" : "") + ">" + esc(lab) + "</option>";
    }).join("");
    var moveOpts = allGroups.filter(function (x) { return x !== grp; })
      .map(function (x) { return '<option value="' + x + '">' + esc(t("review.group") + " " + x.toUpperCase()) + "</option>"; })
      .concat('<option value="__new__">' + esc(t("review.newGroup")) + "</option>").join("");

    var speciesHtml = rows.map(function (a) {
      var lbl = getLabelsByKey()[a.key] || {};
      var nm = lbl.common ? speciesName(lbl) : a.key;
      var split = ebirdActSplit(a.acts);
      var codeOpts = ['<option value=""></option>'].concat(
        ["F","S","H","S7","P","T","A","C","NB","ON","FY","NY","FL","N","FS","UN","DD","PE"].map(function (c) {
          return '<option value="' + c + '"' + (split.code === c ? " selected" : "") + ">" + c + "</option>";
        })
      ).join("");
      var note = (split.residual ? split.residual + (a.notes.length ? " — " : "") : "") + a.notes.join(" | ");
      var srcEntries = entriesInGroup(rec, grp).filter(function (e) { return e.key === a.key; });
      var srcHtml = srcEntries.map(function (e) {
        return '<div class="rv-src" data-eid="' + esc(e.id) + '">' +
          '<span class="rv-src-meta">' + esc(fmtClock(e.ts) + " · " + (e.count != null ? e.count : "·") + (e.act ? " · " + actName(e.act) : "") + (e.note ? " · " + e.note : "")) + "</span>" +
          '<select class="rv-move" data-eid="' + esc(e.id) + '" data-grp="' + esc(grp) + '">' +
            '<option value="">' + esc(t("review.moveTo")) + "</option>" + moveOpts +
          "</select>" +
          "</div>";
      }).join("");
      return '<div class="rv-sp" data-key="' + esc(a.key) + '" data-grp="' + esc(grp) + '">' +
        '<div class="rv-sp-head">' +
          '<span class="rv-sp-name">' + esc(nm) + "</span>" +
          '<input type="text" class="rv-count" data-grp="' + esc(grp) + '" data-key="' + esc(a.key) + '" inputmode="numeric" value="' + esc(a.hadCount && a.count > 0 ? String(a.count) : (a.hadCount ? "0" : "X")) + '" />' +
          '<select class="rv-code" data-grp="' + esc(grp) + '" data-key="' + esc(a.key) + '" title="Breeding/behaviour code">' + codeOpts + "</select>" +
          '<button type="button" class="rv-expand" data-key="' + esc(a.key) + '" data-grp="' + esc(grp) + '" aria-label="Show entries">▾</button>' +
        "</div>" +
        '<input type="text" class="rv-note" data-grp="' + esc(grp) + '" data-key="' + esc(a.key) + '" value="' + esc(note) + '" placeholder="' + esc(t("th.notes")) + '" />' +
        '<div class="rv-src-list" hidden>' + srcHtml + "</div>" +
      "</div>";
    }).join("");

    var showDist = meta.protocol === "Traveling";
    return '<div class="rv-group" data-grp="' + esc(grp) + '">' +
      '<div class="rv-group-head">' +
        '<h3>' + esc(t("review.group") + " " + grp.toUpperCase()) + " · " + entries.length + "</h3>" +
        '<button type="button" class="btn rv-dl ico-btn" data-grp="' + esc(grp) + '">' + ico("download") + '<span class="ico-label" data-i18n="review.dlEbird">' + esc(tLabel("review.dlEbird")) + "</span></button>" +
      "</div>" +
      '<div class="rv-meta">' +
        '<label>' + esc(t("review.protocol")) + ' <select class="rv-m" data-grp="' + esc(grp) + '" data-f="protocol">' + protoOpts + "</select></label>" +
        '<label>' + esc(t("review.start")) + ' <input type="time" class="rv-m" data-grp="' + esc(grp) + '" data-f="start" value="' + esc(meta.start || "") + '"></label>' +
        '<label>' + esc(t("review.duration")) + ' <input type="number" min="0" class="rv-m" data-grp="' + esc(grp) + '" data-f="duration" value="' + esc(String(meta.duration || 0)) + '"></label>' +
        (showDist ? '<label>' + esc(t("review.distance")) + ' <input type="number" min="0" step="0.1" class="rv-m" data-grp="' + esc(grp) + '" data-f="distance" value="' + esc(String(meta.distance || "")) + '"></label>' : "") +
        '<label>' + esc(t("review.observers")) + ' <input type="number" min="1" class="rv-m" data-grp="' + esc(grp) + '" data-f="observers" value="' + esc(String(meta.observers || 1)) + '"></label>' +
        '<label>' + esc(t("review.allObs")) + ' <select class="rv-m" data-grp="' + esc(grp) + '" data-f="allObs"><option value="Y"' + (meta.allObs !== "N" ? " selected" : "") + ">" + esc(t("review.yes")) + '</option><option value="N"' + (meta.allObs === "N" ? " selected" : "") + ">" + esc(t("review.no")) + "</option></select></label>" +
        '<label class="rv-wide">' + esc(t("review.locName")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="locName" value="' + esc(meta.locName || "") + '"></label>' +
        '<label>' + esc(t("review.state")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="state" value="' + esc(meta.state || "") + '"></label>' +
        '<label>' + esc(t("review.country")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="country" value="' + esc(meta.country || "") + '"></label>' +
        '<label class="rv-wide">' + esc(t("review.effortNotes")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="effortNotes" value="' + esc(meta.effortNotes || "") + '"></label>' +
        '<label class="rv-wide">' + esc(t("review.submitNotes")) + ' <input type="text" class="rv-m" data-grp="' + esc(grp) + '" data-f="submitNotes" value="' + esc(meta.submitNotes || "") + '"></label>' +
      "</div>" +
      (rows.length ? '<div class="rv-sp-list">' + speciesHtml + "</div>" : '<p class="fc-empty">' + esc(t("review.empty")) + "</p>") +
    "</div>";
  }

  // ---- Review handlers ----
  // Move a single log entry between groups. "__new__" allocates a fresh letter.
  function reviewMoveEntry(rec, eid, targetGrp) {
    var e = rec.log.filter(function (x) { return x.id === eid; })[0]; if (!e) return;
    if (targetGrp === "__new__") targetGrp = nextGroupKey(rec);
    e.grp = targetGrp;
    putFieldRecord(rec);
  }
  // Edit an aggregated species' count / breeding code / shared note. Counts
  // and notes act on the species' entries WITHIN this group: count gets
  // stamped on the most recent entry (others zeroed), code/note on the most
  // recent entry — pragmatic since the source-entries list still lets users
  // touch individual entries when needed.
  function reviewEditSpecies(rec, grp, key, patch) {
    var ents = entriesInGroup(rec, grp).filter(function (e) { return e.key === key; });
    if (!ents.length) return;
    var last = ents[ents.length - 1];
    if (patch.count !== undefined) {
      ents.forEach(function (e) { e.count = null; });
      last.count = patch.count;
    }
    if (patch.code !== undefined) {
      var residual = ents.reduce(function (s, e) {
        var others = String(e.act || "").split(" / ").filter(function (a) { return a && !EBIRD_BREEDING[a]; });
        return s.concat(others);
      }, []);
      // Map code back to first FIELD_ACTS entry that produces it
      var actForCode = null;
      Object.keys(EBIRD_BREEDING).some(function (k) { if (EBIRD_BREEDING[k] === patch.code) { actForCode = k; return true; } });
      var newActs = [];
      if (actForCode) newActs.push(actForCode);
      residual.forEach(function (r) { if (newActs.indexOf(r) < 0) newActs.push(r); });
      last.act = newActs.join(" / ");
      ents.slice(0, -1).forEach(function (e) {
        e.act = String(e.act || "").split(" / ").filter(function (a) { return !EBIRD_BREEDING[a]; }).join(" / ");
      });
    }
    if (patch.note !== undefined) {
      last.note = patch.note;
      ents.slice(0, -1).forEach(function (e) { e.note = ""; });
    }
    putFieldRecord(rec);
  }

  // Pipe-separated per-entry detail string for one species, embedded in the
  // species-summary CSV exports so each report carries the individual time
  // + location of every observation. Power users can split on " | " to expand.
  function observationsSummary(ents) {
    return (ents || []).map(function (e) {
      var bits = [];
      if (e.ts) bits.push(new Date(e.ts).toISOString());
      if (e.lat != null && e.lon != null) bits.push(e.lat.toFixed(5) + "," + e.lon.toFixed(5));
      if (e.count != null && e.count !== "") bits.push("×" + e.count);
      if (e.sex) bits.push(e.sex);
      if (e.act) bits.push(actLabel(e.act));
      if (e.note) bits.push('"' + String(e.note).replace(/"/g, "'") + '"');
      return bits.join(" ");
    }).join(" | ");
  }
  function fieldChecklistCsv() {
    var entries = getFieldEntries(), esc = function (v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var byKey = {}; (fieldData || []).forEach(function (r) { byKey[r.key] = r; });
    var titleEl = document.getElementById("field-coords");
    var title = (titleEl && titleEl.value || "").trim() || (fieldLat.toFixed(4) + "°, " + fieldLon.toFixed(4) + "°");
    var lid = fieldKey || "";
    var rec = curFieldRecord(false);
    var lines = ["# " + title + " | " + new Date().toISOString().slice(0, 10)];
    lines.push("checklist,list_id,species,common_name,count,activity,notes,observations");
    Object.keys(entries).forEach(function (key) {
      var e = entries[key]; if (!e.seen && (e.count == null || e.count === "") && !e.act && !e.note) return;
      var name = (byKey[key] && byKey[key].name) || (getLabelsByKey()[key] && speciesName(getLabelsByKey()[key])) || key;
      var ents = rec ? fcEntriesFor(rec, key) : [];
      lines.push([esc(title), esc(lid), key, esc(name), e.count != null ? e.count : "", e.act ? actName(e.act) : "", esc(e.note || ""), esc(observationsSummary(ents))].join(","));
    });
    return lines.join("\n");
  }


  // Open a clean, print-ready page of the seen birds in a new tab and trigger
  // the print dialog (where the browser offers "Save as PDF"). No PDF library
  // needed — works offline.
  function exportFieldPdf() {
    var title = (document.getElementById("field-coords").value || "").trim() || t("btn.checklist").replace(/^[^\wÀ-ɏ]+\s*/, "");
    var date = new Date().toISOString().slice(0, 10);
    var esc = escapeHtml;
    var rec = curFieldRecord(false);
    var byKey = {}; (fieldData || []).forEach(function (r) { byKey[r.key] = r; });
    function nameFor(key) { return (byKey[key] && byKey[key].name) || (getLabelsByKey()[key] && speciesName(getLabelsByKey()[key])) || key; }
    // One row PER DETECTION (log entry), not per species. Species seen with no
    // logged detection still get a name-only row so nothing is lost.
    var dets = ((rec && rec.log) || []).map(function (e) { return { e: e, name: nameFor(e.key) }; });
    var agg = getFieldEntries();
    Object.keys(agg).forEach(function (key) { if (agg[key].seen && !agg[key].n) dets.push({ e: { key: key }, name: nameFor(key), seenOnly: true }); });
    dets.sort(function (a, b) { var c = a.name.localeCompare(b.name); return c || ((a.e.ts || 0) - (b.e.ts || 0)); });
    // Photo ids across all detections.
    var ids = []; dets.forEach(function (o) { (o.e.imgs || []).forEach(function (id) { ids.push(id); }); });
    setStatus(t("app.loading"));
    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function dtStr(ts) { if (!ts) return ""; var d = new Date(ts); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + fmtClock(ts); }
    fcLoadImages(ids).then(function (imgMap) {
      var COLS = 7;
      var body = dets.map(function (o) {
        var e = o.e;
        var nameCell = esc(o.name) + (e.sex ? " " + sexGlyphHtml(e.sex) : "");
        var cnt = (e.count != null && e.count !== "") ? esc(String(e.count)) : "";
        var row = "<tr>" +
          "<td>" + nameCell + "</td>" +
          "<td>" + esc(dtStr(e.ts)) + "</td>" +
          '<td class="pr-num">' + cnt + "</td>" +
          "<td>" + esc(e.act ? actLabel(e.act) : "") + "</td>" +
          '<td class="pr-num">' + (e.lon != null ? esc(e.lon.toFixed(5)) : "") + "</td>" +
          '<td class="pr-num">' + (e.lat != null ? esc(e.lat.toFixed(5)) : "") + "</td>" +
          "<td>" + esc(e.note || "") + "</td>" +
        "</tr>";
        var imgs = (e.imgs || []).filter(function (id) { return imgMap[id]; });
        var imgRow = imgs.length ? '<tr class="pr-imgrow"><td colspan="' + COLS + '">' +
          imgs.map(function (id) { return '<img src="' + imgMap[id] + '" alt="" />'; }).join("") + "</td></tr>" : "";
        return row + imgRow;
      }).join("") || '<tr><td colspan="' + COLS + '">' + esc(t("analysis.empty")) + "</td></tr>";
      var inner =
        '<div class="pr-bar"><button type="button" class="pr-print">' + esc(t("chk.savePdf")) + "</button>" +
        '<button type="button" class="pr-close" aria-label="' + esc(t("btn.close")) + '">✕</button></div>' +
        "<h1>" + esc(title) + "</h1>" +
        '<div class="pr-meta">' + esc(date) + " &middot; " + dets.length + " " + esc(t("chk.seen").toLowerCase()) + "</div>" +
        '<table class="pr-det"><thead><tr><th>' + esc(t("th.species")) + "</th><th>" + esc(t("th.datetime")) +
        "</th><th>" + esc(t("chk.count")) + "</th><th>" + esc(t("chk.activity")) + "</th><th>" + esc(t("th.lon")) +
        "</th><th>" + esc(t("th.lat")) + "</th><th>" + esc(t("th.notes")) + "</th></tr></thead><tbody>" + body + "</tbody></table>";
      showPrintReport(inner);
      setStatus("");
    }, function () { setStatus(t("status.error", { msg: "images" })); });
  }
  // Show the report as a full-screen in-app overlay (where photos render exactly
  // as they do in the editor), then window.print() captures ONLY this element via
  // the @media print rules in app.css. This avoids new windows / blob navigation /
  // iframe printing — all unreliable for data-URL images on iOS Safari.
  function showPrintReport(inner) {
    var el = document.getElementById("print-report");
    if (!el) { el = document.createElement("div"); el.id = "print-report"; document.body.appendChild(el); }
    el.innerHTML = inner;
    el.classList.add("show");
    document.body.classList.add("print-report-active");   // scopes the @media print rule to this overlay
    el.querySelector(".pr-print").addEventListener("click", function () { try { window.print(); } catch (e) {} });
    el.querySelector(".pr-close").addEventListener("click", function () { navClose("printreport"); });
    navOpen("printreport", function () { el.classList.remove("show"); el.innerHTML = ""; document.body.classList.remove("print-report-active"); });
  }

  // Write final HTML into an already-open print window (opened earlier in the
  // user gesture), then trigger the print dialog. Waits for any embedded photos
  // (data-URL <img>) to finish decoding first — otherwise print()/Save-as-PDF can
  // fire before they paint and the photos are missing from the PDF. Falls back to
  // a timeout so a stuck image can't block printing forever.
  function writePrintWindow(w, html) {
    try {
      w.document.open(); w.document.write(html); w.document.close(); w.focus();
      var done = false;
      var doPrint = function () { if (done) return; done = true; try { w.print(); } catch (e) { /* user can print manually */ } };
      var imgs = w.document.images || [], pending = 0;
      var tick = function () { if (pending <= 0) setTimeout(doPrint, 60); };   // all decoded → tiny delay for layout
      for (var i = 0; i < imgs.length; i++) {
        if (!imgs[i].complete) {
          pending++;
          var fin = function () { pending--; tick(); };
          imgs[i].addEventListener("load", fin); imgs[i].addEventListener("error", fin);
        }
      }
      if (pending === 0) setTimeout(doPrint, 350);   // no photos (or all cached) → small delay for layout
      else setTimeout(doPrint, 5000);                 // safety: never wait forever on a stuck image
    } catch (e) {}
  }

  return {
    init: init,
    // ---- record store + aggregation ----
    getFieldChecklists: getFieldChecklists, saveFieldChecklists: saveFieldChecklists,
    getFieldRecord: getFieldRecord, putFieldRecord: putFieldRecord,
    curFieldRecord: curFieldRecord, fcEntriesFor: fcEntriesFor, fcAggregate: fcAggregate,
    cd: cd, eid: eid, dayOf: dayOf, todayStr: todayStr, listIdFor: listIdFor,
    countNum: countNum, fuzzyMatch: fuzzyMatch, fmtClock: fmtClock,
    // ---- entry mutations ----
    fcCommitCompose: fcCommitCompose, fcUpdateEntry: fcUpdateEntry,
    fcDeleteEntry: fcDeleteEntry, fcMergeEntries: fcMergeEntries, fcMerge: fcMerge,
    fcClear: fcClear, fcAddEntryImages: fcAddEntryImages,
    fcRemoveEntryImage: fcRemoveEntryImage, fcAddPhotoToSpecies: fcAddPhotoToSpecies,
    updateFieldSeen: updateFieldSeen, persistFieldTitle: persistFieldTitle,
    // ---- page renderers + pickers ----
    renderFieldChecklist: renderFieldChecklist, renderFieldList: renderFieldList,
    renderCountryChecklist: renderCountryChecklist,
    openFcPicker: openFcPicker, hideFcPicker: hideFcPicker, setFcCount: setFcCount,
    openFcActPicker: openFcActPicker, hideFcActPicker: hideFcActPicker,
    setFcAct: setFcAct, renderFcActList: renderFcActList, resolveActQuery: resolveActQuery,
    setFcSex: setFcSex, nextSex: nextSex, sexGlyph: sexGlyph,
    actName: actName, actLabel: actLabel,
    openEntryEdit: openEntryEdit, closeEntryEdit: closeEntryEdit, renderEntryEdit: renderEntryEdit,
    openPlacePicker: openPlacePicker, hidePlacePicker: hidePlacePicker, setFieldTitle: setFieldTitle,
    stopFieldGeoWatch: stopFieldGeoWatch, startFieldGeoWatch: startFieldGeoWatch,
    // ---- review page + exports ----
    openReviewPage: openReviewPage, closeReviewPage: closeReviewPage,
    renderReviewPage: renderReviewPage, reviewMoveEntry: reviewMoveEntry,
    reviewEditSpecies: reviewEditSpecies, nextGroupKey: nextGroupKey,
    writeGroupMeta: writeGroupMeta, observationsSummary: observationsSummary,
    ebirdRecordCsv: ebirdRecordCsv, fieldChecklistCsv: fieldChecklistCsv,
    exportFieldPdf: exportFieldPdf, writePrintWindow: writePrintWindow,
    // ---- state (app.js reads through these) ----
    reviewRecId: function () { return REVIEW_RECID; },
    fcActKey: function () { return fcActKey; },
    fcPickerKey: function () { return fcPickerKey; },
    fieldQuery: function () { return fieldQuery; },
    setFieldQuery: function (v) { fieldQuery = v; },
    fieldFilter: function () { return fieldFilter; },
    setFieldFilter: function (v) { fieldFilter = v; },
    entryEditKey: function () { return entryEditKey; },
    fieldKey: function () { return fieldKey; },
    setFieldKey: function (v) { fieldKey = v; },
    fieldLat: function () { return fieldLat; },
    fieldLon: function () { return fieldLon; },
    fieldNameCache: function () { return fieldNameCache; },
  };
})();
