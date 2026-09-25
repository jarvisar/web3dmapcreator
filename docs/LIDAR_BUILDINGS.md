# Building heights and USGS LiDAR

## Edge collapse: walls from the returns alone (algorithm 21, 0.24.0)

Run **Prepare LiDAR Buildings** with Refresh off, then **Generate Model**;
only measurement re-runs (cached tiles and normalized points are reused).

The goal was the look of a decimated survey model (Micropolitan's Chicago):
large flat walls, a curved tower as a coherent fan of facets, a flared base
as a smooth slope, crisp roof rims, rooftop plant kept, no vertical ribs. The
tiers of algorithm 20, a facade-tracing experiment and a plain
DSM-plus-Blender-Decimate test all fell short; the record of those is in
`scratchpad/lidar_wall_tracing/HANDOFF.md` (git-ignored).

What works is simpler. The height raster is built as before (upper quantile
per cell, disc median, light mean away from walls) but unobserved cells now
copy their nearest observed neighbour instead of being relaxed across: the
band beside a facade, where a cell holds returns from the whole height of
the wall, becomes a step rather than a ramp of uneven heights. Returns are
**not** filtered: a "shadow" rule (drop a return with a return 3 m higher
within 1 m) removed Chase Tower's flared base (a 7:1 to 15:1 slope) and kept
only a fifth of some towers' returns, and no threshold separated a flare
from a facade. The raster is triangulated on its grid, each cell split along
the diagonal of most similar corner heights, and then
`external/lidar_simplify.py` collapses edges by quadric error until every
remaining edge would cost more than `COLLAPSE_TOLERANCE` × pitch² (32 cells²,
8 m² at 0.5 m), and beyond that while the cap exceeds its face budget. The
error is memoryless (priced against the current local faces, Lindstrom &
Turk): with accumulated quadrics a straight facet remembers every stair it
replaced and its cost grows with the cube of the stairs it spans, so walls
stopped merging at about a metre at every threshold, which is why Blender's
Decimate never straightened them. Ties in flat regions break by edge length,
a collapse never flips or flattens a face in plan, never brings two vertices
within a centimetre in plan, never moves the mesh rim, and never leaves a
vertex further than two cells from any face it replaces (without that bound
a small plant room is lowered corner by corner once its top is one face).
The collapsed faces are clipped to the footprint and published as one cap;
Blender joins it into one solid with walls along the footprint.

Measured on the Chicago towers at the 0.5 m grid (71 South Wacker, CME,
Chase, UBS, One North LaSalle, 111 South Wacker): 71 South Wacker collapses
from about 41,000 grid faces to about 900, its wall facets change azimuth by
0° median and 6° at the 90th percentile between neighbours (the reference
model: 5.3 m facets, 2.7°), the CME notches survive, Chase's flare is a
broad sloped surface. The pitch is now half a printed layer (0.035 mm per
cell), so the default scale grids Chicago at 0.5 m where a cell averages at
least one upper-surface return; faces are cheap after the collapse, so plan
resolution is spent freely.

Removed with this change: tiers, traced outlines, `_labels`/`_outline`,
block merging (`_levels`/`_coplanar`), the pitch-coarsening retry, the
`outlines` in packed meshes and the per-tier Blender join. Records written
by algorithm 20 are stale and re-measured.

### What the first city run found (same day)

Generating downtown Chicago from the first algorithm 21 re-measure gave 155
geometry fallbacks against 13 for algorithm 20. Every one had a mechanical
cause in the hand-off between the worker and the Blender join, none in the
collapse itself:

- **77 "nonplanar measured roof".** The builder refitted a plane through
  three corners of each clipped face and rejected the face when a fourth
  corner was 2 cm off. A clipped piece of a wall facet a few decimetres wide
  and a hundred metres tall, with its published corners rounded to nine
  decimals in degrees, misses that by construction. The cap faces now carry
  their own vertex heights through the crop clip (`clip_cap`); no plane is
  refitted.
- **7 "boundary edge not on the outline".** The join allowed a cap corner
  to sit three float32 ulps off the outline. Near the model centre that
  floor is a few millionths of a millimetre, less than the nine-decimal
  rounding of the record. The join takes a `precision` (a millimetre on
  the ground at the print scale) as the floor of that test.
- **6 pinched boundaries.** A footprint edge lying a hair inside a grid
  line clipped a whole row of faces into slivers thinner than float32
  holds at print scale (Canal Station: 110 of them); the join dropped them
  and found a hole. Collapsed vertices within a quarter of the 1 cm vertex
  gap of the footprint boundary are now snapped onto it before clipping,
  and the collapse refuses a face thinner than that gap, so no clipped
  piece is thinner than float32 can represent. Welding in the join was
  rejected: vertex pairs 2 mm apart in plan can differ by 40 m in height
  on a wall that the collapse legitimately made a few millimetres wide.

Re-measuring those 92 buildings with the fixed worker left none failing.
The other 67 fallbacks of that run were stale algorithm 20 records that the
scratch re-measure keeps when a building's points are missing; a real
Prepare does not produce them. The full re-measure with the final worker
generated 942 LiDAR buildings with 608 K roof faces in 104 s, against 991
buildings with 2.88 M faces for algorithm 20; its 66 fallbacks were those
stale records plus two ordinary width rejections, none from the envelope.

### A stadium on the riverbank (algorithm 22, 0.24.1)

Paycor Stadium in Cincinnati kept its source box. Both Kentucky surveys
rejected it with `insufficient_ground`, and the Ohio statewide tiles never
covered its ground halo across the river. Replaying the ground tests on the
cached points showed why: the ground around it spans 146–155 m (river bank,
elevated plaza and ramps), so the planar fit's residual is 2 m against a
1 m limit, and the anchor fallback required the hull of the surrounding
ground cells to enclose the whole footprint, while 2.3% of the stadium lies
beyond it on the water side. The 946 ground cells sat in all eight
directions around the building. With that ground accepted, the open field
did not trip the ground-in-footprint check and the envelope fitted with
5,538 faces up to 60 m above its base. The anchor now requires the hull to
cover the representative point and nine tenths of the footprint area
(`ANCHOR_COVERAGE`); ground on one side, or over half of a footprint, is
still rejected. The algorithm version is 22 so Prepare re-measures.

### Rim teeth and scan shadows

The podium of 71 South Wacker showed vertical "teeth" along its outline
wall. Profiling the cap along the outline showed isolated 5–14 m dips in
the outermost half metre only, about ten per hundred metres, and dumping
the raster showed why: in the scan shadow of the tower the low roof has
almost no returns, a stray facade return every few cells, and each of those
was the median of its own disc (unobserved cells never vote), so the fill
copied a 6/12/19 m patchwork along the rim. Three rules, in order of what
they fixed:

- Cells outside the outline never vote: the roof reaches the outline at
  the height of its last cell inside. On its own this changed nothing
  visible, but it removes the rim's dependence on the facade band.
- Where fewer than four cells of a disc are observed the cell is in a
  shadow and takes the upper quantile of the shadow's cells over twice the
  reach. A median there still alternated 6/12 m (a facade's returns are
  scattered down the wall; any median of them is a mid-wall value).
  Dropping sparse cells instead was tried and rejected: a strip of real
  33 m roof north of the tower, sparse because shadowed, was then filled
  from the tower at 207 m.
- A rim cell more than two cells below a neighbour takes that neighbour's
  height. This is what removed the teeth; without the threshold the max
  lifted noisy roofs at the rim by a fraction of a metre and failed the
  noisy-slope tests. City-wide, transitions along the outline between roof
  and more than 3 m below it fell from about 11,900 to 9,100 in the
  outermost quarter metre while staying at 7,400 a metre and a quarter in
  (real steps), so the rim-only artefact fell by about two thirds; what
  remains sits mostly in the second cell row. Extending the rule to two
  rows was rejected: it lifted the foot of a genuinely steep roof plane by
  nearly three metres.

Rejected for the look: subset vertex placement (endpoints and midpoint,
no quadric optimum) brought back ribs on every wall; halving the deviation
bound made more faces and failed Chase; halving the collapse tolerance
changed nothing visible. Chase Tower's doubly curved sweep still comes out
creased because the memoryless optimum extrapolates along tangent planes;
an error-driven edge-flip pass is the principled next step if that matters.

### Slender towers: a castle as one blade (algorithm 23, 0.25.1)

Cinderella Castle (Magic Kingdom, 857 m², about 2 mm across at the default
scale) came out as a tent with one slanted spike. The survey was not the
limit: 11,900 returns inside the outline, 14 per m², up to 54.5 m. Printing
the raster at each stage and rendering it uncollapsed showed where the
towers went:

- **The collapse.** The raster held six distinct towers; the collapsed cap
  one blade. The deviation bound is a distance to planes, and a wall's plane
  says nothing about height or about how far the wall has already moved: a
  wall may wander two cells at every merge. A broad mass never shows that; a
  tower three to six cells across is folded into the towers beside it.
- **The pitch.** The castle alone among 396 buildings was gridded at 0.71 m
  (eleven mapped rock surfaces at 0.58 m). `_surface_density` counts returns
  within half a metre of each 1 m cell's top, and cones and turrets spread a
  cell's returns over metres, so the castle read 2 per m² beside roofs
  reading 10 from the same flight lines. Its half-metre cells are 83% filled,
  more than many buildings gridded at 0.5 m.
- **The rank filter** lowers the main spire from 51 m (raw cell quantile) to
  45 m. That part of the cone is one or two cells wide, under 0.1 mm printed,
  and the filter is what keeps every other roof clean. Left alone.
- **Returns excluded upstream** (unclassified, multi-return: 29% of the
  castle's) would raise the raw tip by 2 m and put tree canopy on low roofs
  (665 low cells of the Contemporary rise over 3 m). Left alone.

What was tried on a 43-building set (Magic Kingdom, Chicago's West Loop,
downtown Miami; renders and a fidelity measure of the cap against its own
raster, tolerant of a wall shifted within its cell):

- Halving the deviation everywhere, or for wall planes only, kept the
  towers but roughened every skyscraper's walls (Kinzie Station, Ivy) and
  added 20–50% faces. Rejected, as before.
- Refusing optimum positions outside the height range of the faces they
  replace (to stop extrapolated blades) made fidelity worse: Brickell
  Heights' largest error went from 56 to 106 m. Rejected.
- A two-sided bound (the vertex given up must stay near the new faces) and
  a bound against the original raster both leave towers under four cells
  across unprotected, because every cell of such a tower is within reach of
  its foot; the raster bound also cost 65% more time. Rejected.
- Marking slender masses by width (what a grey opening removes) caught
  5–17% of tower cells, bays and fins included, and roughened walls like
  the global change. Rejected.

Adopted: `_spires` marks cells standing more than the admission band
(0.28 mm printed, at least 3 m) above four fifths of a ring six cells out. A
tower, a steeple or a chimney clears the ring; a bay attached to a larger
mass clears half of it and a square corner three quarters. `collapse` holds
edges touching a marked vertex, or a vertex that absorbed one, to half the
deviation. Kinzie Station and most towers mark nothing, and a cap that marks
nothing is collapsed byte for byte as before: 30 of the 43 buildings; of
the other 13, the castle apart, none gained more than 14% faces and no wall
changed visibly. Re-measuring 122 Magic Kingdom records changed 18 of them
and generated the same 373 LiDAR buildings and 23 rock surfaces with no
geometry fallbacks. Pinning marked
vertices instead was slightly crisper on the castle but kept every spike of
a planted parking deck. The pitch: a blanket occupancy-based density made
`test_noisy_slope_is_not_terraced` fail, rightly (the half-metre band also
reads a noisy roof as sparse, and the coarser grid is what averages it out),
so only a cap that shows spires at its coarser pitch is regridded by
`_scatter_density` (the share of half-metre cells holding any return; d per
m² leave exp(-d/4) empty). The castle goes to 0.5 m and 526 faces, its
towers distinct and vertical; synthetic 2–2.5 m towers that the plain
collapse cut down by up to 4.5 m keep their heights exactly.

### Facades filed as vegetation: icicles (algorithm 24, 0.25.2)

Rendered beside the Micropolitan model from the same cameras (it is north-up
in a local metric frame, offset about 353 m east and 619 m south of this
bundle's centre), Chicago's envelopes matched it closely except for jagged
"icicles" hanging a few storeys down from many roof edges (the Daley Center,
Leo Burnett, North Pier Tower). Micropolitan's edges there are straight.

The raster was clean, the collapse was not at fault: the cells along those
edges already held 174–183 m against a 192 m roof. They were lowered by the
vegetation-class returns (`secondary_samples`). The Cook County survey files
most of every tower's facade under classes 3–5 (the Daley Center 48,563
against 75,728 building-class returns, the Kemper Building 104,790 against
39,372), and reconstruction admits every one below the structural envelope
plus the band. Where an outline runs a metre outside the wall, the facade's
returns, spread over its whole height, outnumber the roof's in the last cells,
and each cell's 90th percentile sits on the facade. The one-row rim rule
cannot reach the second row.

Dropping vegetation returns entirely halved the sag but deleted Chase
Tower's flare, which the survey files as vegetation. Adopted: they still join
each cell's upper quantile, but never lower a cell that building-class
returns observed (`max(structural, combined)`), and a cell those left empty
takes the combined value, so they may still raise a cell by up to the band
or fill a gap.

- 19 dumped Loop towers: outline length sagging more than 3 m below the cap
  1.5 m inside fell from 3.6% to 2.4% (Daley 2.2 → 0, Burnett 9.5 → 2.6,
  One South Dearborn 2.6 → 0.2); Chase's flare unchanged.
- The 34 Magic Kingdom and Miami buildings of the regression set are byte
  for byte unchanged (those surveys file no facades as vegetation); the
  West Loop's changed slightly.
- Re-measuring the 599 Chicago records whose points were still cached (the
  others kept theirs): 159 → 135 buildings with more than 2% sag, faces
  −1.2%, the same 1,010 LiDAR buildings and no geometry fallbacks. The
  buildings whose number rose (a rooftop block now reaching an edge) looked
  unchanged or cleaner in renders; North Pier Tower and University Center
  lost nearly all their icicles.

What remains of the sag is real transitions (a tower meeting its wing) and
short teeth where only vegetation-class returns saw the edge. Thin shards
beside towers on scan-shadowed podium roofs (the pooled rule of "Rim teeth
and scan shadows") and creases on Chase's doubly curved faces are the next
visible differences from the reference.

## Tiers: real walls inside a footprint (algorithm 20, superseded)

Reconstruction algorithm 20; superseded by the edge collapse above. Run **Prepare LiDAR Buildings** with Refresh off,
then **Generate Model**; only measurement re-runs.

Towers showed full-height vertical ribs, 71 South Wacker's curved north face
most clearly. Most Chicago footprints are ground lots that include podiums and
plazas, so a tower face is usually not an outline wall but a step inside the
LiDAR cap: on the re-measured Chicago cache that was 53% of all wall area. On
the 1 m raster a step can only fall between two grid nodes, so a curved,
slanting or noisy wall is a staircase and every stair became a rib.

The cap is now split into tiers wherever neighbouring grid nodes differ by at
least half a printed millimetre (6.5 m at the default vertical scale). Each tier
gets a smooth outline, traced where its mask blurred over 1.5 cells crosses one
half, and its own measured roof clipped to that outline. Blender builds each tier
as a separate solid with vertical walls along the outline, like building parts.
A tier's outline also covers the tiers above it, so tiers nest and never leave a
gap. Rooftop detail lower than
the threshold stays in the tier's roof; smooth slopes of any steepness stay one
tier. Tiny tiers (under half a printed square millimetre) and walls smeared over
a node or two join the ground around them.

On synthetic buildings the rib amplitude on a curved face fell from 0.40 m to
0.09 m, a 45° wall is straight within 8 mm, and 3 m notched corners (as on the
Chicago Mercantile Exchange Center) keep their shape; a square convex corner is
rounded by under a metre.

Steep merged faces are also always published as triangles now. Blender refits
each face's plane from coordinates rounded to about 0.1 mm, and on a
near-vertical polygon that misses the other corners by centimetres; on the
Chicago cache that alone had rejected Aqua, Blue Cross-Blue Shield Tower,
181 West Madison and Legacy at Millennium Park back to source boxes.

## Straight tower walls and scale-aware detail

Reconstruction algorithm 19.

A tower rising from a lower part of the same footprint is a step of tens of
metres inside the cap. Along a wall that is diagonal or curved against the grid
(the triangular Macy's tower, the curved Hyatt Regency in Cincinnati) that step
was ribbed for two reasons. Every grid cell was split along the same diagonal,
so each cell the wall cut folded into a V-shaped notch; and the smoothing pass
averaged across the wall, turning it into a ramp of uneven heights. Each cell is
now split along the diagonal whose corners are closest in height, and the
smoothing leaves any cell whose neighbours differ by more than two grid cells in
height. A 45° wall becomes a straight line of faces; curved walls become flat
vertical facets. Domes and gentle roofs are still smoothed.

The grid still follows the print scale (0.07 mm printed per cell), and at the
default scale it stays 1 m. Previously it could never go below 0.8 m, so a larger
print lost detail the survey had. It can now go down to 0.5 m wherever a cell
would still average about four upper-surface returns (measured as the median
1 m cell's returns within 0.5 m of its top, so facade returns don't count). It
is never coarser than before. The face budget grows with a finer grid, from
16,384 at 1 m to 65,536 at 0.5 m, so a detailed building is not pushed back onto
a coarser grid. At twice the default scale, Space Mountain uses a 0.76 m grid
and the Hyatt a 0.63 m grid.

## Smoother envelope slopes

Reconstruction algorithm 18.

A rank (median) filter removes facade ribs but, on a curved or noisy roof,
settles into small plateaus, which the cap showed as terraces. Space Mountain's
dome was the clearest case. The envelope now averages each observed cell with
its observed edge neighbours after the median. Flat and planar roofs are
unchanged, step edges move by less than one cell, and ordinary buildings usually
need fewer faces because smoother areas merge into larger blocks. On a noisy
synthetic slope the share of flat terrace segments fell from 10% to about 1%.

The per-building face budget is back to 16,384 (it had been lowered to 8,192),
so large resorts, arenas and domes keep the 1 m plan grid instead of being
rebuilt at 1.5 m or coarser. Very steep facades can still show vertical ribs:
there each 1 m cell captures the survey's stripe pattern, and smoothing does not
remove that.

The raster is now laid along each footprint's long axis (the longer side of its
minimum rotated rectangle). Before, a roof wall running diagonally across the
north-aligned grid was sampled as a staircase of cells and the cap showed it as
a row of vertical ribs; Mickey's PhilharMagic was the clear case. Walls parallel
to that axis are now straight. Walls at other angles still meet the grid at an
angle. Clipped pieces are no longer discarded for being tiny: an outline running
close beside a grid line clips into thin slivers, and dropping one left a hole
that rejected the whole cap.

Merged flat blocks must now be within 5 mm of their plane (was 15 mm). Blender
takes every corner height from each face's fitted plane, so two neighbouring
blocks could disagree at a shared corner by more than the cap join allows, and
the building silently fell back to its source box. On the Magic Kingdom cache
this took envelope fallbacks from 17 of 369 buildings (including Peter Pan's
Flight, the Haunted Mansion and the Contemporary) to none.


## Skip small building footprints

**Minimum Building Footprint (mm²)** under LiDAR Buildings defaults to **0.7 mm²**,
roughly a **0.84 × 0.84 mm square** on the print (about 143 m² at the default
0.07 mm/metre scale). It uses actual mapped footprint area, subtracting courtyards
and summing disconnected sections, independent of orientation or height. The
whole mapped parent footprint is used even at the selection edge; small parts
of a larger eligible building remain available for detail reconstruction.

Buildings below the threshold keep their ordinary source geometry and skip
LiDAR survey comparisons, point acquisition and measurement. The filter applies
to both roof reconstruction and Correct Heights Only; mapped rock is unaffected.
Shared point batches or tiles can still include nearby small buildings' returns.
Set **0** to disable the filter, or increase it to focus on larger buildings.
Run **Prepare LiDAR Buildings** again after changing the threshold or print scale,
with Refresh off to reuse compatible cached work. Preparation reports the skip count.

## Height sanity correction

Enable **Correct Heights Only** under LiDAR Buildings, run **Prepare LiDAR
Buildings** with Refresh off, then generate. It changes height only when the
scan and current model differ by more than both **3 metres and 20%**.

Heights are checked within each existing main mass's own footprint, so a tower's
height cannot stretch its neighboring podium. Footprints, courtyard openings and
source roof shapes stay intact. Grounded undersides remain seated; print minimum
heights still apply. Small details, shaped roof parts and elevated parts stay
unchanged. Overlapping or insufficiently exposed masses retain their source
heights. It does not add missing main bodies or sculpt roofs. Unusable measurements
retain the ordinary source model. **Prefer LiDAR on Conflicts** still controls
whether conflicting source heights/dates can yield to a usable scan.

This mode uses coarser roof sampling and skips reconstruction, infill and mapped
rock preparation. Downloads and decoding still use the normal data path, so
total speedup depends on how much time acquisition takes. Switching modes needs
another Prepare; compatible downloaded and decoded data can be reused. Changing
roof-detail settings alone does not invalidate height-only data. Print scale
reselects buildings when the footprint filter is enabled; compatible scalar
measurements remain reusable.

## Automatic LAZ offers and mapped relief (0.23.15)

Reconstruction algorithm 17 (now 18, see above); acquisition remains 5; fallback policy is 8. Run **Prepare LiDAR
Buildings** with Refresh off after updating. Existing downloaded tiles and
compatible normalized points remain reusable.

1. Optionally enable **Include Mapped Rock Surfaces** after caching land data.
2. Run **Prepare LiDAR Buildings**, with Refresh off to reuse cached data.
3. Review any optional LAZ offer, then choose **Download and Use Offered Tiles**.
4. Generate the model.

Preparation finishes efficient EPT/COPC work first, then offers staged tiles for
missing coverage, known measurement gaps, or substantially newer/better catalog
evidence. A building's measured capture year can fill a missing streamed catalog
date for that building. Publication dates and survey names never establish measured capture dates.
When verified acquisition dates are absent, a project-year hint prioritizes
which survey to try; it is displayed as unverified and never becomes a measured
capture date. Much older projects without a documented quality advantage remain
fallbacks if the newer attempt fails, rather than being downloaded alongside it.
Ordinary roof mismatches or ground where a building is mapped can now prompt a
different survey; known duplicate deliveries still need an actual delivery gap.

Eligible independent surveys of uncertain relative age remain in the offer even when another survey
covers the same buildings. Wider coverage or unknown metadata is not proof
that the earlier-ranked survey is better. Known duplicate deliveries are
suppressed. Accepting the offer compares its reviewed alternatives even after
one staged source succeeds; actual support and capture evidence choose the
result. More alternatives can increase the reviewed download size.

Tile selection follows the
eligible footprints and their ground halos, excluding unrelated map acreage.
Nearby buildings, including successful older measurements, are compared too
when all their required tiles already fit that offer. This does not add downloads;
a footprint whose ground halo needs another tile is not added this way.

Accepting an offer evaluates its complete reviewed scope. One unproductive
batch no longer cancels the remaining approved comparisons. Transfers remain
bounded to each batch, with normal cancellation and cache reuse. If another
survey is needed after a failure, its tiles require a new offer. Current survey
support and capture evidence determine which complete measurement wins.

The separate **Compare a Full Survey** control from 0.23.13 is removed. Its old
saved URL has no effect. Offers from earlier preparation policies must be
reviewed again. No new downloads occur during model generation.

Buildings on irregular terrain can now use a measured ground anchor when a
single surrounding plane cannot be fitted. Spatially balanced ground cells
must enclose the whole footprint; a lower-decile cell provides WGS84 XY and a
same-survey vertical reference. Blender aligns that specific location with its
existing heightfield. Successful planar fits are unchanged.

Mapped bare-rock polygons have an optional separate upper-surface path. Class-2
ground is valid rock-surface evidence inside those polygons; vegetation is
excluded. Every component still requires 85% supported area and three returns
per supported cell. The output is a closed, terrain-seated envelope with rock
material, not a raw point mesh. Missing evidence retains fallback geometry.
Only a successfully built rock cap replaces source masses wholly contained
within that mapped domain. General attraction boundaries and point peaks do
not supply missing outlines. Overhangs, caves and hidden cliff faces cannot be
represented by a single upper height per XY location.

Small valid triangles at clipped envelope corners are now checked for relative
collinearity rather than rejected solely for their tiny printed area. This
keeps a complete cap from falling back because of one sub-print-size face;
closure, winding and boundary checks remain unchanged.

## Full plan resolution for large envelopes (0.23.10)

Reconstruction algorithm 16. Run **Prepare LiDAR Buildings** with Refresh off,
then **Generate Model**. Downloaded tiles and normalized point batches are
reused; the acquisition version is unchanged, so nothing is downloaded again
and only measurement re-runs.

Large buildings were losing their shape, not their detail. A cap costs about
one face per print-scale raster cell, so a downtown outline exceeded the old
4,096-face record budget, and the whole surface was then rebuilt at a coarser
pitch — 1.5 m, 2.25 m, or 3.37 m — until it fit. The pitch is what fixes how
well a cap follows the building in plan, so the result was a faceted circular
drum, a stepped curved facade and setbacks merged into blocks. In a dense
Chicago selection 201 of 1,204 reconstructed buildings were coarsened this way,
including most of the landmark towers.

The budget is now 16,384 faces and the pitch stays at print scale, so those
buildings keep a 1 m plan grid. Coarsening remains only as a last resort for an
outline too large to describe at print scale at all. Nothing else about the
reconstruction changed: the same upper-quantile raster, the same rank filter,
the same coplanar block merging, the same clipping and the same joined cap.

The larger budget is affordable because an envelope now publishes one shared
vertex table and integer faces (`roof_mesh`) instead of an independent GeoJSON
polygon per face. A cap's faces meet at common corners, so the polygon form
repeated every corner about six times and the wrapper once per face: 238 bytes
a face against 42, on disk and again in the reader's memory. Packing moves no
coordinate. Measured on the Chicago landmarks, the buildings that gained the
most detail are still smaller on disk than before, and small buildings drop to
about a sixth of their previous size. Records written by earlier algorithms, and
every other reconstruction, keep the loose `roof_surfaces` list.

One robustness fix travelled with this: when the reader conformed
clipping-induced edge splits it could treat a vertex a rounding distance from
an edge's own endpoint as a T-junction, fan the face around that sliver, and
leave three faces on one edge, which rejected the whole cap.

## Upper roof envelope (0.22.0)

**Roof Envelope** replaces Detailed Surfaces as the default reconstruction.
The saved enum remains `FACETED`, so existing scenes select the new path.
After updating, run **Prepare LiDAR Buildings** with Refresh off, then
**Generate Model**. Reconstruction algorithm 14 invalidates older measurements;
downloaded tiles and compatible normalized point batches remain reusable.
Acquisition, survey selection, ground reference, footprint coverage and conflict
policy are unchanged.

The new path builds a blanket over supported upper returns. Fine spatial bins
select upper evidence without letting dense lower facade returns erase a roof.
An upward-relaxed height sheet spans narrow downward recesses; broad level roofs
anchor it so a podium does not disappear into a whole-building convex hull.
Supported roof caps, slopes and broad curves remain in the surface. Isolated
spikes are filtered by neighboring support. There is no architectural region
segmentation, fitted circle/rectangle outline, setback reconstruction, or plane
stitching. The old reconstruction modules remain for legacy helper tests; the
default preparation path does not call that stack, even as a fallback.

The numerical sheet uses 0.5 m spacing and a scale-dependent relaxation reach
(2 m at the default scale). Its cells never become terraces. An adaptive triangle
surface approximates it, with nominal error budgets of 0.04 printed mm vertically
and 0.1 mm laterally, bounded by survey resolution. These describe approximation
of the **processed sheet**, not accuracy against every raw return. A genuinely
single planar roof can suppress bounded measurement noise without running the
sheet. The other local plane calculation only extrapolates a supported slope to
the mapped boundary. Neither creates independent roof objects.

Blender joins the roof into one shared cap with exterior and courtyard walls.
It sits on the existing terrain-seated base, with the usual small overlap.
Interior triangle edges create no walls. Cropping conforms shared cap edges;
incomplete, inconsistent or unclosable geometry falls back transactionally.
Mapped courtyards remain open, separate buildings remain separate solids, and
the output is a fully supported height envelope with no reconstructed undercuts.

**Terraces** remains available with its existing width and step controls. Failed
envelope preparation can retain a complete conservative terrace/height result;
failed mesh adoption retains the original source building. No building-specific
rules or extra native dependencies were added.

The reference screenshots guide the envelope style, not exact dimensions or
facade reconstruction. Fine survey noise and footprint irregularities can remain;
the method intentionally spans some real recesses. Mesh closure and rendered
comparisons do not establish slicer behavior or a completed physical print.

## Preparation progress and cache reuse (0.20.0)

Preparation now shows its current stage, survey, building counts, cache reuse,
elapsed time and a Cancel button at the top of the City Model panel. A progress
bar tracks buildings checked in the current survey; discovery and point reading
report their actual activity without guessing a whole-job percentage.

Use **Prepare LiDAR Buildings** normally with **Refresh Existing Cache** off.
Valid prepared results reuse immediately, including offline. After 24 hours,
Prepare rechecks discovery while retaining compatible measurement batches.
Failures affecting building reads retry; unrelated provider warnings do not
force repeated reconstruction. Changed footprints/settings invalidate the
affected work. A new normalized-point cache lets scale and roof-setting changes
reuse decoded points instead of reading the same downloaded tiles again.

**Refresh Existing Cache** deliberately bypasses reuse and invalidates older
derived results for the refreshed sources. Algorithm 13 remains unchanged:
existing compatible checkpoints migrate, and this release does not require a
geometry rebuild. Older installations have no decoded-point cache until a point
batch is read once. See the [workflow report](LIDAR_PREPARATION_WORKFLOW.md) for
validation and cache limitations. Earlier version sections below are historical.

## Near-touching roof-region crash fix (0.19.1)

Preparation could abort with `index 0 is out of bounds for axis 0 with size 0`
while ranking roof-plane merge candidates. The spatial query buffered one region,
but the ranking calculation buffered the other. At nearly touching corners,
polygonal buffer approximation can make only the first intersection nonempty.
The ranking pass now checks for an actual contact before reading coordinates;
the existing shared-edge test keeps unsupported merges separate. This does not
discard the building or relax reconstruction acceptance.

Algorithm 13 and acquisition remain unchanged, so completed checkpoints and
downloaded tiles remain reusable. Run **Prepare LiDAR Buildings** again with
**Refresh Existing Cache** off.

Validation reproduced the exact failure in the cached Chicago preparation and
then completed that replay after the fix. The repaired roof passes Blender mesh
closure/winding checks, and the prior 42-building geometry comparison is unchanged.
The regression test covers the asymmetric contact in both region orders.

## Shared surface outlines and final plane consolidation (0.19.0)

Detailed Surfaces now also consolidates compatible final planes, fits shared
roof outlines as a vector network, and suppresses subprint surface ripples before
adaptive meshing. Supported circular and rectangular roof structures receive
fitted outlines, while genuine discontinuities remain separate surfaces. The
actual XY/Z output scales determine the approximation budgets; the legacy
width/step controls still apply only to Terraces.

Run **Prepare LiDAR Buildings** again, then **Generate Model**. Reconstruction
algorithm 13 invalidates Task 1 measurements; leave Refresh off to reuse acquired
tiles. Discovery and acquisition are unchanged. Difficult regions can retain
their previous geometry, including complete connected roofs when necessary to
avoid cutting terraces into a continuous slope.

The [refinement report](LIDAR_SURFACE_REFINEMENT.md) contains the diagnosis,
actual Blender comparisons against 0.18.0, scale budgets, limitations and Task 2
observations. Earlier version sections below are historical.

## Coherent architectural surfaces (0.18.0, historical Task 1)

Detailed Surfaces now reconstructs coherent surfaces before it creates any
terraces. Run **Prepare LiDAR Buildings** again after updating, then **Generate
Model**. Algorithm 12 invalidates old measurement/checkpoint results; leave
Refresh off to reuse acquired tiles. Existing source discovery and downloads
are unchanged.

The former path flood-filled neighboring scalar cell heights, reduced each
accepted region to an elevation, and extruded nested unions of grid squares.
Its later faceting pass inherited those boundaries and retained terraces when
fitting failed. This explains both horizontal stair bands on slopes and noisy
roof islands. Blender did not introduce the height quantization.

The new path retains the existing ground, classification, per-component roof
coverage, footprint and survey-consistency checks, then:

1. Fits local robust planes to equally weighted supported cell observations.
   Compatible surface predictions connect regions; observed jumps act as
   barriers, so one accidental connection cannot merge a tower with its podium.
2. Removes spatially isolated residuals and merges statistically compatible
   planar regions. Independent roof features need two-dimensional support;
   numerous returns along a narrow facade strip do not establish a roof.
   Nearly equal flat levels merge horizontally, with measured local gradients
   distinguishing them from an actual shallow slope. Coherent small crowns
   remain independently supported features.
3. Partitions the mapped footprint, refines observed architectural boundaries,
   and reconciles continuous planar folds at their plane intersections. Shared
   nested interfaces avoid deep slivers; known courtyards remain open. Width
   regularization removes unsupported fingers from region outlines rather
   than filtering the individual triangles of a valid curved surface.
4. Emits broad fitted planes or adaptive continuous curved surfaces. It uses
   a bounded, coarser plane for an uncertain patch only when its residual fits
   fine printed-feature resolution. This is recorded explicitly. Incomplete
   envelopes keep a complete legacy fallback rather than losing an upper mass.

Minimum LiDAR Detail Width and Minimum Roof Step now apply only to **Terraces**.
Detailed Surfaces derives approximation tolerances from the selected print scale
and supported survey evidence; saved low slider values cannot fragment its roofs.
At the default 0.07 mm/m scale, its nominal fit error is about 0.025 printed mm,
with a measurement floor. A difficult local patch may be regularized within
0.1 printed mm; diagnostics distinguish this from the nominal fit and report
cell adjustments separately. Surface segmentation is not height quantization.

The mesh path still creates supported closed solids. This avoids unsupported
roof overhangs and does not use smooth shading, subdivision, or a modifier.
Planar regions may contain several cap polygons around holes; those polygons
are not independent architectural height levels.

Limitations: roof evidence remains an aerial 2.5D envelope, not a facade model.
Sub-cell boundaries, parapets, thin spires, occluded roofs, and heavily corrupted
returns remain uncertain. Curves are bounded polygonal approximations. Complex
or unsupported envelopes can retain legacy geometry. Closed-mesh verification
is distinct from slicer validation or a physical print.

Task 2 follow-up: the old terrace acceptance prerequisite could reject an
otherwise reconstructable sloping upper roof (`unresolved_upper_roof` or
`unprintable_major_tier`) before surface fitting ran. Bypassing that prerequisite
is necessary for quality and can incidentally recover those cases. Other skips
still come from surrounding-ground support, component coverage, footprint/epoch
contradictions, source-selection policy, and transactional Blender adoption.
Source-part supplements still deliberately use coarser scalar height correction.
Mixed polygon/line clipping remnants, unsupported convex-hull probes outside
concave roofs, and numerically fragile cap outlines were also concrete geometry
failure causes encountered and fixed here. Rejected full surface fits still
use a complete legacy fallback. No broad missing-building policy was changed.

The sections below document older reconstruction revisions and investigations;
the implementation and this section describe the current detailed path.


## Preparation with mixed clipped geometry (0.15.19)

Intersecting valid tier and footprint polygons can produce a GeometryCollection
containing roof polygons plus isolated line or point contacts. Such a collection
has no boundary object in GEOS. The roof-continuity check now extracts its
polygonal components before querying the boundary; line/point-only results have
no continuity evidence and cannot justify removing a major step. This fixes the
`'NoneType' object has no attribute 'intersection'` preparation failure without
discarding the supported roof or disabling detailed reconstruction. Ordinary
polygonal inputs keep their existing path. Algorithm 11 remains unchanged so
successful reconstruction checkpoints can be reused.

## Measured boundaries between roof cells (0.15.18)

The preceding contour cleanup still started from unions of whole square cells.
It recognized alternating short stairs but pinned long grid edges and repeated
turns, leaving ribs around broad curves and irregular setbacks. The grid retained
which cell contained an upper roof but lost where the edge crossed that cell.
This was a reconstruction bottleneck: the acquired returns already contained
useful XY observations between the 1.5 m support-grid boundaries. Increasing
download resolution or changing Blender normals would not recover that discarded
boundary placement.

Detailed Surfaces now retains returns near each supported cell's accepted upper
height band for a separate, bounded boundary fit. Major tier boundaries (the
existing `max(2 m, 4 × minimum step)` criterion) use a strip extending 1.5 cells
on each side. Within this strip, equal-weight XY bins retain actual return
centroids. Conflicting high/low bins are omitted; Delaunay triangles with edges
no longer than 1.5 cells locate crossings between observed roof levels. The
triangles are temporary 2D reconstruction data, not the final roof mesh.

Equal-distance contour samples feed a local quadratic fit, preserving straight
segments and broad curvature without the shrinking bias of simple averaging.
Resolved sharp corners are protected. The final contour is simplified to remove
sub-cell survey jitter; it retains a bounded number of useful vertices instead
of extruding every intermediate cell or sample.

This changes geometry, with these limits:

- At most 4,096 boundary observations per tier; excessively dense raw strips or
  over-budget fits retain the existing contour. There is no new point download,
  globally finer roof grid, or increased roof-facet budget.
- Unobserved sections and sections exceeding the displacement allowance retain
  their previous outline locally. The final boundary moves at most 0.8 cells
  (1.2 m, or 0.084 printed mm, at default settings).
- Each mass preserves its topology and area within 5%; known holes are protected.
  Only new islands/holes smaller than the existing detail-width area are filtered.
  Rectangular masses stay unchanged. Mapped parts, minimum width, and intersection
  with the lower supporting tier still apply afterward.
- Roof heights, sample ownership across terraces, plane/slope guards, coverage
  checks and closed-solid construction remain in force. A failed refined envelope
  retries the previous Detailed Surfaces geometry before the older fallback, so
  a previously usable detailed roof is not discarded just to fit a new outline.

`tests/test_lidar_boundaries.py` checks circular/oblique and irregular contours,
sharp recesses, courtyards, missing support, conflicting returns, deterministic
point order, budgets, preserved roof levels and complete-envelope fallback.
The synthetic Blender fixture generator also includes an irregular curved tier
with a sharp recess. Existing roof shapes, Terraces mode and LiDAR-disabled
generation keep their prior paths.

Select **Detailed Surfaces** with **Generate Roof Shapes** enabled, run **Prepare
LiDAR Buildings** again, then **Generate Model**. Leave Refresh off to reuse
cached points. Measurement algorithm **11** invalidates old reconstruction
checkpoints. Source footprint resolution, sparse surveys, unsupported boundaries
and conservative fallbacks still limit the result; this does not reconstruct
missing facade detail or establish physical print quality.

## Smoother measured building geometry (0.15.17)

The block-like appearance has several causes before Blender receives a mesh.
EPT reads target roughly 0.75 m spacing; LAZ uses valid cropped returns without
that hierarchy cutoff. Roof processing then compresses each supported cell
(at least 1.5 m across) to one upper-band height/sample. Terrace reconstruction
unions square cells, closes gaps, filters narrow detail and simplifies outlines.
Those cell boundaries can remain stair-stepped on diagonal or curved setbacks.
Detailed Surfaces previously retained every sufficiently large elevation-band
boundary even when the underlying roof was a continuous slope. Pinning noisy
extrema also produced unnecessary facets on otherwise planar patches.

At the default 0.07 mm/m scale, the EPT target is about 0.053 printed mm and
the roof-cell floor is 0.105 mm. Globally increasing point density would not
remove the later contour and partition artifacts. Blender projects and extrudes
the prepared outlines/surfaces without a voxel remesher or decimator. Its flat
shading exposes polygon changes, including the segments already present in
mapped curved facades; shading alone cannot improve an FDM silhouette. Roof
reconstruction does not invent finer facade outlines absent from source data.

Detailed Surfaces now performs three bounded improvements:

- Fit alternating short raster stairs through their edge midpoints, anchoring
  long edges and architectural corners. Reject invalid topology, excessive area
  change or boundary movement over 0.8 cells. Mapped parts, physical width
  filtering, courtyards and intersection with the supporting tier still apply.
- Test both sides of a terrace boundary at common positions. A major boundary
  is dissolved only when every probe has a supported continuous fit. A measured
  discontinuity retains the wall, including smaller supported steps. Keep the
  original cell-region sample ownership after outline cleanup, so a tower return
  cannot enter a podium fit merely because the outline moved across its XY.
- Fit clean planar patches within the existing height residual bounds before
  adaptive triangulation, avoiding extrema pinned to sub-tolerance survey noise.

The existing 120-vertex patch and 1,024-facet building limits, height agreement,
coverage and solid-closure checks remain. Unsupported patches retain terraces.
If the refined envelope fails, a single retry can retain its prior supported
detailed reconstruction rather than losing that detail to a height-only result.
No new points are downloaded for these refinements or retries. Roof solids stay
fully supported to their base; no subdivision modifier or facade bevel is added.

**Prepare LiDAR Buildings** again, with **Detailed Surfaces** selected and
**Generate Roof Shapes** enabled, then **Generate Model**. Leave **Refresh
Existing Cache** off to reuse cached point files. Algorithm **10** invalidates
older measurement checkpoints; it does not refresh source point downloads.
**Terraces** and LiDAR-disabled geometry retain their existing behavior.

Pure regression cases cover diagonal/circular setbacks, nested tower tiers,
small real steps, steep continuous slopes, courtyard holes, support gaps and
bounded noisy planes. `tests/lidar_surface_fixtures.py` prepares synthetic
measurement fixtures for `tests/blender_lidar_surfaces.py`, which checks actual
merged/unmerged solids, winding, roof heights and courtyard voids and can render
identical flat-shaded comparisons. A closed-mesh audit is not a slicer or physical
print test.

## International discovery and optional tile downloads (0.17.0)

See [LiDAR discovery architecture and source metadata](LIDAR_DISCOVERY.md) for the
current EPT/COPC/LAS/LAZ providers, normalization, selection and consent behavior.
This supersedes the USGS-only acquisition and gap-only offers described in older
release notes below. EPT/COPC stream automatically; ordinary LAS/LAZ require
request-bound consent for gaps or substantial metadata-backed upgrades. Good
streamed coverage is retained by default. Acquisition version 4 / fallback policy
5 require Prepare again; existing point-download caches remain reusable.
See [official providers, coverage limits and live verification](LIDAR_OFFICIAL_SOURCES.md)
for the direct national/regional additions. Flai, OpenTopography and USGS remain
part of discovery; official sources do not replace their coverage.

## Detailed measured roof surfaces (0.15.15)

**LiDAR Roof Reconstruction → Detailed Surfaces** is the new default. With
**Generate Roof Shapes** enabled, supported slopes and curved crowns can become
connected triangular roof facets instead of horizontal height bands. **Terraces**
retains the previous reconstruction. Changing modes requires **Prepare LiDAR
Buildings** again; leave **Refresh Existing Cache** off to reuse cached points.

The usual footprint, ground, coverage, classification and height checks run
first. `lidar_facets.py` then fits the same supported cell samples (three returns
per cell, existing 1.5 m cell floor), using deterministic boundary estimates and
adaptive interior refinement. No additional EPT points or LAZ tiles are requested.
Existing measured roof planes remain unchanged. Major terrace jumps of at least
`max(2 m, 4 × minimum step)` divide the fit, retaining vertical podium/setback
walls. Holes and footprint boundaries clip every facet. Unsupported patches keep
their original measured terraces; an incomplete or excessive fit keeps the entire
original envelope. This does not reconstruct facades or infer absent survey detail.

Comparison and complexity limits are explicit in `lidar_facets.py`: the 95th
percentile residual must be at most `max(0.35 m, minimum step / 2)` and the maximum
residual at most `max(1.25 m, 3 × that tolerance)`. Boundary estimates need three
nearby supported samples and a nearest sample within two cells. Refinement uses
at most 120 vertices per patch, 24 iterations and 1,024 facets per building.
The top must agree with the existing measured height within `max(2 m, 5%)`.
Clipping slivers less than 5 mm wide in survey space (0.00035 mm at the default
print scale) are discarded with a maximum footprint-area loss of 0.1%; the
existing solid builder still checks coverage and closed geometry before adoption.

The existing ground-draped solid builder supplies printable walls beneath each
facet. Smooth shading is not required, and no smoothing modifier rounds major
building corners. Preparation and generation report detailed-roof counts;
per-building records retain fit error and reasons for keeping terrace patches.
Measurement algorithm **9** includes the reconstruction mode in cache identity.
The public measurement-cache read limit is 128 MiB to accommodate bounded facets;
individual source-download limits and acquisition policy remain unchanged.

## Roof coverage and FGDC reports (0.15.14)

The measurement grid can split nearby returns across cell boundaries, causing
a well observed roof to fall just short of the coverage requirement. Only
coverage near misses with at least **80% supported footprint area in every
polygon component** now retry the grid at three fixed offsets: half a cell in
X, half in Y, then half in both. The first complete fit wins deterministically.
Each fit still needs **three returns per supported cell**, **85% coverage per
component**, and all existing ground, exterior-roof, height and printability
checks. Broad missing sections, observed ground, and mismatched exterior roofs
remain rejections. Accepted original fits retain their measurements and geometry.
The retries reuse the same cropped EPT points and ground reference; they do not
request LAZ or denser EPT data. Recovered records log `coverage_grid_offset`.

Standard FGDC XML reports can declare an external DTD. That declaration is now
accepted without fetching the DTD. Custom entity declarations and references
remain blocked, including UTF-16 input; ordinary XML escapes are supported.
The previous warning discarded useful survey metadata but did not invalidate
successfully prepared EPT buildings. Acquisition dates still come from reported
ground/collection time, and point spacing remains resolution rather than accuracy.

Measurement algorithm **8** requires **Prepare LiDAR Buildings** again. Cached
point files remain reusable; old measurement checkpoints are not treated as
newly evaluated roofs. Source ranking and incremental LAZ admission are unchanged.

## Verified input provenance and incremental fallback (0.15.13)

Differently named EPT/LAZ deliveries are now compared using the EPT input
manifest and original input metadata before staged point acquisition.
`lidar_provenance.py` reads `ept-sources/manifest.json`, with the legacy
`list.json` and numbered input metadata as a fallback. Similar project names
only produce a **possible duplicate** log entry; stripping packaging suffixes
does not establish identity or an acquisition date.

Explicit original project/dataset identities can establish equivalence. When
those are unavailable, a nonzero original LAS project GUID must agree with the
staged file's point count, native XYZ extrema, XYZ scale, point format and
global encoding. Legacy GUID byte ordering is accepted only with those other
matching facts. LAZ inspection reads the fixed public header only (at most
375 bytes), using an existing cached file or exact HTTP Range requests. It
does not fetch point records. Creation years and upload dates do not become
acquisition dates.

Verification applies only to the intersection of matched input/tile coverage.
Several verified regions can cover a whole footprint; one sample cannot stand
in for unmatched tiles, missing input metadata or a mixed survey. Known
conflicting acquisition intervals or explicit dataset editions retain the
existing conservative behavior. Limits are documented constants in
`lidar_provenance.py`: 4 MiB per manifest, 256 KiB per input report, 8 MiB total
provenance JSON per discovery, 32 local inputs per EPT source, and 32 LAZ header
attempts per discovery. Limit failures leave identity unknown.
[EPT source provenance format](https://entwine.io/en/latest/entwine-point-tile.html#ept-sources).

Confirmed same-survey LAZ remains eligible outside EPT coverage, after actual
EPT read failures, or for an explicit delivery coverage gap. An empty hierarchy
query (zero nodes and zero retained points) is a delivery coverage gap. Zero
filtered roof/ground returns alone, generic roof coverage rejections and sparse
support are not. This strengthens the duplicate-survey rule without changing
the preparation, classification or building-enhancement pipeline.

LAZ acquisition is now **one building batch at a time**. Only that batch's
footprint/ground-halo tiles enter the download pool; configured parallelism
still applies within the batch. No later batch's tiles start until the current
batch is decoded and its measurements evaluated. Completed files are reused
across batches and subdivision. Healthy measurement checkpoints are evaluated
before new transfers.

For speculative support-gap fallback, one batch with **zero adopted building
measurements** defers remaining speculative acquisitions from that source.
A productive batch resets the counter. The explicit policy constant is
`MAX_UNPRODUCTIVE_LAZ_BATCHES = 1` in `lidar_ranking.py`; this is a cost policy,
not proof that untested areas lack useful data. Independently justified coverage
or delivery gaps and material metadata upgrades remain eligible. Checkpoint
replay applies the same counter and stop rule. Logs and
`discovered_sources[].incremental_acquisition` record evaluated batches,
recovered buildings, the threshold and deferred candidates; provenance matches
and possible duplicates are also retained in the source audit.

Public `fallback_policy=3` requires Prepare again. The measurement signature is
unchanged, and matching survey checkpoints remain reusable.

## Footprint tile selection and survey identity (0.15.11)

LAZ admission now uses **each candidate footprint buffered by 30 m**, clipped
to the map's existing 75 m limit. The measurement pipeline still uses its 25 m
ground neighborhood; the remaining 5 m is the existing acquisition guard.
Tiles between buildings inside a batch rectangle are excluded. `lidar_tiles.py`
supplies the same tile allowlist to concurrent prefetch and sequential reads,
including subdivided batches. Healthy checkpoints require no tile transfers.
The download wrapper rejects unplanned tiles instead of silently fetching them.

`lidar_identity.py` compares scoped project/dataset identifiers from catalog,
EPT root and linked report metadata. It also recognizes project directories in
the USGS EPT delivery namespace, staged LPC links and TNM metadata links. Case
and separator normalization retains years and subprojects; parent programmes,
tile filenames, tile source IDs, generic titles and spatial overlap do not
establish equivalence. Different explicit dataset editions or disjoint reported
acquisition intervals defeat a project match. Unknown/mixed member identity
remains unknown. No extra point downloads are made to establish identity, and
the existing bounded metadata budget is unchanged.

A LAZ delivery of a usable EPT survey cannot outrank it because of discrepant
format metadata. After that survey has been read successfully for a building,
insufficient ground/roof support does not justify reading those same returns
as LAZ. This check includes every attempted EPT survey, not only the preferred
one. Same-survey LAZ remains eligible outside EPT coverage, after failed EPT
reads, for an empty EPT query, or for explicitly established coverage gaps.
Missing ground/roof classifications in otherwise returned survey data are not
evidence of a delivery gap. Different or unidentified surveys retain the
existing material-improvement thresholds and support-gap fallback policy.

Logs report survey identity and redundancy decisions. Each selected LAZ tile
also lists the number of intersecting footprints/ground halos and admission
reasons. `discovered_sources[].selected_tiles` preserves exact tile URLs,
building IDs, footprint versus halo ownership, sizes and reasons. Identity
evidence is retained in `survey_identity`. Public `fallback_policy=2` requires
Prepare again; identity-only changes preserve matching survey checkpoints.
Measurement, building enhancement and geometry algorithms are unchanged.

The cached `bbox_5270167d9b54` replay used 84 existing EPT checkpoints, with no
network requests or LAZ reads. All 965 accepted measurements remain available.
Footprint filtering alone still intersects seven tiles in each fallback survey:
the 60 support-gap candidates really are scattered across those tiles. The
identity check excludes both LAZ surveys because their matching EPT deliveries
were already read. **The final staged LAZ selection is empty.** This is an
acquisition-policy replay of cached measurement evidence, not a new preparation
or geometry run. Targeted tests additionally cover empty space between buildings,
ground-halo-only tiles, subdivision, checkpoint replay, different datasets,
unknown identity, conflicting acquisition dates, ties and EPT delivery gaps.

## Avoiding speculative LAZ fallback (0.15.10)

Previously every rejected EPT building remained eligible for LAZ, even when
EPT returned enough data to identify an unsupported roof shape, a footprint
conflict, or an unprintable component. Scattered rejections could consequently
request staged LAZ tiles throughout the selection despite complete EPT coverage.

Fallback now distinguishes data acquisition/support gaps from reconstruction
rejections. Without a material metadata advantage, LAZ is eligible after failed
EPT reads, insufficient ground points, insufficient roof points, or explicit
insufficient coverage; it also remains eligible where suitable EPT coverage is
absent. Roof fitting, noise, footprint/height/epoch conflicts, unprintable detail,
and unknown rejection reasons do not independently justify LAZ. A material
metadata advantage can still justify trying another survey. Source-independent
rejections (invalid/small footprints, elevated/underground buildings, or a
footprint/ground halo outside the fixed query limit) do not retry other sources.

The preferred attempted EPT's result governs this decision. Sparse returns from
a poorer secondary EPT cannot reclassify an earlier roof-fit rejection as a data
gap. Live and checkpoint results supply the same evidence. Logs and
`discovered_sources[].skipped_fallback_reasons` explain omitted acquisitions.
Remaining genuine support gaps can still require complete compressed LAZ tiles;
fewer candidate buildings do not necessarily reduce bytes in proportion.

That release introduced `fallback_policy=1` (superseded by 2 above), so Prepare is required to update
an older prepared result. That scheduling-only field is excluded from independent
survey checkpoint keys; matching existing batches remain reusable. Measurement,
geometry, source fallback and printability rules are unchanged.

## Windows progress-file contention (0.15.9)

The sidebar polls a private `progress.json` while the LiDAR worker replaces it.
On Windows an open reader can temporarily prevent replacement, producing an
access-denied error for `progress.partial -> progress.json`. Previously this
advisory update could abort preparation or be mistaken for a source failure.

Progress updates now retain atomic replacement, serialize download-thread
writers, limit sidebar writes to five per second, and retry permission conflicts
three times with 5 ms between attempts. If the temporary file or destination
remains unavailable, preparation continues and retries on a later status update;
stderr retains every progress message and emits one diagnostic per job. The last
complete sidebar status remains readable. Checkpoint and final measurement writes
still propagate errors. No acquisition/measurement signature change is needed;
existing completed work and cached point-cloud tiles remain reusable.

## Ranked acquisition (0.15.8)

Discovery now ranks metadata **before point acquisition**. Suitable EPT is the
default because its spatial queries are cheaper than staged LAZ transfer and
decoding. A small improvement or missing metadata does not justify downloading
LAZ. The existing measurement algorithm 7, preparation, roof fitting, source
conflict preference and building geometry remain unchanged.

Each building is assigned to a survey covering its entire footprint. Among
eligible sources, prefer EPT unless LAZ has a material advantage below. Within
each practicality tier, rank usable sources with adequate map coverage first,
then acquisition date, resolution, comparable reported accuracy, classification availability, coverage
fraction and finally URL. The URL tie-break is independent of catalog order.
A partial superior LAZ survey can win buildings in its own coverage while EPT
serves the rest. Coverage is a catalog estimate, clipped to EPT metadata bounds;
holes and incomplete footprints remain ineligible even at 98% map coverage.

| Comparison threshold | Default | Requirement to choose LAZ over suitable EPT |
| --- | --- | --- |
| `adequate_coverage` | 0.98 | Map-coverage ordering within a tier; never permits a partially covered building |
| `age_difference_years` | 5 | LAZ acquisition start at least 5 × 365.25 days after EPT acquisition end |
| `spacing_ratio`, `spacing_difference_m` | 1.5, 0.25 m | EPT nominal spacing at least 1.5× LAZ **and** at least 0.25 m coarser |
| `density_ratio`, `density_difference_m2` | 2, 2 points/m² | LAZ density at least 2× EPT **and** at least 2 points/m² higher |
| `accuracy_ratio`, `accuracy_difference_m` | 2, 0.10 m | EPT error at least 2× LAZ **and** at least 0.10 m higher, for the same axis and statistic |
| `classification_difference` | 0.25 | Reported classification quality at least 0.25 higher on the same explicitly named scale |

LAZ also takes precedence when it explicitly provides ground and building
classes that EPT reports missing. Unknown class availability is not absence.
Known missing ground or unsupported EPT delivery/units is unusable. RMSE is
compared separately from accuracy at a confidence level; accuracy requires
matching known confidence/basis. Point spacing measures **resolution**, never
positional accuracy. EPT octree span, XYZ quantization, total return counts,
quality-level labels and publication/upload/file-creation/project-name years
are not substitutes for these measurements.

Defaults live in `external/lidar_ranking.py`. Advanced callers can pass partial
`acquisition_thresholds` overrides to `data.lidar.request_signature(...)` or put
them in the worker request JSON; no additional sidebar controls are needed.
The full effective defaults are included by the signature builder. Unknown,
nonfinite or nonpositive thresholds are rejected; ratios must exceed 1 and
fractions must not exceed 1. Threshold changes invalidate prepared caches.
Acquisition version **2** requires **Prepare LiDAR Buildings** again after this
upgrade; downloaded tiles remain reusable.

Metadata reads use EPT `ept.json`, explicit catalog acquisition/metric fields,
and linked JSON or FGDC XML reports (4 MiB per document, at most eight distinct
reports per survey). TNM's S3 metadata landing pages are resolved by listing
their designated `best_use_xml/` directory. Other landing pages, absent reports,
ambiguous units/prose and unsupported metadata formats remain unknown; there
is no arbitrary web crawl or point-body download to fill metadata fields.
FGDC dataset dates are accepted only when their stated basis is ground
condition/acquisition/collection. Year/month precision becomes a full interval,
and the complete interval must establish the age advantage. Survey aggregates
use the full date range and worst quality; a missing tile/report field cannot
be replaced by another tile's better claim. Some EPT catalogs omit all flight
dates and quality metrics: EPT remains preferred until usable coverage is
tested. No date is inferred from its name.
[EPT metadata specification](https://entwine.io/en/latest/entwine-point-tile.html),
[USGS TNMAccess description](https://www.usgs.gov/faqs/there-api-accessing-national-map-data).

Only unresolved buildings advance to another survey. As of 0.15.10, LAZ fallback
requires a read/coverage/support gap or a material metadata advantage; an arbitrary
measurement/selection rejection is not enough.
Successful buildings are excluded from later batches. LAZ prefetch therefore
downloads only tiles intersecting individual unresolved footprints and their
existing ground halos; a selected compressed tile still transfers in full.
No ground, roof points or geometry from different surveys are mixed within a
building. Fallback can try several surveys if genuine data gaps persist; it stops
as soon as a compatible result exists. Checkpoint replay follows the same plan.

One log line per candidate records format, acquisition interval, spacing,
density, horizontal/vertical RMSE or reported accuracy, classification, coverage,
rank and reason. Selection/skip lines explain actual acquisition, including gap
fallback. `discovered_sources` retains metadata and acquisition reasons, and
`acquisition_selection` records the effective thresholds in the result audit.
`tests/test_lidar_ranking.py` covers preference, substantial improvements, dates,
missing metadata, ties, incomplete coverage, holes, parser limits, source
failure, actual LAZ tile admission, cache replay and threshold invalidation.

## EPT and staged USGS LAZ acquisition (0.15.0)

The following describes the initial dual-format implementation. Ranked
acquisition above supersedes its exhaustive survey scheduling.

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
  -> independent survey candidates, ranked from acquisition metadata
  -> preferred surveys, then fallback only for unresolved buildings
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
quality. Ranked acquisition now retains unknown sources as fallbacks and
prefers suitable EPT. After bounded acquisition, the existing weighted coverage,
explained-roof fraction, saturating supported density and GPS capture-age score
validates available complete measurements per building. The crop's
class-6 share among class-1/6 returns breaks otherwise equal quality/age ties;
this is a classification-availability hint, not a classification accuracy claim.
Raw point counts and number of fitted tiers do not win by themselves.
Names are not fuzzy-matched to deduplicate acquisitions. The survey identity
checks above apply before LAZ admission; successful buildings are excluded
from later EPT or LAZ reads by the acquisition planner.

Publication/update dates never become flight dates or veto observations.
Mixed epochs, missing ground, insufficient support and the existing conflict
preference retain their behavior. Source format, URL, selected quality/age
score, alternatives and catalog candidates are recorded in the audit.

### Tile acquisition and manual manifests

LAZ tiles are grouped by their delivered survey/subproject directory, using
the union of authoritative tile bounds for coverage. Directories identify
collections only; names are never decoded into coordinates. Only tiles
intersecting candidate footprints and their established halos are fetched.
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

Acquisition signature **2** invalidates old prepared results/checkpoints without
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
`-87.7442,41.87627,-87.61906,41.89276` and contains 1,542 buildings.

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

LAZ delivery is not hardcoded to RockyWeb: acquisition uses the HTTPS LAZ URL
published by TNM (`urls.LAZ`, `downloadLazURL`, then `downloadURL`), or supplied
by the optional manifest. Public S3 URLs work through the same transport when
actually available. Do not manufacture a free mirror by replacing RockyWeb's
hostname/path with `prd-tnm/StagedProducts`: the presence of browse images or
download manifests there does not establish that the point-cloud objects exist.
The separate `usgs-lidar` raw-LAZ bucket requires authenticated Requester Pays
access and is not a complete 3DEP mirror. Supporting it requires an explicit
paid-access option, verified object mapping and AWS authentication; neither
anonymous requests nor a simple URL rewrite provides that access.
[AWS delivery resources](https://registry.opendata.aws/usgs-lidar/),
[Requester Pays authentication and charges](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RequesterPaysBuckets.html).

The implemented path uses the mirror's GeoJSON coverage index and TNMAccess
LPC tiles as described above, intersects the selected bbox, and ranks overlapping
surveys before acquisition, with EPT preference and unresolved-only fallback.
An optional EPT URL overrides automatic discovery; a
manifest can add manual LAZ candidates. Each building is measured
within one survey; overlapping acquisitions are never mixed.
[Mirror coverage index](https://github.com/hobuinc/usgs-lidar/blob/master/boundaries/resources.geojson).

For EPT, only intersecting hierarchy pages and LAZ nodes are fetched. EPT is
additive, so ancestors must be included with descendants. The reader targets
0.75 m sampling, adjusts Web Mercator horizontal resolution for latitude, and
crops decoded points to the requested area plus a 75 m ground/boundary halo.
[EPT format](https://entwine.io/en/latest/entwine-point-tile.html).

EPT node and staged LAZ acquisition download four required resources concurrently by
default. **Buildings → USGS LiDAR Buildings → Parallel Downloads** accepts
1–16 transfers; the limit applies to the next preparation. Changing it preserves
prepared measurements and checkpoints because it is a transport option, not a
measurement setting. The external CLI exposes `--download-workers 1–16`.
The worker prefetches only the currently admitted building group, skipping
valid checkpoints and unneeded tiles. EPT has a bounded window of node downloads
and consumes results in the original hierarchy order. Set the limit to 1 for
sequential downloads; COPC range reads remain sequential.
Downloads overlap with sequential decoding and measurement; point-array memory
limits and source selection remain unchanged. Shared URL/revision transfers are
coalesced, cache replacement is atomic, and progress-file writes are serialized.
Esc terminates the worker and its download threads; completed files remain
reusable. A single large tile still uses one transfer, and throughput depends on
the connection and USGS server. Explicit total byte budgets serialize transfers
to preserve the cap; normal preparation uses concurrent transfers with the
existing per-tile size guard.

Within a preparation, decoded EPT nodes reuse up to 64 MiB of RAM. Decoded LAZ
tiles reuse read-only mappings of temporary files, limited to 1 GiB total and
512 MiB per tile. This avoids repeatedly decompressing a tile shared by several
building groups. Larger tiles, or unavailable temporary storage, use the
existing chunked reader. These temporary files are removed on eviction, normal
completion, or process termination. Each batch still applies its own crop and
normalization to the raw records; no surveys, classifications, or heights are
combined. The persistent normalized-point and measurement caches are unchanged.

The downloader reports per-tile throughput and identifies decoding/cropping
separately. LAS header checks run during the initial transfer, before the point
body: tiles lacking usable coordinate metadata fail early. EVLR-only CRS and
large header regions defer to full-file validation. This preserves survey and
geometry selection while avoiding transfers that cannot produce measurements.

Interrupted transfers retain a partial file only when a strong HTTP ETag and
total length are available. Retries and later preparations request the remaining
bytes with Range/If-Range, checking the response identity and extent before
appending. A changed resource or ignored Range restarts the full transfer.
Completed files are still promoted atomically. Old partials without validation
metadata cannot be reused safely and restart once.

An OS lock allows one preparation per cache root, including across Blender
instances. The worker monitors its owning Blender process and exits if it closes.
On Windows, cancellation terminates the whole virtual-environment process tree,
including the separate Python child, preventing orphaned duplicate transfers.

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

Reusable LiDAR storage defaults to **30 GiB per cache folder**, with a **10 GiB
free-space reserve**. Both settings are machine preferences, available beside
the cache path and in the add-on preferences. Before acquisition and when a
write needs space, the add-on removes older normalized point batches first,
then older downloaded sources. Files used by the current batch are protected;
completed batches become eligible again so a large preparation can reuse space.
Recent resumable partial downloads are retained; abandoned partial files older
than seven days are eligible for cleanup under the same worker lock.

**Review LiDAR Cache Cleanup** shows current reusable storage, free space, and
the proposed reclaim amount before applying manual cleanup. Merely opening
Blender, installing the add-on, or generating from prepared data does not purge
the cache. Cache eviction can make future preparation slower or require another
download. Optional normalized-point caching is skipped when it cannot fit;
required downloads stop only if eligible older cache files cannot make room.

Prepared building results, measurement checkpoints, Overture/terrain bundles,
and source-revision markers are preserved and excluded from this budget. These
protected datasets can still grow as new areas are saved; review/archive them
manually when no longer needed. The separate temporary decode cache remains
bounded to 1 GiB and also checks free disk space. To explicitly protect reusable
data, place an empty `.keep` file in `lidar_tiles` or in a survey's
`lidar_derived/<source>/points` directory. Protected files may prevent satisfying
the configured limit. Autosaves, saved scenes, exports, and development baselines
are never part of automatic cache cleanup.

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
