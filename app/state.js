/**
 * Persisted UI state for the Species Distribution & Migration Explorer.
 *
 * Stores language, last mode/week/threshold, last map view, and a list of
 * user-named saved locations in localStorage so the page restores on reload.
 * Exposed as window.GeoState (no module system; loaded via <script>).
 */
window.GeoState = (function () {
  "use strict";

  // RC channel isolation: every pcmoan70.github.io site shares ONE browser origin,
  // so an RC deployment (served from a "…-rc/" path) must not read/write the
  // production store — it gets its own suffixed key (starts empty; bring data in
  // via Drive sync download or a backup import).
  var RC_TAG = /-rc\//i.test(location.pathname) ? "-rc" : "";
  var KEY = "geomodel-explorer-v1" + RC_TAG;
  var listeners = [];
  // The app may register a function that shrinks large, droppable data (plotted
  // detections) so a quota-exceeded write can retry without losing the small,
  // important data (year/life lists, starred species, map points, settings).
  var quotaTrim = null;
  function setQuotaTrim(fn) { quotaTrim = (typeof fn === "function") ? fn : null; }

  // Snapshot the persisted change-stamp at load, BEFORE this session's own init
  // writes bump it. Google Drive sync uses this to decide, on open, whether the
  // remote copy is newer than what this device last saved (init churn must not
  // make the local copy look spuriously newer than the remote).
  var bootStamp = (function () {
    try { return +(JSON.parse(localStorage.getItem(KEY) || "{}").updatedAt) || 0; }
    catch (e) { return 0; }
  })();

  // In-memory parse cache. Every get()/save() used to JSON.parse the WHOLE blob
  // again — and config getters (gbifDays, isSourceOff, recentRadiusKm, …) fire in
  // hot paths (fetch loops, per-marker styling, per-render). The cache is
  // write-through, so localStorage stays current for the direct readers
  // elsewhere; another tab's write invalidates it via the storage event, and the
  // one capped-write path that bypasses write() calls invalidate().
  // Callers that mutate a returned object MUST save() it (the existing
  // read→mutate→save pattern), since the cache hands back live references.
  var cache = null;   // parsed state, or null when stale/unloaded
  var lastOk = true;  // did the most recent write actually persist? (false = quota)

  function read() {
    if (cache) return cache;
    try {
      var raw = localStorage.getItem(KEY);
      cache = raw ? JSON.parse(raw) : {};
    } catch (e) {
      cache = {};
    }
    return cache;
  }

  function invalidate() { cache = null; }   // force a re-parse on the next read
  function lastSaveOk() { return lastOk; }   // false → the last write hit the quota (data not persisted)

  function write(obj) {
    obj.updatedAt = Date.now();   // local change-stamp; orders cross-device sync writes
    cache = obj;                  // write-through: the cache is the source of truth
    lastOk = true;
    try {
      localStorage.setItem(KEY, JSON.stringify(obj));
    } catch (e) {
      // Quota (or other write error): retry with progressively trimmed detections
      // so the rest of the state — lists, starred, points, settings — still saves.
      lastOk = false;
      for (var a = 0; quotaTrim && a < 8 && !lastOk; a++) {
        try {
          var trimmed = quotaTrim(obj, a);
          if (!trimmed) break;
          localStorage.setItem(KEY, JSON.stringify(trimmed));
          cache = trimmed; lastOk = true;   // keep the cache matching what persisted
        } catch (e2) { /* still too big — trim more on the next pass */ }
      }
      // Every attempt failed: `cache` still holds `obj` (set above) which never
      // persisted. Drop it so readers re-parse what actually persisted rather than
      // phantom data that vanishes on reload; callers should check lastSaveOk().
      if (!lastOk) cache = null;
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* a bad listener must not break saves */ }
    }
  }

  // Another tab changing our key invalidates this tab's cache (matches the old
  // re-parse-every-read behaviour for cross-tab edits).
  try {
    window.addEventListener("storage", function (e) { if (e.key === KEY) cache = null; });
  } catch (e) { /* no window/storage events — fine */ }

  // Merge a partial patch into the stored state.
  function save(patch) {
    var s = read();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    write(s);
    return s;
  }

  function get(key, fallback) {
    var s = read();
    return s[key] !== undefined ? s[key] : fallback;
  }

  function locations() {
    var s = read();
    return Array.isArray(s.locations) ? s.locations : [];
  }

  function addLocation(name, lat, lon) {
    var locs = locations();
    var id = "loc-" + Date.now();
    locs.push({ id: id, name: name, lat: lat, lon: lon });
    save({ locations: locs });
    return id;
  }

  function removeLocation(id) {
    save({ locations: locations().filter(function (l) { return l.id !== id; }) });
  }

  // Register a callback fired after every write (used by Drive sync to schedule
  // a push when local data changes).
  function onChange(cb) { if (typeof cb === "function") listeners.push(cb); }

  // The change-stamp as it was at page load (see bootStamp above).
  function bootUpdatedAt() { return bootStamp; }

  // Bump the change-stamp without altering data — for changes kept outside this
  // store (e.g. the eBird key) that should still mark local as newer for sync.
  function touch() { write(read()); }

  return {
    get: get,
    save: save,
    storageKey: KEY,   // the (possibly RC-suffixed) localStorage key — use instead of hardcoding
    invalidate: invalidate,
    lastSaveOk: lastSaveOk,
    setQuotaTrim: setQuotaTrim,
    locations: locations,
    addLocation: addLocation,
    removeLocation: removeLocation,
    onChange: onChange,
    bootUpdatedAt: bootUpdatedAt,
    touch: touch,
  };
})();
