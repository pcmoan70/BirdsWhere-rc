/**
 * Species compare — the look-alike (confusion) views for a bird: the look-alike
 * table and photo cards with their Match / misID / Sound / Soundscape columns,
 * the side-by-side compare card (traits, season chart, colour bars, clips), the
 * Audio panel with the preselected Xeno-canto clips, and the data loaders behind
 * them (confusion.csv, sound.csv, soundscape.csv, species-traits.json, xc/*.csv).
 *
 * Lifted out of app.js byte-for-byte (v2230). app.js still owns the species
 * menu, the anchored-popup machinery and the species views, and injects what
 * this module needs through init() — same identifiers as inside the monolith.
 *
 * Exposed as window.AppSpCompare (no module system; loaded via <script>).
 */
window.AppSpCompare = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var anchMenuOpen, centerPhotoPopup, closeAnchoredMenu, cssVar, escapeHtml, experimentalOn, fitCardGrid, openAnchoredMenu,
      openExternal, positionAnchoredMenu, probBarCell, probBarNa, probHueColor, showDetRowMenu, speciesName, t, wireHoldButton,
      wireYearProbTips, xenoCantoUrl, loadSpPhoto, spImagesPrefetch, spImgStore;
  // … and getters for app state that changes at runtime.
  var getCurrentSpView, getLabelsByKey, getSpgHoldAt, getScriptBase;

  function init(ctx) {
    anchMenuOpen = ctx.anchMenuOpen; centerPhotoPopup = ctx.centerPhotoPopup; closeAnchoredMenu = ctx.closeAnchoredMenu;
    cssVar = ctx.cssVar; escapeHtml = ctx.escapeHtml; experimentalOn = ctx.experimentalOn; fitCardGrid = ctx.fitCardGrid;
    openAnchoredMenu = ctx.openAnchoredMenu; openExternal = ctx.openExternal; positionAnchoredMenu = ctx.positionAnchoredMenu;
    probBarCell = ctx.probBarCell; probBarNa = ctx.probBarNa; probHueColor = ctx.probHueColor; showDetRowMenu = ctx.showDetRowMenu;
    speciesName = ctx.speciesName; t = ctx.t; wireHoldButton = ctx.wireHoldButton; wireYearProbTips = ctx.wireYearProbTips;
    xenoCantoUrl = ctx.xenoCantoUrl; loadSpPhoto = ctx.loadSpPhoto; spImagesPrefetch = ctx.spImagesPrefetch; spImgStore = ctx.spImgStore;
    getCurrentSpView = ctx.getCurrentSpView; getLabelsByKey = ctx.getLabelsByKey; getSpgHoldAt = ctx.getSpgHoldAt; getScriptBase = ctx.getScriptBase;
    CMP_FOCAL_COL = cssVar("--brand", "#3f6f3a"); CMP_PARTNER_COL = cssVar("--warn", "#c7791c");
  }

  // ---- the data files (relative to the app; fetched once on first use) ----
  var CONFUSION_URL = "confusion.csv";      // per-bird look-alike (confusion) partner codes; fetched on first use
  var CONFUSION_REV = 19;                     // bump when confusion.csv changes — busts the runtime (cache-first) copy
  var SOUND_URL = "sound.csv";                // per-bird "sounds like" partners (tools/sound, BirdNET+ V3.0 over Xeno-canto): code -> "code:SCORE …"
  var SOUND_REV = 2;                          // bump when sound.csv changes (2 = S17 shared-vocalisation table, 2026-10-29)
  var SCAPE_URL = "soundscape.csv";           // per-bird "heard alongside" partners (tools/sound measures_v2.py heard.csv): code -> "code:SHARE …" (share of recordings, 0-100)
  var SCAPE_REV = 2;                          // bump when soundscape.csv changes (2 = window shares of the full archive, 2026-10-29)
  var TRAITS_URL = "species-traits.json";   // per-species characteristics (AVONET morphology/ecology + HBW colour)
  var TRAITS_REV = 2;                        // bump when species-traits.json changes

  // Confusion-species (look-alike) partners: a per-bird list of the most similar
  // same-family species (morphology + genus, precomputed in tools/gen-confusion.py
  // from AVONET). Fetched once on first use and cached; the map is code -> [codes].
  var confusionMap = null, _confusionP = null;
  function ensureConfusion() {
    if (confusionMap) return Promise.resolve(confusionMap);
    if (_confusionP) return _confusionP;
    _confusionP = fetch(new URL(CONFUSION_URL, getScriptBase()).href + "?r=" + CONFUSION_REV)
      .then(function (r) { if (!r.ok) throw new Error("confusion " + r.status); return r.text(); })
      .then(function (text) {
        var m = Object.create(null), lines = text.split(/\r?\n/);
        for (var i = 1; i < lines.length; i++) {              // skip "code,partners" header
          var line = lines[i]; if (!line) continue;
          var c = line.indexOf(","); if (c < 0) continue;
          var parts = line.slice(c + 1).split(" ").filter(Boolean).map(function (pp) {
            var a = pp.split(":");                             // "code:MATCH[:MISID]" (MATCH 0-100; MISID = % share of the species' iNat confusions, absent below the 5 % floor)
            return { c: a[0], w: (+a[1] || 0) / 100, mid: +a[2] || 0 };
          });
          if (parts.length) m[line.slice(0, c)] = parts;
        }
        confusionMap = m; return m;
      })
      .catch(function () { _confusionP = null; return null; });
    return _confusionP;
  }
  // "Sounds like" partners: how close two birds are to a sound-recognition model's ear (0-1), from the
  // world sound table (tasks/sound-table_20261025.md; the report is about/audio-similarity.html).
  // Same shape as the confusion file; the map is code -> { partnerCode: score }.
  // soundscape.csv has the same shape: the share (0-100) of the bird's 5 s recording windows in which the partner is detected (p ≥ 0.1).
  function pairsLoader(url, rev) {
    var map = null, p = null;
    return function () {
      if (map) return Promise.resolve(map);
      if (p) return p;
      p = fetch(new URL(url, getScriptBase()).href + "?r=" + rev)
        .then(function (r) { if (!r.ok) throw new Error(url + " " + r.status); return r.text(); })
        .then(function (text) {
          var m = Object.create(null), lines = text.split(/\r?\n/);
          for (var i = 1; i < lines.length; i++) {
            var line = lines[i]; if (!line) continue;
            var c = line.indexOf(","); if (c < 0) continue;
            var o = Object.create(null);
            line.slice(c + 1).split(" ").forEach(function (pp) { var a = pp.split(":"); if (a[0]) o[a[0]] = (+a[1] || 0) / 100; });
            m[line.slice(0, c)] = o;
          }
          map = m; return m;
        })
        .catch(function () { p = null; return null; });
      return p;
    };
  }
  var ensureSound = pairsLoader(SOUND_URL, SOUND_REV), ensureScape = pairsLoader(SCAPE_URL, SCAPE_REV);
  // Xeno-canto clips for the compare card (owner, 2026-10-29): app/xc/<first char>.csv (tools/sound/xc_clips.py) — per species up
  // to two A-grade recordings per voice as "xc|cat|hash|recordist|licence;…". The sonogram and the audio come from xeno-canto.org
  // itself; the recordist and licence are shown with each clip (the CC attribution). One shared Audio element plays one clip at a time.
  var XC_REV = 1, xcShards = Object.create(null), XC_CATS = ["s", "c", "a", "f", "d", "j", "o"];
  function ensureClips(code) {
    var k = String(code || "").charAt(0).toLowerCase(); if (!k) return Promise.resolve([]);
    if (!xcShards[k]) xcShards[k] = fetch(new URL("xc/" + k + ".csv", getScriptBase()).href + "?r=" + XC_REV)
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (text) {
        var m = Object.create(null);
        text.split(/\r?\n/).slice(1).forEach(function (line) {
          var c = line.indexOf(","); if (c < 0) return;
          m[line.slice(0, c)] = line.slice(c + 1).split(";").map(function (cl) { var f = cl.split("|"); return { xc: f[0], cat: f[1], h: f[2], by: f[3] || "", lic: f[4] || "" }; });
        });
        return m;
      }, function () { return Object.create(null); });
    return xcShards[k].then(function (m) { return m[code] || []; });
  }
  var xcAudio = null, xcPlayingEl = null;
  function xcStop() {
    if (xcAudio) { try { xcAudio.pause(); } catch (e) {} xcAudio.loop = false; }
    if (xcPlayingEl) xcPlayingEl.classList.remove("playing", "xc-loop");
    xcPlayingEl = null;
  }
  function xcToggle(clipEl, loop) {
    if (xcPlayingEl === clipEl) { xcStop(); return; }
    xcStop();
    if (!xcAudio) {
      xcAudio = new Audio(); xcAudio.preload = "none"; xcAudio.crossOrigin = "anonymous";   // a CORS request: the service worker stores the clip as a real (sized) response for offline play
      xcAudio.addEventListener("ended", xcStop);
      xcAudio.addEventListener("timeupdate", function () { if (xcPlayingEl && !document.body.contains(xcPlayingEl)) xcStop(); });   // the card closed under it
    }
    xcAudio.src = "https://xeno-canto.org/" + clipEl.dataset.xc + "/download";
    xcAudio.loop = !!loop;   // a press-and-hold plays the clip on repeat (owner, 2026-10-29); any tap or hold on it stops it
    xcPlayingEl = clipEl; clipEl.classList.add("playing"); if (loop) clipEl.classList.add("xc-loop");
    xcAudio.play().catch(function () { xcStop(); });
  }
  function xcClipHtml(c, side) {
    var cap = "XC" + c.xc + " \u00b7 " + c.by + " \u00b7 CC " + c.lic;
    return '<div class="xc-clip xc-' + side + '" data-xc="' + escapeHtml(c.xc) + '" title="' + escapeHtml(cap) + '">' +
      '<img src="https://xeno-canto.org/sounds/spectrograms/' + escapeHtml(c.h) + '/' + escapeHtml(c.xc) + '/grey-small.png" alt="">' +   // the site's current spectrogram path: the old /ffts/XC<nr>-small.png exists only for recordings before about XC1100000 (2025), newer ones showed no sonogram (owner, 2026-10-30)
      '<a class="xc-cap" href="https://xeno-canto.org/' + escapeHtml(c.xc) + '" target="_blank" rel="noopener">' + escapeHtml(cap) + "</a></div>";
  }
  // The species menu's Audio panel (owner, 2026-10-29: "The species popup Audio should give the preselected audio clips used in the
  // confusion (audio) pane. At the bottom there should be a link to xeno-canto for that species"): the same clips as the compare card,
  // one column, grouped by voice, then the Xeno-canto search link that the entry used to open directly.
  function openAudioMenu(key, name, sci, x, y) {
    var el = openAnchoredMenu("detrow-menu conf-menu cmp-menu xc-menu anch-top");   // a window: at the top of the map area from the start
    el.style.maxHeight = "min(82vh,640px)"; el.style.overflowY = "auto"; el.style.width = "min(94vw,360px)";
    var closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.className = "conf-close"; closeBtn.textContent = "\u00d7"; closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closeAnchoredMenu(); });
    var hdr = document.createElement("div"); hdr.className = "detrow-menu-hdr"; hdr.textContent = name;
    hdr.appendChild(closeBtn); el.appendChild(hdr);   // the × rides inside the sticky name line, so both stay put while the clips scroll (owner, 2026-10-29)
    var box = document.createElement("div"); box.className = "xc-sec"; box.innerHTML = '<span class="cmp-nocol">\u2026</span>'; el.appendChild(box);
    var more = document.createElement("a"); more.className = "xc-more"; more.href = xenoCantoUrl(sci || ""); more.target = "_blank"; more.rel = "noopener";
    more.textContent = t("clips.more"); more.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openExternal(xenoCantoUrl(sci || "")); });
    el.appendChild(more); positionAnchoredMenu(el, x, y);
    ensureClips(key).then(function (A) {
      if (!document.body.contains(box)) return;
      var h = '<div class="xc-sec-lbl">' + escapeHtml(t("clips.sec")) + "</div>";
      if (!A.length) h += '<div class="cmp-nocol">' + escapeHtml(t("clips.none")) + "</div>";
      XC_CATS.forEach(function (k) {
        var a = A.filter(function (c) { return c.cat === k; }); if (!a.length) return;
        h += '<div class="xc-voice"><div class="xc-vlbl">' + escapeHtml(t("clips." + k)) + '</div><div class="xc-col xc-col-a">' + a.map(function (c) { return xcClipHtml(c, "a"); }).join("") + "</div></div>";
      });
      box.innerHTML = h;
      box.querySelectorAll(".xc-clip").forEach(function (cl) {
        cl.addEventListener("click", function (e) { e.stopPropagation(); if (e.target.closest(".xc-cap")) return; xcToggle(cl, e.shiftKey); });   // shift-click = repeat on a desktop; a right / two-finger click reaches the hold helper as contextmenu
        wireHoldButton(cl, function () { xcToggle(cl, true); }, function (e) { return !e.target.closest(".xc-cap"); });
        cl.querySelector("img").addEventListener("error", function () { cl.classList.add("xc-noimg"); });
      });
      positionAnchoredMenu(el, x, y);
    });
  }
  // The compare card's Recordings section (a grid under the trait table, not table rows: a table cannot shrink the sonograms
  // on a phone): one block per voice either bird has, the two birds' clips in two columns coloured like their names.
  function xcSection(focalKey, partnerKey) {
    return Promise.all([ensureClips(focalKey), ensureClips(partnerKey)]).then(function (ab) {
      var A = ab[0], B = ab[1], h = '<div class="xc-sec"><div class="xc-sec-lbl">' + escapeHtml(t("clips.sec")) + "</div>";
      if (!A.length && !B.length) return h + '<div class="cmp-nocol">' + escapeHtml(t("clips.none")) + "</div></div>";
      // One table row spanning the three columns (so the pinned names row stays over the clips too), the clips in a grid whose columns are set to the table's
      XC_CATS.forEach(function (k) {
        var a = A.filter(function (c) { return c.cat === k; }), b = B.filter(function (c) { return c.cat === k; });
        if (!a.length && !b.length) return;
        h += '<div class="xc-grid"><div class="xc-vlbl">' + escapeHtml(t("clips." + k)) + "</div>" +   // the voice in the table's label column, the clips under the two names (owner, 2026-10-29)
          '<div class="xc-col xc-col-a">' + (a.map(function (c) { return xcClipHtml(c, "a"); }).join("") || '<span class="cmp-nocol">\u2014</span>') + "</div>" +
          '<div class="xc-col xc-col-b">' + (b.map(function (c) { return xcClipHtml(c, "b"); }).join("") || '<span class="cmp-nocol">\u2014</span>') + "</div></div>";
      });
      return '<tr class="xc-tr"><td class="xc-td" colspan="3">' + h + "</div></td></tr>";
    });
  }
  // Per-species characteristics (AVONET morphology/ecology + HBW plumage colour),
  // for the confusion "compare" card. Fetched on first use, cache-first like confusion.
  var traitsData = null, _traitsP = null;
  function ensureTraits() {
    if (traitsData) return Promise.resolve(traitsData);
    if (_traitsP) return _traitsP;
    _traitsP = fetch(new URL(TRAITS_URL, getScriptBase()).href + "?r=" + TRAITS_REV)
      .then(function (r) { if (!r.ok) throw new Error("traits " + r.status); return r.json(); })
      .then(function (j) { traitsData = j; return j; })
      .catch(function () { _traitsP = null; return null; });
    return _traitsP;
  }
  var CMP_NUM = [
    { k: "mass", label: "traits.mass", unit: " g" },
    { k: "wing", label: "traits.wing", unit: " mm" },
    { k: "tail", label: "traits.tail", unit: " mm" },
    { k: "tarsus", label: "traits.tarsus", unit: " mm" },
    { k: "bill", label: "traits.bill", unit: " mm" },
    { k: "hwi", label: "traits.hwi", unit: "" }
  ];
  var CMP_CAT = [
    { k: "hab", label: "traits.habitat" },
    { k: "habd", label: "traits.habd" },
    { k: "niche", label: "traits.niche" },
    { k: "trophic", label: "traits.trophic" },
    { k: "life", label: "traits.lifestyle" },
    { k: "mig", label: "traits.migration", map: { "1": "traits.migSed", "2": "traits.migPart", "3": "traits.migMig" } }
  ];
  var CMP_FOCAL_COL, CMP_PARTNER_COL;   // focal vs look-alike, shared by the wheel + season chart Resolved in init(): cssVar is injected, so the colours cannot be read while this file loads.
  // Plumage colour as a per-colour DEVIATION between the two birds, one diverging strip per sex
  // (male above female). For each colour class either bird uses, dev = 200·(base − look-alike) /
  // (base + look-alike): the bar rises above the zero line when the base species has relatively
  // more of that colour, drops below when the look-alike does, and reaches the full ±half-height
  // when only one bird wears it. Bars are the colour's real RGB; shared-equally colours vanish at
  // zero, so what's left is exactly where the two plumages differ. When the male and female
  // deviations match (within 1) the two strips collapse into one labelled ♂♀.
  function colourBars(A, B, palette, aName, bName) {
    function dic(cols) { var m = {}; (cols || []).forEach(function (c) { m[c[0]] = c[1]; }); return m; }
    var am = dic(A && A.cm), af = dic(A && A.cf), bm = dic(B && B.cm), bf = dic(B && B.cf);
    var seen = {}, idxs = [];
    [am, af, bm, bf].forEach(function (m) { for (var k in m) { if (m[k] > 0 && !seen[k]) { seen[k] = 1; idxs.push(+k); } } });
    if (!idxs.length) return '<span class="cmp-nocol">' + escapeHtml(t("traits.noColour")) + "</span>";
    function hs(i) {
      var p = palette[i] || [128, 128, 128], r = p[0] / 255, g = p[1] / 255, b = p[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, s = mx ? d / mx : 0, h = 0;
      if (d > 1e-6) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = h * 60; if (h < 0) h += 360; }
      return [h, s, mx];
    }
    idxs.sort(function (x, y) {   // achromatic (by lightness) first, then chromatic by hue
      var hx = hs(x), hy = hs(y), cx = hx[1] < 0.15 ? 0 : 1, cy = hy[1] < 0.15 ? 0 : 1;
      return (cx - cy) || (cx === 0 ? hx[2] - hy[2] : hx[0] - hy[0]);
    });
    var N = idxs.length, help = t("traits.colourDev");
    function devOf(fMap, pMap, idx) { var f = fMap[idx] || 0, p = pMap[idx] || 0, s = f + p; return s > 0 ? 100 * (f - p) / s : 0; }
    // If male and female deviations match for every colour (within 1), the two strips would be
    // identical (monomorphic, or the source only had one sex) — collapse to one labelled ♂♀.
    var same = idxs.every(function (i) { return Math.abs(devOf(am, bm, i) - devOf(af, bf, i)) <= 1; });
    var groups = same ? [[am, bm, "♂♀"]] : [[am, bm, "♂"], [af, bf, "♀"]];
    var colW = 12, step = 16, half = 16, gapS = 12, padL = same ? 30 : 26;
    var W = padL + N * step + 2, H = 4 + groups.length * 2 * half + (groups.length - 1) * gapS, plotW = (N - 1) * step + colW;
    function strip(fMap, pMap, mid, label) {
      var s = '<text x="0" y="' + (mid + 3) + '" font-size="9" fill="var(--ink-muted,#667)">' + label + "</text>";
      // fixed ±200 scale: the top/bottom of the strip (a colour only one bird wears reaches the extreme).
      s += '<text x="' + padL + '" y="' + (mid - half + 6) + '" font-size="7" text-anchor="end" fill="var(--ink-faint,#aaa)">+100</text>';
      s += '<text x="' + padL + '" y="' + (mid + half) + '" font-size="7" text-anchor="end" fill="var(--ink-faint,#aaa)">−100</text>';
      s += '<line x1="' + padL + '" y1="' + mid + '" x2="' + (padL + plotW) + '" y2="' + mid + '" stroke="var(--border,#ddd)" stroke-width="1"/>';   // zero baseline
      idxs.forEach(function (idx, k) {
        var p = palette[idx] || [128, 128, 128, "?"], x = padL + k * step, rgb = "rgb(" + p[0] + "," + p[1] + "," + p[2] + ")";
        var fv = fMap[idx] || 0, pv = pMap[idx] || 0, sum = fv + pv;
        if (sum <= 0) return;
        var dev = 100 * (fv - pv) / sum, hh = Math.min(half, Math.abs(dev) / 100 * half), y = dev >= 0 ? (mid - hh) : mid;
        var lean = dev > 0 ? aName : dev < 0 ? bName : "—";
        var title = escapeHtml(p[3] + " · " + aName + " " + fv + "% vs " + bName + " " + pv + "% → " + (dev > 0 ? "+" : "") + Math.round(dev) + " (" + lean + ")");
        s += '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + colW + '" height="' + Math.max(0.6, hh).toFixed(1) + '" fill="' + rgb + '" stroke="#888" stroke-width="0.5"><title>' + title + "</title></rect>";
      });
      return s;
    }
    var body = "", top = 2;
    groups.forEach(function (g) { body += strip(g[0], g[1], top + half, g[2]); top += 2 * half + gapS; });
    return '<svg class="cmp-cbar" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '"><title>' + escapeHtml(help) + "</title>" + body + "</svg>" +
      '<div class="cmp-wheel-legend"><span class="cw-lg">▲ ' + escapeHtml(aName) + "</span>" +
      '<span class="cw-lg">▼ ' + escapeHtml(bName) + "</span>" +
      '<span class="cw-lg">♂ ' + escapeHtml(t("traits.male")) + "   ♀ " + escapeHtml(t("traits.female")) + "</span>" +
      '<span class="cw-lg cmp-help" title="' + escapeHtml(help) + '">ⓘ</span></div>';
  }
  // Both birds' 48-week presence curves on ONE shared-scale chart (same axes), so the seasons
  // line up directly. Which curve is which is read off the (colour-matched) compare-card header.
  // The current week is dashed and, at it, each species' probability is dotted + read out on top.
  function seasonChart(cell, ai, bi) {
    var W = 232, H = 66, topPad = 13, botPad = 12, baseY = H - botPad, i, w, va, vb, mx = 0, a = [], b = [];
    for (w = 1; w <= 48; w++) {
      va = (ai != null && cell[w]) ? cell[w][ai] : 0; vb = (bi != null && cell[w]) ? cell[w][bi] : 0;
      a.push(va); b.push(vb); if (va > mx) mx = va; if (vb > mx) mx = vb;
    }
    if (mx <= 0) return '<span class="cmp-nocol">—</span>';
    function yAt(v) { return baseY - v / mx * (baseY - topPad); }
    function poly(arr, col) { var pts = []; for (i = 0; i < 48; i++) pts.push(((i / 47) * W).toFixed(1) + "," + yAt(arr[i]).toFixed(1)); return '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + col + '" stroke-width="2.2" stroke-linejoin="round"/>'; }
    var cw = +((document.getElementById("week-select") || {}).value) || 1;
    if (cw < 1) cw = 1; if (cw > 48) cw = 48;
    var cx = ((cw - 1) / 47) * W;
    var fp = (ai != null && cell[cw]) ? cell[cw][ai] : null, pp = (bi != null && cell[cw]) ? cell[cw][bi] : null;
    function dot(v, col) { return v == null ? "" : '<circle cx="' + cx.toFixed(1) + '" cy="' + yAt(v).toFixed(1) + '" r="2.6" fill="' + col + '" stroke="#fff" stroke-width="1"/>'; }
    function pct(v) { return Math.round(v * 100) + "%"; }
    var side = cx > W / 2 ? "end" : "start", tx = cx > W / 2 ? (cx - 4) : (cx + 4);
    var readout = '<text x="' + tx.toFixed(1) + '" y="9" font-size="9" font-weight="600" text-anchor="' + side + '" style="paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round">' +
      (fp != null ? '<tspan fill="' + CMP_FOCAL_COL + '">' + pct(fp) + "</tspan>" : "") +
      (fp != null && pp != null ? '<tspan fill="var(--ink-muted,#999)"> · </tspan>' : "") +
      (pp != null ? '<tspan fill="' + CMP_PARTNER_COL + '">' + pct(pp) + "</tspan>" : "") + "</text>";
    var months = "JFMAMJJASOND", mt = "";   // month letters on the x-axis, like the other probability charts
    for (i = 0; i < 12; i++) mt += '<text x="' + ((i + 0.5) / 12 * W).toFixed(0) + '" y="' + (H - 2) + '" font-size="7" fill="#888" text-anchor="middle">' + months[i] + "</text>";
    return '<svg class="cmp-season" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">' +
      '<line x1="' + cx.toFixed(1) + '" y1="' + topPad + '" x2="' + cx.toFixed(1) + '" y2="' + baseY + '" stroke="var(--ink-muted,#ccc)" stroke-width="1" stroke-dasharray="2 2"/>' +
      (ai != null ? poly(a, CMP_FOCAL_COL) : "") + (bi != null ? poly(b, CMP_PARTNER_COL) : "") +
      dot(fp, CMP_FOCAL_COL) + dot(pp, CMP_PARTNER_COL) + readout + mt + "</svg>";
  }
  // Clicking a species in the confusion list opens a side-by-side COMPARE card: the
  // focal bird vs the look-alike across plumage colour (male + female), size/shape and
  // ecology — so you can see at a glance what makes them similar and what tells them
  // apart (matching ecology cells are tinted green, differing ones amber).
  async function openTraitCompare(focalKey, partnerKey, focalNm, partnerNm, x, y, stats) {
    var data = await ensureTraits();
    var el = openAnchoredMenu("detrow-menu conf-menu cmp-menu");
    el.style.maxHeight = "min(82vh,640px)"; el.style.overflowY = "auto";
    el.style.width = "min(94vw,430px)";                       // full phone width, like the confusion list it opens from
    var closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.className = "conf-close"; closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closeAnchoredMenu(); });
    el.appendChild(closeBtn);
    var A = (data && data.sp && data.sp[focalKey]) || null;
    var B = (data && data.sp && data.sp[partnerKey]) || null;
    var pal = (data && data.palette) || [];
    if (!A && !B) {
      var none = document.createElement("div"); none.className = "detrow-menu-hdr";
      none.textContent = t("traits.none"); el.appendChild(none); positionAnchoredMenu(el, x, y); return;
    }
    function fmtNum(v, unit) { return v == null ? "—" : (Math.round(v * 10) / 10) + unit; }
    function numBar(v, mx, side) {
      if (v == null || !mx) return "";
      return '<div class="cmp-bar cmp-bar-' + side + '" style="width:' + Math.max(3, Math.min(100, v / mx * 100)) + '%"></div>';
    }
    var rows = "";
    // Both names are clickable: each opens THAT bird's own confusion-species list, so you can
    // step from one comparison to the next in either direction.
    rows += '<tr class="cmp-head"><th></th>' +
      '<th class="cmp-clk" data-conf="' + escapeHtml(focalKey) + '" title="' + escapeHtml(t("confusion.openList")) + '" style="color:' + CMP_FOCAL_COL + '">' + escapeHtml(focalNm) + "</th>" +
      '<th class="cmp-clk" data-conf="' + escapeHtml(partnerKey) + '" title="' + escapeHtml(t("confusion.openList")) + '" style="color:' + CMP_PARTNER_COL + '">' + escapeHtml(partnerNm) + "</th></tr>";
    // Confusion metrics for this pair, in the common columnar format (label · number · bar)
    // used by the overview list: Match · misID · Score.
    if (stats) {
      function metricCell(labelKey, tipKey, num, barPct, na) {
        return '<td class="cmp-metric prob-cell" title="' + escapeHtml(t(tipKey)) + '">' +
          '<span class="cmp-mlbl">' + escapeHtml(t(labelKey)) + "</span>" +
          '<span class="prob-num">' + num + "</span>" +
          (na ? "" : '<div class="prob-bar" style="width:' + Math.max(4, Math.min(100, barPct)) + '%"></div>') + "</td>";
      }
      var mV = Math.round((stats.match || 0) * 100);
      var midOn = stats.mid > 0;
      var sRaw = stats.score != null ? stats.score * 100 : null;
      var sV = sRaw != null ? (sRaw >= 0.5 ? Math.round(sRaw) : (sRaw > 0 ? "<1" : "0")) : "—";
      rows += '<tr class="cmp-metrics">' +
        metricCell("confusion.colScore", "confusion.tipMatch", mV, mV, false) +
        metricCell("confusion.colMisid", "confusion.tipMisid", midOn ? stats.mid + "%" : "—", stats.mid, !midOn) +
        metricCell("confusion.colCombined", "confusion.tipScore", sV, sRaw != null ? sRaw : 0, sRaw == null) + "</tr>";
    }
    // Seasonality moved to the TOP — a placeholder now, filled once the 48-week inference lands.
    var pt = (getCurrentSpView() && isFinite(+getCurrentSpView().lat) && isFinite(+getCurrentSpView().lon)) ? getCurrentSpView() : null;
    if (pt) {
      rows += '<tr class="cmp-sec"><td colspan="3">' + escapeHtml(t("traits.season")) + "</td></tr>";
      rows += '<tr><td colspan="3" class="cmp-season-cell" data-season="1"><span class="cmp-nocol">…</span></td></tr>';
    }
    // colour
    rows += '<tr class="cmp-sec"><td colspan="3">' + escapeHtml(t("traits.colour")) + "</td></tr>";
    rows += '<tr><td colspan="3" class="cmp-cbar-cell">' + colourBars(A, B, pal, focalNm, partnerNm) + "</td></tr>";
    // sexual dimorphism cue — how much the male vs female plumage overlap
    function sexAlike(cm, cf) {
      if (!cm || !cm.length || !cf || !cf.length) return null;
      var fm = {}, sm = 0; cm.forEach(function (c) { fm[c[0]] = c[1]; sm += c[1]; });
      var ov = 0, sf = 0; cf.forEach(function (c) { ov += Math.min(c[1], fm[c[0]] || 0); sf += c[1]; });
      // fraction of the (top-6) plumage the sexes SHARE — normalised, so identical sexes = 1.0.
      // (The top colours never sum to 100, so an un-normalised total under-counts and mis-reads "Differ".)
      return (ov / (Math.min(sm, sf) || 1)) >= 0.70;
    }
    function sexTxt(v) { return v == null ? "—" : t(v ? "traits.sexSame" : "traits.sexDiff"); }
    rows += '<tr><td class="cmp-lbl">' + escapeHtml(t("traits.sexes")) + '</td><td>' +
      escapeHtml(sexTxt(sexAlike(A && A.cm, A && A.cf))) + "</td><td>" + escapeHtml(sexTxt(sexAlike(B && B.cm, B && B.cf))) + "</td></tr>";
    // size & shape
    rows += '<tr class="cmp-sec"><td colspan="3">' + escapeHtml(t("traits.shape")) + "</td></tr>";
    CMP_NUM.forEach(function (r) {
      var a = A ? A[r.k] : null, b = B ? B[r.k] : null, mx = Math.max(a || 0, b || 0);
      // bold both values when they differ by 10%+ (relative to the larger)
      var big = Math.max(Math.abs(a || 0), Math.abs(b || 0));
      var vd = (a != null && b != null && big > 0 && Math.abs(a - b) / big > 0.10) ? " cmp-vdiff" : "";
      rows += '<tr><td class="cmp-lbl">' + escapeHtml(t(r.label)) + "</td>" +
        '<td class="cmp-num' + vd + '"><span>' + fmtNum(a, r.unit) + "</span>" + numBar(a, mx, "a") + "</td>" +
        '<td class="cmp-num' + vd + '"><span>' + fmtNum(b, r.unit) + "</span>" + numBar(b, mx, "b") + "</td></tr>";
    });
    // ecology
    rows += '<tr class="cmp-sec"><td colspan="3">' + escapeHtml(t("traits.ecology")) + "</td></tr>";
    CMP_CAT.forEach(function (r) {
      var a = A ? A[r.k] : null, b = B ? B[r.k] : null;
      function disp(v) { return v == null || v === "" ? "—" : escapeHtml(r.map ? (t(r.map[v]) || v) : v); }
      // values coloured to match the species; bold both when they differ
      var vd = (a != null && a !== "" && b != null && b !== "" && a !== b) ? " cmp-vdiff" : "";
      rows += '<tr><td class="cmp-lbl">' + escapeHtml(t(r.label)) + "</td>" +
        '<td class="cmp-eco-a' + vd + '">' + disp(a) + "</td>" +
        '<td class="cmp-eco-b' + vd + '">' + disp(b) + "</td></tr>";
    });
    var tbl = document.createElement("table"); tbl.className = "cmp-table";
    tbl.innerHTML = rows;
    // Either species name → open that bird's own confusion-species list (pick a new look-alike).
    el.appendChild(tbl);
    // Recordings side by side (owner, 2026-10-29; Experimental / Sound on): appended once the clip index shard is here.
    if (soundOn()) xcSection(focalKey, partnerKey).then(function (xr) {
      if (!document.body.contains(tbl)) return;
      // The clip columns line up under the two names: the grid's columns are the table's own, as shares of its width,
      // measured BEFORE the row goes in (the row then adds nothing to the column widths, and shares follow a resize)
      var ths = tbl.querySelectorAll(".cmp-head th"), shares = null;
      if (ths.length === 3) {   // column pitches, not cell widths (collapsed borders make a cell's rect wider than its column)
        var r0 = ths[0].getBoundingClientRect(), r1 = ths[1].getBoundingClientRect(), r2 = ths[2].getBoundingClientRect(), tl = tbl.getBoundingClientRect(), W = tl.right - r0.left;
        if (W > 0) shares = [(r1.left - r0.left) / W, (r2.left - r1.left) / W, (tl.right - r2.left) / W];
      }
      (tbl.tBodies[0] || tbl).insertAdjacentHTML("beforeend", xr);
      var sec = tbl.querySelector(".xc-sec");
      if (sec && shares) { sec.style.setProperty("--xc-lbl", (shares[0] * 100).toFixed(3) + "%"); sec.style.setProperty("--xc-a", (shares[1] * 100).toFixed(3) + "%"); sec.style.setProperty("--xc-b", (shares[2] * 100).toFixed(3) + "%"); }
      el.querySelectorAll(".xc-clip").forEach(function (cl) {
        cl.addEventListener("click", function (e) { e.stopPropagation(); if (e.target.closest(".xc-cap")) return; xcToggle(cl, e.shiftKey); });   // shift-click = repeat on a desktop; a right / two-finger click reaches the hold helper as contextmenu
        wireHoldButton(cl, function () { xcToggle(cl, true); }, function (e) { return !e.target.closest(".xc-cap"); });
        cl.querySelector("img").addEventListener("error", function () { cl.classList.add("xc-noimg"); });   // no sonogram on XC yet (new uploads): caption only, still playable
      });
      positionAnchoredMenu(el, x, y);
    });
    tbl.querySelectorAll(".cmp-clk").forEach(function (th) {
      th.addEventListener("click", function (e) {
        e.stopPropagation();
        var k = this.getAttribute("data-conf");
        if (k) openConfusionMenu(k, x, y);
      });
    });
    positionAnchoredMenu(el, x, y);
    // Fill the top seasonality placeholder once the 48-week inference lands: both birds'
    // presence curves on ONE shared-scale chart, current week dashed.
    if (pt) {
      var cell = await predictAllWeeks(+pt.lat, +pt.lon);
      if (!anchMenuOpen(el)) return;
      var ai = (getLabelsByKey()[focalKey] || {}).index, bi = (getLabelsByKey()[partnerKey] || {}).index;
      var sc = tbl.querySelector("[data-season]");
      if (sc) sc.innerHTML = seasonChart(cell, ai == null ? null : ai, bi == null ? null : bi);
      positionAnchoredMenu(el, x, y);
    }
  }
  // Clicking "Confusion species" opens the look-alikes for a bird — its most
  // similar same-family species — ranked by the model's probability at the current
  // point so realistic local confusions surface first. Same drill-in as the family
  // browser: each partner is a button into its own species menu.
  // Score = (0.25·Match + 0.75·misID) × Here. Match is the fused morphology weight
  // (0-1); misID is the % share (0-100) → /100; Here is local probability (0-1).
  // Either input absent is taken as 0 (a species with no iNat data leans on Match).
  //
  // Each input must be SIGNIFICANT before it contributes: a 3 % Match or a 1 % misID is
  // noise, and letting it through gave a species a non-zero Score — and so a place in the
  // ranking — on the strength of a resemblance nobody would ever make. Below its floor an
  // input counts as nothing; a look-alike under both floors scores 0 and sinks to the
  // bottom of the list rather than pretending to be a candidate.
  var CONF_MATCH_MIN = 0.10;   // Match < 10 % contributes nothing
  var CONF_MISID_MIN = 5;      // misID < 5 % contributes nothing (mid is already a percentage)
  function confScore(w) {
    var m = w.w >= CONF_MATCH_MIN ? w.w : 0;
    var d = w.mid >= CONF_MISID_MIN ? w.mid : 0;
    return (0.25 * m + 0.75 * (d / 100)) * w.p;
  }
  // The ranked look-alikes of a species: [{ m: label, w: Match, mid: misID %, snd: Sound, p: Here }] in the
  // order `by` asks for — "score" (most likely confusion first; needs a point, else Match), "match", "misid"
  // or "sound"; `out` is that week's prediction at the point (null without one), `by` the order taken.
  // Sound mode lists the bird's eight nearest BY EAR from the sound table, whether or not they are visual
  // look-alikes (owner, 2026-10-27: "for audio make sure to load the top matches when toggled to audio");
  // such a sound-only bird has no Match / misID. Shared by the Confusion-species table and its images view.
  // "scape" (owner, 2026-10-27: "species that are heard in the same audio clips and have reasonably high probability
  // for the point have a high soundscape score"): Soundscape = share of the bird's recordings with the partner heard
  // in the background × Here — the birds you hear ALONGSIDE it, whether or not they sound alike. Experimental, like Sound.
  var CONF_SORTS = ["score", "match", "misid", "sound", "scape"];
  // Cutoff (owner, 2026-10-27: "Other species must have a reasonable probability of eg 15%"): with a point open, a bird
  // under SCAPE_HERE_MIN here gets no Soundscape value and is left out of the Soundscape order.
  var SCAPE_HERE_MIN = 0.15;
  function scapeScore(w) { return (w.hs < 0 || (w.p >= 0 && w.p < SCAPE_HERE_MIN)) ? -1 : w.hs * (w.p >= 0 ? w.p : 1); }
  function scapeTxt(v) { v *= 100; return v >= 0.5 ? String(Math.round(v)) : (v > 0 ? "<1" : "0"); }   // a positive share × Here under 0.5 reads "<1", never "0"
  // The by-ear side (Sound button, column, card row, note, the sound.csv fetch) is Experimental (owner, 2026-10-27:
  // "Gate the audio confusion behind the experimental gate").
  function soundOn() { return experimentalOn(); }
  function confSort() { var v = window.GeoState.get("confusionSort", "score"); return (CONF_SORTS.indexOf(v) >= 0 && ((v !== "sound" && v !== "scape") || soundOn())) ? v : "score"; }
  async function confusionRanked(key, by) {
    var map = await ensureConfusion(), snd = soundOn() ? await ensureSound() : null, scp = soundOn() ? await ensureScape() : null;
    var entries = (map && map[key]) || [], sm = (snd && snd[key]) || {}, hm = (scp && scp[key]) || {};
    function mem(l, c, w, mid) { return { m: l, w: w, mid: mid, snd: (c in sm) ? sm[c] : -1, hs: (c in hm) ? hm[c] : -1 }; }
    var members = entries.map(function (e) { var l = getLabelsByKey()[e.c]; return l ? mem(l, e.c, e.w, e.mid || 0) : null; }).filter(Boolean);
    var union = {}; members.forEach(function (mm) { union[mm.m.key] = 1; }); Object.keys(sm).concat(Object.keys(hm)).forEach(function (c) { if (getLabelsByKey()[c]) union[c] = 1; });
    var nAll = Object.keys(union).length;   // every bird any order could list: the images view sizes its grid by this, so the popup keeps one shape across the orders (owner, 2026-10-29)
    if (by === "sound" || by === "scape") {                 // the by-ear / heard-alongside partners join the list, look-alikes or not
      var have = {}; entries.forEach(function (e) { have[e.c] = 1; });
      Object.keys(by === "sound" ? sm : hm).forEach(function (c) { var l = getLabelsByKey()[c]; if (l && !have[c]) members.push(mem(l, c, 0, 0)); });
      members = members.filter(function (mm) { return (by === "sound" ? mm.snd : mm.hs) >= 0; });
    }
    var pt = (getCurrentSpView() && isFinite(+getCurrentSpView().lat) && isFinite(+getCurrentSpView().lon)) ? getCurrentSpView() : null;
    var out = null;
    if (pt) { try { out = await predictWeek(+pt.lat, +pt.lon, +document.getElementById("week-select").value); } catch (e) {} }
    by = (by === "score" && !out) ? "match" : (CONF_SORTS.indexOf(by) >= 0 ? by : "match");
    if (!members.length) return { none: true, arr: [], out: out, by: by, nAll: nAll };
    var arr = members.map(function (mm) { return { m: mm.m, w: mm.w, mid: mm.mid, snd: mm.snd, hs: mm.hs, p: out ? (out[mm.m.index] || 0) : -1 }; });
    if (by === "score") {
      // Occurs-here only, and only where the Score survives its floors: a look-alike that
      // scores 0 is one whose resemblance is under 10 % AND whose real-misidentification
      // share is under 5 %, which is not a confusion anyone would make — listing it at the
      // bottom said "consider this bird" about a bird nobody mistakes for this one.
      arr = arr.filter(function (w) { return w.p > 0 && confScore(w) > 0; });
      arr.sort(function (a, b) { return confScore(b) - confScore(a); });    // by Score, most likely-confusion first
    } else if (by === "misid") {
      arr.sort(function (a, b) { return (b.mid - a.mid) || (b.w - a.w); });
    } else if (by === "sound") {
      arr.sort(function (a, b) { return b.snd - a.snd; });
    } else if (by === "scape") {
      arr = arr.filter(function (w) { return scapeScore(w) >= 0; });          // the Here cutoff
      arr.sort(function (a, b) { return scapeScore(b) - scapeScore(a); });   // heard alongside × Here
    } else {
      arr.sort(function (a, b) { return b.w - a.w; });                      // by Match (confusion score)
    }
    return { arr: arr, out: out, by: by, nAll: nAll };
  }
  // The header line of both look-alike views: the title, then the sort buttons Score · Match · misID · Sound
  // (owner, 2026-10-27: "toggleable with button on top … Let toggle be on top line. Of confusion panes (both
  // text and image)"). The choice is remembered (Settings-wide); a tap re-opens the same view at the same
  // anchor in the new order. Returns the marker to call once the list is ranked: it lights the order taken
  // and greys Score when no point is open (Score needs Here).
  function confHeader(el, reopen) {
    var hdr = document.createElement("div"); hdr.className = "detrow-menu-hdr detrow-menu-name";
    var ttl = document.createElement("span"); ttl.className = "conf-title"; ttl.textContent = t("menu.confusion"); hdr.appendChild(ttl);
    var bar = document.createElement("span"); bar.className = "conf-sort"; bar.title = t("confusion.sortTip");
    var labels = { score: t("confusion.colCombined"), match: t("confusion.colScore"), misid: t("confusion.colMisid"), sound: t("confusion.colSound"), scape: t("confusion.colScape") };
    CONF_SORTS.forEach(function (s) {
      if ((s === "sound" || s === "scape") && !soundOn()) return;
      var b = document.createElement("button"); b.type = "button"; b.textContent = labels[s]; b.setAttribute("data-sort", s);
      b.addEventListener("click", function (e) { e.stopPropagation(); if (b.disabled) return; window.GeoState.save({ confusionSort: s }); closeAnchoredMenu(); reopen(); });
      bar.appendChild(b);
    });
    hdr.appendChild(bar); el.appendChild(hdr);
    return function (rk) {
      Array.prototype.forEach.call(bar.children, function (b) { var s = b.getAttribute("data-sort"); b.classList.toggle("on", s === rk.by); if (s === "score") b.disabled = !rk.out; });
    };
  }
  function confusionView() { return window.GeoState.get("confusionView", "images") === "table" ? "table" : "images"; }
  // The view switch in the popup's top-right (next to ×): table ↔ photo cards, one-off (the
  // Settings default is untouched); reopens the other view at the same anchor.
  // Photo cards in a popup (the family view, the confusion view). Asking for one picture
  // per card is how you get rate-limited: four failures in a row trip spPhotoFailed()
  // and every remaining card is then told the service is down, so a big family came out
  // half empty and STAYED that way, nothing cached for next time.
  // So: a BATCHED pass (spImagesPrefetch — fifty species per request) over the cards that
  // are actually ON SCREEN plus the next five, then the per-card chain, three in flight,
  // for whatever the batch could not place — a species with no article picture, whose file
  // is non-free, or a name Wikipedia does not know. Scrolling sweeps again for whatever has
  // come into view. Anatidae's 164 cards used to cost eight round trips on open whether or
  // not you ever scrolled; now opening it costs one, and the rest arrive as you go.
  function wirePhotoCards(popup, strip) {
    var PARALLEL = 3, AHEAD = 5, queue = [], running = 0, pending = 0;
    var cards = Array.prototype.slice.call(strip.querySelectorAll(".cfi-card"));
    if (!cards.length) return;
    function fill(card) {
      if (!card || card._cfiDone) return;
      card._cfiDone = true;
      queue.push(card); pump();
    }
    function pump() {
      // `c` MUST be captured per card. It used to be a plain `var` in this loop, which the
      // while runs up to PARALLEL times before any promise settles — so all three callbacks
      // closed over the LAST card: a card whose lookup came back null re-queued its
      // neighbour instead of itself and never retried, leaving it blank until the popup was
      // closed and opened again (a fresh card clears _cfiDone). That is the "open it twice
      // and then the pictures are there" in the confusion and family views.
      while (running < PARALLEL && queue.length) {
        running++;
        (function (c) {
          loadSpPhoto(c.querySelector(".spg-img"), c.querySelector(".spg-none"), c.querySelector(".spg-credit"), c.getAttribute("data-sci"))
            .then(function (ok) {
              running--;
              // null = the lookup could not be reached (offline, rate limit): nothing was
              // remembered, so it is worth asking again — ONCE. Past that the card is left
              // as it is rather than retrying for as long as the popup stays open.
              if (ok === null && popup.isConnected && !c._cfiRetried) {
                c._cfiRetried = 1; c._cfiDone = false;
                setTimeout(function () { fill(c); }, 4000);
              }
              pump();
            }, function () { running--; pump(); });
        })(queue.shift());
      }
    }
    // The cards on screen, plus AHEAD below the fold so a short scroll finds them already
    // loading. Cards are in document order, so the walk stops as soon as it is far enough
    // past the bottom — a 164-card family never measures 164 rectangles for one scroll.
    function cardsToLoad() {
      var pr = popup.getBoundingClientRect(), out = [], after = 0;
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i], r = c.getBoundingClientRect();
        if (r.bottom <= pr.top) continue;                      // scrolled past, above the view
        if (r.top >= pr.bottom && ++after > AHEAD) break;       // five past the bottom is enough for now
        if (!c._cfiDone && !c._cfiClaimed) out.push(c);
      }
      return out;
    }
    function sweep() {
      if (!popup.isConnected) return;
      var pick = cardsToLoad(); if (!pick.length) return;
      var store = spImgStore(), want = [], seen = {};
      pick.forEach(function (c) {
        c._cfiClaimed = 1;                                     // a later sweep must not ask for it again
        var sci = c.getAttribute("data-sci"); if (!sci) return;
        if (store[sci]) return;                                // already on the device: no request needed
        if (!seen[sci]) { seen[sci] = 1; want.push(sci); }
      });
      if (!want.length) { pick.forEach(fill); return; }        // all cached (or nothing to look up): paint now
      strip.classList.add("cfi-loading");                      // a quiet placeholder while the batch is out
      pending++;
      function rest() { if (!--pending) strip.classList.remove("cfi-loading"); pick.forEach(fill); }
      spImagesPrefetch(want).then(rest, rest);
    }
    var frame = 0;
    function onScroll() {
      if (!popup.isConnected) { window.removeEventListener("resize", onScroll); return; }   // the popup outlives nothing; the scroll listener goes with it
      if (typeof requestAnimationFrame === "undefined") { sweep(); return; }
      if (frame) return;
      frame = requestAnimationFrame(function () { frame = 0; sweep(); });
    }
    popup.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // The first sweep MEASURES the popup, so let the layout it was just given settle.
    if (typeof requestAnimationFrame === "undefined") sweep(); else requestAnimationFrame(sweep);
  }
  function confSwitchBtn(el, label, open) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "conf-switch"; b.textContent = label;
    b.addEventListener("click", function (e) { e.stopPropagation(); closeAnchoredMenu(); open(); });
    el.appendChild(b);
  }
  // "Confusion species (images)": the same ranked look-alikes as picture cards, left →
  // right by Score (Match without a point) and wrapping onto further rows, the species
  // itself first as the reference. Each card: photo (credited), name, scientific name, Match · misID · Here ·
  // Score; tapping a look-alike opens the compare card, as a table row does.
  async function openConfusionImages(key, x, y) {
    var lbl = key && getLabelsByKey()[key]; if (!lbl) return;
    var el = openAnchoredMenu("detrow-menu family-menu conf-menu conf-img-menu");
    el.style.maxHeight = "min(80vh,640px)"; el.style.overflowY = "auto";
    el.style.width = "min(97vw,900px)";
    var mark = confHeader(el, function () { openConfusionImages(key, x, y); });   // same title as the text view, with the sort buttons
    var closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.className = "conf-close"; closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closeAnchoredMenu(); });
    el.appendChild(closeBtn);
    confSwitchBtn(el, t("confusion.toText"), function () { openConfusionMenu(key, x, y); });   // "Text" → the table view
    var wait = document.createElement("div"); wait.className = "detrow-menu-hdr"; wait.textContent = "…";
    el.appendChild(wait); positionAnchoredMenu(el, x, y);
    var rk = await confusionRanked(key, confSort());
    if (!anchMenuOpen(el)) return;
    mark(rk);
    if (rk.none) { wait.textContent = t(rk.by === "sound" ? "confusion.noneSound" : rk.by === "scape" ? "confusion.noneScape" : "confusion.none"); positionAnchoredMenu(el, x, y); return; }
    var out = rk.out, arr = rk.arr;
    if (!arr.length) { wait.textContent = t("confusion.noneHere"); positionAnchoredMenu(el, x, y); return; }
    if (wait.parentNode) wait.parentNode.removeChild(wait);
    var L = { match: t("confusion.colScore"), misid: t("confusion.colMisid"), sound: t("confusion.colSound"), scape: t("confusion.colScape"), here: t("confusion.colHere"), score: t("confusion.colCombined") };
    // Each metric row carries data-hintkey → the wrapped hover tooltip the table headers
    // use (a native title can't wrap these explanations); phones have the legend below.
    function row(cls, label, txt, pct, color, tipKey) {
      return '<div class="cfi-row ' + cls + '" data-hintkey="' + tipKey + '"><i class="cfi-bar" style="width:' + Math.max(0, Math.min(100, pct)).toFixed(0) + '%' + (color ? ";background:" + color : "") + '"></i>' +
        '<span class="cfi-k">' + escapeHtml(label) + '</span><span class="cfi-v">' + escapeHtml(txt) + "</span></div>";
    }
    function pctTxt(p) { var v = p * 100; return v >= 0.5 ? Math.round(v) + "%" : "<1%"; }
    function card(m, w, isBase) {
      var nm = speciesName(m), here = out ? (isBase ? (out[m.index] || 0) : w.p) : -1;
      var sv = (out && !isBase) ? confScore(w) * 100 : -1;
      return '<div class="cfi-card' + (isBase ? ' cfi-base" title="' + escapeHtml(t("confusion.base")) + '"' : '"') + ' data-key="' + escapeHtml(m.key) + '" data-sci="' + escapeHtml(m.sci) + '">' +
        '<div class="spg-img"><span class="spg-none" style="display:none">' + escapeHtml(t("spg.noImage")) + "</span></div>" +
        '<div class="cfi-name">' + escapeHtml(nm) + "</div>" +   // the species itself is marked by its thicker frame (.cfi-base), not a label
        '<div class="cfi-sci">' + escapeHtml(m.sci) + "</div>" +
        '<div class="cfi-stats">' +
          row("cfi-match", L.match, (!isBase && w.w > 0) ? String(Math.round(w.w * 100)) : "—", (!isBase && w.w > 0) ? w.w * 100 : 0, "", "confusion.tipMatch") +
          row("cfi-misid", L.misid, (!isBase && w.mid > 0) ? w.mid + "%" : "—", (!isBase && w.mid > 0) ? Math.max(6, w.mid) : 0, "", "confusion.tipMisid") +
          (soundOn() ? row("cfi-sound", L.sound, (!isBase && w.snd >= 0) ? String(Math.round(w.snd * 100)) : "—", (!isBase && w.snd >= 0) ? Math.max(4, w.snd * 100) : 0, "", "confusion.tipSound") : "") +
          (soundOn() ? row("cfi-scape", L.scape, (!isBase && scapeScore(w) >= 0) ? scapeTxt(scapeScore(w)) : "—", (!isBase && scapeScore(w) >= 0) ? Math.max(4, scapeScore(w) * 100) : 0, "", "confusion.tipScape") : "") +
          row("cfi-here", L.here, here >= 0 ? pctTxt(here) : "—", here >= 0 ? Math.max(4, here * 100) : 0, here >= 0 ? probHueColor(here) : "", "confusion.tipHere") +
          row("cfi-score", L.score, sv >= 0 ? (sv >= 0.5 ? String(Math.round(sv)) : (sv > 0 ? "<1" : "0")) : "—", sv >= 0 ? Math.max(2, sv) : 0, sv >= 0 ? probHueColor(sv / 100) : "", "confusion.tipScore") +
        "</div>" +
        '<div class="spg-credit"></div>' +
      "</div>";
    }
    var strip = document.createElement("div"); strip.className = "cfi-strip";
    strip.innerHTML = card(lbl, null, true) + arr.map(function (w) { return card(w.m, w, false); }).join("");
    el.appendChild(strip); fitCardGrid(el, Math.max(strip.children.length, rk.nAll + 1));   // the squarest grid for ALL the look-alikes (+ the base card), whatever this order lists: one width across Points / Match / misID / Audio
    var legend = document.createElement("div"); legend.className = "conf-legend";
    legend.textContent = t("confusion.legend", { match: L.match, misid: L.misid, here: L.here, score: L.score });
    el.appendChild(legend);
    if (soundOn()) legend.parentNode.appendChild(soundNote());
    centerPhotoPopup(el);
    wirePhotoCards(el, strip);
    wireYearProbTips(el);                                    // hold any metric row → the year curve
    strip.addEventListener("click", function (e) {
      if (e.target.closest("a")) return;   // the photo credit link
      if (Date.now() - getSpgHoldAt() < 800) return;              // a hold just showed the year curve — not a tap on the card
      var c = e.target.closest(".cfi-card"); if (!c || c.classList.contains("cfi-base")) return;
      var pk = c.getAttribute("data-key"), w = null;
      for (var i = 0; i < arr.length; i++) if (arr[i].m.key === pk) { w = arr[i]; break; }
      if (!w) return;
      confPick(key, lbl, w, out, e.clientX, e.clientY);
    });
  }
  // A look-alike tapped in the confusion window (owner, 2026-10-14: "when user clicks the name of a confusor:
  // give choice of comparing side by side in addition to the normal species name popup"): compare the two
  // side by side, or that bird's own species menu.
  function confPick(key, lbl, w, out, x, y) {
    var nm = speciesName(w.m), menu = openAnchoredMenu("obs-addmenu");
    menu.innerHTML = '<div class="obs-addmenu-head">' + escapeHtml(nm) + "</div>" +
      '<button type="button" class="obs-addmenu-item cp-cmp">' + escapeHtml(t("confusion.cmpSide", { a: speciesName(lbl), b: nm })) + "</button>" +
      '<button type="button" class="obs-addmenu-item cp-sp">' + escapeHtml(t("confusion.spMenu")) + "</button>";
    positionAnchoredMenu(menu, x, y);
    menu.querySelector(".cp-cmp").addEventListener("click", function (e) {
      e.stopPropagation(); closeAnchoredMenu();
      openTraitCompare(key, w.m.key, speciesName(lbl), nm, x, y, { match: w.w, mid: w.mid, here: out ? w.p : null, score: out ? confScore(w) : null });
    });
    menu.querySelector(".cp-sp").addEventListener("click", function (e) {
      e.stopPropagation(); closeAnchoredMenu();
      showDetRowMenu({ key: w.m.key, name: nm, sci: w.m.sci || "" }, x, y, function () {});
    });
  }
  async function openConfusionMenu(key, x, y) {
    var lbl = key && getLabelsByKey()[key]; if (!lbl) return;
    var el = openAnchoredMenu("detrow-menu family-menu conf-menu");
    el.style.maxHeight = "min(72vh,560px)"; el.style.overflowY = "auto";
    el.style.width = "min(97vw,540px)";                       // full phone width (content-sized it came out squashed), capped on desktop
    var mark = confHeader(el, function () { openConfusionMenu(key, x, y); });
    var closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.className = "conf-close"; closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closeAnchoredMenu(); });
    el.appendChild(closeBtn);
    confSwitchBtn(el, t("splay.gallery"), function () { openConfusionImages(key, x, y); });   // "Images" → the photo cards
    positionAnchoredMenu(el, x, y);
    var wait = document.createElement("div"); wait.className = "detrow-menu-hdr"; wait.textContent = "…";
    el.appendChild(wait); positionAnchoredMenu(el, x, y);
    var rk = await confusionRanked(key, confSort());
    if (!anchMenuOpen(el)) return;                          // menu closed while loading
    mark(rk);
    if (rk.none) { wait.textContent = t(rk.by === "sound" ? "confusion.noneSound" : rk.by === "scape" ? "confusion.noneScape" : "confusion.none"); positionAnchoredMenu(el, x, y); return; }
    var out = rk.out, arr = rk.arr;
    if (!arr.length) { wait.textContent = t("confusion.noneHere"); positionAnchoredMenu(el, x, y); return; }
    if (wait.parentNode) wait.parentNode.removeChild(wait);
    // Columns: species · Match (fused confusability) · misID (iNaturalist human-confusion
    // share %) · Here (probability at the point) · Score = (0.25·Match + 0.75·misID) × Here.
    var tbl = document.createElement("table"); tbl.className = "conf-table";
    var thr = document.createElement("tr"); thr.className = "conf-head";
    thr.innerHTML = "<th></th>" +
      '<th title="' + escapeHtml(t("confusion.tipMatch")) + '">' + escapeHtml(t("confusion.colScore")) + "</th>" +
      '<th title="' + escapeHtml(t("confusion.tipMisid")) + '">' + escapeHtml(t("confusion.colMisid")) + "</th>" +
      (soundOn() ? '<th title="' + escapeHtml(t("confusion.tipSound")) + '">' + escapeHtml(t("confusion.colSound")) + "</th>" : "") +
      (soundOn() ? '<th title="' + escapeHtml(t("confusion.tipScape")) + '">' + escapeHtml(t("confusion.colScape")) + "</th>" : "") +
      '<th title="' + escapeHtml(t("confusion.tipHere")) + '">' + escapeHtml(t("confusion.colHere")) + "</th>" +
      '<th title="' + escapeHtml(t("confusion.tipScore")) + '">' + escapeHtml(t("confusion.colCombined")) + "</th>";
    tbl.appendChild(thr);
    arr.forEach(function (w) {
      var m = w.m, nm = speciesName(m);
      var tr = document.createElement("tr"); tr.className = "conf-row";
      var mv = Math.round(w.w * 100);
      // misID: raw iNat confusion count, bar log-scaled the same way the score fuses it
      var midCell;
      if (w.mid > 0) {                          // w.mid = % share of this species' iNat confusions
        midCell = probBarCell(w.mid + "%", Math.max(6, Math.min(100, w.mid)), "", "conf-misid");
      } else {
        midCell = probBarNa();
      }
      var probCell, scoreCell;
      if (out) {
        var v = w.p * 100, pct = v >= 0.5 ? Math.round(v) + "%" : "<1%";
        probCell = probBarCell(pct, Math.max(4, Math.min(100, v)), probHueColor(w.p));
        // Score = (0.25·Match + 0.75·misID) × Here; only the display is rounded —
        // a positive score below 0.5 shows "<1", never "0".
        var svRaw = confScore(w) * 100;
        var sv = svRaw >= 0.5 ? Math.round(svRaw) : (svRaw > 0 ? "<1" : "0");
        scoreCell = probBarCell(sv, Math.max(2, Math.min(100, svRaw)), probHueColor(svRaw / 100), "conf-total");
      } else {
        probCell = probBarNa();
        scoreCell = probBarNa();
      }
      // Sound: the pair's by-ear closeness (0-100) from the sound table; empty when the pair is not among the bird's eight nearest by ear
      var sndCell = !soundOn() ? "" : w.snd >= 0 ? probBarCell(Math.round(w.snd * 100), Math.max(4, w.snd * 100), "", "conf-sound") : probBarNa("conf-sound");
      // Soundscape: share of the bird's recordings with this one heard in the background × Here (share alone without a point)
      var ss = scapeScore(w), scpCell = !soundOn() ? "" : ss >= 0 ? probBarCell(scapeTxt(ss), Math.max(4, ss * 100), "", "conf-scape") : probBarNa("conf-scape");
      tr.innerHTML = '<td class="conf-name" data-name="' + escapeHtml(nm) + '" data-sci="' + escapeHtml(m.sci) + '">' + escapeHtml(nm) + '</td>' +
        (w.w > 0 ? probBarCell(mv, mv, "", "conf-match") : probBarNa("conf-match")) +   // a sound-only bird has no Match
        midCell + sndCell + scpCell +
        probCell + scoreCell;
      (function (w2) { tr.addEventListener("click", function (ev) { confPick(key, lbl, w2, out, ev.clientX, ev.clientY); }); })(w);
      tbl.appendChild(tr);
    });
    el.appendChild(tbl);
    // Column legend at the bottom — the header tooltips need a hover, which a phone hasn't got.
    var legend = document.createElement("div"); legend.className = "conf-legend";
    legend.textContent = t("confusion.legend", { match: t("confusion.colScore"), misid: t("confusion.colMisid"), here: t("confusion.colHere"), score: t("confusion.colCombined") });
    el.appendChild(legend); if (soundOn()) el.appendChild(soundNote());
    positionAnchoredMenu(el, x, y);
  }
  // Under both look-alike views: what the Sound number is (a model's ear, not people's) and the report on how good it is.
  function soundNote() {
    var d = document.createElement("div"); d.className = "conf-legend conf-sound-note";
    d.textContent = t("confusion.legendSound", { sound: t("confusion.colSound") }) + " " + t("confusion.legendScape", { scape: t("confusion.colScape"), here: t("confusion.colHere") }) + " ";
    var a = document.createElement("a"); a.href = "about/audio-similarity.html"; a.target = "_blank"; a.rel = "noopener"; a.textContent = t("confusion.soundReport");
    d.appendChild(a); return d;
  }

  return {
    init: init,
    confSwitchBtn: confSwitchBtn,
    confusionView: confusionView,
    openAudioMenu: openAudioMenu,
    openConfusionImages: openConfusionImages,
    openConfusionMenu: openConfusionMenu,
    wirePhotoCards: wirePhotoCards,
  };
})();
