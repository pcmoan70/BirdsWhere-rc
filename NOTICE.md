# NOTICE — definitions, dedication, reservations, terms of use

_Version 2026-10-24 (v2185). This file is the defining text. The LICENSE header, the README and the
in-app "Credits & licence" text are summaries of it; where they differ, this file governs. It does not
and cannot restrict the Code (section 2): it states what the dedication does **not** cover (section 3)
and the terms of the hosted service (section 5)._

## 1. Definitions

Every file in this repository belongs to exactly one of these classes.

- **"Code"** — all files in the repository except the Brand Assets, the Reserved Datasets and the
  Third-Party Components defined below. It includes `app/**` (HTML, JavaScript, CSS, the service
  worker, the UI-string packs under `app/i18n/lang/`, the about pages), `deploy.sh`, the GitHub
  workflow, and the documentation files (`README.md`, `CHANGES.md`).
- **"Brand Assets"** — the name **BirdsWhere**, the name **thebirding.site**, and these files:
  `app/icon.svg`, `app/icon-192.png`, `app/icon-512.png`, `app/apple-touch-icon.png`,
  `app/qr-app.svg`, and the `name` / `short_name` values in `app/manifest.webmanifest`.
- **"Service Identifiers"** — the hosted service and the exact identifiers that address or
  authenticate it:
  - the hosts `thebirding.site`, `www.thebirding.site`, `pcmoan70.github.io/BirdsWhere` and
    `pcmoan70.github.io/BirdsWhere-rc`, and every path under them (including `/f/…` short links);
  - the hit-counter namespace `thebirding.site` at `abacus.jasoncameron.dev` (keys `page-visits`,
    `poster-scans`);
  - the EmailJS relay public key `-5S2PctOrxEViV5Pf`, service `service_1wr4am1` and template
    `template_2qq926a`;
  - the Google OAuth client `309967713424-o0vgr5cgb1t8bvc9pk78br2mmo4v8kkm.apps.googleusercontent.com`;
  - the site-verification file `app/google93f4faba0f13b05e.html`;
  - any API key, token or credential configured for the hosted service now or later.
- **"Reserved Datasets"** — these paths, produced by the author's own pipelines:
  `app/best-sites/**`, `app/best-sites-week/**`, `app/coverage.html`, `app/confusion.csv`,
  `app/species-traits.json`.
- **"Third-Party Components"** — everything listed in `THIRD-PARTY-NOTICES.md`: `app/vendor/**`,
  the BirdNET Geomodel weights and labels (`app/geomodel_fp16.onnx`, `app/labels.txt`,
  `app/model-compare/**`), the taxonomy and name files derived from third-party lists, the
  birding-spots extracts from OpenStreetMap (`app/birding-spots/**`, `app/birding-spots.json`),
  and the map tiles and observations fetched at run time.

## 2. Dedication: the Code is public domain (CC0 1.0 Universal)

The Code is dedicated to the public domain under CC0 1.0 Universal (`LICENSE`), without
conditions. Where a dedication is not effective, CC0 grants an unconditional, irrevocable,
royalty-free licence instead.

**Request, not a condition.** The Code was written by AI; that is why it is dedicated rather than
licensed. The idea, the concept and the user-interface design are Per Christian Moan's own work.
Nothing obliges you to credit him, but if you build on BirdsWhere, this line would be appreciated:
*"Based on BirdsWhere by Per Christian Moan — thebirding.site"*.

## 3. Reservations: what the dedication does not cover

1. **Brand Assets** — all trademark and copyright rights reserved (CC0 §4(a) excludes trademark
   rights). No right to use them is granted. A copy or derivative of the Code must not use the
   name BirdsWhere or thebirding.site, the icon files, or anything confusingly similar, and must
   not present itself as BirdsWhere or as endorsed by, affiliated with or connected to it.
2. **Service Identifiers** — all rights reserved. No right to call, reuse, embed, proxy or
   impersonate the hosted service or any identifier above is granted. A copy or derivative of the
   Code must replace them with its own hosts, counters, relay and sign-in client, or remove the
   features that use them.
3. **Reserved Datasets** — **© 2026 Per Christian Moan, all rights reserved.** They are present in
   this repository only so that the hosted service can display them. No licence is granted to
   copy, extract, redistribute, re-host, mine, train on or build on them, in whole or in part. A
   copy or derivative of the Code that is redistributed or hosted must **delete these paths** unless
   the author has licensed them in writing. The underlying facts remain subject to their sources'
   terms (GBIF and its publishers, AVONET CC BY 4.0, iNaturalist, HBW-RGB).
4. **Third-Party Components** — each keeps its own licence as listed in `THIRD-PARTY-NOTICES.md`;
   the dedication does not touch them. The BirdNET Geomodel weights are CC BY-SA 4.0 and their
   licence forbids use for poaching or any military purpose.

## 4. No warranty

The Code, the Reserved Datasets and the hosted service are provided "as is", without warranty of
any kind. Model output is a probabilistic prediction, not a confirmed observation.

## 5. Terms of use of the hosted service (thebirding.site)

By using the hosted service you agree to these terms.

1. **Free, as is, may stop.** The service is free of charge, carries no warranty, and may change,
   break or stop at any time without notice. To the extent permitted by law the author is not
   liable for any loss arising from its use.
2. **No account, no server.** The app runs in your browser; your lists, settings and points stay on
   your device unless you sync them to your own Google Drive.
3. **Providers' rules apply.** Observations, predictions and map tiles come from third parties; you
   accept their terms, rate limits and attribution requirements when you use them through the service.
4. **Responsible use.** Do not use the service to disturb wildlife, to locate sensitive species for
   harm, or for poaching or any military purpose. Respect protected areas, private land and local
   rules.
5. **No automated or derivative use of the service.** Automated access, scraping of the hosted site
   or of the Reserved Datasets, reuse of the Service Identifiers, and anything that impersonates the
   service are not permitted.
6. **Governing law.** These terms are governed by the laws of Norway; disputes go to the Norwegian
   courts.
7. **Contact and changes.** Questions and licence requests go through the app's contact form (How
   it works → Contact). These terms may change; the current version is this file in the public
   repository.
