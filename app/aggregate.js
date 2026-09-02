/**
 * Record → model-species aggregation (the "aggregation layer").
 *
 * Extracted from app.js as the first modularisation step. Maps a flat list of
 * normalised observation records (from any source — eBird / GBIF / iNaturalist /
 * national DBs) onto the BirdNET model's species (`agg`) plus everything the
 * model doesn't cover (`extras`), using a scientific- + common-name matching
 * index built from the model labels.
 *
 * Revealing module (same pattern as GeoState / GeoAnalysis). app.js still OWNS
 * the model data and the family-colour index; it injects live accessors once via
 * AppAggregate.init({...}). Nothing here touches the DOM, the network, or
 * GeoState — it's pure record→species logic, so it loads before app.js with no
 * dependencies of its own.
 *
 * Exposes: init, aggregateRecords, ensureSciIndex, resetSciIndex,
 * labelBySciEpithet, labelBySciGenus, comNorm.
 */
window.AppAggregate = (function () {
  "use strict";

  // ---- Injected by app.js (model data + family index live there) -----------
  // Getters return the LIVE reference each call — `labels`/`labelsByKey`/
  // `taxByCode` are reassigned in app.js when the model loads, so we must not
  // capture a stale snapshot.
  var getLabels = function () { return []; };
  var getLabelsByKey = function () { return {}; };
  var getTaxByCode = function () { return {}; };
  var recordFamily = function () { return false; };   // (key, family) -> changed?
  var saveFamIndex = function () {};
  var getSpeciesGroup = function () { return "all"; };   // "all" | aves | mammalia | amphibia | insecta
  function init(deps) {
    deps = deps || {};
    if (deps.getLabels) getLabels = deps.getLabels;
    if (deps.getLabelsByKey) getLabelsByKey = deps.getLabelsByKey;
    if (deps.getTaxByCode) getTaxByCode = deps.getTaxByCode;
    if (deps.recordFamily) recordFamily = deps.recordFamily;
    if (deps.saveFamIndex) saveFamIndex = deps.saveFamIndex;
    if (deps.getSpeciesGroup) getSpeciesGroup = deps.getSpeciesGroup;
  }

  // ---- Scientific / common-name index over the model labels ----------------
  var sciByLower = null;
  var sciByEpithet = null;   // species epithet → [model labels] (genus-rename fallback)
  var sciByGenus = null;     // genus → [{ l: label, ep: epithet }] (orthographic-variant fallback)
  var comByLower = null;     // normalized English common name → model label (null = ambiguous)
  function comNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
  function ensureSciIndex() {
    if (sciByLower) return sciByLower;
    sciByLower = Object.create(null);
    sciByEpithet = Object.create(null);
    sciByGenus = Object.create(null);
    comByLower = Object.create(null);
    getLabels().forEach(function (l) {
      // Common-name index: lets a source species reconcile to the model even when
      // the scientific name differs (recent splits/synonyms — e.g. eBird's Tyto
      // alba "American Barn Owl" → the model's Tyto furcata "American Barn Owl").
      // A name shared by ≥2 model species is marked ambiguous (null) and skipped.
      if (l.common) { var ck = comNorm(l.common); if (ck) comByLower[ck] = (ck in comByLower) ? null : l; }
      if (!l.sci) return;
      sciByLower[l.sci.toLowerCase()] = l;
      var pg = l.sci.toLowerCase().split(/\s+/);
      if (pg.length >= 2) (sciByGenus[pg[0]] || (sciByGenus[pg[0]] = [])).push({ l: l, ep: pg[1] });
      // Index the species epithet (binomial's 2nd word) so an observation that
      // arrives under an OLD genus (e.g. "Accipiter gentilis" for the model's
      // "Astur gentilis") can still be matched — recent genus splits keep the
      // epithet. Shared epithets keep ALL candidates; the lookup disambiguates
      // by taxonomic class so e.g. the bird "gentilis" wins over the bat.
      var ep = pg.length >= 2 ? pg[1] : "";
      if (ep) (sciByEpithet[ep] || (sciByEpithet[ep] = [])).push(l);
    });
    return sciByLower;
  }
  // Drop the cached label index so the next ensureSciIndex() rebuilds it (call after model labels reload).
  function resetSciIndex() { sciByLower = sciByEpithet = sciByGenus = comByLower = null; }
  function labelClassOf(l) { var tax = getTaxByCode(); return (l && tax[l.key] && tax[l.key].class_name) || ""; }
  // Last-resort scientific-name match for genus renames: the epithet. Returns a
  // model label when it's the only one with that epithet, or — when several
  // share it — the one whose class matches `cls` (the observation's class).
  function labelBySciEpithet(sciName, cls) {
    if (!sciByEpithet) return null;
    var parts = String(sciName || "").toLowerCase().split(/\s+/);
    var cands = parts.length >= 2 && sciByEpithet[parts[1]];
    if (!cands || !cands.length) return null;
    if (cands.length === 1) {
      // Even a unique epithet match must not cross classes (an insect epithet that
      // happens to equal an exotic bird's) when the record's class is known.
      if (cls) { var c1 = labelClassOf(cands[0]); if (c1 && c1.toLowerCase() !== String(cls).toLowerCase()) return null; }
      return cands[0];
    }
    if (cls) {
      var m = cands.filter(function (l) { return String(labelClassOf(l)).toLowerCase() === String(cls).toLowerCase(); });
      if (m.length === 1) return m[0];
    }
    return null;   // still ambiguous → don't guess
  }
  // True if two strings differ by at most one edit (insert/delete/substitute) —
  // enough to bridge orthographic variants between taxonomies (e.g. GBIF's
  // "sibillatrix" vs the model's "sibilatrix").
  function within1(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length, d = la - lb;
    if (d > 1 || d < -1) return false;
    if (d === 0) { var diff = 0; for (var i = 0; i < la; i++) if (a.charAt(i) !== b.charAt(i) && ++diff > 1) return false; return true; }
    var s = la < lb ? a : b, lng = la < lb ? b : a, si = 0, li = 0, skip = 0;
    while (si < s.length && li < lng.length) { if (s.charAt(si) === lng.charAt(li)) { si++; li++; } else { li++; if (++skip > 1) return false; } }
    return true;
  }
  // Match within the SAME genus: exact epithet (catches subspecies trinomials and
  // epithets that are ambiguous across genera) else an epithet within one edit
  // (orthographic variants). Only returns a unique candidate — never guesses.
  function labelBySciGenus(sciName, cls) {
    if (!sciByGenus) return null;
    var parts = String(sciName || "").toLowerCase().split(/\s+/);
    if (parts.length < 2) return null;
    var cands = sciByGenus[parts[0]]; if (!cands || !cands.length) return null;
    var ep = parts[1];
    var pool = cands.filter(function (c) { return c.ep === ep; });
    if (!pool.length) pool = cands.filter(function (c) { return within1(ep, c.ep); });
    if (pool.length === 1) {
      if (cls) { var g1 = labelClassOf(pool[0].l); if (g1 && g1.toLowerCase() !== String(cls).toLowerCase()) return null; }
      return pool[0].l;
    }
    if (pool.length > 1 && cls) {
      var m = pool.filter(function (c) { return String(labelClassOf(c.l)).toLowerCase() === String(cls).toLowerCase(); });
      if (m.length === 1) return m[0].l;
    }
    return null;
  }
  // A subspecies trinomial "Genus species subspecies" frequently names a taxon the
  // model carries as its OWN (split) species "Genus subspecies" — e.g. Corvus corone
  // cornix (Hooded Crow) → the model's Corvus cornix, NOT the nominate Corvus corone
  // (Carrion Crow). Prefer that exact "genus + subspecies" species over the plain
  // epithet fallback, which would otherwise grab the middle word (the nominate).
  function labelBySubspecies(sciName) {
    if (!sciByLower) return null;
    var parts = String(sciName || "").toLowerCase().replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    var sub = parts[2];
    if (!/^[a-z-]+$/.test(sub) || sub === parts[1]) return null;   // 3rd token isn't a plain epithet, or = the nominate
    return sciByLower[parts[0] + " " + sub] || null;
  }

  // ---- Aggregation ----------------------------------------------------------
  // Map a flat list of normalised records to model species (agg) + everything the
  // model doesn't cover (extras), harvesting families for colouring along the way.
  function aggregateRecords(records, groupOverride) {
    var sci = ensureSciIndex();
    var labelsByKey = getLabelsByKey();
    var agg = Object.create(null), extras = Object.create(null), famDirty = false, total = 0;
    function pushRow(arr, row) { if (row && row.lat != null && row.lon != null) arr.push(row); }
    function bump(key, dt, row) {
      if (!key) return;
      if (!agg[key]) agg[key] = { count: 0, latestTs: 0, rows: [] };
      agg[key].count++; total++; pushRow(agg[key].rows, row);
      // Latest-seen timestamp = the record's DATE at LOCAL midnight (day granularity).
      // Parsing the raw dt (often a UTC instant, or a bare date = UTC midnight) then
      // formatting it would shift the day in non-UTC zones — so normalise to the local
      // date here and everywhere it's read (see localISODate).
      var t = Date.parse(String(dt || "").slice(0, 10) + "T00:00:00"); if (!isNaN(t) && t > agg[key].latestTs) agg[key].latestTs = t;
    }
    function bumpExtra(sciName, commonName, dt, cls, row) {
      if (!sciName) return;
      var k = sciName.toLowerCase();
      if (!extras[k]) extras[k] = { sci: sciName, name: commonName || "", cls: cls || "", count: 0, latestTs: 0, rows: [] };
      if (!extras[k].name && commonName) extras[k].name = commonName;
      if (!extras[k].cls && cls) extras[k].cls = cls;
      extras[k].count++; total++; pushRow(extras[k].rows, row);
      var t = Date.parse(String(dt || "").slice(0, 10) + "T00:00:00"); if (!isNaN(t) && t > extras[k].latestTs) extras[k].latestTs = t;   // local-midnight date (see bump)
    }
    // GBIF re-publishes the national databases (Artsobservasjoner, Artportalen,
    // eBird, iNaturalist), so the same sighting can arrive once natively and once
    // via GBIF. Build a set of keys for every non-GBIF record, then drop any GBIF
    // record that matches one — keeping the native copy (fresher, better link).
    // Key = species + location (~110 m) + observer + date (day) + count, per the
    // user's rule. (Date was previously missing from the observer key, so two
    // different-date sightings by the same observer at one spot with the same count
    // could wrongly merge.) Many GBIF records (and eBird's geo/recent) carry NO
    // observer, so a second key swaps the observer for the date (species + loc + day
    // + count) to catch the no-observer case — used only when the GBIF record lacks
    // an observer, so observer-tagged records still dedup precisely.
    function dkLoc(r) { return (r.lat != null ? r.lat.toFixed(3) : "") + "," + (r.lon != null ? r.lon.toFixed(3) : ""); }
    function dkCount(r) { return String(r.count != null ? r.count : ""); }
    function dkDate(r) { return String(r.date || "").slice(0, 10); }
    function dedupKey(r) { return r.sciName.toLowerCase() + "|" + dkLoc(r) + "|" + String(r.observer || "").toLowerCase().replace(/\s+/g, " ").trim() + "|" + dkDate(r) + "|" + dkCount(r); }
    function dedupKeyNoObs(r) { return r.sciName.toLowerCase() + "|" + dkLoc(r) + "|" + dkDate(r) + "|" + dkCount(r); }
    var nativeKeys = Object.create(null), nativeNoObs = Object.create(null);
    (records || []).forEach(function (r) {
      if (!r || !r.sciName || r.src === "GBIF") return;
      if (r.observer) nativeKeys[dedupKey(r)] = 1;
      nativeNoObs[dedupKeyNoObs(r)] = 1;   // built for ALL native records (matches a GBIF republish that dropped the observer)
    });
    // Keep only the active species group's taxa. A specific ANIMAL group keeps just
    // its class (and drops non-animals); the PLANTS / FUNGI groups keep just that
    // kingdom; "all" keeps every supported kingdom (animals + plants + fungi — the
    // sources are already taxon-filtered to those, so All is a true superset).
    var GROUP_CLASS = { aves: "Aves", mammalia: "Mammalia", amphibia: "Amphibia", insecta: "Insecta" };
    var GROUP_KINGDOM = { plantae: /^plant/i, fungi: /^fung/i };
    var NON_ANIMAL_RE = /^(plant|fung|chromist|protozo|bacteri|archae)/i;
    var grp = groupOverride || getSpeciesGroup();   // override = the group captured when the fetch STARTED (avoids a mid-fetch group-switch mismatch)
    var wantClass = GROUP_CLASS[grp] || null;       // set only for the 4 animal groups
    var wantKingdom = GROUP_KINGDOM[grp] || null;   // set only for plantae / fungi
    (records || []).forEach(function (r) {
      if (!r || !r.sciName) return;
      var snLower = r.sciName.toLowerCase();
      // Skip a GBIF record that duplicates a sighting we already have natively:
      // by observer when GBIF kept one, else by the observer-independent date key.
      if (r.src === "GBIF") {
        if (r.observer ? nativeKeys[dedupKey(r)] : nativeNoObs[dedupKeyNoObs(r)]) return;
      }
      // Group filter (records with an unknown class/kingdom are kept — the name
      // match decides):
      var rKingdom = String(r.kingdom || ""), rCls = String(r.cls || "");
      if (wantKingdom) {
        // Plants / Fungi: keep only that kingdom (by kingdom, or the kingdom-derived
        // class since some sources leave kingdom blank).
        if (!(wantKingdom.test(rKingdom) || wantKingdom.test(rCls))) return;
      } else if (wantClass) {
        // A specific animal group: keep only its class, and drop non-animals.
        if (rCls && rCls !== wantClass) return;
        if (NON_ANIMAL_RE.test(rKingdom)) return;
      } else if (grp === "all") {
        // All: keep animals + plants + fungi; drop only the other kingdoms
        // (chromists / protozoa / bacteria / archaea) that a source might slip in.
        if (/^(chromist|protozo|bacteri|archae)/i.test(rKingdom)) return;
      }
      var row = { lat: r.lat, lon: r.lon, date: r.date || "", src: r.src, origin: r.origin || "", url: r.url || "", place: r.place || "", count: (r.count != null ? r.count : ""), act: r.act || "", note: r.note || "", flags: r.flags || "", observer: r.observer || "" };
      // Match a model species by code (eBird) first, then exact scientific name,
      // then the species epithet (catches old-genus synonyms like "Sylvia
      // curruca" for the model's "Curruca curruca").
      var key = (r.speciesCode && labelsByKey[r.speciesCode]) ? r.speciesCode : null;
      // Exact sci-name match always; the epithet fallback (old-genus synonyms) is
      // skipped for sources flagged noFuzzy (Laji.fi) so a record is never guessed
      // onto a different species.
      if (!key) {
        var l = sci[snLower];                                                   // exact binomial (or full trinomial)
        if (!l && !r.noFuzzy) l = labelBySubspecies(r.sciName);                  // "Genus species subspecies" → the split species "Genus subspecies"
        if (!l && !r.noFuzzy) l = labelBySciEpithet(r.sciName, r.cls);           // genus-rename (epithet across genera)
        if (!l && !r.noFuzzy) l = labelBySciGenus(r.sciName, r.cls);             // same-genus exact/≤1-edit epithet (orthographic variants, subspecies)
        if (!l && !r.noFuzzy && r.comName) { var lc = comByLower[comNorm(r.comName)]; if (lc) l = lc; }   // shared English common name (split synonyms, e.g. Tyto alba vs furcata "American Barn Owl")
        if (l) key = l.key;
      }
      // Cross-class guard: never fold a record with a KNOWN class onto a model
      // species of a DIFFERENT class (name/epithet/common-name collisions, e.g. an
      // insect whose name matches a bird). Drop the match so it lands in extras
      // under its own name + class — otherwise it would inherit the model species'
      // class and, in "all"→birds filtering, show as an exotic bird.
      if (key && r.cls) {
        var mCls = (getTaxByCode()[key] || {}).class_name || "";
        if (mCls && mCls.toLowerCase() !== r.cls.toLowerCase()) key = null;
      }
      if (key) { bump(key, r.dt || r.date, row); if (r.family && recordFamily(key, r.family)) famDirty = true; }
      else { bumpExtra(r.sciName, r.comName, r.dt || r.date, r.cls, row); if (r.family && recordFamily("x:" + snLower, r.family)) famDirty = true; }
    });
    if (famDirty) saveFamIndex();
    // dedupTotal = unique records kept after de-dup + the birds-only filter (sum
    // of all agg/extras counts); returned so callers don't re-walk the result.
    return { agg: agg, extras: extras, dedupTotal: total };
  }

  return {
    init: init,
    aggregateRecords: aggregateRecords,
    ensureSciIndex: ensureSciIndex,
    resetSciIndex: resetSciIndex,
    labelBySciEpithet: labelBySciEpithet,
    labelBySciGenus: labelBySciGenus,
    comNorm: comNorm,
  };
})();
