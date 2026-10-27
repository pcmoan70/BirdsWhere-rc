# How well does the "sounds like" table work?

_Generated 2026-10-27 from the BirdsWhere sound pipeline. Numbers only; the recordings themselves stay with their recordists on Xeno-canto._

## What the table is

For every species the app knows, the table lists the eight species a sound-recognition model finds closest by ear. It was built from Xeno-canto recordings (grade A, and grade B where a species had no A-grade material left), cut into 5-second windows at 32 kHz. Each window was scored by BirdNET+ V3.0 (preview 3.1) and by Perch 2.0; a window counts only if the model gives the labelled species at least 20 %. The BirdNET model's kept windows feed the table: a species' centroid embedding and its soft confusion (how much of the model's probability lands on other species) are rank-averaged into one closeness score. Species with fewer than three kept windows get no sound entry and fall back to the app's range-based closeness.

## Coverage

Species in the app: 11843 (10292 birds). With a Xeno-canto recording of grade A or B: 9801. With files scored: 9796. With a sound entry (≥ 3 kept windows): 7475. Falling back: 4368.

### By region of the recordings

| region | species | any A-grade | any A or B | recordings / species | sound entry | ≥ 10 kept windows |
|---|---|---|---|---|---|---|
| Europe | 421 | 99 % | 100 % | 540.1 | 94 % | 89 % |
| North America | 979 | 95 % | 100 % | 87.7 | 90 % | 81 % |
| South America | 3182 | 96 % | 100 % | 51.3 | 85 % | 73 % |
| Africa | 1747 | 89 % | 100 % | 25.6 | 65 % | 52 % |
| Asia | 1477 | 93 % | 100 % | 42.2 | 80 % | 67 % |
| Oceania | 1916 | 85 % | 100 % | 21.2 | 60 % | 48 % |
| Antarctica | 9 | 89 % | 100 % | 12.0 | 56 % | 22 % |
| unknown | 70 | 70 % | 100 % | 25.6 | 29 % | 21 % |
| no recordings | 2042 | 0 % | 0 % | 0.0 | 0 % | 0 % |

### By class

| class | species | any A-grade | any A or B | recordings / species | sound entry | ≥ 10 kept windows |
|---|---|---|---|---|---|---|
| aves | 10292 | 88 % | 95 % | 60.8 | 73 % | 61 % |
| mammalia | 535 | 0 % | 0 % | 0.0 | 0 % | 0 % |
| insecta | 524 | 0 % | 0 % | 0.0 | 0 % | 0 % |
| amphibia | 481 | 0 % | 0 % | 0.0 | 0 % | 0 % |
| reptilia | 11 | 0 % | 0 % | 0.0 | 0 % | 0 % |

The archive used (Xeno-canto's bird collection) holds no mammal, insect, amphibian or reptile recordings, so those species always fall back.

### Bird families with the thinnest coverage (≥ 15 species, by share with a sound entry)

| family | species | any A-grade | any A or B | recordings / species | sound entry | ≥ 10 kept windows |
|---|---|---|---|---|---|---|
| Phalacrocoracidae | 28 | 57 % | 86 % | 16.9 | 11 % | 11 % |
| Ciconiidae | 16 | 62 % | 75 % | 15.8 | 25 % | 19 % |
| Dicaeidae | 42 | 64 % | 98 % | 21.9 | 33 % | 24 % |
| Viduidae | 18 | 67 % | 89 % | 10.6 | 33 % | 17 % |
| Hydrobatidae | 17 | 88 % | 88 % | 10.6 | 35 % | 24 % |
| Procellariidae | 72 | 72 % | 86 % | 14.4 | 36 % | 25 % |
| (no family on record) | 82 | 60 % | 70 % | 18.2 | 37 % | 24 % |
| Apodidae | 96 | 64 % | 92 % | 20.3 | 38 % | 29 % |
| Diomedeidae | 16 | 81 % | 94 % | 15.6 | 38 % | 19 % |
| Zosteropidae | 129 | 63 % | 92 % | 14.7 | 40 % | 32 % |
| Estrildidae | 120 | 62 % | 85 % | 12.8 | 40 % | 23 % |
| Otididae | 20 | 80 % | 80 % | 16.7 | 40 % | 30 % |
| Megapodiidae | 18 | 89 % | 89 % | 15.9 | 44 % | 28 % |
| Ptilonorhynchidae | 22 | 73 % | 91 % | 18.5 | 45 % | 32 % |
| Sturnidae | 112 | 73 % | 86 % | 34.8 | 47 % | 37 % |

## Detection accuracy (the window filter)

Every recording is labelled by its recordist, so the labelled species is present. Recall = share of a species' windows where the model gives it ≥ 20 % (the rest are silence, other species or the model not recognising it: the false negatives of the filter). Label on top = share of kept windows where the labelled species is the model's first choice. Another species ≥ 20 % = share of kept windows where some other species also scores ≥ 20 % (background birds, or a false positive). Held-out = leave one recording out, is its own species the nearest centroid (false negatives of "sounds like" at the species level).

### All species with a sound entry

| class | species | recall | label on top | another species ≥ 20 % | held-out top-1 | held-out top-8 |
|---|---|---|---|---|---|---|
| aves | 7474 | 54 % | 90 % | 34 % | 75 % | 91 % |
| amphibia | 1 | 100 % | 100 % | 90 % | – | – |

### By region

| region | species | recall | label on top | another species ≥ 20 % | held-out top-1 | held-out top-8 |
|---|---|---|---|---|---|---|
| Europe | 395 | 65 % | 91 % | 40 % | 81 % | 93 % |
| North America | 883 | 64 % | 87 % | 51 % | 76 % | 91 % |
| South America | 2697 | 56 % | 88 % | 39 % | 73 % | 89 % |
| Africa | 1136 | 49 % | 95 % | 17 % | 75 % | 91 % |
| Asia | 1184 | 52 % | 91 % | 28 % | 74 % | 91 % |
| Oceania | 1155 | 47 % | 93 % | 23 % | 77 % | 92 % |

### By bird family (families with ≥ 15 species in the table, lowest held-out top-1 first)

| family | species | recall | label on top | another species ≥ 20 % | held-out top-1 | held-out top-8 |
|---|---|---|---|---|---|---|
| Cracidae | 44 | 58 % | 86 % | 41 % | 58 % | 81 % |
| Dicruridae | 18 | 43 % | 92 % | 22 % | 58 % | 76 % |
| Laniidae | 26 | 30 % | 87 % | 35 % | 62 % | 87 % |
| Ploceidae | 45 | 29 % | 91 % | 26 % | 63 % | 89 % |
| Podicipedidae | 16 | 47 % | 87 % | 38 % | 64 % | 88 % |
| Polioptilidae | 17 | 65 % | 86 % | 45 % | 65 % | 88 % |
| Meliphagidae | 97 | 44 % | 92 % | 27 % | 66 % | 88 % |
| Icteridae | 90 | 48 % | 85 % | 49 % | 67 % | 86 % |
| Troglodytidae | 87 | 60 % | 90 % | 41 % | 67 % | 85 % |
| Nectariniidae | 80 | 42 % | 96 % | 16 % | 67 % | 88 % |
| Malaconotidae | 37 | 61 % | 94 % | 19 % | 67 % | 88 % |
| Ramphastidae | 33 | 73 % | 85 % | 41 % | 68 % | 91 % |
| Pachycephalidae | 31 | 35 % | 89 % | 29 % | 68 % | 87 % |
| Picidae | 168 | 44 % | 87 % | 41 % | 69 % | 89 % |
| Monarchidae | 50 | 40 % | 90 % | 30 % | 69 % | 86 % |
| (no family on record) | 30 | 43 % | 85 % | 35 % | 69 % | 87 % |
| Mimidae | 29 | 51 % | 79 % | 54 % | 69 % | 89 % |
| Thraupidae | 302 | 47 % | 87 % | 41 % | 70 % | 89 % |
| Passerellidae | 120 | 57 % | 86 % | 53 % | 70 % | 90 % |
| Ardeidae | 38 | 41 % | 84 % | 49 % | 70 % | 89 % |

## Similarity accuracy (the table itself)

From the table's own report: a set of species pairs European birders find hard to tell apart by ear, against random pairs. AUC = probability that a hard pair scores closer than a random pair.
species 7475, windows 169114, class known 7475, lump pairs masked 0, diffuse 75; held-out recordings 36369 (129 single-recording species skipped)
held-out nearest species by centroid: own species top-1 74.7 %, top-3 85.9 %, top-8 90.7 %

| measure | AUC hard vs random (22 / 400) | hard pairs in top 8 | top 3 |
|---|---|---|---|
| centroid | 0.966 | 15 | 12 |
| soft | 0.997 | 10 | 6 |
| fused | 0.997 | 18 | 12 |

## Hard pairs: rank (centroid / soft / fused)

- Phylloscopus collybita ↔ Phylloscopus trochilus: 6 / 12 / 6
- Acrocephalus palustris ↔ Acrocephalus scirpaceus: 3 / 13 / 4
- Acrocephalus dumetorum ↔ Acrocephalus scirpaceus: 15 / 12 / 8
- Acrocephalus dumetorum ↔ Acrocephalus palustris: 1 / 5 / 1
- Anthus trivialis ↔ Anthus pratensis: 12 / 52 / 16
- Sterna hirundo ↔ Sterna paradisaea: 1 / 2 / 1
- Sylvia borin ↔ Sylvia atricapilla: 1 / 2 / 1
- Phylloscopus trochiloides ↔ Phylloscopus borealis: 133 / 268 / 140
- Curruca curruca ↔ Curruca communis: 4 / 22 / 5
- Certhia familiaris ↔ Certhia brachydactyla: 1 / 15 / 2
- Turdus iliacus ↔ Turdus philomelos: 11 / 26 / 12
- Locustella naevia ↔ Locustella fluviatilis: 1 / 10 / 3
- Regulus regulus ↔ Regulus ignicapilla: 1 / 3 / 1
- Dendrocopos major ↔ Dendrocopos leucotos: 5 / 7 / 3
- Larus argentatus ↔ Larus cachinnans: 9 / 8 / 8
- Tringa nebularia ↔ Tringa totanus: 1 / 2 / 1
- Emberiza citrinella ↔ Emberiza cirlus: 12 / 17 / 6
- Hippolais icterina ↔ Hippolais polyglotta: 1 / 5 / 1
- Poecile montanus ↔ Poecile palustris: 15 / 33 / 11
- Linaria cannabina ↔ Linaria flavirostris: 2 / 3 / 1
- Anthus petrosus ↔ Anthus spinoletta: 1 / 1 / 1
- Picus viridis ↔ Picus canus: 2 / 15 / 2


### The other model on the same recordings

Perch 2.0 was run on every recording too. On the 4996 species both models cover, held-out top-1 / top-8 is 76 % / 91 % for BirdNET and 79 % / 93 % for Perch. BirdNET covers 2479 species the other does not (held-out 71 % / 90 % there). The table ships the model with the wider coverage.

## Limits

- BirdNET+ V3.0 is a developer preview; its labels and scores will change.
- Rare and regional species have few graded recordings; a species' entry rests on as little as three windows.
- Mimics and species with diffuse confusion are flagged in the table (75 species) and their lists are less trustworthy.
- Regions are approximate: a species is placed where most of its Xeno-canto recordings were made.
- Closeness by a model's ear is not closeness to a human ear; the pair check above is the only human-anchored number.
