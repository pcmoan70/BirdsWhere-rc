/**
 * Service worker — makes the explorer work offline once it has been opened
 * online at least once.
 *
 * Strategy by request type:
 *   - App shell (html/js/css/i18n/manifest/icon)  CACHE-FIRST
 *       → once cached, the code is served straight from the device and is NOT
 *         re-downloaded while online (no per-load ~1 MB refetch). Fresh code is
 *         pulled ONLY when VERSION changes: a new SW installs and precaches a new
 *         shell cache. It does NOT skipWaiting — the new version WAITS and only
 *         takes over on a full reload / app restart, so the running app stays on
 *         its local cached code until the user reloads from the server. *** This
 *         still makes bumping VERSION on every user-visible deploy mandatory —
 *         without it, returning users keep the cached app forever. ***
 *   - Big immutable data (model, labels, taxonomy) + vendored libs  cache-first
 *       → fetched once, then served instantly offline.
 *   - Map tiles  cache-first, capped (LRU-ish FIFO trim)
 *       → visited areas stay available offline without unbounded growth.
 *   - Geocode / Overpass / species APIs  network-first, cache fallback
 *       → fresh when online, last-known answer when offline.
 *
 * Bump VERSION to invalidate all caches on the next deploy.
 */
var VERSION = "v1581";
// The changelog highlights shown under the lit "Reload to update" button in
// Settings (one bullet per line, ~4–5 bullets). Refresh whenever VERSION is
// bumped for a user-visible change — replace stale bullets, don't accumulate.
var NOTES = [
  "• Fix: “Best sites” dots that had stopped appearing on the map (a stale cached data index after the recent best-sites update) now load correctly — this version refreshes the best-sites data.",
  "• Update button (✓, right side of the map): one tap refreshes every area you’ve already fetched right up to today’s latest observations — it re-fetches each area from a couple of days before its last fetch, so nothing is missed. Hold the button for its two settings: how many days to overlap the previous fetch (default 2) and whether to update only the areas currently in view.",
  "• New Region filter (Filters → Region): every species carries a geographic “belonging” fingerprint from the AI model (13 flyway/continent regions). “Far migrants” shows species that don’t belong to YOUR region — it follows your location (GPS/pin, else the map centre), so a European sees Nearctic/Siberian vagrants while an American sees European ones. “From a region” lists species typical of a chosen realm.",
  "• Sort by distance from you: the legend’s sort toggle has a 📍 Distance option, and the lists sort by their Dist column / “By distance”. While location tracking is on these re-order live as you move — the legend/“close by” every ~50 m, the lists every ~100 m (tuned for driving).",
  "• Locate crosshair: tap = find me once (the red crosshair clears as soon as you pan away); hold = automatic updating — the button pulses blue, the map stays centred on your live position (your zoom is kept), and the legend + any distance-sorted list re-sort as you move.",
].join("\n");
// RC channel isolation: an RC deployment (SW served from a "…-rc/" path) shares the
// browser ORIGIN with production, so its caches must be namespaced — and its activate
// cleanup must only ever delete its OWN namespace (else RC would wipe prod's caches).
// The tile pool + pinned offline areas + meta config are deliberately SHARED (they're
// URL-keyed, identical content — no point downloading tiles twice).
var RC_TAG = /-rc\//i.test(self.location.pathname) ? "rc-" : "";
var SHELL_CACHE = RC_TAG + "shell-" + VERSION;   // app code + small assets
// The data cache is keyed by DATA_REV, NOT by VERSION: model, labels, taxonomy
// and vendor libs (~11 MB) survive app updates instead of being re-downloaded on
// every deploy. Individual data files refresh automatically when their hash in
// files.json changes (see install); bumping DATA_REV is only the manual
// nuke-and-refetch-everything override.
var DATA_REV = "d3";
var DATA_CACHE = RC_TAG + "data-" + DATA_REV;    // model / labels / taxonomy / vendor libs
// version-INDEPENDENT shared pool: map tiles AND the app's computed range-data
// blob live here together, under one byte budget + one LRU. The app writes its
// range cache into this same cache (see MAP_POOL_CACHE in app.js), so it isn't
// wiped on a deploy and both compete for the same space.
var TILE_CACHE = "map-pool";            // map tiles + computed range data
var API_CACHE = RC_TAG + "api-" + VERSION;       // geocode / overpass / species lookups
var META_CACHE = "meta-config";         // version-independent: holds the user's cache-cap setting
var DEFAULT_MAX_TILES = 11000;          // fallback LRU tile cap before the app pushes its setting
var PINNED_PREFIX = "pinned-";          // explicitly downloaded offline areas (never auto-purged)
// The "Map cache buffer" (Settings) in tiles, set by the app via postMessage and
// persisted in META_CACHE so it survives SW restarts. ~22 KB per tile.
var tileCap = null;
function tilesForMB(mb) {
  mb = +mb;
  if (!isFinite(mb)) return DEFAULT_MAX_TILES;
  if (mb < 0) return Infinity;   // Unlimited — never trimmed
  if (mb === 0) return 0;        // Off — cache nothing
  return Math.max(20, Math.round(mb * 1024 * 1024 / 22000));
}
function getTileCap() {
  if (tileCap != null) return Promise.resolve(tileCap);
  return caches.open(META_CACHE).then(function (c) { return c.match("https://config.local/tilecap"); })
    .then(function (r) { return r ? r.text() : null; })
    .then(function (v) {
      var n = v == null ? NaN : parseInt(v, 10);   // "-1" persisted = Unlimited
      tileCap = isNaN(n) ? DEFAULT_MAX_TILES : (n < 0 ? Infinity : n);
      return tileCap;
    })
    .catch(function () { tileCap = DEFAULT_MAX_TILES; return tileCap; });
}
self.addEventListener("message", function (event) {
  var d = event.data || {};
  if (d.type === "getVersion") {
    // Report THIS worker's version. Reply on the MessageChannel port when one is
    // supplied (so the page can ask a specific worker — e.g. the *waiting* one
    // behind the update banner — and not just the active controller); otherwise
    // fall back to event.source (the startup popup asks the active worker).
    event.waitUntil(
      caches.open(SHELL_CACHE)
        .then(function (c) { return c.match(DL_KEY); })
        .then(function (r) { return r ? r.text() : ""; })
        .catch(function () { return ""; })
        .then(function (v) {
          try {
            var payload = { type: "version", version: VERSION, notes: NOTES, dlBytes: v ? +v : null };
            if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
            else if (event.source && event.source.postMessage) event.source.postMessage(payload);
          } catch (e) {}
        })
    );
    return;
  }
  if (d.type === "skipWaiting") {
    // User tapped "Reload" on the update banner — activate this waiting worker now.
    // (We never skipWaiting on install; only on this explicit user action.)
    self.skipWaiting();
    return;
  }
  if (d.type === "tileCacheMB") {
    var tiles = tilesForMB(d.mb);
    tileCap = tiles;
    caches.open(META_CACHE).then(function (c) { c.put("https://config.local/tilecap", new Response(tiles === Infinity ? "-1" : String(tiles))); });
    caches.open(TILE_CACHE).then(function (c) { trim(c, tiles); });   // shrink now if the new cap is smaller
  }
});

// Rarity-alert notifications (shown via reg.showNotification from the page):
// clicking one focuses an open app window — telling it to pan to the sighting —
// or opens a fresh one.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var d = event.notification.data || {};
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    if (list.length) {
      list[0].focus();
      if (d.lat != null) list[0].postMessage({ type: "rarityFocus", lat: d.lat, lon: d.lon });
      return;
    }
    return self.clients.openWindow("./");
  }));
});

// Precached on install so the very next (possibly offline) load has the shell.
var SHELL = [
  "./",
  "index.html",
  "sw-register.js",
  "app.js",
  "rarity.js",
  "offline-maps.js",
  "points-lists.js",
  "site-overlays.js",
  "share-links.js",
  "field-checklist.js",
  "app.css",
  "analysis.js",
  "state.js",
  "idb.js",
  "gdrive-sync.js",
  "sources.js",
  "geo.js",
  "fetch.js",
  "normalize.js",
  "aggregate.js",
  "i18n/strings.js",
  "app-data.js",
  "whats-new.js",
  "countries-lite.json",
  "manifest.webmanifest",
  "icon.svg",
  "qr-app.svg",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/leaflet.js",
  "vendor/maplibre/maplibre-gl.js",
  "vendor/maplibre/maplibre-gl.css",
  "vendor/maplibre/leaflet-maplibre-gl.js",
  "vendor/h3-js.js",
  "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-icon-2x.png",
  "vendor/leaflet/images/marker-shadow.png",
  "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png",
];

// Large files + inference runtime: cache-first, but precache too so a fully
// offline first reload can still run inference (worth the one-time download
// the user already accepted by choosing "full offline").
var DATA = [
  "inference-worker.js",
  "geomodel_fp16.onnx",
  "labels.txt",
  "taxonomy-base.csv",
  "families.csv",
  "vendor/ort/ort.wasm.min.js",
  "vendor/ort/ort-wasm-simd-threaded.mjs.js",
  "vendor/ort/ort-wasm-simd-threaded.wasm",
  "birding-spots/index.json",
  "best-sites/index.json",
];
// (Per-language species-name packs under i18n/names/ and the birding-spot
// quadtree tiles under birding-spots/ are runtime-cached into DATA_CACHE on
// first use — offline keeps every language/area you've opened once.)

var TILE_HOSTS = /(\.basemaps\.cartocdn\.com|\.tile\.openstreetmap\.org|\.tile\.opentopomap\.org|server\.arcgisonline\.com|data-gis\.unep-wcmc\.org|bio\.discomap\.eea\.europa\.eu)/;
var API_HOSTS = /(nominatim\.openstreetmap\.org|overpass-api\.de|api\.inaturalist\.org|api\.gbif\.org|api\.ebird\.org|artskart\.artsdatabanken\.no|api\.artdatabanken\.se|wikipedia\.org|wikidata\.org|wikimedia\.org)/;

// ---- Incremental updates ---------------------------------------------------
// app/files.json (regenerated by .githooks/pre-commit via tools/
// gen-files-manifest.mjs) maps every SHELL/DATA file to a content hash. On
// install, files whose hash is unchanged are COPIED from the previous version's
// caches and only changed files are downloaded. If the manifest is missing or
// its _version doesn't match this sw.js (regeneration forgotten), we fall back
// to a full download — never to stale code.
function fetchManifest() {
  return fetch(reload("files.json")).then(function (r) {
    if (!r.ok) return null;
    return r.clone().json().then(function (m) {
      return (m && m._version === VERSION) ? { man: m, res: r } : null;
    });
  }).catch(function () { return null; });
}
// The previous version's shell cache holds the files.json it installed with —
// that's the "before" side of the diff. Only OUR channel's caches are candidates.
function prevShellManifest() {
  return caches.keys().then(function (names) {
    var prevs = names.filter(function (n) {
      var isRc = n.indexOf("rc-") === 0;
      if (RC_TAG ? !isRc : isRc) return false;
      return n.indexOf(RC_TAG + "shell-") === 0 && n !== SHELL_CACHE;
    });
    var out = { man: null, cache: null };
    return prevs.reduce(function (p, n) {
      return p.then(function () {
        if (out.man) return;
        return caches.open(n).then(function (c) {
          return c.match("files.json").then(function (r) {
            if (!r) return;
            return r.json().then(function (m) { out.man = m; out.cache = c; }).catch(function () {});
          });
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  });
}

// Bytes downloaded by the last install, persisted in the shell cache — the
// Settings "Update to vX" button and the banner show the update's size.
// Content-Length is the wire (gzipped) size when the server reports it.
var DL_KEY = "https://config.local/update-dl";
function addCounted(c, u, tally) {
  return fetch(reload(u)).then(function (res) {
    if (!res || !res.ok) throw new Error(u + " " + (res && res.status));
    var cl = parseInt(res.headers.get("content-length") || "0", 10);
    if (cl > 0) { tally.n += cl; return c.put(u, res); }
    return res.clone().blob().then(function (b) { tally.n += b.size; return c.put(u, res); });
  });
}

self.addEventListener("install", function (event) {
  var tally = { n: 0 };
  event.waitUntil(
    Promise.all([fetchManifest(), prevShellManifest()]).then(function (rr) {
      var cur = rr[0], prev = rr[1];
      var canDiff = !!(cur && prev.man && prev.cache);
      return Promise.all([
        caches.open(SHELL_CACHE).then(function (c) {
          var puts = SHELL.map(function (u) {
            if (canDiff && cur.man[u] && cur.man[u] === prev.man[u]) {
              return prev.cache.match(u).then(function (hit) {
                return hit ? c.put(u, hit) : addCounted(c, u, tally);
              });
            }
            return addCounted(c, u, tally);
          });
          if (cur) puts.push(c.put("files.json", cur.res));
          return Promise.all(puts);
        }),
        // Data files are big; tolerate individual failures so install still
        // succeeds (they fall back to runtime caching on first use). Already-
        // cached data files are re-fetched ONLY when their hash changed (e.g. a
        // new geomodel.onnx) — a plain app update downloads no data at all.
        caches.open(DATA_CACHE).then(function (c) {
          return Promise.all(
            DATA.map(function (u) {
              var changed = canDiff && cur.man[u] !== prev.man[u];
              return c.match(u).then(function (hit) {
                if (hit && !changed) return null;
                return addCounted(c, u, tally).catch(function () {});
              });
            })
          );
        }),
      ]).then(function () {
        return caches.open(SHELL_CACHE).then(function (c) {
          return c.put(DL_KEY, new Response(String(tally.n)));
        });
      });
    })
    // NOTE: deliberately NO self.skipWaiting() here. A newly deployed version
    // precaches its shell but then WAITS — the running (offline-capable) app keeps
    // being served by the current worker's local cache. The new code only takes
    // over on a FULL reload / app restart (all controlled tabs gone), never mid-
    // session. This is what keeps the app "controlled by local code unless the user
    // does a full reload from the server". (A hard reload also bypasses the SW and
    // pulls fresh code straight from the server.)
  );
});

function reload(url) {
  return new Request(url, { cache: "reload" });
}

self.addEventListener("activate", function (event) {
  var keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE, API_CACHE, META_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (n) {
            // Keep current caches and all pinned offline areas (version-independent).
            if (keep.indexOf(n) !== -1 || n.indexOf(PINNED_PREFIX) === 0) return;
            // Only ever delete OUR OWN channel's caches: RC deletes rc-*; production
            // deletes non-rc names (the channels share one origin-wide cache store).
            var isRc = n.indexOf("rc-") === 0;
            if (RC_TAG ? !isRc : isRc) return;
            return caches.delete(n);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;

  if (TILE_HOSTS.test(url.hostname)) {
    // ArcGIS "identify"/"query" calls share the tile hosts but are tiny,
    // position-specific JSON — don't let them fill (and evict) the tile cache.
    if (/\/(identify|query|find)/i.test(url.pathname)) return;
    event.respondWith(tileResponse(req));
    return;
  }
  if (API_HOSTS.test(url.hostname)) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }
  if (sameOrigin) {
    // (The Migration Aloft radar moved to its own repo/site — no /aloft/ path here now.)
    if (/\.(onnx|csv|wasm|mjs)$/.test(url.pathname) ||
        /\/vendor\//.test(url.pathname) ||
        /\/birding-spots\//.test(url.pathname) ||   // bundled spot tiles → persistent data cache (offline once visited)
        /\/best-sites\//.test(url.pathname) ||      // bundled weekly best-site tiles → same persistent data cache
        /labels\.txt$/.test(url.pathname) ||
        /inference-worker\.js$/.test(url.pathname)) {
      event.respondWith(cacheFirst(req, DATA_CACHE));
    } else {
      event.respondWith(shellCacheFirst(req));   // app code served from cache — not re-downloaded per load
    }
    return;
  }
  // Other cross-origin (e.g. fonts): try network, fall back to any cache.
  event.respondWith(
    fetch(req).catch(function () {
      return caches.match(req);
    })
  );
});

// Never resolve a fetch handler to `undefined` — respondWith(undefined) surfaces
// as a hard network error. A synthesized 503 is a clean "offline/unavailable".
function offlineResponse() {
  return new Response("Offline", { status: 503, statusText: "Offline", headers: { "Content-Type": "text/plain" } });
}

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () {
        // Offline and not in this cache — fall back to any other cache. The
        // Leaflet marker/layer images are precached in the shell, so this is
        // what lets markers and icons render offline before they were ever
        // fetched into the data cache.
        return caches.match(req).then(function (hit2) { return hit2 || offlineResponse(); });
      });
    });
  });
}

// App shell (HTML/JS/CSS/i18n) — CACHE-FIRST. Once cached, the code is served
// straight from the device and is NOT re-downloaded while online; fresh code is
// pulled only when VERSION changes (a new SW installs and precaches a new
// cache). This is what keeps an installed/offline app from re-fetching ~1 MB of
// code on every load. Navigations resolve to the cached index.html so share
// links (?s=…) and deep links still open the cached app offline.
function shellCacheFirst(req) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    if (req.mode === "navigate") {
      return cache.match("index.html").then(function (idx) {
        if (idx) return idx;
        return cache.match("./").then(function (root) {
          return root || fetch(req).catch(function () { return offlineResponse(); });
        });
      });
    }
    return cache.match(req).then(function (hit) {
      if (hit) return hit;   // served from cache — not re-downloaded
      // A shell asset that wasn't precached (e.g. added after install): fetch
      // once and store it so the next load is cache-served too.
      return fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit2) { return hit2 || offlineResponse(); });
      });
    });
  });
}

// timeoutMs (optional): if a cached copy exists and the network hasn't answered
// within this many ms, serve the cache immediately and let the network keep
// updating it in the background (stale-while-revalidate). Used for the app shell
// so an offline / dead-network boot doesn't stall on failing fetches. Omitted for
// the API cache, which should wait for fresh data and only fall back on failure.
function networkFirst(req, cacheName, timeoutMs) {
  // Bypass the browser HTTP cache for the network attempt ("no-store") so a
  // fresh deploy is picked up immediately — GitHub Pages' max-age would
  // otherwise let the SW serve a stale copy even though we try the network
  // first. We keep our own copy in CacheStorage for the offline fallback.
  // Build from the Request (not just its URL) so request headers — e.g. the
  // eBird X-eBirdApiToken — are preserved on the network attempt.
  return caches.open(cacheName).then(function (cache) {
    var netP = fetch(new Request(req, { cache: "no-store" }))
      .then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());   // refresh cache (also for the bg update)
        return res;
      });
    function fallback() {
      return cache.match(req).then(function (hit) {
        if (hit) return hit;
        // A navigation must always get the shell, even uncached/offline, rather
        // than a hard network error — fall back to the precached index/root.
        if (req.mode === "navigate") {
          return cache.match("index.html")
            .then(function (idx) { return idx || cache.match("./"); })
            .then(function (s) { return s || offlineResponse(); });
        }
        return offlineResponse();
      });
    }
    if (!timeoutMs) return netP.catch(fallback);   // classic network-first (API)
    // Stale-while-revalidate with a timeout: serve the cache fast when the network
    // is slow/dead, but prefer a fresh response if it arrives within the window.
    return cache.match(req).then(function (hit) {
      if (!hit) return netP.catch(fallback);       // nothing cached → must wait for the network
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () { if (!done) { done = true; resolve(hit); } }, timeoutMs);
        netP.then(function (res) {
          if (done) return; done = true; clearTimeout(timer);
          resolve(res && res.ok ? res : hit);
        }, function () {
          if (done) return; done = true; clearTimeout(timer);
          resolve(hit);                             // network failed fast → serve cache
        });
      });
    });
  });
}

// Tile request: serve from a pinned offline-area cache if present (never
// purged), otherwise the normal LRU tile cache.
function tileResponse(req) {
  return caches.keys().then(function (names) {
    var pinned = names.filter(function (n) { return n.indexOf(PINNED_PREFIX) === 0; });
    return (function tryPinned(i) {
      if (i >= pinned.length) return null;
      return caches.open(pinned[i]).then(function (c) { return c.match(req); })
        .then(function (hit) { return hit || tryPinned(i + 1); });
    })(0);
  }).then(function (pinnedHit) {
    if (pinnedHit) return pinnedHit;
    return getTileCap().then(function (cap) { return cacheFirstCapped(req, TILE_CACHE, cap); });
  });
}

// Cache-first with a FIFO cap. A hit is served as-is — we deliberately do NOT
// re-stamp it (the old delete→put ran detached and raced concurrent requests for
// the same tile and the trim pass, which could lose the entry or double-fetch).
// Plain insertion-order FIFO is a fine eviction policy for map tiles and has no
// race. Opaque (no-cors) responses have status 0 and MUST still be cached — every
// cross-origin tile is opaque, so this is what makes the map work offline; a
// visible (CORS/same-origin) error is skipped because res.ok is false.
function cacheFirstCapped(req, cacheName, max) {
  if (max <= 0) return fetch(req);   // caching Off — straight to the network, nothing stored
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === "opaque")) {
          cache.put(req, res.clone()).then(function () {
            queueTrim(cache, max);
          });
        }
        return res;
      });
    });
  });
}

// Serialize trims: rapid concurrent tile fetches would otherwise fire many
// overlapping trim() passes, each independently reading cache.keys() then
// deleting overlapping keys[i] ranges, which can over-delete (below max) or
// thrash. Chain each queued trim onto the previous so at most one runs at a
// time, and coalesce — never pile up more than one additional pending pass.
var trimming = null; // tail of the in-flight trim chain, or null when idle
var trimPending = false; // a follow-up pass is already queued behind the chain

function queueTrim(cache, max) {
  if (trimming) {
    // A trim is running; queue at most one follow-up pass behind it.
    if (trimPending) return trimming;
    trimPending = true;
    trimming = trimming.then(function () {
      trimPending = false;
      return trim(cache, max);
    });
  } else {
    trimming = trim(cache, max);
  }
  // Whichever branch set the tail, clear it once the chain drains. New work
  // arriving meanwhile reassigns `trimming` to a later promise, so this only
  // nulls when nothing further has been chained on.
  var tail = trimming;
  tail.then(function () {
    if (trimming === tail) trimming = null;
  });
  return trimming;
}

// Cache Storage preserves insertion order, so cache.keys() returns requests
// oldest-first (FIFO) — keys[0..excess-1] are the oldest. The app's computed
// range blob (https://mapcache.local/…) shares this pool so it survives deploys,
// but it is NOT a tile and must never be evicted by tile churn — exclude it from
// both the cap count and deletion.
function trim(cache, max) {
  return cache.keys().then(function (keys) {
    var tiles = keys.filter(function (k) { return k.url.indexOf("mapcache.local") < 0; });
    if (tiles.length <= max) return;
    var excess = tiles.length - max;
    var dels = [];
    for (var i = 0; i < excess; i++) dels.push(cache.delete(tiles[i]));
    return Promise.all(dels);
  });
}
