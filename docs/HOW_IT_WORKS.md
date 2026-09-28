# How It Works

Technical notes on how a model is built. For everyday use see the [README](../README.md).

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

- **Cut water.** Rivers, lakes and the sea above 5,000 m², measured on the whole feature, so a lake that only reaches into a corner of the area is still cut. These are cut through the base. The water fill is a separate solid from the underside of the model up to the water surface, so it prints as its own colour from the bed up.
- **Ponds, fountains and basins.** Identified by their tags and classes, never by size or name, plus untyped water under 5,000 m². These are recessed 1 mm into the terrain with 0.8 mm of water in them.
- **Water sheets.** Other small water. A thin flat slab sits 0.18 mm above the terrain, which is flattened under it.

Ponds and sheets that lie in cut water are trimmed to the part outside it, so the parts don't overlap.

A body's level is the median of the terrain inside it, because elevation data reports open water as a noisy plateau at its surface. Some data carries bathymetry instead, so cut water is never set below the low tenth of its connected shoreline. Only shore inside the area counts, so the sea running off the edge isn't dragged down to the seabed. Cut water mapped as several overlapping polygons, like a harbour and the river flowing into it, becomes one body at one level. The grid under cut water is flattened to the level and the shore around it is raised to at least that level. Cut water then sits 0.25 mm under the bank, so one printed layer of bank always shows.

With `Keep ground under structures over water` on, the terrain is kept under roads, buildings and mapped piers that stand over cut water or a basin, so nothing hangs over an opening. Turning it off clips roads and buildings at the water's edge instead.

## Surfaces

Parks, forest, sand, rock and paving come from `land`, `land_use` and `land_cover` (vegetation only), through allowlists of classes (`src/core/pipeline/classify.ts`). An unrecognised class produces nothing rather than a guess. Polygons more than 8 times the size of the selection are regional features and are skipped.

Categories never overlap: the priority order (paved, sand, rock, green, forest by default) decides who owns shared ground. Water, roads and building footprints are cut out of every slab. Strips narrower than about 0.2 mm are removed, since they can't print as a colour of their own. Slabs rise 0.4 mm above the terrain and reach 0.15 mm into it, following the ground across their whole area. Sand beside cut water slopes down to the waterline over 1.5 mm.

## Roads

Transportation segments are split at every scoped rule boundary (`between` ranges on flags, widths, levels and subclasses) before anything is read, so a partial bridge or tunnel isn't lost. Tunnels are skipped, and by default so are sidewalks and crossings mapped beside a street.

Widths come from the mapped width or a class default, clamped between 0.45 and 0.7 mm printed. Centerlines are buffered with round joins and unioned per group (roads, railways, paths), so overlapping pieces become one solid. Roads win over rail at level crossings, and both win over paths. Ribbons are 0.6 mm tall. Runways, taxiways, aprons and helipads from `infrastructure` print as airport paving.

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

## Meshes

Almost everything is a 2.5D prism: a polygon with a top and bottom height at every point and vertical walls (`src/core/geometry/solid.ts`). The mesher (`src/core/geometry/mesher.ts`) triangulates the polygon once and uses it for both caps. Where a surface follows the terrain it adds interior points on the grid's lattice and uses a constrained Delaunay triangulation, so the outline stays exact. Walls run along every boundary edge. Each shell is closed and consistently wound by construction, and the mesher checks that every cap covers its polygon exactly before using it. Polygons whose rings touch at a single point are shrunk by a tenth of a micron so four walls never share one edge.

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
- Large areas need more memory and time. Around 25 km² at the default scale is comfortable on a desktop browser.
- Areas that cross the 180th meridian or come within half a degree of the poles aren't supported.
