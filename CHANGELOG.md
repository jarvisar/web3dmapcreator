# Changelog

## Unreleased

### Added

- `Layers > Buildings > Bring raised parts down to the ground`, on by default. Parts mapped to start above the ground, like arcades, overhangs, skybridges and the tiers of a dome, are built down to meet the terrain like the rest of the building, so nothing hangs in the air. Off keeps them raised, but a part hovering less than a 0.2 mm layer over the ground or the part below it still comes down to it, since a gap that thin can't print.
- `Layers > Water > Large water` picks how rivers, lakes and the sea print. `Thin layer`, the new default, makes them a 1 mm layer of water on a floor of terrain, so the water colour only comes in for the top few layers. Before, a lake up in the hills took a colour change on every layer from the bed to its surface. On the Chicago, Clearwater, Rome, Cincinnati, Vancouver and San Francisco presets the water uses 45 to 57% less filament and prints in 3 to 6 fewer layers. The base runs under the floor too, so a model can come out a little taller, at most 0.5 mm on those presets. `Cut through the base` keeps the old behaviour, for printing the water as its own pieces or leaving openings. `Water thickness` sets the layer, and `scripts/generate.ts --cut-water` now cuts through map models too.
- `Tidy road network`, on by default, cleans up roads before they're widened. Lines doubling a more important one are left out, like the second carriageway of a divided street (the one kept moves onto the middle of the street) or a footway mapped beside a street, paths that stopped at a dropped sidewalk are joined to the street, stubs and specks that lead nowhere are removed, and ground too thin to print between two roads side by side is filled in. Each step has its own switch, and `Minimum gap` sets how close two roads can run side by side. It's a rewrite of the add-on's Tidy Road Network, with spurs and specks judged on a graph of the lines as they'll print. On the `Chicago - The Loop (small)` preset, loose specks of road filament went from 229 to 11.
- SVG maps, merged in from SVGmap. Pick `SVG map` at the top of the settings to make a flat map of the area for a laser engraver, a pen plotter or print instead of a model: plaque, paper and coaster sizes, filled, outlined or hatched layers, a title in a box or a band, and line cleanup that merges lines too close together to burn apart. The box on the map becomes the piece's map window, with the margin, border and title drawn around it. See `docs/SVG_MAPS.md`.
- SVG maps take the same shapes as models, hexagons included.
- A copied share link for an SVG map carries its settings, and links from the old SVGmap site open here.
- The SVGmap example cities: Cincinnati, Vancouver, Midtown Manhattan, central Paris, London, Amsterdam, Venice and Sydney.
- The site installs as an app and opens offline. A new version waits for `Reload`.

- LiDAR only models, ported from the add-on's LiDAR Only mode. Pick `LiDAR only` at the top of `Layers` to build the whole model from a public LiDAR survey: the ground, buildings, trees and bridges as the survey saw them, in one closed solid in the terrain colour. The survey is read in 256 m blocks, up to eight at once, and each block is kept, so a cancelled read carries on where it stopped and other settings regenerate without reading again. Cars, cranes and clutter are removed, trees are rounded or removed, and the cells grow to what the survey's point density fills. Exports credit the survey instead of the map data. See `docs/LIDAR_MODEL.md`.
- `Cut away water` for LiDAR only models cuts rivers, lakes and the sea out of the model instead of recessing them, with the add-on's rules: water above the same minimum area as map models, counted across bridges, at least 0.4 mm wide and not up on a roof. Bridges stay as solid walls, and boats and pilings go with the water.
- `scripts/generate.ts --lidar-only`, with `--detail`, `--cut-water` and `--surface-out`.
- LiDAR buildings, ported from the add-on. Turn on `Layers > LiDAR` to measure buildings from public surveys and rebuild them from their scanned roofs, or only correct their heights. Surveys come from USGS 3DEP (EPT), IGN LiDAR HD, NRCan, swisstopo and Open LiDAR Data (COPC), streamed with range requests. Tiled LAZ downloads aren't supported.
- LiDAR point data has its own browser cache of up to 1 GB, and measured buildings are reused for a day.
- The surveys a model used are listed in `Model details` and in the attribution of exported 3MF files.
- `Mapped bare rock` builds cliffs and outcrops mapped as bare rock from the LiDAR surface.
- `scripts/generate.ts --lidar` for the command line.
- Measured roofs are fitted with planes instead of the add-on's edge collapse. Flat roofs come out exactly level, so they slice into one clean top layer, pitched roofs keep straight ridges and hips, and rooftop plant, chimneys, parapets and light wells too small to print are left off. Spires keep their tips. With rim vertices on straight walls thinned and the underside taken from the outline, the `Chicago - The Loop (small)` preset's buildings are about 300,000 triangles, against 1.15 million the add-on's way.

### Changed

- Beaches slope into the water, ground and all. Only the sand used to slope, on top of terrain that still ended in a bank above the water. Now the ground itself slopes down to the water's surface and the sand thins out on it to a 0.1 mm lip at the waterline. Sand mapped a little short of the water is run on to it, instead of leaving a strip of bare ground along the beach. A narrow beach climbs to full height where the park or rock behind it starts, instead of meeting it with a step. Roads, buildings and bridges by the water keep their bank.
- Parks, roads, buildings, piers and trees reach 0.04 mm into the terrain instead of 0.15 mm, and 3MF exports list the terrain after them and water after the terrain. PrusaSlicer, Bambu Studio and OrcaSlicer give an overlap to the part listed later, so a park or road could print a layer below the ground at the model's edges and shores. The terrain wins it now. Filament numbers stay the same, with the terrain first.
- Ponds, fountains and basins are always sunk, 0.25 mm below their lowest bank at the water thickness, with either water setting. `Recess ponds and fountains`, `Recess depth` and `Pond water thickness` are gone. With the recess off, large ponds were cut through the base and small ones sat on the terrain.
- Trees rest on the lowest ground under their base and bridge piers follow the ground under them, so neither lifts off a slope. With the old 0.15 mm overlap, trees on steep ground already floated a little on their downhill side.
- Small water sheets are as thick as `Water thickness` (1 mm, was 1.2 mm) and always reach into the terrain at least as far as `Embed into terrain`.
- LiDAR only walls come out flat instead of ribbed. Tall facades were a row of narrow vertical stripes, from facade relief too narrow to print and from each wall's crooked foot. Relief under 0.3 mm is now straightened like it is on measured roofs, walls get a little more room to straighten, and each wall's foot is moved in line with its roof edge. On Micropolitan's Chicago, Philadelphia and San Francisco areas the stripes went down 39 to 50%, with 21 to 29% fewer triangles.
- The outline of cut water in LiDAR only models follows the shore to a cell and a half instead of three quarters, so a bank wall is a few long panels instead of many narrow ones.
- Indoor corridors and skyways are left out like tunnels. They only printed where they poked out of a building.
- Area sizes are kept to the centimetre instead of the metre, so an SVG map's scale stays at what was typed.
- Cutting a measured roof or a LiDAR only surface to a section or the area's shape only runs the triangles near the cut through the constrained triangulation. A section of a city-sized LiDAR surface took 5 s and takes about half a second.
- Reading LiDAR for buildings works out each return's capture year from a table instead of a date object, about 9 times faster.
- The site moved to https://citymodel.jarvisar.com/. The old web3dmapcreator.jarvisar.com address redirects there. Browsers keep saved settings and cached map data per address, so those start fresh on the new one.
- New look: the system font, gradient buttons, a dark header, section bars and checkboxes for the layers. Dark mode follows the same style.
- One Download button, in the bar under the settings. Export errors show there too, instead of inside the Export section.
- The layer list shows the filament colour of each layer.
- Terrain exaggeration is only under `Layers > Terrain` now, not in `Print size` as well.
- Help shows how much map data the browser keeps, with a link to clear it.
- Exports are written in pieces, so a large single STL needs about a third of the memory it did.
- Map data is cached per page, so moving the area a little downloads less. Elevation tiles no longer queue behind the map data.
- Areas with many lakes or large detailed forests generate much faster (37 s to 0.5 s and 12.5 s to 0.2 s in the worst cases found).

### Fixed

- Flickering in the 3D view where parks, roads and buildings meet the terrain at the model's edges and shores. The terrain shows there, the way it prints.
- The plate count on screen could differ from the export. A 3 km area at the default scale showed 1 plate and exported 4.
- The 36-plate limit applied to every format. It's only for Bambu Studio projects now, and it's checked before anything is meshed.
- The sea or a bay running off the edge of the model sat up to 1.3 mm too low.
- Water mapped as overlapping polygons, like a harbour and the river flowing into it, prints as one body at one level. Ponds mapped inside a river no longer overlap it.
- A lake that only reaches into a corner of the area is cut through the base like the rest of it.
- Bridge piers could stand outside the model. A ramp that meets another deck partway along joins it instead of dropping to the road.
- The border rim was missing from multi-plate exports.
- A PrusaSlicer project split into sections opened with the sections scattered around and off the bed, because PrusaSlicer 2.9 recentres the file. They now open side by side on the first bed, ready for Arrange.
- Trees could grow inside buildings when `Keep trees off roads` was off, hang over the model edge or cross section seams. Forests mapped as land use get trees.
- Building heights over 1,000 m or 200 floors are treated as mapping errors.
- Mapped piers keep their ground with parks and land cover turned off.
- Missing elevation tiles give a warning instead of silently reading as sea level.
- A new Overture release without an optional data type no longer stops generation.
- The 3D view kept its graphics context after closing, so many failed generations in a row could blank the map.
- Generate could hang on "Starting" after the page's worker failed to load, for example after a new deploy. It now asks you to reload.
- Tabbing through a number field rounded its value. A comma typed as the decimal point ("0,4") is read as one.
- The place name, and so the file name, was lost on reload.
- Keyboard focus now goes into the Presets menu and the colour picker, and back to `Settings` when the phone drawer closes.
- Saved settings outside the allowed ranges are clamped when loaded instead of breaking generation.
- A roof cap or LiDAR only surface whose flat underside couldn't be triangulated from its outline got a copy of its whole top surface underneath. A constrained triangulation of the outline is tried first now, so a surface cut along a river no longer doubles in size.

## 1.0.0

First web release, ported from the Jarvizar City Model Blender add-on (0.25.8).

### Added

- Runs in the browser. Map data comes straight from Overture's GeoParquet files and elevation from the AWS Terrain Tiles, with no server, Blender or Python downloader.
- Only the rows and pages of the Overture files that the area needs are downloaded, and downloads are cached in the browser (up to 400 MB).
- Area editor on the map: move, resize and rotate the area, with rectangle, rounded rectangle, circle and hexagon shapes.
- Place search, typed coordinates, pasted bounds, presets and share links.
- 3D preview with the printer bed, part visibility, model details and screenshots. Hidden parts are left out of the download.
- PrusaSlicer project and 3MF with colours export, besides the Bambu Studio project and STL.
- Printers from Prusa and generic bed sizes, besides the Bambu Lab models.
- Light and dark themes, and a layout for phones.

### Changed from the add-on

- The area is set in metres around a centre and can be rotated, so the model can follow a street grid. Its shape crops the model directly instead of through a frame object.
- Plate sections are cut in 2D before meshing, so every section is made of closed parts.
- Ground kept under structures over water is part of the terrain itself instead of separate supports.
- Land cover is cleared under buildings as well as under roads and water. Strips narrower than about 0.2 mm are removed.
- Bridges use a simpler network solve: loose ends touch down on the road, decks climb at most 8% to clear what they cross, and networks too low to read as bridges become roads.
- Buildings on the edge of the area are cut through instead of getting a new roof, and pyramid or dome roofs on concave footprints stay flat.

### Not included

- LiDAR buildings.
- Tidy Road Network (it was off by default in the add-on).
- Editing the model before export, and per-building objects with source metadata.
