/**
 * Species images — the Images-layout cards' photos (the lead picture of the
 * species' Wikipedia article, with Wikidata / iNaturalist / GBIF fallbacks),
 * the batched lookup, the per-species store, the full-size lightbox with zoom,
 * the Wikimedia Commons category grid (male / female / juvenile / in flight …,
 * topped up from iNaturalist) and the gallery card markup.
 *
 * Lifted out of app.js byte-for-byte (v2230). app.js still owns the species
 * views and the plotted detections, and injects what this module needs through
 * init() — same identifiers as inside the monolith.
 *
 * Exposed as window.AppSpImages (no module system; loaded via <script>).
 */
window.AppSpImages = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var createModal, escapeHtml, holdDelay, holdFeedback, isBirdKey, macaulayUrl, openExternal, powoUrl, spMissingOn, t, wireSpeciesPicker, ytopLabel;
  // … and getters for app state that changes at runtime.
  var getDetPlot, getLabelsByKey, getSecondLang, getShowSci;

  function init(ctx) {
    createModal = ctx.createModal; escapeHtml = ctx.escapeHtml; holdDelay = ctx.holdDelay; holdFeedback = ctx.holdFeedback;
    isBirdKey = ctx.isBirdKey; macaulayUrl = ctx.macaulayUrl; openExternal = ctx.openExternal; powoUrl = ctx.powoUrl;
    spMissingOn = ctx.spMissingOn; t = ctx.t; wireSpeciesPicker = ctx.wireSpeciesPicker; ytopLabel = ctx.ytopLabel;
    getDetPlot = ctx.getDetPlot; getLabelsByKey = ctx.getLabelsByKey; getSecondLang = ctx.getSecondLang; getShowSci = ctx.getShowSci;
  }

  // ---- Species gallery ("Images" layout) ------------------------------------
  // One card per visible species-table row, in the table's current order: the species'
  // photo (the lead image of its Wikipedia article, resolved lazily as the card scrolls
  // into view), the name (same .sp-link → species menu) with the scientific name in
  // parentheses after it (same .sci-link → Family menu), the row's Total · Last seen ·
  // Distance · Probability, and — when the species has records — a ☰ button that jumps
  // to its record sub-list in the Table layout. The photo of a bird opens its Macaulay
  // Library catalogue narrowed to the month it was last seen (the species menu's
  // "Photos" link); the Probability opens the Migration view (Location analysis →
  // Timeline) and, on hover, previews the same 48-week curve at the fetch point.
  // Every photo is credited to its Wikimedia Commons author and licence, linked to the
  // file page.
  var spImgCache = null;   // sci → { t: thumb url, a: artist, l: licence, f: file title } | { none: 1 }
  function spImgStore() { if (!spImgCache) spImgCache = window.GeoState.get("spImages", {}) || {}; return spImgCache; }
  function spImgRemember(sci, rec) { var o = {}; o[sci] = rec; spImgRememberMany(o); }
  // One save for a whole batch: the family popup remembers 160 species at once, and
  // saving per species re-serialised the entire (capped) store that many times.
  function spImgRememberMany(recs) {
    var c = spImgStore(), n = 0;
    for (var k in recs) { c[k] = recs[k]; n++; }
    if (!n) return;
    var keys = Object.keys(c); if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(function (k) { delete c[k]; });   // bounded
    window.GeoState.save({ spImages: c });
  }
  function spImgFileFromUrl(u) {   // …/commons/thumb/a/ab/Name.jpg/320px-Name.jpg  or  …/commons/a/ab/Name.jpg  → "Name.jpg"
    var m = /\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^\/?#]+)/.exec((u || "").split("?")[0]);
    try { return m ? decodeURIComponent(m[1]) : ""; } catch (e) { return m ? m[1] : ""; }
  }
  // A display-size thumbnail URL from the summary's thumbnail: drop the tracking query,
  // serve from upload.wikimedia.org (the canonical, cacheable host) at 960 px wide.
  // Wikimedia serves a FIXED ladder of widths here (20/40/60/120/250/330/500/960…) and
  // answers anything else with HTTP 400 — v1802 asked for 800 and every photo broke, which
  // is why the width is a named constant now and the loader falls back to 500 on error.
  // 960 rather than 500: a gallery card is ~300 CSS px, i.e. ~900 device px on a 3× phone.
  var SP_IMG_W = 960, SP_IMG_W_FALLBACK = 500;
  function spImgAtWidth(u, w) { return String(u || "").replace(/\/\d+px-/, "/" + w + "px-"); }
  // Press-and-hold on ANY card photo (confusion species, family, the species list's Images
  // layout) opens the same picture full screen (owner, 2026-10-01): a 1600 px rendition of the
  // card's thumbnail (falling back to the thumbnail itself), the card's credit line under it,
  // a tap or Escape closes. Delegated once on the document; the emulated click that follows a
  // touch hold is swallowed so the card underneath does not open as well.
  var PHOTO_BIG_W = 1600, lbHoldT = null, lbHoldAt = 0, lbStart = null;
  function openPhotoLightbox(img) {
    closePhotoLightbox();
    var box = document.createElement("div"); box.id = "photo-lightbox"; box.setAttribute("role", "dialog");
    box._openedAt = Date.now();   // the overlay's own clock: the release of the hold must not count as the closing tap
    var big = document.createElement("img"); big.alt = img.alt || ""; big.decoding = "async";
    var src = img.currentSrc || img.src, bigSrc = spImgAtWidth(src, PHOTO_BIG_W);
    big.addEventListener("error", function () { if (big.src !== src) big.src = src; });   // no 1600 px rendition → the card's own picture
    big.src = bigSrc; big.draggable = false;
    box.appendChild(big);
    // Zoom (owner, 2026-10-30: "it should be shown full size with possibility to zoom"): scroll wheel, pinch and double-tap /
    // double-click zoom about the pointer, a drag pans; a plain tap on the picture at 1:1 still closes. Past 1.5× a 3000 px
    // rendition replaces the 1600 px one once it has loaded.
    var sc = 1, tx = 0, ty = 0, ptrs = {}, pinchD = 0, moved = false, hiRes = false, lastTap = 0, tapT = null;
    big.title = t("photo.zoomTip");
    function apply() {
      big.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + sc + ")";
      big.style.cursor = sc > 1 ? "grab" : "zoom-in";
      if (sc > 1.5 && !hiRes) { hiRes = true; var hi = spImgAtWidth(src, 3000); if (hi !== big.src) { var pre = new Image(); pre.onload = function () { if (big.isConnected) big.src = hi; }; pre.src = hi; } }
    }
    function zoomAt(f, cx, cy) {   // the point under (cx, cy) stays put
      var r = big.getBoundingClientRect(), ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
      var ns = Math.min(8, Math.max(1, sc * f)); f = ns / sc;
      tx += ox * (1 - f); ty += oy * (1 - f); sc = ns;
      if (sc === 1) { tx = 0; ty = 0; }
      apply();
    }
    function pinch() { var k = Object.keys(ptrs); if (k.length < 2) return 0; var a = ptrs[k[0]], b = ptrs[k[1]]; return Math.hypot(a.x - b.x, a.y - b.y); }
    box.addEventListener("wheel", function (e) { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
    big.addEventListener("dblclick", function (e) { e.preventDefault(); e.stopPropagation(); });   // handled on pointerup (one path for mouse and touch)
    big.addEventListener("pointerdown", function (e) {
      if (e.button > 0) return;
      e.preventDefault(); try { big.setPointerCapture(e.pointerId); } catch (e2) {}
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; pinchD = pinch(); moved = false;
    });
    big.addEventListener("pointermove", function (e) {
      var p = ptrs[e.pointerId]; if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (Math.abs(e.clientX - p.x0) > 6 || Math.abs(e.clientY - p.y0) > 6) moved = true;
      var d = pinch();
      if (d && pinchD) { var k = Object.keys(ptrs), a = ptrs[k[0]], b = ptrs[k[1]]; zoomAt(d / pinchD, (a.x + b.x) / 2, (a.y + b.y) / 2); pinchD = d; }
      else if (sc > 1) { tx += dx; ty += dy; apply(); }
    });
    function lift(e) {
      if (!ptrs[e.pointerId]) return;
      delete ptrs[e.pointerId]; pinchD = pinch();
      if (Object.keys(ptrs).length || moved || e.type !== "pointerup") return;
      var now = Date.now();
      if (now - lastTap < 320) { clearTimeout(tapT); lastTap = 0; zoomAt(sc > 1 ? 1 / sc : 2.5, e.clientX, e.clientY); return; }   // double-tap / double-click
      lastTap = now;
      if (sc === 1 && now - box._openedAt >= 900) tapT = setTimeout(closePhotoLightbox, 320);   // a lone tap at 1:1 closes, as before
    }
    // On the box in the capture phase, ahead of the box's own pointerup stop below (the hold's release): the picture's taps must still arrive.
    box.addEventListener("pointerup", function (e) { if (e.target === big) lift(e); }, true);
    box.addEventListener("pointercancel", function (e) { if (e.target === big) lift(e); }, true);
    var cr = img.parentNode && img.parentNode.parentNode && img.parentNode.parentNode.querySelector(".spg-credit");
    var cap = document.createElement("div"); cap.className = "lb-credit";
    cap.innerHTML = (img.alt ? "<b>" + escapeHtml(img.alt) + "</b> " : "") + (cr ? cr.innerHTML : "");
    box.appendChild(cap);
    var x = document.createElement("button"); x.type = "button"; x.className = "lb-close"; x.textContent = "×"; x.setAttribute("aria-label", t("btn.close"));
    box.appendChild(x);
    // The click a touch hold emits on release lands on the OVERLAY (it is on top by then) and
    // closed the picture before it was seen (owner's report, 2026-10-01): ignore clicks for a
    // moment after the hold fired.
    box.addEventListener("click", function (e) { if (e.target.closest("a")) return; e.stopPropagation(); if (e.target === big || Date.now() - box._openedAt < 900) return; closePhotoLightbox(); });   // the picture's own taps: see lift()
    box.addEventListener("pointerup", function (e) { e.stopPropagation(); }, true);   // the hold's release lands here on touch: not a tap
    document.body.appendChild(box);
    document.addEventListener("keydown", lbKey, true);   // capture: the picture's Esc must not also reach the document's Esc = Back
  }
  function lbKey(e) { if (e.key === "Escape") { closePhotoLightbox(); e.stopPropagation(); } }
  function closePhotoLightbox() {
    var b = document.getElementById("photo-lightbox");
    if (b && b.parentNode) b.parentNode.removeChild(b);
    document.removeEventListener("keydown", lbKey, true);
  }
  (function wirePhotoHold() {
    function cancel() { clearTimeout(lbHoldT); lbHoldT = null; lbStart = null; }
    document.addEventListener("pointerdown", function (e) {
      var img = e.target.closest && e.target.closest(".spg-img img");
      if (!img || e.button > 0) return;
      cancel(); lbStart = { x: e.clientX, y: e.clientY };
      lbHoldT = setTimeout(function () { lbHoldT = null; lbHoldAt = Date.now(); holdFeedback(img.parentNode); openPhotoLightbox(img); }, holdDelay());
    }, true);
    document.addEventListener("pointermove", function (e) { if (lbHoldT && lbStart && (Math.abs(e.clientX - lbStart.x) > 8 || Math.abs(e.clientY - lbStart.y) > 8)) cancel(); }, true);
    document.addEventListener("pointerup", cancel, true); document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("click", function (e) {
      var lb = document.getElementById("photo-lightbox");
      if ((Date.now() - lbHoldAt < 900 || (lb && Date.now() - lb._openedAt < 900)) && e.target.closest && e.target.closest(".spg-img img, #photo-lightbox")) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    // Right-click on a desktop, and the long-press that Android turns into a contextmenu
    // event (which used to cancel the pointer hold before it fired): both open the picture
    // full screen instead of the browser's own image menu (owner, 2026-10-01).
    document.addEventListener("contextmenu", function (e) {
      var img = e.target.closest && e.target.closest(".spg-img img"); if (!img) return;
      e.preventDefault(); e.stopPropagation();
      if (lbHoldT) { clearTimeout(lbHoldT); lbHoldT = null; }
      if (!document.getElementById("photo-lightbox") || Date.now() - lbHoldAt > 300) { lbHoldAt = Date.now(); holdFeedback(img.parentNode); openPhotoLightbox(img); }
    }, true);
  })();
  function spImgThumb(thumb) {
    return spImgAtWidth(thumb.split("?")[0].replace(/^https:\/\/thumb\.wikimedia\.org\//, "https://upload.wikimedia.org/"), SP_IMG_W);
  }
  // Licences we may show. Commons is free-only, but the summary's image can be a file
  // local to en.wikipedia, where non-free "fair use" and NC/ND files exist — and those
  // we must not redistribute. Anything we cannot positively identify as free is dropped.
  function spImgLicenceOk(name) {
    var l = String(name || "").toLowerCase();
    if (!l) return false;                                   // no licence metadata → don't show it
    // Reject FIRST, so "Attribution-NonCommercial" cannot pass on the word "attribution".
    if (/non-?free|fair use|no derivat|\bnd\b|non-?commercial|\bnc\b/.test(l)) return false;
    // Commons' free templates, as they actually appear in LicenseShortName. "Attribution"
    // (the bare {{Attribution}} template) was missing until v1815 and cost every species
    // whose picture uses it — Harmonia axyridis among them — its photo entirely.
    return /cc0|public domain|pdm|cc by|cc-by|attribution|fal|free art|gfdl|copyrighted free use|no restrictions|open government|ogl/.test(l);
  }
  // Bumped when the record's SHAPE or the rules that filled it change, so devices
  // re-fetch instead of serving entries made under the old ones (v2: 800 px thumbs,
  // untruncated author, licence URL, free-licence gate).
  var SP_IMG_VER = 5;   // v5: + GBIF occurrence photos (a remembered "no picture" must get another chance)
  // ---- Photo fallbacks for species Wikipedia has no picture of ---------------
  // Measured 2026-09-18 on species actually observed in northern Europe: the English
  // Wikipedia has a lead image for 6/14 insects, 11/14 plants, 10/14 fungi. Of the 15
  // gaps, Wikidata's image (P18) fills 7 — Commons files, free by construction and
  // carrying the same Artist/Licence metadata as any other — and iNaturalist has a photo
  // for all 15, but only 3 under a licence we may redistribute (CC0 / CC BY / CC BY-SA);
  // the rest are NonCommercial. So: Wikidata first, then iNaturalist's free ones.
  function spImgFromCommonsFile(file, sci) {
    if (!file) return Promise.resolve(null);
    var q = "https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&format=json&origin=*" +
      "&iiprop=url%7Cextmetadata&iiurlwidth=" + SP_IMG_W +
      "&iiextmetadatafilter=Artist%7CLicenseShortName%7CLicenseUrl&titles=" + encodeURIComponent("File:" + file);
    return fetch(q).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      var pages = m && m.query && m.query.pages, pg = pages && pages[Object.keys(pages)[0]];
      var ii = pg && pg.imageinfo && pg.imageinfo[0];
      if (!ii || !(ii.thumburl || ii.url)) return null;
      var em = ii.extmetadata || {};
      // The API answers on thumb.wikimedia.org; the canonical, service-worker-cached host
      // is upload.wikimedia.org — the same rewrite spImgThumb does for the article path.
      var url = String(ii.thumburl || ii.url).replace(/^https:\/\/thumb\.wikimedia\.org\//, "https://upload.wikimedia.org/");
      var rec = { v: SP_IMG_VER, t: url, f: file, h: "commons.wikimedia.org",
        a: String((em.Artist && em.Artist.value) || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
        l: String((em.LicenseShortName && em.LicenseShortName.value) || "").trim(),
        lu: String((em.LicenseUrl && em.LicenseUrl.value) || "").trim() };
      return spImgLicenceOk(rec.l) ? rec : null;   // the same gate as the Wikipedia path
    }).catch(function () { return null; });
  }
  // Wikidata knows a taxon's picture even where the English Wikipedia has no article.
  function spImgFromWikidata(sci) {
    var api = "https://www.wikidata.org/w/api.php?format=json&origin=*";
    return fetch(api + "&action=wbsearchentities&language=en&type=item&limit=5&search=" + encodeURIComponent(sci))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var hit = ((j && j.search) || []).filter(function (x) { return String(x.label || "").toLowerCase() === sci.toLowerCase(); })[0];
        if (!hit) return null;
        return fetch(api + "&action=wbgetclaims&property=P18&entity=" + encodeURIComponent(hit.id))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (c) {
            var cl = c && c.claims && c.claims.P18 && c.claims.P18[0];
            var file = cl && cl.mainsnak && cl.mainsnak.datavalue && cl.mainsnak.datavalue.value;
            return spImgFromCommonsFile(file, sci);
          });
      }).catch(function () { return null; });
  }
  // iNaturalist's own photo of the taxon — only the licences we may redistribute.
  var INAT_LIC = { cc0: { n: "CC0", u: "https://creativecommons.org/publicdomain/zero/1.0/" },
                   "cc-by": { n: "CC BY", u: "https://creativecommons.org/licenses/by/4.0/" },
                   "cc-by-sa": { n: "CC BY-SA", u: "https://creativecommons.org/licenses/by-sa/4.0/" } };
  function spImgFromInat(sci) {
    return fetch("https://api.inaturalist.org/v1/taxa?rank=species&per_page=5&q=" + encodeURIComponent(sci))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var hit = ((j && j.results) || []).filter(function (x) { return String(x.name || "").toLowerCase() === sci.toLowerCase(); })[0];
        var dp = hit && hit.default_photo;
        var lic = dp && INAT_LIC[dp.license_code];
        if (!dp || !lic || !dp.medium_url) return null;   // NonCommercial / all rights reserved → not ours to show
        return { v: SP_IMG_VER, t: String(dp.medium_url).replace(/\/medium\.(jpe?g|png)/i, "/large.$1"),
          a: String(dp.attribution || "").replace(/\s+/g, " ").trim().slice(0, 240), l: lic.n, lu: lic.u,
          pg: "https://www.inaturalist.org/taxa/" + hit.id, f: "", h: "" };
      }).catch(function () { return null; });
  }
  // GBIF occurrence photographs: the observers' own pictures, asked for under CC0 / CC BY
  // only (GBIF filters server-side, so nothing we may not redistribute is even returned).
  // Measured 2026-09-22 over 30 Norwegian insect and 30 plant species: the English Wikipedia
  // has an article photo for 73 % of the insects and 93 % of the plants, and iNaturalist's
  // own default photo for 7 % and 20 % (most of theirs are CC BY-NC) — GBIF has one for
  // ALL of them, closing the gap for 8 of the 30 insects and 2 of the 30 plants outright.
  // Insects and plants are exactly where the encyclopaedias run out, which is why this is
  // the source worth adding rather than another article index.
  var GBIF_IMG_LIC = [
    [/publicdomain\/(zero|mark)/i, { n: "CC0", u: "https://creativecommons.org/publicdomain/zero/1.0/" }],
    [/licenses\/by-sa\//i, { n: "CC BY-SA", u: "https://creativecommons.org/licenses/by-sa/4.0/" }],
    [/licenses\/by\//i, { n: "CC BY", u: "https://creativecommons.org/licenses/by/4.0/" }]
  ];
  function gbifImgLic(url) {
    var t = String(url || "");
    for (var i = 0; i < GBIF_IMG_LIC.length; i++) if (GBIF_IMG_LIC[i][0].test(t)) return GBIF_IMG_LIC[i][1];
    return null;   // anything we can't name, we don't show
  }
  function spImgFromGbif(sci) {
    return fetch("https://api.gbif.org/v1/occurrence/search?mediaType=StillImage&limit=5" +
        "&license=CC0_1_0&license=CC_BY_4_0&scientificName=" + encodeURIComponent(sci))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var rows = (j && j.results) || [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i], lic = gbifImgLic(r.license); if (!lic) continue;
          var m = (r.media || []).filter(function (x) {
            return x && x.type === "StillImage" && x.identifier && /^https:\/\//i.test(x.identifier);
          })[0];
          if (!m) continue;
          // Several of these fields can be a bare numeric account id (Flickr, iNaturalist),
          // which is no credit at all — take the first candidate that names a person.
          var cand = [m.creator, m.rightsHolder, r.rightsHolder, r.recordedBy], by = "";
          for (var c = 0; c < cand.length; c++) {
            var v = String(cand[c] == null ? "" : cand[c]).trim();
            if (v && !/^-?\d+$/.test(v)) { by = v; break; }
          }
          return { v: SP_IMG_VER, t: m.identifier, a: by.slice(0, 240), l: lic.n, lu: lic.u,
                   pg: r.key ? "https://www.gbif.org/occurrence/" + r.key : "", f: "", h: "" };
        }
        return null;
      }).catch(function () { return null; });
  }
  // Curated pictures first (an encyclopaedia's chosen lead image), then a field photograph.
  function spImageFallbacks(sci) {
    return spImgFromWikidata(sci)
      .then(function (rec) { return rec || spImgFromInat(sci); })
      .then(function (rec) { return rec || spImgFromGbif(sci); });
  }
  // ---- Whole-list lookup ----------------------------------------------------
  // A family popup opens every member at once — Anatidae is 164 cards. Asking per card
  // is two Wikimedia requests each: measured 2026-09-19 that took 150 s to fill and
  // tripped the app's own "photos are not answering" guard on the way (48 cards wearing
  // the offline mark at t+60 s), so most of a big family looked broken for minutes.
  // The MediaWiki API answers 50 titles per request, so the same family costs four
  // round trips to en.wikipedia (which article, which picture) and four to Commons
  // (who took it, under what licence) — and lands in a couple of seconds.
  var SP_BATCH = 50;
  function mwQuery(host, params) {
    return fetch("https://" + host + "/w/api.php?action=query&format=json&formatversion=2&origin=*&" + params)
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function spImgTitle(sci) { return String(sci || "").trim().replace(/\s+/g, "_"); }
  // file name -> { a, l, lu, h } for up to SP_BATCH files, Commons first and then the
  // ones that turned out to be local to en.wikipedia.
  function spImgMetaBatch(files) {
    var out = {};
    function ask(host, list) {
      if (!list.length) return Promise.resolve([]);
      return mwQuery(host, "prop=imageinfo&iiprop=extmetadata&iiextmetadatafilter=Artist%7CLicenseShortName%7CLicenseUrl&titles=" +
        encodeURIComponent(list.map(function (f) { return "File:" + f; }).join("|"))).then(function (j) {
        var miss = [];
        ((j && j.query && j.query.pages) || []).forEach(function (pg) {
          var name = String(pg.title || "").replace(/^File:/, "").replace(/ /g, "_");   // the API answers with spaces, pageimage uses underscores
          var ii = pg.imageinfo && pg.imageinfo[0] && pg.imageinfo[0].extmetadata;
          if (pg.missing || !ii) { if (name) miss.push(name); return; }
          out[name] = {
            a: String((ii.Artist && ii.Artist.value) || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
            l: String((ii.LicenseShortName && ii.LicenseShortName.value) || "").trim(),
            lu: String((ii.LicenseUrl && ii.LicenseUrl.value) || "").trim(), h: host };
        });
        return miss;
      });
    }
    return ask("commons.wikimedia.org", files).then(function (miss) { return ask("en.wikipedia.org", miss); }).then(function () { return out; });
  }
  function spImgBatchOnce(scis) {
    return mwQuery("en.wikipedia.org", "redirects=1&prop=pageimages%7Cpageprops&ppprop=disambiguation&piprop=thumbnail%7Cname&pithumbsize=" + SP_IMG_W +
      "&titles=" + encodeURIComponent(scis.map(spImgTitle).join("|"))).then(function (j) {
      var q = j && j.query; if (!q) return null;                 // transient: leave these to the per-card chain
      // What we asked for -> the article MediaWiki actually answered about.
      var to = {};
      (q.normalized || []).forEach(function (n) { to[n.from] = n.to; });
      (q.redirects || []).forEach(function (n) { to[n.from] = n.to; });
      var byTitle = {};
      (q.pages || []).forEach(function (pg) { byTitle[pg.title] = pg; });
      var recs = {}, files = [];
      scis.forEach(function (sci) {
        var t = spImgTitle(sci);
        for (var i = 0; i < 3 && to[t]; i++) t = to[t];          // normalise, then follow the redirect
        var pg = byTitle[t] || byTitle[t.replace(/_/g, " ")];
        var th = pg && pg.thumbnail && pg.thumbnail.source;
        // No article picture, or the name leads to a disambiguation page (whose "image" is
        // an icon, not the species) — both cases go to spImageFallbacks, as the single-species
        // path has always done.
        if (!th || !pg.pageimage || (pg.pageprops && pg.pageprops.disambiguation !== undefined)) return;
        recs[sci] = { v: SP_IMG_VER, t: spImgThumb(th), f: pg.pageimage, a: "", l: "" };
        files.push(pg.pageimage);
      });
      if (!files.length) return recs;
      return spImgMetaBatch(files).then(function (meta) {
        Object.keys(recs).forEach(function (sci) {
          var m = meta[recs[sci].f];
          if (m) { recs[sci].a = m.a; recs[sci].l = m.l; recs[sci].lu = m.lu; recs[sci].h = m.h; }
        });
        return recs;
      });
    });
  }
  // Fill the photo cache for a list of species. Batches run one after another (eight
  // requests for a big family, not 328) and only positively-free pictures are kept —
  // everything else is simply not remembered, so the per-card chain still gets its turn.
  function spImagesPrefetch(scis) {
    if (!scis.length || photoNetDown()) return Promise.resolve();
    var chain = Promise.resolve();
    for (var i = 0; i < scis.length; i += SP_BATCH) {
      (function (part) {
        chain = chain.then(function () {
          return spImgBatchOnce(part).then(function (recs) {
            if (!recs) return;
            var keep = {}, n = 0;
            Object.keys(recs).forEach(function (sci) { if (spImgLicenceOk(recs[sci].l)) { keep[sci] = recs[sci]; n++; } });
            if (n) spImgRememberMany(keep);
          }, function () {});
        });
      })(scis.slice(i, i + SP_BATCH));
    }
    return chain;
  }
  // The observations YOU have fetched are the last resort for a species picture: many of
  // them carry the observer's own photograph, and for an insect or a plant that nothing has
  // illustrated anywhere, the person who found it down the road usually has. Nothing is
  // downloaded to do this — the pictures are already on the device, listed behind the 📷 of
  // each record — so it costs one walk of the plotted rows.
  // Credit is the photographer's name, linked to the observation report it came from.
  function obsPhotoForSci(sci) {
    if (typeof getDetPlot() === "undefined" || !getDetPlot()) return null;
    var want = String(sci || "").trim().toLowerCase(); if (!want) return null;
    var keys = Object.keys(getDetPlot());
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], e = getDetPlot()[k]; if (!e) continue;
      // A species the model covers is keyed by its code; everything else by "x:<sci name>".
      var esci = k.indexOf("x:") === 0 ? k.slice(2) : ((getLabelsByKey()[k] && getLabelsByKey()[k].sci) || "");
      if (String(esci).trim().toLowerCase() !== want) continue;
      // Prefer a photograph whose credit does NOT say NonCommercial / NoDerivatives: the
      // app's own picture sources are filtered to freely-licensed images, so where the
      // observations offer a choice, take one under the same terms. Whatever is chosen is
      // shown with the credit exactly as its source wrote it (licence included) and a link
      // to the record, which is what these licences ask for.
      var rows = e.rows || [], best = null;
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j], u = r.photoBig || r.photo;
        if (!u || !/^https:\/\//i.test(u)) continue;
        var by = String(r.photoBy || r.observer || "").trim().replace(/^(\(c\)|©)\s*/i, "");
        var rec = { v: SP_IMG_VER, t: u, a: by.slice(0, 240), l: "", lu: "", pg: r.url || "", f: "", h: "", obs: 1 };
        if (!/non-?commercial|\bnc\b|no-?deriv|\bnd\b/i.test(by)) return rec;   // free, or no licence stated
        if (!best) best = rec;
      }
      if (best) return best;
    }
    return null;
  }
  function spImageFor(sci) {
    return spImageFromRefs(sci).then(function (rec) {
      if (rec && !rec.none) return rec;                 // a reference source had one — it wins
      if (rec && rec.tmp) return rec;                   // couldn't reach them (offline): a remote
                                                        // observation photo would not load either
      return obsPhotoForSci(sci) || rec || { none: 1 };
    });
  }
  // The reference sources, in order, with their own caching. Deliberately kept separate from
  // the wrapper above: a "no picture anywhere" answer is still remembered here, so the
  // network chain runs once — while the local observation lookup is redone each time, and so
  // picks up photographs from whatever has been fetched since.
  function spImageFromRefs(sci) {
    var c = spImgStore();
    if (c[sci] && c[sci].v === SP_IMG_VER) return Promise.resolve(c[sci]);
    if (c[sci] && c[sci].none && c[sci].tmp) return Promise.resolve(c[sci]);   // transient miss: unchanged by the rules above
    if (photoNetDown()) return Promise.resolve({ none: 1, tmp: 1 });   // offline / service down: don't even ask (the SW would answer 503) — retried later
    var title = encodeURIComponent(sci.trim().replace(/\s+/g, "_"));
    return fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + title, { headers: { Accept: "application/json" } })
      // Only a definite 404 means "no article" (remembered below); any other failure —
      // offline 503 from the service worker, 429, 5xx — is transient and must not be remembered.
      .then(function (r) { if (r.ok) return r.json(); if (r.status === 404) return null; throw new Error("summary " + r.status); })
      .then(function (j) { return j || { __noArticle: 1 }; })   // no article ≠ no picture: the fallbacks still run
      .then(function (j) {
        var thumb = j && j.thumbnail && j.thumbnail.source, orig = j && j.originalimage && j.originalimage.source;
        if (!thumb || (j && j.type === "disambiguation")) {
          return spImageFallbacks(sci).then(function (fb) {
            spImgRemember(sci, fb || { v: SP_IMG_VER, none: 1 });
            return fb || { none: 1 };
          });
        }
        var file = spImgFileFromUrl(orig || thumb);
        var rec = { v: SP_IMG_VER, t: spImgThumb(thumb), f: file, a: "", l: "" };
        // Author + licence from the file's metadata (Commons first, else the file may be local to en.wikipedia).
        var q = "w/api.php?action=query&prop=imageinfo&iiprop=extmetadata&iiextmetadatafilter=Artist%7CLicenseShortName%7CLicenseUrl&format=json&origin=*&titles=File:" + encodeURIComponent(file);
        function meta(host) {
          return fetch("https://" + host + "/" + q).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
            var pages = m && m.query && m.query.pages, pg = pages && pages[Object.keys(pages)[0]];
            var ii = pg && pg.imageinfo && pg.imageinfo[0] && pg.imageinfo[0].extmetadata;
            if (!ii) return false;
            // The WHOLE author string (audited: real ones run to 251 chars) — a truncated
            // credit is not the attribution CC BY/BY-SA asks for. 240 is a sanity cap.
            rec.a = String((ii.Artist && ii.Artist.value) || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
            rec.l = String((ii.LicenseShortName && ii.LicenseShortName.value) || "").trim();
            rec.lu = String((ii.LicenseUrl && ii.LicenseUrl.value) || "").trim();   // link the deed, not just the file page
            rec.h = host; return true;
          }).catch(function () { return false; });
        }
        return meta("commons.wikimedia.org").then(function (ok) { return ok ? true : meta("en.wikipedia.org"); })
          .then(function () {
            // No positively-free licence → treat the species as having no photo (remembered,
            // so we don't ask again) rather than showing something we may not redistribute.
            if (!spImgLicenceOk(rec.l)) {
              return spImageFallbacks(sci).then(function (fb) {
                spImgRemember(sci, fb || { v: SP_IMG_VER, none: 1 });
                return fb || { none: 1 };
              });
            }
            spImgRemember(sci, rec); return rec;
          });
      })
      .catch(function () { return { none: 1, tmp: 1 }; });   // network trouble: not remembered, retried next time
  }
  function buildSpGalleryHtml() {
    var tbody = document.getElementById("sp-tbody"); if (!tbody) return "";
    // Before the observations have landed the table holds the model's whole prediction list
    // (default sort: rarest first) — as cards that would be a wall of exotic species whose
    // photos start downloading. Wait for the fetch instead; [?] (predictions wanted) still shows.
    // …but rows that came FROM observations (a fetched species, or an extra — which is
    // every plant, fungus and most insects, none of which the model predicts) are not
    // that wall: they are the result. Waiting on `_sightingsAgg`, which only a per-point
    // fetch attaches, left those layouts on a permanent spinner — plants and fungi never
    // appeared in the Images view at all.
    var anyObserved = tbody.querySelector("tr.sp-has-det, tr.sp-extra");
    if (!tbody._sightingsAgg && !spMissingOn() && !anyObserved) return '<div class="dl-empty spg-wait"><div class="spinner"></div>' + escapeHtml(t("status.loadingDet")) + "</div>";
    // The name search hides table rows with a CLASS (it composes with the inline
    // show/hide) — the cards are built from the rows, so they must honour it too.
    var rows = Array.prototype.filter.call(tbody.children, function (tr) {
      return tr.style.display !== "none" && !tr.classList.contains("sp-hide-search") && !tr.classList.contains("sp-detail-row");
    });
    if (!rows.length) return '<div class="dl-empty">' + escapeHtml(t("detlist.empty")) + "</div>";
    var lbl = { total: t("th.total"), last: t("th.last"), dist: t("th.dist"), prob: t("th.prob") };
    return '<div class="sp-gallery">' + rows.map(function (tr) {
      // .sp-link is the MODEL species' name (clickable → species menu). An extra row —
      // every plant, fungus and most insects — carries its name in .sp-extra-name instead,
      // and without this the card showed a scientific name and nothing else.
      var link = tr.querySelector(".sp-link") || tr.querySelector(".sp-extra-name");
      var sciTd = tr.querySelector("td.sci");
      var sci = sciTd ? sciTd.textContent.trim() : (link ? link.getAttribute("data-sci") || "" : "");
      var sciEl = sciTd ? sciTd.querySelector(".sci-link") : null;   // the table's clickable sci (→ Family menu), reused as-is
      // The .sp-dot HOLDER, not the bare swatch inside it: the swatch is an inline span whose
      // width/height only apply as a flex item of that holder — cloned alone it collapsed to a
      // thin line beside the name. The holder carries the status too (★ / rare centre dot /
      // year-life ring), so the card shows the same dot as every other list.
      var dot = tr.querySelector(".sp-dot, .sp-cdot, .det-sw");
      var nd = tr.querySelector(".det-nd"), last = tr.querySelector(".sp-last"), dist = tr.querySelector(".sp-dist"), prob = tr.querySelector(".prob-num");
      var probTd = tr.querySelector("td.prob-cell");   // number + coloured bar, cloned as-is
      // A model row carries its key on .sp-link; an extra (plant, fungus, most insects)
      // has none, so derive the same "x:<scientific name>" key the table uses — that is
      // what spDetailRowsFor / openSpeciesListRow expect, and without it these cards had
      // no records button at all.
      var key = link ? link.getAttribute("data-key") || "" : "";
      if (!key) {
        var exBtn = tr.querySelector(".det-count-extra[data-sci]");
        var exSci = exBtn ? exBtn.getAttribute("data-sci") : sci;
        if (exSci) key = "x:" + String(exSci).toLowerCase();
      }
      var lastChip = last ? last.querySelector("[data-date]") : null, lastDate = lastChip ? lastChip.getAttribute("data-date") || "" : "";
      // Rows with records have a sub-list to open — a model species that was actually
      // observed (.sp-has-det) OR an extra, which exists only BECAUSE it was observed.
      var subBtn = (key && (tr.classList.contains("sp-has-det") || tr.classList.contains("sp-extra")))
        ? '<button type="button" class="spg-sub" data-key="' + escapeHtml(key) + '" title="' + escapeHtml(t("spg.records")) + '" aria-label="' + escapeHtml(t("spg.records")) + '">\u2630</button>' : "";
      // The card's name line reads "name [second language] (Scientific name)". The second
      // name is taken from the row's own name2 cell, so it is whatever the table shows and
      // stays right through a language change; the scientific name follows the
      // Scientific-names setting exactly as the table's column does — this local used to
      // SHADOW the module's `getShowSci()` flag, so the cards printed it whatever the setting
      // said. Still suppressed when the name already IS the scientific name.
      var sciDiff = sci && !(link && link.textContent.trim() === sci);
      var n2El = tr.querySelector("td.name2");
      var n2 = (getSecondLang() && n2El) ? n2El.textContent.trim() : "";
      var photoLink = !!key && isBirdKey(key);   // Macaulay Library is birds-only (as in the species menu)
      var probLink = !!key && !!getLabelsByKey()[key];   // model species only: the Migration view / year curve need the model
      var predicted = !!key && !tr.classList.contains("sp-has-det") && !tr.classList.contains("sp-extra");   // [?] mode: a model prediction with no records here
      function plain(prefix, el) { var v = el ? el.textContent.trim() : ""; return v ? '<span class="spg-m">' + escapeHtml(prefix + v) + "</span>" : ""; }
      // The last-seen date, clickable like the table's: plain() keeps only textContent, so
      // the card used to lose the .dl-date-click the Last column carries and the date was
      // the one number on a card you could not filter by.
      function dateChip(el, iso) {
        var v = el ? el.textContent.trim() : "";
        if (!v) return "";
        if (!iso) return '<span class="spg-m">' + escapeHtml(v) + "</span>";
        return '<span class="spg-m spg-date dl-date-click" role="button" tabindex="0" data-date="' + escapeHtml(iso) +
          '" title="' + escapeHtml(t("detlist.dateFilterHint")) + '">' + escapeHtml(v) + "</span>";
      }
      function cell(label, el, attrs) { var v = el ? el.textContent.trim() : ""; return v ? '<span class="spg-m' + (attrs ? " " + attrs.cls : "") + '"' + (attrs ? attrs.a : "") + '><span class="spg-k">' + escapeHtml(label) + "</span> " + escapeHtml(v) + "</span>" : ""; }
      // Prob · Season · Yr peak as bar cells on one line (the table's / observation list's cells);
      // Season + Yr peak are filled once the point's 48-week prediction is in (fillSpGalleryBars).
      var barsRow = (probLink && probTd) ? '<div class="spg-bars">' +
          '<span class="spg-bar prob-cell spg-prob" role="button" title="' + escapeHtml(t("spg.probTip")) + '"><span class="spg-k">' + escapeHtml(t("th.probAbbr")) + "</span>" + probTd.innerHTML + "</span>" +
          '<span class="spg-bar season-cell sp-season" data-key="' + escapeHtml(key) + '" role="button" title="' + escapeHtml(t("th.seasonHint")) + '"><span class="spg-k">' + escapeHtml(t("th.season")) + "</span></span>" +
          '<span class="spg-bar prob-cell sp-ytop" data-key="' + escapeHtml(key) + '" role="button"><span class="spg-k">' + escapeHtml(ytopLabel()) + "</span></span>" +
        "</div>" : "";
      return '<div class="spg-card' + (predicted ? " spg-pred" : "") + '" data-sci="' + escapeHtml(sci) + '" data-key="' + escapeHtml(key) + '" data-cls="' + escapeHtml(tr.getAttribute("data-cls") || "") + '" data-date="' + escapeHtml(lastDate) + '">' +
        '<div class="spg-img' + (photoLink ? ' spg-img-link" role="button" title="' + escapeHtml(t("spg.photosTip")) : '"') + '">' +
          (predicted ? '<span class="spg-tag">' + escapeHtml(t("spg.predicted")) + "</span>" : "") +
          '<span class="spg-none" style="display:none">' + escapeHtml(t("spg.noImage")) + "</span></div>" +
        '<div class="spg-name"><span class="spg-nm">' + (dot ? dot.outerHTML : "") + (link ? link.outerHTML : "") +
          (n2 ? ' <span class="spg-n2">[' + escapeHtml(n2) + "]</span>" : "") +
          (getShowSci() && sciDiff ? ' <span class="spg-sci">(' + (sciEl ? sciEl.outerHTML : escapeHtml(sci)) + ")</span>" : "") + "</span>" + subBtn + "</div>" +
        // Compact, label-free meta line: "#total(n)  last-seen  distance" (the bars row below
        // carries the probabilities; a card without the bars keeps a labelled Probability).
        '<div class="spg-meta">' + plain("#", nd) + dateChip(last, lastDate) + plain("", dist) + (barsRow ? "" : cell(lbl.prob, prob)) + "</div>" +
        barsRow +
        '<div class="spg-credit"></div>' +
      "</div>";
    }).join("") + "</div>";
  }
  // Load a species' photo into a card: the picture into `box`, the author/licence line
  // into `cr` (linked to the Commons file page), or reveal `none`. Resolves true when
  // a picture was found, false when there is none, null on network trouble (not
  // remembered, so a later call retries).
  // Offline (or the photo can't be reached and isn't in the on-device cache): a small
  // "no internet" mark instead of the "No image" text, and the card stays retryable.
  // Photo lookups all fail the same way when the connection (or Wikimedia) is down: the
  // service worker answers 503 and every card would mark itself and queue a doomed
  // request. After a few failures in a row, stop asking, say it ONCE above the cards, and
  // try again when the connection returns (or after a cooldown).
  var spPhotoFailStreak = 0, spPhotoDown = false, spPhotoRetryTimer = null;
  var SPG_FAIL_TRIP = 4, SPG_RETRY_MS = 30000;
  function photoNetDown() { return navigator.onLine === false || spPhotoDown; }
  function spPhotoNoteEl(show) {
    var rec = document.getElementById("sp-records"); if (!rec) return;
    var el = rec.querySelector(".spg-photonote");
    if (!show) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement("div"); el.className = "spg-photonote";
    el.innerHTML = OFFLINE_ICO + "<span>" + escapeHtml(t("spg.photosDown")) + "</span>";
    var gal = rec.querySelector(".sp-gallery");
    if (gal) rec.insertBefore(el, gal); else rec.appendChild(el);
  }
  function spPhotoFailed() {
    if (++spPhotoFailStreak < SPG_FAIL_TRIP || spPhotoDown) return;
    spPhotoDown = true; spPhotoNoteEl(true);
    clearTimeout(spPhotoRetryTimer);
    spPhotoRetryTimer = setTimeout(function () { spPhotoDown = false; spPhotoFailStreak = 0; spPhotoNoteEl(false); }, SPG_RETRY_MS);
  }
  function spPhotoOk() {
    spPhotoFailStreak = 0;
    // A success means the service answers again — but keep the note while marked cards remain.
    if (spPhotoDown) { spPhotoDown = false; clearTimeout(spPhotoRetryTimer); }
  }
  var OFFLINE_ICO = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5 12a11 11 0 0 1 14 0"/><path d="M8.5 15.5a6 6 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';
  function markOffline(box, none) {
    if (none) none.style.display = "none";   // one indicator per card, never "No image" AND the mark
    spPhotoNoteEl(true);                     // say once, above the cards, why the marks are there
    if (!box || box.querySelector(".spg-offline")) return;
    var o = document.createElement("span"); o.className = "spg-offline"; o.title = t("spg.offline"); o.setAttribute("aria-label", t("spg.offline"));
    o.innerHTML = OFFLINE_ICO; box.appendChild(o);
  }
  // The taxonomic class behind a picture card: the Images cards carry it as data-cls,
  // and an observed species that does not is looked up among the plotted extras.
  function cardClassFor(box, sci) {
    var host = (box && box.closest) ? box.closest("[data-cls]") : null;
    var c = host ? host.getAttribute("data-cls") : "";
    if (c) return c;
    var e = (typeof getDetPlot() !== "undefined" && getDetPlot()) ? getDetPlot()["x:" + String(sci || "").trim().toLowerCase()] : null;
    return (e && e.cls) || "";
  }
  function inatPhotosUrl(sci) { return "https://www.inaturalist.org/taxa/search?q=" + encodeURIComponent(String(sci || "").trim()); }
  // Where to send someone when the app can show no picture itself: per group, the site that
  // does have photographs AND whose photographs we may not put on the card.
  //   plants — Kew's Plants of the World Online. Measured: Cloudflare answers 403 to its API
  //            and to a taxon page alike, with or without a browser User-Agent, and sends no
  //            CORS header, so it can only ever be a link.
  //   fungi, insects and the other invertebrates — iNaturalist, far the largest photo archive
  //            for them, whose pictures are mostly CC BY-NC and so cannot be redistributed here.
  var NO_IMG_REF = { plantae: 1, fungi: 2, insecta: 2, arachnida: 2, mollusca: 2 };
  function noImageRef(cls, sci) {
    var which = NO_IMG_REF[String(cls || "").toLowerCase()];
    if (which === 1) return { url: powoUrl(sci), label: t("menu.powo") };
    if (which === 2) return { url: inatPhotosUrl(sci), label: t("menu.inat") };
    return null;   // birds and mammals are well covered — an empty frame is the honest answer
  }
  // No picture anywhere. For a plant, a fungus or an insect that is the common case, so rather
  // than an empty frame saying "no image", the card carries a LINK to where the pictures are.
  function markNoImage(box, none, sci) {
    var o = box && box.querySelector(".spg-offline"); if (o) o.remove();
    if (!box) { if (none) none.style.display = ""; return; }
    var old = box.querySelector(".spg-powo"); if (old) old.remove();
    var ref = sci ? noImageRef(cardClassFor(box, sci), sci) : null;
    if (ref) {
      if (none) none.style.display = "none";
      var a = document.createElement("a");
      a.className = "spg-powo";
      a.href = ref.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = ref.label + " \u2197";
      a.title = sci;
      a.addEventListener("click", function (e) { e.stopPropagation(); });   // the card itself opens other things
      box.appendChild(a);
      return;
    }
    if (none) none.style.display = "";
  }
  // Back online: retry every photo that was marked offline (gallery cards + confusion cards).
  window.addEventListener("online", function () {
    spPhotoDown = false; spPhotoFailStreak = 0; clearTimeout(spPhotoRetryTimer); spPhotoNoteEl(false);   // back online: retry every marked card
    Array.prototype.forEach.call(document.querySelectorAll(".spg-offline"), function (o) {
      var box = o.parentNode, card = box && box.closest(".spg-card, .cfi-card"); o.remove();
      if (!card) return;
      if (card.classList.contains("spg-card")) card._spgDone = false;
      loadSpPhoto(box, card.querySelector(".spg-none"), card.querySelector(".spg-credit"), card.getAttribute("data-sci"))
        .then(function (ok) { if (card.classList.contains("spg-card") && ok !== null) card._spgDone = true; });
    });
  });
  // The credit line under a photo: photographer (or the service it came from) → the file page, then the licence → its deed.
  function spCreditHtml(r) {
    var page = r.pg || ("https://" + (r.h || "commons.wikimedia.org") + "/wiki/File:" + encodeURIComponent((r.f || "").replace(/ /g, "_")));
    // With no photographer to name, credit the service the picture actually came from —
    // saying "Wikimedia Commons" under a GBIF field photograph would be simply untrue.
    var hm = String(page || "").match(/^https?:\/\/([^\/]+)/), host = hm ? hm[1].replace(/^www\./i, "") : "";
    var site = /gbif\.org$/i.test(host) ? "GBIF"
      : (/inaturalist\.org$/i.test(host) ? "iNaturalist"
      : (!host || /wiki(m|p)edia\.org$/i.test(host) ? "Wikimedia Commons" : host));
    return '<a href="' + escapeHtml(page) + '" target="_blank" rel="noopener">' + escapeHtml(r.a ? "© " + r.a : site) + "</a>" +
      (r.l ? " · " + (r.lu
        ? '<a href="' + escapeHtml(r.lu) + '" target="_blank" rel="noopener">' + escapeHtml(r.l) + "</a>"   // the licence deed itself
        : escapeHtml(r.l)) : "");
  }
  // ---- Wikimedia Commons category grid (owner, 2026-10-30: a tap on an Images-layout photo opens "the Wikimedia Commons
  // in a nice labeled grid, showing all the available sub categories, but only max of each category", the Macaulay link for
  // the current time of year at the bottom). Commons files a species' photos under "<Scientific name> (male)", "(female)",
  // "(juvenile)", "(eggs)", "(flocks)", "(in flight)" …; one request lists those names, one per category fetches its first
  // free image files with their credits. No sub-category → the species category itself as the one section.
  var CM_PER_CAT = 4, cmCache = Object.create(null);
  function cmApi(params) {
    return fetch("https://commons.wikimedia.org/w/api.php?format=json&origin=*&" + params).then(function (r) { return r.ok ? r.json() : null; });
  }
  // Categories that are not wild birds in natural situations (owner, 2026-10-30: "illustration, museum specimens, being ringed …
  // are not interesting") are left out.
  var CM_SKIP = /illustrat|museum|specimen|ring(ed|ing)|captiv|dead|historical|\bmaps?\b|anatom|skull|skeleton|taxiderm|drawing|painting|stamp|audio|video|incidental|recording|low quality|distribution|\brange\b|\bzoo\b|aviar|cage/i;
  var CM_SKIP_FILE = /\bmaps?\b|distribution|\brange\b|verbreitung|karte|\bareal|chart|diagram/i;   // a map filed under a kept category (owner, 2026-10-30: "The distribution images should not be included")
  function cmSections(sci) {
    return cmApi("action=query&list=allcategories&aclimit=60&acprefix=" + encodeURIComponent(sci + " (")).then(function (m) {
      var out = [];
      (((m || {}).query || {}).allcategories || []).forEach(function (c) {
        var mm = /^(.+) \(([^()]+)\)$/.exec(String(c["*"] || "")); if (!mm || mm[1] !== sci || CM_SKIP.test(mm[2])) return;
        out.push({ cat: c["*"], label: mm[2].charAt(0).toUpperCase() + mm[2].slice(1) });
      });
      return out.length ? cmOrder(out) : [{ cat: sci, label: "" }];
    }, function () { return [{ cat: sci, label: "" }]; });
  }
  // The best CM_PER_CAT free image files of one category, with their credits (owner, 2026-10-30: "preferably images of good
  // quality"): from a pool of up to 50, Commons' own assessments first — Featured, Quality, Valued images — then the pixel count.
  var CM_ASSESS = { "Category:Featured pictures on Wikimedia Commons": 3, "Category:Quality images": 2, "Category:Valued images": 1 };
  function cmFiles(cat) {
    return cmApi("action=query&generator=categorymembers&gcmtype=file&gcmlimit=50&gcmtitle=" + encodeURIComponent("Category:" + cat) +
      "&prop=imageinfo%7Ccategories&iiprop=url%7Cextmetadata%7Cmime%7Csize&iiurlwidth=320&iiextmetadatafilter=Artist%7CLicenseShortName%7CLicenseUrl" +
      "&cllimit=max&clcategories=" + encodeURIComponent(Object.keys(CM_ASSESS).join("|"))).then(function (m) {
      var pages = (((m || {}).query || {}).pages) || {}, out = [];
      Object.keys(pages).forEach(function (id) {
        var pg = pages[id], ii = pg.imageinfo && pg.imageinfo[0], em = (ii && ii.extmetadata) || {};
        if (!ii || !/^image\/(jpe?g|png|webp|tiff?)$/i.test(ii.mime || "") || !ii.thumburl || CM_SKIP_FILE.test(String(pg.title || ""))) return;   // photographs only: no SVG / GIF maps and diagrams
        var l = String((em.LicenseShortName && em.LicenseShortName.value) || "").trim();
        if (!spImgLicenceOk(l)) return;
        var q = 0; (pg.categories || []).forEach(function (c) { q = Math.max(q, CM_ASSESS[c.title] || 0); });
        out.push({ t: String(ii.thumburl).replace(/^https:\/\/thumb\.wikimedia\.org\//, "https://upload.wikimedia.org/"), f: String(pg.title || "").replace(/^File:/, ""), h: "commons.wikimedia.org",
          a: String((em.Artist && em.Artist.value) || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240), l: l,
          lu: String((em.LicenseUrl && em.LicenseUrl.value) || "").trim(), q: q, px: (ii.width || 0) * (ii.height || 0) });
      });
      out.sort(function (a, b) { return (b.q - a.q) || (b.px - a.px); });
      return out.slice(0, CM_PER_CAT);
    }, function () { return []; });
  }
  // iNaturalist tops up the groups it can name (owner, 2026-10-30: "fill up with iNaturalist API images to attempt to fill
  // categories with at least two images"): research-grade observations annotated male / female (sex) or juvenile (life stage),
  // the licences we may show (CC0 / CC BY / CC BY-SA), most-faved first, one per photographer. Male, female and juvenile groups
  // are always present, so a species Commons has not sorted still gets them.
  var INAT_TERMS = { male: "term_id=9&term_value_id=11", female: "term_id=9&term_value_id=10", juvenile: "term_id=1&term_value_id=7" }, CM_MIN = 2;
  function inatFill(sci, label, n) {
    return fetch("https://api.inaturalist.org/v1/observations?photos=true&quality_grade=research&photo_license=cc0,cc-by,cc-by-sa&order_by=votes&order=desc&per_page=" + (n * 4) +
      "&taxon_name=" + encodeURIComponent(sci) + "&" + INAT_TERMS[label])
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        var out = [], seen = {};
        ((j && j.results) || []).forEach(function (o) {
          if (out.length >= n || !o.taxon || String(o.taxon.name || "").indexOf(sci) !== 0) return;   // the species (or a subspecies of it), not a fuzzy name match
          var uid = o.user && o.user.id; if (seen[uid]) return;
          var ph = (o.photos || []).filter(function (p) { return p && p.url && INAT_LIC[p.license_code]; })[0]; if (!ph) return;
          seen[uid] = 1;
          var lic = INAT_LIC[ph.license_code];
          out.push({ t: String(ph.url).replace(/\/square\./, "/large."), f: "", h: "", pg: "https://www.inaturalist.org/observations/" + o.id,
            a: String(ph.attribution || "").replace(/^\(c\)\s*/i, "").replace(/,\s*(some|all) rights reserved.*$/i, "").replace(/,\s*no rights reserved.*$/i, "").trim().slice(0, 240), l: lic.n, lu: lic.u });
        });
        return out;
      }, function () { return []; });
  }
  function cmOrder(secs) {
    var first = ["male", "female", "pairs", "pair", "juvenile", "juveniles", "in flight", "flying"];   // the owner's picks lead; the other natural situations follow in Commons order
    secs.sort(function (a, b) { var ia = first.indexOf(a.label.toLowerCase()), ib = first.indexOf(b.label.toLowerCase()); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    return secs;
  }
  function openCommonsGrid(key, sci, name) {
    var m = createModal({ boxClass: "cm-box", escClose: true }), box = m.box;
    var none = '<div class="cmp-nocol">' + escapeHtml(t("cm.none")) + "</div>";
    box.innerHTML = '<div class="cm-hdr"><b class="cm-name">' + escapeHtml(name || sci) + "</b><span>" + escapeHtml(t("cm.sub", { n: CM_PER_CAT })) + "</span></div>" +
      '<div class="cm-body"><div class="dl-empty spg-wait"><div class="spinner"></div></div></div>' +
      '<a class="cm-more" href="' + escapeHtml(macaulayUrl(key, sci, "")) + '" target="_blank" rel="noopener">' + escapeHtml(t("cm.ml")) + "</a>";
    box.querySelector(".cm-more").addEventListener("click", function (e) { e.preventDefault(); openExternal(this.href); });
    // The name is a search box: pick another species and the grid reopens for it (owner, 2026-10-31).
    wireSpeciesPicker(box.querySelector(".cm-name"), function (l, nm) { m.close(); openCommonsGrid(l.key, l.sci, nm); });
    var body = box.querySelector(".cm-body");
    body.addEventListener("click", function (e) {   // a tap on a tile = the full-size picture (a press-and-hold does the same via wirePhotoHold)
      var img = e.target.closest && e.target.closest(".spg-img img"); if (!img || Date.now() - lbHoldAt < 900) return;
      e.preventDefault(); e.stopPropagation(); openPhotoLightbox(img);
    });
    function tile(r) {
      return '<div class="cm-tile"><div class="spg-img"><img crossorigin="anonymous" decoding="async" src="' + escapeHtml(r.t) + '" alt="' + escapeHtml(sci) + '" title="' + escapeHtml(t("photo.holdBig")) + '"></div>' +
        '<div class="spg-credit">' + spCreditHtml(r) + "</div></div>";
    }
    (cmCache[sci] || (cmCache[sci] = cmSections(sci).then(function (secs) {
      return Promise.all(secs.map(function (sc) { return sc.cat ? cmFiles(sc.cat).then(function (files) { sc.files = files; return sc; }) : sc; }));
    }).then(function (secs) {
      Object.keys(INAT_TERMS).forEach(function (w) {   // the iNaturalist-capable groups always exist …
        if (!secs.some(function (sc) { return sc.label.toLowerCase() === w; })) secs.push({ cat: "", label: w.charAt(0).toUpperCase() + w.slice(1), files: [] });
      });
      return Promise.all(secs.map(function (sc) {   // … and are topped up to CM_MIN pictures
        var w = sc.label.toLowerCase(); if (!INAT_TERMS[w] || sc.files.length >= CM_MIN) return sc;
        return inatFill(sci, w, CM_MIN - sc.files.length).then(function (more) { sc.files = sc.files.concat(more); return sc; });
      })).then(cmOrder);
    }))).then(function (secs) {
      if (!box.isConnected) return;
      secs = secs.filter(function (sc) { return sc.files.length; });
      body.innerHTML = secs.length ? secs.map(function (sc) {
        return '<div class="cm-sec">' + (sc.label ? '<div class="cm-lbl">' + escapeHtml(sc.label) + "</div>" : "") + '<div class="cm-grid">' + sc.files.map(tile).join("") + "</div></div>";
      }).join("") : none;
    });
  }
  function loadSpPhoto(box, none, cr, sci) {
    if (!sci) { markNoImage(box, none); return Promise.resolve(false); }
    if (photoNetDown() && !spImgStore()[sci]) { markOffline(box, none); return Promise.resolve(null); }   // no connection: don't queue a doomed lookup
    return spImageFor(sci).then(function (r) {
      if (r && r.tmp) { spPhotoFailed(); markOffline(box, none); return null; }   // lookup unreachable: not remembered, retried later
      if (!r || r.none) { spPhotoOk(); markNoImage(box, none, sci); return false; }
      spPhotoOk();
      var img = document.createElement("img"); img.alt = sci; img.decoding = "async";
      // CORS load → the SW's species-images cache stores a real (sized) response, not an
      // opaque one. ONLY for the host it caches: the photo may now come from a national
      // portal (Artsobservasjoner serves GBIF's media and sends no
      // access-control-allow-origin), where an anonymous request fails to load at all.
      if (/^https:\/\/upload\.wikimedia\.org\//i.test(String(r.t || ""))) img.crossOrigin = "anonymous";
      img.src = r.t; img.title = t("photo.holdBig");   // press-and-hold → the full-size picture (photoLightbox)
      img.addEventListener("error", function () {
        // A width this file has no thumbnail for → try the narrower standard width once
        // before giving up, so one odd file (or a future ladder change) can't blank the card.
        var alt = spImgAtWidth(r.t, SP_IMG_W_FALLBACK);
        if (!img._retried && alt !== img.src) { img._retried = 1; img.src = alt; return; }
        img.remove();
        if (photoNetDown()) markOffline(box, none);   // known photo, just not cached on the device
        else markNoImage(box, none, sci);
      });
      box.insertBefore(img, box.firstChild);
      if (cr) cr.innerHTML = spCreditHtml(r);
      return true;
    });
  }
  function spImgClear() { spImgCache = null; }   // Settings → Storage → Species photos: forget the remembered pictures (the store itself is cleared by app.js)

  return {
    init: init,
    buildSpGalleryHtml: buildSpGalleryHtml,
    loadSpPhoto: loadSpPhoto,
    openCommonsGrid: openCommonsGrid,
    spImagesPrefetch: spImagesPrefetch,
    spImgStore: spImgStore,
    spImgClear: spImgClear,
  };
})();
