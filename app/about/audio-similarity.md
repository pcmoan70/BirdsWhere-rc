# How well does the "sounds like" table work?

_Generated 2026-10-29 from the BirdsWhere sound pipeline (S17). Numbers only; the recordings themselves stay with their recordists on Xeno-canto._

## What the table is

For every species the app knows, the table lists up to eight species a pair of sound models finds closest by ear. Since v2208 it is built from **vocalisations, not whole recordings**: Xeno-canto recordings of grade A and B (up to four per kind of voice — song, call, drumming, other — the first 45 s of each) are scored frame by frame by BirdNET+ V3.0; where the labelled bird is actually singing (frame probability ≥ 0.4) the audio is cut into 3-second pieces with 1-second overlap, and a piece whose 5-second window holds another species at ≥ 0.3 is dropped (background birds used to fake matches). Each piece is embedded by BirdNET+ V3.0 (a classifier) and by Bird-MAE (self-supervised, never taught species), whitened to 64 numbers. For two species, each piece of A finds its nearest piece of B; the 90th percentile of those similarities (BirdNET+) or the 75th (Bird-MAE) is A's closeness to B, symmetrised, and the two models' row-standardised scores are averaged. A bird's eight nearest get a 0–100 score by rank. Species whose recordings gave no clean piece keep their entry from the v2200 whole-recording table (centroid similarity and soft confusion), marked below as *whole-recording*.

## Coverage

Species in the app: 11843 (10292 birds). With a Xeno-canto recording of grade A or B: 9801. Recordings scored: 82791 of 9159 species. With a sound entry: 7478 — 5639 on the vocalisation metric, 1839 whole-recording.

### By region of the recordings

| region | species | any A or B recording | recordings scored / species | sound entry | on the vocalisation metric |
|---|---|---|---|---|---|
| Europe | 421 | 100 % | 15.0 | 94 % | 89 % |
| North America | 979 | 100 % | 8.6 | 90 % | 78 % |
| South America | 3182 | 100 % | 9.0 | 85 % | 67 % |
| Africa | 1747 | 100 % | 7.4 | 65 % | 42 % |
| Asia | 1477 | 100 % | 8.6 | 80 % | 60 % |
| Oceania | 1916 | 100 % | 7.0 | 60 % | 38 % |
| Antarctica | 9 | 100 % | 5.9 | 56 % | 33 % |
| unknown | 70 | 100 % | 3.5 | 29 % | 19 % |
| no recordings | 2042 | 0 % | 0.0 | 0 % | 0 % |

### By class

| class | species | any A or B recording | recordings scored / species | sound entry | on the vocalisation metric |
|---|---|---|---|---|---|
| aves | 10292 | 95 % | 8.0 | 73 % | 55 % |
| mammalia | 535 | 0 % | 0.0 | 0 % | 0 % |
| insecta | 524 | 0 % | 0.0 | 0 % | 0 % |
| amphibia | 481 | 0 % | 0.0 | 0 % | 0 % |
| reptilia | 11 | 0 % | 0.0 | 0 % | 0 % |

The archive used (Xeno-canto's bird collection) holds no mammal, insect, amphibian or reptile recordings, so those species have no entry.

## The recordist's label against the model

Every recording is labelled by its recordist. Per recording, the probability for a label is the maximum over its 5-second windows; the table shows how often BirdNET+ V3.0 puts the recordist's species first, in its top three, or detects it at all (p ≥ 0.1). B-grade recordings are far harder than A-grade ones, which is why the clean-piece filter matters; the commonest misses are sister species and recent splits (Italian Sparrow → House Sparrow, Scottish Crossbill → Red Crossbill, Atlas → Pied Flycatcher).

| set | recordings | label is top-1 | label in top-3 | label detected (p ≥ 0.1) |
|---|---|---|---|---|
| all | 82789 | 56.0 % | 73.0 % | 75.2 % |
| grade A | 57409 | 62.5 % | 79.2 % | 81.8 % |
| grade B | 25380 | 41.5 % | 59.0 % | 60.3 % |
| voice call | 36969 | 48.4 % | 65.8 % | 67.3 % |
| voice drum | 469 | 22.4 % | 43.9 % | 53.5 % |
| voice other | 10770 | 65.5 % | 80.6 % | 81.9 % |
| voice song | 34581 | 61.8 % | 78.9 % | 82.0 % |

## Similarity accuracy (the table itself)

Three human-anchored sets of species pairs, ranked within the 5639 species on the vocalisation metric (rank 0 = the other species is the nearest of all). A pair is *in the eight nearest* when at least one direction ranks below 8.

| pair set | expectation | in the eight nearest | median rank |
|---|---|---|---|
| 22 congener pairs European birders find hard by ear | should be close | 19 of 22 | 1 |
| 23 same-habitat pairs that do not sound alike | should NOT be close | 5 of 23 | 21 |
| 14 cross-family by-ear pairs (Blackbird ↔ Mistle Thrush, Cuckoo ↔ Collared Dove, Wryneck ↔ Lesser Spotted Woodpecker …) | should be close | 10 of 14 | 2 |

Per model, within the same species: BirdNET+ alone keeps 18 of the 22 congener pairs but only 4 of the 14 cross-family pairs; Bird-MAE alone 10 and 10. The classifier's embedding places close relatives together, the self-supervised one places similar sounds together; the fusion keeps both.

## Limits

- BirdNET+ V3.0 is a developer preview; its labels and scores will change.
- Many species outside Europe have few graded recordings and few frames where the model is sure of them: a median of 6 clean pieces per species on the new metric, and 1,839 species fell back to whole recordings.
- Species with many recordings are found as neighbours more often than species with few (a nearest-neighbour measure rewards sample size); the European species, with up to 30 recordings each, are over-represented as partners.
- Regions are approximate: a species is placed where most of its Xeno-canto recordings were made.
- Closeness by a model's ear is not closeness to a human ear; the pair checks above are the only human-anchored numbers.
