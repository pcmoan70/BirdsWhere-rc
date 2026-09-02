/**
 * Tiny IndexedDB key→value store for the bulky per-list data (saved trips, and
 * later the plotted detections) that would otherwise blow past localStorage's
 * ~5 MB per-origin cap. One object store ("lists"), string keys, JSON-able values.
 *
 * Async by nature; app.js hydrates it into memory ONCE at boot so the rest of the
 * (synchronous) GeoState callers stay unchanged. The Google-Drive sync payload is
 * still assembled as one JSON object, so existing backups remain compatible.
 *
 * Exposed as window.AppIDB. All methods return Promises; `available()` is sync.
 */
window.AppIDB = (function () {
  "use strict";

  // RC channel isolation: same-origin RC deployments ("…-rc/" path) get their own DB.
  var DB_NAME = "migration_calendar" + (/-rc\//i.test(location.pathname) ? "-rc" : ""), STORE = "lists", VERSION = 1;
  var dbPromise = null;

  function available() { try { return !!window.indexedDB; } catch (e) { return false; } }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = window.indexedDB.open(DB_NAME, VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("idb blocked")); };
    });
    // Don't cache a rejected open (blocked / private mode) forever — drop it so a
    // later get/put/del re-attempts open() instead of re-returning the failure.
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function get(id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  // Resolve true on commit, reject on error — so a quota failure is observable.
  function put(id, val) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).put(val, id);
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("idb abort")); };
      });
    });
  }

  function del(id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).delete(id);
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("idb abort")); };
      });
    });
  }

  // Whole store as a plain { id: value } object (cursor → broad compatibility).
  function getAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = {};
        var r = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
        r.onsuccess = function () { var c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else resolve(out); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  return { available: available, open: open, get: get, put: put, del: del, getAll: getAll };
})();
