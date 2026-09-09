# Jarvizar City Model — working context

A Blender add-on that turns a WGS84 bounding box into printable miniature city
geometry from Overture Maps + public elevation tiles. It replaces a BLOSM-based
workflow. The user (Adam) prints these on a Bambu FDM printer.

**Read this before changing geometry code.** Most of what follows is the result
of a specific bug that cost real time to find, and the reasoning is not
recoverable from the code alone.

---

## The target

The goal is a 3D-printed city miniature: white/neutral building massing, dark
road ribbons, green parks, terrain relief, and **the river cut out of the
terrain as an open void**. Adam supplied a Bambu Studio screenshot of a previous
BLOSM model as the reference look. Bridges span the void with no piers standing
in it.

He cuts the model manually to fit the plate, so **do not add build-plate fitting**.

## Print scale — this is fixed, do not "improve" it

- **0.07 mm per real metre** = 1:14,286. This is `mm_per_metre`, default, scale
  mode `FIXED`.
- At that scale a 6.5 m residential street prints **0.455 mm**, which is the
  0.45 mm minimum feature width his slicer resolves. That is not a coincidence —
  the whole scale is chosen for it.
- Roads are **0.6 mm tall** = 3 layers at 0.2 mm.
- For building/LiDAR detail, Adam's current guidelines are **0.1 mm wide /
  0.05 mm tall**, preserving useful silhouettes and removing noise. These are
  practical guidelines, not universal printability thresholds. The LiDAR width
  control permits 0.01 mm; survey sampling still limits actual resolution.
- Terrain base is **1.3 mm** below the lowest surviving land.
- **Export STL with "Scene Unit" UNCHECKED, import into Bambu at 100%.**
  Scene Unit on exports metres (0.1516) instead of mm (151.6).

Do not switch the default to `FIT` mode. Fit-to-170mm gives 0.033 mm/m, where
the 0.45 mm floor stands for 13.6 m of real road and footways come out as wide
as motorways. That was the original "roads are too big" complaint.

---

## Environment (this machine)

| Thing | Path |
|---|---|
| Repo | `c:\Users\adamj\Desktop\3dmapcreator` |
| Blender | `C:\Program Files\Blender Foundation\Blender 3.6\blender.exe` (3.6 only, no 4.x) |
| Add-on install | `%APPDATA%\Blender Foundation\Blender\3.6\scripts\addons\jarvizar_city_model` |
| Downloader venv | `c:\Users\adamj\Desktop\3dmapcreator\.venv-overture\Scripts\python.exe` (`overturemaps==1.0.2`) |
| Cache | `%APPDATA%\Blender Foundation\Blender\3.6\datafiles\jarvizar_city_model\cache` |
| Sample bbox | `-84.53370, 39.08554, -84.47422, 39.11094` (Cincinnati, ~6 km, cached as `bbox_4df7cf1c3668`, now including `infrastructure.geojson`) |

Shell is Git Bash **and** PowerShell. `$APPDATA` works in Bash.

### Commands

```bash
# unit tests (413, all pure, no bpy) -- note the -t tests
python -m unittest discover -s tests -p "test_*.py" -t tests

# synthetic full-pipeline test inside Blender (writes its own fixtures)
"/c/Program Files/Blender Foundation/Blender 3.6/blender.exe" --background \
  --factory-startup --python tests/blender_smoke.py

# real data end-to-end + manifold check over every mesh
"/c/Program Files/Blender Foundation/Blender 3.6/blender.exe" --background \
  --factory-startup --python tests/blender_live_full.py -- \
  --cache "C:/Users/adamj/AppData/Roaming/Blender Foundation/Blender/3.6/datafiles/jarvizar_city_model/cache"

# visual check; --water 0 is the reference look, --target/--span aim at one spot
... --python tests/render_preview.py -- --cache <cache> --output preview.png \
    --water 0 --target -113,-55 --span 60

# unmerged buildings only, one object per feature (takes the bbox dir itself)
... --python tests/blender_live_smoke.py -- <cache>/bbox_4df7cf1c3668

# embed/overhang probe: every cap face of roads, slabs, buildings, piers and
# supports measured against the height field (skips zero-area faces)
... --python tests/blender_embed_probe.py -- --cache <cache>

# clipboard paste button; needs a real window, so no --background
powershell -c "Set-Clipboard -Value '-84.53576,39.08541,-84.48473,39.11475'"
"/c/Program Files/Blender Foundation/Blender 3.6/blender.exe"   --factory-startup --python tests/blender_gui_paste.py

# build both zips into dist/
python scripts/build_addon.py
```

`--factory-startup` disables add-on preferences. Any test that needs the stored
Overture Python path must run **without** it.

### Installing (the trap that cost two round trips)

Blender's **Install…** writes files to disk but does **not** re-import an
already-loaded package. The old UI and old generator keep running until Blender
restarts. Twice this looked like "the new code isn't working" when it was purely
a stale in-memory module.

Install by extracting the zip over the addons folder with Blender **closed**,
clearing `__pycache__`, then enabling and `bpy.ops.wm.save_userpref()` headless.
A running Blender rewrites `userpref.blend` on exit and will clobber preferences
written underneath it — always check `Get-Process blender` first, and **ask
before force-closing** (he has said yes once; that was not standing permission).

---

## Current state

- Repository/release version is **0.14.0**, LiDAR algorithm **6**. At the start
  of this completion pass (2026-09-09), the user-installed **0.13.0** Python
  files matched the working tree exactly. **0.14.0 installed 2026-09-09** at
  the user's request with Blender closed. All 51 archive files, installed
  module/version, preference defaults, 0.01 mm width limit and dependency
  probes verified; add-on enabled and downloader preferences saved. Backup:
  `dist/install-backup-0140-20260909-071947/` (add-on and user preferences).
  User map/LiDAR caches remain unchanged.
  **Prepare LiDAR Buildings again after upgrading**, reusing downloaded tiles.
  Cache signatures include the algorithm, footprint files, scale, detail
  settings, roof-plane setting and the new conflict preference.

  **Prefer LiDAR on Conflicts is enabled by default**, as Adam explicitly
  requested on 2026-09-09. Use a usable measured envelope despite source
  heights/floors/construction dates, richer mapped roof detail or competing
  survey observations. Keep the original source-height decision and ignored
  survey conflicts in the audit; never blend surveys. Turn the toggle off to
  restore the prior conservative conflict policy (including stale tall scans).
  Data/geometry failures still fall back: missing ground, insufficient roof
  coverage, mixed epochs within one candidate, footprint mismatch, positive
  absence observations, unsupported major sections or failed closed meshes.
  OSM/Overture remains the footprint/identity/tag source and fallback.

  LiDAR defaults are **0.1 mm width / 0.05 mm step**, width minimum **0.01 mm**.
  Existing scenes retain explicitly saved settings. A 1.5 m roof-cell floor
  and multiple-return support checks limit sampling resolution; the width
  control filters detail, it does not create finer measurements.

  THE MART's 0.13.0 regression was a high edge return from its main roof on a
  low glass part, causing a floor-count conflict that rejected the infill.
  Source-part scalar heights now use stable aggregation and interior checks;
  narrow consensus bands keep different shallow roofs from winning the main
  base vote together. The **76.4 m main mass** is restored, with rooftop shapes
  retained. Failed part fits keep their original parts. Preferred LiDAR also
  updates the central crown when its usable scan disagrees with the source.

  413 pure tests, Blender smoke, focused geometry/preference, six minimum-height
  and modal/cancel regressions pass. The four Chicago targets build closed,
  consistently wound positive-volume meshes with no geometry fallback.
  Full Chicago preparation accepts **518/1542** buildings, **430 tiered**,
  **9 plane roofs**, **3 infills**, **11 part heights**, **31 corrected derived
  heights**. No network requests were needed. Evidence, snapshots and comparison
  renders are in `scratchpad/lidar-v6/`; design in `docs/LIDAR_BUILDINGS.md`.
  Full generation uses **487 LiDAR buildings / 5,353 tier solids / 9 plane
  roofs**, with 3 infills and 11 part corrections. Thirty measured envelopes
  fail mesh construction and retain source geometry. All **34 model meshes /
  2,056,294 faces** pass manifold and winding checks; the 3MF export succeeds.
  With LiDAR off every mesh fingerprint matches installed 0.13.0; enabled,
  only BUILDINGS and TERRAIN_SUPPORTS differ. No physical print was performed.
- User-installed **0.13.0** improved massing and minimum height, following the
  0.12.0 source-confidence/infill changes. Diagnosed against actual cached data:
  311 South Wacker's main tower lost about 40% of its area because only accepted
  flat roof patches supplied the geometry beneath them. Supported higher
  returns now contribute to that mass, small crowns use a physical support
  floor instead of 1.5% of the whole building, and up to 24 levels replace the
  old six-level cap. Discarding >20% of a section rejects the whole envelope.
  Aon lacks reliable LiDAR ground; its 340 m parent was suppressed by one
  346 m roof part covering 29.9%. Source selection now retains a credible parent
  under incomplete higher roof parts, without swallowing lower setbacks.
  Minimum Building Height uses the low measured base terrace instead of a tall
  tower above it; tiers move together, roof pitch remains, zero disables lift,
  and artificial lift does not trigger slenderness rejection. This applies the
  same footprint gate and highest shared terrain as source buildings.
  Prior measurements/evidence are in `scratchpad/lidar-v4/` and `lidar-v5/`.
- Previously installed **0.11.2** after a
  focused LiDAR reliability review. Installed 2026-09-08 after the user closed
  Blender; all 50 archive files, installed module/version, dependency probes and
  preferences verified. Backup: `dist/install-backup-0112-20260908-142826/`.
  Five reproduced failure cases fixed: malformed checkpoints,
  malformed survey metadata, cancellation timeout, empty upper-tier polygons,
  and nonfinite roof bases. Shared standard-library record validation protects
  both preparation/checkpoints and Blender cache loading. LAS/LAZ decode errors
  are recoverable source failures. Failed cancellation retains worker ownership
  until exit, preventing concurrent writes. No geometry/measurement algorithm
  changes; algorithm 3 caches remain compatible.
  381 unit tests, Blender smoke, focused geometry and lifecycle tests pass.
  All 57 real Manhattan checkpoints resume with exactly the same 677 records,
  survey choices and rejected buildings, zero network requests. Evidence and
  installation/verification scripts: `scratchpad/lidar-review/`. Existing user
  map and LiDAR caches were preserved; no preparation is required for this patch.
- Previously installed **0.11.1**, installed 2026-09-08 with Blender
  closed. All 49 archive files, installed module/version, dependency probes,
  preferences and the installed Prepare operator were verified. Rollback:
  `dist/install-backup-0111-20260908-102730/`.
  Algorithm 3 compares all overlapping EPT projects using supported roof
  coverage/detail and capture age; no first-result or three-project cutoff.
  GPS years may be declared or explicitly inferred from known-mirror EPT;
  project publication and OSM edit dates are not acquisition/construction dates.
  Reject mixed capture epochs, partial/absent roof coverage, outside-footprint
  roof extensions (excluding mapped neighbors), symmetric source height
  conflicts, and ambiguous differing survey heights/tier layouts. Keep the
  whole source assembly on conflict; never blend surveys or resurrect an
  older LiDAR building against newer contradictory observations. New buildings
  absent from the footprint source are not generated from LiDAR alone.
  Updated Manhattan cache: 677/1708 accepted, 109 tiered, 4 plane buildings;
  2 surveys compared, 278 compatibility conflicts kept source geometry.
  Generation uses 615 measured buildings, 168 tier solids, 8 plane solids;
  preserves 56 richer source assemblies and has 6 existing geometry fallbacks.
  376 unit tests, focused Blender geometry/lifecycle, full map and 3MF pass.
  LiDAR off: all 36 mesh fingerprints unchanged from 0.11.0. On: only BUILDINGS
  and TERRAIN_SUPPORTS change; 36 closed consistently wound meshes, 1,906,376
  faces. Evidence in `scratchpad/lidar-v3/`, design in `docs/LIDAR_BUILDINGS.md`.
  Other selections need Prepare again; cached LAZ files are reused.
- Previously installed **0.11.0** (installed 2026-09-08 with Blender
  closed). All 48 installed archive files, version/module path, downloader
  dependencies and the refreshed Manhattan measurement cache were verified.
  Preferences saved. Rollback addon/preferences/LiDAR cache are in
  `dist/install-backup-0110-20260908-093235/`.
  0.11.0 implements resumable 400 m LiDAR groups, background preparation
  with Esc cancellation, measured shed/gable/hip planes, matching part edges,
  and persistent preparation/generation counts. Whole-map area/point/byte/time
  caps are removed; per-group guards subdivide work. No new dependencies.
  The user's Manhattan bbox `-74.01953,40.69919,-73.98726,40.71415`
  (`bbox_91680650326b`) previously yielded just 5 measurements after the NYC
  survey hit the point cap. Now 819 measurements, 122 tiered, 4 sloped roofs;
  full generation uses 747 buildings / 201 tier solids / 8 plane solids.
  66 richer mapped assemblies/crowns are kept, 6 geometry fallbacks. Never
  leave only a podium when an upper measured tier fails. Strong conflicts
  with source heights reject uncertain measurements, not clamp heights.
  362 unit tests, Blender smoke, plane geometry and modal lifecycle pass.
  All 36 full Manhattan meshes match 0.10.0 exactly with LiDAR off. Enabled:
  36 closed, consistently wound meshes / 1,908,023 faces; 3MF export passed.
  Only buildings and their foundations change. See `docs/LIDAR_BUILDINGS.md`.
- Previously installed **0.10.0**, with the part-roof
  height correction and opt-in USGS LiDAR heights/tiers. Installed on
  2026-09-07 with Blender closed; all 46 archive files matched the installed
  copy, its module path/version and LiDAR settings were verified, Overture
  and LiDAR dependency probes passed, and downloader preferences were saved.
  Rollback add-on and preferences: `dist/install-backup-0100-20260907-220129/`.
  Read `docs/LIDAR_BUILDINGS.md` for the pipeline trace,
  measured Chicago bug, acquisition contract, validation and current limits.
  LiDAR uses only the external Python for laspy/lazrs/pyproj/Shapely; Blender
  consumes small cached measurements through its existing prism builder.
- Previous installed Blender 3.6 add-on is **0.9.12**;
  `dist/jarvizar_city_model-0.9.12-{blender36,extension}.zip` built. Installed
  with Blender closed, all 41 files hash-checked; installed cone geometry,
  tree UI defaults and palette checks passed. Preferences saved; prior add-on
  backed up in `scratchpad/installed-before-0912.zip`.
- 0.9.12 = simple solid cone trees, no trunk/overhanging canopy. UI width
  floor 1.2 mm, height floor 2.0 mm and size variation; final varied trees
  respect both floors. Trees sample actual generated land/road slab caps,
  including holes, and use the existing surface embed. Smoke and focused
  tree geometry checks passed; full Chicago generated 1,864 trees and all
  33 model meshes were closed. Bambu CLI slicing timed out; no completed
  slicer or physical print validation yet.
- 0.9.11 = mutually exclusive land-surface categories with scene-configurable
  priority. Default paved > sand > rock > green > forest, arrows in Ground
  Surfaces reorder all five, saved in `surface_priority_order`. Generation
  passes the order through `SurfaceSettings` to `cut_surface_overlaps` in
  `geometry/surface_priority.py`. Cuts built cap footprints after water clipping
  and before the existing road cut, preserving holes, cap Z, slab thickness and
  materials. Reuses `FootprintIndex` / `fragment_solid`; same-category pieces
  retain their existing shared-material behavior. Existing `EPSILON` (0.0001 mm)
  clearance prevents float32 edge rounding from leaving microscopic overlaps.
  334 pure tests, Blender smoke, geometry/road-cut and reorder/persistence
  regressions pass. Live Chicago: 0/251036 overlap rays, 33 closed meshes;
  Cincinnati: 0/2059768 overlap rays, 42 closed meshes. Other existing meshes
  were fingerprinted before/after the cut and remained identical. Tests:
  `tests/blender_surface_priority.py`, `tests/blender_surface_priority_live.py`,
  `tests/blender_surface_priority_settings.py`.
- 0.9.10 = palette only: white buildings and parts, ash-grey terrain/supports,
  charcoal roads/bridges/paving, matching dark-green forest/grass/trees, and
  matching desert-tan sand/rock. Water and rim colors retain their prior values.
  `model_materials()` updates existing named materials on Generate Model.
- 0.9.9 = targeted short-bridge refinement. Two-ended, unbranched components
  too short to gain normal road clearance at the grade start at the bank chord,
  raised for terrain and local crossing-road height. Parallel roads do not
  add a hump; crossings between coarse profile samples are detected. Long,
  branched, stacked, cropped and internally anchored networks keep their solve.
  Regular pier stations remain; a supplemental pass measures actual gaps to
  ground and built piers, adding low abutments or piers where a run exceeds
  spacing. New supports avoid roads, rail and lower decks and require ground.
  Foundation heights over water include the causeway's existing 0.05 mm offset.
  Tests: `tests/test_bridge_supports.py`, `tests/test_deck_graph.py`,
  `tests/blender_short_bridges.py`, cached `tests/blender_bridge_caps.py`.
  334 pure tests and Blender smoke passed. Exact user Chicago bounds
  `-87.64721,41.87279,-87.62438,41.89432`: 211 decks, 739 pier contacts passed,
  33 closed meshes. Cincinnati `-84.53563,39.08084,-84.48014,39.11634`:
  178 decks, 1143 pier contacts passed, 42 closed meshes. All 102 Chicago and
  107 Cincinnati deck pieces in components >=25 mm retained identical heights
  to 0.9.8. Existing tight-curve cap fallback remains; simple caps match profiles.
- 0.9.8 = targeted terrain-support refinement. `SupportBuilder` checks outline
  and interior against remaining open water before adding a pedestal, skips
  exact repeated footprints, and refines cap interiors through the existing
  draping routine. Boundary-only caps previously bridged terrain hollows and
  protruded above ground. **Keep the existing 0.05 mm embed**: it prevents
  coincident faces at bank overlaps; larger interpolation errors caused the
  visible raised patches. Skipped solid candidates still register usable
  ground so `has_ground` recognizes dry decks in mixed shoreline cells and
  does not suppress valid bridge piers. Chicago supports 312 -> 282, with no
  measured protrusions above actual terrain at the audited cap samples.
  320 unit tests, Blender smoke, water and support geometry checks passed;
  the installed package was hash-checked and ran both geometry regressions.
  Tests: `tests/blender_ground_support.py`, `tests/blender_water_cut.py`.
- 0.9.7 = water cutout fix: marina extents no longer restore entire harbors as
  land; water masks compose scanline unions/differences before choosing shore
  crossings. See `docs/WATER_CUTOUTS.md`. This remains in 0.9.8.
- 0.9.6 = **Minimum Building Height** (0.8 mm) with a footprint gate
  (**Raise Only Footprints Over**, 0.6 mm). A mass whose finished top does not
  clear the ground by the minimum has its walls stretched until it does; the
  roof rides up unchanged, so a gable keeps its pitch. Two decisions worth
  keeping:
  * The clearance is measured from the **highest** terrain under the footprint,
    not the base, so the roof stands proud on the uphill side; and for a
    building with parts that maximum is taken over the whole building
    (`shared_ground` returns min *and* max, cached per parent exactly like the
    old `shared_base`), because a per-part maximum would stretch siblings by
    different amounts and break the level-tops invariant.
  * The gate is `footprint_admits_minimum_height` in `geometry/buildings.py`:
    area >= size^2 **and** `effective_width >= size / 2`. Both halves are
    needed -- a 0.1 x 4.0 mm wall strip has four times the area of a 0.6 mm
    square and is exactly the fin the gate exists to stop. Raised masses are
    at least 0.3 mm wide and 0.8 mm tall, slenderness 2.7, so nothing the
    minimum creates can become a needle.
  Bug found and fixed while measuring: the lift was first taken from
  `max(top, roof_top)`, but a shaped roof that falls back to flat still
  carries its unbuilt apex in `roof_top`, so 15 masses landed 0.13 mm short.
  It now measures `roof_top if shaped else top`; after the fix every raised
  mass ends at exactly the minimum (raised clearance min 0.800, max 0.820, the
  0.02 being multipolygon features whose metadata records the last ring).
  Sample bbox at the defaults: **5,504 buildings + 212 parts raised of 10,823
  masses**, lift p50 0.361 / p90 0.588 / max 2.027 mm, 3,959 masses left below
  the minimum on purpose (they failed the footprint gate). Threshold
  sensitivity, same run: 0.4 mm -> 8,765 raised, 0.6 -> 5,715, 1.0 -> 1,023,
  1.5 -> 422. Nothing else moves: 42 objects, 0 non-manifold, 265,802
  BUILDINGS polygons (identical to 0.9.5), 38.9 s, embed probe unchanged.
  Measured with `scratchpad/probe_minimum_height.py` (buildings on the real
  DEM only, merge off, so every mass keeps `minimum_height_lift_mm` and
  `terrain_top_mm`).
- 0.9.5 = **Building Height Scale**, default **1.1**. One multiplier on the
  vertical scale inside `generate_buildings` (`height_scale`), applied to the
  shared `transform.vertical_meters_to_model_mm` so every height a mass is
  built from -- top, elevated underside, wall top, roof apex -- moves
  together, and parts scale with their parent. Nothing else moves: footprints,
  roads, terrain, trees, `mm_per_metre` and the recorded `height_m` metadata
  are unchanged; the factor is reported as `building_height_scale`. Measured
  on the sample bbox, 1.0 vs 1.1: tallest mass 15.47 -> 16.89 mm, shaped roofs
  247 -> 320 (`roofs_below_minimum` 315 -> 228, since a 10% taller roof clears
  the 0.15 mm minimum), `rejected_too_slender` 110 -> 144 and
  `building_parts` 1,238 -> 1,204 -- slenderness is judged on printed
  thickness, so the boost costs 34 masses already under 0.45 mm wide, which is
  the intended reading (a taller needle is a worse needle) and is the one
  knock-on effect to remember. 42 objects, 0 non-manifold of 42, 38.7 s
  either way. The smoke test's roof assertions are in real metres so its first
  pass pins the scale at 1.0; a third pass at 1.1 checks the tops scale
  exactly, no mass is dropped, and every `SURFACE_ROADS` object keeps its
  z-range to 1e-6.
- 0.9.4 = road-cut performance and progress fix for Milwaukee
  (`-87.94324,43.01613,-87.87543,43.05647`, cache `bbox_75148b916e86`).
  0.9.3 built over 1.5M individual cutters from refined road caps and did not
  report progress until a whole surface category finished; reproduction took
  187 s total, ~134 s cutting. Footprints now come from built prism wall rings,
  with redundant boundary points removed at 0.0001 mm, below the 0.005 mm
  clearance; an invalid ring graph/triangulation falls back to the original
  cap method. The cut takes ~46 s on the saved pre-cut model. Progress reports
  while preparing roads and every 2048 cap triangles, weighted by surface size.
  No road, bridge, terrain or placement changes. Regression test includes a
  heavily refined L-shaped road whose footprint needs only four cutters and
  verifies monotonic progress. `blender_live_full.py` now accepts `--bbox`.
  Full Milwaukee validation: 38 meshes, 0 non-manifold, 0 overlaps across
  1,902,680 BVH samples and 30 other meshes bit-identical; 12,435 ground roads,
  164 decks. Full run including the audit took 114 s. Installed and verified
  0.9.4 with Blender closed; previous 0.9.3 add-on and preferences are backed
  up in `dist/install-backup-20260905-195556/`.
- 0.9.3 = ground-road footprints cut full-depth openings through landcover
  slabs after roads are generated (`surface_priority.py`, pure clipping in
  `footprint_cut.py`). Built cap triangles supply the footprint, so skipped
  roads leave no gaps and demoted bridges do cut. Adam explicitly chose to
  keep landcover under elevated bridges. Terrain/base, water, trees, buildings,
  causeways and piers are untouched. Clearance is 0.005 mm per XY axis, bounded
  to 0.0071 mm diagonally even at sharp corners. Surviving cap fragments keep
  interpolated Z and original thickness, each as a closed independent shell.
  Sample: 4 landcover objects cut, 2145.9078 mm² removed (sum over layers),
  0 overlaps in 1,096,184 independent BVH rays, 34 other meshes bit-identical,
  42 objects and 0 non-manifold meshes. Geometry grows 1.35M → 2.36M polygons;
  generation ~14 → 45 seconds. 304 unit tests and Blender smoke pass. Regression
  probes: `tests/blender_road_cut.py` and `tests/blender_road_cut_live.py`.
- 0.9.2 = bridge cap triangulation preserves every profile cross-section
  (`geometry/deck_mesh.py`). Whole-outline tessellation skipped crests and
  made diagonal divots: sample max error 0.51 mm, 51/167 decks over 0.01 mm.
  All 166 simple ribbons now match profile stations to numerical precision;
  the one tightly looping fallback is unchanged (overlapping turns make its
  topmost-hit error ambiguous). No solver, width, pier or causeway changes.
  298 unit tests, Blender smoke and live full pass; 42 meshes, 0 non-manifold,
  polygon count unchanged, 820/820 pier tops inside their own decks. Reproduce
  with `tests/blender_bridge_caps.py -- --cache <cache-root>` in Blender.
- 0.9.1 = **Paste Coordinates**. One button under the bbox fields fills all
  four from `west,south,east,north` on the clipboard, which is what the Copy
  button at prochitecture.com/blender-osm produces. `parse_bounds_text` /
  `format_degrees` are pure (`data/projection.py`); the operator reads
  `window_manager.clipboard` in `invoke` and only opens a dialog when the
  clipboard cannot answer. See "Pasted bounds" below. 294 unit tests.
- 0.9.0 = the 3MF export path and consistent face winding. **Export 3MF for
  Bambu** writes every generated object as one 3MF object with one part each,
  at true millimetres; and `orient_faces_outward` re-winds any solid whose
  degenerate cap slivers handed their walls the wrong direction. Sample:
  **0 inconsistently wound shells of 25,033** (was 107) and **0 faces facing
  inward of 1,349,935** (was 1,366, of which 713 in `BUILDINGS`); polygon count
  unchanged to the face, 13.7 s, 0 non-manifold.
- 0.8.0 = loose deck ends touch down + merged objects. A deck end that is
  neither a joint nor a surface-road end is anchored to the ground like a
  road end (`solve_deck_network(open_ends=...)`; ends on the bbox edge stay
  free), and a component standing over cut water is never demoted.
  Buildings (+ parts in their own material slot) and trees are one object
  each by default (**Merge Buildings and Trees**). Sample: 167 decks
  (66 demoted, was 41), 69 touchdown ends, 10 open ends, 820 piers all
  inside a deck, lift p50 1.0 / max 2.6 unchanged, **42 objects** (was
  ~15,800), 12.8 s (was 15.7), 0 non-manifold. 274 unit tests.
- 0.7.0 = even roads and sane bridges: terrain smoothing (3×3 mean), the
  whole-network deck solve (anchors at the road surface, floors from what a
  deck crosses, 8 % grade, demotion of decks that cannot rise a layer),
  deck thickness 0.6 = road, clearance in printed mm, stacking only at real
  crossings, convex-piece fallback for tight ramps, piers 0.1 mm into decks.
  Sample: 192 decks (41 demoted), 133 components, 840 piers all inside a
  deck, lift p50 1.0 / max 2.6 mm (was 1.2 / 4.4).
- 0.6.0 = printability pass: every draped cap is refined to the drape spacing
  so slabs and ribbons follow the ground across their interior; building
  undersides are draped instead of flat at the lowest corner; one
  **Embed Into Terrain** setting (0.15 mm) replaces the 0.3/0.35 mm embeds;
  land surface rise 0.4 mm; slab clipping takes the crossing nearest the dry
  node so no slab reaches over the water; the exact void test is judged on
  the terrain cell's own dry polygon and `ground_height_mm` uses it.
- 0.5.1 = duplicate building outlines suppressed (Scripps Center), sidewalks
  and crossings skipped by `subclass`.
- 0.5.0 = shaped roofs, parts founded on the parent's base, slenderness
  exemption above one nozzle line, road/deck width cap 0.7 mm.
- 0.4.0 = ground supports over cut water, bridge chains, rail bridges,
  recovered crossings, slabs clipped to land, satellite-forest scatter,
  infrastructure download. See "Hard-won decisions" for each.  Before/after
  close-ups were made with `render_preview.py --water 0 --target x,y --span n`
  at (-113,-55) Brent Spence, (17,-20) Roebling/Taylor-Southgate, (43.7,22.4)
  the riverbank satellite-forest slab.
- 294 unit tests pass; smoke, live full, live smoke and the embed probe all
  pass. `blender_live_smoke.py` needed `cut_water_from_terrain = False`
  added in 0.9.0: it switches every non-building feature off, but the cut
  reads the water layer independently of the blue slab, so it had been
  failing on "No cached water" since 0.4.0.
- Live run on the sample bbox: ~15,800 objects, ~16 s (was 13 s before cap
  refinement; polygons 0.94 M → 1.35 M, land slabs 35 k → 243 k, roads
  419 k → 688 k), **0 non-manifold of 10,898 meshes**, 360.2 × 197.4 mm at
  1:14,286.
- Embed probe on the sample (`tests/blender_embed_probe.py`, samples every
  cap face against the height field, skipping zero-area faces): slabs sit 0.13–0.17 mm
  below the terrain at p01–p99 (was −0.47 floating … +1.78 buried) with 0
  samples over the cut water (was 208); roads 0.14–0.16 (max 0.24, was 0.66);
  building undersides 0.14–0.22 at p01–p99 (was 0.30–0.65, max 2.1 → 1.4,
  the 1.4 being a garage the DEM buries under its own hillside).
  247 shaped roofs (3 dome, 30 pyramid, 99 skillion, 100 gabled, 15 hipped),
  315 left flat as under 0.15 mm, 1,238 parts founded on their parent's base,
  slender rejections 116 → 111 (the five restored are Carew Tower's shaft and
  Great American Tower's wings).
  22 causeways under 21 river decks (plus 25 rail decks, 2 recovered
  crossings), 4 building pedestals, 7 mapped-deck pedestals, 31 slabs clipped
  to land, 277 trees kept out of the water.

---

## Architecture

Everything is aligned to **one shared height field** (`geometry/heightfield.py`).
The elevation provider is resampled once, in model millimetres, onto exactly the
grid the terrain mesh is built from; every other generator interpolates that.
This is why a road does not sink into a hillside. Do not sample the DEM directly
from a generator.

```
data/        cache.py geojson.py overture.py projection.py terrain.py dem.py
             land.py (surface allowlist) linework.py (scoped road rules)
external/    download_overture.py  download_dem.py   (run out of process)
geometry/    planar.py         all pure planar geometry lives here, plus
                               shell_volume / faces_are_consistent /
                               orient_faces_outward (winding repair)
             heightfield.py    the shared grid + the void mask + cut outlines
                               + registered support footprints (ground queries)
             watermask.py      wet nodes + exact shoreline crossings
             terrain_mesh.py   pure terrain solid, water cut out (also builds
                               draped-bottom slabs clipped to land)
             dem_terrain.py    terrain + rim Blender objects
             surfaces.py       water solving, the cut, land slabs
             support.py        SupportBuilder: causeways + pedestals (bpy)
             bridge_network.py pure: void runs, crossing recovery, joint keys
             deck_graph.py     pure: the whole-network deck height solve
             roads.py bridges.py deck_profile.py buildings.py
             roofs.py          pure: roof semantics + planar-region / apex geometry
             building_generation.py vegetation.py
blender/     mesh_utils.py (MeshBuilder, watertight prisms) collections.py materials.py
config.py    AddonPreferences + scene PropertyGroup
operators.py download / generate / export-3mf / clear orchestration
ui.py        N-panel
```

Pure modules import **no bpy** and are unit tested. `blender/mesh_utils.py`
imports bpy, so anything testable must not live there — that is why
`terrain_solid_geometry` was moved out of it into `geometry/terrain_mesh.py`.

### Generation order (operators.py) — order is load-bearing

1. Build height field
2. Solve water bodies (needs terrain heights)
3. **Hydro-flatten** terrain down to each water surface
4. **Cut** water out (void mask + `void_rings` on the height field; mapped
   decks from `infrastructure`/`land` take their footprint back and are
   remembered in `restored_footprints`)
5. Terrain solid → returns its real `bottom_z`
6. `SupportBuilder(heightfield, bottom_z)` → pedestals for mapped decks
7. Land surfaces (slabs reaching the water are grid-clipped) → water →
   roads/bridges (causeways registered *before* piers are placed) → road footprint
   subtraction from landcover slabs only → trees →
   buildings (pedestals) → supports built into `TERRAIN_SUPPORTS`

Steps 3–4 must precede everything that asks the height field for ground.
Ground queries, all on the height field: `is_void` (whole-cell, conservative),
`in_cut_water` / `over_open_water` (exact, outline only consulted in shore
cells), `is_supported`, `has_ground` (piers), `ground_height_mm` (nearest
surviving land over the cut; deck anchors and surface-road draping).

---

## Hard-won decisions — do not regress these

**Overture `height` is absolute from the ground, not a thickness above
`min_height`.** A mass spans `min_height` → `height`. Adding them turned Great
American Tower's crown (min_height 140, height 162.7, real building 202.7 m)
into a 302.7 m spire. Evidence: 0 of 229 parts have `min_height >= height`;
parent heights match `max(part.height)` 13× vs `max(min+height)` 3×.
`VerticalProfile` carries `bottom_m` / `top_m` with a `thickness_m` property.

**Slenderness is judged on `thickness_m`, not height above the street.** A crown
section is a squat block that starts 140 m up; measuring from the ground threw
legitimate ones away. **And it only applies below one nozzle line (0.45 mm,
`slenderness_exempt_width_mm`).** Of 116 slender rejections on the sample, 93
were < 0.2 mm wide (real needles) and the 5 that were ≥ 0.45 mm were Carew
Tower's shaft (slenderness 21.9) and Great American Tower's wings (20) — the
buildings Adam noticed were "missing details". A mass a line wide prints at
any height.

**Explicit heights include roofs for parts too (corrected in 0.10.0).** The
blanket additive rule inflated Chicago part `w284816229@2` from 177.4 to
250.4 m by adding its 73 m roof. Its 177 m parent bypassed the old clamp.
The GAT crown retains a narrow legacy exception: a roof that cannot fit
inside the part interval, with an additive top corroborated by the explicit
parent total within 0.5 m (162.7 + 40 = 202.7). No general height cap.
Floor-derived walls receive the roof once. Invalid/inverted height intervals
are skipped and reported rather than raised above a suspect `min_height`.
The intentional 1.1 scale and 0.8 mm minimum-height defaults remain.

**All parts of one building share one terrain base** (min over the parent's
footprint and every sibling part). 82 of 157 multi-part buildings had parts
founded up to 0.76 mm apart, so equal-height parts ended at different heights
and shared walls showed as streaks. `terrain_base_source` says which.

**`roof_direction` is the DOWNSLOPE bearing** (0 = north, 90 = east), verified
on the 8 P&G skillion facets (all point away from the tower centre, mean
error 2°). Gabled/hipped ignore it and use the longest edge (or `across`).

**Gabled/hipped roofs are built as planar regions, all or none.** No polygon
booleans exist here; the footprint is clipped by half-planes in the ridge
frame (2 regions for a gable, 4 for a hip) and each region is a prism with a
planar top. If the region areas don't add up to the footprint (degenerate
clip), the whole mass falls back to flat rather than leaving a wedge missing.
Pyramids/domes are apex solids (ear-clipped base, ring quads, apex fan) with
the same every-edge-twice check.

**A partless building whose footprint lies inside another building's parts is
that building published twice — drop it.** Scripps Center: a named 143 m box
(`has_parts=False`) over an unnamed outline (`5884d2a7`) with 11 tiered parts;
the box swallowed every tier and the crown, and its top z-fought with the crown
part (the "circle" on the box top in Adam's screenshot). Rule in
`buildings.find_duplicate_outlines`: ≥ 90% of interior samples inside the
other building's parts (all 7 sample cases are 100%), plus mutual ≥ 85% for
two partless twins (keep the one with height, then floors, then name). Do NOT
lower the threshold: an annex beside a complex is legitimately 50% inside.

**Sidewalks and crossings are dropped by Overture `subclass`, not geometry.**
`SIDEPATH_SUBCLASSES = {sidewalk, crosswalk, cycle_crossing}` resolved per
piece (subclass_rules are scoped). Adam's `blender_city_footpath_cleanup.py`
(repo root, reference only) removes the same OSM tags and then repairs the
network; the repair half was deliberately NOT ported ("don't go overboard").
Plain footways (no subclass) stay — 1,313 of 2,644 on the sample.

**Road widths are capped at 0.7 mm** (`maximum_road_width_mm`, decks too).
Adam measured 0.98 mm motorways and asked for 0.7. Class hierarchy survives
below the cap (secondary 0.665) and flattens at it (motorway/trunk/primary).

**Class-aware default heights** (`CLASS_DEFAULT_HEIGHT_M` in
`geometry/buildings.py`). 2,884 of 9,833 sample buildings have neither height
nor floor count. One blanket number made a stadium, a parking deck and a shed
the same height. Explicit source data always wins — Paycor Stadium keeps its
recorded 21 m and that is deliberate, not a bug.

**The water cut follows the real shoreline, not the grid.** A terrain cell is
~1.9 mm across; a cell-aligned cut is a staircase next to a 0.45 mm road.
`watermask.py` rasterises each polygon by scanline (rows and columns), which
yields exact grid-line crossings as a by-product; `terrain_mesh.py` clips each
shore cell against them (Sutherland-Hodgman against the water half-plane).

**Terrain watertightness is by construction, not assertion.** Top faces wound
CCW, bottom is the same set mirrored at constant Z with reversed winding, walls
raised on exactly the top edges used by one face. Two cells sharing a grid edge
share both its nodes and therefore both wetness bits, so **no T-junctions**.
Crossings are keyed by grid edge so adjacent cells weld. `SHORE_INSET = 0.02`
keeps a crossing off a node, which would otherwise make a zero-area face.

**Base thickness is measured against the built surface**, not the height field.
The cut removes the channel bed and the shoreline lies between a node and the
bank, so `terrain_solid_geometry` takes `base_thickness` and computes `bottom_z`
from `min(vertex.z)` itself. Verified exact: 1.3000 mm.

**Only water ≥ 5,000 m² is cut** (`MINIMUM_WATER_CUT_AREA_M2`). The sample bbox
has 52 swimming pools and two named fountains; cutting those punches
sub-millimetre holes that only weaken the print.

**Things over the cut are handled with it.** Piers in a cut river are dropped
(`is_void` passed to `add_bridge_supports`); surface roads entirely over it are
skipped (`skipped_over_void`); mapped decks (pier/quay/dam — `WATER_DECK_CLASSES`)
and building footprints take their own footprint back out of the mask via
`WaterMask.remove_polygon`. The deck idea came from Adam's
`jarvizar_blosm_to_bambu_svg.py` (a separate laser-SVG pipeline, kept in the
repo root purely as reference — **not** part of the add-on).

**The cut is independent of the water object.** `_needs_water_data()` gates on
`generate_water OR (cut_water_from_terrain AND generate_terrain)`. Tying them
together refilled the river the moment the blue part was turned off — that was
a real bug found during review. **To get the reference look, untick Water**;
the opening stays. (The flat-terrain grid resolution had the same coupling;
fixed in 0.4.0 via `_cuts_water()`.)

**Ground under structures is built back as separate solids, not by widening
the mask.** A causeway is ~1–1.6 mm wide and a dock is 0.4 mm; a terrain cell
is 1.9 mm. The mask can only un-mark nodes, so 4 of the 6 floating structures
on the sample bbox contained no node and hung in the void. `SupportBuilder`
drapes the exact footprint (deck corridor + margin, building footprint, pier
polygon) from the terrain's `bottom_z` to the height field minus 0.05 mm.
Overlaps with the bank are fine (individually watertight, slicer unions).
Do NOT widen footprints to a cell to make the mask work — that fills water.
The mask restoration of decks/footprints is kept for continuity of the terrain
mesh under big structures; the pedestal handles what it cannot resolve.

**Exact vs whole-cell void tests.** `is_void` errs wet at the bank on purpose
(piers). A road along a riverbank sits in shore cells for its entire length,
so anything that *classifies* geometry (crossing recovery, pedestals, slab
clipping, trees) must use `over_open_water`, which is exact. Using the cell
test there hoisted whole riverbanks onto decks in the first attempt.

**Deck heights are one solve over the whole bridge graph
(`geometry/deck_graph.py`), never per piece or per chain.** Measured on the
sample before 0.7.0: 233 flagged pieces, 212 chains of which 196 were single
pieces, 39 forks; every deck end was pinned to bare terrain, 0.6 mm *below*
the road surface it continued (all 228 anchored ends); lifts were
`clearance × (1 + level)` with a sine hump up to 3× that, so level-3
interchange pieces stood 4.4 mm over a 1 mm city (Adam's "reduce the z-scale
of the bridges"). Now every centerline vertex is a graph node, joints share
nodes (a fork is a degree-3 node with one height), and the profile is
`min(upper envelope of cones falling from the floors at the grade, lower
envelope of cones rising from the anchors)` via two multi-source Dijkstra
passes. Anchors = `ground_height_mm + road_thickness` where a surface road
ends (the deck *continues the road surface*). Floors = terrain + 0.4 mm gap
(`bridge_clearance_mm`, printed layers, replaces the old metres setting) +
0.6 mm deck (`bridge_deck_thickness_mm`, now equal to the road thickness),
plus one road thickness for a component that passes over any surface road
(the approach road at the anchor excluded). `level` only decides which of
two crossing decks is on top; it never scales a height. Grade 8 %
(`bridge_maximum_grade`). A component whose lift never reaches 0.2 mm
(`bridge_minimum_lift_mm`) is demoted to a surface road (41 pieces on the
sample, listed in `bridge_demoted_by_class`); a recovered water crossing is
never demoted. Result: deck lift over terrain p50 1.0, p90 1.6, max 2.6 mm
(two genuine two-level stacks), 0 piers under nothing.

**Stacking only at real crossings (≥ 25°, `MINIMUM_CROSSING_SINE`).** Brent
Spence's two carriageways run parallel with level tags that swap between
pieces; treated as "the deck below" each other they ratcheted a millimetre
per round to 5 mm over the river. Parallel decks now merge in the print
instead; that is deliberate.

**Piers overlap 0.1 mm into their deck (`PIER_OVERLAP_MM`).** On a tight
curve the deck underside between ring vertices differs from the centerline
profile the pier reads by a few hundredths; measured with rays, 786 of 840
piers met exactly and 9 stopped 0.04–0.08 mm short before the overlap. The
old per-span-slab fallback for tight curves also left 12 piers under nothing
(wedge gaps on the outside of bends); decks now fall back to overlapping
convex pieces like tight roads do.

**Terrain smoothing is a 3×3 mean by default (`terrain_smoothing = 1`).**
The z13 tiles carry a metre or two of pixel noise; on the sample, 0.42 % of
1.5 mm road steps were isolated one-layer coins, 0.20 % after a 3×3 mean
(0.09 % for 5×5, at a p99 change of 0.40 mm; 3×3 changes the terrain by
p50 0.015, p99 0.21 mm, max 0.59 at cliffs). The water cut re-sharpens the
banks afterwards. Smoothing happens in `ModelHeightField.build` so every
generator sees the same ground; a test that rebuilds the field must pass
the same `smoothing` (the smoke test does).

**Causeway corridors are found on a 0.5 mm-sampled copy of the centerline and
simplified at their own half-width before buffering.** The deck centerline is
densified at 3 mm, too coarse to place the strip's ends; and the fine copy
keeps sub-margin jogs (a sidewalk stepping 1.7 m around a pylon, 0.02 mm
noise segments) that fail `offset_is_safe` and blow one corridor into ~240
convex pieces. Simplifying at half-width fixed that; genuine sharp corners
still fall back to convex pieces, which is correct.

**Rail bridges come from `rail_flags`.** Overture rail has no `road_flags`;
the old bypass built rail with `flags=frozenset()` so the C&O railroad bridge
draped flat into the river. `split_segment` now reads both flag fields
(`FLAG_FIELDS`); rail is batched under class `rail` with `RAIL_WIDTH_M`.

**Unflagged crossings are recovered from the water, with a minimum length.**
`_recover_crossings` splits a surface piece at open-water runs ≥ the minimum
bridge length (12 m), extended 6 m onto each bank. Shorter runs are mapping
slop and are draped with `ground_height_mm` so they hold the bank's grade.
2 recovered on the sample bbox.

**Piers have a minimum plan size (0.6 mm).** They are free-standing columns,
not ribbons; 0.35 × deck width for a 0.45 mm footbridge deck was 0.16 mm.

**Slabs that reach the water are rasterised on the grid.** There is no
polygon-difference routine in this project (no Shapely). `_slab_clipped_to_land`
reuses `WaterMask` (fill_wet → remove_polygon(slab) → add_polygon(water)) and
`terrain_solid_geometry(draped_bottom=True)`. Only polygons that touch open
water pay the grid-resolution outline; 31 on the sample, all coarse
`land_cover`. Do not route every slab through this — 98 pitches and 140 gardens
are sub-cell and would vanish.

**`land_cover` forest is scattered by default now.** The regional filter (>8×
bbox) and the open-water exclusion made it safe; +1,879 trees on hillsides no
`land` polygon covers. Toggle: **Scatter in Satellite Forest**.

**`infrastructure` is required for download but optional for generation.**
Piers/quays/breakwaters live in `base/infrastructure`, not `land`, which is
why `water_cut_decks_restored` was 0 for the whole 0.3.x line. `_required_types`
adds it when the cut is on; `_essential_types` excludes it so an older cache
still generates (counts then say `infrastructure: not cached`).

**Overture Python lives in AddonPreferences, not the scene.** Where the
downloader lives is a property of the machine. The sidebar field is a per-scene
*override* and is normally blank. Resolution order: scene → preference → env
`JARVIZAR_OVERTURE_PYTHON`. A working scene-level path is promoted to the
preference automatically when none is set.

**Draped caps are refined to the drape spacing (`planar.refine_triangles`).**
A prism cap is triangulated from its outline only, so a park's top and bottom
were flat sheets strung between outline vertices: on the sample they left the
terrain by up to ±1.8 mm (green wedges on slopes, slabs hanging over hollows,
Adam's screenshot 1). Edges longer than the spacing are bisected and the new
vertex draped through a callback; the rule is per *edge*, so neighbours agree
and no T-junction appears, and outline edges only split into outline edges so
the walls are untouched. Zero-area cap slivers (collinear densified vertices)
get refined too, on purpose — skipping them would leave a T-junction against
the refined neighbour and the every-edge-twice check would reject the prism.
They carry no volume; Blender's float32 storage can flip their winding, so a
probe that classifies faces by normal must skip faces with no area (that is
what the −0.60/−0.15 "floating" outliers were).

**Embed is one setting, 0.15 mm, and undersides are draped.** Roads, slabs,
buildings and piers reached 0.3–0.35 mm into the terrain, and a building's
flat plate at its lowest corner reached 2.1 mm into a hillside. The printed
shape is identical either way (below ground is inside the terrain), but in a
multi-material print every layer a buried colour spans is a filament change,
and Adam asked for the terrain to stay one region. `surface_embed_mm` feeds
`SurfaceSettings.surface_embed_mm`, `RoadSettings.road_embed_mm` (piers use
it too) and `generate_buildings(embed_mm)`. A ground-founded mass's underside
is `terrain(x, y) − embed` at every outline vertex (outline densified at the
drape spacing) and, for flat tops, across the refined interior; it is clamped
to `ceiling − 0.05` where the hill rises above the mass (the mass is buried
either way, this only keeps the solid right-side out). Tops are unchanged:
still measured from the shared/lowest base, so parts still end level. Shaped
roofs drape at their outline only; apex solids take a bottom callable. An
elevated part (`min_height > 0`) keeps its flat underside. Do not raise the
embed to "be safe": 0.15 is three-quarters of a layer over a draped surface
that tracks the terrain to ~0.01 mm.

**Land surface rise is 0.4 mm** (two layers) so greenery reads as its own
colour region; roads at 0.6 still stand one layer above it. As of 0.9.12,
trees sample those actual slab caps instead of being buried at terrain
height; their simple cone bases use the same surface embed.

**The slab-clip mask takes the crossing nearest the DRY node
(`WaterMask(prefer_dry_end=True)`).** The terrain's mask only ever *adds*
water and *removes* decks, so the crossing nearest the wet node keeps the most
land, correctly. `_slab_clipped_to_land` does the opposite — removes the slab
from an all-wet grid, then adds the water — and from the dry node whichever
outline is met first ends the slab. With the terrain rule, a park mapped out
to the state line mid-river (Smale Park) and forest along the east bank kept
a strip up to one cell wide out over the void: 208 slab samples over open
water on the sample, now 0. `_reaches_open_water` also samples the polygon
interior at cell spacing (a lake cut from the middle of a park never touches
its outline), prefiltered by the mask's window test.

**`in_cut_water` is judged on the terrain cell's own dry polygon
(`WaterMask.cell_dry_polygon`), not the water outline.** The polygon walk is
the same Sutherland-Hodgman walk `terrain_mesh` performs with the same
crossings, so the answer agrees with the printed surface exactly and costs a
handful of edge tests instead of a ray cast over the whole river for every
riverside road vertex. `ground_height_mm` now uses it: a point on the dry side
of a shore cell takes the terrain's own height, so the Public Landing ramps
follow the landing down to the water instead of standing as 0.95 mm blocks at
the nearest node's height (Adam's screenshot 3); only a point past the shore
takes the nearest dry node. Deck anchors see the same change (a deck end in
a shore cell now lands on the bank surface). rings buffered in metres must be
re-cleaned at `EPSILON` after scaling to mm; `offset_is_safe` + convex-piece
fallback for tight corners; the topological edge assertion replaced an area
heuristic because Blender's `tessellate_polygon` returns *incomplete*
triangulations (11 triangles for a 14-gon needing 12); `ear_clip` fallback for
hole-free rings. Sliver-thickness filtering was tried and **abandoned** — no
threshold separates a park sliver (1.4e-4) from a legitimate courtyard
hole-bridge triangle (1.988e-4).

---

**Pasted bounds are read in one fixed order and never guessed.**
`parse_bounds_text` takes `west,south,east,north` -- what the Copy button at
prochitecture.com/blender-osm puts on the clipboard -- and is deliberately
loose about separators (commas, semicolons, whitespace, brackets, quotes, a
`bbox=` prefix) and strict about order. Sniffing the order is not possible:
a lat/lon swap of the Cincinnati box, `39.08,-84.53,39.11,-84.48`, still
validates (west 39.08 < east 39.11, south -84.53 < north -84.48) and would
quietly model a patch of the Indian Ocean. `format_degrees` writes the fields
back at 7 decimals with trailing zeros stripped, the precision
`data.cache.Bounds.canonical` hashes at, so pasting the sample bbox lands on
the existing `bbox_4df7cf1c3668` cache directory -- verified in Blender.
The operator's `text` property carries `SKIP_SAVE`: Blender remembers operator
properties between runs, so without it a second click would reapply the text
typed into the dialog on the first instead of reading the clipboard again.
`window_manager.clipboard` always reads back empty in `--background` Blender
(no GHOST window), so the one-click path can only be tested in a real window;
`tests/blender_gui_paste.py` is that test (windowed, quits itself), and the
unit tests cover the parsing.

**Bambu Studio arranges every 3MF build item separately, so the export must
write exactly one.** Adam's "the Z-axis is not lined up, the geometry is all
there". A 3MF `<item>` is a printable object to Bambu: it re-centres each on
its own bounding box, drops it to the bed and will rotate and re-plate it.
Measured by round-tripping the sample through `bambu-studio.exe --export-3mf`
and reading the transforms it wrote back: 42 items became **4 plates**, **13
rotated**, per-object Z offsets spanning **7.49 mm** on a 16.7 mm model (each
offset exactly half that object's own height — `TERRAIN_SURFACE` 9.2455/2 =
4.62275, matching to five decimals). Parenting the objects to one empty makes
`io_mesh_3mf` write them as `<components>` of a single object: the same round
trip then gives **1 item, 42 parts, 1 plate, 0 rotated, one shared Z**, with
`mesh_stat` reporting 0 repairs. That is what `jarvizar.export_3mf` does, and
it restores the parenting afterwards. BLOSM does not hit this because its
output is not dozens of separately founded objects. Do NOT "simplify" this by
joining into one mesh — parts are what carry the per-class materials.

**`io_mesh_3mf` applies the scene's display unit as a second scale.** Its
`unit_scale` is `global_scale × scale_length ÷ 0.001 × blender_to_metre[
length_unit]`, and `length_unit` is only a display preference. With **Set
Scene Units** on (0.001 + MILLIMETERS) that is 1e-6/1e-3 = **0.001**, so a
plain File ▸ Export ▸ 3MF writes the city a thousand times too small; with
factory units (1.0 + METERS) it writes it a thousand times too big.
`_millimetre_export_scale` returns the reciprocal, reading `blender_to_metre`
out of the exporter itself so the two cannot drift. Verified: the file is
364.24 × 201.42 × 16.74 mm (terrain plus the 2 mm rim) with an identity item
transform. Same family of trap as STL's "Scene Unit".

**Face winding is fixed by propagation, not per triangle
(`planar.orient_faces_outward`).** `_build_solid` winds each cap triangle from
the sign of its own XY area and raises each wall on whichever direction that
handed it. Exact — until a cap triangle has no area: a ring that touches
itself, or one the rectangle clip pinched into a zero-width corridor, gives
slivers whose sign is float noise, and the full-size wall quads raised on them
come out facing inward. Measured on the sample before 0.9.0: **107 shells of
25,033 were inconsistently wound**, 1,366 faces in all, 713 of them in
`BUILDINGS` (Adam's red patches in the face-orientation overlay). The
every-edge-twice check cannot see this — it is undirected, and two faces
sharing an edge in the *same* direction still count twice. So `_build_solid`
now counts edges by direction (same cost, and the undirected count falls out
of it) and, only when some directed edge is used twice, re-derives orientation
by walking face to face, flipping each edge-connected component whole if it
came out enclosing negative volume. After: 0 inconsistent, 0 inward faces,
polygon count identical to the face, generation still 13.7 s. NB a signed
volume is only translation invariant for a *consistently* wound shell — before
the fix these shells reported volumes of −600 mm³ inside a 1.6 mm³ box, which
is measurement noise, not an inside-out solid. Judge winding with
`faces_are_consistent`, volume only after.

**A deck end that nothing continues touches down.** Measured on the sample
before 0.8.0: 79 loose deck ends, 72 on built decks; 9 sat on the bbox edge
and the other 63 were skywalks into buildings (24), stubs beside a road or at
a dropped sidewalk/tunnel (14) and isolated ends (26), all hanging at floor
height — a 1–5 mm skywalk between two towers printed as a box in the air on
one pier (Adam's screenshots: the Town Center Garage skywalks at (-101,80),
the arena footbridges at (2,-2), the Covington ramps at (-10.5,-80) ending
0.27 mm from the primary road they join). Rule in `solve_deck_network`: a
degree-1 deck node not in `blocked` is anchored at `ground + road_thickness`
unless its key is in `open_ends` (deck ends within `BOUNDARY_TOLERANCE_MM`
= 0.05 of the model rectangle, computed in `roads._solve_deck_heights`).
Touchdown ends are excluded from the road-crossing test like road anchors.
With the existing 0.2 mm demotion, 18 of the 24 components with no road
anchor (all ≤ 3.8 mm) became ground paths; the 33 mm Purple People footway
and the stadium service loops ramp to the ground at 8 %. Counts:
`bridge_touchdown_ends`, `bridge_open_ends`.

**A component standing over cut water is never demoted** (was: only the
recovered crossing piece). With touchdowns, a flagged footbridge over a creek
whose banks are barely above the water can fail the 0.2 mm lift and would be
built as a road hanging in the void; the first 0.8.0 run lost 2 of 14
causeways exactly that way. `_stands_over_open_water` samples the centerline
at a quarter cell; the protection is per component
(`DeckSolution.deck_components`) so joints stay level.

**Merged objects keep every solid's vertices to itself.** `MeshBuilder.add_raw`
never shares vertices between solids, so `BUILDINGS` (buildings + parts via
per-face `material_index`, two slots) and `TREES` (each tree the shared
`tree_solid_geometry` scaled, turned and moved into its own vertices) are
sets of individually closed shells: 0 non-manifold of 42 meshes. Two
adjacent buildings with a common wall would weld into a four-faced edge if
vertices were merged by coordinate — do not "optimise" that. Merged mode
records no per-building metadata; `merge_buildings_and_trees=False`
restores one object per feature with `overture_id` / `roof_geometry` /
`underside` (the smoke test runs both passes; `blender_live_smoke.py` runs
unmerged).

**Pier-contact probes must use hit parity, not the first hit.** Decks of one
class share an object and overlap (a ramp over its viaduct; the Purple
People Bridge is three parallel decks — rail and pedestrian at 1.7 mm, the
footway at 1.1 — with the rail underside exactly on the footway top). A ray
from a pier top meets the upper deck's underside before its own deck's top,
which the first-hit test reported as a 0.16–0.5 mm "gap" (12 piers, then 2).
Counting tops minus undersides above the origin shows all 820 inside their
deck (`scratchpad/probe_bridges2.py`).

## Working style Adam has asked for

- Diagnose numerically against the real cached data before changing anything.
  Every fix above came from measuring first (counts, distributions, probes).
- Verify with renders. `tests/render_preview.py`, or aim a camera with
  `--target x,y --span n`. Send images with SendUserFile — he checks from
  another device.
- Report honestly: say what was skipped and why. Counts go into
  `generation_counts_json` on the CITY_MODEL collection.
- Don't fabricate data to make output look better. Class defaults for *missing*
  values are fine. Adam explicitly prefers measured LiDAR over conflicting
  recorded heights with **Prefer LiDAR on Conflicts** enabled (default since
  0.14.0); disable it for conservative source confidence checks. No arbitrary
  height clamps, invented footprints or building-specific exceptions.

---

## Open items

- `scripts/build_addon.py` now reads the version from `blender_manifest.toml`.
  It used to hard-code it, so the first build after the 0.9.0 bump rewrote
  `dist/jarvizar_city_model-0.8.0-*.zip` with 0.9.0 source. Both were rebuilt
  from the intact installed 0.8.0 add-on and verified (no
  `orient_faces_outward`, version tuple `(0, 8, 0)`); bump the manifest and the
  zip name now follows.
- **Previously installed 0.9.6**, installed 2026-09-05 with Blender closed via the
  `install-addon` skill. Version tuple `(0, 9, 6)`, module path, the three new
  defaults on a fresh scene (`building_height_scale` 1.1,
  `minimum_building_height_mm` 0.8, `minimum_height_footprint_mm` 0.6), the
  matching arguments on `generate_buildings`,
  `footprint_admits_minimum_height` (square yes / shed no / strip no), the
  preference path and `probe_client` ->
  `{'ok': True, 'client_version': '1.0.2'}` all verified against the installed
  copy with the repo kept off `sys.path`. Prior 0.9.5 add-on and preferences
  backed up in `dist/install-backup-20260905-210001/`, 0.9.4 in
  `dist/install-backup-20260905-201614/`.
  NB a scratch copy of `render_preview.py` must have its `root` pointed at the
  repo: it derives it from `__file__`, so a copy outside `tests/` silently
  renders the *installed* add-on instead (that is why the first 1.0-vs-1.1
  comparison came out byte-identical).
- Previously **installed 0.9.4**, 2026-09-05 with Blender closed, following
  `.claude/commands/install-addon.md`. Installed module path and version,
  bridge helper, road-cut clearance and downloader probe verified in Blender;
  preferences saved and all installed source files match the release ZIP.
  Prior 0.9.3 add-on and preferences backed up in `dist/install-backup-20260905-195556/`;
  the earlier 0.9.1 backup remains in `dist/install-backup-20260905-194050/`.
  Previously, 0.9.1 was installed 2026-09-05 with
  Blender closed via the `install-addon` skill; version tuple, module path,
  preference path and `probe_client` verified against the installed copy with
  the repo kept off `sys.path`, and `jarvizar.paste_bounds` round-tripped
  there. `dist/jarvizar_city_model-0.5.1-blender36.zip`, `-0.6.0-`, `-0.7.0-`,
  `-0.8.0-` and `-0.9.0-` are kept for rollback; a scratch copy of
  `render_preview.py` that takes `--path <extracted zip dir>` instead of the
  repo root is how true "before" renders were made for the 0.6.0, 0.7.0 and
  0.8.0 comparisons.
- Touchdown side effects, left alone on purpose: a ~5 mm skywalk anchored at
  both ends now humps 0.21–0.24 mm (Town Center Garage, AT580), right at the
  demotion threshold — `bridge_minimum_lift_mm` 0.3 would make them paths;
  a footbridge landing 0.21 mm short of the path it serves leaves that gap
  between the two ribbon ends (snapping deck ends to surface ends within
  half a road width would fix it); the Purple People footway now ramps to
  the ground at both banks under the level rail/pedestrian decks that share
  its corridor.
- Merged mode keeps `BUILDING_PARTS` as an empty collection and attaches no
  per-building metadata; `tests/blender_embed_probe.py` still works (it
  samples faces per object) but reports `BUILDINGS` as one object.
- Scene properties renamed in 0.7.0: `bridge_clearance_m` (metres) is gone,
  replaced by `bridge_clearance_mm` (printed gap); a .blend saved with the
  old property simply gets the new default.
- Surface roads that dead-end over the cut water (the Public Landing ramps at
  (-4,-14), the Covington riverfront service road and trail at (-23,-52) and
  (-36,-56), a footway at (42,21)) still cantilever over the void at the
  shoreline height: ~100 cap faces on the sample. Left alone on purpose
  ("keep the road/water behaviour"); the two honest fixes are trimming the
  ribbon at the shoreline or giving terminal void runs the deck causeway
  treatment via `ground_support.corridor`. The sample cache's `infrastructure.geojson` was copied in
  by hand from a scratch download, so the manifest's `feature_counts` does not
  list it; the Download operator will not re-fetch it (file exists) unless
  Refresh Existing Cache is ticked.
- What a deck crosses is inferred from proximity to surface-road centerlines
  (within deck + road half-widths + 0.2 mm), not from `connector` topology,
  so a road running alongside a viaduct lifts it too; and a component's road
  lift is uniform along the component (a long viaduct crossing one street is
  lifted over its whole length). Reading connectors would fix both.
- Short flagged bridges that cannot rise a layer at 8 % (culverts, short
  overpasses) are built as roads; the road they cross runs through them at
  grade. Raising `bridge_maximum_grade` makes more of them decks.
- `bridge:structure` tags (suspension/arch/truss) exist in `infrastructure`
  for the named river bridges; towers/arches are not generated. Tower
  positions are not in the data, so anything built would be schematic.
- `_slab_clipped_to_land` picks "the crossing nearest the wet end" per grid
  edge, so where a slab outline and the bank cross the same edge the slab can
  extend to the bank by up to one cell. Bounded, never over water.
- `C:\Users\adamj\Desktop\jarvizar_city_model` is a stale v0.1.0 folder from an
  earlier Codex session. Inert (not on any script path). Offered to delete it;
  no answer yet.
- `blender_city_footpath_cleanup.py` in the repo root is Adam's OSM-XML
  cleanup script, kept as reference like the laser-SVG one. Not part of the
  add-on.
- Not implemented: non-flat roof shapes (`roof_shape` imported as metadata only,
  objects marked `roof_geometry = unimplemented`); piers from
  `base/infrastructure` (current ones are schematic, placed by spacing);
  connector topology downloaded but unused; downloads block the Blender UI;
  antimeridian bboxes.
- Except for ground-road footprints subtracted from landcover, overlapping
  solids are **not** booleaned. Each object is individually
  watertight, which is what slicers need; union is left to Blender. Supports
  deliberately overlap the bank and each other (parallel carriageways each get
  a causeway).

## Docs

`README.md` (user-facing, install + print scale + honest limits),
`docs/IMPLEMENTATION_PLAN.md` (module map, phases, watertightness),
`docs/OVERTURE_SCHEMA.md`, `docs/BRIDGE_DESIGN.md`, `docs/DEPENDENCIES.md`.
Keep them current — they carry the reasoning, not just the API.
