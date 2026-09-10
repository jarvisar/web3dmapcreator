# Jarvizar City Model — shared agent context

Read [AGENTS.md](AGENTS.md) for development principles. This is shared context
for all coding agents. Implementation, configuration, and tests are authoritative.
Keep installation history, transient results, and fixed test/object counts out
of this document.

## Purpose, units, and defaults

The add-on turns a WGS84 selection into an FDM city miniature: terrain, land
surfaces, roads/rail, schematic bridges, trees, and building massing from
Overture Maps, with optional USGS LiDAR building measurements. Blender 3.6 is
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
| LiDAR | Opt-in; Prefer LiDAR on Conflicts enabled; detail width 0.1 mm / step 0.05 mm |
| Ponds / fountains | Recess enabled, depth 1.0 mm, water thickness 0.8 mm (0.2 mm below the lowest sampled bank) |
| Trees | Solid cones, minimum width 1.2 mm / height 2.0 mm after variation |

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
  `laspy[lazrs]==2.7.0`, `pyproj==3.7.2`, `shapely==2.1.2`, plus the downloader
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
uses a modal timer and an external worker in interactive Blender, with progress
and Esc cancellation. In background Blender, preparation waits synchronously.
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
5. Build draped land slabs, resolve category priority, and remove basin
   footprints. Build optional water fills. Generate roads/bridges with causeway
   registration before pier placement; subtract ground-road footprints from slabs.
6. Place trees using finished land/road caps. Generate source or prepared LiDAR
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
  parent beneath incomplete higher roof sections. Do not replace coverage rules
  with simple polygon intersection; legitimate annexes overlap complexes.
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
- Pond/fountain classification uses explicit source tags/class/subtype, never
  names or size. Polygon fountains can come from `infrastructure`; identities
  and identical basin outlines are deduplicated. Rivers/lakes/reservoirs retain
  their ordinary water policy. The 0.25 mm² surface floor still applies.
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
- Surface priority defaults to **paved > sand > rock > green > forest** and is
  scene configurable. `surface_priority.py` and pure `footprint_cut.py` remove
  full-thickness footprints while preserving slopes, holes, and materials.
  Ground-road cuts use 0.005 mm XY clearance and built road outlines to avoid
  huge cutter sets from refined caps. Elevated bridges retain land beneath them.
- Trees combine mapped `land` points and deterministic forest scatter, including
  satellite forest by default. They avoid open water and sit on actual built
  land/road caps. Keep solid cone bases; thin trunks with unsupported canopies
  defeat the printability purpose.

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
through the existing prism builder; raw point clouds never become Blender meshes.

- `lidar_acquisition.py` discovers EPT coverage and paginated USGS TNMAccess LPC
  LAZ products. An explicit EPT URL replaces automatic discovery; an optional
  manifest URL adds LAZ candidates. Manifest tile locations come from bounded
  LAS header/VLR/EVLR reads, never guessed filename coordinates.
- `lidar_metadata.py` reads bounded EPT JSON and linked JSON/FGDC survey reports
  before point acquisition. `lidar_ranking.py` prefers practical EPT unless
  known acquisition age, resolution, comparable accuracy or classification
  metadata establishes a material LAZ advantage. Threshold defaults and optional
  request overrides enter the acquisition signature. Unknown metadata retains
  EPT preference; project names/publication dates never become flight dates.
  Whole-building coverage determines local eligibility, then only unresolved
  buildings advance to fallback surveys. Successful buildings are not acquired
  again; `lidar_tiles.py` uses individual candidate footprints plus 30 m ground
  halos (25 m measurement neighborhood + 5 m guard) for both LAZ prefetch and
  reads, excluding empty space inside batch rectangles. Split batches retain
  this allowlist; the download wrapper rejects unplanned tiles.
  A rejected reconstruction is not itself a data gap: LAZ fallback requires
  failed EPT acquisition, missing ground/roof support, absent coverage, or a
  material metadata advantage. Use the preferred attempted EPT's evidence;
  a poorer secondary survey cannot reopen LAZ for a roof/footprint rejection.
  The fallback-policy signature invalidates public results independently of
  otherwise identical per-survey measurement checkpoints.
- `lidar_identity.py` compares scoped dataset/project metadata and known USGS
  project delivery/metadata directories, retaining subprojects and epochs.
  Never infer identity from tile names, generic titles or overlap. Conflicting
  acquisition periods/explicit editions prevent equivalence; missing identity
  remains unknown. LAZ copies of successfully read EPT surveys are redundant
  even after insufficient roof/ground support. Per-building coverage gaps,
  failed reads and empty EPT queries still permit same-survey delivery fallback.
  Identity and per-tile footprint/halo ownership/reasons are logged and audited.
- `lidar_ept.py` includes additive ancestor nodes as well as leaves.
  `lidar_laz.py` downloads intersecting staged tiles to disk and decodes chunks.
  Both normalize to WGS84 XY, metre Z, classifications/returns, and capture-age
  evidence. Reject missing CRS/unknown vertical units; distinguish international
  and survey feet. Catalog/publication/OSM edit dates are not flight dates.
- `lidar_batches.py` groups whole buildings spatially (400 m default), retaining
  roofs and a ground halo. Per-group limits can subdivide work; normal preparation
  has no whole-map byte/point/time cap, though per-request/file/group guards remain.
  LAZ transfers use `lidar_downloads.py` (default 4, allowed 1–16) while decoding
  and measurement stay sequential. EPT remains serial. Changing concurrency must
  not change measurement signatures or results. The UI passes the setting to
  interactive and background jobs.
- `lidar_measurements.py` fits ground-relative scalar heights, supported terraces,
  and `lidar_planes.py` roof planes within source footprints. Enforce sufficient
  ground/roof support, component-wise coverage, footprint consistency, and capture
  consistency. Coverage fallback uses actual clipped cell area at the same 85%
  threshold. Missing returns alone are not proof that a building is absent.
- Width/step controls filter measured detail; they cannot create survey resolution
  (roof sampling has a 1.5 m cell floor). Higher supported returns contribute to
  the mass beneath them. Reject materially incomplete envelopes rather than
  quietly retaining only a podium when a major tier fails.
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
  versions, effective XY/Z scales, detail settings, roof/conflict policy, and
  source URLs. Changes to those inputs require Prepare again. Audit both
  `data/lidar.py` and the worker's version checks when changing the contract.
- Completed groups live in `<bundle>/lidar_jobs`; reusable tiles live in
  `<cache-root>/lidar_tiles`. LAZ revisions enter tile and checkpoint keys.
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
| Water / supports | `blender_water_cut.py`, `blender_ground_support.py`, `blender_pond_basins.py`; cached `blender_water_cut_live.py`, `blender_coastline_live.py`, `blender_pond_basins_live.py` |
| Roads / surface ownership | `test_deck_graph.py`, `test_deck_mesh.py`, `test_bridge_supports.py`, `blender_short_bridges.py`, `blender_bridge_caps.py` (cached), `blender_road_cut.py`, `blender_surface_priority.py`, `blender_surface_priority_settings.py` and related live scripts |
| Buildings / LiDAR | Building/roof/duplicate tests and `test_lidar_*.py`; `blender_lidar.py`, `blender_lidar_minimum.py`, `blender_lidar_preference.py`, `blender_lidar_operator.py`; `blender_lidar_regression.py` for cached off/on mesh fingerprints |
| Export / trees / clipboard | `blender_export_cutout.py` and its live counterpart; `blender_tree_printability.py`; `test_projection.py` and windowed `blender_gui_paste.py` |

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
limited to buildings and their terrain supports. A render, closed-mesh audit,
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
