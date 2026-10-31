/**
 * The root HTML shell — the markup init() pours into #app before any UI text is
 * applied: controls, the species panel, map, legend, settings, every page and
 * popup the app shows.
 *
 * Lifted out of app.js byte-for-byte (v2230): the template is a string with no
 * state of its own; the three helpers it calls (icons, the Experimental gate)
 * are injected through init() under the names they had inside the monolith.
 *
 * Exposed as window.AppShell (no module system; loaded via <script>).
 */
window.AppShell = (function () {
  "use strict";

  // ---- injected by app.js (init) -----------------------------------------
  var ico, icoBtn, experimentalOn;

  function init(ctx) { ico = ctx.ico; icoBtn = ctx.icoBtn; experimentalOn = ctx.experimentalOn; }

  function html() {
    var h =
      '<div id="app-loading"><div class="spinner"></div><span data-i18n="app.loading">Loading\u2026</span></div>' +
      '<div id="app-main" style="display:none">' +
        '<div id="app-controls">' +
          '<div class="ctrl-group" id="mode-wrap">' +
            '<label for="mode-select" data-i18n="ctrl.mode">Mode</label>' +
            '<select id="mode-select">' +
              '<option value="list" class="ico-label" data-i18n="mode.list">📍 Recent</option>' +
              // Historic / Migration / Species Range are ENTERED from elsewhere now —
              // Historic + Migration from a clicked point's popup, Species Range from a
              // species' menu — so their options are hidden+disabled here; they remain
              // for programmatic switches (the select still displays the active mode).
              '<option value="historic" class="ico-label" data-i18n="mode.historic" hidden disabled>Historic</option>' +
              '<option value="barchart" class="ico-label" data-i18n="mode.barchart" hidden disabled>Migration</option>' +
              '<option value="range" data-i18n="mode.range" hidden disabled>Species Range</option>' +
            '</select>' +
          '</div>' +
          // Hidden home of the Historic range picker: the picker shows ONLY as a
          // popup (openHistRangeModal adopts #hist-range-body); the bar above the
          // map is untouched by Historic mode.
          '<div class="ctrl-group" id="histrange-wrap" style="display:none">' +
            '<div id="hist-range-body">' +
              '<label data-i18n="hist.range">Date range</label>' +
              '<div class="hist-range-row"><input type="date" id="hist-from" /><span>–</span><input type="date" id="hist-to" />' +
                '<button type="button" id="hist-fetch" class="btn" data-i18n="hist.fetch" disabled>Fetch</button></div>' +
              '<label class="hist-allareas" data-i18n-title="hist.allAreasHint"><input type="checkbox" id="hist-all-areas" /> <span data-i18n="hist.allAreas">All fetched areas</span></label>' +
              '<details class="hist-months-dd">' +
                '<summary class="hist-months-sum"><span data-i18n="hist.months">Months</span><span class="hist-months-sel" id="hist-months-sel"></span></summary>' +
                '<div class="hist-months" id="hist-months"></div>' +
                '<p class="cu-hint" data-i18n="hist.monthsHint">Leave blank for all months.</p>' +
              '</details>' +
            '</div>' +
          '</div>' +
          '<div class="ctrl-group" id="species-search-wrap">' +
            '<button type="button" id="range-back" class="fp-back" title="Back">' + ico("back") + '</button>' +
            '<label for="species-search" data-i18n="ctrl.species">Species</label>' +
            '<div id="species-search-field">' +
              '<input id="species-search" type="text" autocomplete="off" data-i18n-ph="ph.species" placeholder="Search species\u2026" />' +
              '<div id="species-results"></div>' +
            '</div>' +
          '</div>' +
          '<div class="ctrl-group ctrl-group-btn" id="play-btn-wrap">' +
            '<button id="play-btn" class="btn" data-i18n="btn.play">\u25b6 Play migration</button>' +
          '</div>' +
          '<div class="ctrl-group" id="checklists-wrap" style="display:none">' +
            '<button type="button" id="checklists-toggle" class="hdr-icon-btn" aria-haspopup="true" title="Checklists" aria-label="Checklists">' +
              '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M9 5h11M9 12h11M9 19h11"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/></svg>' +
              '<span id="checklists-btn-text" class="hdr-count"></span>' +
            '</button>' +
            '<div id="checklists-panel" class="dd-panel" style="display:none"></div>' +
          '</div>' +
          '<div class="ctrl-group" id="mp-wrap">' +
            '<button type="button" id="mp-toggle" class="hdr-icon-btn" aria-haspopup="true" data-i18n-title="points.title" title="Points" aria-label="Points">' +
              '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" stroke="none" aria-hidden="true">' +
                '<circle cx="5" cy="7" r="1.9"/><circle cx="12.5" cy="4.5" r="1.9"/><circle cx="19" cy="9" r="1.9"/>' +
                '<circle cx="7.5" cy="15" r="1.9"/><circle cx="15" cy="13" r="1.9"/><circle cx="18.5" cy="19" r="1.9"/></svg>' +
              '<span id="mp-btn-text" class="hdr-count"></span>' +
            '</button>' +
            '<div id="mp-panel" class="dd-panel" style="display:none"></div>' +
          '</div>' +
          // List ⇄ Map view switch for a fetched species list — shown only while such
          // a list is available. Replaces the old in-list "📍 Map" button so you can
          // hop back and forth from the header.
          '<div class="ctrl-group" id="viewtoggle-wrap" style="display:none">' +
            '<button type="button" id="viewtoggle-btn" class="hdr-icon-btn" title="" aria-label=""></button>' +
          '</div>' +
          '<div class="ctrl-group" id="settings-wrap">' +
            '<button type="button" id="settings-toggle" class="settings-icon-btn" aria-haspopup="true" aria-label="Settings" data-i18n-title="ctrl.settingsHold" title="Settings"></button>' +
            '<div id="settings-panel" class="dd-panel settings-panel" style="display:none">' +
              // "About ↗" (the short web summary, in the UI language) beside "How it works" (the in-app panel).
              '<div class="settings-aboutrow">' +
                '<a class="settings-about about-page-link" href="about/" target="_blank" rel="noopener" data-i18n="settings.aboutPage">About ↗</a>' +
                '<button type="button" id="about-open" class="settings-about" data-i18n="ctrl.about">How it works</button>' +
                '<a class="settings-about" id="model-compare-link" href="model-compare/" target="_blank" rel="noopener" data-i18n="settings.modelCompare"' + (experimentalOn() ? "" : ' style="display:none"') + '>Model compare ↗</a>' +   // Experimental only (owner, 2026-10-27)
              '</div>' +
              '<div id="settings-version" class="settings-version" style="display:none"></div>' +
              '<button type="button" id="settings-update" class="settings-update" style="display:none"></button>' +
              '<div id="settings-update-notes" class="cu-hint" style="display:none"></div>' +
              '<div class="settings-section" data-i18n="settings.secView">View</div>' +
              // Species group and Sightings radius are NOT shown here: both live in the gear's
              // quick panel (a tap), which is where they belong — one tap instead of opening
              // the long panel. The controls themselves stay as the app's registers, hidden:
              // the quick panel builds itself by reading them, and every other call site keeps
              // them in step. Same arrangement as the probability inputs further down.
              '<div id="settings-registers" style="display:none">' +
                '<select id="group-select">' +
                  '<option value="all" data-i18n="group.all">All groups</option>' +
                  '<option value="aves" data-i18n="group.aves">Birds</option>' +
                  '<option value="mammalia" data-i18n="group.mammalia">Mammals</option>' +
                  '<option value="amphibia" data-i18n="group.amphibia">Amphibians</option>' +
                  '<option value="insecta" data-i18n="group.insecta">Insects</option>' +
                  '<option value="plantae" data-i18n="group.plantae">Plants</option>' +
                  '<option value="fungi" data-i18n="group.fungi">Fungi</option>' +
                '</select>' +
                // Kept (hidden) because the group picker and several callers address them.
                '<div id="group-picker-wrap">' +
                  '<button type="button" id="group-picker-btn" aria-haspopup="listbox"></button>' +
                  '<div id="group-picker-panel" class="group-quick-panel" style="display:none" role="listbox"></div>' +
                '</div>' +
                '<span id="recent-radius-val" class="radius-val"></span>' +
                '<input type="range" id="recent-radius" min="0" max="18" step="1" />' +
              '</div>' +
              // Which TYPES a fetch asks for (the group picker above only decides what is
              // shown). Every source shares one paging budget across the types requested,
              // so fewer ticks = more records of each before a source's limit is reached.
              '<div class="ctrl-group">' +
                '<label data-i18n="ctrl.fetchGroups">Species types to fetch</label>' +
                '<div class="fetch-groups" id="fetch-groups"></div>' +
                '<p class="cu-hint" data-i18n="ctrl.fetchGroupsHint">Every source has one page budget per fetch, shared across the types you ask for — so fetching fewer types returns more of each in a busy place. The type you are viewing is always fetched.</p>' +
              '</div>' +
              // The probability range is no longer a Settings control — it lives in the
              // list's own Filters pane (the funnel → Probability), where the other
              // filters are. These inputs stay as the app's internal register: the
              // pane, the analysis tabs, the checklist builder and the share links all
              // read and write them. Never shown.
              '<div class="ctrl-group" id="barchart-threshold-wrap" style="display:none" aria-hidden="true">' +
                '<input type="range" id="prob-min" min="0" max="100" step="1" value="0" tabindex="-1" />' +
                '<input type="range" id="prob-max" min="0" max="100" step="1" value="100" tabindex="-1" />' +
                '<span id="prob-min-val">0%</span><span id="prob-max-val">100%</span>' +
              '</div>' +
              // The week is always the current week (no user override). The <select> stays
              // as the app's internal week register — Range/Migration playback, the
              // "week it was seen" jumps and share links still set it programmatically.
              '<div class="ctrl-group" id="week-select-wrap" style="display:none">' +
                '<select id="week-select" aria-hidden="true" tabindex="-1"></select>' +
              '</div>' +
              // The base-map chooser lives in the Maps & overlays popup (owner, 2026-10-23); the hidden
              // holder keeps the markup (and its wiring) in the document between opens.
              '<div id="maptype-home" hidden>' +
              '<div class="ctrl-group" id="maptype-wrap">' +
                '<label for="maptype-select" data-i18n="ctrl.basemap">Map type</label>' +
                '<select id="maptype-select">' +
                  '<option value="voyager" data-i18n="basemap.voyager">Voyager</option>' +
                  '<option value="maptiler" data-i18n="basemap.maptiler">MapTiler Outdoor</option>' +
                  '<option value="streets" data-i18n="basemap.streets">Streets</option>' +
                  '<option value="cyclosm" data-i18n="basemap.cyclosm">CyclOSM</option>' +
                  '<option value="topo" data-i18n="basemap.topo">Topographic</option>' +
                  '<option value="esritopo" data-i18n="basemap.esritopo">Esri Topo</option>' +
                  '<option value="satellite" data-i18n="basemap.satellite">Satellite</option>' +
                '</select>' +
                '<p class="cu-hint" data-i18n="ctrl.basemapHint">The background map style behind the data — Light, Dark, Streets, Topographic or Satellite.</p>' +
                '<div id="carto-key-wrap" style="display:none">' +
                  '<input type="text" id="carto-key-input" autocomplete="off" spellcheck="false" data-i18n-ph="ph.cartoKey" placeholder="CARTO API key (for Voyager)" />' +
                  '<p class="cu-hint" data-i18n="ctrl.cartoKeyHint">The Voyager map (CARTO) needs a free personal API key from carto.com — paste it here to use Voyager. Until then a plain Streets map is shown.</p>' +
                '</div>' +
                '<div id="maptiler-key-wrap" style="display:none">' +
                  '<input type="text" id="maptiler-key-input" autocomplete="off" spellcheck="false" data-i18n-ph="ph.maptilerKey" placeholder="MapTiler API key (for MapTiler Outdoor)" />' +
                  '<p class="cu-hint" data-i18n="ctrl.maptilerKeyHint">MapTiler Outdoor (trails + terrain) needs a free personal MapTiler API key from maptiler.com — paste it here to use it. Until then a plain Streets map is shown.</p>' +
                '</div>' +
              '</div>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secFetch">Fetching &amp; detections</div>' +
              '<div class="ctrl-group">' +
                '<label for="download-days" data-i18n="ctrl.downloadDays">Download — last N days</label>' +
                '<input id="download-days" type="number" min="0" max="92" step="1" />' +
                '<p class="cu-hint" data-i18n="ctrl.downloadDaysHint">How far back a normal fetch downloads observations, applied to every source (eBird is always capped at 30 days by its API; GBIF at ~92). 0 = each source’s own default (GBIF/iNaturalist ~90 days, eBird 30, BirdWeather 7). Fetch on open has its own separate window.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="sight-ttl" data-i18n="ctrl.sightTtl">Reuse downloads (min)</label>' +
                '<input id="sight-ttl" type="number" min="0" max="10080" step="5" />' +
                '<p class="cu-hint" data-i18n="ctrl.sightTtlHint">Reopening the app reuses a location’s already-downloaded observations for this many minutes instead of re-fetching. 0 = reuse indefinitely (only refetch on a new place or a changed radius/group/source).</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="fetchonopen-toggle"> <span data-i18n="ctrl.fetchOnOpen">Fetch on open</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.fetchOnOpenHint">When on, opening the app automatically fetches and plots observations for the stored locations you tick “load on open” — the ⟳ column in the Stored locations panel (press-and-hold 🔍). Reuses the cache above, so within that window it loads instantly with no network; only refetches when the cache is stale. Skipped when the app is opened via a shared or ?here link.</p>' +
                '<div id="fetchonopen-days-wrap" class="ctrl-subrow" style="display:none">' +
                  '<label for="fetchonopen-days" data-i18n="ctrl.fetchOnOpenDays">Last days to fetch</label>' +
                  '<input id="fetchonopen-days" type="number" min="1" max="92" step="1" />' +
                '</div>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="restore-det-toggle"> <span data-i18n="ctrl.restoreDet">Show the last session’s observations on open</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.restoreDetHint">Off: the app opens with no fetched observations, no selection and no filters — only your shown lists. On: the observations fetched last time come back on the map.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="max-points" data-i18n="ctrl.maxpoints">Max points on map</label>' +
                '<input id="max-points" type="number" min="50" max="100000" step="50" />' +
                '<p class="cu-hint" data-i18n="ctrl.maxpointshint">Caps how many detection dots are drawn at once for speed. When more are plotted, only the newest this-many are shown on the map (the rest stay in the Detections list).</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="dedup-toggle"> <span data-i18n="ctrl.dedup">Deduplicate detections</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.deduphint">When the same sighting is registered in two databases (e.g. eBird and Artsobservasjoner) — same observer, approximate location, date, count and species — show it once instead of twice. Off = show every source\'s copy.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="rare-pct" data-i18n="ctrl.rarepct">Rare species threshold (%)</label>' +
                '<input id="rare-pct" type="number" min="1" max="100" step="1" />' +
                '<p class="cu-hint" data-i18n="ctrl.rarepcthint">A plotted species is “rare locally” when its detection count is at most this % of the commonest plotted species. Rare dots get a black centre; filter them with the legend’s ◉ Rare.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="rarity-ticker-toggle"> <span data-i18n="ctrl.rarityTicker">Rarest-finds intro</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.rarityTickerHint">Off by default. After each fetch, the rarest species found scroll up from the bottom of the map in their dot colours down the right side (rarest at the top) and stay there until you act. Tap a tile to jump to that species in the list; any other tap, key or map move dismisses it.</p>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secData">Data sources</div>' +
              '<div class="ctrl-group" id="sources-wrap">' +
                '<label data-i18n="sources.label">Data sources</label>' +
                icoBtn("sources-open", "sources", "sources.manage", "Data sources…") +
                '<p class="cu-hint" data-i18n="sources.labelHint">Turn each observation source on or off and enter its API key. GBIF and iNaturalist need no key; eBird and the regional databases each take a free key.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="ctrl.customurls">National databases</label>' +
                icoBtn("natdb-open", "globe", "natdb.manage", "National databases…") +
                '<p class="cu-hint" data-i18n="ctrl.customurlsSettingsHint">Manage the national and regional bird-site links shown in a clicked point’s popup — add, edit, hide or delete per country, or reset the defaults.</p>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secRarity">Rarity alerts</div>' +
              '<div class="ctrl-group">' +
                '<p class="cu-hint" data-i18n="rarity.hint">While the app is open, the places you mark with 🔔 (press and hold the 🔍 search button to manage them) are checked for birds the model finds unlikely there — eBird\'s notable sightings AND, unless you switch it off below, your ordinary observation sources. Rarities among the observations you fetch yourself join the same list, so no eBird key is required. The app cannot alert while the browser is closed.</p>' +
                '<p class="cu-hint" id="rarity-key-hint" style="display:none" data-i18n="rarity.needKey">Nothing can check right now — either switch on “Check all sources” below, or add a free eBird API key under Settings → Data sources → eBird.</p>' +
                '<label class="ctrl-check"><input type="checkbox" id="rarity-onoff-toggle" checked> <span data-i18n="rarity.enable">Alerts on (checks while the app is open)</span></label>' +
                '<label class="ctrl-check"><input type="checkbox" id="rarity-showmap-toggle" checked> <span data-i18n="rarity.showMap">Show rarities on the map</span></label>' +
                '<label for="rarity-interval" data-i18n="rarity.interval">Check every (minutes)</label>' +
                '<select id="rarity-interval"><option value="10">10</option><option value="30">30</option><option value="60">60</option><option value="0" data-i18n="rarity.manual">Manual (long-press the bell)</option></select>' +
              '</div>' +
              '<div class="ctrl-group ctrl-inline">' +
                '<label class="ctrl-check"><input type="checkbox" id="rarity-sound-toggle" checked> <span data-i18n="rarity.sound">Alarm sound</span></label>' +
                '<button type="button" id="rarity-sound-test" class="btn btn-light" data-i18n="rarity.soundTest">Test</button>' +
              '</div>' +
              '<p class="cu-hint" data-i18n="rarity.soundHint">Play a short chime when a new eBird rarity alert arrives while the app is open.</p>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="rarity-notif-toggle"> <span data-i18n="rarity.sysNotif">System notifications</span></label>' +
                '<p class="cu-hint" data-i18n="rarity.sysNotifHint">Also raise a system notification for each new rarity alert — needs the browser’s notification permission.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="rarity-allsrc-toggle" checked> <span data-i18n="rarity.allSrc">Check all sources, not just eBird</span></label>' +
                '<p class="cu-hint" data-i18n="rarity.allSrcHint">Also search your ordinary observation sources (GBIF, iNaturalist, the national databases…) around every 🔔 point, and alert on anything the model finds unlikely there. Catches rarities eBird never flagged, and works without an eBird key. These background checks step aside for any fetch you start.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="rarity-email" data-i18n="rarity.email">Email me new alerts</label>' +
                '<div class="ctrl-inline rarity-email-row">' +
                  '<input id="rarity-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" />' +
                  '<button type="button" id="rarity-email-test" class="btn btn-light" data-i18n="rarity.emailTest">Send test</button>' +
                '</div>' +
                '<p class="cu-hint" id="rarity-email-note"></p>' +
                '<p class="cu-hint" data-i18n="rarity.emailHint">New alerts are also sent to this address, at most one message per 5 minutes. The first message asks you to confirm the address — click the link in it once and later alerts arrive. The mail is relayed by formsubmit.co, so the address and the alert text pass through that service, and (like every alert) it only goes out while the app is open.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="rarity-country-toggle"> <span data-i18n="rarity.countryWide">Whole-country alerts</span></label>' +
                '<p class="cu-hint" data-i18n="rarity.countryWideTip">For every 🔔 point, fetch rare-bird alerts for its entire country instead of just the radius around it. Points that share a country are fetched once. Uses more of your eBird API budget.</p>' +
              '</div>' +
              (window.AppRarity.BAND_DISCONTINUED ? "" :   // BAND groups: retired source, block hidden behind the flag
              '<div class="ctrl-group">' +
                '<label for="rarity-band-token" data-i18n="rarity.band">BAND groups</label>' +
                '<div class="ctrl-inline rarity-email-row">' +
                  '<input id="rarity-band-token" type="password" autocomplete="off" spellcheck="false" data-i18n-ph="rarity.bandToken" placeholder="BAND access token" />' +
                  '<button type="button" id="rarity-band-load" class="btn btn-light" data-i18n="rarity.bandLoad">Load my groups</button>' +
                '</div>' +
                '<div id="rarity-band-list"></div>' +
                '<p class="cu-hint" data-i18n="rarity.bandHint">Also watch the posts of your birding groups on BAND (band.us). Paste a personal access token (BAND Developers → My Apps → Connect BAND account), load your groups and tick the ones to follow. New posts are searched for species names in the chosen language (scientific names always); a named bird is treated as a sighting at the chosen 🔔 location — a post has no coordinates — and alerts when the model finds it unlikely there, like any other source.</p>' +
              '</div>') +
              '<div class="ctrl-group">' +
                '<label for="rarity-prob-th" data-i18n="rarity.probTh">Rarity threshold (%)</label>' +
                '<input id="rarity-prob-th" type="number" min="0" max="100" step="1" />' +
                '<p class="cu-hint" data-i18n="rarity.probThHint">A bird counts as a rarity when the model finds it unlikely at its own spot and week — probability below this %. Applies to both your own fetched observations and eBird notable alerts. Default 15. 0/100 = off.</p>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secListsShare">Lists &amp; sharing</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="track-record-toggle"> <span data-i18n="settings.trackRecord">Record a track while GPS tracking</span></label>' +
                '<p class="cu-hint" data-i18n="settings.trackRecordHint">While automatic GPS updating is on (hold the locate button), your route is drawn on the map. When you turn tracking off you can save it as a point list (the line, plus start and end).</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="share-tiny-toggle"> <span data-i18n="ctrl.shareTiny">Shorten share links (TinyURL)</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.shareTinyHint">Turns share links into short tinyurl.com links (easier to paste / QR), for links under 14 kB. On by default. ⚠ The shared data is sent to TinyURL — a third party — so it may be exposed to unknown parties. Turn off for a plain link + .share file, so nothing leaves via a shortener.</p>' +
                '<div id="tiny-token-wrap">' +   // token field + its explanation: only while shortening is on
                '<input type="text" id="tiny-token-input" autocomplete="off" spellcheck="false" data-i18n-ph="ph.tinyToken" placeholder="TinyURL API token (optional)" />' +
                '<p class="cu-hint" data-i18n="ctrl.tinyTokenHint">TinyURL is retiring its free keyless API: links made without a token now show a TinyURL notice page first, and only small links can be shortened at all. With a personal API token (free TinyURL account → Settings → API) ALL share links — big lists included — become clean short links that go straight to the app.</p>' +
                '</div>' +
              '</div>' +
              '<div class="ctrl-group" id="points-kml-wrap">' +
                '<label data-i18n="ctrl.exportPoints">Map points</label>' +
                '<div class="kml-btn-row">' +
                  icoBtn("points-export", "download", "btn.export", "Export") +
                  icoBtn("points-kml-import", "upload", "btn.import", "Import") +
                  '<button type="button" id="points-fmt-toggle" class="btn btn-light kml-fmt-toggle" data-i18n-title="btn.fmtToggle" title="Export format">KML</button>' +
                "</div>" +
                '<input type="file" id="points-kml-file" accept=".kmz,.kml,.geojson,.json" multiple style="display:none" />' +
                '<p class="cu-hint" data-i18n="ctrl.exportPointsHint">Export the map points you’ve placed as a KML or GeoJSON file, or import points from one.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="lists.title">Administer lists</label>' +
                icoBtn("lists-open", "list", "lists.manage", "Lists…") +
                '<p class="cu-hint" data-i18n="lists.titleHint">Open the managers for your saved species lists and observer lists — rename, edit members or delete.</p>' +
              '</div>' +
              '<div class="ctrl-group" id="sync-wrap">' +
                '<label data-i18n="ctrl.syncData">Share between devices</label>' +
                '<div class="sync-row">' +
                  icoBtn("sync-export", "download", "sync.export", "Export") +
                  icoBtn("sync-import", "upload", "sync.import", "Import") +
                  '<input type="file" id="sync-file" accept=".json,application/json,.csv,text/csv,.txt,text/plain" style="display:none" />' +
                '</div>' +
                '<div class="sync-row" id="gdrive-row">' +
                  icoBtn("gd-connect", "cloud", "gdrive.connect", "Connect Google Drive") +
                  icoBtn("gd-sync", "refresh", "gdrive.syncNow", "Sync now", ' style="display:none"') +
                  '<button type="button" id="gd-disconnect" class="btn" data-i18n="gdrive.disconnect" style="display:none">Disconnect</button>' +
                '</div>' +
                '<input type="text" id="gd-clientid" autocomplete="off" spellcheck="false" data-i18n-ph="gdrive.clientIdPh" placeholder="Google OAuth client ID" style="display:none" />' +
                '<div id="gd-status" class="cu-hint"></div>' +
                '<p class="cu-hint" data-i18n="gdrive.hint">Syncs settings, checklists and points to your private Google Drive app folder. Deletions don’t sync between devices.</p>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secStorage">Storage &amp; offline</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="ctrl.storage">Storage</label>' +
                '<p class="cu-hint" id="storage-usage"></p>' +
                '<p class="cu-hint" data-i18n="ctrl.storageEstimate">Browsers pad every cached map tile for privacy, so their estimate can read far higher than the sizes listed below — those are measured.</p>' +
                '<p class="cu-hint storage-warn" id="storage-warn" style="display:none"></p>' +
                '<button type="button" id="errlog-open" class="btn btn-light" data-i18n="errlog.title">Error log</button>' +
                // Names picked up from iNaturalist while browsing (see the harvest above):
                // exportable so a device's own browsing can grow the app's shipped packs.
                '<button type="button" id="names-export" class="btn btn-light" data-i18n="names.export">Export species names</button>' +
                '<button type="button" id="names-csv" class="btn btn-light" data-i18n="names.csv">Download CSV</button>' +
                '<button type="button" id="names-mail" class="btn btn-light" data-i18n="names.send">Send CSV</button>' +
                '<p class="cu-hint" id="names-export-note"></p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label data-i18n="clear.label">Clear cached data</label>' +
                '<p class="cu-hint" data-i18n="clear.hint">Clear cached data (re-downloads next time). Saved lists &amp; settings are kept.</p>' +
                '<div class="clear-cache-grid">' +
                  '<button type="button" class="clear-cache-btn" data-clear="obs"><span class="clear-lbl" data-i18n="clear.obs">Fetched observations</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="tiles"><span class="clear-lbl" data-i18n="clear.tiles">Map tiles</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="range"><span class="clear-lbl" data-i18n="clear.range">Range maps</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="overlays"><span class="clear-lbl" data-i18n="clear.overlays">Overlays</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="hotspots"><span class="clear-lbl" data-i18n="clear.hotspots">eBird hotspots</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="birds"><span class="clear-lbl" data-i18n="clear.birds">Viewpoints</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="best"><span class="clear-lbl" data-i18n="clear.best">Best sites</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="names"><span class="clear-lbl" data-i18n="clear.names">Species names (iNat)</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="harvest"><span class="clear-lbl" data-i18n="clear.harvest">Downloaded names</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="offline"><span class="clear-lbl" data-i18n="clear.offline">Offline areas</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="images"><span class="clear-lbl" data-i18n="clear.images">Species photos</span><span class="clear-cnt"></span></button>' +
                  '<button type="button" class="clear-cache-btn" data-clear="clips"><span class="clear-lbl" data-i18n="clear.clips">Recordings (Xeno-canto)</span><span class="clear-cnt"></span></button>' +
                '</div>' +
                '<button type="button" id="clear-all-btn" class="btn btn-light" data-i18n="clear.all">Clear all cached data</button>' +
                // Not a cache clear — it rewrites the lists in place, so it sits under its own
                // label with what it does spelled out. One press, reports what it freed.
                '<div class="ctrl-group" id="compact-wrap">' +
                  '<button type="button" id="compact-lists-btn" class="btn btn-light" data-i18n="storage.compact">Compact imported lists</button>' +
                  '<p class="cu-hint" data-i18n="storage.compactHint"></p>' +
                  '<p id="compact-result" class="cu-hint compact-result" style="display:none"></p>' +
                '</div>' +
              '</div>' +
              '<div class="settings-section" data-i18n="settings.secDisplay">Display &amp; language</div>' +
              '<div class="ctrl-group">' +
                '<label for="lang-select" data-i18n="ctrl.language">Language</label>' +
                '<select id="lang-select"></select>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="name-lookup-toggle"> <span data-i18n="ctrl.nameLookup">Look up missing names at iNaturalist</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.nameLookupHint">The bundled name packs were built for birds, so most insects, plants and fungi have no name in your language. When a species turns up without one, the app asks iNaturalist once and keeps every language it answers with. Off: those species show their scientific name.</p>' +
              '</div>' +
              '<div class="ctrl-group" id="secondlang-wrap">' +
                '<label for="secondlang-select" data-i18n="ctrl.secondlang">2nd name</label>' +
                '<select id="secondlang-select"></select>' +
                '<p class="cu-hint" data-i18n="ctrl.secondlangHint">Show a second common-name column in the lists, in another language, next to the primary name.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="show-sci-toggle" checked> <span data-i18n="ctrl.showsci">Scientific names</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.showsciHint">Show the scientific-name column in the species lists.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="confusion-view-select" data-i18n="ctrl.confusionView">Confusion species</label>' +
                '<select id="confusion-view-select"><option value="images" data-i18n="ctrl.confusionImages">Photo cards</option><option value="table" data-i18n="ctrl.confusionTable">Table (no photos)</option></select>' +
                '<p class="cu-hint" data-i18n="ctrl.confusionViewHint">How the species menu shows look-alikes. Photo cards need an internet connection — offline, the table is shown.</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label for="dist-view-select" data-i18n="ctrl.distView">Distribution</label>' +
                '<select id="dist-view-select"><option value="model" data-i18n="ctrl.distModel">Species distribution (model)</option><option value="wiki" data-i18n="ctrl.distWiki">Distribution map (Wikipedia)</option></select>' +
                '<p class="cu-hint" data-i18n="ctrl.distViewHint">Which map the species menu\u2019s Distribution opens first. Each falls back to the other when it has nothing for the species (Wikipedia also when offline).</p>' +
              '</div>' +
              '<div class="ctrl-group">' +
                '<label class="ctrl-check"><input type="checkbox" id="experimental-toggle"> <span data-i18n="ctrl.experimental">Experimental features</span></label>' +
                '<p class="cu-hint" data-i18n="ctrl.experimentalHint">Off (default). On: unlocks less-polished extras — currently the NBN Atlas link in the species menu; more may appear here over time.</p>' +
              '</div>' +
              // Experimental-gated, so it lives under that toggle: the species list's
              // comparison column, defaulting to Annual max.
              '<div class="ctrl-group" id="compare-wrap" style="display:none">' +
                '<label for="compare-select" data-i18n="ctrl.compare">Compare to</label>' +
                '<select id="compare-select">' +
                  '<option value="" data-i18n="compare.none">\u2014 none \u2014</option>' +
                  '<option value="prev" data-i18n="compare.prev">Previous week</option>' +
                  '<option value="next" data-i18n="compare.next">Next week</option>' +
                  '<option value="mean" data-i18n="compare.mean">Annual mean</option>' +
                  '<option value="annualmax" selected data-i18n="compare.max">Annual max</option>' +
                  '<option value="annualtop" data-i18n="compare.annualtop">Annual Top</option>' +
                '</select>' +
                '<p class="cu-hint" data-i18n="ctrl.compareHint">Adds a column to the species list comparing the current week with another week or the annual mean/peak, so you can see what’s arriving or at its best now.</p>' +
              '</div>' +
              // Feedback form, just above the QR code (the delegated ".feedback-open" click handler opens it).
              '<div class="settings-toprow">' +
                '<button type="button" class="btn ico-btn feedback-open settings-feedback">' + ico("mail") + '<span class="ico-label" data-i18n="feedback.send">Feedback</span></button>' +
              '</div>' +
              '<div class="app-qr"><a class="app-qr-url" href="https://thebirding.site/" target="_blank" rel="noopener">thebirding.site</a>' +
                '<img src="qr-app.svg" alt="" width="140" height="140" /><span class="app-qr-cap" data-i18n="settings.qrShare">Scan to open / share this app</span></div>' +
              '<div class="settings-section" data-i18n="settings.secWhatsNew">What’s new</div>' +
              '<div id="whatsnew-list" class="whatsnew-list"></div>' +
              // Last in Settings: a clean reinstall that trusts no cache (owner, 2026-10-31).
              '<div class="ctrl-group" id="force-reload-wrap">' +
                '<button type="button" id="force-reload-btn" class="btn btn-light" data-i18n="settings.forceReload">Force reload</button>' +
                '<p class="cu-hint" data-i18n="settings.forceReloadHint"></p>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="app-status"></div>' +
        // Historic-fetch progress bar — ABOVE the map (historic is map-first, so
        // the bar must not sit in the hidden species panel). Same ids as always;
        // renderSpeciesList's hist branch drives it.
        '<div class="hist-progress hist-progress-map" id="sp-hist-prog" style="display:none"><div class="hist-progress-fill hist-progress-indet" id="sp-hist-prog-fill"></div></div>' +
        '<div id="map-top-row">' +
          '<div id="range-species" style="display:none"></div>' +
          '<div id="play-progress" style="display:none"><div class="pp-fill"></div><div class="pp-marker"></div><div class="pp-months"></div></div>' +
        '</div>' +
        '<div id="map-wrap">' +
          '<div id="app-map"></div>' +
          // Per-day observation histogram — a slim scrollable strip DOCKED UNDER the
          // map (fitMapHeight subtracts its height), with a date axis along the bottom.
          '<div id="histo-strip" style="display:none"><button type="button" class="hs-clear" style="display:none">✕</button><button type="button" class="hs-toggle"></button><div class="hs-scroll"><div class="hs-bars"></div><div class="hs-axis"></div></div></div>' +
          '<div id="computing-overlay" style="display:none">' +
            '<div class="spinner"></div>' +
            '<div id="computing-text">Computing\u2026</div>' +
            '<div id="computing-progress-wrap"><div id="computing-progress-bar"></div></div>' +
          '</div>' +
          '<div id="app-legend"></div>' +
          '<div id="nearby-page" style="display:none">' +
            '<div class="nb-bar">' +
              '<h3 id="nb-title" data-i18n="nearby.title">Close by</h3>' +
              '<button id="nb-tomap" class="nb-tomap" title="Show on map" aria-label="Show on map">' + ico("pin") + '</button>' +
            '</div>' +
            '<div id="nb-ref" class="nb-ref"></div>' +
            '<div id="nb-list" class="nb-list"></div>' +
          '</div>' +
        '</div>' +
        '<div id="csv-btn-wrap" style="display:none">' +
          '<button id="csv-download-btn" class="btn ico-btn" title="Download CSV">' + ico("download") + '<span class="ico-label" data-i18n="btn.csv">CSV</span></button>' +
        '</div>' +
        '<div id="species-panel">' +
          '<div class="sp-page-bar">' +
            '<button id="sp-back" class="fp-back" title="Back to map">' + ico("back") + '</button>' +
            '<div class="sp-head-lines">' +
              '<h3 id="sp-title"></h3>' +
              '<div class="sp-coords" id="sp-coords"></div>' +
            '</div>' +
          '</div>' +
          '<div id="sp-controls" style="display:none">' +
            '<select id="sp-layout" class="detlist-sort-sel" aria-label="Layout"></select>' +
            '<button id="sp-filter-btn" class="sp-filter-btn ico-btn" type="button" aria-label="Filters" title="Filters">' + ico("funnel") + '</button>' +
            '<button id="sp-missing-btn" class="sp-filter-btn ico-btn sp-missing-btn" type="button" data-i18n-title="sp.missingBtn" title="Also list the species the model predicts here that have no observations yet">?</button>' +
            // One button, two states: probability descending (commonest first) or ascending
            // (rarest first). The column headers still offer every other sort; this is the
            // one people reach for, and the Images layout has no headers to click.
            '<button id="sp-probsort-btn" class="sp-filter-btn ico-btn sp-probsort-btn" type="button" data-i18n-title="sp.probSort" title="Sort by probability"><span class="ps-gly">⇅</span></button>' +
            '<div id="sp-filters-bar"></div>' +
          '</div>' +
          '<div id="sp-filters-wrap"></div>' +
          '<div id="sp-pick-anchor"></div>' +   // the species search box is inserted after this (wireSpeciesPicker, inline)
          '<div id="sp-recency-note" class="sp-recency-note" style="display:none"></div>' +
          '<div class="sp-loading" id="sp-loading" style="display:none"></div>' +
          '<div id="sp-launch-note" style="display:none"></div>' +
          '<div id="sp-records" style="display:none"></div>' +
          '<table id="species-list-table">' +
            '<thead><tr>' +
            // Status (★/◉/🟠/🟡) rides on the species dot now (see spListDot), not in
            // its own columns; filtering by status lives in the Species header panel.
            '<th id="sp-nd-head" class="num clickable-head" data-i18n="th.total">Total</th><th id="sp-species-head" class="clickable-head" data-i18n="th.species">Species</th><th class="name2 clickable-head" id="sp-name2-head"></th><th id="sp-sci-head" class="clickable-head" data-i18n="th.sci">Scientific name</th><th id="sp-last-head" class="num clickable-head" data-i18n="th.last">Last</th><th id="sp-dist-head" class="num clickable-head" data-i18n="th.dist" data-hintkey="th.distHint">Dist</th><th id="sp-prob-head" class="clickable-head" data-hintkey="th.probHint"><span class="th-full">Probability</span><span class="th-abbr">Prob.</span></th><th id="sp-season-head" class="season-cell clickable-head" data-i18n="th.season" data-hintkey="th.seasonHint">Season</th><th id="sp-delta-head"></th></tr></thead>' +
            '<tbody id="sp-tbody"></tbody>' +
          '</table>' +
          '<div class="sp-actions sp-actions-dl">' +
            '<button id="sp-checklist-btn" class="btn ico-btn">' + ico("check") + '<span class="ico-label" data-i18n="btn.checklist">Checklist</span></button>' +
            '<button id="sp-pdf-btn" class="btn btn-light ico-btn" title="Download PDF">' + ico("download") + "<span>PDF</span></button>" +
          '</div>' +
        '</div>' +
        '<div id="field-page" style="display:none">' +
          '<div class="field-page-bar">' +
            '<button id="field-back" class="fp-back" title="Back to map">' + ico("back") + '</button>' +
            '<button id="field-nearby" class="fp-nearby" title="Nearby places" aria-label="Nearby places">▾</button>' +
            '<input id="field-coords" class="field-place" type="text" autocomplete="off" data-i18n-ph="ph.fieldtitle" placeholder="Location name" />' +
            '<button type="button" id="field-far" class="fp-far" style="display:none" aria-label="!">!</button>' +
            '<span class="field-seen" id="field-seen"></span>' +
            '<span class="field-actions">' +
              '<span class="fp-dl-wrap">' +
                '<button id="field-dl-btn" class="btn" data-i18n-title="btn.actions" title="Actions">⋮</button>' +
                '<div id="field-dl-menu" class="fp-dl-menu" style="display:none">' +
                  '<button id="field-pdf" class="fp-dl-item ico-btn">' + ico("download") + "<span>PDF</span></button>" +
                  '<button id="field-csv" class="fp-dl-item ico-btn">' + ico("download") + '<span class="ico-label" data-i18n="btn.csv">CSV</span></button>' +
                  '<button id="field-log" class="fp-dl-item ico-btn">' + ico("download") + '<span class="ico-label" data-i18n="btn.logcsv">Log</span></button>' +
                  '<div class="fp-dl-sep"></div>' +
                  '<button id="field-map" class="fp-dl-item ico-btn">' + ico("pin") + '<span class="ico-label" data-i18n="btn.showMap">Map</span></button>' +
                  '<button id="field-review" class="fp-dl-item ico-btn">' + ico("upload") + '<span class="ico-label" data-i18n="btn.review">Upload</span></button>' +
                  '<div class="fp-dl-sep"></div>' +
                  '<button id="field-clear" class="fp-dl-item fp-dl-danger" data-i18n="btn.clear">Clear</button>' +
                '</div>' +
              '</span>' +
            '</span>' +
          '</div>' +
          '<div id="field-far-msg" class="fp-far-msg" data-i18n="chk.farWarn" style="display:none"></div>' +
          '<div class="fc-filterbar">' +
            '<span class="fc-search-wrap">' +
              '<input id="field-search" type="text" autocomplete="off" data-i18n-ph="ph.filter" placeholder="Filter species…" />' +
              '<button type="button" id="field-search-clear" class="fc-search-clear" data-i18n-title="btn.clear" title="Clear" aria-label="Clear" hidden>×</button>' +
            '</span>' +
            '<button type="button" id="field-filter-cycle" class="chk-filter-cycle" data-ff="all" title="Filter species">All</button>' +
          '</div>' +
          '<div id="field-list"></div>' +
          '<div id="fc-picker" style="display:none">' +
            '<div class="fcp-head"><span id="fcp-name"></span><button type="button" id="fcp-close" aria-label="Close">×</button></div>' +
            '<div class="fcp-step-row">' +
              '<button type="button" class="fcp-step" data-step="-25">−25</button>' +
              '<button type="button" class="fcp-step" data-step="-10">−10</button>' +
              '<button type="button" class="fcp-step" data-step="-1">−</button>' +
              '<span class="fcp-val" id="fcp-val">0</span>' +
              '<button type="button" class="fcp-step" data-step="1">+</button>' +
              '<button type="button" class="fcp-step" data-step="10">+10</button>' +
              '<button type="button" class="fcp-step" data-step="25">+25</button>' +
            '</div>' +
          '</div>' +
          '<div id="fc-act-picker" style="display:none">' +
            '<div class="fcp-head"><span id="fca-name"></span><button type="button" id="fca-close" aria-label="Close">×</button></div>' +
            '<input id="fca-search" type="text" autocomplete="off" data-i18n-ph="chk.actSearch" placeholder="Search or write…" />' +
            '<div id="fca-list"></div>' +
          '</div>' +
          '<div id="place-picker" style="display:none">' +
            '<div class="fcp-head"><span data-i18n="place.nearby">Nearby places</span><button type="button" id="place-close" aria-label="Close">×</button></div>' +
            '<div id="place-list"></div>' +
          '</div>' +
        '</div>' +
        // Rarity alerts: a full page in the same framework as the checklist/species
        // pages (under the header bar, ‹ returns to the previous view). rarity.js
        // renders into it; it stays empty until the bell is opened.
        '<div id="rarity-page" class="rarity-panel" style="display:none"></div>' +
        '<div id="entry-page" style="display:none">' +
          '<div class="field-page-bar">' +
            '<button id="entry-back" class="fp-back" title="Back">' + ico("back") + '</button>' +
            '<span id="entry-title" class="field-place"></span>' +
            '<span class="field-actions">' +
              '<button id="entry-merge" class="btn" data-i18n="chk.merge">Merge</button>' +
            '</span>' +
          '</div>' +
          '<div id="entry-list"></div>' +
        '</div>' +
        '<div id="review-page" style="display:none">' +
          '<div class="field-page-bar">' +
            '<button id="review-back" class="fp-back" title="Back">' + ico("back") + '</button>' +
            '<span id="review-title" class="field-place" data-i18n="review.title">Review &amp; upload</span>' +
            '<span class="field-actions">' +
              '<button id="review-new" class="btn" data-i18n="review.newGroup">+ Checklist</button>' +
            '</span>' +
          '</div>' +
          '<div id="review-list"></div>' +
        '</div>' +
        '<div id="barchart-panel">' +
          '<div class="sp-page-bar">' +
            '<button id="bc-back" class="fp-back" title="Back to map">' + ico("back") + '</button>' +
            '<h3 id="bc-title" data-i18n="panel.bcTitle">Location analysis</h3>' +
          '</div>' +
          '<div class="sp-coords" id="bc-coords"></div>' +
          '<div id="an-tabs">' +
            '<button class="an-tab" data-tab="timeline" data-i18n="tab.timeline">Timeline</button>' +
            '<button class="an-tab" data-tab="prob" data-i18n="tab.prob">Probability</button>' +
            '<button class="an-tab" data-tab="arrival" data-i18n="tab.arrival">Arrivals</button>' +
            '<button class="an-tab" data-tab="focus" data-i18n="tab.focus">Focus</button>' +
            '<button class="an-tab" data-tab="scatter" data-i18n="tab.scatter">Scatter</button>' +
          '</div>' +
          '<div id="an-controls">' +
            '<input id="an-filter" type="text" autocomplete="off" data-i18n-ph="ph.filter" placeholder="Filter species…" />' +
            '<label id="an-topn-wrap"><span data-i18n="ctrl.topN">Top N</span> ' +
              '<input id="an-topn" type="number" min="1" max="500" value="55" /> ' +
              '<span data-i18n="ctrl.rankby">Rank by</span> ' +
              '<select id="an-rankby">' +
                '<option value="arrival" data-i18n="rank.arrival">Arrivals</option>' +
                '<option value="prob" data-i18n="rank.prob">Probability</option>' +
                '<option value="both" data-i18n="rank.both">Both</option>' +
              '</select></label>' +
          '</div>' +
          '<div id="bc-container"></div>' +
        '</div>' +
        '<div id="distmap-modal" style="display:none"><div id="distmap-box">' +
          '<button type="button" id="distmap-close" aria-label="Close">×</button>' +
          '<h3 id="distmap-title"></h3>' +
          '<div id="distmap-body"></div>' +
        '</div></div>' +
        '<div id="recent-modal" style="display:none"><div id="recent-box">' +
          '<button type="button" id="recent-close" aria-label="Close">×</button>' +
          '<h3 id="recent-title"></h3>' +
          '<div id="recent-body"></div>' +
        '</div></div>' +
        '<div id="about-modal" style="display:none"><div id="about-box">' +
          '<button type="button" id="about-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="about.title">About the model &amp; how values are computed</h3>' +
          '<div id="about-body"></div>' +
        '</div></div>' +
        '<div id="perf-modal" style="display:none"><div id="perf-modal-box" class="has-modal-x">' +
          '<button type="button" id="perf-modal-x" class="ui-modal-x" data-i18n-title="btn.close" title="Close" aria-label="Close">\u00d7</button>' +
          '<h2 class="perf-title" data-i18n="popup.title">Species — distributions &amp; observations</h2>' +
          '<p class="perf-desc" data-i18n="popup.desc">See where birds live, migrate, and are being seen right now — live observations from eBird, GBIF, iNaturalist and national databases, plus range and timing estimates worked out on your device. Everything runs in your browser.</p>' +
          '<p class="perf-privacy" data-i18n="popup.privacy">Private by design: there is no account and no server of ours. Your searches, saved lists and settings stay on this device — nothing is sent anywhere except the direct requests to the observation sources you query.</p>' +
          '<p class="perf-keys" data-i18n="popup.keysTip"></p>' +
          // Offline mode reads as a line of text with its icon in front, not a button.
          '<div class="install-row" id="install-row">' + ico("install") + '<span class="install-steps cu-hint"></span></div>' +
          '<div class="perf-version" id="perf-version" style="display:none"></div>' +
          '<div class="perf-btns"><a class="perf-about about-page-link" href="about/" target="_blank" rel="noopener" data-i18n="settings.aboutPage">About ↗</a>' +
          '<button id="perf-modal-cancel" class="btn btn-light" data-i18n="btn.cancel" hidden>Cancel</button>' +
          '<button id="perf-modal-ok" class="btn" data-i18n="popup.ok">OK</button></div>' +
        '</div></div>' +
        '<div id="feedback-modal" style="display:none"><div id="feedback-box">' +
          '<button type="button" id="feedback-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="feedback.title">Feedback</h3>' +
          '<p class="feedback-intro" data-i18n="feedback.intro">The team — one human and one AI — welcomes anything: ideas for new functions, tips about data sources we don\'t use yet, ideas for predictive modelling, bug reports, usability issues, praise…</p>' +
          // One-tap thumbs: sends straight away (with whatever is typed below, if anything).
          '<div class="feedback-quick"><span class="feedback-quick-lbl" data-i18n="feedback.quick">Quick feedback</span>' +
            '<button type="button" class="feedback-thumb" data-thumb="up" data-i18n-title="feedback.thumbsUp" title="Works well" aria-label="Works well">👍</button>' +
            '<button type="button" class="feedback-thumb" data-thumb="down" data-i18n-title="feedback.thumbsDown" title="Something’s off" aria-label="Something’s off">👎</button></div>' +
          '<textarea id="feedback-msg" rows="5" maxlength="2000" data-i18n-ph="feedback.msgPh" placeholder="Your message…"></textarea>' +
          '<input type="email" id="feedback-email" maxlength="120" autocomplete="email" data-i18n-ph="feedback.emailPh" placeholder="Your email (optional, for a reply)" />' +
          '<input type="text" id="feedback-web" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />' +
          '<div id="feedback-status" class="cu-hint"></div>' +
          '<div class="feedback-actions">' +
            '<button type="button" id="feedback-cancel" class="btn btn-light" data-i18n="feedback.cancel">Cancel</button>' +
            '<button type="button" id="feedback-send" class="btn" data-i18n="feedback.sendBtn">Send</button>' +
          '</div>' +
        '</div></div>' +
        '<div id="gbif-modal" style="display:none"><div id="gbif-box">' +
          '<button type="button" id="gbif-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="gbif.title">GBIF datasets</h3>' +
          '<p class="cu-hint" data-i18n="gbif.hint">Each is queried on its own page budget so a busy one isn’t lost to the cap. eBird &amp; iNaturalist are already fetched directly. Add datasets by hand: a 2-letter country (blank = everywhere), the GBIF dataset key (or its gbif.org/dataset/… URL), and an optional homepage.</p>' +
          '<div class="gbif-add-row">' +
            '<input type="text" id="gbif-add-cc" autocomplete="off" spellcheck="false" maxlength="2" data-i18n-ph="gbif.addCcPh" placeholder="CC" class="gbif-add-cc" />' +
            '<input type="text" id="gbif-add" autocomplete="off" spellcheck="false" data-i18n-ph="gbif.addPh" placeholder="Dataset key or gbif.org/dataset/… URL" />' +
            '<input type="text" id="gbif-add-url" autocomplete="off" spellcheck="false" data-i18n-ph="gbif.addUrlPh" placeholder="Homepage URL (optional)" />' +
            '<button type="button" id="gbif-add-btn" class="btn" data-i18n="gbif.add">Add</button>' +
          '</div>' +
          '<div id="gbif-table"></div>' +
        '</div></div>' +
        '<div id="natdb-modal" style="display:none"><div id="natdb-box">' +
          '<button type="button" id="natdb-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="ctrl.customurls">National databases</h3>' +
          '<p class="cu-hint" data-i18n="ctrl.customurlsHint">Open extra sites for a country in the map popups. Country code = ISO-3166 (e.g. NO, GB).</p>' +
          '<div id="custom-urls-list"></div>' +
          '<div class="cu-actions">' +
            '<button type="button" id="custom-urls-add" class="btn" data-i18n="ctrl.customurlsAdd">+ Add</button>' +
            '<button type="button" id="custom-urls-reset" class="btn btn-light" data-i18n="ctrl.customurlsReset">Reset</button>' +
          '</div>' +
        '</div></div>' +
        '<div id="detlist-modal" style="display:none"><div id="detlist-box">' +
          '<button type="button" id="detlist-close" aria-label="Close">×</button>' +
          '<div id="detlist-head" data-help="maphelp.detlist" data-help-title="detlist.title">' +
            '<div class="detlist-title-row">' +
              '<button type="button" id="detlist-coords" class="detlist-save-btn ico-btn" data-i18n-title="coords.copyBtn" title="Copy coordinates" aria-label="Copy coordinates">' + ico("copy") + "</button>" +
              '<h3 id="detlist-title">Detections</h3>' +
              // Red ✕ (rarity-opened window only): dismiss this alert — mark it seen and
              // take its dot off the map.
              '<button type="button" id="detlist-rarity-x" data-i18n-title="rarity.dismiss" title="Dismiss this rarity" aria-label="Dismiss this rarity">×</button>' +
            '</div>' +
            '<div id="detlist-actions">' +
              '<button type="button" id="detlist-save" class="detlist-save-btn ico-btn">' +
                '<svg class="btn-ico" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none" aria-hidden="true">' +
                  '<circle cx="5" cy="7" r="1.9"/><circle cx="12.5" cy="4.5" r="1.9"/><circle cx="19" cy="9" r="1.9"/>' +
                  '<circle cx="7.5" cy="15" r="1.9"/><circle cx="15" cy="13" r="1.9"/><circle cx="18.5" cy="19" r="1.9"/></svg>' +
                '<span class="ico-label" data-i18n="detlist.save">Save</span></button>' +
              '<button type="button" id="detlist-nav" class="detlist-save-btn ico-btn" data-i18n-title="nav.title" title="Navigate in Google Maps" aria-label="Navigate in Google Maps">' + ico("nav") + "</button>" +
              '<button type="button" id="detlist-route" class="detlist-save-btn ico-btn" data-i18n-title="route.add" title="＋ Add to route" aria-label="＋ Add to route">' + ico("navplus") + "</button>" +
              '<select id="detlist-sort" class="detlist-sort-sel" aria-label="Sort"></select>' +
            '</div>' +
          '</div>' +
          '<div id="detlist-body"></div>' +
        '</div></div>' +
        '<div id="offline-modal" style="display:none"><div id="offline-box">' +
          '<button type="button" id="offline-min" aria-label="Minimize" title="Minimize">–</button>' +
          '<button type="button" id="offline-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="offline.maps">Offline maps</h3>' +
          '<div class="offline-body">' +
            '<button type="button" id="offline-dl" class="btn ico-btn">' + ico("download") + '<span class="ico-label" data-i18n="ctrl.downloadView">Download map</span></button>' +
            '<p class="cu-hint" data-i18n="offline.hint">Saves the map area shown on screen — pan and zoom first (– shrinks this panel to see more of the map).</p>' +
            '<div id="offline-list"></div>' +
          '</div>' +
        '</div></div>' +
        '<div id="blogs-modal" style="display:none"><div id="blogs-box">' +
          '<button type="button" id="blogs-close" aria-label="Close">×</button>' +
          '<h3 id="blogs-title" data-i18n="blogs.title">Birding blogs</h3>' +
          '<p class="cu-hint" data-i18n="blogs.hint">Top birding blogs & resources for this country. Open any, add your own, or remove ones you don\'t want — your changes sync.</p>' +
          '<div id="blogs-list"></div>' +
          '<div class="cu-actions"><button type="button" id="blogs-add" class="btn btn-light" data-i18n="blogs.add">+ Add blog</button></div>' +
        '</div></div>' +
        '<div id="sources-modal" style="display:none"><div id="sources-box">' +
          '<button type="button" id="sources-close" aria-label="Close">×</button>' +
          '<h3 id="sources-title" data-i18n="sources.title">Data sources</h3>' +
          '<p class="cu-hint" id="sources-hint" data-i18n-html="sources.hint2">Tap a source to enable it and edit its details.</p>' +
          '<div id="sources-table"></div>' +
          '<div class="cu-actions" id="sources-actions">' +
            '<button type="button" id="sources-reset" class="btn btn-light" data-i18n="sources.reset">Reset to defaults</button>' +
          '</div>' +
        '</div></div>' +
        '<div id="lists-modal" style="display:none"><div id="lists-box">' +
          '<button type="button" id="lists-close" aria-label="Close">×</button>' +
          '<h3 data-i18n="lists.title">Administer lists</h3>' +
          '<p class="cu-hint" data-i18n="lists.hint">Add species from a species menu or a field checklist. Species missing from this year\'s list get a thin bronze edge on the map; missing from the life list, a thick yellow one. Old year lists are kept until you delete them.</p>' +
          '<label class="ctrl-check lists-edges-row"><input type="checkbox" id="list-edges-toggle"> <span data-i18n="lists.edgesToggle">Show the year/life-list edges on map markers</span></label>' +
          '<div id="lists-list"></div>' +
          '<div class="lists-managers">' +
            '<button type="button" id="lists-species-btn" class="btn btn-light" data-i18n="lists.speciesLists">Species lists…</button>' +
            '<button type="button" id="lists-observer-btn" class="btn btn-light" data-i18n="lists.observerLists">Observer lists…</button>' +
          '</div>' +
        '</div></div>' +
      '</div>';
    return h;
  }

  return { init: init, html: html };
})();
