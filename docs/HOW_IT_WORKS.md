# How It Works

Technical notes on how a model is built. For everyday use see the [README](../README.md), and for the flat maps see [SVG maps](SVG_MAPS.md).

Everything runs in the browser. The page starts a Web Worker that downloads the data, runs the geometry pipeline and writes the export files, so the page stays responsive while a model is built. Nothing is sent to a server apart from the data requests themselves and the place search.

## Units and scale

One model unit is one printed millimetre. The default scale is 0.07 mm per real metre (about 1:14,286), the scale the Blender add-on used. At that scale a 6.5 m residential street prints 0.455 mm wide, which is just over one line of a 0.4 mm nozzle. `Fit to size` picks the scale from the longest side instead.

Coordinates go from WGS84 through a local East/North/Up frame centred on the area, then get rotated so the area's own "up" is +Y, then scaled. Every layer goes through that one projection (`src/core/geo/projection.ts`). The area itself is defined in metres around a centre, so a 2 km square is a 2 km square anywhere on the globe.

## Data

Map data comes from the latest [Overture Maps](https://overturemaps.org) release, read straight from its GeoParquet files on Amazon S3:

1. `stac.overturemaps.org` lists every release and has a small index of every file with its bounding box.
2. For each needed type (buildings, building parts, road segments, water, land, land use, land cover, infrastructure), only the files whose box meets the area are opened.
3. Each file's footer is read with a range request, and row groups are skipped using the statistics of the `bbox` columns ([hyparquet](https://github.com/hyparam/hyparquet)).
4. A first pass reads only the small columns (bbox, class, heights, road rules) and picks the rows generation can use: inside the area, and of a class some layer turns into geometry. Regional polygons many times the size of the area are dropped here too.
5. A second pass reads the geometry of just those rows. The files have no page index, so the page headers of the geometry column are walked to find which pages hold them.

Features that cross the edge are kept whole and clipped later. An area that would need more than 300 MB is refused before any geometry is downloaded.

Downloaded byte ranges are kept in the browser's IndexedDB (up to 400 MB), so generating the same area again, or changing a setting, doesn't download it again.

Elevation comes from the AWS Terrain Tiles open dataset in its Terrarium PNG encoding. The zoom level is picked so a tile pixel is about as fine as the terrain grid.

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

A body's level is the median of the terrain inside it, because elevation data reports open water as a noisy plateau at its surface. Some data carries bathymetry instead, so cut water is never set below the low tenth of its connected shoreline. Only shore inside the area counts, so the sea running off the edge isn't dragged down to the seabed. Cut water mapped as several overlapping polygons, like a harbour and the river flowing into it, becomes one body at one level. The grid under cut water is flattened to the level and the shore around it is raised to at least that level. Cut water and ponds then sit 0.25 mm under the bank, so one printed layer of bank always shows.

With `Keep ground under structures over water` on, the terrain is kept under roads, buildings and mapped piers that stand over cut water or a basin, so nothing hangs over the water. Turning it off clips roads and buildings at the water's edge instead.

## Surfaces

Parks, forest, sand, rock and paving come from `land`, `land_use` and `land_cover` (vegetation only), through allowlists of classes (`src/core/pipeline/classify.ts`). An unrecognised class produces nothing rather than a guess. Polygons more than 8 times the size of the selection are regional features and are skipped.

Categories never overlap: the priority order (paved, sand, rock, green, forest by default) decides who owns shared ground. Water, roads and building footprints are cut out of every slab. Strips narrower than about 0.2 mm are removed, since they can't print as a colour of their own. Slabs rise 0.4 mm above the terrain and reach 0.15 mm into it, following the ground across their whole area. Sand beside cut water slopes down to the waterline over 1.5 mm.

## Roads

Transportation segments are split at every scoped rule boundary (`between` ranges on flags, widths, levels and subclasses) before anything is read, so a partial bridge or tunnel isn't lost. Tunnels and indoor corridors are skipped, and by default so are sidewalks and crossings mapped beside a street.

Widths come from the mapped width or a class default, clamped between 0.45 and 0.7 mm printed.

Before they're widened, the centerlines are tidied (`src/core/pipeline/network/`). As mapped, both carriageways of a divided street print as one band with a hairline of ground down the middle, footways drawn beside streets without the sidewalk tag double every block, and the steps and scraps that joined dropped sidewalks and tunnels print as loose specks. `Tidy road network` has four steps, each with its own switch:

- `Remove doubled lines`: routes are judged most important first, motorway down to footway, with rail between the streets and the service roads. A line running beside a kept one closer than `Minimum gap` (0.4 mm, edge to edge) is doubled. Paths lose just their doubled stretches. A street only goes when two thirds of it is doubled, and keeps any stretch nothing doubles, joined back onto the road that doubled it. Pieces of one class are welded through straight junctions first, so a divided street keeps one carriageway all the way instead of hopping sides at each cross street. The one kept then moves onto the middle of the street, or the road would jog sideways by half the median wherever the carriageways split and join again.
- `Join loose ends`: a path or street whose partner was left out, like a park path that stopped at a sidewalk, is joined to a road within twice the gap. A real dead end is only joined when the ground left would be too thin to print.
- `Remove stubs and specks`: on a graph of the lines as they'll print, a spur whose loose end met something that's gone is removed when less than 0.7 mm of it shows past its junction, a real dead end when less of it shows than it is wide, and anything touching nothing that's shorter than 1.4 mm in all.
- `Fill gaps too thin to print`: ground narrower than the gap between two roads running side by side, like the gore where a ramp leaves a motorway or a street beside a ramp it doesn't quite double, is filled in so they print as one wider road. Street corners keep their shape.

Rail yards come out as a few tracks with printable gaps between them, not the solid band their overlapping tracks made before.

Centerlines are buffered with round joins and unioned per group (roads, railways, paths), so overlapping pieces become one solid. Roads win over rail at level crossings, and both win over paths. Ribbons are 0.6 mm tall. Runways, taxiways, aprons and helipads from `infrastructure` print as airport paving.

## Bridges

Bridges are off by default. When on, pieces flagged as bridges and unflagged roads crossing cut water become decks. Connected pieces are solved as one network, including a ramp that ends partway along another deck. Loose ends touch down on the road surface, except where the model's edge cut the bridge off. The deck climbs no steeper than 8% towards a height that clears whatever is under it by 0.4 mm. A network that never rises 0.2 mm above the road prints as a road, unless it crosses open water. Piers stand every 30 m inside the area, clear of the ends and of roads below, on ground kept for them in the water.

## Buildings

Buildings and building parts follow the add-on's rules (`src/core/pipeline/buildings/`):

- Height is the mapped `height`, then `num_floors` times 3 m, then a class default (30 m for a stadium, 3 m for a shed), then 10 m.
- `height` is the top of a mass above the ground, not a thickness above `min_height`.
- A parent is replaced by its parts when the parts carry heights. It's kept (or restored) when the parts only cover part of it.
- A plain footprint published again over another building's parts is dropped.
- Every mass of one building sits on the lowest ground under the whole building, so parts of equal height end level. Undersides follow the terrain 0.15 mm below its surface.
- Heights are scaled by 1.1 so buildings read clearly over the roads, and footprints of at least 0.6 x 0.6 mm are raised to at least 0.8 mm tall.
- Gabled, hipped, skillion, pyramidal and dome roofs are built from `roof_shape`. Each planar part of a roof is its own prism.

## LiDAR

With `LiDAR` on, buildings are measured from public LiDAR surveys before the model is built (`src/core/lidar/`). It's a port of the add-on's LiDAR pipeline, limited to surveys a browser can stream. Tiled LAZ downloads aren't read.

Surveys are found per provider (`sources/`):

- USGS 3DEP in the United States, through Hobu's EPT mirror on AWS. Its catalog is a 9 MB GeoJSON of every survey outline, kept for a day.
- IGN LiDAR HD in France (WFS tile index), NRCan in Canada (ArcGIS tile index) and swisstopo swissSURFACE3D (STAC), all as COPC tiles.
- Open LiDAR Data by Flai, from its published inventory and each dataset's shapefile tile index.

The national services are only asked inside a box around their country. A survey can measure a building when its outline holds the whole footprint.

Reading (`read/`):

- EPT: the hierarchy is walked down to the depth with about 0.35 m point spacing, and only nodes that meet the area are downloaded. Nodes are additive, so their ancestors are read too.
- COPC: the header, then the hierarchy pages that meet the area, then each node as one range read. A server that ignores the range is an error, never a whole-file download.
- Points are cropped, noise and withheld returns dropped, and classes mapped to ground, building, vegetation and unclassified. Z units come from the header or the catalog. Without either, metres are assumed only outside regions with a height system in feet (the US, Ireland, Kuwait and the Cayman Islands).
- LAZ is decompressed in WebAssembly by [laz-rs](https://github.com/tmontaigu/laz-rs) (`@voxelkloud/wasm-codecs`), skipping colour and intensity. Grids other than web Mercator go through proj4, with definitions for the national grids the providers use built in.

Buildings are measured in 400 m batches, each read with a 30 m margin so every roof and the ground around it is whole. A read stops at 8 million points and the batch is split in two. Up to four batches run at once, each in a worker of its own (one fewer than the cores). Batch results are kept in the LiDAR cache, and the whole area's result is reused for a day if nothing failed. The workers' downloads go through the engine worker, which fetches each file once for all of them and keeps recent ones in memory, since every batch reads the same coarse EPT nodes. The `Chicago - The Loop (small)` preset measures 610 of its 1,308 buildings from about 790 MB in 3.5 to 4 minutes the first time.

Measuring follows the add-on:

- The ground is a plane fitted to ground returns within 25 m of the footprint, or a nearby ground height where no plane fits.
- A building needs returns across its footprint and observed ground around it. Otherwise it keeps its mapped shape and the reason is counted.
- The roof envelope starts from the second highest return in each cell. Cells are 0.035 mm printed, kept between 0.5 and 0.8 m. The grid is smoothed, filled and faired, then fitted with planes and triangulated (below), with the outline kept exact.
- Where the envelope doesn't fit, it falls back to roof planes, flat terraces and finally a single height.
- `Measure > Heights only` keeps the mapped shapes and only corrects their heights.

Where several surveys cover a building, one is picked by coverage, classification and capture date against the building's construction year. A measurement far from the mapped height is only used with `Prefer LiDAR on conflicts` on. With it off, mapped parts with more detail than the measurement are kept, like a tower on a podium measured as one flat top.

From the faired grid on, the web app goes its own way. The add-on simplified a TIN of the grid with a quadric edge collapse priced against the faces as they were. That let a vertex slide down a wall a little at a time until a penthouse was a pyramid, made pitched roofs a crumple of facets, and left flat roofs a few centimetres off level here and there, which a slicer prints as speckled part-layers. Now (`regularize.ts`, `delatin.ts`, `coarsen.ts`):

- Planes are grown over the grid much like roofer (3D BAG) does on points: a cell joins a plane within 0.3 m of it when the slope of its 3 x 3 neighbourhood is within 25 degrees of the plane's. A second, looser pass (1.3 m, any slope) catches rough roofs, like one covered in plant or a lattice crown. Planes under 3 degrees are made exactly level.
- Every cell then takes a plane or keeps its measured height, whichever costs least. Moving a cell costs how far it moves, square to the plane, and each cell edge between two labels costs a fixed amount, sized so a bump about 0.3 mm across and one 0.2 mm layer tall, printed, is the smallest that stays. Rooftop plant, parapets, chimneys and vents go, a penthouse stays. Raising a cell costs at most a layer, so a pit narrower than 0.3 mm closes however deep it is, as it would in the slicer. Ridges, hips and steps end up where the planes meet.
- The grid is triangulated by greedy insertion (a port of Delatin) until every cell is within a cell's pitch of the TIN up and down on a flat part, and half a pitch across a wall, so a diagonal wall runs straight past the staircase of cells it crosses. Merging vertices along straight steps then removes most of what insertion put there.
- Spires skip the tidying, keep their upper returns rather than the median, which rounds a tip off by metres, and are held to a quarter of the error.
- Clipping to the footprint leaves a rim vertex every half metre along the walls, and one on a straight stretch of outline is removed when the roof around it stays within half a cell. The flat underside is triangulated from the outline instead of copying the roof's triangles.

Relief narrower than about 0.3 mm doesn't print as anything but a blob, so it's left off rather than kept for the 3D view. At a larger print scale the same rules keep more of it. On the `Chicago - The Loop (small)` preset the buildings come to 298,000 triangles. The add-on's way took 1.15 million, and 326,000 with the thinned rim and the underside from the outline.

A measured roof is a solid of its own: the TIN on top, a flat underside and walls along the outline, standing on a prism down to the terrain. Section cuts clip the TIN with a constrained triangulation, so the pieces stay closed. Constrainautor can rescan forever when an outline grazes a TIN vertex, so its work is capped and a stuck cut is retried with the outline moved in by a millionth of its size. A Paris building on the model's edge used to hang generation there.

Up to the faired grid, the measurement code was checked against the add-on's Python (algorithm 29) on the same point clouds. Given the same footprint and ground it gave the same grid, down to the order floats are summed in. That takes a few things another developer might want to tidy:

- `geos.ts` reproduces GEOS 3.13's minimum rotated rectangle and double-double line intersections, and CPython's `math.dist`. The measurement grid follows the rectangle's longest side, and opposite sides are equal to within rounding. A generic rectangle fit turned half of all grids by 180 degrees.
- `centroid` and `rotate` follow GEOS and `shapely.affinity` operation for operation, and the envelope uses a single footprint as given rather than through Clipper, which rounds to 0.1 mm.

Buffers still come from Clipper rather than GEOS, so the 25 m ring the ground is fitted in has slightly different arcs, and the ground can come out up to 0.7 mm apart.

## LiDAR only models

With `LiDAR only`, none of the above is used. The survey is read over the whole area into a grid of about 0.7 m cells, heights are decided per cell (holes filled, water flattened or cut away, trees rounded, clutter removed), and the grid is meshed into one closed solid in the terrain colour. It's a port of the add-on's LiDAR Only mode with a few changes. [LiDAR only models](LIDAR_MODEL.md) has the details.

## Meshes

Almost everything is a 2.5D prism: a polygon with a top and bottom height at every point and vertical walls (`src/core/geometry/solid.ts`). Trees and measured LiDAR roofs are the exceptions. The mesher (`src/core/geometry/mesher.ts`) triangulates the polygon once and uses it for both caps. Where a surface follows the terrain it adds interior points on the grid's lattice and uses a constrained Delaunay triangulation, so the outline stays exact. Walls run along every boundary edge. Each shell is closed and consistently wound by construction, and the mesher checks that every cap covers its polygon exactly before using it. Polygons whose rings touch at a single point are shrunk by a tenth of a micron so four walls never share one edge.

Because solids stay 2D until the end, cropping to a circle or hexagon and splitting into plates are plain polygon clips. Every section's parts are closed shells, like the whole model.

Parts are separate solids that overlap slightly (roads and slabs reach 0.15 mm into the terrain). Slicers union them. The model is not one fused manifold.

## Export

- **Bambu Studio project (.3mf).** A native project with one filament per colour and Bambu PLA line, and one part per layer with its filament assigned. Each plate is one object, laid out like Bambu's own plate list.
- **PrusaSlicer project (.3mf).** One object with a volume per part and an extruder per colour.
- **3MF with colours.** A core 3MF with a base material per colour, for other tools.
- **STL.** One file per colour in a zip, or one combined file.

With multi-plate export the model is cut into equal sections no bigger than the bed. Each section is centred on its own plate and all plates share one Z datum.

## Known limits

- Bridges are schematic: decks on evenly spaced piers, without towers, arches or trusses.
- Building data varies by city. Buildings without a mapped height use a class default.
- LiDAR only comes from streamed EPT and COPC surveys, so England, most of Germany and Spain have none, for buildings or LiDAR only models.
- Large areas need more memory and time. Around 25 km² at the default scale is comfortable on a desktop browser.
- Areas that cross the 180th meridian or come within half a degree of the poles aren't supported.
