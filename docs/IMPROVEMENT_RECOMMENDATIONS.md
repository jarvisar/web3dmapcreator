# High-impact improvement recommendations

Reviewed against commit `84047c1` (`0.15.3`) on 2026-09-09. These are proposals
except where an implementation status is recorded below. Recheck the relevant code before starting a future
session. Follow [the shared development context](../CLAUDE.md) and preserve the
project's default-scale FDM behavior, existing successful geometry, and general
solutions rather than location-specific exceptions.

## Priorities

Rank reflects expected overall value, not necessarily implementation order.
Effort is relative; larger items should be delivered in bounded stages.

| Rank | Improvement | Main benefit | Effort |
| --- | --- | --- | --- |
| 1 | Transactional generation, then responsive cancellation | Protect existing work and recover from failures | Medium, then large |
| 2 | Reduce surface fragmentation and repeated footprint reconstruction | Smaller meshes, faster generation/export/slicing | Large; profile first |
| 3 | Reproducible regression and benchmark runner | Safer changes across interacting geometry systems | Medium |
| 4 | Correct polygon clipping across buildings and land | Preserve courtyards, holes, and disconnected crop results | Medium–large |
| 5 | Preflight the final printable assembly | Catch unsupported or fragile geometry before printing | Medium–large |
| 6 | Bound LiDAR results with a shared producer/consumer contract | Prevent expensive preparation producing unusable results | Medium |
| 7 | Consistent, reproducible source-cache snapshots | Prevent mixed releases and ambiguous cached inputs | Medium |
| 8 | Avoid repeated full-tile LAZ decoding | Reduce processing time after downloads are cached | Medium–large; profile first |
| 9 | Preserve feature provenance through merged output | Make geometry and source-selection problems diagnosable | Medium |
| 10 | Improve transportation connectivity and local crossing constraints | More faithful, less unnecessarily elevated bridges | Large; targeted cases first |

## 1. Make regeneration transactional before adding cancellation

**Implementation status (`0.15.4`):** the transactional first step is implemented
in `blender/generation.py`. Generation retains previous output, builds owned
staging collections and material copies, validates them, then publishes scene
results and removes the previous hierarchy. Failed runs restore the prior model,
shared material users, scene units, LiDAR status, and selection; the status text
reports the error. User helpers and reused meshes survive cleanup. The offline
`tests/blender_generation_transaction.py` exercises phase/publication failures,
retries, invalid geometry, and ownership/name collisions.

**Responsive generation (`0.15.5`):** interactive generation now runs the existing
pipeline in an isolated background Blender process with visible phase progress
and Esc/Cancel. The foreground retains the previous model until a validated
result is appended and committed; imported ID ownership is sealed before any
modal yield. Cancellation can stop a worker inside long geometry operations,
and cleanup waits for confirmed worker exit. Tests cover each worker phase,
foreground import/cancellation, failure, retry, and actual windowed event handling.
Library append, final validation, and publication remain synchronous foreground
operations; cancellation queued while appending is processed before commit.
Overture/DEM download cancellation remains separate follow-up work. The confirmed
gap below describes the reviewed `0.15.3` baseline.

**Confirmed gap.** In [`operators.py`](../jarvizar_city_model/operators.py),
`JARVIZAR_OT_generate_model.execute` clears the existing generated model before
constructing its replacement. A later failure clears the partial replacement;
there is no explicit transaction preserving the previous successful model.
Blender undo support does not provide the same failure guarantee. Generation
and Overture/DEM download operations also run synchronously through long work.

**First step:** build into an explicitly owned staging hierarchy, validate it,
then replace the previous hierarchy only after success. Account for shared
materials, scene properties, selection, and active-object changes as well as
meshes. [`collections.py`](../jarvizar_city_model/blender/collections.py) currently
uses the exact `CITY_MODEL` root name and a generated tag; staging cleanup must
use ownership references rather than assuming the normal name-based cleanup
will find temporary output.

Next, introduce cancellable phase boundaries and visible phase progress. Reuse
the LiDAR operator's external-worker lifecycle where appropriate. Independent
data preparation can run in a worker process; keep Blender data operations on
the main thread, consistent with [Blender's threading guidance](https://docs.blender.org/api/main/info_gotchas_threading.html).
Large individual geometry phases may need chunking before the interface becomes
responsive throughout.

**Acceptance:** injected failures and cancellation at each phase preserve the
previous model and user-owned objects, leave no staging debris, and permit a
successful retry. A successful run produces equivalent geometry. Measure the
extra peak memory from retaining both models during construction.

## 2. Reduce surface fragmentation and geometry-to-footprint round trips

**Confirmed complexity; performance gains need measurement.**
[`surface_priority.py`](../jarvizar_city_model/geometry/surface_priority.py),
[`footprint_cut.py`](../jarvizar_city_model/geometry/footprint_cut.py), and
[`basins.py`](../jarvizar_city_model/geometry/basins.py) repeatedly interpret
generated mesh caps/walls as planar footprints, subtract overlaps, and emit
closed fragment solids. Later cuts process those fragments again.

The preceding audit's cached Cincinnati run generated 2,256,320 polygons,
including 1,174,330 in land surfaces alone, in approximately 63 seconds.
Those are a historical baseline, not a fresh benchmark of `84047c1`, and face
counts do not establish which phase consumes the most CPU time.

**First step:** add per-phase timing, face/fragment counts, and memory
measurements to a repeatable benchmark. Then retain the *accepted, emitted*
road footprints at construction time, avoiding their reconstruction from
walls. Preserve unchanged surface regions without fragmenting them further.
If measurements justify it, retain height-aware planar regions through related
cuts and solidify later, initially for one surface category.

Preserve holes, category priority, terrain draping, slab thickness, clearances,
and material assignments. Do not replace this with global decimation, blanket
vertex welding, or a Boolean over the entire city. Independent closed feature
shells are intentional.

**Acceptance:** compare identical cached inputs and settings; report generation,
export and slicer time, peak memory, and polygon counts. Check silhouettes,
terrain contact and watertightness within a declared print-space tolerance,
especially sloped terrain, ponds, overlapping land categories, and road edges.

## 3. Turn the existing tests into a reproducible validation workflow

**Confirmed maintenance gap.** The repository has substantial pure-Python and
Blender coverage, but verification depends on separate scripts, environment
setup, and live/cached data. Some live scripts assume a particular dense city
and feature counts. There is no checked-in CI workflow providing one consistent
release gate.

A concrete example is [`blender_live_smoke.py`](../tests/blender_live_smoke.py):
its building-only setup leaves the default pond/fountain recess option enabled,
which introduces a water-cache requirement. This failed in the preceding audit
even though the intended fixture did not exercise water. This is a fixture
configuration problem, not evidence that the entire test suite is broken.

**First step:** provide one documented runner for pure tests and deterministic
Blender smoke/regression tests, explicitly setting all relevant scene options.
Check in small, redistributable synthetic or reduced fixtures for critical
failure shapes; keep network/live-city checks as a separate tier. Convert
diagnostic probes into assertions where they are meant to be release gates.
Record phase timings and geometry counts without brittle machine-specific time
thresholds.

Add CI for the deterministic tier and an isolated packaged-add-on smoke test.
Exercise the actual supported `io_mesh_3mf` exporter in an integration tier;
mocked writer tests cannot verify the final file's units, material assignments,
or single-assembly structure. Record tested Blender/exporter combinations.

**Acceptance:** a fresh checkout can run the deterministic tier without personal
caches or network data. Failures return nonzero status and identify the fixture,
settings and phase. The installed/package import path is tested independently
of imports from the repository.

## 4. Give polygon cropping a shared, topology-correct contract

**Confirmed implementation limitation.**
`projected_polygon_rings` in
[`mesh_utils.py`](../jarvizar_city_model/blender/mesh_utils.py) clips the exterior
ring and retains only holes entirely inside the crop rectangle. A courtyard
crossing the boundary can therefore disappear instead of becoming a boundary
notch. Ring-by-ring clipping also lacks a general representation for a crop
splitting one polygon into multiple disconnected polygons.

[`water_geometry.py`](../jarvizar_city_model/geometry/water_geometry.py) already
handles whole polygons, holes, notches and disconnected crop results. Its
approach and regression cases are useful groundwork, although its invalid-data
policy should not automatically be imposed on every other feature type.

**First step:** define a pure polygon-clipping result that returns zero or more
valid polygons with holes. Adapt building and land consumers incrementally,
including associated source/LiDAR outlines where they use the affected path.
Keep projection, invalid-input handling, and height assignment explicit.

**Acceptance:** include boundary-crossing courtyards, U-shaped outlines that
split, multipolygons, collinear/repeated vertices, and tiny clipped pieces.
Interior geometry should remain equivalent. Check the footprint itself as well
as manifoldness: a closed mesh can still have the wrong outline.

## 5. Validate the final FDM assembly, not only individual closed meshes

**Opportunity beyond existing checks.** Closed edge topology is valuable, but
does not establish that a part is supported, attached to the base, thick enough,
or robust after slicing. Elevated building portions, road ends over cut terrain,
bridge connections, and export crops can all change physical support. The
existing support and embedding logic should remain the starting point.

**First step:** add an optional, non-destructive preflight of final output in
millimetres at the configured scale. Report potentially unsupported islands,
insufficient contact/embedding, thin surviving walls or bases, and problematic
intersections. Distinguish intentional separate parts, such as water inserts,
from accidentally floating solids. Run equivalent checks on final cropped
export copies, since cropping can remove an otherwise valid support.

Use [`support.py`](../jarvizar_city_model/geometry/support.py),
[`export_cutout.py`](../jarvizar_city_model/blender/export_cutout.py), and the
existing ground-support, bridge, tree and export tests as entry points. Keep
checks advisory until validated; do not automatically union every shell or
invent supports that obscure meaningful geometry.

**Acceptance:** known unsupported fixtures are identified with useful locations;
valid overlapping closed-shell assemblies remain accepted. Validate a small
set of exported fixtures in the target slicer and, where practical, print
calibration coupons for roads, bridge contacts, minimum buildings and recesses.
Use the default output scale as the baseline; do not silently fit models to a
build plate or change print dimensions.

## 6. Make the LiDAR result contract scalable and consistent

**Confirmed mismatch; oversized-output failure not reproduced here.**
[`data/lidar.py`](../jarvizar_city_model/data/lidar.py) rejects measurement files
over 32 MiB and loads/validates the full JSON result. The preparation worker in
[`download_lidar.py`](../jarvizar_city_model/external/download_lidar.py) validates
record structure but has no corresponding final serialized-size gate. Results
also contain substantial selection/audit data. A sufficiently large successful
preparation can therefore publish data the Blender consumer refuses to use.

**First step:** share the publication contract, including size checks, between
producer and consumer. Fail explicitly before replacing a usable result if the
new result cannot be consumed. Expose the reason instead of leaving users to
infer it from missing LiDAR geometry.

Then separate compact geometry-driving records from detailed audit data. If
needed, introduce a versioned manifest and bounded chunks indexed by building
ID, loading only required records. Keep whole-building acceptance atomic and
retain the existing atomic publication/checkpoint protections. Simply raising
the limit leaves unbounded memory and duplicated audit data unresolved.

**Acceptance:** test an output crossing the current size limit, interrupted
publication, corrupt chunks, schema mismatch, and source-geometry fallback.
Preparation and Blender loading must agree on success and consume bounded
memory without silently accepting incomplete building envelopes.

## 7. Make source caches consistent and reproducible across updates

**Confirmed design gaps.**
[`download_overture.py`](../jarvizar_city_model/external/download_overture.py)
resolves the latest release on invocation. Downloading only missing layers can
mix release dates in one bundle; the bundle's single release field does not
fully describe that provenance. In
[`data/overture.py`](../jarvizar_city_model/data/overture.py), files are staged
and replaced individually, then the manifest is updated: each replacement is
atomic, but the complete bundle update is not. An interruption can leave mixed
old/new files.

In [`cache.py`](../jarvizar_city_model/data/cache.py), DEM availability primarily
checks file presence. The cache contract could better distinguish the source
grid's acquisition parameters from the requested generation resolution.

**First step:** record effective release, input parameters and content hashes
per layer. Either pin missing-layer downloads to the bundle's existing release
or make mixed provenance explicit. Publish a completed staged snapshot through
an atomic manifest/pointer change, with a defined recovery path for interrupted
updates. Keep this file-based; it does not require a database service.

Distinguish reusable raw DEM data from settings requiring resampling or a new
acquisition. Do not redownload merely because a display/generation grid changes.

**Acceptance:** simulate interruption between publication steps, adding a layer
after the upstream release changes, stale/missing content, and changed DEM
parameters. A saved run manifest should identify the actual inputs well enough
to reproduce geometry and invalidate only dependent derived results.

## 8. Profile and eliminate repeated LAZ decoding across adjacent batches

**Verified access pattern; impact is a hypothesis.**
[`download_lidar.py`](../jarvizar_city_model/external/download_lidar.py) processes
spatial batches and calls the reader for each uncached batch.
[`lidar_laz.py`](../jarvizar_city_model/external/lidar_laz.py) streams intersecting
LAZ tiles in chunks, filtering points to the batch query. Adjacent 400 m batches
can intersect the same larger tile and decode its full compressed contents
repeatedly. The transfer cache avoids downloading again, not decoding again.

**First step:** measure tile decode counts, points scanned versus retained,
decompression/normalization time, and peak memory on a cached multi-batch crop.
If material, normalize each tile once into a bounded spatially partitioned
intermediate, or group queries to share a tile pass. Preserve complete-building
batches and ground halos.

Key reusable point data by source identity/revision and normalization format;
keep surveys separate. Print-scale roof filtering can then change without
unnecessarily decoding raw data again, while measurements still invalidate for
settings that actually affect their geometry. Use bounded memory or disk spill,
not an all-surveys in-memory point cloud.

**Acceptance:** benchmark first and repeated preparation, several crop sizes,
and overlapping surveys. Compare selected measurements and massing with the
current implementation. Do not add parallel decoders until profiling and the
memory budget justify them.

## 9. Carry per-feature provenance into merged models and diagnostics

**Confirmed usability gap.** Merged building output is efficient but loses the
easy per-object source inspection available with unmerged output. LiDAR already
records rich selection decisions and alternatives; these are not readily tied
to a selected building in the merged Blender mesh. Summary counters alone make
it hard to explain a wrong roof, rejected observation, or source fallback.

**First step:** preserve a stable feature ID through generation into a compact
sidecar mapping, with an optional face-domain integer attribute for selection
lookup. Blender 3.6 exposes mesh attributes through
[`Mesh.attributes`](https://docs.blender.org/api/3.6/bpy.types.Mesh.html).
Verify ID propagation across triangulation, cuts and export copies; generated
support faces need an explicit association or an unknown marker.

Add an inspector showing footprint source, chosen height/roof basis, survey and
capture date, quality/rejection reasons, and fallback behavior. Reuse the
existing records in
[`lidar_selection.py`](../jarvizar_city_model/external/lidar_selection.py) and
[`lidar_records.py`](../jarvizar_city_model/external/lidar_records.py), exposing
rejected alternatives or outlines only on demand.

**Acceptance:** selecting a problematic merged building identifies its source
and final decision without regenerating an entire city unmerged. Keep footprint
identity authoritative, preserve the current LiDAR preference semantics, and
distinguish final per-building outcomes from cumulative survey observations.
Diagnostics should explain conservative rejection rather than encourage global
threshold relaxation.

## 10. Refine transportation connectivity and crossing constraints locally

**Opportunity with substantial regression risk.** Transportation connectors are
downloaded, but generation primarily consumes segment features. The existing
bridge graph already handles whole-network grading and includes specialized
short-bridge handling. Some general road-clearance decisions remain based on
proximity/component-level constraints, which can lift more of a network than a
real local crossing requires.

**First step:** reproduce an unnecessarily elevated or incorrectly connected
network with a small fixture. Use actual segment crossings and compatible
level/structure metadata to place local clearance constraints, feeding them
into the existing component solver. Evaluate connector IDs as an additional
connectivity signal where present, with the current geometric fallback for
missing or clipped topology.

Entry points: [`linework.py`](../jarvizar_city_model/data/linework.py),
[`bridge_network.py`](../jarvizar_city_model/geometry/bridge_network.py), and
[`deck_graph.py`](../jarvizar_city_model/geometry/deck_graph.py).
Do not infer a junction simply from coincident XY coordinates: grade-separated
roads must remain separate, and a connector is not itself evidence of a
physical crossing needing clearance.

**Acceptance:** cover parallel roads beside footbridges, true road crossings,
forks, mixed levels, clipped bridge ends, and missing connector data. Preserve
grade limits, deck contact, water clearance, support placement, and current
short-bridge regressions. Do not replace the graph solver with per-segment lifts.

## Where complexity appears excessive—and where it is justified

- **Strongest simplification candidate: repeated footprint reconstruction.**
  Inferring planar meaning from cap triangles and wall layouts, then rebuilding
  solids repeatedly, creates extra geometry and brittle representation
  assumptions. Recommendation 2 addresses this through a bounded shared
  representation, not a new city-wide geometry framework.
- **Decision and diagnostic plumbing warrants consolidation.** LiDAR acquisition,
  survey selection, record validation and Blender generation each need different
  checks, but their outcomes are difficult to follow across boundaries. A small
  explicit decision/provenance record would help recommendations 6 and 9. Do not
  collapse distinct quality gates into one policy function or add a generic
  rule engine merely to reduce module count.
- **Keep the external native-dependency boundary.** The separate downloader
  environment protects Blender from heavy dependency and runtime conflicts.
  The current LiDAR transfer resume, validation, checkpoints, cache locking and
  worker cleanup solve real reliability problems; they are not missing features
  or obvious candidates for removal.
- **Keep the shared height field and bridge component solver.** They coordinate
  interacting geometry and avoid inconsistent terrain sampling or independently
  raised bridge segments. Reduce repeated computations around them before
  attempting replacements.
- **Keep independent closed shells and careful crop/export handling.** Avoiding
  accidental welding, preserving nested holes, and exporting a single assembly
  require real complexity. A universal Boolean/repair pass or custom 3MF writer
  would add risk without an established benefit.

## Suggested implementation order

Start with the deterministic runner and benchmark fixtures from **3**, then
transactional replacement from **1**. Profile **2** and **8** on those fixtures
before selecting an optimization. The bounded contract fix in **6** and crop
correctness in **4** are good independent, targeted follow-ups. Build **5** and
**9** incrementally around existing output and records; tackle **10** only with
a concrete failing fixture. Each implementation session should select one
bounded slice, record before/after evidence, and run the related regressions.
