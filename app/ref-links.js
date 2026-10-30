/**
 * Reference links — where a species or a country points to outside the app:
 * Wikipedia (with the binomial clean-up), Macaulay Library, Xeno-canto, POWO,
 * ADW, NBN, eBird, BirdLife, the iNaturalist names popup, the per-country
 * portal links (built-in + the user's own, with the editor) and the birding
 * blogs per country.
 *
 * Lifted out of app.js byte-for-byte (v2230). app.js still owns the menus that
 * show these links and injects what this module needs through init() — same
 * identifiers as inside the monolith.
 *
 * Exposed as window.AppRefLinks (no module system; loaded via <script>).
 */
window.AppRefLinks = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  // Plain function aliases (stable references) …
  var bringToFront, closeAnchoredMenu, createModal, escapeHtml, fatbirderUrl, inatLocale, linkUrl, modalPrompt, navOpen,
      openAnchoredMenu, openExternal, positionAnchoredMenu, safeHref, setLang, t, saveChecked;
  // … and getters for app state that changes at runtime.
  var getLang, getLoadedTaxCols, getTaxByCode;

  function init(ctx) {
    bringToFront = ctx.bringToFront; closeAnchoredMenu = ctx.closeAnchoredMenu; createModal = ctx.createModal; escapeHtml = ctx.escapeHtml;
    fatbirderUrl = ctx.fatbirderUrl; inatLocale = ctx.inatLocale; linkUrl = ctx.linkUrl; modalPrompt = ctx.modalPrompt; navOpen = ctx.navOpen;
    openAnchoredMenu = ctx.openAnchoredMenu; openExternal = ctx.openExternal; positionAnchoredMenu = ctx.positionAnchoredMenu;
    safeHref = ctx.safeHref; setLang = ctx.setLang; t = ctx.t; saveChecked = ctx.saveChecked;
    getLang = ctx.getLang; getLoadedTaxCols = ctx.getLoadedTaxCols; getTaxByCode = ctx.getTaxByCode;
  }

  // Wikipedia article (chosen language) for a species; scientific name is the
  // most reliable search term and resolves to the localized article.
  // eBird group/subspecies taxa carry qualifiers that break external searches
  // ("Terpsiphone affinis [affinis Group]", "Blyth's Paradise-Flycatcher
  // (Blyth's)- -"). Everything from the first (/[ on is dropped, trailing
  // separator junk stripped, and a trinomial is capped to genus+species — but
  // ONLY when the 2nd word looks Latin, so a multi-word COMMON name (the
  // fallback when a record has no scientific name) is passed through whole.
  function sciBinomial(sci) {
    var s = String(sci || "").split("(")[0].split("[")[0];
    s = s.replace(/[\s\-–—·|]+$/, "").trim();
    var w = s.split(/\s+/);
    if (w.length > 2 && /^[a-z-]+$/.test(w[1] || "")) return w.slice(0, 2).join(" ");
    return s;
  }
  function wikipediaUrl(sci) {
    var wl = getLang() === "zh-CN" ? "zh" : getLang();
    return "https://" + wl + ".wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(sciBinomial(sci));
  }

  // Open the species' Wikipedia article in the UI language, falling back to the
  // English article when the locale-language Wikipedia has no page for it.
  // The tab is opened synchronously (preserving the user gesture) and its URL
  // is set once the locale page's existence is known.
  function openWikipedia(sci) {
    sci = sciBinomial(sci);
    var wl = getLang() === "zh-CN" ? "zh" : getLang();
    var enUrl = "https://en.wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(sci);
    if (wl === "en") { openExternal(enUrl); return; }
    var w = window.open("about:blank", "_blank"); try { if (w) w.opener = null; } catch (e) {}   // prevent reverse tabnabbing
    var go = function (url) { if (w) { w.location.href = url; } else { openExternal(url); } };
    fetch("https://" + wl + ".wikipedia.org/w/api.php?origin=*&format=json&action=query&redirects=1&titles=" + encodeURIComponent(sci))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pages = j.query && j.query.pages;
        var page = pages && pages[Object.keys(pages)[0]];
        var exists = page && page.missing === undefined && page.pageid !== undefined;
        go(exists ? "https://" + wl + ".wikipedia.org/wiki/" + encodeURIComponent(String(page.title || sci).replace(/ /g, "_")) : enUrl);
      })
      .catch(function () { go(enUrl); });
  }

  // Macaulay Library media catalog: eBird taxon code for birds (label keys are
  // eBird codes), else a free-text search by scientific name. When a date is known
  // (the observation's), it narrows the catalog to that SEASON — a ±1-month window
  // (beginMonth/endMonth) — so the photos/audio match the time of year the bird was
  // seen (e.g. breeding vs winter plumage). No date → the current month's window.
  function macaulayMonthRange(dateStr) {
    var d = dateStr ? new Date(dateStr) : new Date(), m;
    m = (d && !isNaN(d.getTime())) ? d.getMonth() + 1 : (new Date()).getMonth() + 1;
    var b = Math.max(1, m - 1), e = Math.min(12, m + 1);   // clamp so the range never wraps the year
    return "&beginMonth=" + b + "&endMonth=" + e;
  }
  function macaulayUrl(key, sci, dateStr) {
    var range = macaulayMonthRange(dateStr);
    var k = String(key || "");
    // Only a clean alphanumeric key is an eBird taxon code (model labels are).
    // Extra species carry synthetic "x:<scientific name>" keys, GBIF ones are
    // numeric — both must go through the free-text search instead.
    if (/^[a-z][a-z0-9]*$/i.test(k) && !/^\d+$/.test(k)) {
      return "https://search.macaulaylibrary.org/catalog?taxonCode=" + encodeURIComponent(k) + range;
    }
    var q = sciBinomial(sci || k.replace(/^x:/, ""));
    return "https://search.macaulaylibrary.org/catalog?q=" + encodeURIComponent(q) + range;
  }

  // Xeno-canto audio recordings — search by scientific name (graceful for any
  // taxon, vs. a species page that would 404 on a naming mismatch).
  function xenoCantoUrl(sci) {
    return "https://xeno-canto.org/explore?query=" + encodeURIComponent(sciBinomial(sci));
  }
  // iNaturalist's NAME SERVER — the same API that fills in the app's missing names
  // (taxa/autocomplete above), asked here for everything it holds: the accepted
  // scientific name and the common name per language. That is the check for "this
  // name looks off": read what the source actually calls the taxon.
  var inatNamesCache = Object.create(null);
  function inatNamesFetch(sci) {
    var bin = sciBinomial(sci), k = bin.toLowerCase();
    if (inatNamesCache[k]) return Promise.resolve(inatNamesCache[k]);
    return fetch("https://api.inaturalist.org/v1/taxa?per_page=5&all_names=true&locale=" +
        encodeURIComponent(inatLocale()) + "&q=" + encodeURIComponent(bin))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var rs = (j && j.results) || [];
        // Prefer the taxon whose scientific name IS ours; else iNat's best guess, which
        // is the interesting answer when our name is the one that's off.
        var hit = rs.filter(function (t) { return t && t.name && t.name.toLowerCase() === k; })[0] || rs[0] || null;
        inatNamesCache[k] = hit;
        return hit;
      });
  }
  // iNat's locale code for one of the app's languages (they agree except Norwegian).
  function inatLocaleFor(code) { return ({ no: "nb" })[code] || code; }
  // The panel: our name and scientific name at the top, then EVERY app language side
  // by side — what iNaturalist calls the taxon there, and what the app itself shows.
  // The app column reads the loaded name packs, so a language whose pack has not been
  // fetched yet is a dash rather than a wrong blank; where both sides have a name and
  // they differ, the row is flagged — that is the "this name looks off" answer.
  function showInatNames(name, sci, x, y, key) {
    var el = openAnchoredMenu("detrow-menu");
    function render(inner, table) {
      el.innerHTML = "";
      var h = document.createElement("div"); h.className = "detrow-menu-hdr detrow-menu-name";
      h.textContent = name || sciBinomial(sci); el.appendChild(h);
      var sub = document.createElement("div"); sub.className = "detrow-menu-sub";
      sub.textContent = (table ? table.sciLine : sciBinomial(sci)) + " · " + t("inat.namesTitle"); el.appendChild(sub);
      el.classList.toggle("drm-names-menu", !!table);
      if (table) {
        var hint = document.createElement("div"); hint.className = "drm-names-hint";
        hint.textContent = t("inat.useLang"); el.appendChild(hint);
        var wrap = document.createElement("div"); wrap.className = "drm-names";
        // One "Name" column: iNaturalist's name (the app's own when iNaturalist has none).
        // "*" on the language code marks languages the app's own name files on this device also cover;
        // orange = the two sources disagree.
        var body = table.rows.map(function (r) {
          var local = !!(r.have && r.app);
          var differs = r.inat && local && r.inat.toLowerCase() !== r.app.toLowerCase();
          var cls = "drm-name-row" + (differs ? " drm-name-diff" : "") + (r.code === getLang() ? " drm-name-cur" : "");
          // Each row is tappable: switch the whole app to that language.
          return '<tr class="' + cls + '" data-lang="' + escapeHtml(r.code) + '" title="' + escapeHtml(t("inat.useLang")) +
            '"><td class="drm-lang">' + escapeHtml(r.code) + (local ? "*" : "") + '</td><td>' + escapeHtml(r.inat || r.app || "–") + "</td></tr>";
        }).join("");
        wrap.innerHTML = '<table class="drm-names-tbl"><thead><tr><th>' + escapeHtml(t("inat.colLang")) +
          "</th><th>" + escapeHtml(t("inat.colName")) + "</th></tr></thead><tbody>" + body + "</tbody></table>";
        el.appendChild(wrap);
        var foot = document.createElement("div"); foot.className = "drm-names-hint";
        foot.textContent = t("inat.starHint"); el.appendChild(foot);
        wrap.querySelectorAll("tr[data-lang]").forEach(function (tr) {
          tr.addEventListener("click", function (e) { e.stopPropagation(); setLang(tr.getAttribute("data-lang")); closeAnchoredMenu(); });
        });
      } else {
        var box = document.createElement("div"); box.className = "detrow-menu-info";
        inner.forEach(function (r) {
          var row = document.createElement("div"); row.className = "drm-info-row";
          row.innerHTML = (r.label ? '<span class="drm-info-k">' + escapeHtml(r.label) + "</span>" : "") +
            '<span class="drm-info-v">' + escapeHtml(r.value) + "</span>";
          box.appendChild(row);
        });
        el.appendChild(box);
      }
      positionAnchoredMenu(el, x, y);
    }
    render([{ label: "", value: t("inat.namesLoading") }]);
    inatNamesFetch(sci).then(function (hit) {
      if (!hit) { render([{ label: "", value: t("inat.namesNone") }]); return; }
      // iNat's names per locale — first one wins; banding codes ("WEWV") ride along as
      // ordinary English names there, so four-to-six capitals with no space are dropped.
      var byLoc = Object.create(null);
      (hit.names || []).forEach(function (n) {
        if (!n || !n.name || n.locale === "sci") return;
        if (/codes?$/i.test(n.lexicon || "") || /^[A-Z]{4,6}$/.test(n.name)) return;
        if (!byLoc[n.locale || ""]) byLoc[n.locale || ""] = n.name;
      });
      var taxRow = key && getTaxByCode()[key];
      var rows = (window.GeoI18N.LANGS || []).map(function (L) {
        var inat = byLoc[inatLocaleFor(L.code)] || "";
        var have = L.taxCol === "com_name" || getLoadedTaxCols()[L.taxCol] === true;   // pack fetched?
        var app = have && taxRow ? (taxRow[L.taxCol] || "") : "";
        return { code: L.code, lang: L.name, inat: inat, app: app, have: have };
      });
      render(null, { sciLine: hit.name + (hit.rank ? " (" + hit.rank + ")" : ""), rows: rows });
    }).catch(function () { render([{ label: "", value: t("inat.namesFail") }]); });
  }
  // Kew — Plants of the World Online (authoritative plant photos + info).
  function powoUrl(sci) {
    return "https://powo.science.kew.org/results?q=" + encodeURIComponent(String(sci || "").trim());
  }
  // Animal Diversity Web (mammal photos + accounts), by scientific name.
  function adwUrl(sci) {
    return "https://animaldiversity.org/search/?q=" + encodeURIComponent(String(sci || "").trim());
  }
  // NBN Atlas (UK) species search by scientific name.
  function nbnUrl(sci) { return "https://species.nbnatlas.org/search?q=" + encodeURIComponent(String(sci || "").trim()); }
  // National & regional bird sites, the single source of truth for the map
  // popups' country links. A flat [{cc, url, label}] list (cc = ISO-3166 alpha-2;
  // the pseudo-code "EU" is the Europe & Worldwide category). Curated from
  // tasks/…/important_bird_websites_europe.md. Users add/delete/block entries in
  // Settings → National databases (persisted as countryLinks / natRemoved /
  // natBlocked), so this is only the shipped default set.
  var BUILTIN_COUNTRY_LINKS = window.AppStaticData.BUILTIN_COUNTRY_LINKS;
  // Country display names for the Settings list headers (offline; falls back to
  // the raw code). WLD/EU/AME/OCE head the continental categories.
  var COUNTRY_NAMES = window.AppStaticData.COUNTRY_NAMES;
  function countryDisplayName(cc) { return COUNTRY_NAMES[String(cc || "").toUpperCase()] || cc; }
  // Category pseudo-codes (not real countries) — sorted to the end of the Settings
  // list and used to gate which "… & Worldwide" submenu a point popup shows.
  var LINK_CATEGORIES = { WLD: 1, EU: 1, AME: 1, OCE: 1 };
  var CATEGORY_ORDER = { EU: 0, AME: 1, OCE: 2, WLD: 3 };   // display order among categories
  // Which continent category a country belongs to. Europe includes the Caucasus /
  // Kazakhstan / Turkey as the source list did; the Americas cover North + Central.
  var CONTINENT_OF = {};
  ("AL AD AM AT AZ BY BE BA BG HR CY CZ DK EE FI FR GE DE GR HU IS IE IT KZ XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH TR UA GB VA").split(" ").forEach(function (c) { CONTINENT_OF[c] = "EU"; });
  ("CA US MX GL BM BZ CR SV GT HN NI PA").split(" ").forEach(function (c) { CONTINENT_OF[c] = "AME"; });
  ("AU NZ PG FJ SB VU NC PF WS TO GU PW FM KI MH").split(" ").forEach(function (c) { CONTINENT_OF[c] = "OCE"; });
  function continentFor(cc) { return CONTINENT_OF[String(cc || "").toUpperCase()] || ""; }
  function categoryLabel(cont) {
    return cont === "EU" ? t("natdb.euworld") : cont === "AME" ? t("natdb.amworld")
         : cont === "OCE" ? t("natdb.ocworld") : t("natdb.wworld");
  }
  // Links for a country's continent + the worldwide set, de-duplicated by URL and
  // minus blocked entries. Shown under one "<Continent> & Worldwide" submenu.
  function continentServices(cc) {
    var out = [], seen = {}, cont = continentFor(cc);
    function push(list) { list.forEach(function (s) { if (!seen[s.url]) { seen[s.url] = 1; out.push(s); } }); }
    if (cont) push(natServicesFor(cont));
    push(natServicesFor("WLD"));
    return out;
  }
  function urlHostLabel(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return String(u || "").slice(0, 40); }
  }
  // The shipped defaults as a flat [{cc, url, label, builtin}] list.
  function builtinCountryLinks() {
    return BUILTIN_COUNTRY_LINKS.map(function (e) { return { cc: e.cc, url: e.url, label: e.label, builtin: true }; });
  }
  function linkKey(cc, url) { return String(cc || "").toUpperCase() + "|" + url; }
  function getNatRemoved() { var m = {}; (window.GeoState.get("natRemoved", []) || []).forEach(function (k) { m[k] = 1; }); return m; }
  function getNatBlocked() { var m = {}; (window.GeoState.get("natBlocked", []) || []).forEach(function (k) { m[k] = 1; }); return m; }
  function getUserCountryLinks() { return (window.GeoState.get("countryLinks", []) || []).filter(function (e) { return e && e.cc && e.url; }); }
  // The effective national-database list: built-in defaults + the user's saved
  // additions, minus deletion tombstones (natRemoved), de-duplicated by cc+url.
  // Each entry carries { cc, url, label, builtin, blocked }; a blocked entry
  // stays in the list but is hidden from the map popups (see natServicesFor).
  function effectiveCountryLinks() {
    var removed = getNatRemoved(), blocked = getNatBlocked(), out = [], idx = {};
    function add(e, builtin) {
      var key = linkKey(e.cc, e.url);
      if (removed[key] || !e.cc || !e.url) return;
      if (key in idx) { if (e.label) out[idx[key]].label = e.label; return; }   // a user entry overrides the built-in's label (edit)
      idx[key] = out.length;
      out.push({ cc: String(e.cc).toUpperCase(), url: e.url, label: e.label || "", builtin: builtin, blocked: !!blocked[key] });
    }
    builtinCountryLinks().forEach(function (e) { add(e, true); });
    getUserCountryLinks().concat(window.GeoState.get("customCountryUrls", []) || [])
      .filter(function (c) { return c && c.cc && c.url; }).forEach(function (e) { add(e, false); });
    return out;
  }
  // A valid link scope is a 2-letter country code or a continental category code.
  function isValidLinkCc(cc) { cc = String(cc || "").toUpperCase(); return /^[A-Z]{2}$/.test(cc) || (cc in LINK_CATEGORIES); }
  function saveCountryLinks(arr) { window.GeoState.save({ countryLinks: arr }); }
  // A built-in/user entry keeps its curated label; otherwise show the hostname.
  function labelForLink(e) { return (e && e.label) ? e.label : urlHostLabel(e.url); }
  // Add a user link; clears any deletion tombstone so re-adding un-hides it.
  function addCountryLink(cc, url, label) {
    cc = String(cc || "").trim().toUpperCase(); url = linkUrl(url);   // http(s)-only
    if (!isValidLinkCc(cc) || !url) return false;
    var key = linkKey(cc, url);
    window.GeoState.save({ natRemoved: (window.GeoState.get("natRemoved", []) || []).filter(function (x) { return x !== key; }) });
    var links = getUserCountryLinks();
    if (!links.some(function (e) { return linkKey(e.cc, e.url) === key; })) {
      links.push({ cc: cc, url: url, label: String(label || "").trim() || urlHostLabel(url) });
      saveCountryLinks(links);
    }
    return true;
  }
  // Delete: tombstone the key (so built-ins stay gone across re-render / re-merge)
  // and drop any user copy + blocked flag.
  function removeCountryLink(cc, url) {
    var key = linkKey(cc, url);
    var rem = window.GeoState.get("natRemoved", []) || []; if (rem.indexOf(key) < 0) rem.push(key);
    window.GeoState.save({ natRemoved: rem });
    saveCountryLinks(getUserCountryLinks().filter(function (e) { return linkKey(e.cc, e.url) !== key; }));
    window.GeoState.save({ natBlocked: (window.GeoState.get("natBlocked", []) || []).filter(function (x) { return x !== key; }) });
  }
  // Block / unblock: keep the entry in the list but hide it from the popups.
  function toggleCountryLinkBlock(cc, url) {
    var key = linkKey(cc, url), b = window.GeoState.get("natBlocked", []) || [], i = b.indexOf(key);
    if (i >= 0) b.splice(i, 1); else b.push(key);
    window.GeoState.save({ natBlocked: b });
  }
  // Settings UI: entries grouped by country, each a static row with a block
  // toggle + delete. Blocked rows are dimmed. Built-in and user rows behave the
  // same (both blockable + deletable); "+ Add" appends user entries.
  function renderCustomUrls() {
    var list = document.getElementById("custom-urls-list"); if (!list) return;
    var byCc = {}, order = [];
    effectiveCountryLinks().forEach(function (e) {
      if (!byCc[e.cc]) { byCc[e.cc] = []; order.push(e.cc); }
      byCc[e.cc].push(e);
    });
    order.sort(function (a, b) {   // countries A–Z by name; the continental categories last
      var ca = a in LINK_CATEGORIES, cb = b in LINK_CATEGORIES;
      if (ca && cb) return CATEGORY_ORDER[a] - CATEGORY_ORDER[b];
      if (ca) return 1; if (cb) return -1;
      return countryDisplayName(a).localeCompare(countryDisplayName(b));
    });
    list.innerHTML = order.map(function (cc) {
      var rows = byCc[cc].map(function (e) {
        var blk = e.blocked, bt = t(blk ? "natdb.unblock" : "natdb.block");
        return '<div class="cu-row' + (blk ? " cu-blocked" : "") + '" data-cc="' + escapeHtml(e.cc) + '" data-url="' + escapeHtml(e.url) + '" data-label="' + escapeHtml(labelForLink(e)) + '">' +
          '<a class="cu-name" href="' + escapeHtml(safeHref(e.url)) + '" target="_blank" rel="noopener">' + escapeHtml(labelForLink(e)) + '</a>' +
          '<span class="cu-host">' + escapeHtml(urlHostLabel(e.url)) + '</span>' +
          '<button type="button" class="cu-edit" title="' + escapeHtml(t("natdb.edit")) + '" aria-label="' + escapeHtml(t("natdb.edit")) + '">✎</button>' +
          '<button type="button" class="cu-block" title="' + escapeHtml(bt) + '" aria-label="' + escapeHtml(bt) + '">' + (blk ? "🚫" : "👁") + '</button>' +
          '<button type="button" class="cu-del" title="' + escapeHtml(t("offline.delete")) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button>' +
        '</div>';
      }).join("");
      return '<div class="cu-group"><div class="cu-country">' + escapeHtml(countryDisplayName(cc)) + '</div>' + rows + '</div>';
    }).join("");
  }
  // Persist an add/edit from the link editor. `orig` is the entry being edited
  // ({cc,url,label}) or null when adding. A changed cc/url replaces the original
  // (tombstoning a built-in); an unchanged key just overrides the label.
  function saveLinkEdit(orig, cc, url, label) {
    cc = String(cc || "").trim().toUpperCase(); url = linkUrl(url);
    if (!isValidLinkCc(cc) || !url) return false;
    if (orig && (String(orig.cc).toUpperCase() !== cc || orig.url !== url)) removeCountryLink(orig.cc, orig.url);
    return addCountryLink(cc, url, label);
  }
  // The add/edit popup: one window with all fields, shared by "+ Add" (orig=null)
  // and the per-row ✎ edit icon.
  function openLinkEditor(orig) {
    var m = createModal({ boxClass: "natdb-editor", escClose: true });
    var box = m.box, close = m.close, isEdit = !!orig;
    box.innerHTML =
      '<h3>' + escapeHtml(t(isEdit ? "natdb.editTitle" : "natdb.addTitle")) + '</h3>' +
      '<label class="nle-lbl">' + escapeHtml(t("natdb.addCc")) +
        '<input id="nle-cc" type="text" maxlength="3" autocapitalize="characters" value="' + escapeHtml(orig ? orig.cc : "") + '"></label>' +
      '<label class="nle-lbl">' + escapeHtml(t("natdb.addName")) +
        '<input id="nle-name" type="text" value="' + escapeHtml(orig ? (orig.label || "") : "") + '"></label>' +
      '<label class="nle-lbl">' + escapeHtml(t("natdb.addUrl")) +
        '<input id="nle-url" type="url" value="' + escapeHtml(orig ? orig.url : "https://") + '"></label>' +
      '<div class="nle-err" id="nle-err" style="display:none"></div>' +
      '<div class="nle-actions">' +
        '<button type="button" id="nle-save" class="btn">' + escapeHtml(t("popup.ok")) + '</button>' +
        '<button type="button" id="nle-cancel" class="btn btn-light">' + escapeHtml(t("btn.close")) + '</button>' +
      '</div>';
    box.querySelector("#nle-cancel").addEventListener("click", close);
    box.querySelector("#nle-save").addEventListener("click", function () {
      var cc = box.querySelector("#nle-cc").value, name = box.querySelector("#nle-name").value, url = box.querySelector("#nle-url").value;
      if (saveLinkEdit(orig, cc, url, name)) { close(); renderCustomUrls(); }
      else { var er = box.querySelector("#nle-err"); er.textContent = t("natdb.invalid"); er.style.display = ""; }
    });
    var f = box.querySelector("#nle-cc"); if (f) f.focus();
  }
  // All national/regional links to offer for a country, from the effective list
  // minus blocked entries. Returns [{ label, url }]. When a country has no entry
  // at all, fall back to its eBird region page (eBird covers ~every country).
  function natServicesFor(cc) {
    cc = String(cc || "").toUpperCase();
    var out = effectiveCountryLinks()
      .filter(function (e) { return e.cc === cc && !e.blocked; })
      .map(function (e) { return { label: labelForLink(e), url: e.url }; });
    if (!out.length && cc !== "EU" && /^[A-Z]{2}$/.test(cc)) {
      out.push({ label: "eBird (" + cc + ")", url: "https://ebird.org/region/" + cc });
    }
    return out;
  }

  // ---- Birding blogs / resources per country --------------------------------
  // Built-in "spec": a curated starter set of long-standing birding blogs &
  // resources keyed by ISO-3166 alpha-2. (A JS object, not a YAML file — this app
  // has no parser / build step; user additions + removals live in localStorage
  // [blogLinks / blogRemoved] and sync via the Drive payload like other settings.)
  // Coverage is partial and user-curated: add/remove links per country in the UI.
  // PERSONAL blogs by individual birders only — NOT official organisations,
  // portals or directories. Seeds are blogs seen in real searches; countries
  // without a confident personal blog are left empty for users to fill in.
  // Verified active in the last ~year (checked 2026-06); dormant blogs were
  // dropped. Countries with no confirmed-active personal blog are left empty.
  var BUILTIN_BLOGS = window.AppStaticData.BUILTIN_BLOGS;
  function blogKey(cc, url) { return String(cc).toUpperCase() + "|" + url; }
  function getBlogLinks() { return (window.GeoState.get("blogLinks", []) || []).filter(function (b) { return b && b.cc && b.url; }); }
  function getBlogRemoved() { var m = {}; (window.GeoState.get("blogRemoved", []) || []).forEach(function (k) { m[k] = 1; }); return m; }
  // Effective blogs for a country: built-ins (minus user-removed) + user additions.
  function blogsFor(cc) {
    cc = String(cc || "").toUpperCase();
    var removed = getBlogRemoved(), out = [], seen = {};
    (BUILTIN_BLOGS[cc] || []).forEach(function (b) {
      var k = blogKey(cc, b.url); if (removed[k] || seen[k]) return; seen[k] = 1;
      out.push({ label: b.label, url: b.url, builtin: true });
    });
    getBlogLinks().forEach(function (b) {
      if (String(b.cc).toUpperCase() !== cc) return;
      var k = blogKey(cc, b.url); if (removed[k] || seen[k]) return; seen[k] = 1;   // a deleted user link stays deleted (tombstone)
      out.push({ label: b.label || urlHostLabel(b.url), url: b.url, builtin: false });
    });
    return out;
  }
  var blogsCC = "", blogsCountryName = "";
  function openBlogs(cc, name) {
    blogsCC = String(cc || "").toUpperCase();
    blogsCountryName = name || blogsCC;
    renderBlogs();
    bringToFront(document.getElementById("blogs-modal")).style.display = "flex";
    navOpen("blogs", function () { document.getElementById("blogs-modal").style.display = "none"; });
  }
  function renderBlogs() {
    var list = document.getElementById("blogs-list"); if (!list) return;
    var title = document.getElementById("blogs-title");
    if (title) title.textContent = t("blogs.title") + (blogsCountryName ? " · " + blogsCountryName : "");
    var blogs = blogsFor(blogsCC);
    var rows = blogs.map(function (b) {
      return '<div class="blog-row">' +
        '<a class="blog-name" href="' + escapeHtml(safeHref(b.url)) + '" target="_blank" rel="noopener">' + escapeHtml(b.label) + '</a>' +
        '<span class="blog-host">' + escapeHtml(urlHostLabel(b.url)) + '</span>' +
        '<button type="button" class="blog-del blogs-del" data-url="' + escapeHtml(b.url) + '" title="' + escapeHtml(t("offline.delete")) + '" aria-label="' + escapeHtml(t("offline.delete")) + '">×</button>' +
      '</div>';
    }).join("");
    // Always offer the respective country's blogs page on Fatbirder (a directory,
    // not deletable) so there's a fallback even where there are no personal blogs.
    var fb = '<a class="blog-fb" href="' + escapeHtml(fatbirderUrl(blogsCC, blogsCountryName)) + '" target="_blank" rel="noopener">📖 ' + escapeHtml(t("blogs.fatbirder")) + ' ↗</a>';
    var empty = blogs.length ? "" : '<p class="dd-empty blog-empty">' + escapeHtml(t("blogs.empty")) + "</p>";
    list.innerHTML = empty + rows + fb;
    list.querySelectorAll(".blogs-del").forEach(function (btn) {
      btn.addEventListener("click", function () { removeBlog(this.getAttribute("data-url")); });
    });
  }
  // Delete: always record a blogRemoved tombstone (for BOTH built-ins and user links)
  // so the delete survives a Drive sync/re-merge; also drop it from blogLinks. Re-adding
  // the same URL clears the tombstone (see addBlog).
  function removeBlog(url) {
    var k = blogKey(blogsCC, url);
    var rem = window.GeoState.get("blogRemoved", []) || []; if (rem.indexOf(k) < 0) rem.push(k);
    window.GeoState.save({ blogRemoved: rem });
    saveChecked({ blogLinks: getBlogLinks().filter(function (b) { return blogKey(b.cc, b.url) !== k; }) });
    renderBlogs();
  }
  function addBlog() {
    modalPrompt(t("blogs.addPrompt"), "https://").then(function (url) {
      url = linkUrl(url); if (!url || url === "https://") return;   // http(s)-only; drops javascript:/data:
      modalPrompt(t("blogs.namePrompt"), urlHostLabel(url)).then(function (label) {
        label = String(label || "").trim() || urlHostLabel(url);
        var links = getBlogLinks();
        if (!links.some(function (b) { return blogKey(b.cc, b.url) === blogKey(blogsCC, url); })) {
          links.push({ cc: blogsCC, url: url, label: label });
          saveChecked({ blogLinks: links });
        }
        // Re-adding a removed built-in un-hides it.
        var k = blogKey(blogsCC, url);
        window.GeoState.save({ blogRemoved: (window.GeoState.get("blogRemoved", []) || []).filter(function (x) { return x !== k; }) });
        renderBlogs();
      });
    });
  }
  // eBird species page (label keys are eBird taxon codes) — shows recent
  // sightings and a map; falls back to a search for non-code keys.
  function ebirdUrl(key, sci) {
    if (/^[a-z]/i.test(key) && !/^\d+$/.test(key)) return "https://ebird.org/species/" + encodeURIComponent(key);
    return "https://ebird.org/species/search?q=" + encodeURIComponent(String(sci || "").trim());
  }

  // Best-effort direct factsheet slug (works only when BirdLife's genus matches
  // eBird's); used as a no-JS fallback href and last resort.
  function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function birdlifeUrl(en, sci) {
    return "https://datazone.birdlife.org/species/factsheet/" + slugify(en) + "-" + slugify(sci);
  }

  // Open the species' BirdLife DataZone factsheet. BirdLife uses its own
  // taxonomy (e.g. Sandhill Crane is Grus canadensis there, Antigone canadensis
  // in eBird), so a slug built from eBird names can 404 / hit the wrong species.
  // Instead we look up the species' numeric BirdLife ID from Wikidata
  // (property P5257) and open /species/factsheet/<id>, which redirects to the
  // correct factsheet. The tab is opened synchronously (user gesture) and its
  // URL is set once the ID is fetched; falls back to the slug on any failure.
  function openBirdLife(en, sci) {
    var w = window.open("about:blank", "_blank"); try { if (w) w.opener = null; } catch (e) {}   // prevent reverse tabnabbing
    var done = false;
    var go = function (url) { if (done) return; done = true; if (w) { w.location.href = url; } else { openExternal(url); } };
    var fallback = birdlifeUrl(en, sci);
    setTimeout(function () { go(fallback); }, 6000);   // don't leave a blank tab if Wikidata is slow
    var wd = "https://www.wikidata.org/w/api.php?origin=*&format=json&action=";
    fetch(wd + "wbsearchentities&type=item&language=en&search=" + encodeURIComponent(sci))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var qid = s.search && s.search[0] && s.search[0].id;
        if (!qid) { go(fallback); return; }
        return fetch(wd + "wbgetclaims&property=P5257&entity=" + qid)
          .then(function (r) { return r.json(); })
          .then(function (c) {
            var cl = c.claims && c.claims.P5257;
            var v = cl && cl[0] && cl[0].mainsnak.datavalue && cl[0].mainsnak.datavalue.value;
            go(v ? "https://datazone.birdlife.org/species/factsheet/" + encodeURIComponent(v) : fallback);
          });
      })
      .catch(function () { go(fallback); });
  }

  return {
    init: init,
    sciBinomial: sciBinomial,
    wikipediaUrl: wikipediaUrl,
    openWikipedia: openWikipedia,
    macaulayUrl: macaulayUrl,
    xenoCantoUrl: xenoCantoUrl,
    inatLocaleFor: inatLocaleFor,
    showInatNames: showInatNames,
    powoUrl: powoUrl,
    adwUrl: adwUrl,
    nbnUrl: nbnUrl,
    countryDisplayName: countryDisplayName,
    continentFor: continentFor,
    categoryLabel: categoryLabel,
    continentServices: continentServices,
    effectiveCountryLinks: effectiveCountryLinks,
    addCountryLink: addCountryLink,
    removeCountryLink: removeCountryLink,
    toggleCountryLinkBlock: toggleCountryLinkBlock,
    renderCustomUrls: renderCustomUrls,
    openLinkEditor: openLinkEditor,
    natServicesFor: natServicesFor,
    blogsFor: blogsFor,
    openBlogs: openBlogs,
    renderBlogs: renderBlogs,
    addBlog: addBlog,
    ebirdUrl: ebirdUrl,
    birdlifeUrl: birdlifeUrl,
    openBirdLife: openBirdLife,
  };
})();
