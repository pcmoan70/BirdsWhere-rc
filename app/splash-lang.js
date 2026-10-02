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
  // What the boot is doing right now, named (owner, 2026-10-02: "Laster… should say what
  // exactly it is loading"): app.js calls window.bootPhase(<key>) as it goes.
  var P = {
    en: { lists: "Restoring your lists\u2026", obs: "Restoring saved observations\u2026", model: "Loading the species model and names\u2026", map: "Drawing the map\u2026" },
    no: { lists: "Henter listene dine\u2026", obs: "Henter lagrede observasjoner\u2026", model: "Laster artsmodellen og artsnavnene\u2026", map: "Tegner kartet\u2026" },
    sv: { lists: "H\u00e4mtar dina listor\u2026", obs: "H\u00e4mtar sparade observationer\u2026", model: "L\u00e4ser in artmodellen och artnamnen\u2026", map: "Ritar kartan\u2026" },
    da: { lists: "Henter dine lister\u2026", obs: "Henter gemte observationer\u2026", model: "Indl\u00e6ser artsmodellen og artsnavnene\u2026", map: "Tegner kortet\u2026" },
    fi: { lists: "Palautetaan listasi\u2026", obs: "Palautetaan tallennetut havainnot\u2026", model: "Ladataan lajimallia ja lajinimi\u00e4\u2026", map: "Piirret\u00e4\u00e4n karttaa\u2026" },
    de: { lists: "Deine Listen werden geladen\u2026", obs: "Gespeicherte Beobachtungen werden geladen\u2026", model: "Artenmodell und Artnamen werden geladen\u2026", map: "Karte wird gezeichnet\u2026" },
    nl: { lists: "Je lijsten worden geladen\u2026", obs: "Opgeslagen waarnemingen worden geladen\u2026", model: "Soortenmodel en soortnamen worden geladen\u2026", map: "Kaart wordt getekend\u2026" },
    fr: { lists: "Chargement de vos listes\u2026", obs: "Chargement des observations enregistr\u00e9es\u2026", model: "Chargement du mod\u00e8le et des noms d\u2019esp\u00e8ces\u2026", map: "Dessin de la carte\u2026" },
    es: { lists: "Cargando tus listas\u2026", obs: "Cargando observaciones guardadas\u2026", model: "Cargando el modelo y los nombres de especies\u2026", map: "Dibujando el mapa\u2026" },
    pt: { lists: "A carregar as suas listas\u2026", obs: "A carregar observa\u00e7\u00f5es guardadas\u2026", model: "A carregar o modelo e os nomes das esp\u00e9cies\u2026", map: "A desenhar o mapa\u2026" },
    it: { lists: "Caricamento delle tue liste\u2026", obs: "Caricamento delle osservazioni salvate\u2026", model: "Caricamento del modello e dei nomi delle specie\u2026", map: "Disegno della mappa\u2026" },
    pl: { lists: "Wczytywanie Twoich list\u2026", obs: "Wczytywanie zapisanych obserwacji\u2026", model: "Wczytywanie modelu i nazw gatunk\u00f3w\u2026", map: "Rysowanie mapy\u2026" },
    cs: { lists: "Na\u010d\u00edt\u00e1n\u00ed va\u0161ich seznam\u016f\u2026", obs: "Na\u010d\u00edt\u00e1n\u00ed ulo\u017een\u00fdch pozorov\u00e1n\u00ed\u2026", model: "Na\u010d\u00edt\u00e1n\u00ed modelu a n\u00e1zv\u016f druh\u016f\u2026", map: "Vykreslov\u00e1n\u00ed mapy\u2026" },
    et: { lists: "Sinu nimekirjade laadimine\u2026", obs: "Salvestatud vaatluste laadimine\u2026", model: "Liigimudeli ja liiginimede laadimine\u2026", map: "Kaardi joonistamine\u2026" },
    lt: { lists: "\u012ekeliami j\u016bs\u0173 s\u0105ra\u0161ai\u2026", obs: "\u012ekeliami i\u0161saugoti steb\u0117jimai\u2026", model: "\u012ekeliamas r\u016b\u0161i\u0173 modelis ir pavadinimai\u2026", map: "Brai\u017eomas \u017eem\u0117lapis\u2026" }
  };
  var code = saved();
  if (!T[code]) code = fromDevice();
  try { document.documentElement.setAttribute("lang", code); } catch (e) {}
  var el = document.getElementById("boot-splash-txt");
  if (el && T[code]) el.textContent = T[code];
  window.bootPhase = function (key) {
    var txt = (P[code] && P[code][key]) || (P.en[key]) || T[code];
    var e1 = document.getElementById("boot-splash-txt"); if (e1) e1.textContent = txt;
    var e2 = document.querySelector("#app-loading span"); if (e2) e2.textContent = txt;
  };
})();
  
