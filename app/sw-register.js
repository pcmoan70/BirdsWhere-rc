// Register the service worker for offline support. Split out of an inline
// <script> in index.html so the page can ship a strict Content-Security-Policy
// (script-src without 'unsafe-inline') — the main XSS defence-in-depth.
//
// The SW never skipWaiting on install (the app must stay on its local cached code
// until the user chooses to update). When a new version has installed and is
// WAITING, we do NOT pop anything up by default — instead we expose the pending
// update on `window.SWUpdate` so the app can light up a "Reload to update" button
// in Settings; the user reloads at their own will. The old auto "Update available"
// banner is opt-in (Settings → auto-show update banner; SWUpdate.bannerEnabled).
if ("serviceWorker" in navigator) {
  // Shared state for the app (Settings button reads this; app.js sets bannerEnabled
  // + onchange). apply() activates the waiting worker → controllerchange reloads.
  var SWUpdate = window.SWUpdate = {
    pending: false, version: "", notes: "", dlBytes: null, worker: null, _reloaded: false,
    bannerEnabled: false,   // app.js sets from the user setting (default: no auto banner)
    onchange: null,         // app.js hooks this to refresh the Settings update button
    showBanner: function () {},
    // Activate the newest worker and reload ONTO it. The old worker keeps controlling
    // (and serving old cached code) until a new one takes over via skipWaiting →
    // controllerchange, so we must never plain-reload while an update is pending — that
    // just re-serves the old shell (the "falls back to the previous version" bug).
    apply: function () {
      function activate(w) { if (w) { try { w.postMessage({ type: "skipWaiting" }); } catch (e) {} } }
      // If the worker is still installing, wait for it to finish, then skipWaiting.
      function onceInstalled(reg, w) {
        if (!w) return false;
        if (w.state === "installed") { activate(w); return true; }
        w.addEventListener("statechange", function () { if (w.state === "installed") activate(reg.waiting || w); });
        return true;
      }
      // Belt-and-braces: if controllerchange never fires (skipWaiting silently blocked),
      // reload anyway after a few seconds so the button doesn't sit on "Updating…".
      function fallbackReload() { setTimeout(function () { if (!SWUpdate._reloaded) { SWUpdate._reloaded = true; window.location.reload(); } }, 7000); }

      if (SWUpdate.worker) { activate(SWUpdate.worker); fallbackReload(); return; }
      if (!navigator.serviceWorker.getRegistration) { window.location.reload(); return; }
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) { window.location.reload(); return; }
        if (reg.waiting) { activate(reg.waiting); fallbackReload(); return; }
        if (onceInstalled(reg, reg.installing)) { fallbackReload(); return; }
        // Nothing pending locally — pull the latest from the server, then activate it.
        Promise.resolve(reg.update()).then(function () {
          if (reg.waiting) { activate(reg.waiting); fallbackReload(); }
          else if (onceInstalled(reg, reg.installing)) { fallbackReload(); }
          else window.location.reload();   // genuinely up to date (or offline) → a plain reload is fine
        }).catch(function () { window.location.reload(); });
      }).catch(function () { window.location.reload(); });
    }
  };
  window.addEventListener("load", function () {
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (SWUpdate._reloaded) return; SWUpdate._reloaded = true; window.location.reload();
    });

    // "1.2 MB" / "340 KB" — the update's (already-completed) download size.
    function fmtDlSize(n) {
      return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
    }

    // Ask a specific worker over a MessageChannel (sw.js replies on the port) for its
    // VERSION and NOTES. Resolves to {} on any failure.
    function workerInfo(worker) {
      return new Promise(function (resolve) {
        if (!worker) { resolve({}); return; }
        var ch = new MessageChannel();
        var done = false, finish = function (d) { if (done) return; done = true; resolve(d || {}); };
        ch.port1.onmessage = function (e) { finish(e.data); };
        try { worker.postMessage({ type: "getVersion" }, [ch.port2]); } catch (e) { finish({}); }
        setTimeout(function () { finish({}); }, 1500);
      });
    }

    function showUpdateBar(worker) {
      if (!worker || document.getElementById("sw-update-bar")) return;
      var bar = document.createElement("div");
      bar.id = "sw-update-bar";
      bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;" +
        "background:#0f1b24;color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35);" +
        "font:14px/1.3 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:8px;max-width:min(92vw,360px);";
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;align-items:center;";
      var msg = document.createElement("span"); msg.textContent = "New version available";
      msg.style.cssText = "flex:1 1 auto;font-weight:600;";
      var go = document.createElement("button"); go.textContent = "Reload";
      go.style.cssText = "background:#2f6f4f;color:#fff;border:none;border-radius:7px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer;flex:0 0 auto;";
      var x = document.createElement("button"); x.textContent = "×"; x.setAttribute("aria-label", "Dismiss");
      x.style.cssText = "background:transparent;color:#fff;border:none;font-size:20px;line-height:1;cursor:pointer;padding:0 2px;flex:0 0 auto;";
      go.addEventListener("click", function () { go.disabled = true; msg.dataset.updating = "1"; msg.textContent = "Updating…"; SWUpdate.apply(); });
      x.addEventListener("click", function () { if (bar.parentNode) bar.parentNode.removeChild(bar); });
      row.appendChild(msg); row.appendChild(go); row.appendChild(x);
      bar.appendChild(row);
      var notes = document.createElement("div");
      notes.style.cssText = "font-size:12px;line-height:1.4;color:#c7d2d0;white-space:pre-line;display:none;max-height:38vh;overflow:auto;";
      bar.appendChild(notes);
      workerInfo(worker).then(function (d) {
        if (d && d.version && !msg.dataset.updating) {
          var sz = (d.dlBytes > 0) ? " (" + fmtDlSize(d.dlBytes) + ")" : "";
          msg.textContent = "New version " + d.version + " available" + sz;
        }
        if (d && d.notes) { notes.textContent = d.notes; notes.style.display = ""; }
      });
      document.body.appendChild(bar);
    }
    SWUpdate.showBanner = function () { if (SWUpdate.worker) showUpdateBar(SWUpdate.worker); };

    // A new version has installed and is WAITING. Record it + tell the app (so the
    // Settings "Reload to update" button activates). Only pop the banner when the
    // user has explicitly opted in — otherwise nothing intrudes; they reload at will.
    function notifyWaiting(worker) {
      if (!worker) return;
      SWUpdate.worker = worker; SWUpdate.pending = true;
      try { if (SWUpdate.onchange) SWUpdate.onchange(SWUpdate); } catch (e) {}
      workerInfo(worker).then(function (d) {
        if (d && d.version) SWUpdate.version = d.version;
        if (d && d.notes) SWUpdate.notes = d.notes;
        if (d && d.dlBytes > 0) SWUpdate.dlBytes = d.dlBytes;   // what the install downloaded = the update's size
        try { if (SWUpdate.onchange) SWUpdate.onchange(SWUpdate); } catch (e) {}
        if (SWUpdate.bannerEnabled) showUpdateBar(worker);
      });
      if (SWUpdate.bannerEnabled) showUpdateBar(worker);
    }

    // updateViaCache:"none" → the browser always fetches sw.js straight from the
    // network on an update check, so a new deploy is noticed promptly.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) {
      function maybeShow() {
        if (reg.waiting && navigator.serviceWorker.controller) notifyWaiting(reg.waiting);
      }
      maybeShow();   // an update installed on a previous visit and is already waiting

      // Direct version check: the "waiting worker" path above can miss cases (no
      // controller yet, an install still in flight, a browser that hasn't installed
      // the new SW), so ALSO compare the RUNNING version to the one on the server and
      // light up the button whenever they differ — then pull the new SW in so the
      // button's Reload can activate it.
      var runningVer = "";
      workerInfo(navigator.serviceWorker.controller).then(function (d) { runningVer = (d && d.version) || ""; });
      function checkRemoteVersion() {
        fetch("sw.js", { cache: "no-store" }).then(function (r) { return r.ok ? r.text() : ""; }).then(function (txt) {
          var m = txt.match(/VERSION\s*=\s*"([^"]+)"/);
          var remote = m && m[1];
          if (remote && runningVer && remote !== runningVer) {
            if (!SWUpdate.pending) {
              SWUpdate.pending = true; SWUpdate.version = remote;
              try { if (SWUpdate.onchange) SWUpdate.onchange(SWUpdate); } catch (e) {}
            }
            try { reg.update(); } catch (e) {}   // fetch + install the new SW so apply() can activate it
          }
        }).catch(function () {});
      }
      checkRemoteVersion();
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) notifyWaiting(nw);
        });
      });
      // Desktop tabs stay open for a long time, so re-check for updates: immediately,
      // on focus/visibility, and on a slow interval as a backstop.
      var checking = false;
      function checkForUpdate() {
        if (checking) return; checking = true;
        Promise.resolve(reg.update()).then(maybeShow).catch(function () {})
          .then(function () { checking = false; checkRemoteVersion(); });
      }
      checkForUpdate();
      // Let the app trigger an immediate check (e.g. when Settings opens). Fully
      // non-blocking: both the reg.update() and the sw.js fetch resolve/fail async
      // with .catch, so offline it just quietly does nothing.
      SWUpdate.checkNow = checkForUpdate;
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") checkForUpdate();
      });
      window.addEventListener("focus", checkForUpdate);
      setInterval(checkForUpdate, 15 * 60 * 1000);   // every 15 min while the tab stays open
    }).catch(function (e) {
      console.warn("Service worker registration failed:", e);
    });
  });
}
