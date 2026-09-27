# Jarvizar City Model — shared agent context

Read [AGENTS.md](AGENTS.md) for development principles. This is shared context
for all coding agents. Implementation, configuration, and tests are authoritative.
Keep installation history, transient results, and fixed test/object counts out
of this document.

## Purpose, units, and defaults

The add-on turns a WGS84 selection into an FDM city miniature: terrain, land
surfaces, roads/rail, schematic bridges, trees, and building massing from
Overture Maps, with optional LiDAR building measurements. Blender 3.6 is
the local development/test target. Packaging also supports the Blender 4.2+
extension layout; that does not establish runtime validation on 4.2+.

Coordinates are **west, south, east, north**. `data/projection.py` converts
WGS84 through local ENU metres to model millimetres, with X east, Y north, Z up.
Use the shared transform; never independently scale or recenter a layer. Bounds
parsing accepts several separators but never guesses lat/lon order.
Antimeridian-crossing selections are unsupported.

One Blender unit represents **one printed millimetre**. `config.py` defines
scene defaults; direct geometry helper defaults sometimes differ. Saved scenes
retain explicitly stored values when defaults change.

| Setting | Default and consequence |
| --- | --- |
| Print scale | `FIXED`, `mm_per_metre=0.07` (about 1:14,286); a 6.5 m street becomes 0.455 mm |
| Terrain | DEM, resolution 192, smoothing radius 1 (3×3 mean), exaggeration 1.0 |
| Base | 1.3 mm below the lowest built terrain surface, including basin floors |
| Roads / decks | Both default to 0.6 mm; widths constrained to 0.45–0.7 mm |
| Ground surfaces | 0.4 mm rise, 0.15 mm embed; roads and ground-founded buildings use that embed too; beaches slope to the waterline over 1.5 mm |
| Buildings | Height multiplier 1.1; minimum height 0.8 mm, gated by a 0.6 mm footprint setting |
| Source building detail | Width and slenderness filters off (0); the direct `generate_buildings` helper defaults to 0.08 mm and 30 below 0.45 mm width |
| LiDAR | Opt-in; Prefer LiDAR on Conflicts enabled; automatic Roof Envelope; legacy Terraces width 0.1 mm / step 0.05 mm |
| LiDAR building selection | Minimum printed footprint area 0.7 mm²; 0 disables this pre-acquisition filter |
| Ponds / fountains | Recess enabled, depth 1.0 mm, water thickness 0.8 mm (0.2 mm below the lowest sampled bank) |
| Trees | Trunkless three-tier solids, minimum width 1.1 mm / height 1.6 mm; 26 m forest spacing, 18% variation, 0.2 mm crown clearance |

All main feature toggles, including Water, default on; the border rim defaults
off. Disable **Water** for the open-river appearance: terrain cuts and pond
recesses remain. Preserve the fixed print-scale default. `FIT` is an existing
optional mode; do not add automatic build-plate fitting. The export frame
provides cropping without changing the geographic scale.

## Architecture and data flow

`__init__.py` registers `config`, `operators`, and `ui`; the scene settings live
at `scene.jarvizar_city_model`. UI panels are in View3D → Sidebar → City Model.
`operators.py` coordinates downloads, LiDAR preparation, generation, export,
and generated-model cleanup.

`ui.py` keeps the main panel to the workflow in order of use: area (with the
**Presets** menu, which passes `data/bounds_presets.txt` lines to
`jarvizar.paste_bounds`), print scale, Download / Prepare LiDAR (shown once
LiDAR is on) / Generate / Export, then the last status. Everything set rarely
is a closed sub-panel; a feature's toggle is its sub-panel's header checkbox,
so the closed headers are the feature list. Water and LiDAR Buildings are not
greyed by their headers: cuts and basins outlive the water fill, and Prepare
runs before **Use Prepared LiDAR** is on. Text that grows with the selection
(status, LAZ offers) goes through `_wrapped` with a line cap; offer details are
collapsed by default and list three areas per survey. Design for the narrowest
sidebar: one field per row for values that must stay readable, labels above
paths/URLs, and UI-only state in `generation_modal._RUNTIME` so toggling it
never cancels a pending generation.

| Layer | Responsibility / boundary |
| --- | --- |
| `data/` | Cache/provenance, GeoJSON and rule reading, projection, terrain providers, external-process adapters. No `bpy` dependency. |
| `external/` | Overture/DEM download and LiDAR acquisition/measurement helpers. Native GIS dependencies stay in the separate Python environment. |
| Pure `geometry/` modules | `planar`, `heightfield`, `terrain_mesh`, `watermask`, `water_geometry`, `footprint_cut`, `buildings`, `roofs`, and deck graph/profile/mesh logic return ordinary Python data. |
| Blender-facing geometry | Roads/bridges, building generation, LiDAR envelopes, surfaces/basins, vegetation, and supports turn those results into mesh objects. |
| `blender/` | `MeshBuilder`, collection ownership/cleanup, shared materials, and temporary export cropping. |

Keep math and selection policy testable without Blender. A module being under
`geometry/` does not imply it is pure. Likewise, the standard-library helpers
`external/lidar_records.py`, `lidar_source.py`, and `lidar_downloads.py` are
imported by Blender: do not add eager native-library imports to them.

Workflow: **Download / Cache Data → optionally Prepare LiDAR Buildings → Generate
Model → Export 3MF for Bambu**. Generation is offline. Missing essential layers
are errors; missing/stale/invalid optional LiDAR falls back to source buildings.

### External Python and caches

- `scripts/setup_overture_env.ps1` and `.sh` create/reuse `.venv-overture` and
  install `requirements-downloader.txt` (`overturemaps==1.0.2`). They do not
  install the optional LiDAR requirements. Python 3.11 is the local interpreter;
  setup scripts accept Python 3.10+ for the base downloader.
- For LiDAR, explicitly install `requirements-lidar.txt` in that environment:
  `laspy[lazrs]==2.7.0`, `pyproj==3.7.2`, `shapely==2.1.2`, `pyshp==2.3.1`, plus the downloader
  requirements. Never install wheels into Blender or pip-install at add-on
  runtime. DEM downloading uses only the standard library.
- Interpreter resolution: scene **Override** → preference `overture_python_path`
  → `JARVIZAR_OVERTURE_PYTHON`. Blank Override is normal. A valid scene path is
  promoted to an empty preference; disk persistence requires saving preferences.
- Cache root defaults to Blender's DATAFILES `jarvizar_city_model/cache`;
  `JARVIZAR_CITY_CACHE` overrides the default and the scene can choose a path.
  `CacheBundle` creates `bbox_<12-character SHA256>` from bounds formatted to
  seven decimals. The manifest also checks the actual bbox and cache format.
- Bundles contain per-type `.geojson`, `manifest.json`, and DEM `terrain.json`
  plus little-endian, south-to-north `terrain.f32`. The manifest merges feature
  counts and observed fields across downloads. Preserve provenance and UTF-8.
- Required layers follow enabled features. `infrastructure` is requested for
  water cuts/basins but remains optional at generation for older caches.
  `connector` is downloaded with road data but is not used by the geometry.
- Each Overture download requests the latest release; existing files are reused
  unless missing or Refresh is enabled. Adding layers later can combine releases.
  Preserve exact input bundles for comparisons, not just the manifest's release label.
- Overture returns intersecting, **unclipped** features. Clip during generation;
  preserve holes and inspect unusually large source extents before clipping.
  The DEM helper uses AWS Terrarium tiles, records sea-level datum/provenance,
  and the terrain sampler applies relative relief. Do not treat terrain heights
  as building heights or directly mix orthometric and ellipsoid Z values.

Overture and DEM downloads use blocking `subprocess.run`; the UI waits. LiDAR
uses a modal timer and an external worker in interactive Blender, with a progress
panel and Esc/button cancellation. In background Blender, preparation waits synchronously.
Interactive model generation also uses a modal timer and an offline background
Blender process, launched from the same executable and exact add-on package.
It runs all geometry on that process's main thread; no Blender API is accessed
from a Python worker thread. Background/scripted generation remains synchronous.

### Generation order matters

Follow `JARVIZAR_OT_generate_model.execute_sync`, rather than constructing each layer
independently:

1. Validate essential caches and create the transform. Build one
   `ModelHeightField` from DEM or flat terrain; apply smoothing once there.
2. Retain the previous generated hierarchy and build owned staging collections
   with copies of shared materials; record source/transform metadata. Solve and
   validate water polygons and their reusable prism topology before altering terrain.
3. Flatten terrain under ordinary water to solved levels (cut water both ways,
   its shore raised to at least that level, other water down only); construct the
   through-cut mask from the exact water outlines, then keep mapped deck and
   building footprints that touch the water. Ponds/fountains use a separate finite-depth path.
4. Build terrain and obtain its actual `bottom_z`. Apply basin recesses,
   extending the underside if necessary; register their floors on the field.
   Then build the optional rim and initialize `SupportBuilder` with that bottom.
5. Build draped land slabs, resolve category priority, and remove water
   footprints except supported paving. Build optional water fills. Generate roads/bridges with causeway
   registration before pier placement; subtract ground-road footprints from slabs,
   or, with **Cut Roads at Export** (default), tag the slabs and leave that cut to export.
6. Place trees directly on terrain. Generate source or prepared LiDAR
   buildings and their foundations. Emit accumulated `TERRAIN_SUPPORTS` last.
   Store counts on the staged root, validate ownership/attachment and finite mesh
   coordinates/placement, then publish the replacement and scene status/units.

Every generator samples the shared height field, **not the DEM directly**.
`is_void` conservatively marks whole cells with a wet corner or a water outline
crossing them; `in_cut_water` is the exact outline test the terrain is cut
along, including channels narrower than a cell. `over_open_water` additionally excludes
registered supports. Use exact queries for classification; `has_ground` is the
conservative foundation query. `ground_height_mm` uses surviving bank heights
over cuts for deck anchors and roads without ground supports. Supported surface
roads use the continuous `height_mm` grade and the same water-clearance floor
as their foundations; switching to nearest-bank heights at the cut creates
road steps and gaps above the supports.

Ownership uses `jarvizar_generated` tags and a `jarvizar_city_root` marker; legacy
tagged roots named `CITY_MODEL` remain supported. Published roots normally use
that name, with Blender suffixes when user data or other scenes already own it.
Staging roots are excluded from export and normal cleanup.

`blender/generation.py` retains previous meshes during synchronous generation.
It reserves their names reversibly and copies materials before palette updates.
On failure, allocation snapshots remove only this run's new IDs, including
unlinked/untagged builder leftovers; original names, material users, units, LiDAR
status, selection and active object/collection are restored. `last_status` reports
the failure. On success, shared material users move to the updated copies, scene
results publish, and one final batch removal discards previous generated output,
including manual edits. User helpers inside removed collections are relinked to
the scene, and meshes reused by surviving objects are retained. Keep helpers
outside the generated hierarchy for clarity.

`blender/generation_modal.py` owns interactive generation from launch through
worker exit and publication. Inputs are snapshotted, including an absolute cache
path; changed settings/scenes cancel the pending result. Esc or Cancel terminates
the isolated worker even inside long native geometry calls. Poll until it exits
before releasing ownership or deleting its private temporary directory. Failed
termination keeps the job owned and retries. Scene load, undo/redo, window closure,
and add-on unload stop/reap the worker; a parent monitor and OS-only exit cleanup
also cover the owning application's exit. Downloads, LiDAR preparation, export,
and clearing are guarded while generation owns the scene.

`external/generate_model.py` uses the unchanged synchronous pipeline and writes
one private `.blend` library plus a versioned result. Foreground publication
appends that root, maps worker material roles to staged copies of the local
palette (preserving custom shaders), and seals the imported ID set before yielding
to the event loop. Cleanup after that yield uses only those captured IDs, so user
objects created while generation runs are never swept up. The next timer tick
validates and commits; cancellation queued during append is handled before this
final boundary. Library append, final validation, and atomic publication are
synchronous foreground operations; large file imports can briefly pause the UI.

Peak memory includes the foreground model, a separate Blender worker during
construction, and both meshes during import. Worker progress is best effort;
private model/result publication is mandatory. Atomic JSON replacement retries
brief Windows reader conflicts. Generation remains offline and retains existing
FDM geometry/defaults. Download cancellation is a separate outstanding task.

## Geometry rules worth preserving

### Mesh construction

- Prism walls in `blender/mesh_utils.py` follow triangulated cap boundaries.
  Validate closure, directed-edge consistency, and cap coverage. Hole-free
  failures retry `planar.ear_clip`; rings with holes retry a constrained
  Delaunay cap (`_cdt_rings`), because `tessellate_polygon` can lay extra
  triangles over a hole bridge: that dropped Rio's whole ocean (islands), with
  only `water_meshes_rejected` to show for it. Rejected geometry is counted.
- `MeshBuilder.add_raw` appends independent vertices for each solid. Merged
  objects intentionally contain overlapping, individually closed shells.
  Never weld adjacent buildings, tiers, road pieces, or trees by coordinate;
  shared walls would create edges with four incident faces.
- Check winding before signed volume. `orient_faces_outward` propagates
  orientation over connected faces; per-triangle normal flipping is insufficient.
  Edge-used-twice checks alone cannot detect inconsistent winding.
- Model-space `EPSILON` is 0.0001 mm. Re-clean metre-buffered rings after scaling
  and after densification. Cap refinement must preserve shared edge splits;
  indiscriminately discarding narrow/zero-area triangles can open courtyard
  channels or create T-junctions. Normal-based probes should skip zero-area faces.
- Draped slab/road caps and flat building undersides need interior refinement,
  not only perimeter samples. Increasing embed to hide interpolation errors
  wastes material/color changes and does not fix their cause. Land slabs drape
  their outline plus the fixed 1.5 mm lattice through `surfaces._draped_slab`;
  refining an outline fan with `refine_triangles` turned large lakeside parks
  into hundreds of thousands of faces.

Buildings/parts and trees merge by default; roads and slabs batch by category.
Cut slabs and the cut terrain are the exception to independent shells: overlapping
same-category outlines are unioned in 2D, with pinch vertices split and moved
`EPSILON` apart into their own triangles, never welded by coordinate (Exact
Boolean basin recesses weld coincident vertices).
Use `merge_buildings_and_trees=False` for per-building source IDs, height/roof
decisions, and foundation metadata; merged buildings retain material slots but
no per-building metadata. Generation updates shared `JCM_*` viewport and shader
colors, overwriting manual palette edits.

### Buildings and roofs

- Explicit `is_underground=True` excludes that building or part from source
  generation and cached full-LiDAR reconstruction. Separately mapped surface
  parts remain eligible. A negative `level`, basement floors, or a station name
  alone does not establish that an entire structure is underground.
- `buildings.py` selects source masses/profiles; `building_generation.py` applies
  print settings and builds meshes. `height` is the top above ground, **not
  thickness above `min_height`**. Invalid intervals are skipped. Fallback:
  explicit height → floors × floor height → class/subtype default → configured
  default. Parse unit-tagged lengths rather than stripping their units.
- Parent/part selection suppresses duplicate boxes while retaining a credible
  explicit parent beneath incomplete higher parts. Heightless parts neither
  veto that parent nor count toward known-height coverage; an explicitly lower
  height still prevents filling a real setback. Floor-derived estimates do not
  veto an explicit parent height, but still count toward coverage so complete
  assemblies retain their variable heights. Derived parent
  heights do not justify infill. Do not replace coverage rules with simple
  polygon intersection; legitimate annexes overlap complexes.
- **Restore Missing Main Bodies** defaults on (saved property key remains
  `retain_sparse_building_parents`). It adds grounded parents when all mapped
  parts cover less than half their footprint, including heightless parents using
  normal class/configured fallback heights. Disconnected components use
  area-weighted coverage, with holes excluded. Existing source parts are kept
  unchanged; lower sections may become enclosed and setbacks may be filled.
  Parent holes remain open; any part holes disable this extra fallback.
  Turning it off restores the prior selection policy. Low-level helpers default
  to that prior policy; the operator passes the scene setting explicitly.
  Ordinary full LiDAR reconstruction keeps its existing replacement behavior;
  height-only LiDAR can correct restored masses without sculpting their parts.

- Duplicate footprint checks respect courtyard holes. If every selected source
  part of a suppressed parent fails filtering or meshing, generation retries
  that parent's ordinary source mass and records `building_parents_restored`.
  Any successful source part or LiDAR replacement prevents that retry; the
  fallback itself still has to pass the normal geometry and printability checks.
  Source parent holes are retained. Assemblies with holes in their source parts
  do not receive this fallback, since their parent could fill those courtyards.
- Parts share terrain min/max from their parent's and siblings' footprints.
  Ground-founded undersides drape; elevated parts keep their source underside.
  Building height scaling affects vertical building dimensions together, leaving
  footprints and other layers unchanged.
- Minimum-height lift measures clearance over the highest shared terrain;
  `footprint_admits_minimum_height` requires area ≥ size² and effective width
  ≥ size/2. It stretches walls while retaining roof pitch. Slenderness uses the
  mass's own printed thickness, not its elevation above ground or artificial lift.
- Adjoining source parts with a common base and compatible top heights use
  their combined footprint width for filtering. Internal shared walls cancel
  from its perimeter; holes remain. Gaps, point contacts, different bases and
  excessive exposed height steps do not grant support. This changes selection
  only: footprints, roof profiles and independent closed shells are preserved.
- `roofs.py` implements skillion, gabled, hipped, pyramid and dome constructions
  with documented aliases (`round` currently approximates a gable). Explicit
  total heights include roofs for parts too. The only additive explicit-part
  exception requires a roof too large for its interval and an additive top
  corroborated by the parent total; it is a data rule, never an ID exception.
  Floor-derived walls receive the roof once.
- `roof_direction` means downslope (0° north, 90° east). Gable/hip ridge frames
  use footprint orientation. Region-based roofs commit all regions together;
  source roofs below 0.15 mm, with holes, unsupported shapes, or failed
  construction fall back to flat geometry with diagnostic counts.

### Water, land, supports, and vegetation

- Water uses `water_geometry.projected_water_polygons`, which preserves islands
  crossing the crop and separates disconnected components. Do not substitute
  generic `projected_polygon_rings`: that older building/slab path drops holes
  touching the crop boundary. Reject invalid water polygons as a whole rather
  than silently removing an island. Reuse validated topology for cuts and fills.
- Ordinary water through-cuts default to a 5,000 m² minimum; visible cut water
  is a full-depth plug down to the terrain bottom. Hiding the water object must
  not remove the terrain cut. `_needs_water_data` includes cuts **and basins**.
  `generate_water` batches ordinary water into `WATER_SURFACE` and all recessed
  fills into `WATER_RECESSED`, both in `WATER` with `feature_type=water_surface`.
  `water_recessed` distinguishes the batches; empty batches produce no object.
- Pond/fountain/water-basin classification uses explicit source tags/class/subtype, never
  names or size. Polygon fountains can come from `infrastructure`; identities
  and identical basin outlines are deduplicated. Explicit `water=basin` and
  normalized `class=basin` qualify even with the broader `subtype=reservoir`.
  Rivers/lakes/reservoirs retain
  their ordinary water policy. Generic unclassified water below 5,000 m² also
  recesses: `is_untyped_water` rejects explicit types/tags, and the solver checks
  the entire uncropped source feature area, including all MultiPolygon parts.
  A small crop cannot turn a large river into a basin. The 0.25 mm² surface floor still applies.
  **Skip Ponds, Fountains and Basins** (default off) drops exactly those
  features in `solve_water_bodies` before they become bodies, so nothing
  downstream sees them; it overrides the recess and does not need terrain.
- `basins.py` uses Exact Boolean on temporary terrain, checking closure and
  requested floors with rays before committing. Connected parts share the lowest
  bank reference; overlaps with other water types are skipped/counted. Floors
  enter height queries, not `void_mask`. Slabs drape on original ground before
  basin subtraction. Disabling basin mode restores ordinary water handling.
  A basin mapped against cut water can share its edge within float32 rounding;
  a failed Boolean retries once with cutters grown by `EPSILON`.
- `WaterMask` marks grid nodes by scanline and files every water and kept-ground
  outline edge by grid row, so `contains` is exact at any point: water polygons
  are united, then footprints added afterwards keep their ground. The cut terrain
  (`dem_terrain._cut_terrain_geometry`) puts all grid nodes and those outlines
  into one CDT, removes triangles with water winding > 0 and ground winding ≤ 0,
  and closes the top with a flat bottom. Cutting along grid cells cannot follow
  water narrower than a cell: it left channels standing under their water fills,
  opened diamonds at single wet nodes and gaps at convex shores. Land slabs are
  not grid clipped; `cut_water_land_surfaces` clears them from exact footprints.
- `data/land.py` uses category allowlists and rejects regional land/scatter
  polygons whose uncut extent-area exceeds 8× the selection. Generation also
  drops an area tagged `bridge`/`man_made=bridge` that a bridge-flagged segment
  crosses: its deck carries it, and the plaza draped under Ponte Sant'Angelo
  became a supported dam across the Tiber. One no bridge way crosses (the
  Polynesian's boardwalk to its over-water bungalows) is kept. A marina is a
  facility extent, not a deck: only physical pier/quay/dam/etc. footprints restore
  ground. The exact cut keeps sub-cell structure footprints; supports still lift
  those under retained water. Never widen water masks to reach them.
- `SupportBuilder` emits terrain-colored pedestals/causeways from terrain bottom
  to 0.05 mm below the field. It checks outline/interior, deduplicates footprints,
  and registers usable ground even without a new solid; pier queries need that.
  With ground support enabled, structures over recessed basins use a shallow
  height-field view without basin floors, retaining the pre-recess grade.
  Exact cap overlap selects supports under built road footprints and building
  footprints, including sub-cell shoreline overlaps and enclosed basins. The
  physical field retains its floors; basin islands and courtyards remain open.
  A support covers only the part of its footprint that lacks ground (`_trimmed`):
  the footprint is triangulated with the cut and basin outlines as constraints,
  and a triangle is kept over cut water, over a basin, or where the grade stands
  clear of the terrain by more than the embed, plus one edge-ring over the bank
  whose outer corners sink an embed further. Whole-footprint pedestals were
  mostly buried and flickered through the terrain in the viewport.
  Only a cheap window test gates it, and it ignores earlier supports: their
  outlines are not constraints, so a triangle straddling one was judged by its
  centre and footways beside it were left over the Chicago River. Overlapping
  supports simply lie under their own structures.
  Non-bridge foundations have a footprint-wide minimum grade that puts their
  tops at least 0.2 mm above retained (uncut, non-basin) water sheets; buildings
  and roads use that same grade, preserving their thickness/heights. Cut water
  and basins set no minimum: basin water sits below its lowest bank, and cut
  water is solved no lower than the low tenth of its connected shoreline
  (bathymetric DEMs put the median on the seabed), its nodes are set to that
  bank level, every node of every cell it reaches is raised to at least that
  level (`raise_cut_shores`), and its top sits `CUT_WATER_DROP_MM` below. The
  grade over and beside a cut is therefore the bank and shore structures need
  no pedestals. A basin-driven footprint-wide minimum lifted the whole
  Quirinale 1.1 mm onto a pedestal from a fountain at its hilltop. Bridge
  causeways touching cut water sink by that drop, whole, and stay under the
  water; bridges over basins get none (piers stand on the floor). Paving alone
  among land-cover categories retains supports over ordinary water: build these
  from surviving caps after category priority, welded per slab, and share its
  lifted grade (the lifted vertices', never a slope's highest vertex) with later
  roads/buildings. Never restore forest, green, sand, or rock footprints.
- `cut_water_land_surfaces` removes every validated water footprint from all
  land-cover slabs, including forest/green, sand and rock. Paving is preserved
  over ordinary water on foundations when ground supports are enabled; otherwise
  it is cut too, and it is always cut from basins (kept, it buried Piazza
  Navona's fountains under a supported plaza). It applies
  to ordinary water below the terrain-cut threshold as well as recessed
  basins, and retains island holes and full slab thickness outside the cut.
  Water-fill visibility does not control these exclusions. Structure supports
  and road/building geometry keep their separate ownership.
- **Slope Beaches Into Water** defaults on, 1.5 mm wide. Sand comes only from
  explicit beach/sand/shingle/dune classes, so sand beside *cut* water is a
  beach: right after the water cut, `basins._taper_beach` lowers sand top
  vertices by distance to the cut-water outlines, from the full rise to 0.1 mm
  at the waterline. Only Z of top vertices moves; later road cuts interpolate
  that top. Triangles left under 0.05 mm above `height_mm` raise their vertices
  again: ground bulging between slab vertices showed through the thinned sand.
  Other categories, basins and uncut water keep their walls.
- Surface priority defaults to **paved > sand > rock > green > forest** and is
  scene configurable. Priority, water and ground-road cuts all use
  `surface_priority._rebuild_surface`: slab wall outlines, cutter rings and a
  fixed 1.5 mm interior lattice go into one Blender CDT, triangles are kept by
  directed-edge winding numbers (slab > 0, cutters ≤ 0), and each category is
  re-emitted as welded top/bottom sheets with walls on boundary edges only.
  Outline heights are exact; other heights interpolate the previous top.
  Do not return to per-triangle convex fragments extruded as separate shells:
  each pass compounded them into ~10× vertices and ~100× shells. CDT face-id
  flood fill leaks on degenerate rings; keep the winding walk. `_triangulate`
  directs each ring edge's output pieces by walking them from start to end
  vertex: signs read from float32 piece directions flip on tiny pieces beside
  nearly coincident vertices, and the walk then spreads ±2 errors. Ground-road cuts
  use 0.005 mm XY clearance and built road outlines to avoid huge cutter sets
  from refined caps. Elevated bridges retain land beneath them.
- **Cut Roads at Export** (default on) lets roads be deleted or moved in
  Blender without holes: `defer_road_cut` tags the whole slabs
  (`road_cut_at_export`, `slab_thickness_mm`), and `export_geometry` cuts
  world-space copies with `cut_roads_at_export` from the `surface_road` objects
  present, before the crop, never touching the scene. The tags, not the current
  setting, decide at export, so a toggle between Generate and Export cannot
  double-cut or skip. A copy keeps its source's cached `bound_box` even after a
  new mesh, so the export cut reads bounds from the vertices. An unedited
  export has the same triangles as cutting during generation; on cached cities
  a slab's vertex order can differ, most likely from Generate's stale box.
- Trees combine mapped `land` points and deterministic forest scatter, including
  satellite forest by default. They avoid open water and recessed basins and embed their broad bases
  directly in the terrain, not raised land/road caps. Trunkless three-tier crowns
  are single closed solids with sloped undersides. Size floors apply independently
  to height and width. A shared spatial clearance check uses varied crown radii
  across mapped points and all forest sources, giving mapped points priority.
  **Remove Trees Over Roads/Paths** defaults on. A spatial overlap query tests
  the finished, rotated and varied crown against built ground-road footprints
  (including paths/rail and demoted decks) with 0.005 mm clearance. Overlapping
  trees are skipped before tree-to-tree clearance and the placement cap; no
  trees are cut or modified. Disabling the toggle keeps overlapping trees and
  skips building the road index. Elevated bridge decks do not exclude ground
  trees underneath. All unmerged trees share their original mesh.

### Roads and bridges

- `data/linework.py` splits at all scoped rule boundaries before resolving
  widths, levels, subclasses and road/rail flags. Skip tunnels and, by default,
  sidewalk/crosswalk/cycle-crossing subclasses; ordinary footways remain.
  Buffer in metres, constrain printed width, and clean in millimetres. Tight
  turns fall back to overlapping convex pieces.
- `geometry/road_network.py` (pure) tidies the clipped pieces before crossing
  recovery when **Tidy Road Network** is on (default): rank by class (rail
  between residential and service), weld pieces of one class into routes for
  decisions only (pieces keep their attributes): at 2-valent nodes always, and
  through junctions along the single continuation within 25° of the heading,
  unambiguous from both sides, so each carriageway of a divided street is
  judged whole and the survivor never hops sides at cross streets. Cull
  against kept routes within 28° of parallel whose printed edges would be
  closer than **Minimum Road Gap** (0.4 mm); a sample counts only beside the
  interior of a neighbour, never past its end, or the stem through an
  intersection reads as doubled by the carriageway it continues. A surviving
  route drops a run of doubled pieces (≥ 60%) whose ends both land on kept
  ribbons. A route ≥ 68% shadowed is settled after all routes
  (`_settle_remnants`), against kept roads of equal or better rank only:
  decks are whole or nothing (< 30% shadowed); street pieces keep undoubled
  stretches at least a stub long whose length clear of every such ribbon is
  also a stub, cut ends follow their own path (up to 6 corridors) into an
  equal-or-better ribbon or join the nearest one diagonally from within 3
  corridors, and welded stretches survive only when both ends are covered,
  on the crop boundary, or source dead ends. `MINOR_ROAD_CLASSES` are
  trimmed at sample resolution with remnants shorter than a stub dropped.
  Decks and surface pieces never shadow each other; deck ends never move.
  `tidy_network(context=...)` receives the skipped sidewalks/minor pieces;
  an end is a *dead end* when it met nothing in the source. Snapping: ends
  touching or on the boundary stay; orphaned ends reach twice the gap onto
  an equal-or-better surface road approached at an angle, dead ends only the
  gap; orphaned ends running parallel within the corridor taper in (3× the
  lateral distance). A snap appends a connector (or trims an overshoot) and
  never moves an end vertex of a long segment. Stub pruning (0.7 mm) removes
  routes with a free, non-dead, non-boundary end, judged by length and by
  the length that clears every other ribbon by the gap (a trimmed leg
  stopping inside the next corridor), except a loose end within the gap of
  another route or a route another route's end rests on mid-span. A
  dead-end spur showing less than its own width past the road is a nub; a
  final member shorter than a stub turning off a route by 60° at a free end
  is stripped; whatever touches nothing and totals under **Island Length**
  (1.4 mm) goes. A route whose ends meet is a loop and is anchored to
  itself. Dense-cluster, tangle and loop-collapse passes of the laser
  reference were deliberately not ported. Counts are `network_*`. An audit
  harness in `scratchpad/road_tidy/` renders before/after/delta PNGs and
  counts speck components and orphaned ends (ends that met something in the
  source but touch nothing after the tidy) over cached bundles; keep the
  orphaned count from rising when changing these rules. A pure audit over cached bundles (lost length beyond the
  corridor, invented junctions, named-street fragments) was used to tune
  this; tests in `test_road_network.py` pin the rules.
- `geometry/airports.py` (pure) selects `infrastructure` subtype `airport`
  aprons/helipads and widens runway/stopway/taxiway/taxilane centerlines
  (width tag via `length_metres`, else 45/45/23/15 m; runways square-ended)
  into WGS84 polygons. `roads.generate_roads(airport_features=...)` drapes them
  with `surfaces._draped_slab` at road thickness/embed into one `ROAD_airport`
  object (`feature_type=surface_road`, `road_class=airport`), so road cuts,
  tree clearance and export treat it as a ground road. Generating roads now
  requires `infrastructure`; it stays non-essential for old caches.
- `roads.py` orchestrates one `deck_graph.py` height solve for the whole network;
  `deck_profile.py` interpolates that solution, it is not a separate height solver.
  Joints share heights. Anchors meet ground plus road thickness; unconnected
  ends touch down except where the bbox clips them. Level orders crossings,
  not a height multiplier. Default clearance is 0.4 mm, maximum grade 8%.
- Components too low to reach the 0.2 mm lift threshold demote to roads;
  components over open cut water are protected from demotion. Unflagged water
  crossings are recovered using minimum-span and bank-extension rules.
  Short simple spans adapt to their banks and actual crossings; preserve the
  distinct policy for long/branched/stacked/cropped networks.
- `deck_mesh.py` preserves profile stations in ribbon caps. Piers overlap their
  decks by 0.1 mm; supplemental supports fill excessive unsupported runs where
  foundations and road/rail/lower-deck openings permit. Register causeways before
  placing piers. A first-hit ray is insufficient when decks overlap: use parity.
- Supports remain schematic; mapped suspension/arch/truss superstructures and
  connector-based routing are not implemented. General road-crossing detection
  still uses proximity and can lift a component beside a parallel road. Some
  terminal surface-road runs can overhang cut banks. Closed meshes alone do not
  guarantee support-free printing.

## Optional LiDAR building pipeline

`data/lidar.py` defines the request signature and reads `lidar_buildings.json`.
`external/download_lidar.py` coordinates acquisition, measurements, checkpoints,
and survey selection. `geometry/lidar_buildings.py` emits accepted measurements
as a shared envelope cap or legacy prisms; raw points never become Blender meshes.

- **Minimum Building Footprint (mm²)** defaults to 0.7 (about a 0.84 mm square,
  or 143 m² at the default scale). `lidar_footprint.py` selects parent buildings
  before survey planning, point acquisition and measurement, using full mapped
  polygon area with holes excluded and disconnected components summed. Both
  horizontal scale factors convert area; source height is irrelevant. Small
  parts of admitted buildings remain eligible. Skipped buildings retain ordinary
  source geometry and stay in neighboring-roof exclusions. Mapped rock is exempt.
  Zero disables the filter. Empty selections publish reusable results without
  discovery. Public signatures include the metric area threshold, including in
  height-only mode; unaffected measurement checkpoints remain reusable.

- `lidar_candidates.py` defines the common provider-neutral dataset contract and
  discovery settings. `lidar_acquisition.py` orchestrates adapters/ranking/readers;
  `lidar_usgs.py` retains EPT/TNM pagination, reports and manifest behavior.
  `lidar_flai.py` reads the live Open LiDAR Data inventory and spatial indexes;
  `lidar_opentopography.py` queries its public catalog and published tile indexes.
  `lidar_stac.py` supports bounded static catalogs and GET/POST Item Search with
  pagination. Additional STAC catalogs and international discovery are configurable.
  Provider failures are isolated. Catalog traversal/metadata budgets report partial
  listings; unlocated ordinary LAS/LAZ assets never trigger remote header reads.
  Official adapters add IGN LiDAR HD, NRCan CanElevation, EA England, Scottish
  National LiDAR, NRW, Bavaria and regional PNOA (Castilla-La Mancha). Shared
  `lidar_services.py` handles bounded/paginated WFS and ArcGIS queries and survey
  grouping. Metadata has a 24-hour cache TTL. Published grid inventories/Metalink
  are discovery mechanisms, never guessed tile URLs. See
  `docs/LIDAR_OFFICIAL_SOURCES.md` for coverage/access limits and test commands.
  Multi-nation providers remain fallbacks for unsupported regions and failures.
- `lidar_metadata.py` reads bounded EPT JSON and linked JSON/FGDC survey reports.
  XML accepts harmless external DTD declarations without retrieving them and
  rejects custom/parameter entities. Dates, units, quality and scoped identity
  remain explicit; publication times and generic name hints never become
  acquisition dates. Official documented identifiers can encode acquisition
  information: NRCan's collection end stays end-only, PNOA capture year retains
  year precision. End-only dates cannot establish a material recency upgrade.
- `lidar_usgs_projects.py` enriches recognized USGS EPT/LPC deliveries from the
  3DEP work-unit spatial index before ranking. Match complete work-unit keys and
  intersecting coverage; retain subunits/editions and skip ambiguous matches.
  Collection dates use UTC, independently of publication dates; QL is retained
  as reported metadata, never converted into point spacing or classification
  quality. Existing wider acquisition intervals survive. Queries reuse bounded,
  paginated service reads with a 24-hour metadata cache; failures retain other
  metadata and are reported. Acquisition signature changes require Prepare again.
- Ranking compares whole-building coverage, acquisition age, resolution, comparable
  accuracy, classification and known tile sizes. EPT and COPC share the efficient
  acquisition tier, with EPT preferred on quality ties. Both run before staged
  LAS/LAZ. Successful buildings skip redundant streamed surveys. Material staged
  upgrades require substantial metadata evidence and explicit consent; unknown
  or marginal metadata retains good streamed coverage. Same-survey copies remain
  delivery-gap fallbacks only. Known reconstruction support/epoch gaps can now
  offer a different survey; geometry-budget and unknown failures do not seed downloads.
- `lidar_offer.py` binds consent to the request, reviewed datasets/buildings/tiles
  and normalization metadata. Ordinary Prepare/Refresh/background runs publish
  streamed measurements plus optional gap/upgrade offers. **Download and Use
  Offered Tiles** authorizes only that reviewed set. Replays recheck eligibility;
  changed/expanded offers require another choice. Generation stays offline.
- Automatic staged selection uses fallback policy 8; there is no full-survey
  picker or `comparison_url` request setting. A measured capture year can fill
  missing streamed acquisition metadata for that building, never the whole
  survey. Pending offers suppress known duplicates and substantially older
  fallback projects without a documented quality advantage. Unknown metadata
  or broader catalog coverage must not hide another
  eligible alternative. A substantially newer project-year hint now precedes
  broad old coverage when verified acquisition dates are absent; the hint is
  displayed in the offer, never promoted to measured capture metadata. A much
  older project without a documented quality advantage is deferred while the
  newer offer is pending and after a newer staged success; failed newer reads
  or measurements retain the old fallback. Accepted uncertain alternatives are compared even after another
  staged result succeeds; identical surveys and source-independent failures
  remain excluded. Consent remains limited to reviewed buildings and tiles.
  `shared_tile_features`
  adds otherwise eligible comparisons only when their entire footprint/ground
  tile allowlist fits tiles already selected for gaps/upgrades. This can revisit
  successful streamed measurements without extra downloads. It preserves
  source-independent and same-survey exclusions and includes the expanded
  building list in the reviewed offer. A missing halo tile prevents expansion.
- `lidar_copc.py` uses pinned laspy with strict cached HTTP ranges and bounded
  octree/point allocation. Servers ignoring Range are rejected before body reads;
  there is no whole-file fallback. COPC and staged tiles share footprint/30 m
  ground-halo allowlists. All formats feed the same seven-column point array into
  existing measurements; geometry/FDM defaults are unchanged.
- `lidar_normalize.py` applies declared classification mappings (including LAS
  lookup VLRs) and explicit coordinate units. Header CRS takes priority, with
  catalog CRS as fallback. Unknown custom classifications or Z units are rejected.
  **Missing Z Units** defaults to requiring metadata; a user-declared unit fallback
  can fill missing units, never override explicit header units. No horizontal-unit
  inference or automatic geoid conversion. Ground subtraction is within one survey.
  Provider/name, acquisition interval, density, CRS/datum, classifications, licence
  and attribution survive source audits, point provenance and building records.
  A reported single-year acquisition dates otherwise wholly undated points;
  multi-year metadata never invents a capture year or overrides GPS evidence.
- `lidar_identity.py` compares scoped dataset/project metadata and known USGS
  project delivery/metadata directories, retaining subprojects and epochs.
  Never infer identity from generic tile names, titles or overlap. Conflicting
  acquisition periods/explicit editions prevent equivalence; missing identity
  remains unknown. LAZ copies of successfully read EPT surveys are redundant
  even after insufficient roof/ground support. Per-building coverage gaps,
  failed reads and empty EPT hierarchy queries still permit same-survey delivery
  fallback; zero filtered points or generic roof-coverage rejection do not.
  Identity and per-tile footprint/halo ownership/reasons are logged and audited.
- `lidar_provenance.py` verifies differently named deliveries through bounded
  EPT manifests/input metadata and already cached fixed LAS headers (no automatic
  remote LAZ reads, including header ranges).
  Names only flag possible duplicates. Original project identity or a nonzero
  LAS GUID corroborated by count, XYZ extents/scales, format and encoding can
  confirm equivalence, restricted to verified input/tile coverage. Partial
  metadata must never establish whole-survey equivalence.
  Exact original asset URLs and recognized acquisition-specific EA/PNOA IDs
  retained by Flai also establish aliases, restricted to intersecting matched
  tile coverage. Different catalog namespaces do not defeat proven asset identity.
  Successfully read duplicate streams are skipped unless materially improved;
  failed transfers remain eligible for another delivery.
- `lidar_ept.py` includes additive ancestor nodes as well as leaves.
  `lidar_laz.py` downloads intersecting staged tiles to disk and decodes chunks.
  `lidar_archives.py` handles consented minimum ZIP delivery units for EA England,
  extracts only indexed members to hashed paths, checks sizes/CRC and shares the
  resumable archive download. Offers disclose the minimum 5 km delivery unit.
  Failed downloads exhaust retries once per preparation, not once per building
  batch/member; a new preparation can retry. No point download occurs in discovery.
  Readers normalize to WGS84 XY, metre Z, classifications/returns, and capture-age
  evidence. Reject missing CRS/unknown vertical units; distinguish international
  and survey feet. Catalog/publication/OSM edit dates are not flight dates.
- `lidar_batches.py` groups whole buildings spatially (400 m default), retaining
  roofs and a ground halo. Per-group limits can subdivide work; normal preparation
  has no whole-map byte/point/time cap, though per-request/file/group guards remain.
  EPT node and LAZ tile transfers use `lidar_downloads.py` (default 4, allowed
  1–16; 1 is serial) while decoding stays sequential. Per-building
  reconstruction in `measure_features` runs in a reusable spawn process pool
  (automatic: CPU count − 1, capped at 8; `--measure-workers` or
  `JARVIZAR_LIDAR_MEASURE_WORKERS`, 1 is serial). Cropping, epoch checks and
  publication stay in the parent; `check_source` runs with the reconstruction,
  because intersecting a cap's faces with mapped parts takes seconds and held
  the pool idle from the parent. Buildings complete in their original order,
  but the in-flight window (2 × workers) counts unfinished ones only, so a
  slow tower at its head does not stop new submissions; finished entries drop
  their points and at most 8 windows wait. Results, counts and their order
  match serial exactly, and a broken pool finishes the batch serially. Check
  speed changes byte for byte against a replayed `lidar_derived` batch. Direct `prepare()`
  calls default to serial. EPT
  lookahead retains at most that many futures and consumes the original node
  order; futures keep no response payloads. Prefetch is limited to the current batch;
  evaluate it before admitting the next. Approved staged offers finish their
  reviewed scope even after unproductive batches; further surveys/expanded tile
  sets require another offer. Checkpoints replay completed work before new
  transfers. COPC streaming remains serial. Changing concurrency must
  not change measurement signatures or results. The UI passes the setting to
  interactive and background jobs.
- `lidar_decode_cache.py` reuses raw records only within one preparation, before
  applying each batch's unchanged crop, classifications, units and capture dates.
  EPT nodes use a 64 MiB RAM LRU keyed by URL and fetched-content hash. LAZ tiles
  use read-only mappings of delete-on-close temporary files, capped at 1 GiB
  total and 512 MiB per tile, keyed by downloaded file identity/revision stats.
  Oversized tiles or unavailable temporary storage retain chunked streaming.
  Failed/incomplete reads never publish a decoded tile. Preparation exit closes
  mappings; OS file closure removes temporary storage after process termination.
  This optimization changes neither persistent cache signatures nor geometry.
- `lidar_measurements.py` fits ground-relative scalar heights, supported terraces,
  and `lidar_planes.py` roof planes within source footprints. Enforce sufficient
  ground/roof support, component-wise coverage, footprint consistency, and capture
  consistency. Coverage fallback uses actual clipped cell area at the same 85%
  threshold. Near misses with at least 80% supported area in every component
  retry three fixed half-cell grid offsets, retaining the first complete fit.
  Every retry keeps the three-return cell minimum, 85% component coverage and
  all ground/roof/printability checks; already accepted fits stay identical.
  Ground fitting is reused across retries and no additional points are fetched.
  **Roofs filed as vegetation:** coverage and the ground-inside test count only
  class 6 and single-return class 1, and Cook County files half the roof and
  most of the facade of many towers as vegetation (303 East Wacker, 321 North
  Clark, Block 37 stayed source boxes). A Roof Envelope that every
  building-class attempt rejects (`VEGETATION_ROOF_REASONS`) gets one last pass
  (`_continue_with_vegetation`): a vegetation cell's upper band joins the roof
  where it lies within a cell's height of a roof cell beside it, grown from
  cells the building classes support, and only above `local_canopy` (95th
  percentile of vegetation cell tops 3–30 m outside the footprint and every
  mapped neighbour) plus the admission band. Without that floor, trees rising
  from a low roof's edge gave Oak Park's houses tree-shaped roofs; a planarity
  test did not separate them. Admitted cells feed the envelope as ordinary
  returns and cover the ground test's cells. Neighbours are gathered within
  30 m for that ring; the outside-roof ring (2–6 m) sees the same ones as at
  7 m. Buildings the first attempts accept are byte-identical.
- **Correct Heights Only** is opt-in and uses a separate `HEIGHT_ONLY` cache
  identity. It keeps acquisition/ground/coverage/epoch checks, samples a fixed
  3 m grid, and skips roof surfaces, terraces, infill and mapped rock. Connected
  roof support supplies scalar tops; tiny patches cannot set a large building's
  height. Reuse those same cells within each existing main-mass footprint,
  excluding other mapped parts with a half-cell margin. Never associate the
  tallest scan roof with the tallest source tag. Parts smaller than 5% of the
  parent, shaped roof parts and elevated parts are left alone; at least 25% of
  a mass must be exposed. No extra ground fit, point read or geometry fit occurs
  per source mass. `source_heights` stores scalar corrections by source identity.
  Generation retains ordinary source selection, XY/topology, courtyard holes and
  grounded undersides. It rescales only the corresponding mass when the discrepancy
  exceeds both 3 m and 20%. Print minimums and source roof shapes still apply.
  This does not restore missing source masses or reconstruct detail.
  Roof-detail changes reuse scalar measurements. Print-scale changes require
  Prepare to reselect footprints when the area filter is enabled, reusing
  compatible scalar checkpoints; switching modes requires Prepare again with Refresh off. Downloads
  and point decoding are unchanged; savings come from coarser sampling and skipping
  reconstruction. Keep full-mode cache signatures/results unchanged.
  Missing returns alone are not proof that a building is absent.
- Planar ground fits retain their original result. When the plane fails,
  `lidar_ground.py` can retain a low ground-cell anchor with its actual location:
  at least eight 4 m cells, three returns per cell, whose hull covers the
  footprint's representative point and `ANCHOR_COVERAGE` (nine tenths) of its
  area. Full enclosure rejected a stadium flush with a riverbank for the two
  per cent of its footprint on the water side; ground on one side or half of
  a footprint is still rejected.
  Cell medians and the lower decile resist density imbalance and isolated low
  returns. `ground_anchor` stores WGS84 XY plus a datum offset; the Blender
  builder aligns that location to its existing heightfield. It never interprets
  a hillside as a flat plane or mixes ground from different surveys. Roof,
  footprint, capture and geometry checks still apply.
- **Include Mapped Rock Surfaces** is opt-in. `external/lidar_rock.py` merges
  intersecting valid `land` bare-rock polygons without enlarging them, and
  measures their class-2/6 or single-return class-1 surfaces. Vegetation cannot
  supply coverage or raise the envelope. Require three returns per supported
  1.5 m cell and 85% area coverage in every component, plus surrounding ground
  support and printable relief. Its print-scale area budget bounds fitting.
  The request signs `land.geojson`; records retain `surface_geometry`,
  `surface_kind`, source land IDs and an alignment anchor. Blender builds these
  through `geometry/lidar_rock.py` with rock material. Only a successful complete
  cap can suppress wholly contained source buildings and their parts. A failed
  rock fit or cap adds no guessed extrusion. Point landmarks, general attraction
  boundaries and unmapped cliffs never establish a rock domain.
- Roof Envelope (`FACETED`) calls `external/lidar_envelope.py` before any
  terrace reconstruction. It builds one height raster per footprint component:
  the second-highest return in each cell (`UPPER_RANK`; a quantile agrees up
  to eleven returns, but a facade cell holds hundreds and its 90th
  percentile sat a tenth of the way down the wall, hanging roof edges in
  teeth; the second highest is blind to how many lie below), then a moving median
  over a disc two cells in radius (a slot narrower than that is bridged), a
  light mean over each observed cell and its observed edge neighbours away
  from walls, then the nearest observed height copied into unobserved
  cells. Unobserved cells never vote in the median or the mean, so
  a courtyard or the gap between separate components cannot drag a roof edge
  across it. Cells outside the outline never vote either: the roof reaches
  the outline at the height of its last cell inside, and the band beyond,
  whose returns run the whole height of the wall, cannot notch the rim.
  Where fewer than `MIN_VOTES` cells of a disc are observed the cell is in a
  scan shadow and takes the upper quantile of the shadow's cells over twice
  the reach: a few stray facade returns were otherwise each the median of
  their own disc, and copying them across the shadow combed the rim with
  teeth. They still count, because a shadow beside a tower can be a real
  low roof and dropping them filled it from the tower. A rim cell more than
  two cells below a neighbour is a facade return, not roof, and takes that
  neighbour's height. Returns filed under a vegetation class (3–5) are
  admitted up to the band above the structural envelope and join each
  cell's upper return, but **never lower a cell the building classes
  observed**: the Cook County survey files most of every tower's facade as
  vegetation, and along an outline a metre outside the wall they outnumbered
  the roof returns and hung the roof edge down the facade in icicles (Daley
  Center, Leo Burnett, North Pier Tower). Cells the building classes left
  empty still take them: Chase Tower's flare is filed as vegetation and
  disappears without them. **Scan shadows are ambiguous:** a patch with few
  or no returns can be a low roof hidden by a tower or a roof that returned
  nothing. Capping sparse patches a band above their lowest measured border
  cut Trump Tower's setback terraces to 20 m, and filling empty cells from
  their lowest neighbour dropped 134 cells of the Aon Center's roof to 7 m;
  nearest fill stays. **Returns are not filtered.** Every rule that dropped
  returns by their neighbours (a "shadow" test, 3 m within 1 m) also
  deleted sloping facades such as Chase Tower's flare and kept only a fifth of
  some towers' returns. Copying the nearest height keeps a roof edge a step;
  relaxing across the unobserved band made a ramp of uneven heights that the
  cap showed as ribs.
  **The rank filter is not interchangeable with morphology.** On a
  near-vertical facade an opening or closing by any flat element is the
  identity, because the slope dominates every neighbourhood, so dilation,
  erosion and relaxation passes cannot remove cross-slope detail at all; a
  rank filter is unaffected by slope.
  The raster is triangulated on its grid, each cell split along the diagonal
  of most similar corner heights, and laid along the footprint's
  minimum-rotated-rectangle long axis (reduced to ±45°, no rotation at 0) so
  an ordinary building's walls fall on grid lines. Then
  `external/lidar_simplify.py` collapses edges by quadric error (Garland &
  Heckbert) until every remaining edge costs more than `COLLAPSE_TOLERANCE`
  × pitch² (32 cells², 8 m² at 0.5 m) and, beyond that, while the cap
  exceeds `facet_budget(pitch)`. The error is **memoryless** (Lindstrom &
  Turk): priced against the faces as they are now, not the original ones.
  Accumulated quadrics remember every stair a straight facet replaced, so its
  cost grows with the cube of the stairs it spans and walls stop merging at
  about a metre however loose the threshold, while loosening flattens roof
  detail; measured locally, extending a straight facet costs nothing and a
  real feature still costs its full height. Face planes are cached and refit
  only for the faces around a collapsed vertex (the refit per push was most of
  the run). Flat-region ties break by edge
  length, or one vertex swallows a whole roof and the run turns quadratic.
  A collapse never flips a face in plan or leaves one thinner than
  `MIN_GAP` (the cap must stay a height field for `envelope_solid`, and a
  sliver that thin is float32 noise once printed), never puts two vertices
  within that centimetre in plan (Blender welds float32 XY) and never moves
  the mesh rim. Collapsed vertices within a quarter of that gap of the
  footprint boundary are snapped onto it before clipping: an outline running
  a hair inside a grid line otherwise clipped a row of slivers thinner than
  float32 holds, which the join dropped and then found a hole. Vertex
  placement keeps the quadric optimum: subset placement (endpoints and
  midpoint only) brought the ribs back on every wall. **Relief along a
  steep face is straightened before the collapse** (`_fair`): Chase
  Tower's creases were its piers, 1–2 m proud every 12 m, deeper than the
  deviation bound and tapering up the sweep into long slivers. On a face
  the heights rise monotonically across it, so a median along the face is
  the median of its plan position at every height; each steep cell (over
  four cells, so roof noise never reads as a face) takes the line of four
  directions whose heights vary least, only where more than half the line
  lies within half a cell of that median (a straight face: a cone or a face
  crossing the line at an angle is left alone), only where the face is
  still steep within half the reach of both ends (a line through a convex
  corner runs off the mass and chamfered plant rooms and tower tops by a
  metre; a pier's toe has its face a metre in), only where every height
  level moves at most `FAIR_REACH_MM` (0.14 mm) in plan both ways (a plant
  room, fin or turret the median would erase stays whole), and never within
  half a window of a spire. The window is `FAIR_WINDOW_MM` (0.6 mm, so
  relief under 0.3 mm, a nozzle's width, goes). Loosening the collapse's
  bound on walls instead let every tower's walls drift (fidelity loss
  tripled) and was rejected. This replaced tiers, traced outlines, block merging and the
  pitch-coarsening retry: nothing detects tiers, setbacks or architecture,
  and a curved tower (71 South Wacker) comes out as a coherent fan of 4–5 m
  facets with under a thousand faces, against ~50,000 grid faces, matching a
  decimated survey model. Collapsed faces are clipped to the footprint
  (`_clip_to`, barycentric heights; a clipped piece with a courtyard hole is
  cut by constrained Delaunay because the join takes simple rings) and
  clipped slivers of any positive area are kept: dropping them opened cap
  holes. Pitch follows print scale (0.035 mm per cell, half a printed
  layer, never above 3 m). Its floor is 0.8 m, lowered to at most 0.5 m
  while a grid cell still averages about one upper-surface return
  (`_surface_density`), so Chicago at the default scale is gridded at
  0.5 m; the face budget is `ENVELOPE_FACETS_AT_1M` scaled by
  (1 m / pitch)², capped at `MAX_ENVELOPE_FACETS`, and enforced by
  collapsing further, never by coarsening the pitch. A merged vertex never
  leaves the faces it replaces by more than two cells, so a plant room or
  parapet taller than that is never lowered away, while relief under it
  (a fraction of a printed layer) may be. Spend faces, not plan resolution.
  **That bound is a distance to planes, and the two cells are what smooth
  tower walls need:** halving it everywhere, or for walls only, roughened
  every tower's walls (Kinzie Station, Miami's Ivy), and refusing
  extrapolated optimum heights made fidelity worse (Brickell Heights'
  largest error went from 56 to 106 m). But a wall may wander those two
  cells at every merge, and a mass only a few times that across is folded
  into its neighbours: Cinderella Castle came out as one slanted blade
  although its raster showed six towers. `_spires` marks cells standing
  more than the admission band (0.28 mm printed, at least 3 m) above four
  fifths of a ring six cells out, and `collapse(fine=...)` holds edges
  touching them (or a vertex that absorbed one) to half the bound. A tower,
  steeple or chimney clears the ring; a bay or fin on a larger mass clears
  half and a square corner three quarters, so walls and corners are never
  marked and a cap without such a mass is collapsed byte for byte as before
  (30 of 43 regression buildings; the rest gained a few percent of faces).
  Marking by width alone (a grey opening) caught 5–17% of tower cells and
  roughened walls like the global change. Pinning marked vertices instead
  was slightly crisper but kept every rooftop spike of a planted parking
  deck. The half-metre band of `_surface_density` also reads a steep roof
  as sparse (the castle 2 returns/m² against 10 beside it, so 0.71 m
  cells), and deliberately reads a noisy one so, which grids it coarser
  and averages the noise out (`test_noisy_slope_is_not_terraced`). So only
  a cap that shows spires at the coarser pitch is regridded by
  `_scatter_density`, the share of half-metre cells holding any return
  (d returns per m² leave exp(-d/4) empty); every other cap keeps its
  pitch. Not changed: the rank filter still truncates a spire's last metres
  (the castle's 54 m tip reads 45 m); that part is one or two cells wide,
  under 0.1 mm printed. Returns excluded upstream (unclassified,
  multi-return) would add 2 m to that tip and tree canopy to low roofs.
- The default path no longer calls the `lidar_surface_*` region, primitive,
  outline or plane-stitching stack, including its compatibility fallbacks.
  Those modules remain as historical helper implementations/tests. Entirely
  planar roofs can suppress bounded noise; local boundary extrapolation can
  continue a supported slope. Neither owns independent architectural regions.
  An envelope failure can retain complete legacy terraces/heights, never a
  partial roof. Terraces and disabled roof generation retain their existing path.
- An envelope publishes `roof_mesh`, one shared vertex table plus integer
  faces, tagged `surface_reconstruction=roof_envelope`, with up to 16,384
  faces on a 1 m grid and 65,536 on the finest; a collapsed cap normally
  needs a few hundred to a few thousand. Its faces meet at common corners, so
  a polygon per face repeated every corner about six times and the GeoJSON
  wrapper once per face: measured on downtown buildings that was 238 bytes a
  face against 42, on disk and again in the reader's memory.
  `lidar_records.envelope_mesh`/`envelope_rings` pack and unpack it without
  moving a coordinate; `roof_faces`/`has_roof_surface` read either encoding,
  and the loose `roof_surfaces` list remains valid for every other
  reconstruction and for records written before algorithm 16. Published
  coordinates are rounded to nine decimals in degrees and 0.1 mm in height.
  The reader's `lidar_buildings.json` guard is 512 MB. In Blender,
  `geometry/lidar_envelope.py` joins the cap's shared topology into one solid
  and adds only exterior/courtyard walls along the footprint and a base. Its
  faces are clipped to the output frame carrying their own vertex heights
  (`clip_cap`): a plane refitted through three rounded corners of a wall
  facet a few decimetres wide and a hundred metres tall missed the planarity
  tolerance and lost the building, 77 of them in downtown Chicago. The join's
  outline test allows a `precision` of a millimetre on the ground, because
  published corners are rounded to nine decimals in degrees and near the
  model centre that exceeds the float32 rounding its tolerance was set for. The
  existing terrain-seated foundation overlaps this upper solid slightly.
  Conform clipping-induced edge splits; verify area, closure and winding
  before adoption. A join failure must retain source geometry rather than
  extruding thousands of independent fragments.
- `lidar_source.py` evaluates source-height confidence and incomplete assemblies;
  `lidar_selection.py` chooses one complete survey using measured support/detail
  and capture age, with classification breaking quality ties. Never average or
  mix geometry/ground from different surveys. Prefer LiDAR on Conflicts permits
  a usable scan to override source/date/other-survey conflicts and records those
  decisions. Turning it off enables conservative source-detail/conflict checks.
  Data-quality and geometry checks still apply in either mode.
- Source parts can remain while measurements restore a missing main mass or
  correct supported part heights. Commit infill/corrections only after validation;
  failed replacement geometry retains source fallback. Minimum-height lift uses
  the measured base terrace, carrying its tiers together. No footprint-source
  building means no new building synthesized from LiDAR alone.
- Cache identity includes footprint file hashes, bbox, algorithm/acquisition
  versions, effective XY/Z scales, terrace detail settings, roof/conflict policy, and
  source URLs. Changes to those inputs require Prepare again. Audit both
  `data/lidar.py` and the worker's version checks when changing the contract.
- Completed groups live in `<bundle>/lidar_jobs`; reusable tiles live in
  `<cache-root>/lidar_tiles`. `lidar_reuse.py` keys measurement checkpoints by
  batch features, mapped parts/neighbors, query bounds, source normalization and
  reconstruction/acquisition versions/settings, rather than unrelated discovery
  options or whole-file hashes. Exact compatible older checkpoints migrate on use.
  Public results retain the complete request signature. Prepare reuses valid
  results for 24 hours, including offline; then it rechecks discovery and reuses
  compatible batches. Actual failed building reads retry immediately; provider
  warnings affecting zero buildings do not invalidate a completed result.
  This age limit applies to Prepare, not offline model generation.
  `lidar_point_cache.py` stores checksummed, non-pickled geographic seven-column
  arrays under `<cache-root>/lidar_derived`, before in-place XY projection.
  Scale/roof-setting changes can reconstruct from these normalized points.
  Source metadata, query/allowlists and acquisition versions enter their keys;
  Refresh advances source generations so older settings cannot revive stale
  derived data. No arbitrary cross-bbox point stitching. `lidar_storage.py`
  limits reusable tiles/points to 30 GiB per cache root by default, reserving
  10 GiB of disk space. Machine preferences adjust both. Preparation trims
  older derived points before downloaded sources under the worker lock;
  active inputs, recent resumable partials, bundles, checkpoints, published
  results and source generation markers are protected. A `points/.keep` or
  `lidar_tiles/.keep` marker protects that directory. Required writes reserve
  space across download threads; optional point/decode caching can be skipped.
  Storage exhaustion aborts without publishing partial survey results.
  Sidebar **Review LiDAR Cache Cleanup** previews manual trimming; no cleanup
  runs merely on registration or model generation. The budget excludes protected
  bundles and the separate bounded 1 GiB temporary decode cache.
  `lidar_records.py` validates public results and checkpoints; damaged checkpoints
  are disposable. Publication uses a temporary file and replacement. Cancellation
  preserves previous published results and completed work; keep worker ownership
  until it actually exits so a second job cannot write concurrently.
- `lidar_worker.py` holds an OS lock on the cache root for each preparation;
  overlapping jobs fail before discovery or cache writes. Workers monitor their
  owning Blender PID. Windows cancellation stops the whole process tree because
  a virtual-environment python.exe can launch a separate real Python child.
- `lidar_progress.py` serializes progress from acquisition/download threads,
  retaining stderr messages while limiting sidebar writes to five per second.
  Structured stage/source/current-survey building counts survive reader messages;
  stage boundaries force updates. Readers report node/tile/chunk activity and
  measurements report individual building progress. The top-level City Model
  panel displays the current-survey bar, cache reuse, elapsed time and update age.
  Discovery has no invented completion percentage. `data/lidar.py` retains the
  last valid status during transient progress-file read failures.
  Progress publication retries brief permission conflicts and remains advisory
  if either temporary-file writing or atomic replacement fails. Checkpoints and
  final measurement publication remain mandatory; progress failures must never
  be reported as broken surveys or interrupt otherwise valid preparation.
- `lidar_transfer.py` retains partial LAZ files only with a strong ETag and
  known total length. Resumption uses Range/If-Range and validates the returned
  ETag, offset and total before appending; changed resources restart. Streamed
  LAS headers reject unusable CRS before point transfer, while EVLR-only CRS
  and oversized header regions defer to the existing complete-file reader.
  Transfer rates and decode/crop stages are reported independently.
- `counts` aggregates survey observations; `rejection_counts` describes unique
  final skips. Prepared building totals can exceed generated totals because
  source selection and geometry validation run afterward. Report both stages.

## Export

`jarvizar.export_3mf` writes a native, unsliced Bambu Studio project directly
from mesh data; no external 3MF add-on is involved and scene units are
irrelevant. `data/export_plates.py` streams each plate's parts into the model
XML as they arrive, so memory is bounded by the largest part, then adds
`Metadata/model_settings.config`, `Metadata/project_settings.config`, content
types and relationships. Every part is a named `normal_part` whose `extruder`
metadata assigns its filament: one filament per distinct colour and Bambu PLA
line in order of first use, taken from each material's Principled base colour
(else viewport colour) as raw linear bytes and its `jarvizar_filament` line
(PLA Basic or Matte, which picks the preset and `filament_ids`). The palette
uses Bambu's exact codes: PLA Matte Caramel buildings, PLA Matte Ivory White
terrain and supports, PLA Basic Bambu Green parks, PLA Basic Dark Gray roads,
bridges, piers and paving. A part mixing materials takes the filament of
its most common one; only its other triangles carry Bambu `paint_color`
states. Coordinates are model millimetres at six decimals. The `BambuStudio-`
Application prefix is required: Bambu gates project loading on it and
otherwise imports plain geometry, discarding printer, palette and part
filaments. Part names come from generated `feature_type`, `surface_category`
and `road_class` tags (`data/export_3mf.py`), with repeated types numbered.

Bambu treats every top-level build item as its own object (re-centred,
dropped, possibly rotated onto another plate), so each plate is one multipart
object with relative heights intact. Without Multi-Plate Export the whole
cropped model is one plate named `Map`, centred on the bed. All plates share
one Z datum: the model's lowest point rests on the bed.

**Bambu Printer** selects the bed (A1 mini 180; A1, P1P, P1S, P2S, X1C, X1E
and X2D 256; A2L and H2C 330×320; H2S 340×320; H2D and H2D Pro 350×320) and
the starting printer, process and Bambu PLA Basic/Matte filament preset names as
bundled with Bambu Studio 2.8; P1S is the default. Changing it clamps the
section maxima to the bed, and export rejects maxima above it. Users pick
their actual filaments and recalculate the 280 mm³ default flushing matrix
before slicing. Bed exclusion zones (18×28 mm front-left on P1/X1) are not
modelled; the default 210 mm sections clear them.

If the scene contains a mesh named exactly `cutout`,
`blender/export_cutout.py` derives its evaluated inner through-opening and crops
along the frame's local thickness axis. The frame is neither exported nor used
as a subtraction solid; its scene Z is not a height limit. No frame means full
export. Invalid frames or unclosable cuts fail rather than exporting uncropped.
Frame-axis detection must verify a through opening in candidate cross-sections;
the largest face-normal area alone can select a side wall on a tall frame.

Classify object bounds and connected shells first. Isolate crossing shells
before BMesh operations (their setup otherwise scans the entire merged mesh).
Convex openings use capped plane cuts; concave openings use per-shell Exact
intersection with self-intersection disabled. Preserve holes, collinear boundary
vertices, independent shells, and materials. Export copies/helpers must be
cleaned up on success and every failure path. See [export design](docs/EXPORT_CUTOUT.md).
Cut-edge cleanup may collapse short connected contour edges, but must never
weld nearby unrelated contour strands. Prefer endpoints on large retained faces
to preserve terrain tops/bottoms. Validate new caps for both closure and winding;
roll back failed scan fills before retrying with boundary-preserving ear clipping.
If edge cleanup pinches an exact contact, retry that shell from its original
mesh without collapsing contour edges. Export ear clipping can retain distinct
indices at coincident points; its degenerate-triangle tests must bound the
segment rather than treating an entire infinite line as part of the triangle.

`multi_plate_export` is off by default and used only by this export operator.
It requires a cutout, runs the unchanged final crop first, then partitions
with `data/export_sections.py` and `export_cutout.export_sections`. The grid
follows the opening's dominant edge direction (`grid_angle`: length-weighted
headings modulo 90°, folded to ±45°, world axes when nothing dominates,
exactly 0 when axis-aligned), so a frame rotated to a street grid yields
rectangles aligned with it whether the rotation is on the object or applied
to its mesh. Rows run along the frame's north-south side and columns west to
east; each section is written axis-aligned on its plate. Shared edges and one
common float32 tolerance keep seams exact. Each source is baked once into grid
coordinates and its shells walked once (`partition_mesh`): whole shells go to
the cell containing them and shells straddling a seam are cut in isolation
against each cell they reach, with the crop's own cutter; only this pass
discards zero-volume tangent remnants. Cost no longer grows with the plate
count. Empty cells are omitted; a grid over Bambu's 36-plate limit fails.
The maxima are configurable up to the largest bed.

Plates follow Bambu's PartPlateList: ceil(sqrt(count)) columns, 20% bed
spacing, rows downward, each section centred by its cell bounds. Names
`Section R1 C1`… identify pieces; no connectors, seam clearance or underside
labels are added. Verify with `test_export_3mf.py`, `test_export_sections.py`,
`blender_export_cutout.py`, `blender_export_plates.py` and installed Bambu
`bambu_export_plates.py` (import/save/reopen of single-plate, multi-plate,
rotated and other-bed fixtures). The live crop script accepts
`--multi-plate`, `--printer` and section size options. See
[3MF format and verification](docs/EXPORT_3MF.md).

## Development and verification

Run from the repository root; local `.venv-overture` includes optional LiDAR
dependencies. Tests use `unittest`; no project-wide formatter/linter or CI is
configured. Pure tests need no Blender/network. Report optional dependency skips.

```powershell
& .\.venv-overture\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -t tests
$blenderExe = 'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe'
& $blenderExe --background --factory-startup --python-exit-code 1 --python .\tests\blender_smoke.py
```

Keep `-t tests` for sibling fixture imports. Check exit status and success markers;
use `--python-exit-code 1`. Repository scripts prepend the checkout to `sys.path`,
so installed-copy verification must run separately. `--factory-startup` isolates
tests but does not load saved preferences; supply downloader paths explicitly,
or omit it when intentionally testing installation preferences.

[Verification commands](.claude/commands/verify.md) give full live-run examples.
Select focused checks based on the change:

| Area | Existing checks under `tests/` |
| --- | --- |
| Core pipeline | `test_*.py`, `blender_smoke.py`; smoke exercises merged/unmerged geometry, heights, roofs, and cleanup. `blender_generation_transaction.py` checks rollback/ownership. `blender_generation_modal.py` exercises real worker cancellation at each phase, import, retries and cleanup; windowed `blender_generation_gui.py` checks real Esc/Cancel and event-loop responsiveness. |
| Water / supports | `blender_water_cut.py`, `blender_ground_support.py`, `blender_pond_basins.py`, `blender_basin_support.py`, `blender_water_surfaces.py`, `blender_visible_supports.py`, `blender_paved_supports.py`; cached `blender_water_cut_live.py`, `blender_coastline_live.py`, `blender_pond_basins_live.py` |
| Roads / surface ownership | `test_road_network.py`, `test_airports.py`, `blender_airport_paving.py`, `test_deck_graph.py`, `test_deck_mesh.py`, `test_bridge_supports.py`, `blender_short_bridges.py`, `blender_bridge_caps.py` (cached), `blender_road_cut.py`, `blender_road_cut_export.py`, `blender_shore_roads.py`, `blender_surface_priority.py`, `blender_surface_priority_settings.py` and related live scripts |
| Buildings / LiDAR | Building/roof/duplicate tests and `test_lidar_*.py`; `blender_lidar.py`, `blender_lidar_envelope.py`, `blender_lidar_facets.py`, `blender_lidar_minimum.py`, `blender_lidar_preference.py`, `blender_lidar_operator.py`; `blender_lidar_regression.py` for cached off/on mesh fingerprints |
| Anchored LiDAR / mapped rock | `test_lidar_relief.py`, `test_lidar_offer.py`, `blender_lidar_relief.py`; verify anchor alignment, class/coverage rejection, transactional fallback, source suppression, and unchanged disabled-LiDAR mesh fingerprints |
| Export / trees / clipboard | `test_export_3mf.py`, `test_export_sections.py`, `blender_export_cutout.py`, `blender_export_plates.py`, installed Bambu `bambu_export_plates.py` and the live crop script; `blender_tree_printability.py`, `blender_tree_road_clearance.py`; `test_projection.py`, `test_bounds_presets.py` and windowed `blender_gui_paste.py` |

For geometry work, compare identical inputs/settings, check closure **and winding**,
then inspect focused renders and seating/overlap probes. `render_preview.py`
supports `--water 0`, `--target x,y`, `--span mm`; `blender_embed_probe.py` is
diagnostic, not a correctness verdict. Regressions cover Cincinnati roofs/bridges,
Chicago massing/water, Clearwater/San Francisco coastlines, Magic Kingdom
sub-cell attraction channels, and large surface-cut workloads. These are fixtures, never reasons for location-specific code.

Live scripts need existing caches and sometimes fixed fixture bounds or output
folders; inspect their arguments before running. `blender_live_full.py` accepts
`--cache <cache-root>` and `--bbox west,south,east,north`, but its feature-count
assertions assume a dense city selection. The older `blender_live_smoke.py` takes
a bundle directory and fixed Cincinnati bounds; **it currently fails** because
it supplies only building files while leaving `recess_ponds_and_fountains=True`.
A building-only flat-base fixture must disable that setting as well as water
visibility and through-cuts. Do not advertise that legacy command as passing.

For acquisition changes, check checkpoints, zero-network tile replay, malformed
records, source failure isolation, concurrency, and cancellation. For LiDAR-only
changes, verify disabled-LiDAR geometry is unchanged; enabled changes should be
limited to buildings, explicitly enabled mapped rock, and their terrain supports. A render, closed-mesh audit,
export, slicer round-trip, and actual print are different validation claims.

## Packaging, installation, and other references

`python scripts/build_addon.py` builds both ZIPs in ignored `dist/`. The classic
archive contains `jarvizar_city_model/`; the extension has the manifest at its
root. Archive names read the version from `blender_manifest.toml`; keep that
version and `__init__.py`'s `bl_info` tuple synchronized. The builder overwrites
same-version archives, so preserve needed baselines first. It packages files
under the add-on directory only, excluding bytecode; keep experiments elsewhere.

After add-on changes and relevant passing checks, run `scripts/install_addon.ps1`
as described in [install-addon](.claude/commands/install-addon.md) and report its
three summary lines only; no file listings, tree diffs, or extra Blender sessions.
Blender may stay open. A documentation-only change outside
the packaged add-on does not require rebuilding/reinstalling identical code.
A running Blender keeps its imported copy until restarted. Never force-close an
unsaved user session.

The classic install is normally under
`%APPDATA%\Blender Foundation\Blender\3.6\scripts\addons\jarvizar_city_model`.
Verify actual installed paths/preferences/dependencies, not old installation notes.

[README.md](README.md) covers user setup/use. Topic references:
[bridges](docs/BRIDGE_DESIGN.md), [water/basins](docs/WATER_CUTOUTS.md),
[LiDAR](docs/LIDAR_BUILDINGS.md), [dependencies](docs/DEPENDENCIES.md).
These include historical investigations; verify older claims against the code.
[IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) is a historical staged plan,
not a current completion checklist; [OVERTURE_SCHEMA.md](docs/OVERTURE_SCHEMA.md)
is a dated schema snapshot, not a guarantee about future releases.

`examples_and_inspiration/` contains the old BLOSM/SVG and footpath-cleanup
references, not runtime code. `scratchpad/`, `dist/`, local venvs, and downloaded
caches are ignored, machine-local evidence, not reproducible checked-in fixtures.
Do not make tests or runtime behavior depend on their incidental contents.

For development storage, use `TemporaryDirectory` for disposable test scenes
and outputs. Retain full `.blend` files only for requested inspection or a
specific regression baseline, using `compress=True`. Avoid backup copies for
disposable scripted scenes (set `save_version=0` only in isolated test processes,
never in the user's preferences). Keep short reports/screenshots instead of
whole experiment cache copies. Reuse immutable source downloads when safe;
keep mutable Refresh tests isolated. Review obsolete scratchpad experiments
after the investigation, preserving baselines explicitly; do not blanket-delete
existing scratchpad, autosaves, user scenes, exports, or installation rollback
copies. `.gitignore` does not limit disk use.
