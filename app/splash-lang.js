// The boot splash paints BEFORE app.js runs, so it cannot use GeoI18N (whose language
// packs are fetched on demand). One word in the app's 15 UI languages, honouring the same
// two inputs setLang() uses: the saved choice ("system" or a code) from the same
// (RC-suffixed) localStorage key GeoState owns, else the device's preferred languages.
// Also sets <html lang> straight away, which otherwise stayed "en" until init finished.
//
// A SEPARATE FILE, not inline: the page's CSP is script-src 'self' with no
// 'unsafe-inline', deliberately — an inline script here would simply be blocked, and
// weakening the policy for one word is not a trade worth making.
(function () {
  var T = { en: "Loading\u2026", no: "Laster\u2026", sv: "L\u00e4ser in\u2026", da: "Indl\u00e6ser\u2026",
            fi: "Ladataan\u2026", de: "L\u00e4dt\u2026", nl: "Laden\u2026", fr: "Chargement\u2026",
            es: "Cargando\u2026", pt: "A carregar\u2026", it: "Caricamento\u2026", pl: "Wczytywanie\u2026",
            cs: "Nahr\u00e1v\u00e1n\u00ed\u2026", et: "Laadimine\u2026", lt: "\u012Ekeliama\u2026" };
  function saved() {
    try {
      var k = "geomodel-explorer-v1" + (/-rc\//i.test(location.pathname) ? "-rc" : "");
      var v = JSON.parse(localStorage.getItem(k) || "{}").lang;
      return (v && v !== "system") ? String(v) : "";
    } catch (e) { return ""; }
  }
  function fromDevice() {
    var c = [];
    try {
      if (navigator.languages && navigator.languages.length) c = navigator.languages.slice();
      else if (navigator.language) c = [navigator.language];
    } catch (e) {}
    for (var i = 0; i < c.length; i++) {
      var b = String(c[i] || "").toLowerCase().split("-")[0];
      if (b === "nb" || b === "nn") b = "no";        // Bokm\u00e5l / Nynorsk \u2192 "no"
      if (T[b]) return b;
    }
    return "en";
  }
  var code = saved();
  if (!T[code]) code = fromDevice();
  try { document.documentElement.setAttribute("lang", code); } catch (e) {}
  var el = document.getElementById("boot-splash-txt");
  if (el && T[code]) el.textContent = T[code];
})();
  
