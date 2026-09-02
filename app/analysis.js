/**
 * Location analysis views for a clicked point.
 *
 * All three views derive from a single 48-week prediction at one location
 * (a flat Float32Array of 48 * nSpecies sigmoid probabilities, week-major):
 *
 *   Probability heatmap – species × 48 weeks, red(low)→green(high).
 *   Arrivals heatmap     – species × 48 weeks of the arrival score
 *                          arrival[w] = (P[w+1] - P[w-1]) / max_year(P),
 *                          diverging red(departing)→grey→green(arriving),
 *                          weeks wrap at the 1↔48 boundary.
 *   Scatter              – top-N species by current-week arrival, plotted
 *                          (arrival, probability), plus a sortable table.
 *
 * Stateless renderers: app.js owns the data + UI state and passes a ctx.
 * Exposed as window.GeoAnalysis (no module system; loaded via <script>).
 */
window.GeoAnalysis = (function () {
  "use strict";

  // ---- Colour scales (match the reference app's semantics) ----------------
  // Probability: red (hue 10) at low → green (hue 130) at high.
  function probColor(norm) {
    var n = Math.max(0, Math.min(1, norm));
    return "hsl(" + (10 + n * 120) + ", 60%, 42%)";
  }
  // Arrival: diverging — red (negative/departing) → grey (≈0) → green
  // (positive/arriving), intensity ∝ |value|. Value already in [-1, 1].
  function arrivalColor(val) {
    var a = Math.max(-1, Math.min(1, val));
    var hue = a >= 0 ? 130 : 0;
    var mag = Math.abs(a);
    return "hsl(" + hue + ", " + Math.round(mag * 60) + "%, " + Math.round(60 - mag * 18) + "%)";
  }

  function arrivalAt(probs, w, maxYear) {
    if (maxYear < 1e-6) return 0;
    var prev = probs[(w + 47) % 48] || 0;
    var next = probs[(w + 1) % 48] || 0;
    return (next - prev) / maxYear;
  }

  // "Focus": cumulative sum of the weekly arrival score across the year,
  // min–max normalized to 0–100 (year low = 0, peak = 100). Peaks at the time
  // of year the species is most present. Min–max (rather than dividing by the
  // max) keeps it bounded: the raw cumulative sum is small and can be negative,
  // so dividing by a near-zero max would blow values up to thousands.
  function focusSeries(probs, maxYear) {
    var cum = new Array(48), s = 0, mn = Infinity, mx = -Infinity, w;
    for (w = 0; w < 48; w++) { s += arrivalAt(probs, w, maxYear); cum[w] = s; if (s < mn) mn = s; if (s > mx) mx = s; }
    var range = mx - mn;
    var out = new Array(48);
    for (w = 0; w < 48; w++) out[w] = range > 1e-9 ? ((cum[w] - mn) / range) * 100 : 0;
    return out;
  }

  // ---- Shared: build the visible species cohort ---------------------------
  // Returns [{ idx, label, probs:Float32Array(48), maxYear, curProb }] for
  // species whose current-week probability clears the threshold and that
  // match the (optional) text filter.
  //
  // Memo (last-call cache). app.js rebuilds a fresh ctx object on every
  // render pass (analysisCtx()) and, within that one pass, hands the *same*
  // ctx to each visibleSpecies call (the cohort count, then exactly one
  // renderer/CSV builder). The cohort is a pure function of ctx's inputs, so
  // the ctx OBJECT IDENTITY is itself a complete, leak-proof cache key: any
  // change to any input — week, thresholds, group filter, text filter, the
  // hidden set, the prediction array (allProbs), or the active language —
  // produces a brand-new ctx on the next render and therefore a cache miss.
  // This is why we key on identity rather than trying to signature inputs
  // that can't be reliably observed from here (inGroup/isHidden/speciesName
  // are closures whose behaviour mutates in place, with no version we can
  // see). A scalar signature is stored only as a secondary sanity guard so a
  // hypothetical reused-but-mutated ctx still misses. We intentionally
  // recompute fresh rows on every miss because renderers mutate the returned
  // row objects (attaching .series/.sortKey/.arrival and re-sorting in place).
  var memoCtx = null, memoSig = null, memoResult = null;
  function visibleSig(ctx) {
    return ctx.week + "|" + ctx.thresholdFrac + "|" + ctx.thresholdMax +
      "|" + (ctx.filterText || "") + "|" + ctx.nSpecies + "|" + ctx.topN +
      "|" + ctx.scatterRankBy;
  }
  function visibleSpecies(ctx) {
    var sig = visibleSig(ctx);
    if (memoCtx === ctx && memoSig === sig) return memoResult;
    var rows = computeVisibleSpecies(ctx);
    memoCtx = ctx;
    memoSig = sig;
    memoResult = rows;
    return rows;
  }
  function computeVisibleSpecies(ctx) {
    var wkIdx = ctx.week - 1;
    var f = (ctx.filterText || "").toLowerCase();
    var out = [];
    for (var i = 0; i < ctx.nSpecies; i++) {
      var cur = ctx.allProbs[wkIdx * ctx.nSpecies + i];
      if (cur < ctx.thresholdFrac) continue;
      if (ctx.thresholdMax != null && cur > ctx.thresholdMax) continue;
      if (ctx.inGroup && !ctx.inGroup(i)) continue;
      var lbl = ctx.labels[i];
      if (ctx.isHidden && ctx.isHidden(lbl.key)) continue;
      if (f) {
        var nm = ctx.speciesName(lbl).toLowerCase();
        if (nm.indexOf(f) < 0 && lbl.sci.toLowerCase().indexOf(f) < 0 && lbl.key.indexOf(f) < 0) continue;
      }
      var probs = new Float32Array(48), mx = 0;
      for (var w = 0; w < 48; w++) {
        var v = ctx.allProbs[w * ctx.nSpecies + i];
        probs[w] = v;
        if (v > mx) mx = v;
      }
      // Drop species that are effectively absent all year (zero probability
      // across every week) so they never clutter any analysis view.
      if (mx < 1e-4) continue;
      out.push({ idx: i, label: lbl, probs: probs, maxYear: mx, curProb: cur });
    }
    return out;
  }

  // ---- Heatmap (probability / arrivals / focus) ---------------------------
  // mode: "prob" | "arrival" | "focus".
  function renderHeatmap(el, ctx, mode) {
    var rows = visibleSpecies(ctx);
    var wkIdx = ctx.week - 1;
    var esc = ctx.escapeHtml;
    var isArrival = mode === "arrival", isFocus = mode === "focus";

    if (rows.length === 0) {
      el.innerHTML = '<p class="an-empty">' + esc(ctx.t("analysis.empty")) + "</p>";
      return;
    }

    // Per-row 48-week series for the active mode.
    rows.forEach(function (r) {
      if (isFocus) r.series = focusSeries(r.probs, r.maxYear);
      else if (isArrival) {
        r.series = new Array(48);
        for (var w = 0; w < 48; w++) r.series[w] = arrivalAt(r.probs, w, r.maxYear);
      }
    });

    // Sort every heatmap by the current-week value, largest first.
    if (isArrival || isFocus) {
      rows.forEach(function (r) { r.sortKey = r.series[wkIdx]; });
    } else {
      rows.forEach(function (r) { r.sortKey = r.curProb; });
    }
    rows.sort(function (a, b) { return b.sortKey - a.sortKey; });

    // Probability colour is min-max stretched across visible cells.
    var gMin = Infinity, gMax = -Infinity;
    if (mode === "prob") {
      for (var r = 0; r < rows.length; r++) {
        for (var w = 0; w < 48; w++) {
          var v = rows[r].probs[w];
          if (v < gMin) gMin = v;
          if (v > gMax) gMax = v;
        }
      }
    }
    var gRange = gMax - gMin;

    var months = ctx.months;
    var html = '<div class="an-scroll"><table class="an-heatmap">';
    // Month header row (each month spans 4 weeks).
    html += "<thead><tr><th class='an-corner'></th>";
    for (var m = 0; m < 12; m++) html += '<th colspan="4" class="an-month">' + esc(months[m]) + "</th>";
    html += "</tr><tr><th class='an-corner'>" + esc(ctx.t("th.species")) + "</th>";
    for (var c = 0; c < 48; c++) {
      var hl = c === wkIdx ? " an-cur" : "";
      html += '<th class="an-wk' + hl + '">' + (c + 1) + "</th>";
    }
    html += "</tr></thead><tbody>";

    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      // Title carries the FULL common name too — the narrow sticky column ellipsizes
      // long names, so hover must reveal what got cut, not just the sci name.
      html += '<tr><td class="an-name" title="' + esc(ctx.speciesName(row.label) + " · " + row.label.sci) + '"><span class="an-name-in">' + ctx.nameLink(row.label) + "</span></td>";
      for (var cc = 0; cc < 48; cc++) {
        var color, text;
        if (isArrival) {
          var av = row.series[cc];
          color = arrivalColor(av);
          // Show only the number; negatives keep their "-", positives have no sign.
          text = Math.abs(av) >= 0.005 ? (av * 100).toFixed(0) : "";
        } else if (isFocus) {
          var fv = row.series[cc];
          color = probColor(Math.max(0, Math.min(1, fv / 100)));
          text = Math.abs(fv) >= 1 ? Math.round(fv).toString() : "";
        } else {
          var pv = row.probs[cc];
          var norm = gRange > 0 ? (pv - gMin) / gRange : 0;
          color = probColor(norm);
          text = pv > 0 ? (pv * 100).toFixed(0) : "";
        }
        var curCls = cc === wkIdx ? " an-cur" : "";
        html += '<td class="an-cell' + curCls + '" style="background:' + color + '">' + text + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table></div>";
    el.innerHTML = html;
    // Desktop: give the sticky name column a bit more room than mobile's 110 px
    // (up to the 6th-widest rendered name, hard-capped at 180 px) — the rest of
    // the page width goes to the 48 week cells, which stretch via width:100%.
    if (window.matchMedia && window.matchMedia("(min-width: 860px) and (pointer: fine)").matches) {
      var nameCells = el.querySelectorAll("td.an-name .an-name-in"), ws = [];
      for (var i2 = 0; i2 < nameCells.length; i2++) ws.push(nameCells[i2].scrollWidth);
      ws.sort(function (a, b) { return b - a; });
      var w6 = (ws[Math.min(5, ws.length - 1)] || 0) + 12;   // 6th-widest + slack
      var tb = el.querySelector("table.an-heatmap");
      if (tb) tb.style.setProperty("--an-name-w", Math.max(110, Math.min(w6, 180)) + "px");
    }
  }

  // ---- Scatter + sortable table -------------------------------------------
  function renderScatter(el, ctx) {
    var rows = visibleSpecies(ctx);
    var wkIdx = ctx.week - 1;
    var esc = ctx.escapeHtml;

    // Per-species current-week (arrival, probability).
    rows.forEach(function (r) {
      r.arrival = arrivalAt(r.probs, wkIdx, r.maxYear);
      r.probability = r.curProb;
    });

    var N = Math.max(1, Math.min(500, ctx.topN || 55));
    // Which species become plotted points: top-N by arrival, by probability,
    // or the union of both.
    var rankBy = ctx.scatterRankBy || "arrival";
    var topArr = rows.slice().sort(function (a, b) { return b.arrival - a.arrival; }).slice(0, N);
    var topProb = rows.slice().sort(function (a, b) { return b.probability - a.probability; }).slice(0, N);
    var top;
    if (rankBy === "prob") top = topProb;
    else if (rankBy === "both") {
      var seen = {};
      top = [];
      topArr.concat(topProb).forEach(function (it) { if (!seen[it.idx]) { seen[it.idx] = 1; top.push(it); } });
    } else top = topArr;

    var svg = "";
    if (top.length === 0) {
      svg = '<p class="an-empty">' + esc(ctx.t("analysis.empty")) + "</p>";
    } else {
      var W = 800, H = 500, ML = 60, MR = 24, MT = 24, MB = 56;
      var PW = W - ML - MR, PH = H - MT - MB;
      var xMinPt = Infinity, xMaxPt = -Infinity, yMinPt = Infinity, yMaxPt = -Infinity;
      top.forEach(function (it) {
        if (it.arrival < xMinPt) xMinPt = it.arrival;
        if (it.arrival > xMaxPt) xMaxPt = it.arrival;
        if (it.probability < yMinPt) yMinPt = it.probability;
        if (it.probability > yMaxPt) yMaxPt = it.probability;
      });
      var xSpan = Math.max(1e-3, xMaxPt - xMinPt), ySpan = Math.max(1e-3, yMaxPt - yMinPt);
      var xPad = Math.max(0.01, xSpan * 0.07), yPad = Math.max(0.003, ySpan * 0.07);
      var xMin = xMinPt - xPad, xMax = xMaxPt + xPad;
      var yMin = Math.max(0, yMinPt - yPad), yMax = yMaxPt + yPad;
      var sx = function (a) { return ML + ((a - xMin) / (xMax - xMin)) * PW; };
      var sy = function (p) { return MT + PH - ((p - yMin) / (yMax - yMin)) * PH; };

      var niceTicks = function (lo, hi, target) {
        target = target || 5;
        if (!(hi > lo)) return [lo];
        var span = hi - lo, raw = span / target;
        var mag = Math.pow(10, Math.floor(Math.log10(raw)));
        var norm = raw / mag;
        var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
        var first = Math.ceil(lo / step) * step, out = [];
        for (var tk = first; tk <= hi + step * 1e-6; tk += step) out.push(Number(tk.toFixed(10)));
        return out;
      };

      svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" class="an-scatter-svg" preserveAspectRatio="xMidYMid meet">';
      // Zero-arrival reference line.
      if (xMin < 0 && xMax > 0) {
        var x0 = sx(0).toFixed(1);
        svg += '<line x1="' + x0 + '" y1="' + MT + '" x2="' + x0 + '" y2="' + (MT + PH) + '" stroke="rgba(0,0,0,0.18)" stroke-width="1"/>';
      }
      // Axis ticks + labels.
      niceTicks(xMin, xMax).forEach(function (tk) {
        var x = sx(tk).toFixed(1);
        svg += '<line x1="' + x + '" y1="' + (MT + PH + 4) + '" x2="' + x + '" y2="' + (MT + PH + 8) + '" stroke="#8b97a8"/>';
        svg += '<text x="' + x + '" y="' + (MT + PH + 22) + '" font-size="11" fill="#5a6b72" text-anchor="middle">' + (tk * 100).toFixed(tk === 0 ? 0 : 1) + "%</text>";
      });
      niceTicks(yMin, yMax).forEach(function (tk) {
        var y = sy(tk).toFixed(1);
        svg += '<line x1="' + (ML - 8) + '" y1="' + y + '" x2="' + (ML - 4) + '" y2="' + y + '" stroke="#8b97a8"/>';
        svg += '<text x="' + (ML - 10) + '" y="' + (Number(y) + 4).toFixed(1) + '" font-size="11" fill="#5a6b72" text-anchor="end">' + (tk * 100).toFixed(tk === 0 ? 0 : 1) + "%</text>";
      });
      svg += '<text x="' + (ML + PW / 2) + '" y="' + (MT + PH + 46) + '" font-size="12" fill="#5a6b72" text-anchor="middle">' + esc(ctx.t("scatter.xAxis")) + "</text>";
      svg += '<text x="' + (ML - 42) + '" y="' + (MT + PH / 2) + '" font-size="12" fill="#5a6b72" text-anchor="middle" transform="rotate(-90 ' + (ML - 42) + " " + (MT + PH / 2) + ')">' + esc(ctx.t("scatter.yAxis")) + "</text>";
      // Points.
      top.forEach(function (it) {
        var x = sx(it.arrival).toFixed(1), y = sy(it.probability).toFixed(1);
        var name = ctx.speciesName(it.label);
        var title = name + " (" + it.label.sci + ")\n" + ctx.t("th.arrival") + " " + (it.arrival * 100).toFixed(1) + "%\n" + ctx.t("th.prob") + " " + (it.probability * 100).toFixed(1) + "%";
        svg += '<circle class="an-pt" cx="' + x + '" cy="' + y + '" r="5" fill="' + arrivalColor(it.arrival) + '" stroke="rgba(0,0,0,0.5)" stroke-width="0.8"><title>' + esc(title) + "</title></circle>";
      });
      svg += "</svg>";
    }

    // Sortable table over the full visible cohort (not clipped to top-N).
    rows.forEach(function (r) {
      if (r.arrival === undefined) r.arrival = arrivalAt(r.probs, wkIdx, r.maxYear);
      r.probability = r.curProb;
    });
    var sort = ctx.scatterSort || { column: "arrival", dir: "desc" };
    rows.sort(function (a, b) {
      if (sort.column === "species") {
        var an = ctx.speciesName(a.label), bn = ctx.speciesName(b.label);
        return sort.dir === "asc" ? an.localeCompare(bn) : bn.localeCompare(an);
      }
      var av = a[sort.column] || 0, bv = b[sort.column] || 0;
      return sort.dir === "asc" ? av - bv : bv - av;
    });
    var pMin = Infinity, pMax = -Infinity;
    rows.forEach(function (r) { if (r.probability < pMin) pMin = r.probability; if (r.probability > pMax) pMax = r.probability; });
    var pRange = pMax - pMin;
    var arrow = function (col) { return col === sort.column ? (sort.dir === "desc" ? " ▼" : " ▲") : ""; };

    var tbl = '<table class="an-scatter-table"><thead><tr>';
    tbl += '<th data-sort="species">' + esc(ctx.t("th.species")) + arrow("species") + "</th>";
    tbl += '<th data-sort="probability" class="an-num">' + esc(ctx.t("th.prob")) + arrow("probability") + "</th>";
    tbl += '<th data-sort="arrival" class="an-num">' + esc(ctx.t("th.arrival")) + arrow("arrival") + "</th>";
    tbl += "</tr></thead><tbody>";
    rows.forEach(function (r) {
      var norm = pRange > 0 ? (r.probability - pMin) / pRange : 0;
      tbl += "<tr><td>" + ctx.nameLink(r.label) + "</td>";
      tbl += '<td class="an-num an-tint" style="background:' + probColor(norm) + '">' + (r.probability * 100).toFixed(1) + "%</td>";
      tbl += '<td class="an-num an-tint" style="background:' + arrivalColor(r.arrival) + '">' + (r.arrival * 100).toFixed(1) + "%</td></tr>";
    });
    tbl += "</tbody></table>";

    el.innerHTML = svg + tbl;

    // Header click → sort (handled by app.js via the returned hook).
    var ths = el.querySelectorAll(".an-scatter-table th[data-sort]");
    for (var i = 0; i < ths.length; i++) {
      ths[i].addEventListener("click", function () {
        var col = this.getAttribute("data-sort");
        if (sort.column === col) sort.dir = sort.dir === "desc" ? "asc" : "desc";
        else { sort.column = col; sort.dir = col === "species" ? "asc" : "desc"; }
        ctx.onSortChange(sort);
      });
    }
  }

  // ---- CSV (current tab) ---------------------------------------------------
  function buildCsv(ctx, mode) {
    var rows = visibleSpecies(ctx);
    var esc = function (v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [];
    if (mode === "scatter") {
      var wkIdx = ctx.week - 1;
      lines.push(["species_code", "common_name", "scientific_name", "probability", "arrival"].join(","));
      rows.forEach(function (r) {
        var a = arrivalAt(r.probs, wkIdx, r.maxYear);
        lines.push([r.label.key, esc(ctx.speciesName(r.label)), esc(r.label.sci), r.curProb.toFixed(6), a.toFixed(6)].join(","));
      });
    } else {
      var hdr = ["species_code", "common_name", "scientific_name"];
      for (var w = 1; w <= 48; w++) hdr.push("week_" + w);
      lines.push(hdr.join(","));
      rows.forEach(function (r) {
        var vals = [], fs = mode === "focus" ? focusSeries(r.probs, r.maxYear) : null;
        for (var ww = 0; ww < 48; ww++) {
          vals.push(mode === "arrival" ? arrivalAt(r.probs, ww, r.maxYear).toFixed(6)
            : mode === "focus" ? fs[ww].toFixed(3)
            : r.probs[ww].toFixed(6));
        }
        lines.push([r.label.key, esc(ctx.speciesName(r.label)), esc(r.label.sci)].concat(vals).join(","));
      });
    }
    return { count: rows.length, content: lines.join("\n") };
  }

  return {
    visibleSpecies: visibleSpecies,
    renderHeatmap: renderHeatmap,
    renderScatter: renderScatter,
    buildCsv: buildCsv,
    focusSeries: focusSeries,
  };
})();
