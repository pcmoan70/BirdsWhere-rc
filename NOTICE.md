# NOTICE — what is free and what is not

_Updated 2026-10-24. This notice is binding and travels with every copy of the repository._

## 1. The code is public domain (CC0 1.0)

The application code in this repository (`app/**` and the tooling, except the third-party
components listed in `THIRD-PARTY-NOTICES.md`) is dedicated to the public domain under
**CC0 1.0 Universal** — see `LICENSE`. Copy it, change it, sell it, ship it: no permission, no
attribution, no share-alike, no warranty. Where a true public-domain dedication is not possible,
CC0 grants an unconditional, royalty-free licence instead.

## 2. The brand, the domain and the service are PROPRIETARY

The CC0 dedication covers **code only**. The following are **not** licensed, dedicated or waived in
any way and remain the exclusive property of the author, with all rights reserved:

- **The name "BirdsWhere"**, its logo, icons, artwork and the look that identifies the app.
  CC0 §4(a) expressly excludes trademark rights, and none are granted here.
- **The domain `thebirding.site`** and every URL under it (including the `/f/…` short links and
  the `-rc` preview site).
- **The service's endpoints**: the hosted site itself, its visit and poster-scan counters, the
  contact-form relay, the Google sign-in (OAuth) client registered for thebirding.site, and every
  API key, token or credential configured for the hosted service. Nothing in this repository grants
  a right to call, reuse or impersonate any of them.

**If you fork or redistribute:** give your copy its own name, icons and domain; register your own
API keys and sign-in client; do not present it as BirdsWhere or as endorsed by, affiliated with or
connected to BirdsWhere or thebirding.site; do not point it at the service's endpoints.

## 3. The app's own generated datasets are COPYRIGHTED — all rights reserved

Several datasets shipped with the app were produced by the author's own pipelines in other
projects and are **not** part of the CC0 dedication. They are **© 2026 Per Christian Moan, all
rights reserved**, and are redistributed in this repository solely so that the app can display them:

| files | what they are |
|---|---|
| `app/best-sites/**`, `app/best-sites-week/**`, `app/coverage.html` | the Best sites overlay: ~276k ranked birding sites with 53-week profiles at three detail levels, and their coverage map, derived from 236.8 million GBIF bird occurrences 2010–2026 |
| `app/confusion.csv`, `app/species-traits.json` | the confusion-species lists (the misID model's Match / misID partners) and the per-species trait table behind the compare card |
| `app/owl_network/**` | the owl-observer network page and its data |

You may look at them through the app. You may **not** extract, copy, redistribute, re-host, mine or
build on these datasets, in whole or in part, without the author's written permission — the CC0
licence of the code does not reach them. The underlying facts remain subject to their sources'
terms (GBIF and its publishers, AVONET CC BY 4.0, iNaturalist, HBW-RGB — see
`THIRD-PARTY-NOTICES.md`). The birding-spots data (`app/birding-spots/**`,
`app/birding-spots.json`) is extracted from OpenStreetMap and stays under the ODbL,
© OpenStreetMap contributors.

## 4. Third-party components keep their own terms

The bundled BirdNET Geomodel weights are **CC BY-SA 4.0** (attribution and share-alike apply to
them, and their licence forbids use for poaching or any military purpose). Leaflet, ONNX Runtime
Web, h3-js, the datasets and the map tiles each carry their own licences, listed in
`THIRD-PARTY-NOTICES.md`. The observations the app shows belong to their providers (eBird, GBIF,
iNaturalist, Artsdatabanken, SLU Artdatabanken, FinBIF, BirdWeather, Observation.org …) and are
subject to each provider's terms and API rules.

## 5. Terms of use of the hosted service (thebirding.site)

1. **As is.** The service is provided free of charge, without any warranty, and may change, break
   or stop at any time without notice. The author is not liable for any loss arising from its use.
2. **No account, no server.** The app runs in your browser; your lists, settings and points stay on
   your device unless you choose to sync them to your own Google Drive.
3. **Data providers' rules apply.** Observations, model predictions and map tiles come from third
   parties; by using the service you accept their terms, rate limits and attribution requirements.
   Model output is a probabilistic prediction, not a confirmed observation.
4. **Responsible use.** Do not use the service to disturb wildlife, to locate sensitive species for
   harm, or for poaching or any military purpose. Respect protected areas, private land and local
   rules.
5. **Fair use of the service.** Automated access, scraping of the hosted endpoints or of the
   datasets in section 3, reuse of its keys or counters, and anything that impersonates the service
   are not permitted.
6. **Changes.** These terms may be updated; the current version is this file in the public repository
   and the *Credits & licence* section inside the app.
