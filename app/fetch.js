/**
 * Observation fetch / network layer.
 *
 * Third modularisation step. Holds the low-level GBIF helpers (geometry, paged
 * fetch with backoff, bounded concurrency) and the per-source HTTP adapters that
 * pull raw records from each API (GBIF / iNaturalist / eBird / Artsobservasjoner
 * / Artportalen / Laji.fi). app.js still owns the orchestration (which sources to
 * run, per-source timeouts, the loading-line progress UI) and pipes each
 * adapter's output through AppNormalize.norm*().
 *
 * Revealing module. It needs a few things app.js owns — the GBIF dataset config
 * (which datasets, which are disabled), the country-gating + Laji-vs-GBIF rules,
 * and the iNat locale — so app.js injects them once via AppFetch.init({...}).
 * Injected locals are deliberately given the SAME names the code used inside the
 * monolith, so the moved bodies are byte-for-byte unchanged.
 *
 * Exposes (used by app.js): the 8 fetch adapters + gbifGeometry & gbifPage (the
 * range-plot occurrence fetchers in app.js reuse those two).
 */
window.AppFetch = (function () {
  "use strict";

  // ---- Injected by app.js (config / geo / i18n it owns) --------------------
  var gbifDatasets = function () { return []; };       // GBIF datasets to fetch (GeoState-backed)
  var isGbifOff = function () { return false; };        // a dataset disabled in Settings?
  var GBIF_DS_COUNTRY = {};                             // datasetKey -> ISO-2 (nation-specific gating)
  var lajiDirectActive = function () { return false; }; // direct Laji.fi source on? (skip its GBIF republish)
  var countryMatch = function () { return false; };     // does the search reach a given country?
  var inatLocale = function () { return "en"; };        // iNat common-name locale
  var gbifTaxonParam = function () { return "&taxonKey=212"; };  // class taxonKey(s) for the active group (default = Aves)
  var gbifGroup = function () { return "all"; };                // active species group id (for per-group dataset gating)
  var inatIconicTaxa = function () { return "Aves"; };          // iNat iconic_taxa for the active group ("" = no filter)
  // ---- Truncation diagnostics ----------------------------------------------
  // Each adapter records whether its LAST call was cut short by an API limit
  // (record cap, page budget, or a radius clamp), keyed by adapter id. The app
  // reads-and-clears it per source after each fetch (takeTrunc) and surfaces it
  // in the fetch-issues dialog — so "a big area misses detections" is explained.
  var lastTrunc = Object.create(null);
  function noteTrunc(id, info) { if (info) lastTrunc[id] = info; else delete lastTrunc[id]; }
  function takeTrunc(id) { var v = lastTrunc[id]; delete lastTrunc[id]; return v || null; }
  function init(deps) {
    deps = deps || {};
    if (deps.gbifDatasets) gbifDatasets = deps.gbifDatasets;
    if (deps.isGbifOff) isGbifOff = deps.isGbifOff;
    if (deps.GBIF_DS_COUNTRY) GBIF_DS_COUNTRY = deps.GBIF_DS_COUNTRY;
    if (deps.lajiDirectActive) lajiDirectActive = deps.lajiDirectActive;
    if (deps.countryMatch) countryMatch = deps.countryMatch;
    if (deps.inatLocale) inatLocale = deps.inatLocale;
    if (deps.gbifTaxonParam) gbifTaxonParam = deps.gbifTaxonParam;
    if (deps.gbifGroup) gbifGroup = deps.gbifGroup;
    if (deps.inatIconicTaxa) inatIconicTaxa = deps.inatIconicTaxa;
  }
  // A dataset restricted to certain species groups (d.groups) is only queried when
  // the active group is "all" or one of them. Returns true = skip this dataset.
  function gbifGroupSkip(d) {
    if (!d.groups || !d.groups.length) return false;
    var g = gbifGroup();
    return g !== "all" && d.groups.indexOf(g) < 0;
  }
  // The taxon filter for a dataset. Normally the active group's filter — but in "all"
  // mode a group-restricted dataset (e.g. Pl@ntNet, plants+fungi) uses its OWN filter
  // (d.taxa) so it still returns its taxa instead of the animal-only "all" filter.
  function gbifTaxaFor(d) {
    return (gbifGroup() === "all" && d && d.taxa) ? d.taxa : gbifTaxonParam();
  }

  // GBIF's FinBIF republish dataset; the direct Laji.fi source supersedes it.
  var LAJI_GBIF_KEY = "df12ca07-f133-4550-ab3b-fde13f0e76ba";

  function gbifGeometry(lat, lon, km) {
    var dLat = km / 111.32;
    var cos = Math.cos(lat * Math.PI / 180);
    var dLon = km / (111.32 * (cos > 0.01 ? cos : 0.01));
    var s = Math.max(-90, lat - dLat), n = Math.min(90, lat + dLat), w = lon - dLon, e = lon + dLon;
    return "POLYGON((" + w + " " + s + "," + e + " " + s + "," + e + " " + n + "," + w + " " + n + "," + w + " " + s + "))";
  }
  // Shared GBIF quality filter for every occurrence fetch:
  //  · occurrenceStatus=PRESENT  → drop "species NOT seen" absence records.
  //  · hasGeospatialIssue=false  → drop records GBIF flagged with bad coordinates.
  // The class taxonKey(s) are appended separately via gbifTaxonParam() so they
  // track the active species group (filtering at the source cuts data/pages
  // massively and keeps the 100k offset budget for the wanted classes).
  var GBIF_FILTER = "&occurrenceStatus=PRESENT&hasGeospatialIssue=false";
  // Sleep that also resolves the instant the abort signal fires, so a fetch
  // timeout (or a new-search abort) cuts a backoff wait short instead of letting
  // GBIF overshoot its time budget by up to the full backoff (~8s) after the abort.
  function gbifSleep(ms, sig) {
    return new Promise(function (r) {
      if (sig && sig.aborted) { r(); return; }
      var done = function () { clearTimeout(t); if (sig) { try { sig.removeEventListener("abort", done); } catch (e) {} } r(); };
      var t = setTimeout(done, ms);
      if (sig) { try { sig.addEventListener("abort", done); } catch (e) {} }
    });
  }
  // One reliable HTTP request, shared by EVERY source adapter so the rate-limit
  // handling lives in one place: a per-request timeout (a hung connection can't
  // stall the whole fetch) plus retry-with-backoff on 429 (rate limit) and 5xx /
  // network errors. Without this a spot's records appear or vanish run-to-run
  // depending on which requests got a 429. `opts` is the fetch init (method /
  // headers / body); the abort signal is passed separately as `extSignal` and
  // linked to the internal per-request controller. Returns a Response — an OK one,
  // a non-retryable 4xx (so the caller can read .status), or the last 429/5xx after
  // retries are exhausted — or null when it aborted or every attempt was a
  // network/timeout error.
  async function fetchRetry(url, opts, extSignal) {
    var last = null;
    for (var attempt = 0; attempt < 5; attempt++) {
      if (extSignal && extSignal.aborted) return null;   // fetch-timeout fired → stop, keep partial
      try {
        var ctrl = new AbortController();
        var to = setTimeout(function () { ctrl.abort(); }, 25000);
        var onAbort = function () { try { ctrl.abort(); } catch (e) {} };
        if (extSignal) extSignal.addEventListener("abort", onAbort);
        var resp;
        try { resp = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
        finally { clearTimeout(to); if (extSignal) extSignal.removeEventListener("abort", onAbort); }
        if (resp.status === 429 || resp.status >= 500) {
          last = resp;                    // remember it so an exhausted retry still reports the status
          var ra = parseFloat(resp.headers.get("Retry-After"));
          await gbifSleep(isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : Math.min(500 * Math.pow(2, attempt), 8000), extSignal);
          continue;                       // rate-limited / transient → wait and retry
        }
        return resp;                      // ok, or a non-retryable status the caller inspects
      } catch (e) {
        if (extSignal && extSignal.aborted) return null;   // aborted by the fetch timeout → stop, don't retry
        await gbifSleep(Math.min(500 * Math.pow(2, attempt), 8000), extSignal);   // timeout / network → back off and retry
      }
    }
    return last;                          // retries exhausted → last 429/5xx, or null if only network errors
  }
  // Fetch one GBIF page: the retried request above, parsed to JSON (null on a
  // non-OK status or a malformed body — the historic pager retries that offset).
  // Global cap on concurrent GBIF page requests. The historic fetch now splits a
  // long range into many parallel month batches (each with its own per-dataset
  // concurrency), so without a shared gate the combined burst would trip GBIF's
  // rate limiter. Every gbifPage acquires a slot and releases it when done, so no
  // matter how the work is split the number of in-flight page requests is bounded.
  var GBIF_MAX_INFLIGHT = 8, _gbifActive = 0, _gbifQueue = [];
  function gbifAcquire() {
    return new Promise(function (resolve) {
      if (_gbifActive < GBIF_MAX_INFLIGHT) { _gbifActive++; resolve(); }
      else _gbifQueue.push(resolve);
    });
  }
  function gbifRelease() {
    if (_gbifQueue.length) _gbifQueue.shift()();   // hand the slot to a waiter (active count unchanged)
    else _gbifActive--;
  }
  async function gbifPage(url, extSignal) {
    await gbifAcquire();
    try {
      var resp = await fetchRetry(url, null, extSignal);
      if (!resp || !resp.ok) return null;
      try { return await resp.json(); } catch (e) { return null; }
    } finally { gbifRelease(); }
  }
  // Run task thunks with a bounded concurrency so the parallel dataset queries
  // don't fire as one big burst (which is what trips GBIF's rate limiter). Order
  // of results matches the input.
  async function gbifRunLimited(thunks, limit) {
    var results = new Array(thunks.length), next = 0;
    async function worker() { while (next < thunks.length) { var i = next++; results[i] = await thunks[i](); } }
    var pool = []; for (var w = 0; w < Math.min(limit, thunks.length); w++) pool.push(worker());
    await Promise.all(pool);
    return results;
  }
  // onDataset(done, total) (optional) reports how many of the per-dataset queries
  // have finished — surfaced in the app's "Loading observations…" line as GBIF[d/t].
  async function fetchGbifAll(lat, lon, range, rkm, cc, signal, onProgress, extra, onDataset, historic) {
    // Taxon filter is appended per-dataset (gbifTaxaFor) so a group-restricted dataset
    // can override it; everything else is shared in `base`.
    var base = "https://api.gbif.org/v1/occurrence/search?hasCoordinate=true&limit=300&geometry=" +
      encodeURIComponent(gbifGeometry(lat, lon, rkm)) + "&eventDate=" + encodeURIComponent(range) + GBIF_FILTER + (extra || "");   // `extra` e.g. "&month=5&month=6" (historic month filter)
    // Page progress (estimate): each query learns its page count from `count` on
    // its first page; `done` ticks up per fetched page. Reported to onProgress so
    // a caller can draw a page-based progress bar.
    var prog = { done: 0, total: 0 };
    function report() { if (onProgress) { try { onProgress(prog.done, prog.total); } catch (e) {} } }
    // Each pull is self-contained: a (now retried) page that still fails just
    // stops that one query with whatever it has, so a flaky per-dataset query
    // can't reject the shared run and wipe out the other datasets' results.
    // It pages until the source says it has NO MORE pages (endOfRecords / a short
    // page), so a dense spot isn't truncated — bounded only by GBIF's hard limit
    // of offset+limit ≤ 100 000 (≈ 333 pages of 300).
    var truncGot = 0, truncTot = 0;   // fetched vs server-reported counts across the dataset queries (diagnostics)
    async function pull(b) {
      var out = [], offset = 0, sized = false, est = 0, got = 0, qCount = 0;
      while (offset < 99700) {
        if (signal && signal.aborted) break;
        var j = await gbifPage(b + "&offset=" + offset, signal);
        // A page can fail transiently under GBIF's rate limiter. Don't truncate
        // the WHOLE query on one miss — give the SAME offset several more
        // attempts (each with gbifPage's own retries) with a growing pause,
        // before giving up. An abort (the live fetch's per-source timeout)
        // short-circuits immediately, so this patience only applies to the
        // historic fetch (no timeout) where completeness matters most.
        for (var rt = 0; !j && rt < 4 && !(signal && signal.aborted); rt++) {
          await gbifSleep(2000 * (rt + 1), signal);
          j = await gbifPage(b + "&offset=" + offset, signal);
        }
        if (!j) break;                    // genuinely unreachable after all attempts (or aborted) → keep what we have
        var res = j.results || [];
        if (!sized) { sized = true; var cnt = (+j.count || res.length); qCount = cnt; est = Math.min(Math.ceil(Math.min(cnt, 100200) / 300), 334); prog.total += est; }
        prog.done++; got++; report();
        out = out.concat(res);
        if (res.length < 300 || j.endOfRecords) break;   // GBIF says there are no more pages
        offset += 300;
      }
      // Reconcile: we reserved `est` pages from count, but a query that fails on
      // a later page (rate-limited) or that GBIF over-counted fetches fewer. Drop
      // the phantom remainder so `done` can reach `total` — otherwise the bar
      // plateaus (around half when many per-dataset queries get rate-limited).
      if (est > got) { prog.total -= (est - got); report(); }
      truncGot += out.length; truncTot += Math.max(qCount, out.length);   // diagnostics: what the server said vs what we got
      return out;
    }
    // Query ONLY the configured GBIF datasets — never a blanket unfiltered pull
    // across all of GBIF. Global datasets (no country tag, e.g. Observation.org)
    // are always queried; nation-specific ones only when the point/radius reaches
    // their country. So near a country we fetch that country's datasets, not the
    // whole GBIF corpus.
    var tasks = [];
    gbifDatasets().forEach(function (d) {
      if (!d || !d.key) return;
      if (isGbifOff(d.key)) return;   // user-disabled in Settings
      // Historic-only datasets (e.g. eBird EOD — GBIF's copy lags eBird's live API)
      // are queried ONLY for a Historic date-range fetch, never the recent feed.
      if (d.historicOnly && !historic) return;
      // Group-restricted datasets (e.g. Pl@ntNet → plants/fungi) only when the active
      // group is "all" or one of theirs.
      if (gbifGroupSkip(d)) return;
      // The FinBIF GBIF dataset is a delayed republish of Laji.fi — skip it when
      // the direct Laji.fi source is active (fresher, better links).
      if (d.key === LAJI_GBIF_KEY && lajiDirectActive()) return;
      // Skip a nation-specific dataset unless we're in (or the radius reaches) its
      // country — `country` tag for discovered ones, GBIF_DS_COUNTRY for defaults.
      var dcc = d.country || GBIF_DS_COUNTRY[d.key];
      if (dcc && !countryMatch(lat, lon, dcc, rkm, cc)) return;
      var url = base + gbifTaxaFor(d) + "&datasetKey=" + encodeURIComponent(d.key);
      var task = function () { return pull(url); };
      task.dsName = d.name || "";   // for the "GBIF[2/4](name|name)" progress readout
      tasks.push(task);
    });
    // Report per-dataset progress: done/total PLUS the names currently in-flight, so
    // the app can show e.g. GBIF[2/4](Pl@ntNet|Artsobservasjoner).
    var totalDs = tasks.length, doneDs = 0, active = [];
    if (onDataset) {
      var reportDs = function () { try { onDataset(doneDs, totalDs, active.slice()); } catch (e) {} };
      reportDs();
      tasks = tasks.map(function (task) {
        var nm = task.dsName || "";
        return function () {
          if (nm) active.push(nm); reportDs();
          var fin = function () { doneDs++; var i = active.indexOf(nm); if (i >= 0) active.splice(i, 1); reportDs(); };
          return Promise.resolve(task()).then(function (r) { fin(); return r; }, function (e) { fin(); throw e; });
        };
      });
    }
    // Cap concurrency (not all-at-once) so the burst doesn't trip GBIF's rate
    // limiter — combined with gbifPage's retries this makes the result stable.
    var parts = await gbifRunLimited(tasks, 6);
    prog.done = prog.total; report();   // settle the bar to 100% once every query has finished
    var seen = Object.create(null), all = [];
    parts.forEach(function (arr) { (arr || []).forEach(function (o) {
      if (o.key != null) { if (seen[o.key]) return; seen[o.key] = 1; }
      all.push(o);
    }); });
    // Diagnostics: the server-reported record counts exceeded what the page budget /
    // rate limiter let us fetch → the area was too dense for a complete pull.
    noteTrunc("gbif", (truncTot > truncGot + 50 && truncTot > truncGot * 1.02) ? { kept: truncGot, total: truncTot } : null);
    return all;
  }
  // Auto-discovery removed: it over-collected datasets. The GBIF dataset list is
  // now the curated defaults plus the ones the user adds by hand (key + country
  // + URL) in Settings → GBIF datasets.
  // Count-only GBIF query (limit=0) for a geometry + eventDate range, summed over
  // the SAME datasets fetchGbifAll queries (configured, enabled, country-matched) —
  // NOT an unfiltered all-of-GBIF count. Keeps the historic range-split and
  // completeness check consistent with what is actually fetched.
  async function gbifCount(lat, lon, range, rkm, cc, signal, extra) {
    var base = "https://api.gbif.org/v1/occurrence/search?hasCoordinate=true&limit=0&geometry=" +
      encodeURIComponent(gbifGeometry(lat, lon, rkm)) + "&eventDate=" + encodeURIComponent(range) + GBIF_FILTER + (extra || "");
    var dsets = gbifDatasets(), total = 0;
    for (var i = 0; i < dsets.length; i++) {
      var d = dsets[i];
      if (!d || !d.key || isGbifOff(d.key)) continue;
      if (gbifGroupSkip(d)) continue;
      if (d.key === LAJI_GBIF_KEY && lajiDirectActive()) continue;
      var dcc = d.country || GBIF_DS_COUNTRY[d.key];
      if (dcc && !countryMatch(lat, lon, dcc, rkm, cc)) continue;
      if (signal && signal.aborted) break;
      var j = await gbifPage(base + gbifTaxaFor(d) + "&datasetKey=" + encodeURIComponent(d.key), signal);
      total += j ? (+j.count || 0) : 0;
    }
    return total;
  }
  function gbifMidDate(from, to) {
    var a = Date.parse(from), b = Date.parse(to);
    if (isNaN(a) || isNaN(b)) return from;
    return new Date(a + Math.floor((b - a) / 2)).toISOString().slice(0, 10);
  }
  function gbifAddDay(d, n) {
    var tms = Date.parse(d); if (isNaN(tms)) return d;
    return new Date(tms + n * 86400000).toISOString().slice(0, 10);
  }
  // GBIF's offset paging tops out at 100 000 records per query, so a wide
  // historic range at a dense spot would silently drop everything past 100k.
  // Bisect the DATE range until each sub-range is under the ceiling, fetch each
  // fully (fetchGbifAll pages it), and concatenate — so every page is retrieved.
  // Sub-ranges are disjoint (mid | mid+1), so a record can't land in two of them.
  // Sequential (await) sub-fetches also spread the request load over time, which
  // eases GBIF's rate limiter.
  async function fetchGbifHistoric(lat, lon, from, to, rkm, cc, signal, onProgress, extra) {
    if (signal && signal.aborted) return [];
    var count = await gbifCount(lat, lon, from + "," + to, rkm, cc, signal, extra);
    var mid = gbifMidDate(from, to);
    var canSplit = from < to && mid > from && mid < to;
    if (count <= 95000 || !canSplit) {
      var recs = await fetchGbifAll(lat, lon, from + "," + to, rkm, cc, signal, onProgress, extra, null, true);   // historic=true → include historic-only datasets (eBird EOD)
      // Completeness guard: if paging still came back well short of the known
      // count (a transient truncation the per-page retries couldn't overcome)
      // and the range can still be split, recover the remainder by bisecting.
      if (count > 0 && recs.length < count * 0.85 && canSplit && !(signal && signal.aborted)) {
        var la = await fetchGbifHistoric(lat, lon, from, mid, rkm, cc, signal, onProgress, extra);
        var lb = await fetchGbifHistoric(lat, lon, gbifAddDay(mid, 1), to, rkm, cc, signal, onProgress, extra);
        return la.concat(lb);
      }
      return recs;
    }
    var a = await fetchGbifHistoric(lat, lon, from, mid, rkm, cc, signal, onProgress, extra);
    var b = await fetchGbifHistoric(lat, lon, gbifAddDay(mid, 1), to, rkm, cc, signal, onProgress, extra);
    return a.concat(b);
  }
  // Append a query string to a (possibly already-parameterised) endpoint URL.
  function joinUrl(base, params) { return base + (base.indexOf("?") < 0 ? "?" : "&") + params; }
  async function fetchInatAll(lat, lon, d1, d2, rkm, ep, signal) {
    var taxa = inatIconicTaxa();
    var base = joinUrl(ep || "https://api.inaturalist.org/v1/observations",
      "verifiable=true&order_by=observed_on&order=desc&per_page=200&locale=" + encodeURIComponent(inatLocale()) +
      (taxa ? "&iconic_taxa=" + encodeURIComponent(taxa) : "") +   // restrict to the active group's iconic taxa (Aves / Mammalia / …)
      "&d1=" + d1 + "&d2=" + d2 + "&lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&radius=" + Math.min(200, rkm));   // iNat caps radius at 200 km; clamp so it matches the other sources' scope
    var all = [], lastLen = 0;
    // Page until a short page (source exhausted) rather than an arbitrary cap, so
    // a dense spot isn't truncated. iNat caps a query at 10k records = 50 pages of
    // 200, so that's the hard ceiling.
    for (var page = 1; page <= 50; page++) {
      if (signal && signal.aborted) break;   // fetch timeout → keep the pages we have
      var resp = await fetchRetry(base + "&page=" + page, null, signal);
      if (!resp || !resp.ok) {
        if (page === 1 && !(signal && signal.aborted)) throw new Error("iNaturalist " + (resp ? "HTTP " + resp.status : "unreachable"));
        break;   // a later page failed (or aborted) → keep what we have
      }
      var res = ((await resp.json().catch(function () { return null; })) || {}).results || [];
      lastLen = res.length;
      all = all.concat(res);
      if (res.length < 200) break;
    }
    // Diagnostics: radius clamped to iNat's 200 km limit, and/or the 10k page budget hit.
    var tr = null;
    if (rkm > 200) tr = { clampKm: 200 };
    if (page > 50 && lastLen === 200) { tr = tr || {}; tr.cap = true; tr.kept = all.length; }
    noteTrunc("inat", tr);
    return all;
  }
  async function fetchEbirdAll(lat, lon, tok, rkm, ep, back, signal) {
    var dist = Math.max(1, Math.min(50, rkm));
    var bk = Math.max(1, Math.min(30, +back || 30));   // eBird caps "back" at 30 days
    if (!tok) throw new Error("eBird: no API key");   // surfaced as a failed source, not a silent empty
    var ge = ep || "https://api.ebird.org/v2/data/obs/geo/recent";
    var url = joinUrl(ge, "lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&dist=" + dist + "&back=" + bk + "&maxResults=10000&includeProvisional=true");
    var r = await fetchRetry(url, { headers: { "X-eBirdApiToken": tok } }, signal);
    if (!r) { if (signal && signal.aborted) return []; throw new Error("eBird unreachable"); }
    if (!r.ok) throw new Error("eBird HTTP " + r.status);   // bad/expired key (401/403) → flagged, not hidden
    var obs = await r.json();
    // Diagnostics: eBird's geo/recent covers at most 50 km — a larger requested
    // radius silently searches only the inner 50 km; and a full 10k answer means
    // the record cap truncated the result.
    var tr = null;
    if (rkm > 50) tr = { clampKm: 50 };
    if (obs.length >= 9500) { tr = tr || {}; tr.cap = true; tr.kept = obs.length; }
    noteTrunc("ebird", tr);
    await ebirdEnrichObservers(obs, tok, ge, signal);   // geo/recent omits observers → look them up per checklist
    return obs;
  }
  // eBird "notable" feed — regionally-flagged rarities near a point. Used by the
  // rarity-alert poller, not the normal fetch pipeline. detail=full already
  // carries userDisplayName + obsId, so no checklist enrichment is needed.
  // sppLocale asks eBird for common names in the UI language (falls back to en
  // server-side for untranslated species).
  async function fetchEbirdNotable(lat, lon, tok, rkm, back, sppLocale, signal) {
    if (!tok) throw new Error("eBird: no API key");
    var dist = Math.max(1, Math.min(50, rkm || 25));   // eBird caps dist at 50 km
    var bk = Math.max(1, Math.min(30, +back || 7));
    var url = joinUrl("https://api.ebird.org/v2/data/obs/geo/recent/notable",
      "lat=" + lat.toFixed(4) + "&lng=" + lon.toFixed(4) + "&dist=" + dist + "&back=" + bk +
      "&detail=full&maxResults=500" + (sppLocale ? "&sppLocale=" + encodeURIComponent(sppLocale) : ""));
    var r = await fetchRetry(url, { headers: { "X-eBirdApiToken": tok } }, signal);
    if (!r) { if (signal && signal.aborted) return []; throw new Error("eBird unreachable"); }
    if (!r.ok) { var err = new Error("eBird HTTP " + r.status); err.status = r.status; throw err; }
    return r.json();
  }
  // Notable observations for a whole eBird REGION (a country / subnational code, e.g. "NO",
  // "US", "US-CA") rather than a geo radius — used by the "whole-country rarity alerts" option.
  async function fetchEbirdNotableRegion(region, tok, back, sppLocale, signal) {
    if (!tok) throw new Error("eBird: no API key");
    if (!region) return [];
    var bk = Math.max(1, Math.min(30, +back || 7));
    var url = joinUrl("https://api.ebird.org/v2/data/obs/" + encodeURIComponent(region) + "/recent/notable",
      "back=" + bk + "&detail=full&maxResults=1000" + (sppLocale ? "&sppLocale=" + encodeURIComponent(sppLocale) : ""));
    var r = await fetchRetry(url, { headers: { "X-eBirdApiToken": tok } }, signal);
    if (!r) { if (signal && signal.aborted) return []; throw new Error("eBird unreachable"); }
    if (!r.ok) { var err = new Error("eBird HTTP " + r.status); err.status = r.status; throw err; }
    return r.json();
  }
  // The geo/recent feed has no observer name. Fetch each DISTINCT checklist
  // (subId) once for its userDisplayName and attach it, so eBird records can be
  // filtered by observer like the other sources. Concurrency-limited, abort-aware
  // (the fetch timeout can cut it; the observations themselves are kept), capped
  // so a hotspot can't trigger thousands of lookups. Responses are SW-cached.
  var EBIRD_CHECKLIST_CAP = 150;
  async function ebirdEnrichObservers(obs, tok, geoEp, signal) {
    if (!Array.isArray(obs) || !obs.length) return;
    var apiBase = String(geoEp).replace(/\/v2\/.*$/, "/v2/");   // share the host with the geo endpoint
    var seen = Object.create(null), ids = [];
    obs.forEach(function (o) { if (o && o.subId && !seen[o.subId]) { seen[o.subId] = 1; ids.push(o.subId); } });
    ids = ids.slice(0, EBIRD_CHECKLIST_CAP);   // newest-first; cap the lookups
    var map = Object.create(null), cmt = Object.create(null), next = 0;
    async function worker() {
      while (next < ids.length) {
        if (signal && signal.aborted) return;
        var id = ids[next++];
        try {
          var rr = await fetch(apiBase + "product/checklist/view/" + encodeURIComponent(id), { headers: { "X-eBirdApiToken": tok }, signal: signal });
          if (rr.ok) {
            var j = await rr.json();
            if (j && j.userDisplayName) {
              // eBird returns the pseudonym + the real name (e.g. "Anonymous
              // eBirder Bastian Achenbach"); show the real name when one follows.
              var nm = String(j.userDisplayName).trim();
              var real = nm.replace(/^Anonymous eBirder\b\s*/i, "").trim();
              map[id] = real || nm;
            }
            // Per-species observer comment — eBird's note equivalent, absent from the
            // geo/recent feed but present here (the call we already make for the name).
            if (j && Array.isArray(j.obs)) {
              j.obs.forEach(function (ob) {
                if (!ob || !ob.speciesCode) return;
                var c = ob.comments || ob.comment || "";
                if (c) cmt[id + "|" + ob.speciesCode] = String(c);
              });
            }
          }
        } catch (e) { if (signal && signal.aborted) return; }   // a single failed/aborted lookup just leaves that checklist unnamed
      }
    }
    var pool = []; for (var w = 0; w < 8; w++) pool.push(worker());
    await Promise.all(pool);
    obs.forEach(function (o) {
      if (!o || !o.subId) return;
      if (map[o.subId]) o.userDisplayName = map[o.subId];
      if (o.speciesCode) { var c = cmt[o.subId + "|" + o.speciesCode]; if (c) o.comments = c; }
    });
  }
  // Lat/lon → EPSG:3857 (web-mercator) metres, for Artskart's WKT polygon filter.
  function toMercator(lat, lon) {
    var R = 20037508.34;
    return [lon * R / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * R / 180];
  }
  // "YYYY-MM-DD" date arithmetic (UTC) for slicing the Artskart query window.
  function dAdd(s, n) { return new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10); }
  function dDiff(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
  // Norway — Artskart public API (no key; aggregates Artsobservasjoner + others).
  // Geo filter is a WKT polygon in web-mercator metres around the point.
  // The API ignores MaxFeatures (20/page default), Offset doesn't page, and it
  // returns records OLDEST-FIRST with no sort option — so a single PageSize query
  // over a dense/wide area returns only the oldest rows and misses everything
  // recent near the centre. So: probe once for the total, and if it's truncated,
  // re-fetch the MOST RECENT records in date slices sized to fit under the cap.
  async function fetchArtsobsAll(lat, lon, d1, d2, rkm, ep, signal) {
    var dLat = rkm / 111, dLon = rkm / ((111 * Math.cos(lat * Math.PI / 180)) || 1);
    var pts = [toMercator(lat - dLat, lon - dLon), toMercator(lat - dLat, lon + dLon), toMercator(lat + dLat, lon + dLon), toMercator(lat + dLat, lon - dLon)];
    pts.push(pts[0]);
    var wkt = "POLYGON((" + pts.map(function (p) { return p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(",") + "))";
    var endpoint = ep || "https://artskart.artsdatabanken.no/publicapi/api/observations/list";
    var PAGE = 8000, BUDGET = 3;   // BUDGET recent slices ≈ the most recent (BUDGET × sliceDays) days
    // Returns the parsed body, or null on a non-OK/failed request (retried within
    // fetchRetry). The recent-slice fetches tolerate a null (keep partial); the
    // probe below treats null as a hard failure so a down source is flagged.
    function q(from, to, ps) {
      var url = joinUrl(endpoint, "PageSize=" + ps + "&FromDate=" + from + "&ToDate=" + to + "&gmWktPolygon=" + encodeURIComponent(wkt));
      return fetchRetry(url, null, signal).then(function (r) { return r && r.ok ? r.json().catch(function () { return null; }) : null; });
    }
    // Cheap probe (just the count) → how dense is this window?
    var probe = await q(d1, d2, 50);
    if (!probe) { if (signal && signal.aborted) return { Observations: [] }; throw new Error("Artsobservasjoner unreachable"); }
    var total = +probe.TotalCount || 0;
    if (total <= PAGE) { noteTrunc("artsobs", null); var one = await q(d1, d2, PAGE); return { Observations: (one && one.Observations) || [] }; }   // small enough — one page has it all
    // Truncated → fetch the MOST RECENT records as date slices sized to fit under
    // the cap, queried in parallel (newest first). At a wide/dense radius this
    // covers fewer days but gives the recent observations near the centre that an
    // oldest-first single page would drop.
    var sliceDays = Math.max(1, Math.floor(PAGE / (total / Math.max(1, dDiff(d1, d2))) * 0.8));
    var ranges = [], to = d2;
    for (var i = 0; i < BUDGET; i++) {
      var from = dAdd(to, -(sliceDays - 1));
      if (dDiff(d1, from) < 0) from = d1;
      ranges.push([from, to]);
      if (dDiff(d1, from) <= 0) break;
      to = dAdd(from, -1);
    }
    var parts = await Promise.all(ranges.map(function (r) { return q(r[0], r[1], PAGE); }));
    var seen = Object.create(null), all = [];
    parts.forEach(function (j) { ((j && j.Observations) || []).forEach(function (o) { var id = o.Id; if (id) { if (seen[id]) return; seen[id] = 1; } all.push(o); }); });
    // Diagnostics: the probe said `total` records exist but the recent-slice budget
    // fetched fewer — a dense/wide area only got its most recent days.
    noteTrunc("artsobs", all.length < total ? { kept: all.length, total: total } : null);
    return { Observations: all };
  }
  // Sweden — SLU Artdatabanken SOS API (free subscription key; Artportalen + more).
  async function fetchArtportalenAll(lat, lon, d1, d2, rkm, key, ep, signal) {
    var body = { geographics: { geometries: [{ type: "point", coordinates: [lon, lat] }], maxDistanceFromPoint: Math.round(rkm * 1000) },
      date: { startDate: d1, endDate: d2, dateFilterType: "OverlappingStartDateAndEndDate" }, output: { fieldSet: "Extended" } };
    var endpoint = ep || "https://api.artdatabanken.se/species-observation-system/v1/Observations/Search";
    var post = { method: "POST", headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": key }, body: JSON.stringify(body) };
    var all = [];
    for (var p = 0; p < 6; p++) {
      if (signal && signal.aborted) break;   // fetch timeout → keep the pages we have
      var resp = await fetchRetry(joinUrl(endpoint, "skip=" + (p * 300) + "&take=300"), post, signal);
      if (!resp || !resp.ok) {
        if (p === 0 && !(signal && signal.aborted)) throw new Error("Artportalen " + (resp ? "HTTP " + resp.status : "unreachable"));
        break;   // a later page failed (or aborted) → keep what we have
      }
      var recs = ((await resp.json().catch(function () { return null; })) || {}).records || [];
      all = all.concat(recs);
      if (recs.length < 300) break;
    }
    noteTrunc("artportalen", all.length >= 1800 ? { cap: true, kept: all.length } : null);   // 6-page budget filled → likely truncated
    return all;
  }
  // Source record normalisers (inatLatLon/normEbird/normInat/normGbif/
  // artsobsUrl/normArtsobs/normArtportalen) moved to the AppNormalize module
  // (docs/normalize.js); the raw HTTP fetch adapters above still live here.
  // Finland — FinBIF / Laji.fi data warehouse (api.laji.fi). Keyed: a free
  // personal access_token. GeoJSON output (coords from the feature geometry);
  // filtered by a WGS84 bounding box + a date range. Field paths are the valid
  // warehouse "selected" fields (verified against FinBIF's own tooling).
  var LAJI_FIELDS = "unit.linkings.taxon.scientificName,unit.linkings.taxon.nameEnglish,unit.linkings.taxon.nameFinnish,unit.interpretations.individualCount,gathering.displayDateTime,gathering.locality,gathering.interpretations.municipalityDisplayname,gathering.interpretations.coordinateAccuracy,document.documentId,unit.linkings.taxon.kingdomScientificName,unit.linkings.taxon.informalTaxonGroups,unit.notes,gathering.notes";
  async function fetchLajiAll(lat, lon, d1, d2, rkm, key, ep, signal) {
    if (!key) throw new Error("Laji.fi: no API key");   // surfaced as a failed source
    var dLat = rkm / 111.32, cos = Math.cos(lat * Math.PI / 180);
    var dLon = rkm / (111.32 * (cos > 0.01 ? cos : 0.01));
    var box = (lat - dLat).toFixed(4) + ":" + (lat + dLat).toFixed(4) + ":" + (lon - dLon).toFixed(4) + ":" + (lon + dLon).toFixed(4) + ":WGS84";
    var base = (ep || "https://api.laji.fi/v0/warehouse/query/unit/list") +
      "?format=geojson&featureType=CENTER_POINT&crs=WGS84" +
      "&selected=" + encodeURIComponent(LAJI_FIELDS) +
      "&wgs84CenterPoint=" + encodeURIComponent(box) +   // latMin:latMax:lonMin:lonMax:WGS84
      "&time=" + encodeURIComponent(d1 + "/" + d2) +
      "&pageSize=1000&access_token=" + encodeURIComponent(key);
    var all = [];
    for (var p = 1; p <= 6; p++) {
      if (signal && signal.aborted) break;   // fetch timeout → keep the pages we have
      var resp = await fetchRetry(base + "&page=" + p, null, signal);
      if (!resp || !resp.ok) {
        if (p === 1 && !(signal && signal.aborted)) throw new Error("Laji.fi " + (resp ? "HTTP " + resp.status : "unreachable"));
        break;   // page 1 fails loudly (unless aborted); later pages keep partial
      }
      var res = ((await resp.json().catch(function () { return null; })) || {}).features || [];
      all = all.concat(res);
      if (res.length < 1000) break;
    }
    noteTrunc("laji", all.length >= 6000 ? { cap: true, kept: all.length } : null);   // 6-page budget filled → likely truncated
    return all;
  }
  // UK — NBN Atlas occurrences from the "Birds (BTO+partners)" data resources, which
  // is where BirdTrack records are published (~1 km grid; updated in yearly batches,
  // so it lags months — strongest for Historic-style windows). CORS-open, no key.
  var NBN_RESOURCES = "data_resource_uid:(dr528 OR dr2380 OR dr2381 OR dr2382 OR dr3162)";
  async function fetchNbnAll(lat, lon, d1, d2, rkm, ep, signal) {
    var base = (ep || "https://records-ws.nbnatlas.org/occurrences/search") +
      "?lat=" + lat.toFixed(4) + "&lon=" + lon.toFixed(4) + "&radius=" + Math.max(1, Math.round(rkm)) +
      "&fq=" + encodeURIComponent(NBN_RESOURCES) +
      "&fq=" + encodeURIComponent("occurrence_date:[" + d1 + "T00:00:00Z TO " + d2 + "T23:59:59Z]") +
      "&sort=occurrence_date&dir=desc&pageSize=300";   // newest first, so a truncated pull keeps the most recent
    var all = [], total = 0;
    for (var p = 0; p < 10; p++) {   // ≤ 3000 records per fetch
      if (signal && signal.aborted) break;
      var resp = await fetchRetry(base + "&startIndex=" + (p * 300), null, signal);
      if (!resp || !resp.ok) {
        if (p === 0 && !(signal && signal.aborted)) throw new Error("NBN Atlas " + (resp ? "HTTP " + resp.status : "unreachable"));
        break;   // later page failed/aborted → keep what we have
      }
      var j = await resp.json().catch(function () { return null; });
      var recs = (j && j.occurrences) || [];
      if (j && j.totalRecords) total = j.totalRecords;
      all = all.concat(recs);
      if (recs.length < 300) break;
    }
    noteTrunc("nbn", total > all.length ? { kept: all.length, total: total } : null);
    return all;
  }
  // BirdWeather — a global network of live BirdNET acoustic-monitoring stations.
  // GraphQL `detections` query filtered by a bounding box (ne/sw) + date period,
  // paged via the Relay cursor. No key. Returns raw detection nodes; normBirdweather
  // collapses them to one "present" record per species/station/day.
  // `confidence` is returned so normBirdweather can apply the "above threshold"
  // floor and the daily min-detection count. confidenceGte is intentionally NOT
  // sent — passing it as null returns zero rows (an API quirk), and omitting it
  // returns the full set, which we filter client-side.
  var BW_QUERY = "query($ne:InputLocation!,$sw:InputLocation!,$period:InputDuration!,$first:Int!,$after:String){" +
    "detections(ne:$ne,sw:$sw,period:$period,first:$first,after:$after){" +
    "edges{node{timestamp confidence species{scientificName commonName} coords{lat lon} station{id name}}}pageInfo{hasNextPage endCursor}}}";
  async function fetchBirdweatherAll(lat, lon, d1, d2, rkm, ep, signal) {
    var dLat = rkm / 111.32, cos = Math.cos(lat * Math.PI / 180);
    var dLon = rkm / (111.32 * (cos > 0.01 ? cos : 0.01));
    var ne = { lat: lat + dLat, lon: lon + dLon }, sw = { lat: lat - dLat, lon: lon - dLon };
    var endpoint = ep || "https://app.birdweather.com/graphql";
    var all = [], after = null;
    for (var p = 0; p < 4; p++) {   // cap pages (4 × 100) — collapsed to daily presence, so a few pages suffice and keep it fast
      if (signal && signal.aborted) break;
      var vars = { ne: ne, sw: sw, period: { from: d1, to: d2 }, first: 100, after: after };
      var resp = await fetchRetry(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: BW_QUERY, variables: vars }) }, signal);
      if (!resp || !resp.ok) { if (p === 0 && !(signal && signal.aborted)) throw new Error("BirdWeather " + (resp ? "HTTP " + resp.status : "unreachable")); break; }
      var j = await resp.json().catch(function () { return null; });
      var conn = j && j.data && j.data.detections;
      // GraphQL reports schema/validation errors as HTTP 200 + an `errors` array —
      // surface that on page 1 so a query mismatch is flagged, not silently empty.
      if (!conn) { if (p === 0 && !(signal && signal.aborted) && j && j.errors && j.errors[0]) throw new Error("BirdWeather: " + (j.errors[0].message || "query error")); break; }
      var edges = conn.edges || [];
      for (var e = 0; e < edges.length; e++) if (edges[e] && edges[e].node) all.push(edges[e].node);
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !edges.length) break;
      after = conn.pageInfo.endCursor;
    }
    return all;
  }


  // Shared single-fetch-with-timeout: create an AbortController, abort after `ms`, clear the
  // timer on settle, and propagate the result/error (an AbortError on timeout). Replaces the
  // hand-rolled ctrl+setTimeout(abort)+clearTimeout idiom at the simple single-fetch call sites.
  // (NOT for the retry core, paged loops, or callers that keep an external/reused controller.)
  function fetchWithTimeout(url, opts, ms) {
    var o = {}, k; opts = opts || {};
    for (k in opts) o[k] = opts[k];
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms || 15000) : null;
    if (ctrl) o.signal = ctrl.signal;
    function clear() { if (to) { clearTimeout(to); to = null; } }
    return fetch(url, o).then(function (r) { clear(); return r; }, function (e) { clear(); throw e; });
  }

  return {
    init: init,
    takeTrunc: takeTrunc,
    fetchWithTimeout: fetchWithTimeout,
    gbifGeometry: gbifGeometry,
    gbifPage: gbifPage,
    fetchGbifAll: fetchGbifAll,
    gbifCount: gbifCount,
    fetchGbifHistoric: fetchGbifHistoric,
    fetchInatAll: fetchInatAll,
    fetchEbirdAll: fetchEbirdAll,
    fetchEbirdNotable: fetchEbirdNotable,
    fetchEbirdNotableRegion: fetchEbirdNotableRegion,
    fetchArtsobsAll: fetchArtsobsAll,
    fetchArtportalenAll: fetchArtportalenAll,
    fetchLajiAll: fetchLajiAll,
    fetchNbnAll: fetchNbnAll,
    fetchBirdweatherAll: fetchBirdweatherAll,
  };
})();
