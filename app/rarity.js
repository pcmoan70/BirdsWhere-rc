/**
 * eBird rarity alerts — the standing "notable sightings" subscription.
 *
 * Lifted out of app.js byte-for-byte (v1262): the poll loop, the session feed,
 * the persisted rarity list, the bell badge, the ★ map layers, the alert panel,
 * the chirp and the system notification. app.js still owns the map, the
 * detections and the settings UI, and injects what this module needs through
 * init() — the injected names are the SAME identifiers the code used inside the
 * monolith, so the bodies below are unchanged.
 *
 * Exposed as window.AppRarity (no module system; loaded via <script>).
 */
window.AppRarity = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var detIsRare, detName, ebirdKey, escapeHtml, fmtDate, getHereFix, getStoredLocations,
      hereAsLoc, hereCfg, hideDetHover, holdDelay, ico, llFromAttrs, onDetMarkerClick,
      recentRadiusKm, safeHref, setStatus, setTabAlert, showDetHover, spDetailTableHtml,
      spListDot, speciesColor, t, wireLocHover, wireSpDetail, rarityScoreProbs, onRarityListChanged,
      rarityFetchSources, abortRaritySweep, userFetchActive, speciesName,
      rarityPageEl, openRarityPage, closeRarityPage, appErrLog;
  // … and getters for app state that is reassigned after load (the map is built
  // long after this file runs; the language and the two lookup tables change).
  var getMap, getLang, getShowSci, getDetPlot, getLabelsByKey;

  function init(ctx) {
    detIsRare = ctx.detIsRare; detName = ctx.detName;
    ebirdKey = ctx.ebirdKey; escapeHtml = ctx.escapeHtml; fmtDate = ctx.fmtDate; getHereFix = ctx.getHereFix;
    getStoredLocations = ctx.getStoredLocations; hereAsLoc = ctx.hereAsLoc; hereCfg = ctx.hereCfg;
    hideDetHover = ctx.hideDetHover; holdDelay = ctx.holdDelay; ico = ctx.ico;
    llFromAttrs = ctx.llFromAttrs; onDetMarkerClick = ctx.onDetMarkerClick;
    recentRadiusKm = ctx.recentRadiusKm; safeHref = ctx.safeHref; setStatus = ctx.setStatus;
    setTabAlert = ctx.setTabAlert; showDetHover = ctx.showDetHover;
    spDetailTableHtml = ctx.spDetailTableHtml; spListDot = ctx.spListDot;
    speciesColor = ctx.speciesColor; t = ctx.t; wireLocHover = ctx.wireLocHover;
    wireSpDetail = ctx.wireSpDetail; rarityScoreProbs = ctx.rarityScoreProbs;
    onRarityListChanged = ctx.onRarityListChanged;
    rarityFetchSources = ctx.rarityFetchSources; abortRaritySweep = ctx.abortRaritySweep; userFetchActive = ctx.userFetchActive;
    speciesName = ctx.speciesName;
    rarityPageEl = ctx.rarityPageEl; openRarityPage = ctx.openRarityPage; closeRarityPage = ctx.closeRarityPage;
    appErrLog = ctx.appErrLog;
    getMap = ctx.getMap; getLang = ctx.getLang; getShowSci = ctx.getShowSci;
    getDetPlot = ctx.getDetPlot; getLabelsByKey = ctx.getLabelsByKey;
  }

  // ---- eBird rarity alerts ---------------------------------------------------
  // Standing subscription: while the app/tab is open, poll eBird's "notable"
  // (regionally-flagged rarities) feed around every stored location with the 🔔
  // flag. A never-seen-before record lands as a pulsing ★ on the map, a bell
  // badge in the header, an alarm chirp and (opt-in) a system notification.
  // No backend — polling stops when the tab is gone; the persisted seen-set
  // makes sure nothing re-alerts across reloads. First poll of a location seeds
  // the seen-set silently so subscribing never triggers an alarm storm.
  var RARITY_BACK_DAYS = 7;        // lookback per poll — catches late-submitted checklists
  var RARITY_SEEN_MAX_MS = 30 * 86400000;   // eBird's max "back" — older ids can never reappear
  var RARITY_SEEN_CAP = 4000;   // shared by eBird-notable ids AND local low-probability detection ids
  var RARITY_NOTIF_CAP = 8;        // > this many new in one cycle → one summary notification
  var RARITY_FEED_CAP = 100;
  // eBird sppLocale per UI language (localized common names straight from the API).
  var EBIRD_SPP_LOCALE = { en: "en", sv: "sv", de: "de", es: "es", fr: "fr", nl: "nl", no: "no",
    it: "it", pl: "pl", cs: "cs", et: "et", lt: "lt", fi: "fi", da: "da", pt: "pt_PT" };
  function rarityCfg() {
    var c = window.GeoState.get("rarityAlerts", null) || {};
    if (c.enabled == null) c.enabled = true;   // master on/off (toggle in the bell popup)
    // intervalMin 0 = MANUAL: no automatic checks; long-press the bell (or ↻ in
    // the pane) fetches the latest alerts on demand.
    if (!isFinite(+c.intervalMin) || (+c.intervalMin !== 0 && +c.intervalMin < 10)) c.intervalMin = 10;   // 10 min = fastest auto interval (5-min option removed); 0 = manual
    // THE single rarity model-probability threshold (%): a bird counts as a rarity when the model's
    // probability at its own location + found-week is BELOW this. Governs both the local-fetch harvest
    // (obs below it join the list) AND the eBird-notable gate (alerts above it are discarded). 100 = off.
    if (!isFinite(+c.probPct)) c.probPct = 15;
    if (!isFinite(+c.showDays) || +c.showDays < 0) c.showDays = 7;   // display window: 0 = Today, else last N days
    if (c.showMap == null) c.showMap = true;   // rarity records plotted on the map as ordinary (filtered) dots
    if (c.countryWide == null) c.countryWide = false;   // fetch notable for each point's WHOLE COUNTRY, not just its radius
    // Also sweep the ORDINARY observation sources (GBIF / iNaturalist / the national
    // portals / eBird / BirdWeather) around each 🔔 location and alert on anything the
    // model finds unlikely there — eBird's notable feed only covers what eBird itself flags.
    if (c.allSources == null) c.allSources = true;
    // Email delivery: the address the alerts are mailed to (empty = off) and when the
    // last message went out (the send is rate-limited).
    if (typeof c.email !== "string") c.email = "";
    if (!isFinite(+c.lastEmail)) c.lastEmail = 0;
    if (typeof c.emailState !== "string") c.emailState = "";   // "" | "ok" | "activate" | "fail" — what became of the last message
    if (typeof c.emailKind !== "string") c.emailKind = "";     // "test" | "alert" — which kind it was
    if (!isFinite(+c.emailCount)) c.emailCount = 0;            // how many alerts the last message carried
    if (!isFinite(+c.emailAt)) c.emailAt = 0;
    if (c.sound == null) c.sound = true;
    if (c.sysNotif == null) c.sysNotif = false;
    if (!c.seen) c.seen = {};
    if (!c.seeded) c.seeded = {};
    if (!isFinite(+c.lastPoll)) c.lastPoll = 0;
    return c;
  }
  function raritySave(patch) { var c = rarityCfg(); for (var k in patch) c[k] = patch[k]; window.GeoState.save({ rarityAlerts: c }); return c; }
  function rarityCountryWide() { return rarityCfg().countryWide === true; }
  function rarityAllSources() { return rarityCfg().allSources !== false && typeof rarityFetchSources === "function"; }
  // Upper model-probability gate (%): a rarity alert whose model probability at its
  // OWN point and found-week is above this is discarded (the model thinks the bird is
  // common there, so it isn't really rare). 100 = gate off.
  function rarityProbMaxPct() { var v = +rarityCfg().probPct; return isFinite(v) ? v : 15; }   // the single rarity threshold (was a separate probMaxPct; unified onto probPct)
  // ONE answer to "is this rare enough", for all four places that used to decide it
  // themselves (the eBird gate, the all-sources sweep, the harvest from your own
  // fetches, and the display filter). 0 and 100 both mean OFF, as the Settings hint
  // says — before this, 100 switched three of them off and let the fourth ingest
  // every fetched observation.
  function rarityThOn() { var th = rarityProbMaxPct(); return th > 0 && th < 100; }
  function rarityIsRareProb(p) {   // p = 0..1 model probability at the record's own point/week
    return rarityThOn() && isFinite(p) && p >= 0 && p * 100 < rarityProbMaxPct();
  }
  function rarityProbPasses(pct) {   // pct = 0..100 already-scored value; null/unscored always passes
    return !rarityThOn() || pct == null || !isFinite(+pct) || +pct < rarityProbMaxPct();
  }
  function rarityLocs() {
    var a = getStoredLocations().filter(function (l) { return l.alert && isFinite(+l.lat) && isFinite(+l.lon); });
    // 🔔 on the built-in Here row: a placeholder without coordinates — the poll
    // loop resolves the GPS fix when it reaches it.
    if (hereCfg().alert) a.unshift({ here: true, name: t("loc.here") });
    return a;
  }
  // "Check here now" with nothing subscribed: the place you are looking at, at the
  // usual radius. A deliberate check should never be a dead button — but it is not a
  // subscription either, so its seed key is cleaned up by finish()'s prune like any
  // other location that carries no 🔔.
  function rarityViewLoc() {
    var m = getMap(); if (!m || !m.getCenter) return null;
    var c = m.getCenter(); if (!c || !isFinite(+c.lat) || !isFinite(+c.lng)) return null;
    return { lat: +c.lat, lon: +c.lng, name: "", radius: recentRadiusKm() };
  }
  // One stable seen/seeded key per location. Here uses a FIXED key on purpose:
  // moving somewhere new should alert on that area's rarities, not re-seed.
  function rarityLocKey(l) { return l.here ? "here" : (+l.lat).toFixed(4) + "," + (+l.lon).toFixed(4); }
  // Stable record identity for the seen-set. detail=full always carries obsId;
  // the fallbacks are belt-and-braces against API shape drift.
  function rarityId(o) {
    if (!o) return "";
    return o.obsId || (o.subId && o.speciesCode ? o.subId + "|" + o.speciesCode : "") ||
      (o.speciesCode ? o.speciesCode + "|" + (o.obsDt || "") + "|" + o.lat + "," + o.lng : "");
  }
  var rarityTimer = null, rarityPollBusy = false, rarityChangedTm = null;
  var rarityPollRemain = 0;        // 🔔 locations still to fetch in the running cycle (bell subscript)
  var rarityPanelRefresh = null;   // re-render hook for the open bell popup (cleared on close)
  var rarityBadKey = null;         // the key value that last got a 401/403 — retried only after it changes
  var rarityFeed = [];             // session-only alert list, newest first: {id,name,sci,dt,place,observer,count,url,lat,lon,area,marker}
  var rarityUnread = 0;
  var rarityLayer = null;
  // ---- Persisted rarity list (localStorage via GeoState) --------------------
  // Grouped SPECIES × LOCATION (~1 km cells): every notable eBird record AND every
  // fetched detection whose model probability is under the threshold lands here
  // once (the seen-set dedupes records across polls/fetches). Each group keeps its
  // LAST-seen date/place/link and a record tally; kept 30 days (eBird's max
  // lookback), capped at 500 groups. The bell popup renders from this store.
  var RARITY_LIST_CAP = 500;     // species×location groups kept
  var RARITY_RECS_CAP = 15;      // individual records kept per group (expand view)
  function rarityGroupKey(sci, lat, lon) {
    return String(sci || "").toLowerCase() + "|" + (+lat).toFixed(2) + "," + (+lon).toFixed(2);
  }
  function getRarityList() { return window.GeoState.get("rarityList", []) || []; }
  function rarityListUpsert(items) {
    if (!items || !items.length) return;
    var a = getRarityList(), byK = Object.create(null);
    a.forEach(function (e, i) { byK[e.k] = i; });
    items.forEach(function (it) {
      var rec = { id: it.rid || "", dt: it.dt || "", observer: it.observer || "", count: it.count != null ? it.count : "",
        note: String(it.note || "").slice(0, 300), url: it.url || "", src: it.rsrc || "",
        why: it.why || "", prob: it.recProb != null ? it.recProb : null };   // why: "ebird" (notable report) | "prob" (model threshold)
      // The record's OWN spot: group entries only carry the newest record's
      // coordinates, but records in the same species×~1 km group can sit hundreds
      // of metres apart — near-a-point views need the exact position.
      if (isFinite(+it.lat) && isFinite(+it.lon)) { rec.lat = +it.lat; rec.lon = +it.lon; }
      // The observer's own photo + the species' red-list code, when the source reports
      // them — the pane's record table shows the same 📷 and tag as the species lists.
      if (it.photo) { rec.photo = it.photo; if (it.photoBig) rec.photoBig = it.photoBig; if (it.photoBy) rec.photoBy = it.photoBy; }
      if (it.rl) rec.rl = it.rl;
      if (it.fresh) rec.at = Date.now();   // fresh live alert → "alert received" time (shown in ⓘ)
      var i = byK[it.k], e;
      if (i == null) {
        e = { k: it.k, sci: it.sci, name: it.name, dt: it.dt || "", place: it.place || "",
          lat: it.lat, lon: it.lon, area: it.area || "", src: it.src, prob: it.prob != null ? it.prob : null,
          n: 0, recs: [] };
        byK[it.k] = a.length; a.push(e);
      } else e = a[i];
      e.recs = e.recs || [];
      // Same record re-offered by a later poll → no-op (match by record id, with a
      // dt+observer+count fallback for entries stored before ids existed).
      var known = e.recs.some(function (r) {
        return (rec.id && r.id === rec.id) ||
          (!r.id && r.dt === rec.dt && r.observer === rec.observer && String(r.count) === String(rec.count));
      });
      if (!known) {
        e.n = (e.n || 0) + 1;
        delete e.dismissed;   // fresh activity revives a dismissed group
        e.recs.push(rec);
        e.recs.sort(function (x, y) { return String(y.dt || "").localeCompare(String(x.dt || "")); });
        if (e.recs.length > RARITY_RECS_CAP) e.recs.length = RARITY_RECS_CAP;
        if (String(it.dt || "") >= String(e.dt || "")) {   // newest record's details represent the group
          e.dt = it.dt; e.lat = it.lat; e.lon = it.lon;
          if (it.place) e.place = it.place;
          if (it.url) e.url = it.url;
        }
      }
      if (it.prob != null && (e.prob == null || it.prob < e.prob)) e.prob = it.prob;
      if (it.area && !e.area) e.area = it.area;
      if (it.src === "ebird") e.src = "ebird";   // eBird-notable beats "local" as the group's badge
    });
    var cut = Date.now() - 30 * 86400000;
    a = a.filter(function (e) {
      var ts = Date.parse(String(e.dt || "").replace(" ", "T"));
      return !isFinite(ts) || ts >= cut;
    });
    a.sort(function (x, y) { return String(y.dt || "").localeCompare(String(x.dt || "")); });
    if (a.length > RARITY_LIST_CAP) a = a.slice(0, RARITY_LIST_CAP);
    window.GeoState.save({ rarityList: a });
    // A quota-failed write keeps nothing: say so once instead of letting the list
    // quietly vanish on the next reload. (The trim ladder in app.js shrinks the list
    // first, so reaching this means storage is full even after that.)
    if (window.GeoState.lastSaveOk && !window.GeoState.lastSaveOk() && typeof appErrLog === "function")
      appErrLog("rarity list not saved: storage full (" + a.length + " groups)");
    pruneRarityFeed();   // the 30-day prune / group cap above can retire a group the map still blinks for
    updateRarityBell();  // a list that just gained (or lost) entries decides whether the bell shows at all
    if (typeof onRarityListChanged === "function") { try { onRarityListChanged(); } catch (e) {} }   // refresh legend/map so alert species surface as list rows
  }
  // Drop the fetch-derived LOCAL rarities (harvested low-probability detections, src
  // "local") — called when the map's fetched detections are cleared, so they don't
  // outlive their source and keep showing in the legend/lists/map. Genuine eBird
  // notable alerts (src "ebird") are kept. Returns true if anything was removed.
  // The live-alert markers are SESSION state while the list is persisted, so dropping
  // groups from the list has to take their blinking dots with it — otherwise the map keeps
  // offering alerts that exist nowhere any more, and clicking one opens an empty window.
  function pruneRarityFeed() {
    var live = Object.create(null), dropped = 0;
    getRarityList().forEach(function (e) { live[e.k] = 1; });
    for (var i = rarityFeed.length - 1; i >= 0; i--) {
      var f = rarityFeed[i];
      if (live[rarityGroupKey(f.sci, f.lat, f.lon)]) continue;
      if (f.marker && rarityLayer) rarityLayer.removeLayer(f.marker);
      if (f.unread) rarityUnread = Math.max(0, rarityUnread - 1);
      rarityFeed.splice(i, 1); dropped++;
    }
    if (dropped) updateRarityBell();
    return dropped;
  }
  function clearLocalRarities() {
    var a = getRarityList();
    if (!a.length) return false;
    var keep = a.filter(function (e) { return e.src === "ebird"; });
    if (keep.length === a.length) return false;   // nothing local to drop
    window.GeoState.save({ rarityList: keep });
    rarityPlotList();     // refresh the pulsing rarity dots to match
    pruneRarityFeed();    // …and the live markers of the groups that just went
    return true;
  }
  // Dismiss one rarity group (the red ✕ in a rarity-opened window): mark it seen
  // and keep its dot off the map. A NEW record arriving later un-dismisses it.
  var rarityDismissTarget = null;   // group key behind the currently-open rarity window
  function rarityDismiss(k) {
    if (!k) return;
    var a = getRarityList(), hit = false;
    a.forEach(function (x) { if (x.k === k) { x.dismissed = 1; hit = true; } });
    if (hit) window.GeoState.save({ rarityList: a });
    // Drop this group's live-alert markers + their unread count.
    var removed = 0;
    for (var i = rarityFeed.length - 1; i >= 0; i--) {
      var f = rarityFeed[i];
      if (rarityGroupKey(f.sci, f.lat, f.lon) === k) {
        if (f.marker && rarityLayer) rarityLayer.removeLayer(f.marker);
        rarityFeed.splice(i, 1); removed++;
      }
    }
    rarityUnread = Math.max(0, rarityUnread - removed);
    rarityPlotList();
    updateRarityBell();
  }
  // Model species-code for a rarity's scientific name (via the aggregate layer's
  // sci index) — gives the ordinary species colour, swatch and species menu.
  function rarityModelKey(sci) {
    try {
      var idx = window.AppAggregate.ensureSciIndex();
      var lbl = idx && idx[String(sci || "").toLowerCase()];
      return (lbl && lbl.key) || "";
    } catch (e) { return ""; }
  }
  // Display-window start: showDays 0 = "Today" (records dated the local calendar
  // day), else the last N×24h. Shared by the pane, the map layer and near-a-point.
  function rarityCutTs(cfg) {
    if (+cfg.showDays === 0) { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    return Date.now() - cfg.showDays * 86400000;
  }
  // Does this group count RIGHT NOW: not dismissed, still inside the display window,
  // still under the threshold, and placeable on the map. The map rows, the alerts page
  // and the bell's unread count all ask this one question, so they cannot disagree.
  // (`keepDismissed`: the alerts page lists ✕-dismissed groups dimmed rather than
  // hiding them, so it asks the same question with that one clause relaxed.)
  function rarityGroupVisible(e, cfg, keepDismissed) {
    if (!e || (e.dismissed && !keepDismissed)) return false;
    if (!rarityProbPasses(e.prob)) return false;
    var ts = Date.parse(String(e.dt || "").replace(" ", "T"));
    if (!isFinite(ts) || ts < rarityCutTs(cfg || rarityCfg())) return false;
    return isFinite(+e.lat);
  }
  // Why a record is in the rarity list — shown per detection in the ⓘ details:
  // eBird's notable-sightings report, or the model-probability threshold.
  function rarityWhy(e, r) {
    if (r.why === "prob" || (!r.why && e.src !== "ebird"))
      return t("rarity.whyProb", { p: (r.prob != null ? r.prob : (e.prob != null ? e.prob : "?")), th: rarityCfg().probPct });
    return t("rarity.whyEbird");
  }
  // "HH:MM" from a record's observation timestamp — eBird's obsDt carries the
  // checklist time when the observer logged one ("YYYY-MM-DD HH:MM"); date-only otherwise.
  function rarityRecTime(r) {
    var s = String((r && r.dt) || "");
    return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) ? s.slice(11, 16) : "";
  }
  function rarityFmtTs(ms) {
    var d = new Date(+ms);
    if (!isFinite(d.getTime())) return "";
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return fmtDate(d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate())) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
  }
  function rarityNoteWith(e, r) {
    var head = [rarityWhy(e, r)];
    var tm = rarityRecTime(r);
    if (tm) head.push(t("rarity.timeObs", { t: fmtDate(String(r.dt).slice(0, 10)) + " " + tm }));
    if (r.at) head.push(t("rarity.timeReg", { t: rarityFmtTs(r.at) }));   // when the app first received the alert (eBird's API has no submission time)
    var note = String(r.note || "").trim();
    return note ? head.join("\n") + "\n\n" + note : head.join("\n");
  }
  // Rarity records near a point, in the detection-row shape — feeds the shared
  // hover tooltip and co-located detections window via collectVisibleDetections.
  function rarityNearRows(near) {
    var out = [];
    if (!getMap()) return out;
    var cfg = rarityCfg();
    var dLat = 0, dLon = 0;
    if (near) {
      dLat = near.meters / 111320;
      var cs = Math.cos(near.lat * Math.PI / 180);
      dLon = near.meters / (111320 * (Math.abs(cs) > 1e-6 ? Math.abs(cs) : 1e-6));
    }
    getRarityList().forEach(function (e) {
      // Clicking a rarity ★ passes its group key along — that group ALWAYS shows,
      // even when the star sits away from the group's stored (newest-record)
      // coordinates or its date just left the display window.
      var keyMatch = !!(near && near.rarityKey && near.rarityKey === e.k);
      if (!keyMatch && !rarityGroupVisible(e, cfg)) return;   // dismissed · above threshold · outside the window · unplaceable
      var key = rarityModelKey(e.sci) || ("x:" + (e.sci || e.name));
      var color = speciesColor(key);
      (e.recs || []).forEach(function (r) {
        // Each record at its own spot when stored (newer entries), else at the
        // group's coordinates (older cached entries).
        var rl = (r.lat != null && isFinite(+r.lat)) ? +r.lat : +e.lat;
        var rlon = (r.lon != null && isFinite(+r.lon)) ? +r.lon : +e.lon;
        if (near && !keyMatch) {
          if (Math.abs(rl - near.lat) > dLat || Math.abs(rlon - near.lon) > dLon) return;
          if (getMap().distance(L.latLng(near.lat, near.lon), L.latLng(rl, rlon)) > near.meters) return;
        }
        out.push({ key: key, name: e.name || e.sci, color: color, lat: rl, lon: rlon, rarity: true,
          date: String(r.dt || "").slice(0, 10), time: rarityRecTime(r), src: r.src || (e.src === "ebird" ? "eBird" : ""), origin: "",
          url: r.url || "", place: e.place || "", count: r.count != null ? r.count : "", act: "",
          note: rarityNoteWith(e, r), flags: "", observer: r.observer || "", listName: "", mpId: "",
          prob: e.prob != null ? e.prob / 100 : -1 });
      });
    });
    return out;
  }
  // A rarity group's records adapted to the detection-record shape, so the
  // SAME renderers as the species list (spDetailTableHtml/spRecRowHtml) apply.
  function rarityRecRows(e) {
    var key = rarityModelKey(e.sci);
    return (e.recs || []).map(function (r) {
      return { key: key, name: e.name || e.sci, prob: (e.prob != null ? e.prob / 100 : -1),
        date: String(r.dt || "").slice(0, 10), time: rarityRecTime(r), place: e.place || "", lat: e.lat, lon: e.lon,
        count: r.count != null ? r.count : "", observer: r.observer || "",
        src: r.src || (e.src === "ebird" ? "eBird" : ""), url: r.url || "", note: rarityNoteWith(e, r),
        act: "", flags: "", origin: "", color: key ? speciesColor(key) : "#888",
        photo: r.photo || "", photoBig: r.photoBig || "", photoBy: r.photoBy || "", rl: r.rl || "" };
    });
  }
  // After the per-observation probabilities land: every plotted MODEL-species
  // observation under the threshold joins the rarity list (deduped via the
  // seen-set, so refetching the same area doesn't inflate the tallies).
  function harvestLocalRarities(keys) {
    var cfg = rarityCfg();
    if (!rarityThOn()) return;
    var adds = [], changed = false;
    keys.forEach(function (k) {
      var e = getDetPlot()[k]; if (!e) return;
      // Birds only: rarity alerts are a bird feature. Model species (the only ones
      // with probabilities) are birds by construction — this guards the day other
      // classes ever gain probabilities.
      if (e.cls && String(e.cls).toLowerCase() !== "aves") return;   // taxonomy writes "aves", normalize.js "Aves"
      var lbl = getLabelsByKey()[e.key || k];
      var sci = (lbl && lbl.sci) || k;
      var name = detName(e) || e.name || sci;
      (e.rows || []).forEach(function (r) {
        // Skip the ROWS the pipeline injected (rarity alerts, shared-list imports) —
        // not the whole species, as before: one alert used to cost this species every
        // other observation the user had actually fetched. Re-harvesting an injected
        // row would mint a new id from our own output and loop.
        if (r._alert || r._list) return;
        var p = r._prob;
        if (!rarityIsRareProb(p)) return;
        if (!isFinite(+r.lat) || !isFinite(+r.lon)) return;
        // Only recent observations qualify — a historic fetch shouldn't flood the
        // 30-day rarity list (its entries would be pruned instantly anyway).
        var ts = Date.parse(String(r.date || "").slice(0, 10));
        if (!isFinite(ts) || Date.now() - ts > 30 * 86400000) return;
        var id = localRarityId(sci, r.date, r.lat, r.lon);   // same id the sweep uses — one entry either way
        if (rarityRecSeen(cfg, id, legacyRarityId(sci, r.date, r.lat, r.lon, r.observer))) return;
        cfg.seen[id] = Date.now(); changed = true;
        adds.push({ k: rarityGroupKey(sci, r.lat, r.lon), rid: id, sci: sci, name: name, dt: r.date || "",
          place: r.place || "", observer: r.observer || "", count: r.count != null ? r.count : "",
          note: r.note || "", url: r.url || "", lat: +r.lat, lon: +r.lon, area: "", src: "local",
          rsrc: r.src || "", why: "prob", recProb: Math.round(p * 1000) / 10, prob: Math.round(p * 1000) / 10,
          photo: r.photo || "", photoBig: r.photoBig || "", photoBy: r.photoBy || "", rl: r.rl || "" });
      });
    });
    if (changed) window.GeoState.save({ rarityAlerts: cfg });
    rarityListUpsert(adds);
    if (adds.length) rarityPlotList();
  }
  // ---- The ordinary-sources sweep -------------------------------------------
  // eBird's notable feed only reports what eBird itself flags, and only where eBird
  // is used. So each 🔔 location is ALSO swept through the sources a normal fetch
  // queries (GBIF / iNaturalist / the national portals / eBird / BirdWeather), and
  // anything the model finds unlikely at its own spot and week becomes an alert —
  // the same test the local harvest applies to observations the user fetched.
  //
  // It yields to the user completely: the sweep is skipped while a fetch of theirs
  // is running, aborted if one starts mid-sweep (the next cycle retries), and it
  // touches none of the fetch UI (see rarityFetchSources in app.js).
  var RARITY_SWEEP_DAYS = 7;          // the notable feed's window — recent birds only
  var RARITY_SCORE_CHUNK = 64;        // the model returns the WHOLE species vector per row: score in bounded slices
  // The pre-v1774 id (raw species + observer). Records already in the seen-set carry
  // it, so both spellings are checked before anything counts as new — changing the id
  // format must never re-announce birds the user has already been told about.
  function legacyRarityId(sci, date, lat, lon, observer) {
    return "loc|" + sci + "|" + (date || "") + "|" + (+lat).toFixed(3) + "," + (+lon).toFixed(3) + "|" + (observer || "");
  }
  function rarityRecSeen(cfg, id, legacy) { return !!(cfg.seen[id] || (legacy && cfg.seen[legacy])); }
  // The synthetic record id shared with harvestLocalRarities, so an observation the
  // user fetched and the sweep found is ONE entry, whichever arrived first.
  // One recipe, so the sweep and the harvest cannot mint two ids for one bird: the
  // species lower-cased (the two paths resolve it from different places), the date
  // alone, and the rounded spot. The OBSERVER is deliberately out — the same sighting
  // cross-posted to GBIF and a national portal carries different observer strings.
  function localRarityId(sci, date, lat, lon) {
    return "loc|" + String(sci || "").toLowerCase() + "|" + String(date || "").slice(0, 10) + "|" + (+lat).toFixed(3) + "," + (+lon).toFixed(3);
  }
  function scoreInChunks(items) {
    var out = [], i = 0;
    function step() {
      if (i >= items.length) return Promise.resolve(out);
      var slice = items.slice(i, i + RARITY_SCORE_CHUNK); i += RARITY_SCORE_CHUNK;
      return Promise.resolve(rarityScoreProbs(slice)).then(function (ps) {
        for (var j = 0; j < slice.length; j++) out.push((ps && ps[j] != null) ? ps[j] : -1);
        return step();
      }, function () { for (var j2 = 0; j2 < slice.length; j2++) out.push(-1); return step(); });
    }
    return step();
  }
  // One location's sweep: fetch → score → keep the unlikely ones → upsert.
  function sweepLoc(l, areaName, done) {
    function fin() { if (done) done(); }
    if (!rarityAllSources() || !l || !isFinite(+l.lat) || !isFinite(+l.lon)) { fin(); return; }
    if (typeof userFetchActive === "function" && userFetchActive()) { fin(); return; }   // the user is fetching — leave the network to them
    var guard = setInterval(function () {
      if (typeof userFetchActive === "function" && userFetchActive() && typeof abortRaritySweep === "function") abortRaritySweep();
    }, 1000);
    function end() { clearInterval(guard); fin(); }
    var pr;
    try { pr = rarityFetchSources(+l.lat, +l.lon, +l.radius > 0 ? +l.radius : recentRadiusKm(), RARITY_SWEEP_DAYS); }
    catch (e) { end(); return; }
    Promise.resolve(pr).then(function (recs) { ingestSweep(recs || [], "src:" + rarityLocKey(l), areaName || l.name || "", end); }, end);
  }
  // Score a sweep's records and fold the rare ones into the list (announcing the
  // new ones, unless this is the location's first sweep — then it seeds silently,
  // exactly like a first notable poll).
  function ingestSweep(recs, seedKey, areaName, done) {
    var cfg = rarityCfg(), now = Date.now();
    if (!rarityThOn() || typeof rarityScoreProbs !== "function") { if (done) done(); return; }
    var byId = Object.create(null), order = [];
    recs.forEach(function (r) {
      if (!r || !r.sciName || !isFinite(+r.lat) || !isFinite(+r.lon)) return;
      if (r.cls && String(r.cls).toLowerCase() !== "aves") return;             // rarity alerts are a bird feature
      var ts = Date.parse(String(r.date || "").slice(0, 10));
      if (!isFinite(ts) || now - ts > 30 * 86400000) return;                   // the list prunes at 30 days anyway
      var key = rarityModelKey(r.sciName); if (!key) return;                   // not a model species → no probability to judge it by
      var lbl = getLabelsByKey()[key], sci = (lbl && lbl.sci) || r.sciName;
      var id = localRarityId(sci, r.date, r.lat, r.lon);
      if (byId[id]) return;                                                    // same observation from several sources
      byId[id] = { r: r, id: id, sci: sci, legacy: legacyRarityId(sci, r.date, r.lat, r.lon, r.observer),
        name: (lbl && speciesName(lbl)) || r.comName || sci };
      order.push(id);
    });
    if (!order.length) { if (done) done(); return; }
    // Score once per (species, ~1 km spot, date) — a flock reported many times over
    // is one model question.
    var cellOf = {}, cells = [], items = [];
    order.forEach(function (id) {
      var c = byId[id], r = c.r;
      var ck = c.sci + "|" + (+r.lat).toFixed(2) + "," + (+r.lon).toFixed(2) + "|" + (r.date || "");
      if (cellOf[ck] == null) { cellOf[ck] = items.length; items.push({ sci: c.sci, lat: +r.lat, lon: +r.lon, dt: r.date }); }
      cells.push(cellOf[ck]);
    });
    scoreInChunks(items).then(function (probs) {
      var seeding = !cfg.seeded[seedKey], adds = [], fresh = [], changed = false;
      order.forEach(function (id, i) {
        var p = probs[cells[i]];
        if (!rarityIsRareProb(p)) return;                                      // the model finds it likely here → not a rarity
        var c = byId[id], r = c.r, pct = Math.round(p * 1000) / 10;
        var isNew = !rarityRecSeen(cfg, id, c.legacy);
        if (isNew) { cfg.seen[id] = Date.now(); changed = true; }
        adds.push({ fresh: isNew && !seeding, k: rarityGroupKey(c.sci, r.lat, r.lon), rid: id, sci: c.sci, name: c.name,
          dt: r.date || "", place: r.place || "", observer: r.observer || "", count: r.count != null ? r.count : "",
          note: r.note || "", url: r.url || "", lat: +r.lat, lon: +r.lon, area: areaName, src: "local", rsrc: r.src || "",
          why: "prob", recProb: pct, prob: pct,
          photo: r.photo || "", photoBig: r.photoBig || "", photoBy: r.photoBy || "", rl: r.rl || "" });
        if (isNew && !seeding) fresh.push({ area: areaName, raw: { obsId: id, sciName: c.sci, comName: c.name, lat: +r.lat, lng: +r.lon,
          obsDt: r.date || "", locName: r.place || "", userDisplayName: r.observer || "", howMany: (r.count != null ? r.count : ""),
          _url: r.url || "", _mprob: pct } });
      });
      cfg.seeded[seedKey] = 1;
      window.GeoState.save({ rarityAlerts: cfg });
      if (adds.length) { rarityListUpsert(adds); rarityPlotList(); }
      if (fresh.length) rarityAnnounce(fresh);
      if (done) done();
    }, function () { if (done) done(); });
  }
  // Chained setTimeout (drift-free after background-tab throttling); ≥5 min
  // intervals are safely above Chrome's 1/min hidden-tab timer granularity.
  function scheduleRarityPoll() {
    if (rarityTimer) { clearTimeout(rarityTimer); rarityTimer = null; }
    updateRarityBell();
    var cfg = rarityCfg();
    if (!rarityLocs().length || !cfg.enabled || !cfg.intervalMin) return;   // 0 = manual: never auto-schedule
    var delay = Math.max(15000, cfg.lastPoll + cfg.intervalMin * 60000 - Date.now());
    rarityTimer = setTimeout(runRarityPoll, delay);
  }
  function rarityPollIfOverdue() {
    if (!rarityLocs().length || rarityPollBusy) return;
    var cfg = rarityCfg();
    if (cfg.enabled && cfg.intervalMin && Date.now() - cfg.lastPoll > cfg.intervalMin * 60000) runRarityPoll();
  }
  // One poll cycle: each 🔔 location in turn (polite ~1.2 s gaps, per-location
  // abort + catch so one failure never kills the chain), then announce what's new.
  function runRarityPoll(oneOff) {
    if (rarityPollBusy) return;
    var locs = rarityLocs();
    if (!locs.length && oneOff) locs = [oneOff];   // a deliberate "check here now", no 🔔 needed
    if (!locs.length || !rarityCfg().enabled) { scheduleRarityPoll(); return; }
    var tok = ebirdKey();
    // eBird's notable feed needs a working key; the ordinary-source sweep doesn't —
    // so a poll is worth running as long as ONE of the two can deliver something.
    var ebirdOn = !!tok && tok !== rarityBadKey, sweepOn = rarityAllSources();
    if (!ebirdOn && !sweepOn) { raritySave({ lastPoll: Date.now() }); scheduleRarityPoll(); return; }
    // Offline: nothing was checked, so lastPoll must NOT move — it is what
    // rarityPollIfOverdue and scheduleRarityPoll measure from, and stamping it here
    // made reconnecting wait out a whole interval. Retry shortly; the `online` event
    // beats the timer when the connection comes back sooner.
    if (navigator.onLine === false) { clearTimeout(rarityTimer); rarityTimer = setTimeout(runRarityPoll, 60000); return; }
    rarityPollBusy = true;
    updateRarityBell();   // bell shows the fetching state (orange) for the whole cycle
    var cfg = rarityCfg(), fresh = [], listAdds = [], i = 0;
    // A cycle that never reaches finish() leaves rarityPollBusy set, and every later
    // poll returns at the top: the watch is dead until reload, bell stuck orange. Each
    // network step has its own abort, but a callback that simply never fires (the GPS
    // fix below, a wedged promise) has nothing else to catch it.
    var finished = false;
    var watchTm = setTimeout(function () { finish(); }, 60000 + locs.length * 90000);
    var countryWide = rarityCountryWide(), doneRegions = {}, locale = EBIRD_SPP_LOCALE[getLang()] || "en";
    // Fold one fetch's notable records into the persisted list + the "fresh" alert set.
    // EVERY returned record is offered on every poll — the upsert dedupes by record id and
    // backfills records marked "seen" before the list existed; alerts fire only for genuinely
    // new, post-seed records. `seedKey` scopes the first-poll "seed" (a point, or a country).
    function ingestObs(obs, seedKey, areaName) {
      var seeding = !cfg.seeded[seedKey];
      (obs || []).forEach(function (o) {
        var id = rarityId(o);
        if (!id) return;
        // A record without usable coordinates cannot be grouped, drawn or clicked:
        // (+NaN).toFixed(2) made the group key "NaN,NaN", which collected every
        // coordinate-less record of that species into one nonsense entry.
        if (!isFinite(+o.lat) || !isFinite(+o.lng)) return;
        var mp = (o._mprob != null && isFinite(o._mprob)) ? o._mprob : null;   // model prob % (own point + found-week), null when not a model species
        listAdds.push({ fresh: !cfg.seen[id] && !seeding, k: rarityGroupKey(o.sciName, o.lat, o.lng), rid: id, sci: o.sciName || "",
          name: o.comName || o.sciName || "?", dt: o.obsDt || "", place: o.locName || "",
          observer: o.userDisplayName || "", count: o.howMany != null ? o.howMany : "",
          note: o.comments || "", url: o.subId ? "https://ebird.org/checklist/" + o.subId : "",
          lat: +o.lat, lon: +o.lng, area: areaName, src: "ebird", rsrc: "eBird", why: "ebird",
          recProb: mp, prob: mp });
        if (cfg.seen[id]) return;
        cfg.seen[id] = Date.now();
        if (!seeding) fresh.push({ raw: o, area: areaName });
      });
      cfg.seeded[seedKey] = 1;
    }
    // Score each notable obs with the model (own point + found-week) and DROP the
    // ones the model finds common (prob% above the gate) before they ever reach the
    // list/alerts; the survivors carry their model prob. Gate off (≥100) or no
    // scorer → keep everything unscored. `done` runs after ingest so the poll can
    // advance to the next location.
    function handleObs(obs, seedKey, areaName, done) {
      obs = obs || [];
      if (!rarityThOn() || typeof rarityScoreProbs !== "function" || !obs.length) { ingestObs(obs, seedKey, areaName); if (done) done(); return; }
      var items = obs.map(function (o) { return { sci: o.sciName, lat: +o.lat, lon: +o.lng, dt: o.obsDt }; });
      Promise.resolve(rarityScoreProbs(items)).then(function (probs) {
        var kept = [];
        obs.forEach(function (o, j) {
          var p = probs && probs[j];   // 0..1, or -1 when not a model species
          if (isFinite(p) && p >= 0) {
            o._mprob = Math.round(p * 1000) / 10;   // %
            if (!rarityIsRareProb(p)) return;   // model says common here → not a rarity
          }
          kept.push(o);
        });
        ingestObs(kept, seedKey, areaName);
        if (done) done();
      }, function () { ingestObs(obs, seedKey, areaName); if (done) done(); });   // scorer failed → don't drop anything
    }
    (function next() {
      rarityPollRemain = Math.max(0, locs.length - i);   // bell subscript: fetches still to go
      updateRarityBell();
      if (i >= locs.length) { finish(); return; }
      var l = locs[i++];
      // The Here placeholder resolves its GPS fix first; unresolvable → skip this cycle.
      if (l.here && !isFinite(+l.lat)) {
        // getHereFix has no timeout of its own: a permission prompt left hanging (or a
        // fix that never resolves) would stop the chain here. Same guard as the
        // country lookup below — after 12 s, carry on without Here.
        var hereRan = false, hereGo = function (fix) {
          if (hereRan) return; hereRan = true;
          if (!fix) { next(); return; }
          var h = hereAsLoc(fix); h.here = true;
          poll(h);
        };
        setTimeout(function () { hereGo(null); }, 12000);
        getHereFix(hereGo);
        return;
      }
      poll(l);
      function poll(l) {
        // This location's eBird notable feed first (when there's a usable key), then the
        // sweep of the ordinary sources for the same spot — the next location follows
        // after the polite gap.
        function after() { sweepLoc(l, l.name, function () { setTimeout(next, 1200); }); }
        function fetchDone() { after(); }
        function fetchErr(tm, err) { if (tm) clearTimeout(tm); if (err && (err.status === 401 || err.status === 403)) { rarityBadKey = tok; setStatus(t("rarity.needKey")); } after(); }
        if (!ebirdOn) { after(); return; }   // no usable eBird key → the sweep alone carries this location
        var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
        var tm = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 30000) : null;
        if (countryWide) {
          // Whole-country alerts: fetch notable for the point's COUNTRY (once per country per
          // cycle, so several points in one country don't refetch it).
          var run = function (cc, cname) {
            if (!cc) { if (tm) clearTimeout(tm); after(); return; }
            if (doneRegions[cc]) { if (tm) clearTimeout(tm); after(); return; }
            doneRegions[cc] = 1;
            window.AppFetch.fetchEbirdNotableRegion(cc, tok, RARITY_BACK_DAYS, locale, ctrl && ctrl.signal)
              .then(function (obs) { if (tm) clearTimeout(tm); handleObs(obs, "cc:" + cc, cname || cc, fetchDone); }, function (err) { fetchErr(tm, err); });
          };
          if (window.AppGeo && window.AppGeo.countryInfo && isFinite(+l.lat)) {
            // The lookup has no timeout of its own; without this guard a stalled request would
            // leave rarityPollBusy set for good and the bell stuck on "checking".
            var ran = false, go = function (cc, nm) { if (ran) return; ran = true; run(cc, nm); };
            setTimeout(function () { go("", ""); }, 15000);
            window.AppGeo.countryInfo(+l.lat, +l.lon).then(function (info) { go(info && info.cc, info && info.name); }, function () { go("", ""); });
          } else run("", "");
          return;
        }
        window.AppFetch.fetchEbirdNotable(l.lat, l.lon, tok, l.radius || recentRadiusKm(), RARITY_BACK_DAYS, locale, ctrl && ctrl.signal)
          .then(function (obs) { if (tm) clearTimeout(tm); handleObs(obs, rarityLocKey(l), l.name, fetchDone); }, function (err) { fetchErr(tm, err); });
      }
    })();
    function finish() {
      if (finished) return;              // watchdog and the normal end can both arrive
      finished = true; clearTimeout(watchTm);
      // Prune: seen-ids past eBird's max lookback (can't reappear), then hard-cap;
      // seeded entries whose location lost its 🔔.
      var now = Date.now(), ids = Object.keys(cfg.seen);
      ids.forEach(function (id) { if (now - cfg.seen[id] > RARITY_SEEN_MAX_MS) delete cfg.seen[id]; });
      ids = Object.keys(cfg.seen);
      if (ids.length > RARITY_SEEN_CAP) ids.sort(function (a, b) { return cfg.seen[a] - cfg.seen[b]; })
        .slice(0, ids.length - RARITY_SEEN_CAP).forEach(function (id) { delete cfg.seen[id]; });
      // Seeded keys come in three shapes: a location ("here" / "lat,lon"), a country
      // ("cc:XX", whole-country mode) and a location's source sweep ("src:<loc>").
      // Drop one only when its LOCATION lost its 🔔 — a country key survives while any
      // 🔔 location does. (Stripping the prefix matters: an un-seeded key re-seeds, and
      // a re-seeded location alerts on nothing.)
      var live = {}; rarityLocs().forEach(function (l) { live[rarityLocKey(l)] = 1; });
      var anyLoc = Object.keys(live).length > 0;
      Object.keys(cfg.seeded).forEach(function (k) {
        if (k.indexOf("cc:") === 0) { if (!anyLoc) delete cfg.seeded[k]; return; }
        if (!live[k.indexOf("src:") === 0 ? k.slice(4) : k]) delete cfg.seeded[k];
      });
      cfg.lastPoll = Date.now();
      window.GeoState.save({ rarityAlerts: cfg });
      rarityListUpsert(listAdds);   // persist ALL first-seen notable records (grouped species×location)
      rarityPlotList();             // keep the ★ map layer in sync when it's enabled
      rarityPollBusy = false;
      rarityPollRemain = 0;
      rarityAgeFeed();
      if (fresh.length) rarityAnnounce(fresh);
      scheduleRarityPoll();
      if (rarityPanelRefresh) try { rarityPanelRefresh(); } catch (e) {}   // open popup → show the fresh list + check time
    }
  }
  // New rarities from one cycle → markers + badge + one chirp + notifications
  // (per-obs up to the cap, else a single "{n} new" summary).
  // The same sighting reaches us more than once: eBird's notable feed and the ordinary-source
  // sweep both cover eBird, and a Nordic record is routinely cross-posted to GBIF and
  // Artsobservasjoner. The record ids are per-source, so the seen-set cannot catch it — dedupe
  // at the moment of announcing instead, by species × ~1 km × date, and let whichever source
  // arrived first do the announcing.
  var announced = Object.create(null), ANNOUNCED_MS = 12 * 3600000;
  function announceKey(f) {
    var o = f.raw || {};
    return rarityGroupKey(o.sciName, o.lat, o.lng) + "|" + String(o.obsDt || "").slice(0, 10);
  }
  function rarityAnnounce(fresh) {
    var cfg = rarityCfg(), now = Date.now();
    for (var k in announced) if (now - announced[k] > ANNOUNCED_MS) delete announced[k];
    fresh = fresh.filter(function (f) {
      var ak = announceKey(f);
      if (announced[ak]) return false;   // already announced from another source this session
      announced[ak] = now; return true;
    });
    if (!fresh.length) return;
    fresh.forEach(function (f) { addRarityMarker(f.raw, f.area); });
    rarityUnread += fresh.length;
    updateRarityBell();
    if (cfg.sound) rarityChirp();
    if (cfg.sysNotif && ("Notification" in window) && Notification.permission === "granted") {
      if (fresh.length > RARITY_NOTIF_CAP) {
        rarityNotify(t("rarity.newMany", { n: fresh.length }), "", "summary", null, null);
      } else fresh.forEach(function (f) {
        var o = f.raw;
        rarityNotify(t("rarity.new", { name: o.comName || o.sciName || "?" }),
          (o.locName || "") + " · " + (o.obsDt || "") + (f.area ? " · " + t("rarity.area", { name: f.area }) : ""),
          rarityId(o), o.lat, o.lng);
      });
    }
    try { rarityEmailAlerts(fresh); } catch (e) {}
    setStatus(t("rarity.newMany", { n: fresh.length }));
  }
  // The page framework closed the rarity page (‹, browser Back, or another page
  // taking its place): stop re-rendering into it.
  function rarityPageClosed() { rarityPanelRefresh = null; }
  // ---- Email delivery -------------------------------------------------------
  // The app has no server of its own, so a mail can only be handed to a relay that
  // accepts a browser request. FormSubmit takes the user's OWN address as the
  // endpoint: the first message triggers a one-off "activate" mail to that address,
  // and everything after it is delivered. Nothing is stored anywhere but this device
  // — and, like every other alert, it only goes out while the app is open.
  var RARITY_MAIL_URL = "https://formsubmit.co/ajax/";
  var RARITY_MAIL_GAP_MS = 5 * 60000;    // never more than one mail per 5 minutes
  function rarityEmailTo() { return String(rarityCfg().email || "").trim(); }
  function rarityEmailValid(a) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(a || "").trim()); }
  // Resolves with { ok, activate } — `activate` when the relay is still waiting for the
  // address to confirm. Rejects only on a transport failure.
  function rarityEmailPost(to, subject, body) {
    var opts = {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ _subject: subject, _captcha: "false", _template: "box", message: body })
    };
    // Through the app's own timeout helper: a relay that never answers used to leave
    // the send hanging for as long as the browser allowed, with the 5-minute window
    // already spent and no state ever reported.
    var req = (window.AppFetch && window.AppFetch.fetchWithTimeout)
      ? window.AppFetch.fetchWithTimeout(RARITY_MAIL_URL + encodeURIComponent(to), opts, 20000)
      : fetch(RARITY_MAIL_URL + encodeURIComponent(to), opts);
    return req.then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        var ok = String(j && j.success) === "true";
        return { ok: ok, activate: !ok && /activat/i.test(String((j && j.message) || "")) };
      });
  }
  // One alert as { text, url }: the species, where, when, how unlikely the model finds
  // it, and which watched area it belongs to — with the record's own link. eBird's own
  // records link to their checklist; everything else carries the link its source gave.
  function rarityMailEntry(f) {
    var o = (f && f.raw) || {};
    var bits = [o.comName || o.sciName || "?"];
    if (o.locName) bits.push(o.locName);
    if (o.obsDt) bits.push(o.obsDt);
    if (o._mprob != null && isFinite(o._mprob)) bits.push(o._mprob + "%");
    if (f && f.area) bits.push(f.area);
    return { text: bits.join(" — "), url: o.subId ? "https://ebird.org/checklist/" + o.subId : (o._url || "") };
  }
  // The message body. The DESCRIPTIVE TEXT is the link, so the mail carries no wall of
  // URLs — and EVERY alert gets one, not just the first few. The same lines follow in
  // plain text, for a client (or relay) that does not render HTML.
  function rarityMailBody(entries, headline) {
    var rows = entries.map(function (e) {
      var txt = escapeHtml(e.text);
      return "<li>" + (e.url ? '<a href="' + escapeHtml(safeHref(e.url)) + '">' + txt + "</a>" : txt) + "</li>";
    }).join("");
    var plain = entries.map(function (e) { return "• " + e.text; }).join("\n");
    return "<p>" + escapeHtml(headline) + "</p><ul>" + rows + "</ul><p>" + escapeHtml(t("rarity.emailFoot")) + "</p>" +
      "\n\n" + headline + "\n" + plain + "\n\n" + t("rarity.emailFoot");
  }
  // One mail per batch of new alerts, rate-limited; failures are silent (the bell,
  // the list and the chirp have already done their job).
  // What became of the last message — so a mail that never arrived can be explained
  // in Settings instead of failing silently. "activate" = the relay is still waiting
  // for the address to confirm itself, so nothing is being delivered yet.
  function rarityEmailState(state, kind, n) {
    raritySave({ emailState: state, emailKind: kind || "test", emailAt: Date.now(), emailCount: +n || 0 });
    // Every attempt leaves a line in Settings → Error log, so "no mail arrived" can be
    // traced to the step that failed instead of guessed at.
    if (typeof appErrLog === "function") appErrLog("rarity mail: " + (kind || "test") + " " + state + (n ? " (" + n + ")" : ""));
  }
  // A cycle announces more than once — the ordinary-source sweep does it per location,
  // eBird's notable batch at the end — so alerts are QUEUED and sent together. Anything
  // arriving inside the rate-limit window waits for it instead of being thrown away.
  var mailQueue = [], mailTimer = null, RARITY_MAIL_QUEUE_CAP = 60;
  function rarityEmailFlush() {
    mailTimer = null;
    var batch = mailQueue.slice(); mailQueue.length = 0;
    var to = rarityEmailTo();
    if (!batch.length || !rarityEmailValid(to)) return;
    var subject = t("rarity.emailSubject", { n: batch.length });
    var body = rarityMailBody(batch.map(rarityMailEntry), subject);
    rarityEmailPost(to, subject, body).then(function (r) {
      // The window is spent on a message the relay actually answered for. A transport
      // failure used to burn it too, so the next batch waited five minutes for nothing.
      raritySave({ lastEmail: Date.now() });
      rarityEmailState(r.ok ? "ok" : (r.activate ? "activate" : "fail"), "alert", batch.length);
      if (!r.ok) setStatus(t(r.activate ? "rarity.emailActivate" : "rarity.emailFail"));   // say it once, where the alert was announced
    }, function () { rarityEmailState("fail", "alert", batch.length); });
  }
  function rarityEmailAlerts(fresh) {
    if (!fresh.length || !rarityEmailValid(rarityEmailTo())) return;
    fresh.forEach(function (f) { mailQueue.push(f); });
    if (mailQueue.length > RARITY_MAIL_QUEUE_CAP) mailQueue.splice(0, mailQueue.length - RARITY_MAIL_QUEUE_CAP);   // keep the newest
    if (mailTimer) return;                                                                    // a send is already pending
    var wait = RARITY_MAIL_GAP_MS - (Date.now() - (+rarityCfg().lastEmail || 0));
    if (wait <= 0) rarityEmailFlush();
    else mailTimer = setTimeout(rarityEmailFlush, wait);
  }
  // "Send test" mails the MOST RECENT alerts when there are any, so what lands in the
  // inbox is a real alert mail rather than a stand-in; a plain note when the list is empty.
  function rarityEmailTestSend(to) {
    var list = getRarityList().slice(0, 5), subject, body;
    if (list.length) {
      subject = t("rarity.emailSubject", { n: list.length });
      // Through the same builder as a real alert, so a test shows exactly what an alert
      // will look like — linked text, no bare URLs.
      body = rarityMailBody(list.map(function (e) {
        var bits = [e.name || e.sci];
        if (e.place) bits.push(e.place);
        if (e.dt) bits.push(String(e.dt).slice(0, 10));
        if (e.prob != null) bits.push(e.prob + "%");
        return { text: bits.join(" — "), url: e.url || "" };
      }), subject);
    } else { subject = t("rarity.emailTestSubj"); body = t("rarity.emailTestBody"); }
    return rarityEmailPost(to, subject, body);
  }
  // Live-alert marker on its own layer — independent of the detections pipeline,
  // its filters and the red-× clear. Session-only (the seen-set is the persistence).
  function addRarityMarker(o, area) {
    // The feed entry is what the badge counts and what ages out, so it is pushed even
    // when no marker can be drawn (map not ready, no coordinates, "show on the map"
    // off). Without this, rarityAnnounce's count had nothing to decrement: the bell
    // stayed red with nothing behind it.
    var mk = null;
    var canDraw = !!getMap() && isFinite(+o.lat) && isFinite(+o.lng) && rarityCfg().showMap !== false && rarityCfg().enabled !== false;
    if (canDraw) mk = rarityMarkerFor(o);
    rarityFeedPush(o, area, mk);
  }
  // The live pulsing marker for a just-arrived alert (the list's own dots come from the
  // detection pipeline, which honours the filters).
  function rarityMarkerFor(o) {
    if (!rarityLayer) rarityLayer = L.layerGroup().addTo(getMap());
    // Same coloured-circle + pulsating-core design as the list layer; NEW alerts
    // additionally get the expanding ring (in the species colour) until read.
    var spKey = rarityModelKey(o.sciName), spCol = spKey ? speciesColor(spKey) : "#888";
    var mk = L.marker([+o.lat, +o.lng], {
      icon: L.divIcon({ className: "rarity-dot rarity-marker",
        html: '<span class="rarity-pulse" style="border-color:' + spCol + '"></span>' +
          '<span class="rc-ring" style="background:' + spCol + ';border-color:' + spCol + '"></span><span class="rc-core"></span>',
        iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 900
    });
    // Same interactions as an ordinary detection dot (click = co-located
    // detections window; hover = the shared species tooltip).
    mk.on("click", function (ev) {
      if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
      rarityDismissTarget = rarityGroupKey(o.sciName, o.lat, o.lng);   // the red ✕ dismisses THIS group
      onDetMarkerClick(mk, true, rarityDismissTarget);   // orange rarity frame; the key guarantees the group shows
    });
    mk.on("mouseover", function () { showDetHover(mk.getLatLng(), true); });
    mk.on("mouseout", hideDetHover);
    rarityLayer.addLayer(mk);
    return mk;
  }
  function rarityFeedPush(o, area, mk) {
    rarityFeed.unshift({ id: rarityId(o), name: o.comName || o.sciName || "?", sci: o.sciName || "",
      dt: o.obsDt || "", place: o.locName || "", observer: o.userDisplayName || "",
      count: o.howMany != null ? o.howMany : "", url: o.subId ? "https://ebird.org/checklist/" + o.subId : (o._url || ""),
      lat: +o.lat, lon: +o.lng, area: area || "", marker: mk, unread: true });   // unread → red "!" on its list row
    while (rarityFeed.length > RARITY_FEED_CAP) {
      var old = rarityFeed.pop();
      if (old.marker && rarityLayer) rarityLayer.removeLayer(old.marker);
    }
  }
  // Feed entries (and their stars) age out past the lookback window.
  function rarityAgeFeed() {
    var cut = Date.now() - RARITY_BACK_DAYS * 86400000, dropped = 0;
    for (var i = rarityFeed.length - 1; i >= 0; i--) {
      var ts = Date.parse((rarityFeed[i].dt || "").replace(" ", "T"));
      if (isFinite(ts) && ts < cut) {
        if (rarityFeed[i].marker && rarityLayer) rarityLayer.removeLayer(rarityFeed[i].marker);
        if (rarityFeed[i].unread) { rarityUnread = Math.max(0, rarityUnread - 1); dropped++; }   // else the badge counts alerts that are gone
        rarityFeed.splice(i, 1);
      }
    }
    if (dropped) updateRarityBell();
  }
  function rarityClearFeed() {
    if (rarityLayer) rarityLayer.clearLayers();
    if (rarityListLayer) rarityListLayer.clearLayers();
    rarityFeed = []; rarityUnread = 0;
    updateRarityBell();
  }
  // "Show as map points": the whole rarity list (within the day window) plotted as
  // STATIC red ★ markers — the same star the live alerts use, minus the pulse, so
  // rarities stand apart from the ordinary coloured detection dots. Re-plotted
  // after every poll/harvest upsert and when the toggle or day window changes.
  var rarityListLayer = null;
  // Rarity dots now draw through the MAIN detection pipeline (app.js: syncAlertDetections
  // injects them into detPlot flagged `rarity`, renderDetGroup draws them with a pulsing
  // black↔white centre) so they get hover, legend selection, clustering, click and the
  // header histogram for free. This shim just clears any legacy separate layer and asks the
  // app to re-sync so the pipeline redraws — keeping every existing caller working.
  function rarityPlotList() {
    if (rarityListLayer) { try { rarityListLayer.clearLayers(); } catch (e) {} }
    // Live alert markers are drawn outside the pipeline, so the gates the pipeline
    // honours have to be applied to them here: switching alerts (or "show on the map")
    // off used to leave pulsing ghosts nothing could remove.
    var rc = rarityCfg();
    if (rarityLayer && (rc.enabled === false || rc.showMap === false)) {
      try { rarityLayer.clearLayers(); } catch (e) {}
      rarityFeed.forEach(function (f) { f.marker = null; });
    }
    if (typeof onRarityListChanged === "function") { try { onRarityListChanged(); } catch (e) {} }
  }
  // Unread the user could actually SEE: an unread alert whose group the alerts page
  // would list right now (inside the day window, under the threshold, not dismissed).
  // The badge used to count raw feed entries, so the bell could be red over an empty
  // page — and opening it zeroed a count that pointed at nothing.
  function rarityUnreadShown() {
    var cfg = rarityCfg(), byKey = Object.create(null), n = 0;
    getRarityList().forEach(function (e) { if (rarityGroupVisible(e, cfg, true)) byKey[e.k] = 1; });
    rarityFeed.forEach(function (f) { if (f.unread && byKey[rarityGroupKey(f.sci, f.lat, f.lon)]) n++; });
    return n;
  }
  // Header bell: hidden entirely while nothing is subscribed; red badge = unread.
  function updateRarityBell() {
    var unread = rarityUnreadShown();
    setTabAlert("rarity", unread > 0 && rarityCfg().enabled);   // ❗ on the tab until the list is opened
    var btn = document.getElementById("rarity-bell");
    if (!btn) return;
    // Hidden when alerts are switched off, or when there is nothing to open: no 🔔 location
    // subscribed AND an empty list. A fetch of your own can put locally-rare birds in the list
    // without any subscription, and the bell is the only way in — so it shows for those too.
    btn.style.display = (rarityCfg().enabled && (rarityLocs().length || getRarityList().length)) ? "" : "none";
    btn.title = t("rarity.bellTitle");
    btn.classList.toggle("alert", unread > 0);         // new (unread) rarity → the bell turns RED until the list is opened
    btn.classList.toggle("busy", rarityPollBusy);      // orange + pulsing while a poll is fetching
    btn.classList.toggle("off", !rarityCfg().enabled); // paused → dimmed (still clickable to re-enable)
    var b = document.getElementById("rarity-badge");
    if (b) { b.textContent = unread > 99 ? "99+" : String(unread); b.style.display = unread > 0 ? "" : "none"; }
    // While a poll runs, a small subscript counts the location fetches still to go.
    var rem = document.getElementById("rarity-remain");
    if (rem) {
      var showRem = rarityPollBusy && rarityPollRemain > 0;
      rem.textContent = String(rarityPollRemain);
      rem.style.display = showRem ? "" : "none";
    }
    var kh = document.getElementById("rarity-key-hint");
    if (kh) kh.style.display = (ebirdKey() || rarityAllSources()) ? "none" : "";   // without a key the sweep still delivers alerts
  }
  // Opening the panel = mark-as-read: badge zeroed, star pulses stop (stars stay).
  function showRarityPanel() {
    // Which groups carry the alerts behind the red bell: collect the unread feed
    // entries' group keys BEFORE marking them read — their rows get a red "!"
    // for the whole time this popup stays open.
    var newKeys = Object.create(null);
    rarityFeed.forEach(function (f) {
      if (f.unread) { newKeys[rarityGroupKey(f.sci, f.lat, f.lon)] = 1; f.unread = false; }
    });
    rarityUnread = 0;
    updateRarityBell();
    rarityFeed.forEach(function (f) {
      var el = f.marker && f.marker.getElement && f.marker.getElement();
      var p = el && el.querySelector(".rarity-pulse");
      if (p) p.classList.add("done");
    });
    // A real page in the app's page framework (like the Species list / Migration /
    // checklist pages): it sits UNDER the green header bar, which stays usable, and
    // its ‹ returns to whatever view it was opened from.
    var page = rarityPageEl && rarityPageEl(); if (!page) return;
    var m = { box: page, close: function () { closeRarityPage(); } };
    openRarityPage();
    var expanded = Object.create(null);   // group key → its individual records are shown
    function render() {
      var cfg = rarityCfg();
      // Alerts arriving while the popup is open join the red-"!" set too.
      rarityFeed.forEach(function (f) { if (f.unread) newKeys[rarityGroupKey(f.sci, f.lat, f.lon)] = 1; });
      // Last completed poll, shown compactly: time-only when it was today.
      var lp = cfg.lastPoll, lpTxt = "—";
      if (lp > 0) {
        var d = new Date(lp);
        lpTxt = (d.toDateString() === new Date().toDateString())
          ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      }
      // Species×location groups from the persisted list — the same question the map
      // rows and the bell ask (dismissed ones stay, dimmed).
      var list = getRarityList().filter(function (e) { return rarityGroupVisible(e, cfg, true); });
      // Species-LIST layout (the real table look), one row per SPECIES × LOCATION
      // group; clicking a row expands its detections beneath (sp-detail style).
      // showSci = the module-level Scientific-names setting, same as the species list.
      var rows = list.map(function (e, gi) {
        e.recs = e.recs || [];
        e.recs.sort(function (x, y) { return String(y.dt || "").localeCompare(String(x.dt || "")); });
        var badge = e.prob != null ? '<span class="rt-src">' + escapeHtml(String(e.prob)) + "%</span>" : "";
        // Source column: the distinct databases behind this group's records —
        // eBird's rarity report shows as "eBird alert" (per-record why flag).
        var srcSeen = Object.create(null), srcList = [];
        e.recs.forEach(function (r) {
          var s = (r.why === "ebird" || (!r.why && e.src === "ebird")) ? t("rarity.ebirdAlert") : (r.src || "").trim();
          if (s && !srcSeen[s]) { srcSeen[s] = 1; srcList.push(s); }
        });
        if (!srcList.length && e.src === "ebird") srcList.push(t("rarity.ebirdAlert"));
        // Species cell: the standard status/colour dot + a clickable .sp-link name
        // (opens the unified species menu, like everywhere else).
        var k2 = rarityModelKey(e.sci) || "";
        // Unseen alerts stand out in bold; everything already known reads in the normal weight.
        var html = '<tr class="rt-row' + (newKeys[e.k] ? " rt-fresh" : "") + (e.dismissed ? " rt-dismissed" : "") + '" data-k="' + escapeHtml(e.k) + '">' +
          '<td class="rt-name">' + (newKeys[e.k] ? '<span class="rt-new" aria-hidden="true">!</span>' : "") +
            // ✕-dismissed groups stay listed (dimmed) with an ⊘ control to bring the dot back.
            (e.dismissed ? '<button type="button" class="rt-unhide" data-k="' + escapeHtml(e.k) + '" title="' + escapeHtml(t("rarity.unhide")) + '" aria-label="' + escapeHtml(t("rarity.unhide")) + '">⊘</button>' : "") +
            spListDot(k2, detIsRare(k2)) +
            '<span class="sp-link" data-key="' + escapeHtml(k2) + '" data-name="' + escapeHtml(e.name || e.sci) +
            '" data-sci="' + escapeHtml(e.sci || "") + '" data-lat="' + (+e.lat) + '" data-lon="' + (+e.lon) +
            '" data-date="' + escapeHtml(String(e.dt || "").slice(0, 10)) + '" data-url="' + escapeHtml(e.url || "") +
            '">' + escapeHtml(e.name || e.sci) + "</span> " + badge + "</td>" +
          (getShowSci() ? '<td class="sci">' + escapeHtml(e.sci && e.sci !== e.name ? e.sci : "") + "</td>" : "") +
          '<td class="rt-loc-cell">' + (e.place
            ? '<span class="rt-loc sp-loc-click" role="button" data-lat="' + (+e.lat) + '" data-lon="' + (+e.lon) + '" data-loc="' + escapeHtml(String(e.place).trim()) + '">' + escapeHtml(e.place) + "</span>"
            : "") + "</td>" +
          '<td class="num rt-n">' + (e.n || 1) + "</td>" +
          '<td class="num rt-last">' + escapeHtml(String(e.dt || "").slice(0, 10)) + "</td>" +
          '<td class="rt-srccol">' + escapeHtml(srcList.join(", ")) + "</td>" +
          '<td class="rt-link">' + (e.url ? '<a href="' + escapeHtml(safeHref(e.url)) + '" target="_blank" rel="noopener">↗</a>' : "") + "</td></tr>";
        // Expanded: this group's detections in the SAME detail table the species
        // list uses (prob/date/location/dist/count/source/observer, ⓘ notes,
        // clickable dates/places/observers via wireSpDetail).
        if (expanded[e.k] && e.recs.length) {
          html += '<tr class="rt-recs"><td colspan="' + (getShowSci() ? 7 : 6) + '">' +
            spDetailTableHtml(rarityModelKey(e.sci), rarityRecRows(e)) + "</td></tr>";
        }
        return html;
      }).join("");
      // Laid out like the app's other full-screen pages: a ‹ page bar with the title
      // and the "last check" line under it, then ONE row of controls, then the table.
      m.box.innerHTML = '<div class="sp-page-bar rarity-bar">' +
          '<button type="button" id="rarity-back" class="fp-back" title="' + escapeHtml(t("btn.close")) + '" aria-label="' + escapeHtml(t("btn.close")) + '">' + ico("back") + "</button>" +
          '<div class="sp-head-lines">' +
            "<h3>" + ico("bell") + " " + escapeHtml(t("rarity.bellTitle")) + "</h3>" +
            '<div class="sp-coords rarity-sub">' + escapeHtml(t("rarity.lastPoll", { t: lpTxt })) +
              ' <button type="button" id="rarity-refresh" class="rt-refresh' + (rarityPollBusy ? " busy" : "") + '" title="' + escapeHtml(t("rarity.checkNow")) + '" aria-label="' + escapeHtml(t("rarity.checkNow")) + '"' + (rarityPollBusy ? " disabled" : "") + ">↻</button></div>" +
          "</div></div>" +
        '<div class="rarity-controls">' +
          '<label class="rt-days">' + escapeHtml(t("rarity.days")) + ' <select id="rarity-days" class="detlist-sort-sel">' +
            [0, 1, 2, 3, 7, 14, 21].map(function (n) {
              return '<option value="' + n + '"' + (+cfg.showDays === n ? " selected" : "") + ">" +
                (n === 0 ? escapeHtml(t("rarity.today")) : n) + "</option>";
            }).join("") + "</select></label>" +
          (rows ? '<button type="button" class="btn btn-light rt-clear" id="rarity-clear">' + escapeHtml(t("rarity.clear")) + "</button>" : "") +
        "</div>" +
        (rows ? '<div class="rarity-list"><table class="sp-style-tbl rarity-tbl"><thead><tr><th>' + escapeHtml(t("th.species")) + "</th>" +
            (getShowSci() ? "<th>" + escapeHtml(t("th.sci")) + "</th>" : "") +
            "<th>" + escapeHtml(t("th.location")) + "</th><th class=\"num\">" + escapeHtml(t("th.total")) +
            "</th><th class=\"num\">" + escapeHtml(t("th.last")) + "</th><th>" + escapeHtml(t("th.source")) + "</th><th></th></tr></thead><tbody>" +
            rows + "</tbody></table></div>"
          : '<div class="rarity-empty">' + escapeHtml(t("rarity.bellEmpty")).replace(/🔔/g, ico("bell")) + "</div>");
      m.box.querySelector("#rarity-back").addEventListener("click", m.close);
      var ds = m.box.querySelector("#rarity-days");
      if (ds) ds.addEventListener("change", function () { raritySave({ showDays: Math.max(0, +this.value || 0) }); rarityPlotList(); render(); });
      // ↻ = poll eBird right now (all 🔔 locations); the finish hook re-renders the list.
      var rf = m.box.querySelector("#rarity-refresh");
      if (rf) rf.addEventListener("click", function () {
        if (rarityPollBusy) return;
        if (!ebirdKey() && !rarityAllSources()) { setStatus(t("rarity.needKey")); return; }   // nothing could deliver an alert
        // With no 🔔 location this used to do nothing at all — a dead button at exactly
        // the moment someone tries the feature. Check where the map is looking instead.
        var one = rarityLocs().length ? null : rarityViewLoc();
        if (!rarityLocs().length && !one) return;
        rarityBadKey = null;
        runRarityPoll(one);
        render();   // show the busy state on the button immediately
      });
      var cl = m.box.querySelector("#rarity-clear");
      if (cl) cl.addEventListener("click", function () {
        window.GeoState.save({ rarityList: [] });
        rarityClearFeed();
        rarityPlotList();   // …and re-derive the map/legend/list rows, or cleared alerts keep their dots
        m.close();
      });
      // Species row = expand/collapse its detections (like the species list);
      // a location name inside the expansion pans the map there.
      m.box.querySelectorAll(".rt-row").forEach(function (tr) {
        tr.addEventListener("click", function (ev) {
          // Links, the species-name menu, the location pan and ⊘ handle themselves.
          if (ev.target.closest("a, .sp-link, .rt-loc, .rt-unhide")) return;
          var k = this.getAttribute("data-k");
          expanded[k] = !expanded[k];
          render();
        });
      });
      // ⊘ on a dismissed row → bring its dot back.
      m.box.querySelectorAll(".rt-unhide").forEach(function (b) {
        b.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var k = this.getAttribute("data-k");
          var a = getRarityList();
          a.forEach(function (x) { if (x.k === k) delete x.dismissed; });
          window.GeoState.save({ rarityList: a });
          rarityPlotList();
          render();
        });
      });
      try { wireSpDetail(m.box); } catch (e) {}   // the shared record-table interactions (ⓘ, dates, observers, places)
    }
    render();
    rarityPanelRefresh = render;   // a finishing poll refreshes the open popup
  }
  // Alarm chirp: two short descending sine sweeps via Web Audio (no asset, works
  // offline). Autoplay policy: the context only runs after a user gesture — the
  // one-time pointer/key listeners below unlock it; until then alarms are
  // silently visual-only.
  var rarityAudioCtx = null;
  function ensureAudioUnlocked() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!rarityAudioCtx) rarityAudioCtx = new AC();
      if (rarityAudioCtx.state === "suspended") rarityAudioCtx.resume().catch(function () {});
    } catch (e) {}
  }
  function rarityChirp(force) {
    if (!force && !rarityCfg().sound) return;
    ensureAudioUnlocked();
    var ctx = rarityAudioCtx;
    if (!ctx || ctx.state !== "running") return;
    function chirp(t0, f0, f1) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(f1, t0 + 0.12);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.25, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.2);
    }
    var now = ctx.currentTime + 0.02;
    chirp(now, 1760, 880);
    chirp(now + 0.22, 1320, 660);
  }
  // System notification through the SW registration — Android Chrome has no page
  // new Notification() constructor. tag dedupes across two open tabs.
  function rarityNotify(title, body, id, lat, lon) {
    try {
      var opts = { body: body || "", icon: "icon-192.png", badge: "icon-192.png",
        tag: "birdswhere-rarity-" + (id || "x"), data: { lat: lat, lon: lon } };
      if (navigator.serviceWorker) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg && reg.showNotification) return reg.showNotification(title, opts);
          return new Notification(title, opts);
        }).catch(function () { try { new Notification(title, opts); } catch (e) {} });
      } else new Notification(title, opts);
    } catch (e) {}
  }
  // 🔔 subscription set changed: bell visibility, forget a bad-key verdict, and a
  // debounced immediate poll (which seeds any new location silently).
  function rarityAlertsChanged() {
    rarityBadKey = null;
    updateRarityBell();
    if (rarityChangedTm) clearTimeout(rarityChangedTm);
    rarityChangedTm = setTimeout(function () {
      if (rarityLocs().length) runRarityPoll();
      else scheduleRarityPoll();   // cancels the timer, hides the bell
    }, 500);
  }
  // One-time boot wiring: header bell, audio unlock, overdue re-checks, the SW
  // notification-click focus message, and the first poll when already subscribed.
  function initRarityAlerts() {
    var hdr = document.getElementById("site-header");
    if (hdr && !document.getElementById("rarity-bell")) {
      var btn = document.createElement("button");
      btn.type = "button"; btn.id = "rarity-bell"; btn.className = "hdr-icon-btn";   // white line icon in the standard bordered header button
      btn.innerHTML = ico("bell") + '<span id="rarity-badge"></span><span id="rarity-remain"></span>';
      // A tap opens the alerts page — and closes it again when it is the page you are on,
      // returning to whatever you came from. (Press-and-hold still polls; see below.)
      btn.addEventListener("click", function () {
        var page = rarityPageEl && rarityPageEl();
        if (page && page.style.display !== "none") closeRarityPage();
        else showRarityPanel();
      });
      hdr.appendChild(btn);
      // Press-and-hold (or right-click) the bell = poll all 🔔 locations right now
      // (same as the popup's ↻ button); a plain tap still opens the rarity list.
      (function () {
        var lpT = null, lpFired = false, lpX = 0, lpY = 0;
        function fire() {
          lpFired = true;
          if (rarityPollBusy) return;
          if (!ebirdKey() && !rarityAllSources()) { setStatus(t("rarity.needKey")); return; }   // nothing could deliver an alert
          var one = rarityLocs().length ? null : rarityViewLoc();
          if (!rarityLocs().length && !one) return;
          rarityBadKey = null;
          runRarityPoll(one);
          setStatus(t("rarity.checkNow") + "…");
        }
        // Capture-phase guard swallows the hold's trailing click so it doesn't also open the popup.
        btn.addEventListener("click", function (e) { if (lpFired) { lpFired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
        function start(x, y) { lpFired = false; clearTimeout(lpT); lpX = x; lpY = y; lpT = setTimeout(fire, holdDelay()); }
        btn.addEventListener("touchstart", function (e) { var tt = e.touches && e.touches[0]; start(tt ? tt.clientX : 0, tt ? tt.clientY : 0); }, { passive: true });
        btn.addEventListener("touchmove", function (e) { var tt = e.touches && e.touches[0]; if (tt && (Math.abs(tt.clientX - lpX) > 12 || Math.abs(tt.clientY - lpY) > 12)) clearTimeout(lpT); }, { passive: true });
        btn.addEventListener("touchend", function () { clearTimeout(lpT); });
        btn.addEventListener("mousedown", function (e) { if (e.button === 0) start(e.clientX, e.clientY); });
        btn.addEventListener("mouseup", function () { clearTimeout(lpT); });
        btn.addEventListener("mouseleave", function () { clearTimeout(lpT); });
        btn.addEventListener("contextmenu", function (e) { e.preventDefault(); fire(); });
      })();
    }
    document.addEventListener("pointerdown", ensureAudioUnlocked, { once: true, capture: true });
    document.addEventListener("keydown", ensureAudioUnlocked, { once: true, capture: true });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) rarityPollIfOverdue(); });
    window.addEventListener("online", rarityPollIfOverdue);
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", function (ev) {
      var d = ev.data || {};
      if (d.type === "rarityFocus" && isFinite(+d.lat) && isFinite(+d.lon) && getMap())
        getMap().setView([+d.lat, +d.lon], Math.max(getMap().getZoom() || 0, 12));
    });
    updateRarityBell();
    rarityPlotList();   // restore the ★ layer when "show as map points" is on
    // Offset from the fetch-on-open start (1.2 s) so the two loops don't collide.
    // Go through the scheduler, not straight to a poll: it honours Manual
    // (intervalMin 0) and measures from lastPoll, so a reload minutes after the last
    // check no longer costs a full network cycle.
    setTimeout(scheduleRarityPoll, 3000);
  }

  return {
    init: init,
    rarityCfg: rarityCfg,
    raritySave: raritySave,
    rarityAlertsChanged: rarityAlertsChanged,
    scheduleRarityPoll: scheduleRarityPoll,
    rarityNearRows: rarityNearRows,
    plotList: rarityPlotList,
    clearLocalRarities: clearLocalRarities,
    rarityDismiss: rarityDismiss,
    rarityChirp: rarityChirp,
    ensureAudioUnlocked: ensureAudioUnlocked,
    harvestLocalRarities: harvestLocalRarities,
    rarityEmailPost: rarityEmailPost, rarityEmailValid: rarityEmailValid, rarityEmailState: rarityEmailState,
    rarityEmailTestSend: rarityEmailTestSend,
    showPanel: showRarityPanel, pageClosed: rarityPageClosed,
    initRarityAlerts: initRarityAlerts,
    // the group key behind the currently-open rarity window (app.js clears it
    // when a non-rarity window opens, and reads it when the red ✕ is pressed)
    dismissTarget: function () { return rarityDismissTarget; },
    setDismissTarget: function (v) { rarityDismissTarget = v; },
  };
})();
