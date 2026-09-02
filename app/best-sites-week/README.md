# Best birding sites per week — Europe (GBIF)

Weekly ranking of birding locations across Europe, answering **"where should I go birding this
week?"** for any ISO week 1–53. Derived from **236.8 million GBIF bird observations** (2010–2026)
across **30 countries and territories**. Built 2026-08-18.

This folder holds the **app-servable subset only**. The full dataset — SQLite, CSV, the combined
45 MB JSON and a standalone Leaflet map — lives at `../../GBID_best_sites_week/`, whose `README.md`
is the fuller reference. The pipeline itself is in the `Artsdata` repo
(`src/gbif_*.py`, `tasks/gbif_northern_europe_20260818.md`).

---

## 1. Files here

| file | size | what it is |
|---|---:|---|
| `sites.json` | 4.8 MB | the site table — fetch **once**, cacheable |
| `week-01.json` … `week-53.json` | 0.4–1.0 MB each | one ISO week of ranked sites |

Split per week on purpose: this app is 100 % in-browser with no backend, and only ever needs the
current week. Loading the combined file instead would mean 45 MB on page open.

```js
const {sites} = await (await fetch('best-sites-week/sites.json')).json();   // once
const wk = isoWeek(new Date());                                            // 1..53
const {best} = await (await fetch(
  `best-sites-week/week-${String(wk).padStart(2,'0')}.json`)).json();
const rows = best.map(r => ({...r, ...sites[r.site]}));   // adds lat/lon/name/country/cell
```

`sites.json` is `{ "meta": {...}, "sites": [ ... ] }`; each week file is
`{ "week": 34, "sites_file": "sites.json", "best": [ ... ] }`. Week rows reference sites by array
index, so they stay small. `meta` records every build parameter, so the data is self-describing.

```jsonc
// sites[i]
{ "lat": 52.24495, "lon": 1.61499, "name": "Minsmere RSPB", "country": "GB",
  "cell": [149, 130],           // 25 km stratification cell (EPSG:3035 / 25000)
  "observations": 658, "observers": 65, "species": 114 }

// best[j]
{ "site": 18728, "rank": 1, "rank_cell": 1, "score": 6.056,
  "species_per_visit": 45.0,    // what one real birding visit is likely to yield
  "species": 100,               // distinct species ever recorded there that week
  "visits": 7, "visits_scored": 4, "observers": 2, "years": 3,
  "seasonality": 7.07,          // x the site's own annual average
  "top_species": "..." }
```

**32 868 sites, 140 527 ranked site-weeks.**

---

## 2. What the data means

### A site is a reported coordinate, rounded to 100 m

Not a grid cell, not a place name — the coordinates observers actually used, rounded onto a 100 m
grid so the same spot reported with slightly different GPS readings becomes one site. Each site sits
on a **real observed coordinate**: the busiest actual `(lat, lon)` in its square, not the square's
centre. Rounding is done in EPSG:3035 metres, so 100 m is 100 m on both axes from Brittany to
Svalbard.

`name` is a display label only (most-reported locality string, else `"lat, lon"`).
**The coordinate is the identity.**

### Coverage is uniform per 25 km cell

Two nested rules, both on the same 25 × 25 km equal-area grid:

1. **Selection** — sites ranked by observation count within each cell, top 3 deciles kept
   (24.4 M distinct coordinates → 7.86 M 100 m sites → **1 317 613 kept**, 9 766 populated cells).
2. **Export** — each week keeps the Europe-wide top 1 000 **plus `rank_cell = 1`**, the best site
   in every populated cell.

Rule 2 is what keeps coverage even. A Europe-wide top-N alone gives nearly every slot to the
data-rich countries (GB 3 239 sites vs Moldova 2). With it: **1.0–14.2 sites per populated cell,
median 4.2**, all 30 territories present.

`rank` = Europe-wide position that week. `rank_cell` = position inside the site's own cell. Use
`cell` to re-stratify — e.g. best site per cell within 100 km of the user.

Observations at coordinates that did not survive selection are **snapped to the highest-count
surviving site within 500 m**, so their species and visits still count: **97.8 % of all 236.8 M
observations are attributed**.

### The score

Four components, each **z-scored within the ISO week** so weeks stay comparable and the score means
*"good for this week"*, not *"good in absolute terms"*:

| component | meaning | weight |
|---|---|---:|
| `species_per_visit` | expected species from one proper birding visit, empirical-Bayes shrunk toward the week's regional mean (K = 3) | 0.35 |
| `breadth` | `ln(1 + species)` — the species pool available there that week | 0.30 |
| `seasonality` | `species_per_visit` ÷ the site's own annual average — is this its peak week? | 0.20 |
| `activity` | `ln(1 + visits)` — coverage/popularity | **0.00** |

**`activity` is weight zero on purpose.** Raw counts mostly measure observer effort, not bird
quality; ranking on them just rediscovers cities.

**`species_per_visit` averages only the best half of visits.** Most "visits" here are incidental
one- or two-species records, not birding trips, so averaging all of them understates a site.
Visits are ranked by species recorded and only the top half averaged (+40 % on Latvian data,
+52 % on Norwegian). `visits` is all visits, `visits_scored` the half actually averaged.

**`rank` is only meaningful within a week.**

---

## 3. Provenance

Aves, 2010–2026, with coordinates. Box **48–81 °N, −11.288799–33 °E**, plus the Nordic countries in
full (they extend past it; Iceland lies west of it).

SE 65.7 M · GB 45.8 M · NO 27.4 M · DK 22.5 M · DE 21.8 M · FR 10.6 M · NL 9.7 M · FI 7.6 M ·
BE 6.6 M · PL 3.6 M · CZ 3.6 M · EE 2.7 M · IE 2.1 M · IS 1.5 M · LU 0.87 M · plus RU, SK, UA, AT,
LT, IM, BY, LV, SJ, AX, FO, JE, HU, GG, MD.

Southern edges are cut by the 48 °N line (FR, DE, AT, HU, UA, MD partly covered); **Switzerland is
absent entirely** — its northern tip is 47.8 °N.

**GBIF requires citing the data.** DOIs: `10.15468/dl.pd37z4` (NL/BE/LU), `10.15468/dl.8hc2xn`
(GB/IE/IM/JE/GG), `10.15468/dl.ncb8e7` (DE/FR), `10.15468/dl.6cdsn5` (PL/CZ/SK/AT/HU/RU/UA/BY/MD),
`10.15468/dl.ajnacb` (IS/AX/SJ/FO), `10.15468/dl.an2zx6` and `10.15468/dl.g5psgr` (2026 top-ups).
The Nordic/Baltic country archives carry their own DOIs in each archive's `metadata.xml`.

---

## 4. Limitations

1. **NL and BE are under-represented, by design.** Their records are mostly grid-aggregated —
   51.0 M at exactly 5 000 m coordinate uncertainty, 10.8 M at 3 536 m (2500·√2, a 5 km square's
   half-diagonal). Only 4.2 M of the Netherlands' 60.8 M records are precise to ≤ 2 km. A 5 km
   record cannot be placed on a 100 m site, so they are dropped; NL/BE appear via their precise
   subset (9.7 M and 6.6 M records). Records with a *null* uncertainty are kept, since ~90 % of
   records region-wide omit the field.
2. **Large reserves split across sites.** Snapping only absorbs coordinates that did *not* survive
   truncation, so two surviving points 800 m apart stay separate — Minsmere appears twice,
   Helgoland three times. Near-duplicates in a top-N list are expected.
3. **Effort bias reduced, not removed.** GBIF carries no checklist effort; `eventID` is only ~19 %
   populated for Aves, so `visits` are reconstructed as `(site, date, observer)`.
4. **Some top sites are not visitable.** A ≥ 3-observer gate removes private gardens (street
   addresses do appear as localities) and most single-observer spots, but not all — a closed
   seabird island still ranked in an earlier build. **Check access before travelling.**
5. **Historical, not predictive.** Where birds *have been* that week over 2010–2026 — no weather,
   no current season.
6. **No rarity term.** GBIF carries no national red-list status.
7. **Country totals track covered area, not importance.** Moldova has 3 sites because only 3 of its
   25 km cells fall inside the box and clear the reliability gate (≥ 5 visits, ≥ 3 years,
   ≥ 3 observers).
8. **Week 53** exists only in some years and rests on less data.

---

## 5. Validation

The ranking reproduces the canonical sites without being told about any of them: **week 20**
Minsmere RSPB (rank 1), Biebrza NP, Kabli ringing station, Helsinki–Vanhankaupunginlahti, Texel;
**week 34** Højer Sluse, Ottenby, Falsterbo–Nabben, Sõrve, Rutland Water, Titchwell Marsh, Spurn;
**week 41** Ile de Sein, Ouessant and Baie des Trépassés (peak Brittany vagrant season), Helgoland,
Schiermonnikoog, Dueodde.

---

## 6. Not yet wired into the app

These are data files only — nothing in `app.js` or `sw.js` references them yet. To make the app use
them, following the pattern already used by `birding-spots/`:

- `sw.js`: add `best-sites-week/sites.json` to the precache list (near the existing
  `"birding-spots/index.json"`), and add `/\/best-sites-week\//` to the runtime rule that routes
  tiles into the persistent data cache, so weeks are cached offline once visited.
- Bump `DATA_REV` in `sw.js` (currently `d1`) when these data files change, and `VERSION`
  (currently `v1207`) on any user-visible change — otherwise returning users keep the stale cache.
- `files.json` regenerates automatically via the `.githooks/pre-commit` hook.

**Size note:** this folder is 44 MB. `docs/` is the GitHub Pages deploy root, so everything here
ships to the live site.
