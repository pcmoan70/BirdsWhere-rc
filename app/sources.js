/**
 * Source / dataset configuration.
 *
 * Fifth modularisation step. The GeoState/localStorage-backed config for which
 * observation sources + GBIF datasets are enabled, their API keys, the GBIF
 * fetch window, and the source registry defaults. AppFetch and AppGeo already
 * take this as injected accessors; this is its proper home.
 *
 * Revealing module. The config SETTERS used to reset app.js's sightings cache
 * directly; they now call an injected onConfigChange() (app.js wires it to that
 * reset) via AppSources.init({ onConfigChange }). The rendering UI for these
 * (the Data-sources / GBIF-datasets popups) stays in app.js and calls back in.
 *
 * app.js aliases every export locally so its existing call sites are unchanged.
 */
window.AppSources = (function () {
  "use strict";

  var onConfigChange = function () {};   // app.js injects a sightings-cache reset
  function init(deps) { deps = deps || {}; if (deps.onConfigChange) onConfigChange = deps.onConfigChange; }

  var DEFAULT_GBIF_DATASETS = [
    { key: "8a863029-f435-446a-821e-275f4f641165", name: "Observation.org", url: "https://observation.org/" },
    { key: "38b4c89f-584c-41bb-bd8f-cd1def33e92f", name: "Artportalen (SE)", url: "https://www.artportalen.se/", country: "SE" },
    { key: "b124e1e0-4755-430f-9eab-894f25a9b59c", name: "Artsobservasjoner (NO)", url: "https://artsobservasjoner.no/", country: "NO" },
    { key: "df12ca07-f133-4550-ab3b-fde13f0e76ba", name: "Notebook / Laji.fi (FI)", url: "https://laji.fi/", country: "FI" },
    { key: "95db4db8-f762-11e1-a439-00145eb45e9a", name: "DOFbasen (DK)", url: "https://www.dofbasen.dk/", country: "DK" },
    // Estonia's state citizen-observation database (loodusvaatlused / EELIS): all
    // species incl. ~156k bird records — verified on GBIF as an ongoing occurrence
    // dataset. Country-gated so it's only queried near Estonia.
    { key: "c6bbb6ef-ad16-4f3c-99e2-f693760173e0", name: "eElurikkus / EELIS (EE)", url: "https://loodusvaatlused.eelis.ee/", country: "EE" },
    // BSPB's common-bird monitoring scheme (Bulgaria) — the largest general-bird
    // BSPB occurrence dataset openly on GBIF (~246k, all birds); gated to BG.
    { key: "0c5f7cb7-1973-4f0e-994f-dfc69fcabc0e", name: "SmartBirds / BSPB (BG)", url: "https://smartbirds.org/", country: "BG" },
    // NABU|naturgucker — Germany's big citizen-science nature portal and by far the
    // largest openly-published German bird source (~15.6M bird records, ~1.4M in
    // 2024–25, actively updated). Fills Germany, which has no direct source. Gated
    // to DE (its data is overwhelmingly German; ornitho.de is not on GBIF).
    { key: "6ac3f774-d9fb-4796-b3e9-92bf6c81c084", name: "naturgucker (DE)", url: "https://naturgucker.de/", country: "DE" },
    // Birds of Ireland (National Biodiversity Data Centre) — Ireland's general bird
    // occurrence dataset (~293k, ongoing); Ireland has no other portal here. Gated to IE.
    { key: "81b551f9-3e4f-47b4-952e-56e870c1b363", name: "Birds of Ireland (IE)", url: "https://www.biodiversityireland.ie/", country: "IE" },
    // SABAP2 — Southern African Bird Atlas Project 2. The #1 fresh bird source in South
    // Africa (ahead of eBird there; ~25.7M total, ~3.5M in 2024–25), key-free. Gated to ZA.
    { key: "906e6978-e292-4a8b-9c39-adf6bb0f3323", name: "SABAP2 (ZA)", url: "https://sabap2.birdmap.africa/", country: "ZA" },
    // Birdata — BirdLife Australia's national bird atlas/surveys (~23M total, ~1.5M in
    // 2024–25), key-free; complements eBird for Australia. Gated to AU.
    { key: "4bf1cca8-832c-4891-9e17-7e7a65b7cc81", name: "Birdata / BirdLife Australia (AU)", url: "https://birdata.birdlife.org.au/", country: "AU" },
    // RU-BIRDS.RU — the Russian birders' observation database, ACTIVE on GBIF
    // (~2M records, ~500k in 2025–26). Russia's only source here (eBird is thin
    // there and ornitho has nothing); gated to RU.
    { key: "ba19fc1d-670c-426b-b99d-49f003792ac4", name: "RU-BIRDS.RU (RU)", url: "https://ru-birds.ru/", country: "RU" },
    // AIRONE — "The Atlas of Wintering Birds in Italy" (Univ. degli Studi di Milano).
    // The dominant Italian bird dataset on GBIF and one of the few national portals
    // still adding current data (~2.75M birds w/coords, ~111k in 2025). Italy has no
    // direct source here; gated to IT.
    { key: "a722377c-ceda-4d15-b02a-f5c7c6a07652", name: "AIRONE Wintering Birds (IT)", url: "https://www.gbif.org/dataset/a722377c-ceda-4d15-b02a-f5c7c6a07652", country: "IT" },
    // Biodiversitätsdatenbank Salzburg (Haus der Natur) — Austria's only actively-
    // updated bird source on GBIF (~654k birds w/coords, ~11k in 2025); ornitho.at is
    // not on GBIF. Gated to AT.
    { key: "c1492854-5d15-40e9-9ee7-24a18ac05112", name: "Salzburg biodiversity DB (AT)", url: "https://www.hausdernatur.at/", country: "AT" },
    // eBird Observation Dataset (EOD) — by far the largest bird source on GBIF, global.
    // HISTORIC-ONLY: it's queried only for a Historic date-range fetch, not the recent
    // fetch — GBIF's copy lags eBird's live API by months, so the direct eBird source
    // (a free key, last ~30 days) stays the fresh recent feed, while EOD gives deep
    // key-free historic coverage everywhere. Not country-gated (global).
    { key: "4fa7b334-ce0d-4e88-aaae-2e0c138d049e", name: "eBird (GBIF · historic)", url: "https://ebird.org/", historicOnly: true },
    // Faune-France network (LPO / PatriNat) opportunistic bird data — France's biggest
    // volume on GBIF (Oiseaux des Jardins ~6.5M, Faune-Occitanie ~3.9M). GBIF's copy is
    // batch-published and ends ~2022, so — like eBird EOD — these are HISTORIC-ONLY
    // (only queried for a Historic date-range fetch), gated to FR, giving France a deep
    // baseline it otherwise lacks here.
    { key: "e0876b81-db28-4e44-891e-ae768e6bb9b5", name: "Oiseaux des Jardins (FR · historic)", url: "https://www.oiseauxdesjardins.fr/", country: "FR", historicOnly: true },
    { key: "c3710778-6492-4094-b7a6-9d63a76e133a", name: "Faune-Occitanie (FR · historic)", url: "https://www.faune-occitanie.org/", country: "FR", historicOnly: true },
    // Pl@ntNet — global plant (+ some fungi) identifications, ~2.6M records, fresh. Only
    // queried when the active group is Plants, Fungi or All (groups gate); in "All" it
    // uses its own Plantae(6)+Fungi(5) filter so it still returns flora there. Global.
    { key: "7a3679ef-5582-4aaa-81f0-8c2545cafc81", name: "Pl@ntNet", url: "https://plantnet.org/", groups: ["plantae", "fungi"], taxa: "&taxonKey=6&taxonKey=5" },
    { key: "6ff8b3b0-ef0f-4f79-a310-5a5615c6aa0b", name: "Birda", url: "https://birda.org/" },
    // Xeno-canto — the world's bird SOUND-recording library, published to GBIF as
    // georeferenced occurrences (~900k, LIVE — records within weeks; ~70k/year).
    // Every record links to a playable recording. Global, key-free.
    { key: "b1047888-ae52-4179-9dd5-5448ea342a24", name: "Xeno-canto (sounds)", url: "https://xeno-canto.org/" },
    // Faune-France (LPO) opportunistic records — 1.6M but a FROZEN 2020 snapshot on
    // GBIF, so historic-only like the other Faune datasets. Gated to FR.
    { key: "e357cdec-295a-4b91-ac7d-abf5fbbc43bb", name: "Faune-France (FR · historic)", url: "https://www.faune-france.org/", country: "FR", historicOnly: true }
  ];
  var GBIF_DS_COUNTRY = {}; DEFAULT_GBIF_DATASETS.forEach(function (d) { if (d.country) GBIF_DS_COUNTRY[d.key] = d.country; });
  function gbifDatasets() {
    var stored = window.GeoState.get("gbifDatasets", null);
    var def = {}; DEFAULT_GBIF_DATASETS.forEach(function (d) { def[d.key] = d; });
    var removed = {}; (window.GeoState.get("gbifRemoved", []) || []).forEach(function (k) { removed[k] = 1; });
    var out = [], have = {};
    (Array.isArray(stored) ? stored : []).forEach(function (d) {
      have[d.key] = 1;
      // Backfill url/name from defaults for entries saved before url existed.
      out.push((d.url || !def[d.key]) ? d : { key: d.key, name: d.name || def[d.key].name, url: def[d.key].url });
    });
    // Always include the current defaults (so new ones like Birda appear),
    // unless the user explicitly removed them.
    DEFAULT_GBIF_DATASETS.forEach(function (d) { if (!have[d.key] && !removed[d.key]) out.push(d); });
    return out;
  }

  function lajiDirectActive() { return !isSourceOff("laji") && !!directKey("laji"); }

  var DEFAULT_DIRECT_SOURCES = [
    { id: "ebird",       name: "eBird",             url: "https://api.ebird.org/v2/data/obs/geo/recent",                                   country: null, keyed: true,  days: 30 },
    { id: "inat",        name: "iNaturalist",       url: "https://api.inaturalist.org/v1/observations",                                    country: null, keyed: false, days: 90 },
    { id: "artsobs",     name: "Artsobservasjoner", url: "https://artskart.artsdatabanken.no/publicapi/api/observations/list",             country: "NO", keyed: false, days: 90 },
    { id: "artportalen", name: "Artportalen",       url: "https://api.artdatabanken.se/species-observation-system/v1/Observations/Search", country: "SE", keyed: true,  days: 90 },
    { id: "laji",        name: "Laji",              url: "https://api.laji.fi/v0/warehouse/query/unit/list",                               country: "FI", keyed: true,  days: 90 },
    // BirdTrack (BTO, Britain & Ireland) has no public API of its own; its records are
    // published to the NBN Atlas in the "Birds (BTO+partners)" datasets (~1 km grid,
    // yearly batches → months of lag). days=400 so a default fetch reaches the newest batch.
    { id: "nbn",         name: "BirdTrack (NBN)",   url: "https://records-ws.nbnatlas.org/occurrences/search",                             country: "GB", keyed: false, days: 400 },
    { id: "birdweather", name: "BirdWeather",       url: "https://app.birdweather.com/graphql",                                            country: null, keyed: false, days: 7 }
  ];
  var DIRECT_BY_ID = {}; DEFAULT_DIRECT_SOURCES.forEach(function (d) { DIRECT_BY_ID[d.id] = d; });

  function directSources() {
    var stored = window.GeoState.get("directSources", null);
    var list;
    if (!Array.isArray(stored)) {
      list = DEFAULT_DIRECT_SOURCES.map(function (d) { return { id: d.id, name: d.name, url: d.url, days: d.days }; });
    } else {
      // The user's list — but always surface any newer built-in source (e.g.
      // Laji.fi) they don't have yet, unless they explicitly removed it.
      var have = {}; stored.forEach(function (s) { if (s && s.id) have[s.id] = 1; });
      var removed = {}; (window.GeoState.get("srcRemoved", []) || []).forEach(function (id) { removed[id] = 1; });
      list = stored.slice();
      DEFAULT_DIRECT_SOURCES.forEach(function (d) { if (!have[d.id] && !removed[d.id]) list.push({ id: d.id, name: d.name, url: d.url, days: d.days }); });
    }
    var seen = {};
    return list.filter(function (s) { if (!s || !s.id || seen[s.id]) return false; seen[s.id] = 1; return true; }).map(function (s) {
      var d = DIRECT_BY_ID[s.id] || {};
      var name = s.name || d.name || s.id;
      if (s.id === "laji" && name === "Laji.fi (FI)") name = "Laji";   // migrate the old default label to the short name
      return { id: s.id, name: name, url: s.url || d.url || "", keyed: !!d.keyed, country: d.country || null, days: (s.days != null && +s.days > 0) ? +s.days : (d.days || 90) };
    });
  }
  function saveDirectSources(list) { window.GeoState.save({ directSources: list }); onConfigChange(); }
  // On/off toggles. A source/dataset is ON unless its id/key is in the "off" map,
  // so existing setups (and freshly added ones) default to enabled.
  function sourcesOff() { return window.GeoState.get("srcOff", { birdweather: 1 }) || { birdweather: 1 }; }   // BirdWeather (acoustic AI IDs) is OFF by default; enabling it removes it from the map
  function isSourceOff(id) { return !!sourcesOff()[id]; }
  function setSourceOff(id, off) {
    var m = sourcesOff(); if (off) m[id] = 1; else delete m[id];
    window.GeoState.save({ srcOff: m }); onConfigChange();
  }
  // GBIF isn't a direct source (it's the always-present base), but it gets the
  // same "days to fetch" control: how far back its window goes. Default 90 keeps
  // the historical 3-month behaviour.
  var GBIF_MAX_DAYS = 92;   // upper limit for GBIF's fetch window (≈ 3 months)
  function gbifDays() { var n = +window.GeoState.get("gbifDays", 90); return (n > 0) ? Math.min(GBIF_MAX_DAYS, n) : 90; }
  function setGbifDays(n) { window.GeoState.save({ gbifDays: Math.max(1, Math.min(GBIF_MAX_DAYS, +n || 90)) }); onConfigChange(); }
  function gbifOff() { return window.GeoState.get("gbifOff", {}) || {}; }
  function isGbifOff(key) { return !!gbifOff()[key]; }
  function setGbifOff(key, off) {
    var m = gbifOff(); if (off) m[key] = 1; else delete m[key];
    window.GeoState.save({ gbifOff: m }); onConfigChange();
  }
  // A keyed source's key. eBird and Artportalen keep their dedicated slots (used
  // directly elsewhere); any OTHER keyed source stores its key generically in a
  // per-id map, so adding a new keyed international source needs no special
  // plumbing — just a registry entry with keyed:true and a run() implementation.
  function directKey(id) {
    if (id === "ebird") return ebirdKey();
    if (id === "artportalen") return artKey();
    var keys = window.GeoState.get("sourceKeys", {}) || {};
    return keys[id] || "";
  }
  function setDirectKey(id, v) {
    if (id === "ebird") { setEbirdKey(v); return; }
    if (id === "artportalen") { setArtKey(v); return; }
    var keys = window.GeoState.get("sourceKeys", {}) || {}; keys[id] = (v || "").trim();
    window.GeoState.save({ sourceKeys: keys }); onConfigChange();
  }

  // User's personal eBird API token (kept in localStorage; never shared).
  // The eBird token lives in its own localStorage entry (not the shared app
  // state) so it always persists across reloads. Older builds stored it inside
  // GeoState — migrate that on first read.
  var EBIRD_KEY_LS = "geomodel-ebird-key";
  function ebirdKey() {
    try {
      var k = localStorage.getItem(EBIRD_KEY_LS);
      if (k == null) {
        var old = window.GeoState.get("ebirdKey", "");
        if (old) { localStorage.setItem(EBIRD_KEY_LS, String(old).trim()); return String(old).trim(); }
        return "";
      }
      return String(k).trim();
    } catch (e) { return ""; }
  }
  function setEbirdKey(v) { try { localStorage.setItem(EBIRD_KEY_LS, (v || "").trim()); } catch (e) { /* storage blocked */ } }
  // SLU Artdatabanken (SE) subscription key — free, pasted like the eBird key;
  // enables the Artportalen source (only queried when the point is in Sweden).
  var ART_KEY_LS = "geomodel-artdb-key";
  function artKey() { try { return String(localStorage.getItem(ART_KEY_LS) || "").trim(); } catch (e) { return ""; } }
  function setArtKey(v) { try { localStorage.setItem(ART_KEY_LS, (v || "").trim()); } catch (e) { /* storage blocked */ } }

  return {
    init: init,
    gbifDatasets: gbifDatasets,
    lajiDirectActive: lajiDirectActive,
    directSources: directSources,
    saveDirectSources: saveDirectSources,
    sourcesOff: sourcesOff,
    isSourceOff: isSourceOff,
    setSourceOff: setSourceOff,
    gbifDays: gbifDays,
    setGbifDays: setGbifDays,
    gbifOff: gbifOff,
    isGbifOff: isGbifOff,
    setGbifOff: setGbifOff,
    directKey: directKey,
    setDirectKey: setDirectKey,
    ebirdKey: ebirdKey,
    setEbirdKey: setEbirdKey,
    artKey: artKey,
    setArtKey: setArtKey,
    DEFAULT_GBIF_DATASETS: DEFAULT_GBIF_DATASETS,
    GBIF_DS_COUNTRY: GBIF_DS_COUNTRY,
    DEFAULT_DIRECT_SOURCES: DEFAULT_DIRECT_SOURCES,
    DIRECT_BY_ID: DIRECT_BY_ID,
    GBIF_MAX_DAYS: GBIF_MAX_DAYS,
    EBIRD_KEY_LS: EBIRD_KEY_LS,
    ART_KEY_LS: ART_KEY_LS,
  };
})();
