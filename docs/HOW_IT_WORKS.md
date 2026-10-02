# How It Works

Technical notes on how a model is built. For everyday use see the [README](../README.md), and for the flat maps see [SVG maps](SVG_MAPS.md).

Everything runs in the browser. The page starts a Web Worker that downloads the data, runs the geometry pipeline and writes the export files, so the page stays responsive while a model is built. Nothing is sent to a server apart from the data requests themselves and the place search.

## Units and scale

One model unit is one printed millimetre. The default scale is 0.07 mm per real metre (about 1:14,286), the scale the Blender add-on used. At that scale a 6.5 m residential street prints 0.455 mm wide, which is just over one line of a 0.4 mm nozzle. With the scale unlocked under `Size` the printed size stays put and the scale follows the area instead (`scale.mode` `fit`, from the longest side). Models and SVG maps share these controls: the lock means the same in both, but an SVG piece never follows the area, so with its scale locked the box only moves and turns.

Coordinates go from WGS84 through a local East/North/Up frame centred on the area, then get rotated so the area's own "up" is +Y, then scaled. Every layer goes through that one projection (`src/core/geo/projection.ts`). The area itself is defined in metres around a centre, so a 2 km square is a 2 km square anywhere on the globe.

## Data

Map data comes from the latest [Overture Maps](https://overturemaps.org) release, read straight from its GeoParquet files on Amazon S3:

1. `stac.overturemaps.org` lists every release and has a small index of every file with its bounding box.
2. For each needed type (buildings, building parts, road segments, water, land, land use, land cover, infrastructure), only the files whose box meets the area are opened.
3. Each file's footer is read with a range request, and row groups are skipped using the statistics of the `bbox` columns ([hyparquet](https://github.com/hyparam/hyparquet)).
4. A first pass reads only the small columns (bbox, class, heights, road rules) and picks the rows generation can use: inside the area, and of a class some layer turns into geometry. Regional polygons many times the size of the area, and land cover made for small scale maps, are dropped here too.
5. A second pass reads the geometry of just those rows. The files have no page index, so the page headers of the geometry column are walked to find which pages hold them.

Features that cross the edge are kept whole and clipped later. An area that would need more than 300 MB is refused before any geometry is downloaded.

Downloaded byte ranges are kept in the browser's IndexedDB (up to 400 MB), so generating the same area again, or changing a setting, doesn't download it again.

Elevation comes from the AWS Terrain Tiles open dataset in its Terrarium PNG encoding. The zoom level is picked so a tile pixel is about as fine as the terrain grid.

Some coastal tiles have holes (black pixels, -32768 m) and specks of seabed garbage down to -15,000 m, sometimes right on land. One of them set the base for the whole model, so Waikiki came out a metre tall. They're filled from the pixels around them before anything samples the tiles (`repairElevation` in `src/core/data/dem.ts`). Only pixels below sea level that drop far more steeply than real ground can are touched.

## The terrain grid

The elevation is resampled once onto a square grid in model millimetres, 192 cells across the longer side by default, and lightly smoothed with a 3 x 3 mean. The tiles carry a metre or two of pixel noise, which at this scale is a fifth of a layer and prints as bumps along every draped road.

Every layer samples this same grid (`src/core/terrain/heightfield.ts`). A road can't sink into a hill the terrain renders differently, because both read the same numbers.

## Water

Water polygons are clipped to the area and sorted into three kinds:

- **Cut water.** Rivers, lakes and the sea above 5,000 m², measured on the whole feature, so a lake that only reaches into a corner of the area is still cut. These are cut out of the terrain.
- **Ponds, fountains and basins.** Identified by their tags and classes, never by size or name, plus untyped water under 5,000 m². The elevation data is too coarse to show them, so they sit below their lowest bank.
- **Water sheets.** Other small water. A thin flat slab sits 0.18 mm above the terrain, which is flattened under it.

Ponds and sheets that lie in cut water are trimmed to the part outside it, so the parts don't overlap.

By default cut water and ponds are a 1 mm layer of water on a floor of terrain (`Large water` set to `Thin layer`). Every printed layer with water in it needs a colour change, so keeping the water to the top millimetre saves a lot of them wherever water sits above the lowest point, like a lake up in the hills. The floor counts as terrain for the base, so the full base thickness runs under it and the bottom of the model is one colour. The model can come out a little taller for it, up to 1.25 mm where the bank is the lowest ground, though on the regression areas it was at most 0.5 mm. `Cut through the base` is the add-on's way: the water part runs from the print bed up to its surface, so it can be printed as pieces of its own, and with `Water` off the openings stay empty. Ponds are a layer either way.

A body's level is the median of the terrain inside it, because elevation data reports open water as a noisy plateau at its surface. Some data carries bathymetry instead, so cut water is never set below the low tenth of its connected shoreline. Only shore inside the area counts, so the sea running off the edge isn't dragged down to the seabed. Cut water mapped as several overlapping polygons, like a harbour and the river flowing into it, becomes one body at one level. The grid under cut water is flattened to the level and the shore around it is raised to at least that level. Cut water and ponds then sit 0.25 mm under the bank, so one printed layer of bank always shows, except under beaches with `Slope beaches into water` on (see below).

Water smaller than `Large water above` is a sheet sitting 0.18 mm over the ground, which suits a stream or a pool out on its own. Mapped beside large water, like a lock, a dock or a canal split into pieces, it stood about 0.4 mm over the water next to it. `Join small water to large water`, on by default, makes it cut water at the level of what it touches, the lowest one where it touches several, and carries on through chains of small pieces. It never uses its own measured level: the elevation data can't see water that small, so Boston's locks read as their dam and Venice's canals up to 11 m over the lagoon. Anything more than 15 m (real) away from that level stays a sheet, so a stream climbing away from a lake still follows the ground. Untyped small water joins too, but tagged ponds and fountains keep their own level. Large water mapped as separate touching pieces still keeps a level each, which leaves small steps between Venice's bigger canals.

The water is cut around roads, buildings and bridge piers that stand in cut water or a basin. With `Keep ground under structures in water` on, the terrain is kept under them, so they print on a strip of ground. Turned off, they're built down through the water in their own colour instead, to the floor of the recess or to the base when the water runs through the model (`pipeline/wading.ts`). Either way nothing is left on air if the water part is deleted in the slicer. Mapped piers, quays, breakwaters and dams are ground whatever the setting.

A pier or breakwater narrower than a nozzle line leaves a slot in the water that neither part prints, so it shows up as a hole. `Skip thin ground in water` fills it with water and `Widen thin ground in water` grows it into the water instead. Both are off by default and use 0.42 mm, one line from a 0.4 mm nozzle. Thin means ground with water on both sides, found by a closing of the water, so a quay that overlaps the water along the shore stays as mapped however narrow it is. Islands count too. Widening takes a piece's width from its area and perimeter, which is exact for a strip of even width, and does a couple more passes for fingers much thinner than the walkway they come off. Specks under the width every way, like mooring posts, and slivers under 0.02 mm where a pier's outline and the water's disagree are skipped rather than grown. Bridges are still found from the water as mapped, so a path along a filled breakwater isn't taken for one (`pipeline/thinGround.ts`).

## Surfaces

Parks, forest, sand, rock and paving come from `land` and `land_use`, through allowlists of classes (`src/core/pipeline/classify.ts`). An unrecognised class produces nothing rather than a guess. Polygons more than 8 times the size of the selection are regional features and are skipped.

`Satellite land cover` adds forest, shrub and grass from `land_cover`, which Overture makes from ESA WorldCover. It's off by default. Its tree class means 10% canopy or more, so tree-lined streets and gardens count as forest, and in a leafy city like Cincinnati whole neighbourhoods came out green where the mapped woods (and SVG maps) only have the hillsides. Land cover comes at two zoom levels: zoom 0-7 polygons, some of them continent sized, and detailed zoom 8-15 ones cut to zoom 10 tiles, 30 to 40 km across. Only the detailed ones are used, picked by zoom instead of by size. A detailed tile is often one forest polygon with holes where it's built up, and the size test dropped it from small areas and kept it in large ones, so the same streets changed colour with the size of the area. `Scatter in satellite forest` under `Trees` uses the same polygons.

Categories never overlap: the priority order (paved, sand, rock, green, forest by default) decides who owns shared ground. Water, roads and building footprints are cut out of every slab. What's left is kept as mapped, however small or thin. Strips under 0.2 mm and pieces under 0.1 mm² used to be removed as too thin to print as a colour of their own, but that left bare terrain in about 3% of the land cover, mostly pockets between paths and strips beside roads. Slabs rise 0.4 mm above the terrain and reach 0.04 mm into it, following the ground across their whole area. With `Slope beaches into water` on (it's off by default), the ground under sand beside cut water slopes down to the water's surface over 1.5 mm (at least a cell and a half of the grid) instead of ending in a bank, and the sand stays 0.4 mm thick on top. Roads, buildings, bridges and ponds keep their ground, so a beach behind a promenade doesn't slope. A park behind a beach slopes with it. Mapped sand often stops a little short of the water, so gaps up to that 1.5 mm are filled with sand (`src/core/pipeline/beaches.ts`). The grid is usually coarser than a beach, so the sand's edge can still sit a little above the water.

## Roads

Transportation segments are split at every scoped rule boundary (`between` ranges on flags, widths, levels and subclasses) before anything is read, so a partial bridge or tunnel isn't lost. Tunnels and indoor corridors are skipped, and by default so are sidewalks and crossings mapped beside a street.

Widths come from the mapped width or a class default, clamped between 0.45 and 0.7 mm printed.

Before they're widened, the centerlines are tidied (`src/core/pipeline/network/`). As mapped, both carriageways of a divided street print as one band with a hairline of ground down the middle, footways drawn beside streets without the sidewalk tag double every block, and the steps and scraps that joined dropped sidewalks and tunnels print as loose specks. The tidy tries to change as little as it can: lines are cut, dropped, extended a little along themselves or moved onto the middle of their own road, never bent towards something else. `Tidy road network` has five steps, each with its own switch:

- `Merge divided roads`: two one-way lines of the same class going opposite ways, side by side closer than `Minimum gap` (0.4 mm, edge to edge) with nothing as important between them, become the line halfway between them. Junctions move with it: a street meeting or crossing the pair slides along its own line onto the middle, so it stays straight and the stub across the median disappears. Where the carriageways part again the ends bend in to the merged line like a fork. Anything less clear, like three carriageways or a two-way street beside a one-way one, keeps its lines and gets filled in instead.
- `Remove doubled lines`: a line running beside a strictly more important one closer than the gap is doubled, motorway down to footway, with rail between the streets and the service roads. Paths lose just their doubled stretches, and a street only goes when two thirds of it is doubled. Lines of the same rank never cull each other, so rail yards and car parks keep all their lines.
- `Join loose ends`: a path or street whose partner was left out, like a park path that stopped at a sidewalk, carries straight on to a road within twice the gap, or takes the shortest way across when that still heads the way it was going. A real dead end is only joined when the ground left would be too thin to print.
- `Remove stubs and specks`: on a graph of the lines as they'll print, a spur whose loose end met something that's gone is removed when less than 0.7 mm of it shows past its junction, a real dead end when less of it shows than it is wide, and anything touching nothing that's shorter than 1.4 mm in all.
- `Fill hairline cracks`: a crack narrower than half the gap between two roads or two paths side by side is filled in, and so is enclosed ground nowhere that wide. Tracks are left alone, since a yard's tracks sit this close and still read as separate lines. Cracks that thin close up in the print anyway. This used to fill everything up to the whole gap, between colours too, and ramps side by side printed as one block of road, a lot thicker than with the tidy off. Wider gaps stay open now.

Centerlines are buffered with round joins and unioned per group (roads, railways, paths), so overlapping pieces become one solid. Roads win over rail at level crossings, and both win over paths. Ribbons are 0.6 mm tall. Runways, taxiways, aprons and helipads from `infrastructure` print as airport paving.

## Routes

Imported routes (`src/core/tracks/`) are read from GPX, KML, KMZ, TCX, GeoJSON and FIT files, gzipped or in a zip. Every track, route and line in one file is one route, and the pieces of a recorded track less than 500 m apart are joined, since watches start a new piece after a pause. They're simplified to 1 m and saved as encoded polylines.

A route is its own part, never part of the road network, so the tidy can't move or drop it. Recorded tracks wander 5 to 10 m off the street, more between towers, so with `Snap to roads` on they're matched to the road lines first (`snap.ts`). It's map matching with a hidden Markov model: the track is sampled every 10 m, each sample can be on any road within 40 m or off the roads, and the most likely sequence is the one whose distance along the roads best agrees with the distance between the samples. Between two samples on roads the route follows the road's own line. Leaving the roads costs as much as a road 24 m away, plus a little to switch there and back, so a trail through a park that isn't mapped stays as recorded. A map model snaps to its roads as tidied, so the route lands on the printed road, and a LiDAR only model downloads Overture's roads and paths for it.

On a map model a route is a ribbon 0.6 mm wide standing 0.8 mm over the ground, a layer above the roads, with a dot at the start and a bar across the finish (`src/core/pipeline/tracks.ts`). Roads, paths and land cover are cut away under it, the same way land is cut away under roads, so the route prints in its colour even from an STL, which has no part order. Removing it in the editor gives them back. It's listed before the buildings, so slicers give a building the overlap where GPS has drifted into one. A building taller than the route hides it, and over a low one its top stays whole. Cutting buildings out of it instead shredded a route into dashes at small scales, where it's wider than the streets. A bridge deck it runs along carries it, and one it only passes under is cut out of it. Over cut water it keeps a strip of ground like a road does, or with supports off goes down through the water.

A LiDAR only model's surface has the roofs and crowns in it, so a route rests on the survey's bare ground instead (`src/core/dsm/route.ts`). Trees and parked cars along it are taken down to the ground first so it shows. Where the surface stands more than 2.5 m over the ground, the route is either on it or under it: on it where the surface rises to it gently along the route, like a bridge's ramps, under it where it has a sheer edge, like a building, a crown or an overpass. Something that isn't a building and stays over the route for 40 m or more, like an elevated railway over a street, carries it on top instead, at the median height of the structure so stations don't make it jagged. Under a roof or an overpass the city keeps the overlap, so the route is hidden there, the same as in the 3D view.

## Bridges

Bridges are off by default. When on, pieces flagged as bridges and unflagged roads crossing cut water become decks. Connected pieces are solved as one network, including a ramp that ends partway along another deck. Loose ends touch down on the road surface, except where the model's edge cut the bridge off. The deck climbs no steeper than 8% towards a height that clears whatever is under it by 0.4 mm. A network that never rises 0.2 mm above the road prints as a road, unless it crosses open water. Piers stand every 30 m inside the area, clear of the ends and of roads below, in the water like anything else that stands in it.

## Buildings

Buildings and building parts follow the add-on's rules (`src/core/pipeline/buildings/`):

- Height is the mapped `height`, then `num_floors` times 3 m, then a class default (30 m for a stadium, 3 m for a shed), then 10 m.
- `height` is the top of a mass above the ground, not a thickness above `min_height`.
- A parent is replaced by its parts when the parts carry heights. It's kept (or restored) when the parts only cover part of it.
- A plain footprint published again over another building's parts is dropped.
- Every mass of one building sits on the lowest ground under the whole building, so parts of equal height end level. Undersides follow the terrain 0.04 mm below its surface.
- Parts mapped to start above the ground (`min_height`), like arcades, overhangs, skybridges and the tiers of a dome, are built down to the terrain too, the way I used to shrinkwrap building undersides onto the terrain by hand. One standing on another part runs down through it, which looks the same and costs about 1% more building triangles in Rome. `Bring raised parts down to the ground` off keeps them raised, as the add-on does, except where the gap under one would be thinner than a 0.2 mm layer, over the ground or over the part below. A gap that thin prints as a layer of air or none, and the slicer flags it.
- Heights are scaled by 1.1 so buildings read clearly over the roads, and footprints of at least 0.6 x 0.6 mm are raised to at least 0.8 mm tall.
- Gabled, hipped, skillion, pyramidal and dome roofs are built from `roof_shape`. Each planar part of a roof is its own prism.

## LiDAR

With `LiDAR` on, buildings are measured from public LiDAR surveys before the model is built (`src/core/lidar/`). It's a port of the add-on's LiDAR pipeline, limited to publishers a browser can read from directly.

Surveys are found per provider, one module each in `sources/`: USGS 3DEP through Hobu's EPT mirror, NOAA, KyFromAbove, Indiana, IGN, NRCan, swisstopo, several German states, Luxembourg, Scotland, Slovenia, the Basque Country, Trentino, Helsinki, Japanese prefectures, OpenTopography and Open LiDAR Data by Flai. [LiDAR sources](LIDAR_SOURCES.md) has the list, and the open surveys that couldn't be used. Each provider is only asked inside a box around its territory, and one that fails or takes over 90 s is reported while the others carry on. One that didn't answer is left out of searches for the next 5 minutes, or every Generate waited out its deadline again. A survey can measure a building when its outline holds the whole footprint. Surveys that only come as whole files are offered rather than downloaded (`offers.ts`): the model is made without them and the action bar says what downloading them would add and cost.

Reading (`read/`):

- EPT: the hierarchy is walked down to the depth with about 0.35 m point spacing, and only nodes that meet the area are downloaded. Nodes are additive, so their ancestors are read too.
- COPC: the header, then the hierarchy pages that meet the area, then each node as one range read. A server that ignores the range is an error, never a whole-file download, unless its provider says it does.
- Plain LAZ and LAS tiles: read through laszip's chunk table, in runs of chunks by range. The first read of a tile decodes all of it and notes where each chunk lies, so later batches only fetch what they need. Tiles in ZIPs are read in place when stored, inflated when deflated, and plain LAS is cropped as it inflates.
- Points are cropped, noise and withheld returns dropped, and classes mapped to ground, building, vegetation and unclassified. Z units come from the header or the catalog. Without either, metres are assumed only outside regions with a height system in feet (the US, Ireland, Kuwait and the Cayman Islands).
- LAZ is decompressed in WebAssembly by [laz-rs](https://github.com/tmontaigu/laz-rs) (`@voxelkloud/wasm-codecs`), skipping colour and intensity. Grids other than web Mercator go through proj4, with definitions for the national grids the providers use built in.

Buildings are measured in 400 m batches, each read with a 30 m margin so every roof and the ground around it is whole. A read stops at 8 million points and the batch is split in two. A single building still over that is skipped. Up to four batches run at once, each in a worker of its own (one fewer than the cores). Batch results are kept in the LiDAR cache, and the whole area's result is reused for a day if nothing failed. The workers' downloads go through the engine worker, which fetches each file once for all of them and keeps recent ones in memory, since every batch reads the same coarse EPT nodes. The `Chicago - The Loop (small)` preset measures 610 of its 1,308 buildings from about 790 MB in 3.5 to 4 minutes the first time, and in about 70 s once the survey is downloaded.

Measuring follows the add-on:

- The ground is a plane fitted to ground returns within 25 m of the footprint, or a nearby ground height where no plane fits.
- A building needs returns across its footprint and observed ground around it. Otherwise it keeps its mapped shape and the reason is counted.
- Where the roof can't be built from the surface (below), it falls back to roof planes, flat terraces and finally a single height.
- `Measure > Heights only` keeps the mapped shapes and only corrects their heights.

Where several surveys cover a building, one is picked by coverage, classification and capture date against the building's construction year. A measurement far from the mapped height is only used with `Prefer LiDAR on conflicts` on. With it off, mapped parts with more detail than the measurement are kept, like a tower on a podium measured as one flat top.

### Measured roofs

Roofs are cut from the same surface a LiDAR only model is built from (`lidar/surface.ts`). Each batch counts its returns into the cells a LiDAR only model of the area would have, at the same `Detail` or cell size, runs them through the same rules (`composeSurface`, `fairFaces`), and meshes each building from the cells around it with the same mesher and limits. Inside its walls, a measured building comes out the way it does in a LiDAR only model: rooftop plant, parapets, setbacks and spires as the survey saw them. The measurement uses the area's own frame, so the cells land exactly where a LiDAR only model's do.

Until October 2026 roofs had a pipeline of their own after the add-on's faired grid: planes grown over the grid, anything under 0.3 mm across and a 0.2 mm layer tall tidied away, then a Delatin triangulation. It printed clean, but next to a LiDAR only model of the same area the buildings looked bare, and the two kept drifting apart. That code is gone, and the git history has it.

A map model needs a few things a LiDAR only model doesn't:

- The building fills its mapped outline, since the roads and land cover stop there. Cells within 1.5 m inside the outline that stand under 2.5 m over the building's ground are the street, where the map's outline runs past the wall, and they take the height of the nearest roof cell. The roof is carried out past the outline the same way, so the cut along it goes through the roof and not halfway down a wall.
- A taller mapped neighbour's facade standing inside the outline comes down to the roof behind it. Otherwise a metre of the tower next door stood along the edge of the roof, and counted towards the building's height.
- Trees come off the roof, down to what the survey saw under them. Map models have trees of their own.
- The cells never grow for a large area, since only one batch is gridded at a time. Where the survey is too sparse they grow the way a LiDAR only model's do.

On the `Chicago - The Loop (small)` preset the buildings come to 530,000 triangles, from 385,000 with the old roofs.

A measured roof is a solid of its own: the TIN on top, a flat underside and walls along the outline, standing on a prism down to the terrain. Section cuts clip the TIN with a constrained triangulation, so the pieces stay closed. Constrainautor can rescan forever when an outline grazes a TIN vertex, so its work is capped and a stuck cut is retried with the outline moved in by a millionth of its size. A Paris building on the model's edge used to hang generation there.

The measurement's checks were ported from the add-on's Python (algorithm 29) and checked against it on the same point clouds. That takes a few things another developer might want to tidy:

- `geos.ts` reproduces GEOS 3.13's minimum rotated rectangle and double-double line intersections, and CPython's `math.dist`. The coverage grid follows the rectangle's longest side, and opposite sides are equal to within rounding. A generic rectangle fit turned half of all grids by 180 degrees.
- `centroid` and `rotate` follow GEOS and `shapely.affinity` operation for operation.

Buffers still come from Clipper rather than GEOS, so the 25 m ring the ground is fitted in has slightly different arcs, and the ground can come out up to 0.7 mm apart.

## LiDAR only models

With `LiDAR only`, nothing is measured per building. The survey is read over the whole area into a grid of about 0.7 m cells, heights are decided per cell (haze and birds left out, holes filled, water flattened), and the grid is meshed into one closed solid in the terrain colour. Water is recessed in it, cut out for a thin layer of its own, or cut away, and Overture's water outlines smooth the shorelines where they agree with the survey. It's a port of the add-on's LiDAR Only mode with a few changes. [LiDAR only models](LIDAR_MODEL.md) has the details.

## Meshes

Almost everything is a 2.5D prism: a polygon with a top and bottom height at every point and vertical walls (`src/core/geometry/solid.ts`). Trees and measured LiDAR roofs are the exceptions. The mesher (`src/core/geometry/mesher.ts`) triangulates the polygon once and uses it for both caps. Where a surface follows the terrain it adds interior points on the grid's lattice and uses a constrained Delaunay triangulation, so the outline stays exact. Walls run along every boundary edge. Each shell is closed and consistently wound by construction, and the mesher checks that every cap covers its polygon exactly before using it. Polygons whose rings touch at a single point are shrunk by a tenth of a micron so four walls never share one edge, and by up to a micron if they're still pinched after that.

Because solids stay 2D until the end, cropping to a circle or hexagon and splitting into plates are plain polygon clips. Every section's parts are closed shells, like the whole model.

Parts are separate solids that overlap slightly (roads and slabs reach 0.04 mm into the terrain). Slicers union them. The model is not one fused manifold.

PrusaSlicer, Bambu Studio and OrcaSlicer give an overlap to the part listed later in the object, so 3MF exports list the terrain after everything that reaches into it, and water after the terrain, since small water sheets are sunk into it (`OVERLAP_RANK`). The overlap used to be 0.15 mm with the terrain listed first, and PrusaSlicer printed a park's lowest layer below the ground wherever a slice fell in the overlap, which shows at the model's edges and shores. Filaments keep the model's order, so the terrain is still filament 1. The 3D view settles the walls these parts share the same way.

## Editing

Edits are a small document kept next to the settings (`src/core/edit/types.ts`), keyed by what they change: Overture IDs for buildings, building parts, road segments and water, and IDs of the app's own for trees and added shapes. Nothing in it points into the mesh, so edits carry over when the model is generated again with other settings. Changes for things a model doesn't have are kept and ignored, and the editor offers to clear them. Sizes are printed millimetres except a building's height, which is real metres, so an edited building keeps its place in the skyline at another scale.

Since edits aren't tied to a place, there's one document for every area. A share link or an options file adds its edits to the ones saved in the browser rather than replacing them. Whatever of yours it changes is kept aside, like what `Undo all` and the crash screen's reset clear, and the editor offers it back (`Backup` in `src/app/state/persist.ts`). Only one copy is kept aside, so the next thing that replaces edits replaces it too. A tab only saves the edits, and the settings, once it has changed them, and takes on what another tab saves. Before that, an idle tab closing wrote its old copy over the other tab's.

The editor's undo only covers edits. The area, the output and every setting have a history of their own (`src/app/state/undo.ts`), on the arrows next to the logo and on `Ctrl+Z` everywhere but the 3D view while editing. From the sidebar it's the settings' even then. I kept the two apart since edits are one document for every area, and an undo in the 3D view that moved the box on the map instead would be confusing. Steps are recorded from the store, so no action has to remember to add one, and grouped by what the person did: one press of the pointer (a whole drag, a slider pulled), one click, typing in one field, or the same key pressed in a row. It's only kept for the session.

A copied link only carries what's on its area, or a link for one city took a pin marking someone's home in another. Shapes go by where they are. Edits to buildings, roads and water say nothing about where they are, so they only go when the model shown is of that area and has them (`src/app/state/linkScope.ts`). Options files still carry every edit.

The worker keeps the generated model and applies the edits to it afterwards (`src/core/edit/session.ts`). The 3D view only gets what changed: new geometry for a building with a new height or for an added shape, and whole road parts once a road is edited. It hides removed things and colours layers itself. An export applies the edits to the generated solids and meshes them like a generated model, so sections and every format work the same. If an update fails part way, the session forgets what it sent, and the next update sends everything again for the view to take in place of what it had.

Roads were the awkward part. A city's streets come out of the pipeline as one unioned polygon per colour, so one street can't just be cut out of it. Once a road is edited, the area is split into tiles of 12 to 30 mm, and each tile an edited road reaches is rebuilt from the road pieces with the pipeline's own `bufferRoads`, with the tile as the crop. The other tiles keep the generated polygons. Tile edges are on whole Clipper units, so neighbouring tiles meet exactly. A road with its own height or layer owns its ground where it crosses others, and the taller one wins.

Roads are edited a block at a time (`src/core/edit/blocks.ts`). An Overture segment often runs through several junctions, and keyed by segment, a colour meant for one block went on down the street. So an edit can cover a range of its segment instead, by the fraction of the segment's length from its start, the way Overture scopes its own rules: `r:<id>` is the whole segment, as before, and `r:<id>@0.25-0.5` a quarter of it. A click picks a block, the stretch between two junctions, a split or the end of another edit. Junctions are inner vertices another printed segment shares. Overture puts a connector wherever segments meet, on a vertex of both, and on the Loop the shared vertices gave the same junctions as the connectors without downloading them. Junctions with sidewalks and crossings that aren't printed don't count, and ones closer than 0.5 mm are taken as one. Edits apply by range, not by block, so an edit lands on the same stretch at another scale or with another release's junctions. Where ranges overlap, the narrowest wins, a field at a time. Setting a colour on a block clears it from smaller ranges inside it, and putting a block back carves it out of the edit of the street around it.

The tidy moves and joins lines after they're split from their segment, so every road piece is measured at the end by projecting its points onto its segment's line (`src/core/pipeline/measure.ts`). The road tiles cut pieces where a range ends and give each stretch its own edit. A block with a colour or height of its own is clipped flat where it was cut, so it doesn't end in a round cap pushing into the next block. A bridge takes the edit of the block its middle is in. `Split a road` keeps splits on the segment's own edit, and `Make it a drawn road` removes a block and adds a drawn road along the same line, which then reshapes like any other.

A removed road, building or pond gives its ground back to the land cover it was cut out of, so a path taken out of a park is grass again (`src/core/edit/land.ts`). The land cover is laid again around it the way the pipeline lays it, and only what the generated slab lacks is added, so the two meet exactly. Filling just the removed footprint left bare notches wherever the slab had been rounded off against the road. That's worked out per tile too, and cached, or every edit in a large city took seconds.

Water works the same way (`src/core/edit/earth.ts`). Once a road or building standing in the water goes, the water and the ground kept in it are cut again from what still stands there, rather than patching the generated water, which left hairline cracks along the old outline. Water given back too thin to print, like a thread between a building and the bank, stays ground.

Custom layers export as parts of their own, with their own filament. Hiding a part in the view hides what's still in its own colour, so a building moved into a custom layer stays on screen, and in the download, with `Buildings` hidden. Added shapes are built down to what they stand on (`src/core/edit/stand.ts`), and like buildings they're listed before the terrain, so the terrain wins where they overlap under the ground. A shape raised onto a roof has a flat top, even text, which follows the ground by default. It moves with the roof or deck it was raised onto: up with a taller building, and down to what's under it once the building is removed. What a deck or roof holds up doesn't cut the water under it. A raised part of a building left on air when the part under it is removed or lowered is built down to the ground, like raised parts are by default.

A LiDAR only model is one surface with every roof and crown in it, so a road drawn on it used to climb the trees along a street and run up the face of any building it met. A drawn road that follows the ground rests on the survey's bare ground now, the same way a route does (`src/core/edit/drawn.ts`). It rides bridge decks and ramps, stays down under trees and overpasses, and goes inside a building it runs into. The trees over it are cleared: the cells are cut out of the surface and filled with the bare ground, so it runs through a park in a trench a cell wider than the road. Only what stands more than half the road's height over the ground goes, since anything lower doesn't hide it. Clutter is kept by default, and clearing every parked car along a street would cut holes all down it for nothing. Compose's canopy leaves out the rim of a lot of crowns, so cells that are mostly vegetation with nothing solid over the ground count as trees here too, and so do cells compose raised to close a gap in a crown. A drawn road raised onto something, or with `Follow the ground` off, is flat as before.

Cutting the whole surface took about a second for the Chicago Loop preset on every change to a road. So the view's copy is split once into the tiles the roads reach and the rest, and later changes only cut those tiles again: about 0.2 s to move a road on the Loop, 0.8 s when a road reaches new tiles. The split leaves walls inside the solid, so exports cut the whole surface in one go instead (`src/core/edit/surfaceCut.ts`).

What the 3D view shows and what exports come from different code: the view hides and colours objects in the generated meshes (`src/app/viewer/shown.ts`), and the export rebuilds the solids. `scripts/fuzz-edits.ts` makes random edits on real areas and checks, colour by colour, that the two hold the same volume, with nothing hidden and with some parts hidden, along with every part being closed.

## Export

- **Bambu Studio project (.3mf).** A native project with one filament per colour and Bambu PLA line, and one part per layer with its filament assigned. Each plate is one object, laid out like Bambu's own plate list.
- **PrusaSlicer project (.3mf).** One object with a volume per part and an extruder per colour.
- **3MF with colours.** A core 3MF with a base material per colour, for other tools.
- **STL.** One file per colour in a zip, or one combined file.

With multi-plate export the model is cut into equal sections no bigger than the bed. Each section is centred on its own plate and all plates share one Z datum.

## Progress

The bar used to give each stage a fixed share, and those were far off. Meshing got 10% of the bar for 40% of the time, and the download's byte total grew part way through, so the bar ran to 28% on the file footers and went back to 5%.

Now every step of a job has an estimate in seconds (`src/core/pipeline/estimate.ts`), worked out from the feature counts, and the bar is the share of that time done (`Progress` in `pipeline/context.ts`). The estimates came from timing the CLI on the regression areas. They're rough. Roads took 150 to 580 µs a segment depending on the city, and Las Vegas' interchanges are the slow end. So each step's own pace takes over from its estimate as it goes.

Estimates change during a job: the download's row counts come in before the geometry, meshing is sized from the actual solids, and a step can turn out slow. When that happens the bar stays where it is and the rest of it is shared out again, so it never goes back. A step with a real estimate that finishes early moves the bar to the end of its share. A wait that was only a guess (the download before its row counts, finding LiDAR surveys) doesn't, since what's left of a guess grows while it's stuck. One survey search stuck for 3 minutes sent the bar from 10% to 78% when it ended.

The time left shows after a couple of seconds, and only once every step ahead has a real estimate. Until the download has its row counts, or while LiDAR surveys are still being found, there's nothing to go on, so it isn't shown. Estimates are scaled by how this machine has done against them so far, and that figure is kept in localStorage for the next visit.

On eight regression areas in the CLI the bar stays within 3 to 14% of a straight line in time (San Francisco was 45% off before). Nine times out of ten the time left is within 15% of the real finish for six of them. Las Vegas and Rome are 20 to 27% off, since Las Vegas' road ribbons and Rome's land cover take about three times their estimates.

## Known limits

- Bridges are schematic: decks on evenly spaced piers, without towers, arches or trusses.
- Building data varies by city. Buildings without a mapped height use a class default.
- LiDAR only comes from publishers a browser can read from, directly or through the proxy. England after 2022, Portugal and most of Italy aren't, so they use older mirrors or have none.
- Large areas need more memory and time. Around 25 km² at the default scale is comfortable on a desktop browser.
- Areas that cross the 180th meridian (or come within 25 m of it) or come within half a degree of the poles aren't supported.
