# Building heights and USGS LiDAR — 0.15.0

## EPT and staged USGS LAZ acquisition (0.15.0)

The architectural gap was acquisition, not LAZ decoding or building generation:
`read_ept` already decoded compressed LAS nodes into seven columns, while
`download_lidar.prepare` hard-wired both the EPT catalog and reader. The
existing `lidar_selection` already compared whole-building survey observations
using usable coverage, supported density and measured capture age. That policy,
the measurement algorithm **7**, roof fitting, print filters and mesh builders
remain in place.

The worker now calls `external/lidar_acquisition.py` for discovery and bounded
reads. `external/lidar_laz.py` adapts delivered LAZ tiles to the existing point
contract: longitude, latitude, metre elevation, LAS class, single-return flag,
capture year and confidence. `lidar_selection.py` selects the final complete
measurement; no format-specific building pipeline exists.

```text
map bounds + existing 75 m halo
  -> EPT coverage index + TNMAccess LPC bbox query (+ optional manifest)
  -> independent survey candidates, scheduled by coverage / labelled age hints
  -> whole-building groups -> intersecting EPT nodes or staged LAZ tiles
  -> crop / XY reprojection / explicit vertical-unit conversion
  -> existing measure_features -> existing survey comparison
  -> existing measurement cache -> existing Blender geometry
```

### Discovery and selection

TNMAccess requests `/api/v1/products` with `datasets=Lidar Point Cloud (LPC)`,
`prodFormats=LAZ`, WGS84 `bbox`, `max=100` and a paginated `offset`. It consumes
`urls.LAZ`, `downloadLazURL` or `downloadURL`, `boundingBox`, source IDs, size,
publication/update dates and metadata URLs. Every page is read and exact links
are deduplicated. API error payloads, repeated/nonadvancing pages, incomplete
listings and invalid products are reported. After transport retries, HTTP
500/502/503/504 responses reduce the page size down to ten, preserving the
same offset; a failed page cannot silently skip later products. Persistent
errors preserve already retrieved candidates and report incomplete discovery.
Failure of one catalog leaves the
other available. Catalog boxes are acquisition estimates; actual roof/ground
support must still pass preparation.
[USGS TNMAccess description](https://www.usgs.gov/faqs/there-api-accessing-national-map-data),
[TNMAccess API interface](https://apps.nationalmap.gov/tnmaccess/).

TNM does not consistently expose capture dates, density or classification
quality. Therefore catalog hints schedule reads but do not discard unknown
surveys or select a format in advance. **All overlapping usable candidates
remain eligible**, even when EPT succeeds. After bounded acquisition, the
existing weighted coverage, explained-roof fraction, saturating supported
density and GPS capture-age score selects one survey per building. The crop's
class-6 share among class-1/6 returns breaks otherwise equal quality/age ties;
this is a classification-availability hint, not a classification accuracy claim.
Raw point counts and number of fitted tiers do not win by themselves.
An EPT and LAZ copy of the same acquisition may both be evaluated when the
catalogs provide no reliable shared identifier; names are not fuzzy-matched.

Publication/update dates never become flight dates or veto observations.
Mixed epochs, missing ground, insufficient support and the existing conflict
preference retain their behavior. Source format, URL, selected quality/age
score, alternatives and catalog candidates are recorded in the audit.

### Tile acquisition and manual manifests

LAZ tiles are grouped by their delivered survey/subproject directory, using
the union of authoritative tile bounds for coverage. Directories identify
collections only; names are never decoded into coordinates. Only tiles
intersecting the current building group and its established halo are fetched.
Ordinary LAZ is not a spatial query service: each intersecting compressed file
must download in full. The existing HTTPS cache now streams those files to an
atomic disk replacement (4 GiB per-file guard) and laspy reads 250,000 points
at a time. Eight million retained crop points still trigger group subdivision.
Identical returns on neighboring tile boundaries are deduplicated; different
survey collections are never merged. Completed tiles are reused across groups.
[laspy chunked reading](https://laspy.readthedocs.io/en/latest/basic.html).

LAS WKT/GeoTIFF CRS metadata defines XY, and a vertical CRS, 3D axis or explicit
GeoTIFF vertical-unit key defines Z. Metres, international feet and US survey
feet are handled independently of horizontal units. Unknown units are rejected
instead of assuming the EPT mirror's metre convention applies to delivered
LAZ. Both readers remove withheld/overlap, vegetation and noise returns, retain
classes 1/2/6, and use the existing same-survey ground subtraction. Adjusted GPS
dates from delivered LAS require the declared encoding; EPT's existing mirror
inference remains scoped to EPT.
[USGS CRS, units and GPS requirements](https://www.usgs.gov/ngp-standards-and-specifications/lidar-base-specification-data-processing-and-handling-requirements).

The advanced manifest field accepts an HTTPS `0_file_download_links.txt` URL
containing direct HTTPS LAZ links. It augments automatic discovery, or the
existing explicit EPT override. Blank lines, UTF-8 BOM, comments and duplicates
are handled. Every listed tile's LAS header/VLRs (and EVLRs if present) is read
through bounded HTTP Range requests to recover its actual CRS and extent.
Only intersecting tiles proceed to full download. Metadata is limited to
4 MiB per tile, and a server ignoring Range is rejected before reading its
response body. No filename-grid inference or whole-project fallback exists.
Large manifests can require many header requests; stale links and unknown CRS
are reported individually while valid candidates continue.

Acquisition signature **1** invalidates old prepared results/checkpoints without
changing measurement algorithm 7. **Prepare LiDAR Buildings again** after
upgrading. The EPT node cache is retained. LAZ checkpoint identities include
tile metadata, and staged downloads use TNM update revisions when present.
The worker refreshes catalog listings once per run; the UI still reuses a
complete matching prepared result. Use **Refresh Existing Cache** to explicitly
rediscover/re-download a completed selection. Esc preserves completed work and
the previous public measurement cache.

### Validation

Tests cover API paging/errors, independent catalog outages, format-neutral
age/density/coverage/classification choices, real compressed LAZ decoding,
chunking, crop masks, withheld/overlap flags, foot conversion, unknown units,
VLR/EVLR range reads, arbitrary manifest filenames, tile seams, revision
identity, atomic failed downloads, and preparation checkpoint resumption.
A dense analytic stepped building survives LAZ serialization, reprojection
and the unchanged measurement pipeline with its expected 30 m base and 60 m
upper tier at the default print scale.
All **455 Python tests** pass in the downloader environment. Blender 3.6
smoke, LiDAR preference/geometry, six minimum-height cases and modal/cancel
regressions pass. Both 0.15.0 archives contain 56 files matching the workspace
source, including the two new acquisition modules. The add-on is not installed.

Live TNMAccess testing on 2026-09-09 returned one 150,950,127-byte Chicago tile
for a small test bbox. Header-only requests read EPSG:6455 and the correct
0.30480060960121924 US-survey-foot Z conversion; the full map selection and
user caches were untouched. The bulk download from RockyWeb stalled and was
stopped; a 1 MiB range completed. A published USGS manifest was also inspected:
its text was available but its first linked S3 tile returned 404. These live
checks confirm why delivery failures and stale manifest links must be reported.

A second TNM tile (13,114,844 bytes, Goshen County) completed its live download
and chunked decode in 105 seconds. Its catalog rectangle's center had no
returns; a crop around actual returns retained **18,113 points** (2,948 class 1
and 15,165 ground), correctly transformed from EPSG:6612 with survey-foot Z.
GPS dates identify **2016** capture despite the project's 2017 name and 2022
catalog update. The second crop reused the downloaded tile with **zero network
requests**. Live acquisition/cropping is verified; building reconstruction
was verified with the analytic LAZ fixture and existing Blender regressions,
not a new live LAZ city build at that stage. Diagnostics: `scratchpad/lidar-laz/`.

### Default Cincinnati follow-up

The live query used the exact defaults from `config.py`:
`-84.53370,39.08554,-84.47422,39.11094`. TNM returned **124 LAZ products**:
77 from Ohio Statewide Phase 3, eight from Kentucky Western, and 39 from two
legacy surveys. The EPT catalog also lists two Kentucky surveys overlapping
part of this map; Cincinnati is not wholly outside EPT catalog coverage.

To keep this a quick acquisition/build test, preparation used a workspace copy
of **46 real buildings and 33 associated parts** in the portion outside both
EPT coverage geometries. Map bounds, actual fresh Blender scale/detail
settings, automatic discovery and the normal worker were retained. This is
a bounded building sample, not a claim to have prepared every Cincinnati
building. No explicit source URL, source-format override, synthetic points or
city-specific acquisition rule was used.

The worker downloaded one intersecting **24,397,445-byte modern Ohio LAZ tile**
and two small legacy tiles. Modern points declare EPSG:6551 horizontal CRS,
US-survey-foot Z and GPS capture year **2022**, despite the project's 2021
name and 2025 publication date. The legacy LAS 1.0 files contain no CRS VLR;
they are rejected without guessing coordinates or units. The preparation UI
now reports the actual source issue, rather than mislabelling missing CRS as
an incomplete download that another retry would fix.

Results: **36/46 prepared buildings**, **23 tiered**, **nine plane roofs**,
four height-only. Ten unresolved/complex roofs retain source fallback under
the existing rules. All accepted measurements use the modern LAZ source.
The normal Generate Model operator loads the matching preparation signature
and uses all **36 buildings**, with **96 tier sections**, **14 plane solids**
and **zero geometry fallbacks**. The model also contains the existing cached
terrain, roads and other layers: **41 meshes / 1,994,628 faces**, all passing
manifold and winding checks; 3MF export succeeds. The focused building audit
also checks positive volume. A default-scale source/LAZ close-up was rendered
and inspected.

Replaying the saved catalog responses and three completed modern checkpoints
reproduces all 36 records, final rejections and counts with **zero network
requests**. The legacy tiles are rechecked from disk and remain unsupported.
The EPT reader, hierarchy traversal and node intersection functions are
unchanged from the pre-LAZ implementation; EPT and mixed-source selection
regressions pass. The transient TNM page failure and truthful source-status
reporting have dedicated regression tests. Python suite: 455 passing tests;
Blender modal/cancel, minimum-height, roof/geometry and live-generation checks
pass. Diagnostic fixture, source inventories, request, render, 3MF and audits
are under `scratchpad/lidar-laz/cincinnati/`. User caches and the installed
add-on remain untouched.

## Preparation consistency checks (0.14.2)

The 2026-09-09 Chicago cache (`bbox_fc293ec456a2`, 2,240 candidates,
0.01 mm width / 0.02 mm step at the default output scale) accepted 730 buildings
and reported **704 consistency skips**. Those were 434 `footprint_roof_mismatch`,
158 `observed_ground_in_footprint`, and 112 `roof_extends_outside_footprint`.
They were scan/footprint checks, not source-height conflicts: the cache already
had Prefer LiDAR on Conflicts enabled.

The general cause of recoverable failures was **overcounting clipped grid
cells**. Roof coverage treated a partially clipped boundary cell like a full
missing roof square. Ground and exterior-roof checks credited the full 9 m²
square even when most of it lay outside the tested region or behind an excluded
neighbor footprint. Narrow boundaries could therefore look like broad evidence
of a missing or enlarged building.

Targeted corrections in `external/lidar_measurements.py`:

* If the existing roof-cell coverage check fails, retry the **same 85%** limit
  with the actual supported footprint area. Every disconnected footprint
  component must independently reach 85%; the denominator includes the full
  footprint, including ignored boundary slivers. The existing 65% coarse gate,
  four-cell minimum and at least three consistent returns per cell remain.
  No missing cells are interpolated. Already accepted coverage fits are kept.
* Ground-only evidence uses each occupied cell's intersection with the inset
  footprint. The four-cell and 20% area requirements, ground classification,
  roof exclusion and same-survey reference remain unchanged.
* Exterior-roof evidence uses each occupied cell's intersection with the test
  ring after neighboring footprints are masked. The 2 m registration margin,
  6 m halo, matching roof elevations, three-return requirement, 36 m² / 8% of
  footprint / 25% of ring gates all remain unchanged.

Many skips remain necessary. Broad interior ground observations provide no
reliable roof for the mapped building in that survey; missing returns alone do
not prove demolition. Substantial unobserved roof sections, broad unexplained
roof extensions, missing ground, noisy elevations and unresolved upper masses
still retain source geometry. Later roof fitting, print-detail cleanup, survey
selection and transactional closed-mesh fallback are unchanged. No new toggle,
default change, building detector or city-specific exception was added.

`download_lidar.prepare` now supplies `rejection_counts` for **unique final
rejected buildings**. Historical `counts` still counts individual observations
across surveys and must not be presented as the number of skipped buildings.
`data.lidar.measurement_summary` derives the same breakdown from cached final
rejections, and the preparation status displays the three footprint checks
separately from source/survey conflicts.

Algorithm **7** invalidates prior measurement checkpoints and results.
**Prepare LiDAR Buildings again** after upgrading; immutable downloaded tiles
are reused. The installed add-on and user caches were not changed during this
investigation. Diagnostic samples, workspace cache replay and validation logs
are in `scratchpad/lidar-consistency/`.

### Validation against the user's cached selection

| Result | Before | After |
|---|---:|---:|
| Accepted buildings | 730 | 851 |
| Roof-coverage consistency skips | 434 | 368 |
| Ground-inside consistency skips | 158 | 130 |
| Exterior-roof consistency skips | 112 | 55 |
| All consistency skips | 704 | 553 |

That is **121 additional accepted buildings** and **21.4% fewer consistency
skips**. Sixty-two new acceptances previously failed roof coverage, 58 exterior
checks, and one complex source assembly recovered a part. Some cleared checks
lead to a different rejection: all 28 relieved ground-area vetoes still fail
roof coverage or density. A reduced consistency count is not itself an accepted
building, and no absent roof is manufactured to improve the headline number.

All 730 previously accepted buildings remain. **729 records are identical**;
one adds a usable 18.6 m part height, preserving its prior measurements. The
replay makes zero network requests and has no download failures; checkpoint
resumption reproduces the records and counts. All 438 pure tests pass, including
rotated boundary coverage, missing multipart sections, positive ground evidence,
real roof extensions, neighbor masks, unique rejection counts and algorithm-6
cache invalidation. The exterior-extension fixture now exceeds the actual area
gates; its old one-sided case depended on counting 240 m² as 360 m².

Blender geometry/roof, minimum-height and modal/cancel/status regressions pass.
THE MART, 71 South Wacker, 311 South Wacker and Aon retain identical geometry,
with closed, consistently wound positive-volume meshes. At this cache's fine
step setting, 311 and Aon use the same source fallback as before. Reviewed
source-versus-recovered-LiDAR renders show Heyworth Building and Two First
National Building in `scratchpad/lidar-consistency/`. No physical print was made.

Full-map generation uses **819 LiDAR buildings versus 704 before**, with 16,578
tier solids, five measured sloped roofs, three restored main masses and 15 part
heights. Six of the additional fits fail mesh construction and safely retain
source geometry (29 geometry fallbacks total, previously 23). All **39 meshes /
4,090,514 faces** pass manifold and winding checks, and full 3MF export succeeds.
Only BUILDINGS and TERRAIN_SUPPORTS change; the other 37 mesh fingerprints match
the baseline exactly.

## Current behavior: massing and LiDAR preference (0.14.0)

**Prefer LiDAR on Conflicts** is enabled by default inside the existing optional
LiDAR workflow. Once preparation succeeds, Use Prepared LiDAR is enabled as
before. The preference allows a usable measured envelope to supersede source
height/floor/construction-date conflicts and richer mapped roof shapes. It also
chooses the best individual usable survey when competing observations conflict,
using the existing coverage, support and capture-age ranking. The audit records
ignored survey conflicts and the original source-height decision. No survey
geometries or ground references are mixed. Disable the preference for the prior
conservative source/survey conflict policy, including protection against stale
tall scans of demolished buildings. This default change follows the user's
explicit preference for LiDAR on 2026-09-09.

It does not bypass missing ground, weak roof coverage, mixed capture epochs
inside one candidate, positive ground/absence observations in that candidate,
footprint mismatch, unsupported upper masses, corrupt caches or failed mesh
construction. These cases retain source geometry. It cannot create buildings
absent from the OSM/Overture footprint source.

Defaults are **0.1 mm detail width / 0.05 mm roof step**, with the width control
allowing **0.01 mm**. At the default scale these defaults correspond to about
1.43 m width / 0.65 m rise. Survey cells have a 1.5 m sampling floor and require
multiple consistent returns; lowering the width does not invent sub-survey
resolution. Existing scenes keep explicitly saved values. Algorithm **7** and
the conflict preference are part of the cache signature: **prepare again after
upgrading or changing the preference/detail settings**, reusing downloaded tiles.

### Diagnosed losses and general fixes

* **311 South Wacker:** the old fit used only accepted flat roof patches to
  define the tower below them. Irregular higher roofs and small separate crown
  patches vanished, shrinking the roughly 2,229 m² source main tower to about
  1,301 m² above the podium. Each upper level now uses all supported higher
  returns, bounded by the original footprint and lower support. Physical width
  and a four-cell support minimum replace the old 1.5%-of-building-area cutoff.
  Up to 24 supported levels replace the old six-level limit; identical adjacent
  footprints coalesce. If filtering removes over 20% of a measured section,
  reject the envelope instead of silently retaining only its surviving pieces.
  The default-scale fit restores the main shaft and separate crown sections.
* **Aon Center:** there is no reliable surrounding LiDAR ground fit. Source
  fallback suppressed the explicit 340 m parent and kept only a 346 m roof part
  covering 29.9% of its footprint. Source selection now retains a trustworthy
  explicit parent when all associated parts have explicit tops at least as high
  and leave substantial footprint area uncovered. Lower setbacks, complete
  assemblies, missing/derived parent heights and duplicate filtering retain
  their prior rules. This fix also works with LiDAR disabled.
* **THE MART regression in 0.13.0:** finer sampling exposed a high edge band
  from the neighboring main roof on a low 8-floor glass part. Its maximum tier
  conflicted with the floors and vetoed the main infill. A source part's scalar
  height now checks its interior when sufficient area remains; source-shaped
  parts use coarser height aggregation because their measured polygons are not
  being emitted. Failed part fits keep their source parts. A narrower one-metre
  consensus separates adjacent shallow roof levels when choosing the dominant
  main base. The main mass is again about **76.4 m**, with the rooftop assembly
  retained. The seven usable part measurements include the central crown when
  LiDAR is preferred; conservative mode retains its explicit source top.
* **Minimum Building Height:** a tall cached tower previously satisfied the
  minimum for a low podium. Measured terraces now use their lowest base roof
  for the lift, moving upper tiers together. Fitted roofs use the apex actually
  inside the crop and keep their pitch. The footprint gate and highest shared
  terrain remain authoritative. Zero disables lifting; artificial lift does
  not trigger a LiDAR-only slenderness rejection.

No building names, IDs, special-case footprints, new detector, new dependency
or replacement geometry engine are used in these fixes. Existing closed-solid
construction, shared terrain and transactional source fallback remain.

### Current validation

413 pure tests pass, including small separate crowns, more than six setbacks,
shallow steps, non-flat roof support, component loss, noise, source-part edge
spill, conflict preference and cache invalidation. Blender smoke, six minimum
height regressions, preference/geometry fallback, and modal/cancel tests pass.
The four Chicago examples build with no geometry fallback and closed,
consistently wound positive-volume meshes. Prepared records at both 0.1 mm and
0.01 mm width retain THE MART, 311 South Wacker and 71 South Wacker; Aon keeps
its complete source fallback. Evidence and renders: `scratchpad/lidar-v6/`.

The full cached Chicago run prepares 518 buildings (430 tiered, 9 plane roofs)
and generates 487 LiDAR buildings, 5,353 tier solids, 3 restored infills and
11 corrected parts. Thirty measured envelopes fail mesh construction and
retain their source geometry. All 34 meshes / 2,056,294 faces pass manifold and
winding checks, and 3MF export succeeds. With LiDAR off every mesh fingerprint
matches 0.13.0; enabled, only BUILDINGS and TERRAIN_SUPPORTS change. Preparation
reuses existing tiles and resumes from checkpoints. No physical print was made.

The following sections describe earlier releases and their policies.

## Source confidence and incomplete assemblies (0.12.0)

The existing Overture/OSM footprints, IDs, source roof shapes, shared terrain,
closed-prism builder and export path remain authoritative. LiDAR algorithm 4
adds spatial source-height checks and supplements incomplete mapped assemblies.
**Prepare LiDAR Buildings again after upgrading.** Algorithm 3 measurements and
checkpoints are stale; immutable downloaded EPT tiles are reused. Preparation
and generation report restored main masses and corrected part heights.

### Chicago diagnosis before editing

The cached selection `bbox_125c4fc8e7fc` covers
`-87.64442,41.87627,-87.61906,41.89276` and contains 1,542 buildings.

* **THE MART** (`a4060d52-97e2-4092-9582-5fc23409ac56`) is present as an OSM
  footprint of about 19,807 m². Its nine mapped roof parts cover only **15.0%**
  of it. The existing selection rule suppresses the whole parent as soon as
  any part has useful vertical data, losing the main mass. Whole-roof LiDAR
  fitting also fails: 98.7% roof-cell coverage, but only 25% explained by simple
  flat regions, with roughly half the returns unclassified.
* **71 South Wacker** (`cc8ccd06-e760-48ca-abf1-a019037db148`) has an OSM
  footprint, a **Microsoft-derived 22.52 m parent estimate**, a 30 m OSM podium
  covering 37.65%, and a heightless tower covering 62.35%. The former global
  `max(parent.height, part.height)` veto discarded a good LiDAR observation.
  The 2017 Cook County survey supplies 97.3% roof coverage and coherent levels
  near **18.4, 32.6, 203.2 and 207.1 m** above same-survey ground.

Both targeted measurements replayed from existing tiles with zero network
requests. Evidence, input snapshots and before/after renders are in
`scratchpad/lidar-v4/`; no user's cache or installed add-on was changed.

### Height confidence

Height provenance is read from `sources[].property == /properties/height`,
not from the footprint provider or a confidence number. Explicit architectural
heights with unknown provenance stay trusted. Microsoft ML and USGS-derived
estimates can be corrected on a large conflict when the scan has at least 90%
roof coverage, 80% explained support and one supported point/m², with a coherent
region/plane method. Independent matching mapped parts or a floor count that
demonstrates an estimate is wrong can also corroborate the correction.

Credible explicit height disagreements still reject in **both** directions.
Missing/estimated heights are also checked against a broad floor-count range
(2–5 m per floor with 10/15 m tolerance); a matching explicit architectural
height outranks inconsistent floors. An explicit height internally contradicted
by its own floor count can yield to a strong scan that agrees with those floors.
Part heights constrain their own **exposed** roofs: mapped higher parts can
occlude a lower podium. A heightless neighboring tower does not inherit the
podium's height limit. No source file is rewritten.

This is the simple stale-data heuristic: a credible current short height/floor
count blocks an old tall scan even without dates. Existing construction-date,
capture-epoch, footprint/ground-absence and competing-survey checks remain.
An undated derived estimate without corroborating mapped evidence cannot prove
whether a building has been replaced; this remains a limitation, not an inferred
construction history. OSM edit timestamps are never construction dates.

### Retaining source parts and filling a missing main mass

For partial or shaped mapped assemblies, measure useful source parts separately
against the **same whole-building ground reference**. Keep good explicit tops;
correct absent, floor-derived and estimated tops while retaining source roof
shapes, identities and undersides. Failed part fits retain those source parts.
The missing main mass is the exact source footprint minus mapped parts, with
real courtyard holes retained. Gaps must exceed 15% of the parent and the
configured minimum detail area before this pass attempts a fill.

For these source-constrained components, a complex roof can yield a height
without being misrepresented as terraces: require 90% coverage, classified
corroboration (40%), supported density, coherent adjacent cells (80%), and a
bounded height spread/tail. A dominant flat band explaining at least 20% of a
complex missing main roof supplies its conservative base; otherwise use the
supported component height. Tall unresolved upper roofs cannot enter this
fallback. This extra fallback never detects unmapped footprints.

THE MART gains a **76.4 m** main mass and **six corrected part heights**, while
keeping all nine source roof shapes and its explicit 104 m crown. Two difficult
lower roof parts retain source heights, with reasons recorded. Wacker uses the
existing nested tier builder and two matching source part boundaries.

The `source_parts` record adds `part_heights` and optional `infill_geometry`.
Blender validates both. An infill commits its part corrections only after all
its mesh checks pass, so failed geometry retains the complete original assembly.
Each solid remains separately closed and consistently wound, sharing terrain
placement and the existing slicer-union convention. It is not one Boolean shell.
LiDAR disabled follows exactly the previous source-generation path.

### Buildings truly absent from source footprints

THE MART did not require building detection. A diagnostic experiment withheld
its outline and grouped class-6 returns outside other mapped buildings. The
largest connected patch recovered **98.1%** of the true footprint but **10.0%**
of that patch lay outside it; eight sizeable clusters survived in the small
crop. This can suggest a building, but does not establish its boundary, identity
or current existence. Unclassified roof extensions, neighboring structures,
scan seams and stale demolished buildings require further decisions.

No automatic LiDAR-only detector is shipped. The existing Overture download
already includes non-OSM building footprints, which can receive these same
LiDAR enhancements. For a building absent from that entire source, geometry
still needs a footprint. This keeps the change focused on the diagnosed failures
without silently introducing speculative buildings.

### Validation

Focused Blender regressions cover both merged and separate solids, source-shape
retention, shared ground, corrections without an infill, and complete fallback
on broken infill geometry. Source-confidence tests cover stale tall/short scans,
derived estimates, independent corroboration, overlapping podium/tower parts,
units, corrupt part/infill records and algorithm-3 invalidation. Both real
Chicago targets build with no geometry fallback and pass manifold, winding and
positive-volume checks. Their combined targeted output has 6,322 faces.

The following version-specific sections document earlier behavior and evidence.

## Reliability review (0.11.2)

Five reproduced failure cases were fixed without changing measurement or mesh
algorithms: damaged checkpoint structures aborted resumption; malformed survey
metadata stopped later surveys; a cancellation timeout stranded the modal job;
empty cached upper-tier polygons could leave a podium-only result; and a NaN
roof base passed validation. Shared standard-library record validation now checks
cached and newly published results, so invalid measurements use source fallback.
Damaged batches recompute while healthy checkpoints resume. Invalid LAS/LAZ
decoding becomes a reported source failure, with Refresh guidance for cached
corruption. Cancellation escalates only the owned external worker, reaps it, and
keeps polling if termination fails so another worker cannot compete for the cache.

381 unit tests and focused Blender geometry/lifecycle tests pass. Replaying all
57 Manhattan checkpoints produces exactly the same 677 measurements, selected
surveys and rejections, with zero network requests. All existing roof/tier records
pass the stricter validation. No geometry, terrain, scale or export changes;
algorithm 3 caches remain compatible and do not require preparation again.
Installed in Blender 3.6 on 2026-09-08 after user-confirmed closure. All 50
installed files, module/version, dependency probes and preferences verified;
existing map/LiDAR caches were preserved. Rollback files:
`dist/install-backup-0112-20260908-142826/`.

## Survey selection and changed buildings (0.11.1)

Preparation now compares **all overlapping catalogue surveys** for each whole
building instead of taking the first accepted measurement or stopping at three
projects. An explicit EPT URL still selects only that project. Usable roof-cell
coverage, explained surface area and saturating supported-point density form a
quality score; comparable quality favors more recent capture. No points, ground
references, roof tiers or heights are blended between surveys. Results and
alternatives are recorded in `lidar_buildings.json`; preparation reports the
number of surveys compared and buildings kept as source geometry on conflict.

Dates come from point GPS times where interpretable, not LAS creation dates,
upload dates, Overture releases, or OSM edits. Some cached USGS EPT nodes declare
GPS-week encoding despite values outside the valid week range. On the recognized
mirror only, plausible adjusted-GPS values yield a **gps_inferred_ept** year,
distinct from **gps_declared**; unavailable dates remain unknown. Project-name
years are scheduling hints only. Mixed significant capture years within a
building and its ground neighborhood reject the enhancement; minority epochs
and undated points are excluded from otherwise adequately dated measurements.
[LAS GPS time definition](https://asprslas.org/stable/02.00_definition.html),
[laspy header encoding](https://laspy.readthedocs.io/en/latest/_modules/laspy/header.html).

Compatibility safeguards retain the **entire original parent/part assembly**:

- Roof coverage must reach 85% for the footprint and each disconnected component.
- Broad positively observed ground inside the footprint signals an absent or
  partial building; missing returns alone are insufficient evidence of demolition.
- Broad classified roof extension outside the footprint rejects a possible
  replacement/enlargement, allowing registration tolerance and mapped neighbors.
- Large explicit height contradictions are checked in both directions. Explicit
  construction dates can rule out older observations. Source record `update_time`
  is an edit date, not construction evidence.
- Different major measured heights or flat-tier layouts between surveys require
  chronology: an older high-quality scan cannot override a contradictory newer
  building. Same-year/unknown-order conflicts use source fallback. A newer or
  undated contradictory absence/mismatch also blocks resurrection from an older
  survey. Sparse/failed downloads alone do not prove absence.

[Overture source timestamps](https://docs.overturemaps.org/schema/reference/common/source_item/).

This is conservative conflict handling, not automatic historical reconciliation.
A replacement with the same footprint and similar roof may be indistinguishable;
unknown dates cannot prove which source depicts today's building. Fallback may
retain an outdated mapped building, but does not graft incompatible measurements
onto it. A LiDAR building absent from OSM/Overture is not added without a clean
source footprint. Refresh normal building data when it is outdated, then prepare
LiDAR again. A failed survey is reported as incomplete and can be retried.

**Upgrade:** prepare again after 0.11.0. Algorithm version 3 invalidates old
measurements and batch results while reusing downloaded LAZ tiles. No changes to
the existing geometry, terrain, scale or export pipeline were needed.

Validated and installed 2026-09-08: **376 unit tests**, Blender geometry and
preparation-lifecycle tests pass. The Manhattan crop compares two projects,
both inferred to have local 2014 captures: **677/1708 measurements**, **109**
tiered and **4** plane buildings; **278** compatibility conflicts retain source
geometry. All tile reads used the existing cache, with zero network requests.
Generation uses **615** measured buildings, **168** tier solids and **8** plane
solids, preserving **56** richer mapped assemblies with **6** geometry fallbacks.
All **36** meshes are closed and consistently wound (**1,906,376 faces**), and
3MF export succeeds. LiDAR-off fingerprints exactly match 0.11.0; enabling it
changes only buildings and their supports. Physical printing is untested.
All **49** installed archive files, dependency probes, module/version and
installed Prepare result were verified. The user's matching Manhattan cache
and 57 batch checkpoints were updated; backups are in
`dist/install-backup-0111-20260908-102730/`. Other selections need preparation.

The version-specific 0.11.0 results below are historical, not current counts.

The opt-in enhancement includes measured heights, major flat roof tiers,
supported roof planes, and matching Overture part boundaries. The existing
map pipeline remains in place. The height fix and first LiDAR pass shipped
in 0.10.0 on 2026-09-07; 0.11.0 completes the bounded, resumable workflow.
Version 0.11.0 was installed and verified in Blender 3.6 on 2026-09-08.
The existing Manhattan cache was updated and the installed preparation
operator confirmed 819/1708 measurements. Rollback files are under
`dist/install-backup-0110-20260908-093235/`.

## Why the previous result looked unchanged

The user's cached Lower Manhattan bbox was
`-74.01953,40.69919,-73.98726,40.71415`. The New York EPT survey exceeded the
old 8-million-point whole-area cap. Preparation then accepted only **5**
buildings from a neighboring New Jersey survey, while the rest used source
geometry. That partial result was reused as if preparation were complete.

In 0.11.0 the same selection yielded **819 measurements**, including **122 tiered
buildings and 4 fitted sloped roofs**, with no acquisition failures. The full
Blender model uses **747 measured buildings, 201 tier solids and 8 roof-plane
solids**. It preserves **66** richer source buildings and falls back on **6**
geometry failures. Measurement counts and generated counts are deliberately
separate. The largest processed batch held 789,887 points.

Visual review also caught a dangerous fallback: an unbuildable upper tier
could leave only a low podium. That now rejects the entire enhancement.
Unresolved broad upper roofs and large conflicts with explicit source heights
also retain source geometry or try another survey. No building height is
clamped to a maximum. Existing printable source crowns and more detailed
part assemblies remain intact when a measurement lacks their detail.

## Larger selections without whole-map caps

Buildings are assigned to roughly 400 m groups. Each query includes their
complete roofs plus nearby ground, bounded by the selected map's 75 m halo.
Groups exceeding the point/node working limits subdivide automatically.
Completed measurements checkpoint under `bbox_*/lidar_jobs`; immutable EPT
resources share `cache/lidar_tiles`. Cancellation/failure retains completed
work and the previous public measurement cache. Retrying incomplete preparation
reuses checkpoints and tiles. Refresh deliberately ignores old checkpoints.

The previous 25 km², 512 MiB total, 8-million whole-area point and 30-minute
job caps are removed. Per-response, per-node, per-group and per-building
guards remain to bound memory and reject malformed or individually excessive
inputs. Disk space, connection availability and processing time remain real
constraints; this does not promise unlimited regional reconstruction.

| Option investigated | Practical tradeoff |
| --- | --- |
| Existing EPT + resumable building groups (implemented) | Reuses public coverage, dependencies, cache and footprint coordinates; no regional cloud in Blender |
| PDAL streamed EPT processing | Mature streamed reader and spatial queries; useful future adapter but adds a native Windows installation |
| COPC selective range queries | Efficient when that source is published as COPC; does not turn the USGS EPT catalogue into COPC coverage |

[PDAL EPT streaming and spatial queries](https://pdal.io/en/stable/stages/readers.ept.html),
[laspy COPC queries](https://laspy.readthedocs.io/en/latest/api/laspy.copc.html).

## Measured roof planes

Equal-weight roof-cell XYZ centroids feed deterministic robust plane fits.
One to four broad planes must explain at least 90% of the sampled surface;
area, width, slope, spatial support and residual checks reject unreliable fits.
Their lower envelope is intersected analytically with the original footprint,
including courtyards. This supports shed, gable and hip roofs and compatible
broad crowns; it is not triangulation of raw points.

Each polygon carries ground-relative vertex heights and uses the existing
closed prism builder, with full support and a small overlap into its base.
Model clipping evaluates the original plane so slopes survive a map edge.
Plane sets are transactional: missing coverage rejects the whole enhancement.
Highly complex roofs, mixed slope/terrace reconstruction, concave roof networks,
facade details and thin spires remain source fallbacks. Current measured planes
cover an entire supported roof, not arbitrary planes attached to every terrace.

## 0.11.0 regression evidence

- **362 unit tests pass**, including acquisition bounds/resumption, roof fits,
  noise rejection, stale cache detection and cancellation preservation.
- Standard Blender smoke and focused LiDAR geometry/lifecycle tests pass.
- With LiDAR disabled, all **36** meshes in the full Manhattan map have exactly
  the same vertex, face and material-index fingerprints as 0.10.0.
- With LiDAR enabled, all **36** meshes are closed and consistently wound;
  the full map has **1,908,023 faces**. Buildings and their foundations change;
  terrain, roads, bridges, water, land surfaces and trees retain fingerprints.
- The existing 3MF exporter succeeds, writing the 36 parts as one object at
  millimetre scale. Physical printing has not been validated.
- Real Chicago and Manhattan geometry and comparison renders were checked.
  Renders exposed the source-detail loss that the preservation rule fixes.

The remaining sections record the architecture and the original 0.10.0
height investigation, with workflow updates for 0.11.0.

## Existing pipeline and integration point

| Step | Existing implementation | LiDAR addition |
| --- | --- | --- |
| Sources | External `overturemaps` client downloads `building` and `building_part` GeoJSON for the bbox | External helper discovers USGS EPT coverage and reads intersecting LAZ nodes |
| Cache | `CacheBundle`: bbox directory, feature files and merged manifest | `lidar_buildings.json` plus reusable hashed EPT tiles in `cache/lidar_tiles` |
| Selection | `select_building_geometry` suppresses parents with useful parts and duplicate outlines | A successfully built measured envelope replaces that parent's selected masses; failed enhancement keeps them |
| Coordinates | WGS84 → local ENU → model mm; source rings clipped to the model rectangle | Processing uses local metric coordinates; cached tier polygons return to WGS84 and use the same ENU transform |
| Heights | Explicit height, floors × floor height, class default, configured default | Reliable same-survey roof-minus-ground measurements take priority |
| Placement | Shared minimum/maximum terrain over parent and siblings; draped undersides | Reuses shared ground, underside draping, embed and water supports |
| Geometry | Closed `MeshBuilder` prisms and shaped roofs | Same builder, clean footprint base and nested stepped solids |
| Export | Existing collection/material batching and millimetre 3MF exporter | Unchanged exporter; no point clouds enter Blender |

Terrain still comes from the existing shared height field. LiDAR does not
replace or resample it. Building Z is `terrain_base_mm + measured_height_m ×
scale_z × building_height_scale`, not LiDAR sea-level elevation added to the
terrain. Terrain exaggeration never multiplies building heights.

## Height bug: evidence and correction

Cached Chicago part `w284816229@2` has `height=177.4`, `roof_height=73`,
`roof_shape=skillion`; its parent has `height=177`. The old blanket additive
part-roof rule generated a 250.4 m top. The parent clamp only ran when
`parent_height > part_height`, so this particular error bypassed it entirely.
Other parts, including an explicitly 184 m building with a default hip roof,
also acquired extra height simply because they were parts.

Explicit building **and part** totals now include the roof: Chicago's example
has walls to 104.4 m and a roof top at 177.4 m. This follows the OSM height
definition, including the roof and measuring from the lowest ground contact.
[OSM height](https://wiki.openstreetmap.org/wiki/Key:height),
[Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings).

The earlier Cincinnati evidence is retained narrowly: a roof that cannot fit
inside the part interval is added above the walls only if an explicit parent
total agrees with that sum within 0.5 m. Great American Tower's
`140 → 162.7 + 40 = 202.7 m` crown still works. An absent or conflicting parent
does not authorize this exception. There is no maximum-height clamp.

Additional fixes and findings:

- An inverted interval (`height=5`, `min_height=9`) previously became a new
  12 m top. It is now reported and skipped; minimum-only parts cannot replace
  the parent on their own. Non-finite values are rejected.
- Explicit unit strings such as `100 ft` convert to metres instead of being
  ignored or misread. OSM level aliases are supported. Floor-derived walls
  receive the roof once; an explicit total already includes it.
- `min_height`/`min_floor` remain underside elevations, not thicknesses added
  to the top. Parts still share their parent's terrain base. `level` is not
  used as an extra floor count.
- The default **Building Height Scale = 1.1** and **Minimum Building Height =
  0.8 mm** intentionally enlarge some geometry. They are preserved. For a
  source-height audit use scale 1.0 and minimum 0.0. At 0.07 mm/m, 0.8 mm is
  about 11.4 real metres before the building multiplier.
- Source data itself can disagree: the cached Willis Tower parent has a
  USGS-derived 31.1 m height, while its OSM parts describe the tower. A parent
  total is therefore not a safe universal cap for its parts.

Reproduce the numerical source audit without Blender:

```powershell
python scripts/audit_building_heights.py --cache <bbox-directory> --output audit.json
```

Overture's current schema wording calls height the distance between the lowest
and highest points; it does not resolve every ground-relative OSM part in
these caches. The existing, tested OSM-derived absolute-top interpretation is
preserved instead of changing all parts to `min_height + height`.
[Overture building schema](https://docs.overturemaps.org/schema/reference/buildings/building/).

## Practical acquisition

USGS LidarExplorer supports discovery, downloads and EPT visualization.
Original 3DEP LAS/LAZ tiles are available through The National Map. The AWS
public EPT mirror provides spatially indexed access to many of those surveys;
the original AWS LAS/LAZ bucket is requester-pays. EPT coverage is not identical
to all 3DEP coverage.
[USGS LidarExplorer](https://www.usgs.gov/tools/lidarexplorer),
[AWS dataset registry](https://registry.opendata.aws/usgs-lidar/).

The implemented path uses the mirror's GeoJSON coverage index and TNMAccess
LPC tiles as described above, intersects the selected bbox, and compares every
overlapping survey. An optional EPT URL overrides automatic discovery; a
manifest can add manual LAZ candidates. Each building is measured
within one survey; overlapping acquisitions are never mixed.
[Mirror coverage index](https://github.com/hobuinc/usgs-lidar/blob/master/boundaries/resources.geojson).

For EPT, only intersecting hierarchy pages and LAZ nodes are fetched. EPT is
additive, so ancestors must be included with descendants. The reader targets
0.75 m sampling, adjusts Web Mercator horizontal resolution for latitude, and
crops decoded points to the requested area plus a 75 m ground/boundary halo.
[EPT format](https://entwine.io/en/latest/entwine-point-tile.html).

The mirror uses EPSG:3857 XY. Its normalized metre Z convention is used only
on recognized USGS mirror hosts; declared vertical CRS units are converted
explicitly. Unknown units on other sources are refused. NOAA documents metre
conversion for mirrored USGS EPT datasets. Heights always subtract nearby
ground in the same survey, so a constant vertical-datum offset cancels.
[Mirror coordinate system](https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/README.rst),
[NOAA EPT processing example](https://www.fisheries.noaa.gov/inport/item/72412).

PDAL's `readers.ept` is a capable alternative and supports bounds and resolution
queries. This Windows installation had no PDAL. The first pass uses laspy/
lazrs wheels and a small bounded EPT reader in the existing external Python,
avoiding a new native PDAL distribution requirement. Direct TNM LAZ acquisition
now uses those same dependencies. General local LAS/LAZ import and COPC spatial
queries remain future adapters.
[PDAL EPT reader](https://pdal.io/en/stable/stages/readers.ept.html),
[laspy installation](https://laspy.readthedocs.io/en/latest/installation.html).

## Measurement and print geometry

Nearby class-2 ground cells establish a robust local plane; surrounding ground
coverage and residual checks reject unreliable extrapolation. The lowest
predicted footprint ground is the building reference. Roof candidates use
class 6 and single-return class 1, excluding vegetation, noise and withheld
returns. Cook County illustrates why class 6 alone is insufficient: Willis
Tower's upper roofs are class 1 while its low podium is class 6.

Inside the original footprint, a grid aligned to its principal axes measures
the highest dense elevation band in each cell. Connected continuous surfaces
are checked for flatness. Broad supported regions become elevation levels;
small islands, antennas, thin strips and unstable cells do not become tiers.
At least 85% cell coverage is required, and tier candidates must explain a
majority of the usable cells. Flatness thresholds are measurement tolerances,
not clamps on building height. Classified non-flat roofs can supply a robust
height only; supported slopes use the plane fitter above. Ambiguous surfaces
fall back. A dominant flat consensus can discard small HVAC/parapet noise;
it must explain most of its continuous region, so broad slopes do not become
arbitrary staircase bands.

Plateaus are simplified, near-rectangular patches regularized, and missing
return holes filled. Real courtyard holes are reapplied from the footprint.
The exterior base footprint is preserved. Upper footprints are intersected
with the layer below, producing full support and no added overhangs. Each
tier overlaps its supporting layer by 0.02 mm and is individually closed,
matching the add-on's established independent-shell/slicer-union convention.
This is not a Boolean-fused single shell.

Defaults retain details at least **0.6 mm wide** and **0.2 mm high**. At the
fixed scale these correspond to about 8.6 m horizontal detail and 2.6 m vertical
steps with the default 1.1 multiplier. Maximum six height levels constrain
complexity. A minimum-height lift moves all measured tiers together. If any
required mesh construction fails, the original parent/parts jobs remain.

## Setup and use

Install optional dependencies outside Blender:

```powershell
.\.venv-overture\Scripts\python.exe -m pip install -r requirements-lidar.txt
```

Use the existing downloader Python setting. Cache buildings normally, open
**Buildings → USGS LiDAR Buildings**, then click **Prepare LiDAR Buildings**.
Preparation enables **Use Prepared LiDAR**; click **Generate Model** as usual.
Keep **Generate Roof Shapes** on for measured slopes. Preparation runs in the
background with progress in Buildings; Esc cancels and retains completed work.
No network is used during generation. Turning the option off restores the
corrected source-based building path. Changed bbox, footprint files, print
scale, detail thresholds or source URL invalidate the measurements. Use
**Refresh Existing Cache** to re-fetch data deliberately.

The cache records source URLs, sampling, ground references, coverage, methods,
rejection reasons by building ID, timestamps, source-file hashes and budgets.
Missing, stale, corrupt, unsupported or failed data cannot silently become
empty replacement geometry. Preparation failures preserve the previous cache.

Working guards: 4,096 EPT nodes, 40 million source points and 8 million retained
crop points per group, 2 million points per individual LAZ node, 32 MiB per
response and 40,000 roof cells per building. Groups subdivide on point/node
limits. An individually excessive building safely falls back. Completed groups
are reused on the next preparation, including after an incomplete download.

## Validation and next stages

The focused Chicago selection was `-87.6385,41.877,-87.632,41.8815` (96 building
features). Final acquisition used 246 nodes, about 91 MB of cached reads and
4.91 million cropped candidate/ground points. It accepted 34 measurements,
7 with tiers. Blender built 32 measured buildings with 16 tier solids; two
enhancements fell back at geometry checks. The complete building selection
was closed and consistently wound, with 14,941 polygons on the synthetic
sloping test ground.

Willis Tower's measured podium is about 10.9 m, then broad levels near 200.7,
264.2, 360.4, 437.2 and 445.0 m. The generated envelope is 2,583 polygons in
the focused test, including the terrain-draped underside. This is an empirical
check on one survey, not a nationwide accuracy claim. Survey age and roof
classification quality matter. Slicer/physical-print validation remains open.

The full preparation operator, generation with LiDAR enabled/disabled, and
existing 3MF exporter were also exercised successfully. The exporter needed
the already-installed `io_mesh_3mf` add-on enabled in the factory-startup test
session. The two-object terrain/buildings export retained millimetre units.
The height audit found 11 changed part-roof extents in the larger Chicago
cache and 337 in the Cincinnati sample, before printable-size filtering.

Regression commands:

```powershell
python -m unittest discover -s tests -p 'test_*.py' -t tests
.\.venv-overture\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -t tests
& '<Blender path>' --background --factory-startup --python-exit-code 1 --python tests/blender_smoke.py
& '<Blender path>' --background --factory-startup --python-exit-code 1 --python tests/blender_lidar.py
```

`tests/blender_lidar.py -- --bundle <bbox-directory> --output comparison.png`
also checks a real measurement cache and renders a source/LiDAR comparison.

0.11.0 implements the bounded scheduler, supported plane fitting and part-edge
matching described above. Further reconstruction should only be added where
survey evidence and print scale justify it. Photogrammetry, facade detailing
and thin spires are outside this automated printable envelope. No second OSM
acquisition pipeline was necessary.
