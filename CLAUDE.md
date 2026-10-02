# Jarvizar City Model (web): shared agent context

Read [AGENTS.md](AGENTS.md) for development principles. Implementation,
configuration and tests are authoritative. Keep transient results out of here.

## What it is

A browser-only app (Vite + React + TypeScript, deployed to GitHub Pages) that
turns a map area into a multicolour FDM city model: terrain, water, land
surfaces, roads/rail, optional schematic bridges and trees, and buildings with
roofs from Overture Maps. It is a port of the Jarvizar City Model Blender
add-on (separate repo `3dmapcreator`, not a dependency). Its LiDAR pipeline
reads EPT, COPC, Esri I3S scene layers and plain LAZ/LAS tiles (also inside ZIPs) straight from
publishers that allow cross-origin requests (`docs/LIDAR_SOURCES.md`).
Surveys that only come as whole files are offered and read once the user
approves their tiles, like the add-on's staged downloads (`lidar/offers.ts`). `settings.modelSource = 'lidar'` (LiDAR only) builds the whole model from
a survey instead, as one solid in the terrain colour, with the water as its
own part if asked and Overture's water only for shorelines and holes
(`src/core/dsm/`).
There is no server of our own, apart from an optional CORS proxy (`proxy/`, a
Cloudflare Worker) for LiDAR files on a fixed list of hosts without CORS
headers. Everything else is read from public, CORS-enabled sources.

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
| `src/core/lidar/` | LiDAR: `sources/` one module per provider (`common.ts` has the shared catalog helpers), `read/` EPT, COPC, I3S, plain LAZ/LAS and ZIP reading (`ept.ts`, `tiles.ts`, `i3s.ts`, `chunks.ts`, `zip.ts`) with an injected LAZ decoder and projector, measurement (`measure.ts`, ground, planes, terraces, selection), roofs cut from the LiDAR only surface (`surface.ts`, `rim.ts`), `prepare.ts` batching and checkpoints |
| `src/core/pipeline/` | Generation stages: water, roads (+linework, airports, bridges, `network/` tidy), land, buildings (+`buildings/` selection, heights, roofs, printability), trees, orchestration (`generate.ts`), meshing, plates, row filter |
| `src/core/export/` | Bambu Studio project, PrusaSlicer project, generic 3MF, STL, zip streaming, section grid |
| `src/core/edit/` | Model editor: the edits document (`types.ts`, `keys.ts`), `EditSession` applying it to a generated model in the worker, road tiles, land fill, terrain and water after edits (`earth.ts`), added shapes and what they stand on (`stand.ts`), drawn roads on LiDAR only models (`drawn.ts`, `surfaceCut.ts`), road edits by block (`blocks.ts`), road lines for picking |
| `src/core/tracks/` | Imported routes ("tracks" in the code, so they don't clash with the SVG maps' picked-road routes): reading GPX, KML, KMZ, TCX, GeoJSON and FIT (`parse.ts`, `fitfile.ts`), encoded polylines, snapping to roads (`snap.ts`), framing the area (`frame.ts`), start and finish markers. Map models lay them out in `pipeline/tracks.ts`, LiDAR only models rest them on the survey in `dsm/route.ts` |
| `src/core/engine/` | Worker protocol and main-thread client |
| `src/worker/engine.worker.ts` | Downloads, generates, meshes and exports off the main thread |
| `proxy/` | The LiDAR CORS proxy, a Cloudflare Worker: only the URLs `PROXIED` in `src/core/data/corsProxy.ts` matches, only the site's origins, GET and HEAD, bodies streamed |
| `src/worker/svg.worker.ts` | Renders SVG maps, separate so a preview updates while a model generates |
| `src/core/svgmap/` | SVG maps: tile fetch/decode/stitch, piece layout (`layout/`), line cleanup (`lines/`), fills and hatching, titles (`text/`), SVG writer, `service.ts` (the render with its caches) |
| `src/app/` | React UI: state (zustand), MapLibre area editor, panels, three.js viewer. The model editor is `viewer/editController.ts` (pointer tools), `picker.ts`, `highlight.ts`, `shown.ts` (what the view hides and colours), `viewer/edit/` (toolbar, inspector) and `state/editActions.ts` (edits, undo). `state/undo.ts` is undo for everything else. `src/app/svgmap/` has the SVG sections, preview, render client, route picker, piece fitting and share encoding |
| `scripts/` | `generate.ts` (CLI end to end, `--options` for an exported options file with its edits), `fetch-area.ts`, `bench-synthetic.ts`, `check-bambu.ts`, `fuzz-edits.ts` (random edits, exports checked), `shot.mjs`, `e2e.mjs`, `e2e-mobile.mjs` and `e2e-edit.mjs` (browser runs in the installed Edge) |

## Pipeline rules worth preserving

- Everything samples one `HeightField`. Never sample the DEM directly in a layer.
- Terrarium voids (-32768) and seabed garbage (specks down to -15,000 m, some
  on land) are filled in the mosaic before anything samples it
  (`repairElevation`). One bad pixel set the base for the whole model:
  Waikiki came out a metre tall. Only pixels below sea level dropping far
  more steeply than ground can are touched, so polders, mines and the Dead
  Sea are left alone. Reclaimed land over old seabed (Singapore, Dubai)
  isn't garbage and still adds a few mm of base. Tiles the server doesn't
  have read as sea level but are left out of both the test and the fill, or
  seabed beside one counted as garbage.
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
  ring's edge) are shrunk by 1e-4 mm and retried (`PINCH_MM`). Pieces still
  pinched or failing are shrunk again by 5e-4 and 1e-3 mm (`SHRINK_STEPS`),
  and a draped piece that still fails gets a flat cap rather than being
  dropped: after ordinary edits, Venice's main ground piece (most of the
  terrain) failed after one shrink and went missing from the export. Never
  weld by coordinate. A cap cut to a print section gets the same retry, for
  a section line through a concave corner of its outline.
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
  footprints are cut out of slabs, and the rest is kept as mapped. Only
  rounding under 2 µm goes (`openSharp`, mitred and clipped to the slab,
  so corners stay sharp and edges stay on the roads that cut them). Opening
  by 0.1 mm and dropping pieces under 0.1 mm² left about 3% of the land
  cover as bare terrain, pockets between paths and strips beside roads, and
  filled holes under 0.025 mm² over small buildings. Above 250 mm this runs in 50 mm tiles with a 1 mm margin (`tiled`), so
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
  after it. It takes out the repeated points and spikes it leaves where a
  ring has a vertex on the cut line: Clipper's union lost area beside them
  (17% of rings in a fuzz, a 0.065 mm² sliver of park at an editor tile
  seam). Clipper's own `intersection()` is right on simple rings but not on
  self-intersecting ones, so check against sampled winding numbers there.
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
- Progress is planned in seconds (`pipeline/estimate.ts`, `Progress.plan`)
  and the bar is the share of that time done, shared out again when an
  estimate changes so it never goes back. A step that can take more than a
  moment needs its own `begin` and an estimate, and its fraction should
  follow time, not item counts (meshing goes by `meshCost`, not solids).
  Code that can't yield can still `report`: the worker's messages go out
  mid-call. Fixed shares had meshing at 10% of the bar for 40% of the time.

Imported routes (`src/core/tracks/`, `pipeline/tracks.ts`, `dsm/route.ts`, UI in
`panels/RoutesPanel.tsx` and `state/tracks.ts`):

- Routes are user data like the edits: one list for every area, saved
  under their own key (`TRACKS_KEY`), in undo's `Setup`, added to (never
  replaced) by links and option files (`mergeTracks`), and only the ones
  on the area go in a link (`tracksForArea`, `t=`) or an options file. A
  link simplifies them up to 12 m to fit (`packTracks`). Lines are stored
  as encoded polylines, simplified to 1 m at import and to at most 10,000
  points. The visible ones go to the worker decoded, and they're part of
  `modelKey`, not `snapshotKey`, so offers don't go stale with them.
  Only 3D models build them for now: SVG maps have picked routes instead.
- They never go through the road tidy. `settings.tracks.snap` (on by
  default) matches a recording to the roads with an HMM (`snap.ts`): a
  sample every 10 m, candidates within 40 m, and an off-road state that
  costs as much as a road 24 m away plus 4 to switch, so an unmapped trail
  stays as recorded. Map models snap to the road lines as tidied, decks
  included, so the route sits on the printed road. LiDAR only models
  download every road and path segment for it (`loadMapWater`).
- Map models: a ribbon of `widthMm` at `heightMm` over the ground (0.8,
  a layer over 0.6 mm roads), draped like roads, keyed `rt:<id>` and
  described for the editor. Roads, rail, paths and land cover are cut away
  under its ground, as land is under roads, so an STL (no part order) or a
  slicer that ignores the order still prints the route over them. Airport
  paving only gives way by order. The editor's road tiles and land fill give
  them back when the route is removed (`RoadTiles` cuts, `ground` on its
  object). Its layer comes after roads, land and decks
  and before buildings, so where GPS drifts into a building the building
  keeps the overlap and its walls stay its colour. Buildings aren't cut out
  of it: at a small scale a route 27 m wide was shredded into dashes by the
  houses either side, and over a low building its top stays whole. A deck
  it runs along (`carries`, 60% of it within 30
  degrees) carries it at the deck's top plus what it stands over a road,
  over the route's whole width, or strips beside a narrower deck stood on
  the water and kept ground. Decks it only crosses are cut out. Over cut
  water it keeps ground like a road (`kept.tracks`, which goes with the
  route if it's removed in the editor), or wades with supports off. Trees
  avoid it. Without routes the model is unchanged.
- LiDAR only models: a route rests on compose's bare ground grid
  (`ground`), never the surface, which a
  drifting track climbed every roof and crown of. Trees and clutter under 2 m
  are cleared to the ground along it first (`clear`, the ribbon plus a cell
  either side), so it shows through parks. Raised stretches (over 2.5 m) it
  rides only when the surface rises gently (25% over two cells, the sheer
  drop at a deck's side to the water left out): decks and ramps yes, walls,
  crowns and overpasses no. A non-building structure over it for 40 m or
  more carries it on top at a 30 m running median (Chicago's L along Wells
  hid six blocks), only in surveys that file buildings. Over water it rests
  on the recess or the layer, and pieces over water cut through the base
  are left out. Steps become 45 degree ramps. The route is listed before the
  city, so under a roof the city keeps the overlap, as the view shows it.
  Its underside goes 1.5 cells under the surface to reach the meshed TIN.

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

- Measurement's checks (ground, coverage, contradictions, selection) are a
  port of the add-on's `lidar_*.py` (algorithm 29). `geos.ts`, `centroid`
  and `rotate` follow GEOS 3.13 and Shapely to the bit (the coverage grid
  follows the minimum rotated rectangle, whose opposite sides tie). Don't
  swap any of these for generic versions, or the checks drift from the add-on's.
- Buffers are Clipper's, not GEOS's, so the 25 m ground ring differs at its
  arcs and the ground can move by up to ~0.7 mm.
- Roofs are cut from the LiDAR only surface (`surface.ts`): each batch's
  returns go into the area's LiDAR only cells (`BlockRaster`, same `Detail`
  or cell size, `lidarModel`'s setting), through `composeSurface` and
  `fairFaces`, and each building is meshed from its cells with
  `surfaceLimits`, `wallDetail`, `meshGrid` and `straightenWalls`. Keep
  the two on the same code, so a measured building looks the way it does in
  a LiDAR only model. The old roofs (planes, a 0.3 mm x 0.2 mm tidy, Delatin)
  looked bare next to it and were removed in October 2026.
- What map models add: band cells under 2.5 m over the building's ground take
  the nearest roof's height and the roof is carried past the outline
  (`carryToOutline`, `spread`), so the walls stand on the mapped outline;
  a taller mapped neighbour's facade inside it comes down (`neighbourFacades`);
  trees are taken off (trees 'off'). Batch cells never grow for the area.
- Records are measured in the area's own frame (rotation included) at scale 1,
  so batch cells line up with a LiDAR only model's, and published in lon/lat.
  Generation projects them like any other feature. Only buildings within 5 m
  of the area's own outline are measured, not everything in the lon/lat box
  around a turned or round area (Chicago turned 30° measured 77 buildings
  for the 37 it used). Points are still read as far out as before.
- A measured roof is a `CapSolid` (TIN top, flat underside, boundary walls).
  Section cuts clip the TIN with `clipTin` (CDT arrangement), so caps stay
  closed. `capBoundary` rejects pinched TINs rather than welding them. The
  underside is triangulated from the outline (`undersideTriangles`), with
  outline vertices earcut skips put back, and checked with `capIsClosed`.
- `clipTin` caps Constrainautor's work (`Bounded`) and retries a stuck cut
  with the region moved in slightly. Without the cap, a grazing outline can
  loop forever. It returns an empty TIN when the region misses the surface
  and null only when the triangulation failed, so a section that only the
  cap's box reaches isn't counted as a failure. When both tries fail it cuts
  once more with vertices merged and snapped to edges within 3e-5 mm, inside
  a frame of far points: a LiDAR only cap already cut along its water has
  vertices millionths of a mm apart, and cutting it again for a section
  threw. Clips that work never reach this, so their output is unchanged.
- `thinRim` (not in the add-on) removes rim vertices on straight walls after
  the roof is clipped to the footprint.
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
  Chicago's LiDAR about three times over. Each worker says `ready` once its
  script has run. Only one that never did and fails without a reason is
  taken for a tab left on an old version (`onStale`): a mesh tile says
  nothing until it's done, and a worker lost on one was told to reload.
- Readers only use range reads that come back whole (exact header, VLR, page
  and node ranges). A server ignoring `Range` is an error.
- Prepared results and batch checkpoints are keyed by the source properties
  the measurement reads, listed in `measuredProps` (`source.ts`). A property
  read anywhere new goes on that list. Catalog answers are only cached when
  they parse, so a maintenance page served with a 200 isn't kept, and
  neither is an ArcGIS error (`{"error": ...}` with a 200). Whole files are
  checked too before they're cached (`BodyCheck`): Helsinki answers a
  missing sheet with a 200 and a line of text, and an I3S node with JSON.
- With `preferLidar` off, mapped assemblies with more levels or a shaped roof
  the measurement lacks are kept (`preferSourceDetail`).

LiDAR sources (`src/core/lidar/sources/`, notes in `docs/LIDAR_SOURCES.md`):

- A publisher is only usable when its index and its files both answer
  cross-origin requests, or go through the proxy. Check in a real browser
  (fetch from another origin, plainly and with `Range`): curl headers misled
  more than once, and redirects need CORS at every hop. For the proxy, check
  from a server with its User-Agent and no cookies instead. The doc lists
  what was checked and why it isn't used, so it isn't checked again.
- Each provider has `areas` and is only asked inside them. `discover` gives
  each one a deadline (90 s, NRCan 180, Salzburg 240) and marks its failures
  as searches, which the worker words apart from failed reads. One that ran
  out its deadline is left out for 5 minutes of the session (`search.ts`),
  or every Generate waited for it again. Catalogs are kept a day, and a
  failed one is answered from a copy up to 30 days old.
- `read/tiles.ts` reads what a tile's header says. Plain LAZ goes through
  laszip's chunk table (`chunks.ts`, the arithmetic coder ported and checked
  against laz-rs on a real NRW tile and a swisstopo COPC). The first read of
  a tile decodes every chunk and saves each chunk's box as a Fetcher note.
  Later reads fetch only the 8 MB runs they need. Runs are fixed per file so
  they come from the cache.
- ZIPs: a stored member is read in place by range (Luxembourg's COPC). A
  deflated member is fetched in pieces six at a time (4 MB, 16 MB through the
  proxy, which counts requests) and inflated as they arrive, never held
  compressed: LAZ into its output (up to 768 MiB, Texas's members reach
  830), LAS cropped on the way (`readStream`), so a 2.9 GB Brussels tile is
  never held. `whole` tiles (Helsinki, Poland) ignore Range and come in one
  download. Whole tiles and inflated LAZ members are held once by the
  pool's Fetcher (`held`) for every block that reads them, up to a GB (less
  where the browser reports less memory), and let go when meshing starts.
  Each worker inflating its own copy of a Texas member ran the tab out of
  memory, and DC's 300 MB tiles came down once per block.
- `wktOf` ignores a WKT record that isn't one (GUGiK's las2las sheets have
  `''`) and unquotes one LAStools wrote as a JSON string (Estonia 2024), so
  the GeoKeys decide. `wktEpsg` only takes the CRS's own code: deeper ones
  are its unit's (9003 in Anchorage's ESRI WKT) or its geographic CRS's
  (6783 for NOAA's NAD83(CORS96) / UTM zone 10N, which has no code and is
  read through its WKT).
- `crs.ts` definitions were checked against PROJ at three points each. Don't
  copy towgs84 strings from epsg.io's newer exports: its RD New is a
  Molodensky-Badekas set, which proj4 reads as arcsecond rotations, and all
  Dutch LiDAR sat 170 m off. Krovak's 3-parameter shift was 8 m off.
- Flai's README lags its bucket: the provider also lists the bucket's
  folders for countries near the area, skips its copy of IGN (read
  directly), finds the index-less PNOA 2022-2025 by tile name, only inside
  each block's region (`PNOA_REGIONS`), and gives Navarra 2017 tiles their
  own classes. The same tile numbers name a square 6 degrees away in the
  next zone, and Aragón's tiles turned up at Bragança.
- Grids were checked against real files, not taken from the research:
  Luxembourg's 2024 blocks start at Y 55000 (member names give the top
  edge), and Japan's index polygons are cut at vector-tile edges, so a
  sheet's pieces are merged.
- LiDAR only block and map batch checkpoints are keyed by the tiles each one
  reads, so one read while a catalog lacked a tile isn't kept for good. EPT
  surveys have no tiles and keep their old keys.
- Whole-file surveys (`staged`: format 'LAZ', which covers plain LAZ and
  LAS, ZIP members and `whole` files) are never downloaded without the
  user's approval, as in the add-on. EPT and COPC are read as before.
  A staged survey that would be read becomes an offer (`offers.ts`): for
  buildings nothing else measured (unless the rejection is one no survey
  would change), or for ones it beats by the add-on's margins, five years
  newer or twice as dense and two returns more (`advantage`). A building
  another survey read and rejected is only offered when the staged one has
  that `advantage` over it, and each building comes from one staged survey
  at most, the first in reading order. São Paulo was offered
  OpenTopography's copy of the flight it had just read. A LiDAR only block
  offers it where it would fill 2% of the block nothing else does.
  Approval is per tile (`tileKey`), kept in the LiDAR cache by the worker
  (`approvedTiles`) and saved again after each read, since a big download
  pushed it out of the LRU. A larger area asks again for its new tiles only
  and clearing the cache asks again for everything. The CLI's
  `--download-tiles` approves everything.
- Checkpoints with an offered survey in them are used without approval,
  since they cost nothing. A LiDAR only block read without one is saved
  under a key that marks it skipped, so approving it reads the block again.
  Saved and session results with an offer stand until one of its tiles is
  approved (`reopened`).
- Before offering, one tile's header is read by range (`checkTile`) and a
  survey that couldn't be read anyway is a failure instead:
  OpenTopography's Indiana tiles have no height units and are 300 MB each.
- A LiDAR only model with nothing to read but offers throws `OffersError`,
  whose offers reach the UI with the error (`offeredTiles` in the client).
- USGS's own LAZ is only on `rockyweb.usgs.gov` (no CORS) and
  `s3://usgs-lidar` (requester pays, so anonymous requests are refused).
  `usgsstaged.ts` reads the work units Hobu hasn't built from rockyweb
  through the proxy, found with USGS's product search (which repeats items,
  so they're deduped). rockyweb gives each connection about 50 KB/s, so
  Pennsylvania's 2024 units come from PASDA's copy (2,500 ft State Plane
  tiles, `pasdaName`) and New York's from the state's (`COPIES`), only where
  the copy has every tile of the area. NOAA's bucket is the other US source
  of tiles: its EPTs, and for a survey without one, the zipped tile index in
  `laz/<datum>/<id>/`.
- The proxy (`data/corsProxy.ts`, `proxy/`) only rewrites the request:
  cache keys stay the file's own URL. The browser workers get its address
  from `VITE_LIDAR_PROXY` at build time, Node goes direct (`setUpLidar`), and
  providers that need it return nothing without it (`proxyAvailable`). The
  Worker streams bodies through: 128 MB of memory per isolate wouldn't hold
  a tile. Over the free plan's 100,000 requests a day it answers without
  CORS headers, which the site only sees as a network error.
- `PROXIED` rules are a `prefix`, or a `pattern` where a random share id
  comes first (Montevideo's Alfresco), plus `noHead` where a HEAD gets no
  length (Nextcloud, FileBrowser, Alfresco, and Bavaria, which gzips LAZ
  for anyone accepting gzip and then ignores Range), so sizes come from a
  two byte range, and `firstByteMs` where the host can take minutes to
  start (Poland). Only GET and HEAD go through. The Worker sends
  `PROXY_AGENT` (TxGIO's CloudFront wants `Mozilla/5.0` first) and
  `Accept-Encoding: identity`, and Node sends the same agent going direct
  (`directHeaders`), since Node's own gets a 403 from TxGIO.
- Hosts answer missing files oddly, so providers never guess where it
  costs: AHN's bucket says 403 (tiles are HEADed), Madrid 302s to a
  maintenance page (names come from its grid shapefile), Estonia sends 206
  with a web page (names come from each sheet's listing). Saxony's and
  Saarland's Nextcloud shares lock out an address after failed requests,
  and every user shares the Worker's, so Saxony's tiles come from GeoSN's
  WMS and Saarland's from its ZIPs' directories. ICGC's server didn't
  answer US addresses at all, hence its 20 s deadline, and a survey's
  density gets 20 s before its catalog figure stands (`measureDensities`).
- Copies can move heights to another datum. AIST 3DDB's COPC of Tokyo's
  wards is on the ellipsoid, 36-38 m over the T.P. of Tama's and
  Kanagawa's tiles beside it, so each tile carries `zOffset` (the API's
  original minz less the header's). Without it a model across the wards'
  edge stepped 37 m. Navarra's are on the ellipsoid too, and go down by
  Spain's own geoid (EGM08-REDNAP, a 0.125° table in `navarra.ts`) per tile:
  EGM2008 left them 0.8 m under Flai's PNOA. Surveys with no classes at all (`unclassified`: ARPA-I,
  Open Nagasaki) only go into LiDAR only models, never building measurement.
- Esri I3S scene layers (`read/i3s.ts`, LEPCC in `read/lepcc.ts`) answer a
  missing resource with HTTP 200 and a JSON body, so a node resource is
  checked for one. Coarse nodes are snapped to cells of up to a metre and
  are left out. A layer's outline is its ~250 m nodes under the area: a box
  around the coastal survey would claim Belfast's centre, where it has no points.
- 3DEP work units since 2020 have no year written out
  (`CA_SanFrancisco_1_B23`), so the USGS provider reads it from the suffix
  (`workUnitYear`). Only there: `projectYear` stays the add-on's. Their
  points were flown within a year or two of it. Undated, 226 of them
  ranked behind every older survey (Minneapolis read 2011 at 10 returns per
  m² over 2022 at 64).
- Survey order is `lidar/ranking.ts`. `rankOrder` is the add-on's, newest
  first, then `rankSurveys` moves an older survey ahead of a newer one that
  fills the model's grid cells clearly worse (`effectiveCell`, 1.25 times)
  within `lidar.olderYears` (5), or half as finely within twice that. Any
  age, as LiDAR only models' old fill tier had it, would put a 2010 survey
  over NOAA's 2025 one in the Financial District without USGS's 2023 one.
  'newest' moves nothing, 'detail' compares at 0.25 m at any age.
  At the default 0.71 m cells most modern surveys fill them and the newest
  wins. The rule isn't transitive, so it's a pass that stops at the first
  survey it doesn't beat, not a comparator.
- Densities come from each survey's index near the area (`read/density.ts`):
  EPT hierarchies in 32 m columns with water and holes left out, or a few
  tiles' headers. Catalog densities are outline averages and ran 2x off
  (San Francisco's 2023 survey: 62 over its outline, 150 downtown). The
  hierarchy came within 30% of counted returns for a few KB.
- Outlines overclaim too, so `eptPresence` walks the hierarchy over the whole
  area to nodes about a column across and finds where it has points
  (`measuredCoverage`). NOAA's Irma survey claims all of downtown Miami and
  has points in 45%. Surveys with none are dropped and the picker shows the
  share. It never orders surveys: the index can't tell water from land, and
  ordered by it a 2010 survey went ahead of San Francisco's 2023 one by the
  Ferry Building, which has nothing over the far bay.
- EPT builds are LAS 1.2 (five-bit classes), so topobathy codes 40-45 arrive
  as 8-13. For surveys with "bathy" in the name `surfaceCodes` leaves the
  seabed (8, else read as ground for old model key points), water column
  and submerged objects out and reads 10 as water. Their blocks (`readKey`)
  and probes are keyed apart, so only those are read again.
- Density misses holes: NOAA's 2025 Bay-Delta survey has 18 returns per m²
  in the Financial District and left 7% of 0.71 m cells empty between the
  towers. With 'balanced', when a survey 1.5 times denser could take the
  newest's place, the newest is probed near the middle (`gridProber`, the
  LiDAR only density probe, saved per block), and if it doesn't fill the
  cells, so are the rivals that would beat it. A probe of a dense survey
  can be 25-55 MB, hence the gate. LiDAR only models reuse it for the cell
  size, and the survey search only uses saved ones (`savedOnly`).
- `settings.lidar.survey` picks a survey by hand (`choice.ts`), for LiDAR
  buildings and LiDAR only models alike. It only moves that survey to the
  front of every order (`chosenFirst`), ahead of the coverage tier too,
  so the others still fill in where it doesn't reach. A picked whole-file
  survey is always offered. The worker lists the surveys under an area in
  automatic order without reading points (`findSurveys`, the `surveys`
  message), which the picker asks for by itself once the area and the
  ranking settings settle (`surveySearchKey`). Every prepared result
  carries what it found (`found`) for the same list, with a `note` on why
  the first goes first when it isn't simply the newest. The pick only
  enters a prepared result's key when set, so results saved without one
  keep theirs. A survey search never counts as a stuck worker.

LiDAR only (`src/core/dsm/`, design notes in `docs/LIDAR_MODEL.md`):

- The grid is the area's own rectangle in its rotated frame, a cell centred
  on each vertex. Nothing is resampled between reading and meshing. A square
  area turned 90 degrees reads identical cells, which is a good check after
  touching projection or rasterizing.
- The cell is `Detail` over the scale, grown to stay under `MAX_CELLS`, or
  `lidarModel.cellM` with `cellMode` 'metres', which never grows for the
  area (`requestedCell`). That grid is held to `fixedCellLimit` instead, from
  `navigator.deviceMemory` (64 million cells at 32 GB peaked at 6.9 GB in
  Edge), and `ui.largeGrids` lifts it. Both grow for a sparse survey.
- Memory peaks in meshing. surfaceModel lets the survey layers go after
  compose (`releaseLayers`) and the worker keeps the block checkpoints to
  build them again (`unpackLayers`), so don't read `surface.layers` past
  compose or hold them anywhere else. Sets and Maps stop at 2^24 entries in
  Chrome and 2^23 in Node: nothing keyed by every edge or vertex of the
  surface (`capBoundary` uses flat arrays), and no `Float32Array.from(grid,
  fn)` on a grid, which lists every value first.
- `compose.ts` is a port of the add-on's `dsm_model.compose` and matches it on
  its prepared Chicago, Philadelphia and Boston grids (float32 flips 1 to 3
  cells per grid on exact thresholds). Keep the rules and their order. The
  deliberate differences: removed trees are ordinary cells again, `inside`
  limits the base to the area shape, water grows into partly wet cells at
  its level and takes in specks (`GROW_M`, `takeSpecks`, for San Francisco's
  2023 survey), a body whose edge is mostly unclassified water-level cells
  grows over those too (`SURFACE_M`, `UNFILED_SHARE`, for New York's
  harbour) and over dead flat ground at its level (`LEVEL_M`, a tile of
  Lake Michigan filed as ground), up to the upper water surface of flight
  lines flown at another tide (`upperSurfaces`, Miami's 2021 survey has the
  bay at -0.5 and +0.1 m), with map water, empty ground far from any return
  outside it is never water (`unseen`), without clutter small pieces standing
  alone in water go as boats (`clearBoats`, never mostly building or tall),
  and cut water takes its bank's height for `BANK_RINGS` rings,
  then the TIN is clipped along it (the add-on drops cut cells to the bottom
  before meshing). The app defaults to natural crowns (gaps closed, a 3 x 3
  mean over canopy) and keeps what's under 2 m. Slivers (wires, jibs,
  poles) go whatever the settings. `DEFAULT_COMPOSE` stays the add-on's.
- The density probe (`occupiedCell`) counts land as 2 m squares with a
  return that isn't water, and unclassified returns within 10 m of water
  returns aren't land either (Miami's 2021 survey leaves the bay
  unclassified). The add-on counts any return, which grew the Chicago
  lakefront's cells to 2.08 m. Don't judge unclassified squares by density:
  Bay-Delta's sparse unclassified ground by San Francisco's towers then
  looked filled and it was read ahead of B23. It tries up to six blocks
  nearest the middle (`PROBE_BLOCKS`) for one with land. Probe results are
  saved under `PROBE_VERSION`.
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
- Surveys: those whose outlines cover the most of the area first (`coverTier`,
  within 5% of the best), then `orderSurveys`. A cell belongs to the first
  survey whose outline holds it, returns or not. The exception is ground
  an outline claims with nothing near it (`overclaimed`, after every block
  is read): more than 20 m from any return, past the returns along its row
  or column, with mostly ground, buildings or trees around it. Those empty
  cells take the next survey's returns. Miami's 2019 Keys survey stops 300 m
  short of downtown's west side, and the strip printed as part of the river.
  Rivers, ponds, dark roofs and lakes whose returns end in water stay put,
  or the Schuylkill and Lake Michigan read older surveys for nothing.
- The mesher prices collapses by memoryless quadrics against the current
  faces (the add-on's, so stair walls straighten), and also checks every
  collapse against the grid (`GridBound`): no grid point further than half a
  cell from the surface (a cell beside a wall), square to it. Don't drop that check. Without it
  vertices drift until penthouses are pyramids. Tiles are simplified in workers with edge points pinned, then the
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
  the two parts won't meet. The land region (`landRegion`) mustn't touch
  itself at a point: `cutSurface` then falls back to pulling it in by a
  micron all round, a slot along every shore. Its opening keeps corners by
  putting back points only where the rounding circle fits (`openSharp`
  without `snap`), since a mitre grew points into cut necks that met.
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
  deck height until small map islands were ignored. One exception is
  sea and lake beaches (`followShore`): only bare ground within `BEACH_M` of
  the water, or survey water outside all mapped water with such ground
  behind it, and only strips wholly within `SHORE_M` of the map's line.
  The other is mapped water the survey files none of (`unfiledWater`, the
  EA's 2012 London survey has no water class): per mapped feature
  (`waterPieces`, smallest wins, only `trustedWater`, so no intermittent,
  covered or dry water), its bare ground from the low tenth to the high
  tenth short of the banks, and what's within `GROW_M` of the bare ground
  beside it or in a flat surface over `FLAT_WATER_M2`. Bridges, boats,
  pontoons and quays step up and stay. It has to sit `BANK_DROP_M` below
  banks sampled 2 to 6 m out (outlines run short of the water), and never
  runs where the survey files water in the feature (`UNFILED_WET`). Tried
  and dropped: flat surfaces alone (Canary Wharf's noisy docks broke into
  small pieces) and the lowest smoothed height within 15 m (lost the
  Thames where flight lines overlap at different tides).
- A water layer sits `WATER_DROP_MM` (0.25 mm) under its bank like map
  models' water. `waterDepthMm` is for recessed water only.

Model editor (`src/core/edit/`, UI in `src/app/viewer/`, notes in `docs/HOW_IT_WORKS.md`):

- Edits are keyed by feature, never by mesh: `b:<building>[/<part>]`,
  `r:<segment>[@<from>-<to>]`, `br:<segment>` (bridge decks), `w:<water>`, `t:<tree>`,
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
  corners and at a pond's corners. It's laid per tile in a band 1 mm past what was vacated,
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
- Roads are edited by block (`blocks.ts`). A road edit covers a range of
  its segment by fraction of its length (`r:<id>@0.25-0.5`, the plain key
  is all of it), and the narrowest range wins a field at a time. Set a
  field on a range and smaller ranges inside lose it, clear one and it's
  carved out of wider ranges (`writeRoads`, which every road write in
  `editActions.ts` goes through, `tidySegment` after). Splits live on the
  segment's own edit (`splits`). A click picks a block: the stretch between
  junctions, splits and edit ends (`blockBounds`). Junctions are inner
  vertices another kept segment shares (`pipeline/measure.ts`), which gave
  the same blocks as Overture's connectors on all of the Loop without
  reading them (25% more segment data). Sidewalks that aren't printed don't
  count, and ones within 0.5 mm are one. Pieces and decks are measured
  along their segment once laid out (`measure`, `DeckPiece.at`), by
  projecting onto the segment's own line, since the tidy moves lines. The
  road tiles cut pieces at range ends (`styledPieces`), and a stretch with
  a layer or height of its own is clipped flat at its cuts (`endMask`).
  Without range edits nothing is cut, so exports with whole-segment edits
  stay byte-identical (checked on the Loop). A deck takes the road's edit
  at its middle (`editOf` with `at`, `ObjectFacts.at` for the viewer). The
  viewer cuts its road lines into blocks (`viewer/blocks.ts`) only when
  splits or edit ranges change (`blocksSignature`), and `Whole street`
  selects whole segments.
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
- A drawn road (a `path` that follows the ground) on a LiDAR only model
  rests on the bare ground through `routeProfile`, like a route
  (`drawn.ts`). The edit context keeps compose's ground and a byte of
  flags per cell (`profile`, `ProfileGrids`: water, cut, building,
  tree). Trees and clutter over the road are cleared in a copy of the grid
  around it, only where they stand over half the road's height above the
  ground (clutter is kept by default, and clearing every parked car cut
  holes all down a street). `TREE_CELL` is compose's canopy plus cells of
  mostly vegetation with nothing solid over the ground, and cells compose
  raised closing a crown's gap beside one: the canopy alone left crown rims
  poking through the road. Routes still clear by the canopy, so their
  output is unchanged. A road on something raised the whole way (a roof)
  stands on it, since no edge is seen. Mostly hidden (`BURIED_SHARE`) it
  gets the `surface` note.
- What drawn roads clear is cut out of the city cap and filled with the
  bare ground (`surfaceCut.ts`). The view splits the cap once into the
  tiles the roads reach and the rest, meshed once, and only cuts those
  tiles again: a whole cut and mesh was about 1 s per road edit on the
  Loop, the tiles about 0.2 s. Exports cut the whole cap, since the split
  leaves walls inside the solid. The hole grows by `JOIN_MM` first: cells
  meeting at a corner pinched the land, and `cutSurface` pulled the whole
  surface in by a micron.
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
  opentype.js, which reverses and shapes it itself. opentype.js throws on
  some GSUB lookups (Calibri's ligatures, and Arabic in Arial or Segoe UI),
  so an SVG title is shaped again without Latin ligatures, then a letter at
  a time with a warning. It used to fail the whole render.
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
  reset clear, and `BackupNote` offers it back. A tab writes edits, picks
  and settings only once it changed them (`written` is seeded at load) and
  takes on another tab's saves (`storage` in `sync.ts`), dropping its undo
  steps. An idle tab closing used to write its old copy over the other
  tab's, settings and area included, and a broken settings key made the
  next save wipe them.

Undo outside the editor (`src/app/state/undo.ts`, buttons in `TopBar.tsx`):

- The area, output, settings, colours, export options, SVG settings, picks,
  place and file name (`Setup` in `store.ts`) have one history, apart from
  the edits'. `Ctrl+Z` is the editor's in the 3D view while editing and the
  settings' everywhere else, the sidebar and the top bar's undo buttons
  included (`editorTakesUndo`, which `ModelView`'s keys check too).
- Steps are recorded by a store subscription, not by the actions. Changes
  join one step within one handler (same microtask), while a pointer is
  held (a drag, a slider), while typing in one field (until focus moves),
  or for the same keys within a second. A pointerdown or a focus change
  starts a new one. A change that ends where its step began (a drag called
  off with Esc) leaves no step and keeps redo.
- Anything the app changes by itself goes through `quietly`, with a
  `rebase` when it should be in every step (picks from another tab), or
  the undo button lights up for something nobody did. Name an action's
  step with `asChange`, which also returns it for a toast's Undo
  (`undoChange(step)` only undoes it while it's the last). A rebase can
  leave steps that change nothing, which undo, redo and the buttons' labels
  all pass over (`lastUndo`, `firstRedo`).
- A text field typed in since it was focused keeps `Ctrl+Z` for its own
  typing. `NumberInput` and `HexInput` follow the value while focused
  until typed in, or an undo with the focus there showed the old value and
  blur wrote it back. `NumberInput`'s own arrow steps don't move what
  Escape puts back (`sent`).

SVG maps (`src/core/svgmap/`, UI in `src/app/svgmap/`, notes in `docs/SVG_MAPS.md`):

- The engine is SVGmap's, moved with its tests. At the merge, live renders of
  the Chicago Loop were byte-identical to SVGmap's for laser, plotter and
  print. Hexagons were added (`layout/shapes.ts`, `availableWidthAt` in
  `text/label.ts`, the plotter band in `compose.ts`).
- In SVG mode the area is the piece's map window: `fitAreaToPiece` gives it
  the window's proportions and corner radius and sets `svg.scale` (1:n) from
  its width, or its width from the scale when `scaleLocked` (the scale
  lock under Size, on by default at 0.05 mm/m). The panel shows the scale in
  mm/m but it's stored as 1:n. Every area or piece change goes through it in
  the store. The shape is shared with 3D, and so is the size block
  (`ScaleAndSize.tsx`, in both outputs' Size sections): one lock, on the scale, meaning the
  same for both outputs (`scaleLocked` and `setScaleLock` in the store). A
  model's lock is its `scale.mode`, and switching it carries the scale it
  works out to across, so it never changes the model. `snapshotKey` keys on
  that effective scale for the same reason. The area is shared, but each
  output keeps its own size (`areaSizes`, saved): `setOutput` remembers the
  one it leaves and gives back the one it switches to, at the shared centre.
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
- `source.overtureBuildings` (off by default) adds Overture's building
  footprints whose geometry isn't from OSM (`svgmap/overture.ts`): only the
  `sources` dataset and `is_underground` are read (`columns` in
  `fetchOverture`, `sources` pruned to `property` and `dataset`), and one
  overlapping tile buildings by over a quarter is dropped. Each feature is
  unioned EvenOdd on its own first (`projectFootprints`): Overture's winding
  isn't fixed, and under the layer's NonZero union an outline wound the other
  way, or a hole, cancelled the tile polygon under it. Tile buildings are
  indexed by ring, not feature: OpenMapTiles packs whole blocks into one
  feature and per feature took 87 s on the Loop. They're merged into their
  own prepared entry with its own unions, so turning it off gives the tiles'
  entry back and output stays byte-identical. Only at zoom 14, 150 MB at
  most, a failed download is tried again after a minute.
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
  the area inside) still open, with the scale lock off so they keep their
  width: SVGmap never put the lock in links, and locked by default here
  they opened at 1:20,000. The `s=` part is dropped from the address bar
  once read.
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
npx tsx scripts/generate.ts --route run.gpx --fit-route --out out/run.3mf   # a route, the area framed around it (--turn, --no-snap, --lidar-only)
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

This applies to all code comments and anything public (READMEs, docs, PR descriptions). Write it like a developer leaving useful context for another developer, not like a technical writer, a tutorial, or an AI trying to make the codebase look well documented.

My older READMEs are the reference for tone: pre-2024 versions in jarvisar/solar-system, sorting-algos, interpreter, exoplanet-classifier, and senior-design. Don't use my newer repos as a reference, some of those are AI generated.

## General

- Plain, direct, and practical. Use a normal word when one works. Nothing corporate, academic, or overly polished.
- Short sentences. Describe actual behavior with concrete details, numbers, and examples.
- Focus on intent: what something is supposed to do, why a decision was made, and any constraints or tradeoffs.
- Call out real limits, exceptions, and edge cases. If something is uncertain, just say so.
- Qualifiers like "currently", "for now", "normally", "only when needed", "this should still..." or "we don't want..." are fine when they clarify scope.
- Keep it proportional to the problem. Don't invent terminology or structure for simple behavior.
- No em dashes, semicolons, emojis, arrows, bold scattered through sentences, or other punctuation and formatting regular people don't use.
- No AI patterns: "it's not just X, it's Y", rhetorical flourishes, intros that restate the title, "Overall, ..." wrap-ups, repeated summaries, filler adjectives like powerful, seamless, or robust.

## READMEs

- Open with a sentence or two on what it is. e.g. "This is a simple proxy server that adds the necessary headers to allow Cross-Origin Resource Sharing (CORS) for a specified website." or "My first real Three.js project."
- Link the live build if there is one: "Visit the [GitHub Pages site](...) to access the latest deployment."
- Controls and usage as short imperatives: "Use W/S to increase or decrease throttle. Use A/D to roll. Press the escape key at any time to exit flight mode."
- State limits plainly: "Currently the maximum amount is 512." or "Note that large searches can take up to 15 seconds to process."
- Small side notes can go on an h6 line: "###### Note: Assembly generator currently only supports integers"
- Usual sections, only when there's something to put in them: Usage or How to Use, Features, Local Installation (numbered steps with the command in backticks), Known Issues & Limitations, Screenshots, Credits.
- Title Case headings. "&" is fine in titles ("Solar System & Flight Simulator").
- Backticks for buttons, keys, files, branches, and commands.
- Keep it short. Most of my older READMEs were 250 to 550 words, bigger projects around 1,200 to 1,500.

## Code comments

- Sparse. Only for non-obvious logic, reasons behind a decision, edge cases, limitations, unusual behavior, or something another developer might be tempted to "fix".
- Don't narrate straightforward code or restate the function name. Don't add doc blocks just to have them.
- Short and plain, a fragment is fine. e.g. "# Use WSL to run the commands if on Windows" or "# If the input contains an equal sign, skip code generation"

## Attributes

Never list Claude or any AI tool as an author or co-author: no `Co-Authored-By` trailers, "Generated with" lines or session links in commits or pull requests, and no AI names in author, maintainer or copyright fields. The user (jarvisar) is the sole author and should appear as the sole Contributor on the GitHub repository.