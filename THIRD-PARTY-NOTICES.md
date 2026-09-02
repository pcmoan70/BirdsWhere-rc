# Third-party notices

The application code in this repository is licensed under the MIT License (see
[`LICENSE`](LICENSE), © 2026 Pär Wiklund). This file reproduces the copyright and
licence notices of the third-party components that are **redistributed inside this
repository**, and attributes the models, data and services the app relies on at
runtime, as those licences require.

---

## 1. Redistributed software (bundled under `app/vendor/`)

### Leaflet 1.9.4 — BSD-2-Clause
Files: `app/vendor/leaflet/**`
Copyright (c) 2010–2023, Volodymyr Agafonkin
Copyright (c) 2010–2011, CloudMade

> Redistribution and use in source and binary forms, with or without modification, are
> permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this list of
>    conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice, this list of
>    conditions and the following disclaimer in the documentation and/or other materials
>    provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS
> OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
> COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
> EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
> HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
> TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
> EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### ONNX Runtime Web 1.21.0 — MIT
Files: `app/vendor/ort/**`
Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License
(full text in §3 below).

### h3-js (Uber H3 bindings) — Apache License 2.0
File: `app/vendor/h3-js.js`
Copyright (c) Uber Technologies, Inc.
Licensed under the Apache License, Version 2.0 (full text in §4 below). No modifications were
made to the vendored build. Project: https://github.com/uber/h3-js

---

## 2. Redistributed model & data assets

### BirdNET Geomodel
Files: `app/geomodel_fp16.onnx`, and the derived `app/labels.txt` / `app/taxonomy.csv`
By the BirdNET team — https://github.com/birdnet-team/geomodel

- The Geomodel **source code** is MIT-licensed.
- The **trained weights** (`geomodel_fp16.onnx`) and the label/taxonomy data derived from the
  model are licensed under **Creative Commons Attribution-ShareAlike 4.0 International
  (CC BY-SA 4.0)** — https://creativecommons.org/licenses/by-sa/4.0/ — and are redistributed
  here under those terms. Attribution: © the BirdNET team, K. Lisa Yang Center for
  Conservation Bioacoustics, Cornell Lab of Ornithology, and Chemnitz University of
  Technology. If you redistribute these weights or a modified version, you must do so under
  the same CC BY-SA 4.0 licence and retain this attribution.

Multilingual common names in `taxonomy.csv` derive from the BirdNET label set and its upstream
taxonomy; usage follows the CC BY-SA 4.0 terms above.

### Simplified country borders
File: `app/countries-lite.json` — heavily simplified national outlines used only to gate
country-scoped observation sources. Derived from open/public-domain geographic boundary data
(e.g. Natural Earth, public domain). No attribution is required for public-domain sources; if
you know the exact upstream, add it here.

---

## 3. Loaded at runtime from a CDN (not redistributed here)

- **@emailjs/browser 4.4.1** — MIT, © EmailJS — loaded from jsDelivr (SRI-pinned in
  `app/index.html`); used only to send the optional feedback form.
- **Google Identity Services** (`accounts.google.com/gsi/client`) — © Google LLC, used under
  Google's API/Identity Services terms — loaded only for the optional Google Drive sync.

### MIT License (applies to ONNX Runtime Web and @emailjs/browser above)

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## 4. Runtime observation & basemap providers (attribution)

The app fetches live data directly from these third-party services; the data is © its
respective providers and subject to each provider's terms of use:

- **Observations:** eBird / Cornell Lab of Ornithology; GBIF; iNaturalist; Artsdatabanken
  (Artsobservasjoner); SLU Artdatabanken (Artportalen); FinBIF / Laji.fi; BirdWeather.
- **Basemaps & overlays:** © OpenStreetMap contributors; © CARTO; OpenTopoMap (CC-BY-SA);
  Esri / ArcGIS World Imagery; UNEP-WCMC (protected areas); European Environment Agency (EEA).

Reverse geocoding uses OpenStreetMap Nominatim; place/feature lookups use the Overpass API.

---

## 5. Apache License 2.0 (full text — applies to h3-js)

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction, and
      distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by the
      copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all other
      entities that control, are controlled by, or are under common control
      with that entity. For the purposes of this definition, "control" means
      (i) the power, direct or indirect, to cause the direction or management
      of such entity, whether by contract or otherwise, or (ii) ownership of
      fifty percent (50%) or more of the outstanding shares, or (iii)
      beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity exercising
      permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation source,
      and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but not limited
      to compiled object code, generated documentation, and conversions to
      other media types.

      "Work" shall mean the work of authorship, whether in Source or Object
      form, made available under the License, as indicated by a copyright
      notice that is included in or attached to the work.

      "Derivative Works" shall mean any work, whether in Source or Object form,
      that is based on (or derived from) the Work and for which the editorial
      revisions, annotations, elaborations, or other modifications represent,
      as a whole, an original work of authorship.

      "Contribution" shall mean any work of authorship, including the original
      version of the Work and any modifications or additions to that Work or
      Derivative Works thereof, that is intentionally submitted to Licensor for
      inclusion in the Work by the copyright owner or by an individual or Legal
      Entity authorized to submit on behalf of the copyright owner.

      "Contributor" shall mean Licensor and any individual or Legal Entity on
      behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of this
      License, each Contributor hereby grants to You a perpetual, worldwide,
      non-exclusive, no-charge, royalty-free, irrevocable copyright license to
      reproduce, prepare Derivative Works of, publicly display, publicly
      perform, sublicense, and distribute the Work and such Derivative Works in
      Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of this
      License, each Contributor hereby grants to You a perpetual, worldwide,
      non-exclusive, no-charge, royalty-free, irrevocable (except as stated in
      this section) patent license to make, have made, use, offer to sell,
      sell, import, and otherwise transfer the Work, where such license applies
      only to those patent claims licensable by such Contributor that are
      necessarily infringed by their Contribution(s) alone or by combination of
      their Contribution(s) with the Work to which such Contribution(s) was
      submitted. If You institute patent litigation against any entity
      (including a cross-claim or counterclaim in a lawsuit) alleging that the
      Work or a Contribution incorporated within the Work constitutes direct or
      contributory patent infringement, then any patent licenses granted to You
      under this License for that Work shall terminate as of the date such
      litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the Work or
      Derivative Works thereof in any medium, with or without modifications, and
      in Source or Object form, provided that You meet the following conditions:

      (a) You must give any other recipients of the Work or Derivative Works a
          copy of this License; and

      (b) You must cause any modified files to carry prominent notices stating
          that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works that You
          distribute, all copyright, patent, trademark, and attribution notices
          from the Source form of the Work, excluding those notices that do not
          pertain to any part of the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained within
          such NOTICE file, excluding those notices that do not pertain to any
          part of the Derivative Works.

      You may add Your own copyright statement to Your modifications and may
      provide additional or different license terms and conditions for use,
      reproduction, or distribution of Your modifications, or for any such
      Derivative Works as a whole, provided Your use, reproduction, and
      distribution of the Work otherwise complies with the conditions stated in
      this License.

   5. Submission of Contributions. Unless You explicitly state otherwise, any
      Contribution intentionally submitted for inclusion in the Work by You to
      the Licensor shall be under the terms and conditions of this License,
      without any additional terms or conditions. Notwithstanding the above,
      nothing herein shall supersede or modify the terms of any separate license
      agreement you may have executed with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade names,
      trademarks, service marks, or product names of the Licensor, except as
      required for reasonable and customary use in describing the origin of the
      Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or agreed to in
      writing, Licensor provides the Work (and each Contributor provides its
      Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
      ANY KIND, either express or implied, including, without limitation, any
      warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or
      FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for
      determining the appropriateness of using or redistributing the Work and
      assume any risks associated with Your exercise of permissions under this
      License.

   8. Limitation of Liability. In no event and under no legal theory, whether in
      tort (including negligence), contract, or otherwise, unless required by
      applicable law (such as deliberate and grossly negligent acts) or agreed
      to in writing, shall any Contributor be liable to You for damages,
      including any direct, indirect, special, incidental, or consequential
      damages of any character arising as a result of this License or out of
      the use or inability to use the Work.

   9. Accepting Warranty or Additional Liability. While redistributing the Work
      or Derivative Works thereof, You may choose to offer, and charge a fee
      for, acceptance of support, warranty, indemnity, or other liability
      obligations and/or rights consistent with this License. However, in
      accepting such obligations, You may act only on Your own behalf and on
      Your sole responsibility, not on behalf of any other Contributor, and only
      if You agree to indemnify, defend, and hold each Contributor harmless for
      any liability incurred by, or claims asserted against, such Contributor by
      reason of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
