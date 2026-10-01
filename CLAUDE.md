# Jarvizar City Model (web): shared agent context

Read [AGENTS.md](AGENTS.md) for development principles. Implementation,
configuration and tests are authoritative. Keep transient results out of here.

## What it is

A browser-only app (Vite + React + TypeScript, deployed to GitHub Pages) that
turns a map area into a multicolour FDM city model: terrain, water, land
surfaces, roads/rail, optional schematic bridges and trees, and buildings with
roofs from Overture Maps. It is a port of the Jarvizar City Model Blender
add-on (separate repo `3dmapcreator`, not a dependency). Its LiDAR pipeline is
ported for streamed surveys only (EPT and COPC). Staged LAZ downloads were left
out. `settings.modelSource = 'lidar'` (LiDAR only) builds the whole model from
a survey instead, as one solid in the terrain colour, with the water as its
own part if asked and Overture's water only for shorelines and holes
(`src/core/dsm/`).
There is no server: data is read from public, CORS-enabled sources.

The same app makes flat SVG maps for laser engraving, pen plotters and print
(`output: 'svg'`), from OpenFreeMap vector tiles. That engine came from the
SVGmap app (separate repo `SVGmap`, not a dependency) and lives in
`src/core/svgmap/`. The two outputs share the area, search, presets, share
link and saved state, not their engines.

One model unit is one printed millimetre. Default scale 0.07 mm per metre
(1:14,286). Defaults live in `src/core/settings.ts` and follow the add-on.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/geo/` | `Projection` (WGS84 to local ENU, rotated to the area, scaled to mm), area shapes, bounds parsing |
| `src/core/data/` | Overture GeoParquet reads from S3 (STAC index, row-group pruning, two-pass page reads, hyparquet), Terrarium DEM tiles, IndexedDB byte cache, HTTP retries/limiter |
| `src/core/geometry/` | Clipper2 wrappers (`polygon.ts`), prism mesher (`mesher.ts`, Delaunator + Constrainautor CDT with earcut fallback), edge/raster indexes, mesh validation |
| `src/core/terrain/` | `HeightField`: the one grid every layer samples |
| `src/core/dsm/` | LiDAR only models: `prepare.ts` reads a survey into a grid (`raster.ts`, `grid.ts`), `compose.ts`/`filters.ts` the height rules, `mesh.ts` RTIN and edge collapse, `model.ts` the `ModelSpec` |
| `src/core/lidar/` | LiDAR: `sources/` discovery (USGS EPT, IGN, NRCan, swisstopo, Flai COPC), `read/` EPT/COPC/LAS reading with an injected LAZ decoder and projector, measurement (`measure.ts`, `envelope.ts`, ground, planes, terraces, selection), roof surfaces (`regularize.ts`, `delatin.ts`, `coarsen.ts`, `rim.ts`), `prepare.ts` batching and checkpoints |
| `src/core/pipeline/` | Generation stages: water, roads (+linework, airports, bridges, `network/` tidy), land, buildings (+`buildings/` selection, heights, roofs, printability), trees, orchestration (`generate.ts`), meshing, plates, row filter |
| `src/core/export/` | Bambu Studio project, PrusaSlicer project, generic 3MF, STL, zip streaming, section grid |
| `src/core/edit/` | Model editor: the edits document (`types.ts`, `keys.ts`), `EditSession` applying it to a generated model in the worker, road tiles, land fill, terrain and water after edits (`earth.ts`), added shapes and what they stand on (`stand.ts`), road lines for picking |
| `src/core/engine/` | Worker protocol and main-thread client |
| `src/worker/engine.worker.ts` | Downloads, generates, meshes and exports off the main thread |
| `src/worker/svg.worker.ts` | Renders SVG maps, separate so a preview updates while a model generates |
| `src/core/svgmap/` | SVG maps: tile fetch/decode/stitch, piece layout (`layout/`), line cleanup (`lines/`), fills and hatching, titles (`text/`), SVG writer, `service.ts` (the render with its caches) |
| `src/app/` | React UI: state (zustand), MapLibre area editor, panels, three.js viewer. The model editor is `viewer/editController.ts` (pointer tools), `picker.ts`, `highlight.ts`, `shown.ts` (what the view hides and colours), `viewer/edit/` (toolbar, inspector) and `state/editActions.ts` (edits, undo). `src/app/svgmap/` has the SVG sections, preview, render client, route picker, piece fitting and share encoding |
| `scripts/` | `generate.ts` (CLI end to end, `--options` for an exported options file with its edits), `fetch-area.ts`, `bench-synthetic.ts`, `check-bambu.ts`, `fuzz-edits.ts` (random edits, exports checked), `shot.mjs`, `e2e.mjs`, `e2e-mobile.mjs` and `e2e-edit.mjs` (browser runs in the installed Edge) |

## Pipeline rules worth preserving

- Everything samples one `HeightField`. Never sample the DEM directly in a layer.
- Between nodes the terrain is the grid split along each cell's low-to-high
  diagonal (`geometry/lattice.ts`), `heightAt` included, and draped solids
  (terrain, land, roads, grounded buildings) are cut from those triangles
  (`latticeCap`). Separately triangulated caps parted from the ground by more
  than the embed on steep ground with big cells: 0.4 mm at 3 mm cells.
  `latticeTin` only builds the cells a polygon touches (its bounding box was
  1.8 GB for a thin diagonal beach). A footprint is only left undraped when
  it lies in one triangle (`inOneTriangle`), not when it's smaller than a cell.
- Almost everything is a `PrismSolid` (polygon + top/bottom height + drape).
  Crop and multi-plate sections are 2D clips before meshing, so every shell
  stays closed. Trees are `MeshSolid`s, kept only where the whole crown is
  inside the crop, and left out of both sections when a crown crosses a seam.
- The mesher only accepts caps whose edges close exactly (`capIsClosed`).
  Pinched polygons (rings touching at a vertex, or a hole corner on another
  ring's edge) are shrunk by 1e-4 mm and retried (`PINCH_MM`). Never weld by
  coordinate. A cap cut to a print section gets the same retry, for a
  section line through a concave corner of its outline.
- Water: cut (>= 5,000 m2 of the whole feature), basins (ponds/fountains
  by tags, below their lowest bank), sheets (small, 0.18 mm above flattened
  ground). Cut water and basins sit 0.25 mm below the bank as a
  `water.thicknessMm` layer on a flat terrain floor, and the base thickness
  counts from the floors. With `water.mode` 'through' cut water runs down
  to the base instead (`waterBottom`). Basins and sheets are trimmed to
  what lies outside cut water. Cut water level is the interior median
  raised to the low tenth of its shoreline (grid nodes inside the crop
  only). Cut bodies that overlap merge into one at their area-weighted
  median level. The grid is flattened under it and the shore raised.
- Small water touching cut water (sheets and untyped small water, not
  tagged ponds) joins it as cut water at its level, the lowest where it
  touches several, and on through chains of small pieces
  (`joinSmallWater`, `water.joinSmallWater`, on by default). As sheets,
  Boston's locks and Amsterdam's and Venice's canal pieces stood 0.4 to
  0.6 mm over the water beside them. Their own median isn't used: the
  elevation data reads a lock as its dam and Venice's canals up to 11 m
  over the lagoon. A piece more than 15 real metres from that level stays
  a sheet, for a stream climbing away from a lake. Touching cut bodies
  still keep their own levels, so steps between large water mapped
  separately remain (up to 0.5 mm in Venice).
- Beaches (`beaches.ts`, `land.taperBeaches`, off by default) lower the grid
  itself from the waterline to the ground behind, after every layer is laid
  out and before the base is worked out, so draped parts follow. Only nodes
  1.5 cells clear of roads, buildings, bridges, piers and ponds move, so every
  grid triangle under them keeps its shape and its bank. Other land cover
  stops a beach but slopes with it. Sand short of the water is joined to it
  by a closing of sand and water (a buffer of the waterline ran sand past the
  beach ends). Every land slab keeps `land.riseMm`, sand included: a sand
  taper and ground lowered below the water so the sand met it were both
  tried, and on coarse grids with roads behind a beach the second left
  0.6 mm sand walls.
- The water is cut around everything standing in cut water or a basin:
  roads, buildings, piers and mapped piers, quays and dams (`kept` in the
  edit context). With `settings.supports` the ground under them is left out
  of the cut, not added as extra solids. Off, they're built down through
  the water in their own material (`wading.ts`), to the floor or `baseZ`
  where the water runs through, and only mapped piers and the like stay
  ground. Either way nothing may stand on the water alone: the water part
  can be deleted in the slicer. A pier counts by its whole footprint, not
  its middle point, or one on a bank stood on air over the water.
- The terrain only drops ground pieces under `GROUND_SPECK_MM2` (1e-6 mm²).
  Nothing else covers a dropped piece, and at 0.01 mm² they were pinholes
  through the model under road tips and huts in the water. Mapped piers
  under 0.01 mm² in cut water (moorings) are left out of `decks` instead,
  so the water covers them.
- Thin ground in water (`thinGround.ts`, `water.skipThinGround` and
  `widenThinGround`, off by default) is ground with water on both sides
  that a closing of the water less the mapped decks fills, so a quay
  along the shore never counts. It's settled in `solveWater` before the
  grid is flattened. Filled islands join the body they share the most
  shore with, and bridges are split on the water as mapped (`mappedCut`)
  so a path along a filled breakwater isn't a bridge. Widened ground joins
  `decks`, so bodies keep their outlines. Widening skips specks under the
  width every way (moorings grew into triangles) and slivers under 0.02 mm
  (a pier's outline and the lake's disagreeing grew into 0.4 mm strips
  beside Chicago's piers). With both off the output is unchanged.
- Parts overlap where they reach into the terrain (`land.embedMm`, 0.04 mm)
  and where water sheets sink into it. Slicers give an overlap to the part
  listed later, so 3MF writers list parts by `OVERLAP_RANK` (`writeOrder`):
  terrain after everything embedded in it, water last. Filaments keep the
  model's order (`modelFilaments`). The viewer settles coplanar walls the
  same way, offsetting walls only: a whole part offset would let a water
  surface show through the bank in front of it. Nothing that reaches into
  the terrain may lift off it on a slope, whatever the overlap: draped parts
  are cut from the lattice, piers drape like buildings, and a tree's flat
  base goes down to the lowest ground under it.
- Land categories never overlap (priority order). Water, roads and building
  footprints are cut out of slabs, and slivers under ~0.2 mm are opened away.
  Above 250 mm this runs in 50 mm tiles with a 1 mm margin (`tiled`), so
  each boolean only sees what's near it and seams match a single pass.
- Satellite land cover (`land.satelliteCover`) is off by default. WorldCover
  calls tree-lined streets forest, and whole neighbourhoods came out green.
  Land cover is picked by zoom level (`isDetailedCover`), never by size
  against the selection: a detailed polygon is a whole zoom 10 tile, so a
  size test made the same streets green or not with the size of the area.
  Mapped `land` and `land_use` keep the size test (`isRegional`).
- Don't bring back Clipper2's `rectClip`. It drops a corner when a ring
  leaves the rectangle through one side and comes back through the next (up
  to 2 mm2 on random road networks). `clipToRect` (`geometry/clipRect.ts`,
  shared with SVG maps) is Sutherland-Hodgman, and needs a NonZero boolean
  after it.
- Boolean output is sorted into outers and holes by orientation, not tree
  depth. Where edges of two inputs nearly coincide, the engine can return a
  hole at the top level, and `placeStrays` puts it back into its owner.
- Road widths clamp to 0.45-0.7 mm and groups are unioned. Roads beat rail beat
  paths. Split segments at every `between` boundary before reading rules.
  Tunnels and indoor corridors are skipped.
- Overture has no raceways (OSM `highway=raceway`), so `data/raceways.ts`
  reads them from OpenFreeMap tiles and adds them to the segments as class
  `raceway`: zoom 12 to find them, zoom 14 over what it found (zoom 12 is up
  to 3 m off). Tiles have no OSM ids, so edit keys come from each line's
  ends and length. A failed download is a warning, never a failed model.
- Buildings follow the add-on's selection/height/roof rules. See comments in
  `src/core/pipeline/buildings/`. The exception is raised parts
  (`min_height`): by default they're built down to the terrain
  (`groundRaisedParts`), and either way a gap under one thinner than a layer
  is closed (`MINIMUM_CLEARANCE_MM`, `settleOnMassesBelow`).
- `pipeline/dataPlan.ts` selects data types and filters rows from small
  columns before geometry is read. Its requirements also key the worker's
  cached download. Keep the filter in step with the classifiers.

Road network tidy (`pipeline/network/`, `roads.tidy`, run in `collectRoadPieces`
before bridges are split off):

- The web app's own. The first version (after the add-on's `road_network.py`)
  held a moved carriageway at every junction and bent it back, so divided
  streets zigzagged at every cross street, thinned rail yards and car parks
  into ladders, and joined loose ends with long diagonals and tapers. The
  rule now: lines are cut, dropped, extended a little along themselves or
  moved onto the middle of their own divided road, never bent towards
  something else. Check changes with before/after renders on many areas
  (motorway interchanges, Irvine's arterials, rail yards, car parks, old
  town centres), not just Chicago.
- Order: merge divided roads (`divided.ts`), cull, join, prune. Merging goes
  first, or a service road beside one carriageway was culled and the
  carriageway then moved away from it.
- Divided roads merge only as clear pairs: one-way lines (`oneway`, from
  `access_restrictions`, general traffic only, no time or vehicle
  conditions) of one class and subclass travelling opposite ways, each the
  other's only partner, nothing of their rank or higher between them. A pair
  starts below the gap and runs on to 1.5 times it, or medians near the
  limit merged for a block and forked again. The midline averages closest
  points taken both ways (one way leans on a fork's arms), kept in order
  along the other line, and a one-way ring's partner is unrolled from
  beside its start. Junctions slide along the street meeting them onto the
  midline, so cross streets stay straight and the stub across the median
  vanishes. Pairs run on to a fork both carriageways share, or to a cross
  street joining both, within 4 mm, or they forked just short of junctions.
  Lines left over bend in to the merged line with the move eased out along
  them, so curved ramps keep their curve.
  Crossing divided roads merge in successive rounds, and a merged line never
  merges again.
- Neighbours only count when they're beside a sample (`SegmentIndex.beside`).
  A line carrying straight on from another's end vertex read as doubling it
  and paired one-way streets end to end.
- The cull only drops a line beside a strictly more important one (twin
  decks excepted). Rail yards, car parks and plaza path grids keep their
  lines. Thinning a yard to every few tracks was tried (welding through
  switches along the straightest track, so they didn't thin into ladders),
  but the untidied yard reads fine: the tracks are distinct enough for the
  slicer. `alongside` ignores a kept line
  past its ends, and cuts snap to a vertex within a sample, or a scrap of the
  doubled stretch is left pointing along the road.
- End origins decide what may move. `met` ends (their partner was left out or
  culled) join within twice the gap and go as stubs. `dead` ends only join
  when the ground left wouldn't print and only go as nubs. `portal` ends
  (tunnels, indoor corridors) never join far but can go as stubs. Skipped
  sidewalks and crossings go in `leftOut`, or every path that met one reads
  as a dead end. Joins go straight on, or across within 60 degrees of the
  heading, never across another line.
- A part lying wholly inside a ribbon at least as important is dropped. Such
  scraps passed every other rule and printed as slivers.
- Decks and ground never double each other, deck ends never move, and decks
  only meet the ground where their lines meet.
- The tidy must never make roads read thicker than with it off. `fillGaps`
  only fills cracks under half the gap between lines of one group, never
  rail (filled, a yard printed as one band), from
  centerline to centerline in the same union as the roads (`gaps.ts`), and
  enclosed ground nowhere that wide (`fillThinHoles`). Filling up to the
  whole gap, across groups too, printed ramps side by side as one block and
  a track beside a street as a slab of rail colour. Strips run on to 1.3
  times the limit and need 0.5 mm, or lines near it gave rows of rungs.
  The tidied footprint less the untidied one catches this: merged divided
  roads add their median, nothing else should add much. A closing of the whole footprint was tried: round joins
  filleted every block corner and it cost seconds on large areas.
- Road polygons of one group touching at a single vertex are pulled apart
  by 0.2 µm (`separateTouching`), or their prisms share a wall edge.
- Every step has its own switch and the tidy off gives the untidied network.

LiDAR (`src/core/lidar/`, generation in `pipeline/lidar.ts` and `buildings.ts`):

- Measurement is a port of the add-on's `lidar_*.py` (algorithm 29) up to the
  faired roof raster. Tests use a numpy PCG64 copy, and `geos.ts`, `centroid`
  and `rotate` follow GEOS 3.13 and Shapely to the bit (the grid follows the
  minimum rotated rectangle, whose opposite sides tie). Don't swap any of
  these for generic versions, or the raster drifts from the add-on's.
- Buffers are Clipper's, not GEOS's, so the 25 m ground ring differs at its
  arcs and the ground can move by up to ~0.7 mm.
- The roof surface on the raster is the web app's own. `regularize.ts` grows
  planes, then labels each cell with a plane or leaves it as measured,
  trading how far cells move against boundary length. Anything under about
  0.3 mm across and a 0.2 mm layer tall, printed, goes, and pits narrower
  than 0.3 mm go at any depth. `delatin.ts` and `coarsen.ts` triangulate
  within one cell up and down on flat roofs and half a cell across walls.
  Don't bring back an edge collapse priced against the current faces: it let
  vertices slide down walls until penthouses were pyramids. Spire cells skip
  all of it, keep their upper returns and get a quarter of the error.
- Records are measured in a metric frame at scale 1 and published in lon/lat.
  Generation projects them like any other feature.
- A roof envelope is a `CapSolid` (TIN top, flat underside, boundary walls).
  Section cuts clip the TIN with `clipTin` (CDT arrangement), so caps stay
  closed. `capBoundary` rejects pinched TINs rather than welding them. The
  underside is triangulated from the outline (`undersideTriangles`), with
  outline vertices earcut skips put back, and checked with `capIsClosed`.
- `clipTin` caps Constrainautor's work (`Bounded`) and retries a stuck cut
  with the region moved in slightly. Without the cap, a grazing outline can
  loop forever. It returns an empty TIN when the region misses the surface
  and null only when the triangulation failed, so a section that only the
  cap's box reaches isn't counted as a failure.
- `thinRim` (not in the add-on) removes rim vertices on straight walls after
  the envelope is clipped. It cut roof triangles about four times.
- `src/core` has no LAZ or proj dependency. `src/worker/lidarCodecs.ts`
  installs laz-rs (`@voxelkloud/wasm-codecs`) and proj4 with `setLazDecoder`
  and `setProjector`, for the workers and scripts. Tests use a pass-through
  decoder.
- Batches are plain `BatchJob`s run by a `BatchRunner`: a pool of
  `lidar.worker.ts` workers in the browser, worker threads in the CLI, or in
  the calling thread. Checkpoints and survey choice stay in `prepare.ts`, and
  each building is in one batch per round, so finishing order doesn't matter.
  Workers send downloads to the pool (`lidarProtocol.ts`, `Fetcher.serve`),
  which fetches each file once. Separate caches per worker downloaded
  Chicago's LiDAR about three times over.
- Readers only use range reads that come back whole (exact header, VLR, page
  and node ranges). A server ignoring `Range` is an error.
- Prepared results and batch checkpoints are keyed by the source properties
  the measurement reads, listed in `measuredProps` (`source.ts`). A property
  read anywhere new goes on that list. Catalog answers are only cached when
  they parse, so a maintenance page served with a 200 isn't kept.
- With `preferLidar` off, mapped assemblies with more levels or a shaped roof
  the measurement lacks are kept (`preferSourceDetail`).

LiDAR only (`src/core/dsm/`, design notes in `docs/LIDAR_MODEL.md`):

- The grid is the area's own rectangle in its rotated frame, a cell centred
  on each vertex. Nothing is resampled between reading and meshing. A square
  area turned 90 degrees reads identical cells, which is a good check after
  touching projection or rasterizing.
- The cell is `Detail` over the scale, grown to stay under `MAX_CELLS`, or
  `lidarModel.cellM` with `cellMode` 'metres', which never grows for the
  area (`requestedCell`). That grid is held to `MAX_FIXED_CELLS` instead:
  16.5 million cells peaked at 2.1 GB composing and meshing in one thread.
  Both grow for a sparse survey.
- `compose.ts` is a port of the add-on's `dsm_model.compose` and matches it on
  its prepared Chicago, Philadelphia and Boston grids (float32 flips 1 to 3
  cells per grid on exact thresholds). Keep the rules and their order. The
  deliberate differences: removed trees are ordinary cells again, `inside`
  limits the base to the area shape, water grows into partly wet cells at
  its level and takes in specks (`GROW_M`, `takeSpecks`, for San Francisco's
  2023 survey), a body whose edge is mostly unclassified water-level cells
  grows over those too (`SURFACE_M`, `UNFILED_SHARE`, for New York's
  harbour) and over dead flat ground at its level (`LEVEL_M`, a tile of
  Lake Michigan filed as ground), without clutter small pieces standing
  alone in water go as boats (`clearBoats`, never mostly building or tall),
  and cut water takes its bank's height for `BANK_RINGS` rings,
  then the TIN is clipped along it (the add-on drops cut cells to the bottom
  before meshing). The app defaults to natural crowns (gaps closed, a 3 x 3
  mean over canopy) and keeps what's under 2 m. Slivers (wires, jibs,
  poles) go whatever the settings. `DEFAULT_COMPOSE` stays the add-on's.
- The density probe (`occupiedCell`) counts land as 2 m squares with a
  return that isn't water. The add-on counts any return, which grew the
  Chicago lakefront's cells to 2.08 m. Probe results are saved under
  `PROBE_VERSION`.
- Blocks are counted into cells as they're read (`BlockRaster`), never held as
  points, and checkpointed in the LiDAR cache under `VERSION`. Raise it when
  what a block stores changes. A block with a failed read isn't saved.
- `BlockRaster` keeps each cell's 24 highest returns (and `MARGIN` cells past
  the block) and leaves out floating ones, like the haze 250 to 900 m over
  Houston: layers between 30 m gaps over an open band, too few for a
  surface, with no surface beside them or up to 30 m over them, and not a
  tight surface shared with three neighbours (glass roofs). Sparse patches
  over nothing (a pond) float when everything around is 30 m lower. Check
  changes on the regression areas' raw tops, not only Houston: glass towers,
  stepped roof edges and ledges are what drafts took by mistake.
- Surveys: whole-area coverage first, then `rankOrder`. A cell belongs to the
  first survey whose outline holds it, returns or not.
- The mesher prices collapses by memoryless quadrics against the current
  faces (the add-on's, so stair walls straighten), and also checks every
  collapse against the grid (`GridBound`): no grid point further than half a
  cell from the surface (a cell beside a wall), square to it. Don't drop that check. Without it
  vertices drift until penthouses are pyramids, the reason roof caps moved to
  Delatin. Tiles are simplified in workers with edge points pinned, then the
  seams get their own pass.
- Walls come out ribbed without two extra steps: `fairFaces` straightens
  facade relief under 0.3 mm printed before meshing (in `model.ts`, not
  `compose`, which keeps its parity), and `straightenWalls` puts each wall's
  foot on a line parallel to its straightened roof edge after meshing. A tall
  triangle on a crooked stretch of foot faces its own way, and a row of them
  is the ribs. The cut water outline is simplified at 1.5 cells for the same
  reason.
- The model is one `CapSolid`, cut to shapes, sections and cut water by
  `clipTin`. A water layer is the same cut plus a terrain floor and a water
  prism per piece, at the lowest level of the water it holds. `clipBand` only triangulates the triangles near the outline, and
  a triangle counts as near when an outline edge crosses its box, so both
  triangles on any edge the outline touches are near. Keep it that way or
  the two parts won't meet.
- `lidarModel.waterMode` 'cut' is the add-on's `cut_water` (`cutWater`):
  survey water of at least `water.cutMinAreaM2` (shared with map models),
  water within 40 m counting as one body across bridges, opened to 0.4 mm
  printed, none more than 3 m above the ground (roof pools), and land it
  leaves alone under 4 mm² printed goes too. The one change is that specks
  under `SPECK_M2` are also filled before the opening. 'layer' cuts the same
  way at any size and keeps islands, boats and pilings, since nothing falls
  out.
- Overture water is never the source of LiDAR only water, since its
  polygons run under every bridge and pier (`docs/LIDAR_MODEL.md`). With
  `lidarModel.mapWater` it only fills cells without returns (`mappedHoles`,
  and growth into empty mapped cells), never a hole read as a dark roof, and
  moves cut and layer shorelines onto its outline where that's within
  `MAP_EDGE_M` of the survey's (`followMap`), easing back to the survey's
  line by twice that. The survey decides wherever they part by more. Keep it
  that conservative: taking returns at the water's level took floating docks
  and boats, and mapped pilings under 6 m across became columns at bridge
  deck height until small map islands were ignored. The one exception is
  sea and lake beaches (`followShore`): only bare ground within `BEACH_M` of
  the water, or survey water outside all mapped water with such ground
  behind it, and only strips wholly within `SHORE_M` of the map's line.
- A water layer sits `WATER_DROP_MM` (0.25 mm) under its bank like map
  models' water. `waterDepthMm` is for recessed water only.

Model editor (`src/core/edit/`, UI in `src/app/viewer/`, notes in `docs/HOW_IT_WORKS.md`):

- Edits are keyed by feature, never by mesh: `b:<building>[/<part>]`,
  `r:<segment>`, `br:<segment>` (bridge decks), `w:<water>`, `t:<tree>`,
  `k:<rock>`, `s:<shape>` (`keys.ts`). They carry over when the model is
  generated again with other settings, and edits for things a model lacks
  are kept and ignored. Sizes are printed mm, apart from building heights
  (`heightM`, real metres times `buildingScale`), which have to follow a
  new scale. The document has a `version`: bump it and read older ones
  as far as they still make sense when a field changes meaning. Generation tags solids with `key`/`sub` and fills
  `ctx.objects`, and the mesher records each object's triangle runs for
  picking. Without edits an export uses the generated spec as it is, so
  exports stay byte-identical. Check that on the Loop and Clearwater after
  touching generation.
- `EditSession` applies the edits to the kept `ModelSpec` afterwards. The
  viewer only gets what changed and hides removed objects and colours
  layers itself. Exports mesh `session.edited()`. The worker only runs the
  newest pending edit, and updates carry the model id and edits version so
  a late one for an older model is dropped. An update that throws forgets
  what it sent (`forget`), and the next one carries `reset` and sends
  everything, for the viewer to take in place of what it had. Road tiles
  are rebuilt in a copy and swapped in with their styles: rebuilt in place,
  an export during a slow update (Download right after an undo) read half
  of the undone edit.
- Road edits rebuild square tiles (`roads.ts`, 12 to 30 mm on whole Clipper
  units) from the pieces near them with `bufferRoads`, laid 1 mm past the
  tile and cut to it at the end. Cut first, a motorway's corner poking
  into a tile was under `bufferRoads`' 0.02 mm² specks and went. Other
  tiles keep the generated polygons, split into every tile at once
  (`splitToTiles`): clipping the city-wide road polygon tile by tile took
  over 2 s per edit in San Francisco. A road with its own height or layer
  owns its ground, the taller one where two cross, and the plain groups
  keep what's left of every road there buffered together, in the
  pipeline's order. Buffered without the edited road, a colour edit
  opened the cracks filled between it and its neighbours again.
- Land fill (`land.ts`) lays the land cover again around ground a removed
  road, building or body of water left, from the land regions before
  clearing (`ctx.land`) and what clears them now, opened like the land
  stage, and fills only what that has and the generated slab lacks. The
  vacated footprint opened on its own left bare notches at the slab's
  rounded corners and at a pond's corners, and dropped pieces between
  crossing paths. It's laid per tile in a band 1 mm past what was vacated,
  cached on what the tile and its neighbours had.
- Terrain and water after edits (`earth.ts`): water left out is filled with
  ground on the grid (flattened to its bank for cut water), or with
  `hollow` keeps its recess, a new floor where it ran to the base. What
  stands in the water is recomputed from the edited roads, buildings,
  piers and shapes, and the water re-cut around it. Only ground that was
  kept in the water can go, never land. Once that really changed, judged by
  width (a road along a pier gave back a 0.006 mm² sliver, which an area
  threshold took for rounding), the water and floors are cut from it as it
  is now. Patching the generated regions with an opened copy of what went
  left hairlines of the old outline in the water, and tabs where a road had
  met the bank. Water given back narrower than 0.4 mm and more than 0.4 mm
  from wider water, measured through the water, stays ground: threads
  between a building and the bank, not the corners of open water. Both
  parts are sent whole (100 ms to mesh San Francisco's terrain) when their
  inputs change, and exports use the same solids. Only what nothing holds
  up stands in the water: a shape on a deck cut the water under the bridge,
  or left an island with supports on. What's held depends on the water,
  so `standAll` starts from what was held last time and goes round once
  more when that changed. Water edits are ignored with the water turned
  off, as the inspector lists them.
- A bridge deck is its road's segment (`br:x` and `r:x`), so `editOf` gives
  it the road's removal, layer and width unless it has its own, and
  `removed: false` keeps one whose road is removed. `patchObjects` keeps
  that flag through later changes to the bridge. Decks are built again
  from their centrelines at a new width (`DeckPiece`), and piers are cut
  to a narrower deck.
- Custom layers export as `layer:<id>` (building rank) and
  `layer:<id>:water` (water rank) with a `PartColour`. Shapes in a model
  colour export as `added-<group>` with building rank, so a water-coloured
  shape never takes an overlap from the terrain. A shape is built down to
  what it stands on and no further (`stand.ts`): a building, deck or shape
  under its raised base, else the ground, and in water down through it to
  the floor or base with the water cut around it. Running every shape to
  the base cut a column through anything under it, and a column through a
  building changes filament on every layer. Drawn roads, outlines, boxes
  and cylinders get ground kept under them in water with supports on, like
  the structures they stand for. Text and pins never do. A raised shape
  never follows the ground (`followsGround`), it's flat on what it was
  raised onto. Text follows the ground by default, and put on a roof its
  letters ran from the street up through every layer of the building. A
  shape on the ground dragged into a building gets the buried note too,
  worked out apart from its signature (`buriedOnGround`). A raised shape
  moves with what it stood on or over as generated (`supportShift`): a
  taller roof takes it up, and once the building goes it comes down to
  what's under that. Its lift stays what it was when placed.
- Sloping bridge decks hold shapes in squares (`deckSquares`), quartered
  while the top rises more than a third of the deck's thickness across one.
  Whole, a span high over a shape held it because its ramp reached the
  ground elsewhere, and the shape hung under it. Something sunk into a deck
  stays above its underside. `standPieces` only takes each holder's region
  from those overlapping it: taking every region from what was left cost 9 s
  for a 30 mm title over San Francisco.
- What a shape stands on is kept between updates. Its signature takes the
  water only inside its own box (`wetKey`): with the earth's own key, one
  shape moved in water spanning the model built all 500 again (3.6 s).
  What holds a flat shape up is kept apart from the water and its own
  height (`heldPieces`, `restPieces`, `heldAt`): a box over downtown San
  Francisco stands on 9,000 roofs. The session's meshes keep their caps by
  polygon (`CapCache`), so a taller shape doesn't cut its ground from the
  lattice again. `standCache.test.ts` holds a long-lived session to a new
  one given the same edits.
- A LiDAR only model has no water to edit, but shapes over its water go down
  to the floor, or through a cut to the base (`surfaceWater`). The pieces
  are opened by a micron (`openSlivers`): where the shape's outline and the
  water's nearly met, the slivers left made Constrainautor loop on the
  draped top, and the shape was missing from the export.
- A height edit scales everything above the building's ground
  (`heights.ts`). A part's own height beats its building's. A raised part
  left on air by a removed or lowered part is built down to the ground
  (`settle`), the way `groundRaisedParts` builds them. Group edits by
  building once per update (`reshaped`): scanning every edit per building
  took five minutes with a box around San Francisco. A building's own
  height counts from the parts left, or taking out its tallest left it short.
- The UI holds edits to the limits saved edits and exports do: 500 shapes,
  heights from drags (`buildingHeightRange` for buildings at the model's
  scale), 2000 points, 80 characters. Past them the inspector showed things
  the export clamped or dropped.
- A drag follows the pointer that started it (`editController.ts`). A
  second finger during a touch drag puts the drag back (`revertEdits`) and
  hands both fingers to OrbitControls, with a synthetic `pointerdown` for
  the first, which the controls never saw. Only the arrow's shaft and head
  take a height drag, and seen from within about 17 degrees of straight
  down the arrow is put away: end on it covered the middle of the shape,
  and a pixel moved it by metres. OrbitControls sets an inline
  `cursor: auto` when it connects, which `ViewerEngine` clears or no edit
  cursor shows.
- The size chip, the sidebar's size and Reset view go by what the view
  shows (`ui.shownBounds`), so a raised tower counts. The bed stays under
  the generated bounds.
- Undo steps hold what they changed (`history.ts`), not a copy of the
  edits: after an edit reaching every building in San Francisco, a copy per
  step held 630 MB after a hundred small ones. Pass the keys a change wrote
  to `commitEdits`, or every key is compared. A step keeps a `WeakRef` to
  the edits before it, which undo returns while something else holds them.
- Exports can be cancelled and a stuck edit update stopped
  (`cancelExport`, `stopEdits` in `engine/client.ts`). An update can't stop
  part way, so stopping one replaces the worker and the model has to be
  generated again, which the viewer says. A generate asked for behind an
  edit or export waiting over 10 s replaces the worker too, or it queued
  behind a loop for good.
- Text notes say when its font didn't load (warned once per font, not per
  edit) and which characters the font has no glyph for. No bundled font
  has Hebrew or Arabic. `visualOrder` lays right-to-left text out for
  fonts that do, custom SVG title fonts for now, and leaves Arabic to
  opentype.js, which reverses and shapes it itself.
- The view and the export are separate code, so they can disagree. The
  view hides and colours by `shown.ts`, and `ComposedMesh` only rebuilds
  its index when the styles change, with hidden marked apart from the
  part's own colour (`''`). Joined as plain strings the two matched, and
  removed buildings stayed on screen. `scripts/fuzz-edits.ts` holds the
  export to `shown.ts` volume by volume, and `e2e-edit.mjs` checks the
  view changes when something is removed. A hidden part is hidden entry by
  entry, never as a mesh: what's in a custom layer shows and exports with
  the layer (`entryColour` with the part id, `excludedParts` in
  `session.ts`). The fuzzer compares with random parts hidden too.
  `downloadParts` only counts a custom layer when something this model has
  is in it, since edits from other areas are kept. The
  client's copy of edit geometry (`model.ts`) is keyed by part and key,
  since a bridge's deck and piers share a key.
- Edits and SVG picks are saved under keys of their own
  (`persist.ts`), so running out of space for them doesn't stop the
  settings saving, and a failed save is shown once. Share links carry them
  deflated (`e=`, `p=`, `shareLink.ts`) up to `MAX_LINK_EXTRA`, and only
  what's on the linked area (`linkScope.ts`). Object edits go only with a
  model of that area that has them, since their keys don't say where they
  are. Reading one back is capped (`MAX_UNPACKED`): a crafted 117 KB link
  inflated to 700 MB, and it crashed the tab again on every reload.
- Edits are one document for every area. A share link or options file adds
  its edits and picks to these (`bringIn`, `mergeEdits`, `mergePicks`),
  never replaces them. What it changed goes into the one backup
  (`BACKUP_KEY`), like what `Undo all`, `Undo all picks` and the crash
  reset clear, and `BackupNote` offers it back. A tab writes edits and
  picks only once it changed them (`written` is seeded at load) and takes
  on another tab's saves (`storage` in `sync.ts`), dropping its undo
  steps. An idle tab closing used to write its old copy over the other
  tab's, and a broken settings key made the next save wipe them.

SVG maps (`src/core/svgmap/`, UI in `src/app/svgmap/`, notes in `docs/SVG_MAPS.md`):

- The engine is SVGmap's, moved with its tests. At the merge, live renders of
  the Chicago Loop were byte-identical to SVGmap's for laser, plotter and
  print. Hexagons were added (`layout/shapes.ts`, `availableWidthAt` in
  `text/label.ts`, the plotter band in `compose.ts`).
- In SVG mode the area is the piece's map window: `fitAreaToPiece` gives it
  the window's proportions and corner radius and sets `svg.scale` (1:n) from
  its width, or its width from the scale when `scaleLocked` (`Fixed scale`,
  on by default at 0.05 mm/m). The panel shows the scale in mm/m but it's
  stored as 1:n. Every area or piece change goes through it in the store.
  The shape is shared with 3D.
- Area sizes are rounded to the centimetre (`lib/area.ts`), not the metre,
  so a typed 1:5,000 on a small piece stays 1:5,000.
- The box on the map uses the ENU `Projection`, the engine Web Mercator at
  the centre. The piece overlay on the map is one affine transform from
  where the area's axes land (`AreaEditor.layout`).
- The live preview re-renders whenever the settings key differs from both
  the result's and the last tried key (`svgmap/render.ts`), so a failed or
  cancelled render isn't retried until something changes. The action bar
  offers the retry instead.
- Every number in the SVG settings has its range in `core/svgmap/limits.ts`.
  The panels offer it, share links, saved and imported settings are held to
  it, and the engine clamps again: a hand-edited dense window hung the line
  cleanup. Ranges have to hold what the app works out itself too (line
  spacing from a 3 mm pen, a hexagon's height, the scale of a tiny or huge
  piece), which `settings.test.ts` checks.
- The SVG worker acknowledges each message by sequence number. One busy
  with a render that doesn't answer a newer render or a cancel within 8 s is
  stuck in a loop and is replaced (`svgmap/render.ts`). Only an ack for the
  message the watchdog waits on, or a later one, clears it.
- Plotter files put every layer of one pen together, so `compose` sorts the
  drafts by pen before ordering paths and adding up travel.
- Tiles and the window box are cut with `clipToRect`, not the `rectClip`
  SVGmap used, so renders are no longer byte-identical to SVGmap's. A
  polygon crossing a tile edge is unioned in `decode.ts` right after its
  clip. The clip's edges back and forth along the tile edge cancel at tile
  resolution but not once a rotated map rounds them, and they left hairline
  cracks along the seams.
- Share links: `#a=...&o=svg`, and a copied link adds `s=` (settings that
  differ from the defaults, base64url JSON). An area without `o=` opens as
  a model, whatever mode the recipient was in. Old SVGmap links (`#s=` with
  the area inside) still open. The `s=` part is dropped from the address
  bar once read.
- Routes (`routes.ts`): OpenFreeMap has no ids or names on road lines, so
  picks are kept as lon/lat lines and matched to the prepared lines before
  the line cleanup, which then never thins a route. Picks nothing matched
  come back as `missingPicks`. The `s=` part of a share link leaves
  `routes` and `hiddenLines` out, and `p=` carries them. Options files
  keep them only with the map area, sanitized rather than checked, and all
  picks together are held to `MAX_PICKED_POINTS`. Assigning lines takes
  them out of wherever they were with `withoutLines`, which only compares
  lines whose boxes touch: comparing every pair froze the page for 13 s
  with 2,000 picked.
- Titles (`text/label.ts`, `text/place.ts`): a box goes to the nearest
  spot that fits its position, flush along a flat edge, or with its corner
  on a circle's rim. Walking it towards the centre, as SVGmap did, left
  corner boxes floating mid-map and both lower corners of a circle in one
  spot. Rectangles come out as before. A dragged title is an offset from
  that spot (`offsetX/Y`, `bandOffsetX/Y`), and the layout returns the
  offset it ended up at once clamped, which is what a drop stores. Drags
  lay the title out on the main thread (`layoutWith` from
  `useLabelArtwork`) and only write the store when let go. Resize handles
  (`labelDrag.ts`) set `size`, `boxWidth`/`boxHeight` (along the text, at
  100%) or `bandHeight`, then move the result so the opposite side stays
  put. Across a side handle the offset is left alone, or a box flush with
  the bottom came away from it as its height followed the shrinking text.

## Verification

```powershell
npm test                     # vitest, offline
npx tsc --noEmit
$env:NETWORK=1; npx vitest run src/core/data   # live data tests
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --out out/loop.3mf
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --lidar   # point cache in out/lidar-cache
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --lidar-only --out out/loop-surface.3mf   # --water-layer or --cut-water, --no-map-water
npx tsx scripts/check-bambu.ts   # round trip through installed Bambu Studio (isolated data dir)
npx tsx scripts/fuzz-edits.ts --preset "Chicago - The Loop (small)" --steps 40   # random edits, exports checked against the view (--bridges, --no-supports, --through)
npx tsx scripts/generate.ts --options out/fuzz/<failed step>.json --out out/repro.3mf   # an options file, edits and all
$env:NETWORK=1; npx vitest run src/core/svgmap/e2e.test.ts   # SVG maps from live tiles ($env:SVG_OUT to keep them)
node scripts/e2e.mjs http://localhost:4173/ out/e2e-svg --svg --all-formats   # SVG map in Edge
node scripts/e2e-edit.mjs http://localhost:4173/ out/e2e-edit   # the editor in Edge, --phone and --svg too
npm run build                # site into build/ (not dist/, which holds old add-on archives)
```

For geometry work check closure and winding (`edgeReport`, `signedVolume`)
on real presets (Chicago Loop, Clearwater, Rome, San Francisco), and look at
renders. `scripts/shot.mjs` screenshots the dev server with the installed Edge.
Regression areas are fixtures, never reasons for location-specific code.
LiDAR only output can be compared against the Micropolitan reference STLs in
`examples_and_inspiration/` (git-ignored).

Machine-local folders carried over from the add-on (`scratchpad/`, `dist/`,
`.venv-overture/`) are ignored and unrelated to the web app.

# Writing style

This applies to code comments and anything public like READMEs, docs, and PR descriptions. Write like the developer who built the project leaving useful context for somebody else. Do not write like a technical writer, tutorial author, or AI documenting everything it found in the codebase.

My older READMEs are the main reference for tone: pre-2024 versions in `jarvisar/solar-system`, `sorting-algos`, `interpreter`, `exoplanet-classifier`, and `senior-design`. Don't use newer repos as a style reference since some of those were AI generated.

## General

- Plain, direct, and practical. Use normal words.
- Don't try to sound polished. Slightly casual or imperfect wording is fine if it sounds natural.
- Keep sentences fairly short, but don't force every sentence into the same length or pattern.
- Write what is actually useful to know. Do not document something just because you found it in the code.
- Prefer a few important details over exhaustive coverage.
- Don't systematically explain every subsystem, edge case, fallback, constant, or implementation decision unless the document actually needs it.
- Avoid giving every section the same amount of detail. Some things may need a paragraph, some need one sentence, and some do not need mentioning at all.
- Don't turn code inspection into an encyclopedia of how the project works.
- Assume the reader is a developer. Obvious implementation details usually don't need explanation.
- Focus on things I would realistically remember being worth mentioning: weird behavior, important constraints, decisions that are easy to misunderstand, useful examples, and limitations.
- Concrete numbers and implementation details are good when they matter, but don't dump constants into documentation just because they exist.
- Explain why something works a certain way only when the reason is useful or non-obvious. Not every behavior needs a justification.
- It's fine to say things like "currently", "for now", "I ended up doing this because...", "this is a little weird", "we don't want...", or "this should still..." when natural.
- First person is fine when talking about a decision I made. Don't artificially rewrite everything into detached authoritative prose.
- If something is uncertain, unfinished, hacky, or likely to change, say that normally instead of making it sound finalized.
- Keep structure proportional to the amount of information. Don't invent categories, terminology, or sections just to make the documentation look complete.
- Don't add an intro or conclusion unless there is actually something useful to say.
- Don't repeat a point in prose after already showing it in a command, example, heading, or list.
- No em dashes, semicolons, emojis, arrows, bold scattered through sentences, or overly decorative formatting.
- Avoid AI writing patterns like "it's not just X, it's Y", rhetorical contrasts, fake enthusiasm, title-restating intros, "Overall..." conclusions, repeated summaries, or filler words like powerful, seamless, robust, comprehensive, sophisticated, and elegant.
- Avoid repetitive explanatory constructions like "This ensures...", "This allows...", "This means...", or "This prevents..." paragraph after paragraph.
- Don't make every statement sound absolute. Human-written project docs are often scoped to how the project works right now.
- When in doubt, write less.

## READMEs

- Open with one or two normal sentences saying what the project is. For example: "This is a simple proxy server that adds the necessary headers to allow Cross-Origin Resource Sharing (CORS) for a specified website." or "My first real Three.js project."
- Link the live build if there is one: "Visit the [GitHub Pages site](...) to access the latest deployment."
- Don't explain the entire architecture unless the project actually needs an architecture section.
- Prefer documenting what somebody needs to run, use, understand, or modify the project.
- Controls and usage should be short and direct: "Use W/S to increase or decrease throttle. Use A/D to roll. Press the escape key at any time to exit flight mode."
- State limits plainly: "Currently the maximum amount is 512." or "Note that large searches can take up to 15 seconds to process."
- Small side notes can go on an h6 line: "###### Note: Assembly generator currently only supports integers"
- Common sections are Usage or How to Use, Features, Local Installation, Known Issues & Limitations, Screenshots, and Credits, but only add them when they are useful.
- Don't force every README into the same template.
- Title Case headings. `&` is fine in titles.
- Backticks for buttons, keys, files, branches, and commands.
- Keep it short. Most of my older READMEs were around 250 to 550 words. Bigger projects can be around 1,200 to 1,500, but don't aim for a word count if there isn't that much worth saying.
- If a technical detail is easy to find by reading one function, it probably doesn't belong in the README.
- A README can leave implementation details out. It does not need to prove that every part of the project was considered.

## Technical docs

- Technical docs can be more detailed than the README, but still shouldn't read like generated reference documentation.
- Start from the reason the document exists, not from a desire to describe the whole system.
- Don't automatically create one section per subsystem.
- Don't walk through the entire pipeline in order unless understanding that sequence is the point of the document.
- Mention source files where they are genuinely useful for finding the implementation, not after every paragraph.
- Avoid exhaustive lists of thresholds, fallback rules, caches, data sources, and special cases unless those details are the subject of the document.
- Examples and odd cases are often more useful than a complete formal description.
- It's fine for a technical document to say "The rest is handled in `foo.ts`" rather than explaining every step.
- Leave out details that are likely to become stale unless they are important enough to maintain.
- Don't make the implementation sound more deliberate or formally designed than it really was.

## Code comments

- Keep comments sparse.
- Only comment non-obvious logic, reasons behind a decision, edge cases, limitations, unusual behavior, or something another developer might be tempted to "fix".
- Don't narrate straightforward code or restate the function name.
- Don't add doc blocks just because a function is public.
- Don't explain every branch of complicated code. Comment the weird part or the reason the code has to be complicated.
- Fragments are fine.
- Comments can sound like quick developer notes rather than miniature documentation paragraphs.
- Good: `# Use WSL to run the commands if on Windows`
- Good: `# If the input contains an equal sign, skip code generation`
- Good: `// Keep this separate from the road union or tiny paths disappear`
- Bad: `// This ensures that the road geometry is correctly processed before proceeding to the next stage.`

# Attribution

Never list Claude or any other AI tool as an author or co-author. Do not add `Co-Authored-By` trailers, "Generated with" lines, session links, or AI names to commits, pull requests, author fields, maintainer fields, or copyright notices.

The user (`jarvisar`) is the sole author and should appear as the sole contributor on the GitHub repository.
