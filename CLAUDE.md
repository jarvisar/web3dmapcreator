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
| Ground surfaces | 0.4 mm rise, 0.15 mm embed; roads and ground-founded buildings use that embed too |
| Buildings | Height multiplier 1.1; minimum height 0.8 mm, gated by a 0.6 mm footprint setting |
| Source building detail | Minimum effective width 0.08 mm; slenderness limit 30 below 0.45 mm width |
| LiDAR | Opt-in; Prefer LiDAR on Conflicts enabled; automatic Roof Envelope; legacy Terraces width 0.1 mm / step 0.05 mm |
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
3. Lower terrain under ordinary water to solved water levels; construct the
   through-cut mask. Restore mapped deck and building footprints where the
   grid can resolve them. Ponds/fountains use a separate finite-depth path.
4. Build terrain and obtain its actual `bottom_z`. Apply basin recesses,
   extending the underside if necessary; register their floors on the field.
   Then build the optional rim and initialize `SupportBuilder` with that bottom.
5. Build draped land slabs, resolve category priority, and remove water
   footprints except supported paving. Build optional water fills. Generate roads/bridges with causeway
   registration before pier placement; subtract ground-road footprints from slabs.
6. Place trees directly on terrain. Generate source or prepared LiDAR
   buildings and their foundations. Emit accumulated `TERRAIN_SUPPORTS` last.
   Store counts on the staged root, validate ownership/attachment and finite mesh
   coordinates/placement, then publish the replacement and scene status/units.

Every generator samples the shared height field, **not the DEM directly**.
`is_void` conservatively marks whole shore cells; `in_cut_water` follows the
terrain cell's actual dry polygon. `over_open_water` additionally excludes
registered supports. Use exact queries for classification; `has_ground` is the
conservative foundation query. `ground_height_mm` uses surviving bank heights
over cuts so roads and deck anchors do not dip into a removed riverbed.

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
  failures retry `planar.ear_clip`; rejected geometry is counted.
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
  wastes material/color changes and does not fix their cause.

Buildings/parts and trees merge by default; roads and slabs batch by category.
Use `merge_buildings_and_trees=False` for per-building source IDs, height/roof
decisions, and foundation metadata; merged buildings retain material slots but
no per-building metadata. Generation updates shared `JCM_*` viewport and shader
colors, overwriting manual palette edits.

### Buildings and roofs

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
- **Keep Main Bodies with Sparse Parts** defaults on in scene settings and
  additionally retains a grounded parent with a height or floor count when all
  mapped parts cover less than 25% of its footprint. Small lower setbacks may
  be filled intentionally. Parent holes stay open; any holes in parts, or a
  disconnected parent footprint, disable this extra fallback. Heightless parts
  count toward coverage. Turning it off restores the prior selection policy.
  Low-level selection/generation helpers default to the prior policy; the operator
  passes the scene setting explicitly. No new geometry or height inference is used.

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
- `basins.py` uses Exact Boolean on temporary terrain, checking closure and
  requested floors with rays before committing. Connected parts share the lowest
  bank reference; overlaps with other water types are skipped/counted. Floors
  enter height queries, not `void_mask`. Slabs drape on original ground before
  basin subtraction. Disabling basin mode restores ordinary water handling.
- `WaterMask` composes scanline unions/differences before choosing grid-edge
  crossings. Terrain is closed from its built top boundary and matching bottom.
  Only slabs reaching open water use grid clipping, with `prefer_dry_end=True`;
  routing all slabs through the grid would erase small gardens and pitches.
- `data/land.py` uses category allowlists and rejects regional land/scatter
  polygons whose uncut extent-area exceeds 8× the selection. A marina is a
  facility extent, not a deck: only physical pier/quay/dam/etc. footprints restore
  ground. Sub-cell structures need exact support solids, not wider water masks.
- `SupportBuilder` emits terrain-colored pedestals/causeways from terrain bottom
  to 0.05 mm below the field. It checks outline/interior, deduplicates footprints,
  and registers usable ground even without a new solid; pier queries need that.
  With ground support enabled, structures over recessed basins use a shallow
  height-field view without basin floors, retaining the pre-recess grade.
  Exact cap overlap selects supports under built road footprints and building
  footprints, including sub-cell shoreline overlaps and enclosed basins. The
  physical field retains its floors; basin islands and courtyards remain open.
  Non-bridge foundations have a footprint-wide minimum grade that puts their
  tops at least 0.2 mm above retained water; buildings and roads use that same
  grade, preserving their thickness/heights. Bridge causeways keep the existing
  field-relative top. Paving alone among land-cover categories retains supports:
  build these from surviving caps after category priority, and share their grade
  with later roads/buildings. Never restore forest, green, sand, or rock footprints.
- `cut_water_land_surfaces` removes every validated water footprint from all
  land-cover slabs, including forest/green, sand and rock. Paving is preserved
  on foundations when ground supports are enabled; otherwise it is cut too. It applies
  to ordinary water below the terrain-cut threshold as well as recessed
  basins, and retains island holes and full slab thickness outside the cut.
  Water-fill visibility does not control these exclusions. Structure supports
  and road/building geometry keep their separate ownership.
- Surface priority defaults to **paved > sand > rock > green > forest** and is
  scene configurable. `surface_priority.py` and pure `footprint_cut.py` remove
  full-thickness footprints while preserving slopes, holes, and materials.
  Ground-road cuts use 0.005 mm XY clearance and built road outlines to avoid
  huge cutter sets from refined caps. Elevated bridges retain land beneath them.
- Trees combine mapped `land` points and deterministic forest scatter, including
  satellite forest by default. They avoid open water and embed their broad bases
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
  1–16; 1 is serial) while decoding and measurement stay sequential. EPT
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
  Print/roof-detail changes reuse scalar
  measurements; switching modes requires Prepare again with Refresh off. Downloads
  and point decoding are unchanged; savings come from coarser sampling and skipping
  reconstruction. Keep full-mode cache signatures/results unchanged.
  Missing returns alone are not proof that a building is absent.
- Planar ground fits retain their original result. When the plane fails,
  `lidar_ground.py` can retain a low ground-cell anchor with its actual location:
  at least eight 4 m cells, three returns per cell, enclosing the full footprint.
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
  a high upper quantile of the returns in each cell, then a moving median over
  a print-scale window, then propagation across unobserved cells. Unobserved
  cells never vote in the median, so a courtyard or the gap between separate
  components cannot drag a roof edge across it.
  **The rank filter is not interchangeable with morphology.** On a near-vertical
  facade an opening or closing by any flat element is the identity, because the
  slope dominates every neighbourhood, so dilation, erosion and relaxation
  passes cannot remove cross-slope detail at all; a rank filter is unaffected by
  slope. That is why the earlier relaxed height sheet left vertical ribs.
  Grid cells merge into larger blocks only where the returns really are coplanar
  within a fraction of a printed layer, and the block grid is kept two-to-one
  balanced so the cap has no cracks. Every block corner is a raster node, so
  simplification changes the face count and never the surface. At the default
  scale the raster pitch is 1 m and the rank window is twice the pitch. The
  pitch fixes the plan resolution of the building, so coarsening it turns a
  drum or a curved facade into blocks: it is a last resort for an outline too
  large to describe at print scale within the record budget at all, not the
  ordinary path. A cap costs roughly one face per cell; adaptive triangulation
  does not change that materially, because measured roofs carry relief
  everywhere. Spend faces, not plan resolution.
- The default path no longer calls the `lidar_surface_*` region, primitive,
  outline or plane-stitching stack, including its compatibility fallbacks.
  Those modules remain as historical helper implementations/tests. Entirely
  planar roofs can suppress bounded noise; local boundary extrapolation can
  continue a supported slope. Neither owns independent architectural regions.
  An envelope failure can retain complete legacy terraces/heights, never a
  partial roof. Terraces and disabled roof generation retain their existing path.
- An envelope publishes `roof_mesh`, one shared vertex table plus integer
  faces, tagged `surface_reconstruction=roof_envelope`, with up to 16,384
  faces. Its faces meet at common corners, so a polygon per face repeated
  every corner about six times and the GeoJSON wrapper once per face: measured
  on downtown buildings that was 238 bytes a face against 42, on disk and again
  in the reader's memory. `lidar_records.envelope_mesh`/`envelope_rings` pack
  and unpack it without moving a coordinate; `roof_faces`/`has_roof_surface`
  read either encoding, and the loose `roof_surfaces` list remains valid for
  every other reconstruction and for records written before algorithm 16.
  A block wholly inside the outline stays one face; only blocks the outline
  crosses are cut into triangles. Published coordinates are rounded to about a
  centimetre. The reader's `lidar_buildings.json` guard is 512 MB; with the
  packed mesh a dense downtown selection lands well inside it even at the
  larger budget, but a raised budget still has to be checked against that file
  size, not only against appearance. In Blender,
  `geometry/lidar_envelope.py` joins their shared cap topology and adds only
  exterior/courtyard walls and a base. The existing terrain-seated foundation
  overlaps this upper solid slightly. Conform clipping-induced edge splits;
  verify area, closure and winding before adoption. A join failure must retain
  source geometry rather than extruding thousands of independent fragments.
- The saved `FACETED` enum now displays **Roof Envelope**. Legacy width/step
  sliders remain Terraces-only. Algorithm 17 requires Prepare again with
  Refresh off; it reuses cached tiles and normalized points, because the
  acquisition version is unchanged, and re-runs measurement only. Acquisition version 5 reads every octree level the survey
  actually has (`resolution_m` 0.35, which for the Cook County EPT is its
  deepest level) and retains classes 1-6 rather than 1/2/6: automated
  classifiers file much of an articulated or glazed facade under a vegetation
  class, and on the Chicago towers that is most of the facade. Those returns
  never establish coverage, ground or height; reconstruction admits them only
  where the structural envelope already reaches that level, so a real canopy
  cannot lift a roof. Cached tiles are reused; normalized point batches and
  measurements are re-read because their contents changed. See
  [LiDAR reconstruction](docs/LIDAR_BUILDINGS.md) for behavior and limits.
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
  derived data. No arbitrary cross-bbox point stitching or automatic eviction.
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

`jarvizar.export_3mf` requires separately installed/enabled `io_mesh_3mf`. It
parents temporary copies under one holder and compensates for the writer's
scene/display-unit scaling. Preserve **one build item with material-bearing
parts**, world placement, selection, and active object; Bambu can rearrange
independent build items. For STL, export with **Scene Unit unchecked** and
import at 100% to retain model millimetres.

Export annotation maps each writer mesh's exact `Title` to the source's semantic
tags, then writes core object names and Bambu `Metadata/model_settings.config`
names keyed by assembly/component resource IDs. The result is `Map` with named
normal Parts, preserving existing batches, transforms and standard material
conversion. Base-material colors are also mirrored into Materials-extension
`m:colorgroup` resources, with property references retargeted and face indices
preserved, because Bambu reads color groups rather than base-material colors.
Do not use a Bambu application identity or assign extruders merely
to label standard single-plate parts. Publication is atomic after annotation succeeds. See
[3MF naming and verification](docs/EXPORT_3MF.md); `tests/bambu_export_names.py`
optionally verifies import/save/reopen through installed Bambu Studio.

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
It requires a cutout, runs the unchanged final crop first, then uses
`data/export_sections.py` and `export_cutout.export_section` to partition in
world X/Y (east/north), with shared edges and one common float32 tolerance.
The 210 mm width/height maxima are configurable up to 256 mm. A grid exceeding
Bambu's 36-plate limit fails; empty cells are omitted. Section evaluation is
baked into temporary world-space meshes and processed one section at a time
through the same shell cutter, writer, and semantic naming path. Only this
partition pass discards zero-volume tangent remnants.

`data/export_plates.py` combines those staged archives into a native unsliced
Bambu project, with one multipart assembly per plate, row/column names, the
256 mm bed/20% spacing layout, and a common Z datum. This mode requires Bambu's
Application prefix to retain project settings; generator metadata identifies
Jarvizar. Native part extruders, face paint, and a shared filament palette
replace standard color-group import. The small project config starts with
P1S 0.4 mm / Generic PLA and Bambu's default purge matrix; users choose their
actual printer/materials before slicing. It does not copy the example project's
personal settings. Verify with `blender_export_plates.py`,
`test_export_sections.py`, and installed Bambu `bambu_export_plates.py`;
the live crop script accepts `--multi-plate` and section size options.

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
| Roads / surface ownership | `test_deck_graph.py`, `test_deck_mesh.py`, `test_bridge_supports.py`, `blender_short_bridges.py`, `blender_bridge_caps.py` (cached), `blender_road_cut.py`, `blender_surface_priority.py`, `blender_surface_priority_settings.py` and related live scripts |
| Buildings / LiDAR | Building/roof/duplicate tests and `test_lidar_*.py`; `blender_lidar.py`, `blender_lidar_envelope.py`, `blender_lidar_facets.py`, `blender_lidar_minimum.py`, `blender_lidar_preference.py`, `blender_lidar_operator.py`; `blender_lidar_regression.py` for cached off/on mesh fingerprints |
| Anchored LiDAR / mapped rock | `test_lidar_relief.py`, `test_lidar_offer.py`, `blender_lidar_relief.py`; verify anchor alignment, class/coverage rejection, transactional fallback, source suppression, and unchanged disabled-LiDAR mesh fingerprints |
| Export / trees / clipboard | `blender_export_cutout.py` and its live counterpart; `blender_tree_printability.py`, `blender_tree_road_clearance.py`; `test_projection.py` and windowed `blender_gui_paste.py` |

For geometry work, compare identical inputs/settings, check closure **and winding**,
then inspect focused renders and seating/overlap probes. `render_preview.py`
supports `--water 0`, `--target x,y`, `--span mm`; `blender_embed_probe.py` is
diagnostic, not a correctness verdict. Regressions cover Cincinnati roofs/bridges,
Chicago massing/water, Clearwater/San Francisco coastlines, and large surface-cut
workloads. These are fixtures, never reasons for location-specific code.

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

After add-on changes and relevant passing checks, follow
[install-addon](.claude/commands/install-addon.md) to update Blender's installed
copy and verify it against the built archive. A documentation-only change outside
the packaged add-on does not require rebuilding/reinstalling identical code.
Blender must be closed before replacing loaded files or saving preferences in
another process. Never force-close an unsaved user session without permission.

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
