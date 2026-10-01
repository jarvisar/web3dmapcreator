# Changelog

## Unreleased

### Added

- Racetracks print with the roads (`Layers > Roads > Racetracks`, on by default). Overture has no class for OpenStreetMap's raceways, so the oval at the Indianapolis Motor Speedway came out as bare ground. They're read from the OpenFreeMap tiles the SVG maps use: zoom 12 tiles to find them, a few hundred KB for a city area, then zoom 14 tiles over the tracks found. If the tiles can't be downloaded the model is still made, without them, and says so.
- `Layers > Water > Skip thin ground in water` and `Widen thin ground in water`, both off by default. Mapped piers, breakwaters and islands narrower than a nozzle line left a slot in the water too thin for either part to print, so they showed up as holes in the water. Skipping fills them with water, and widening grows them to the width instead, leaving out specks like mooring posts. Both default to 0.42 mm, about 6 m at the default scale. With both on, anything under the skip width goes and the rest is widened. Only ground with water on both sides counts, so quays along the shore stay as mapped. Every dock in the Clearwater preset's marinas is under 0.42 mm.
- An editor in the 3D view, as a beta. Press the pencil to select buildings, building parts, roads, paths, trees and water, by clicking them, a box around them or their name, then remove them, change a building's height, make roads wider or taller, or put any of them in a custom layer with a colour of its own. Each custom layer exports as its own part with its own filament in every format, so a racetrack or a route can print in its own colour. Text, map pins, boxes and cylinders can be added, and roads and buildings drawn, then moved, turned and reshaped. Everything added is built down to what it stands on, a roof or bridge it was raised onto or the ground, and in water down through it to the bottom. Raised onto a roof, a shape moves with it when the building is made taller or shorter, and comes down to the ground when it's removed. A removed road or building gives its ground back to the park or plaza it was cut out of, and a raised part left on air when the part under it goes is built down to the ground. Water left out is filled with ground up to its banks, or keeps its hollow for resin, and a pond in a park gets its grass back. Ground kept in the water for a road, building or pier goes with it, while a widened or drawn road over water gets ground of its own. Width edits reach bridge decks, and `Whole street` follows a street across its bridges. Edits are keyed by Overture IDs, so they stay when the settings change and the model is generated again, and a building's height is kept in real metres, so it follows a new scale. They're saved in the browser, in exported options with the map area and in copied share links, which only carry the ones on the linked area. Edits are one set for every area, so opening a share link or importing options adds its edits to yours, and anything of yours it changes is kept aside to put back, like what `Undo all` clears. Every change can be undone, from the toolbar or the toast that says what changed. It works on phones: the `Select several` tool adds what you tap, drawing has `Finish` and `Undo point` buttons, and a tapped point can be deleted.
- Routes in SVG maps. Click the roads, paths and railways a route follows in the preview and put them in a route, drawn in its own colour on its own layer, or leave them out. Copied share links carry the ones on the map, and the route card lists picks nothing on the map matched. A link's picks are added to yours, and `Undo all picks` and deleting a route can be undone.
- An SVG map's title can be dragged into place, on the map or in the preview. It stays inside the border, or inside the band for a band title. `Reset the position` under `Title` puts it back, and picking another position or piece preset starts it over.
- `scripts/generate.ts --options` rebuilds an options file exported from the app, edits and all, and `scripts/fuzz-edits.ts` checks random edits on real areas export closed and the same as the 3D view shows them.
- `Layers > Buildings > Bring raised parts down to the ground`, on by default. Parts mapped to start above the ground, like arcades, overhangs, skybridges and the tiers of a dome, are built down to meet the terrain like the rest of the building, so nothing hangs in the air. Off keeps them raised, but a part hovering less than a 0.2 mm layer over the ground or the part below it still comes down to it, since a gap that thin can't print.
- `Layers > Water > Large water` picks how rivers, lakes and the sea print. `Thin layer`, the new default, makes them a 1 mm layer of water on a floor of terrain, so the water colour only comes in for the top few layers. Before, a lake up in the hills took a colour change on every layer from the bed to its surface. On the Chicago, Clearwater, Rome, Cincinnati, Vancouver and San Francisco presets the water uses 45 to 57% less filament and prints in 3 to 6 fewer layers. The base runs under the floor too, so a model can come out a little taller, at most 0.5 mm on those presets. `Cut through the base` keeps the old behaviour, for printing the water as its own pieces or leaving openings. `Water thickness` sets the layer, and `scripts/generate.ts --cut-water` now cuts through map models too.
- `Tidy road network`, on by default, cleans up roads before they're widened. A divided road mapped as two one-way carriageways closer than the gap prints as one road down the middle (`Merge divided roads`), and the streets meeting it are extended or trimmed along their own line, so straight streets stay straight. Footways, cycle tracks, trams and service roads running alongside a more important road are left out, paths that stopped at a dropped sidewalk carry straight on to the street, stubs and specks that lead nowhere are removed, rail yards keep every track, and hairline cracks between roads of one colour are filled. Nothing prints thicker than with the tidy off, apart from a merged road running down its old median. Each step has its own switch, and `Minimum gap` sets how close two roads can run side by side. It started as a rewrite of the add-on's Tidy Road Network and was reworked after it zigzagged divided streets at every junction, thinned rail yards and car parks into ladders and joined loose ends with long diagonals. One-way streets are read from Overture for it, about 3% more road data.
- SVG maps, merged in from SVGmap. Pick `SVG map` at the top of the settings to make a flat map of the area for a laser engraver, a pen plotter or print instead of a model: plaque, paper and coaster sizes, filled, outlined or hatched layers, a title in a box or a band, and line cleanup that merges lines too close together to burn apart. The box on the map becomes the piece's map window, with the margin, border and title drawn around it. A Hebrew title in a loaded font runs right to left. See `docs/SVG_MAPS.md`.
- SVG maps take the same shapes as models, hexagons included.
- A copied share link for an SVG map carries its settings, and links from the old SVGmap site open here.
- The SVGmap example cities: Cincinnati, Vancouver, Midtown Manhattan, central Paris, London, Amsterdam, Venice and Sydney.
- The site installs as an app and opens offline. A new version waits for `Reload`.

- LiDAR only models, ported from the add-on's LiDAR Only mode. Pick `LiDAR only` at the top of `Layers` to build the whole model from a public LiDAR survey: the ground, buildings, trees and bridges as the survey saw them, in one closed solid in the terrain colour. The survey is read in 256 m blocks, up to eight at once, and each block is kept, so a cancelled read carries on where it stopped and other settings regenerate without reading again. Trees keep their crowns as scanned, or are rounded or removed, cars and other small things stay unless `Keep cars and clutter` is off, and wires, crane jibs and poles too thin to print go. Haze, cloud and birds floating over the city are left out, which cleared needles up to 50 mm tall over downtown Houston. Open water a survey mostly left unclassified, like New York's harbour, prints as water instead of a speckled web of land, and so does lake filed as ground. With `Keep cars and clutter` off, boats, buoys and pilings become water too. The cells grow to what the survey's point density fills. Exports credit the survey, and the map data only when its water outlines were used. See `docs/LIDAR_MODEL.md`.
- `Water` for LiDAR only models. `Recessed` keeps the water in the one solid. `Thin layer` prints it as a part of its own in the water colour, on a terrain floor at `Water thickness` and 0.25 mm below its bank like map models, so the water colour only comes in for the top few layers, and every body at least 0.4 mm wide gets one with its islands, boats and pilings left standing. `Cut away` cuts rivers, lakes and the sea out of the model with the add-on's rules: water above the same minimum area as map models, counted across bridges, at least 0.4 mm wide and not up on a roof. Bridges stay as solid walls, and boats and pilings go with the water.
- `Water outlines from map data` for LiDAR only models, on by default. Thin layers and cuts follow Overture's smooth shoreline where it runs within 3 m of the survey's, easing back to the survey's by 6 m, instead of the traced cells, and holes in the survey inside Overture's water are filled as water at the survey's level, like the Petit Bras in Paris that IGN leaves empty. On sea and lake beaches the waterline moves to Overture's coastline, up to 60 m, over bare ground near the water's level, so the tide or lake level on the survey day doesn't leave a ragged edge. The survey still decides everywhere else, so the bridges, piers, wharves and boats Overture's water runs under stay. It downloads 3 to 5 MB of Overture water and adds the map data credit.
- `scripts/generate.ts --lidar-only`, with `--detail`, `--water-layer`, `--cut-water`, `--no-map-water` and `--surface-out`.
- LiDAR buildings, ported from the add-on. Turn on `Layers > LiDAR` to measure buildings from public surveys and rebuild them from their scanned roofs, or only correct their heights. Surveys come from USGS 3DEP (EPT), IGN LiDAR HD, NRCan, swisstopo and Open LiDAR Data (COPC), streamed with range requests. Tiled LAZ downloads aren't supported.
- LiDAR point data has its own browser cache of up to 1 GB, and measured buildings are reused for a day.
- The surveys a model used are listed in `Model details` and in the attribution of exported 3MF files.
- `Mapped bare rock` builds cliffs and outcrops mapped as bare rock from the LiDAR surface.
- `scripts/generate.ts --lidar` for the command line.
- Measured roofs are fitted with planes instead of the add-on's edge collapse. Flat roofs come out exactly level, so they slice into one clean top layer, pitched roofs keep straight ridges and hips, and rooftop plant, chimneys, parapets and light wells too small to print are left off. Spires keep their tips. With rim vertices on straight walls thinned and the underside taken from the outline, the `Chicago - The Loop (small)` preset's buildings are about 300,000 triangles, against 1.15 million the add-on's way.

### Changed

- Box titles on round, hexagonal and rounded SVG maps go to the nearest spot that fits instead of heading for the middle of the piece. On a hexagon the box sits on the flat bottom or top, in the corner. On a circle a corner box touches the rim about 45 degrees round, where both lower corners used to end up in nearly the same spot near the middle. A title too wide to reach a corner, like a long name at full size on a 100 mm coaster, still ends up near the top or bottom middle. Band text on those shapes is fitted where the band is widest, by its straight edge, so it comes out larger. Rectangular pieces are unchanged.
- Small water touching large water, like Boston's locks at the Charles River Dam and canals mapped in pieces in Amsterdam and Venice, is sunk with it at the same level. As water under `Large water above` it was a thin sheet on the ground like a stream, and stood 0.4 to 0.6 mm above the water beside it. It carries on through chains of small pieces, and a piece more than 15 m (real) above or below the water it touches stays a sheet, so a stream climbing away from a lake still follows the ground. Tagged ponds and fountains keep their own level. Turn off `Layers > Water > Join small water to large water` for the old behaviour. Areas without small water beside large water, like the Chicago, Clearwater, San Francisco and Rome presets, come out the same.
- Road and water names are read from Overture, for labelling what the editor selects and finding things by name. It's under 1% more road and water data.
- With `Keep ground under structures in water` off, roads, buildings and bridge piers standing in cut water or a pond are built down through it in their own colour, to the floor of the recess or the base, instead of being cut back to the shore. Mapped piers, quays, breakwaters and dams are ground whether it's on or off, so they're always read.
- Bridge piers standing partly in water, or in a pond, have ground under all of the part in the water. Only piers whose middle was in cut water did, and the rest stood on air there.
- Options files can be up to 8 MB, and leave picked SVG roads out unless the map area goes too.
- `Layers > Parks and land cover > Satellite land cover` is new and off by default, so parks and forest come from mapped data only. Overture's land cover comes from ESA WorldCover, whose tree class counts tree-lined streets and gardens as forest, and leafy cities came out almost all green. The middle of a 10 km area of west Cincinnati was 60% forest, where its mapped woods, like an SVG map of the same area, cover 27%. `Scatter in satellite forest` under `Trees` still uses it.
- An SVG map's scale is typed in mm per metre like a model's, and is fixed at 0.05 mm per metre (1:20,000) by default. Give it the piece size and the scale and the box on the map is sized to match. `Fixed scale` and `Fit the area` under `Area > Size` replace the lock button. With `Fit the area` you resize the box yourself and the scale follows, like before. Saved settings keep the scale they had, so switch to `Fixed scale` to pick the new default up.
- `Layers > Land > Slope beaches into water` works differently and is off by default. It used to thin the sand from its full height to 0.1 mm at the waterline, on terrain that still ended in a bank above the water. Now it slopes the ground itself down to the water's surface under sand beside cut water, and the sand keeps its thickness on top, like every other surface. Sand mapped a little short of the water is run on to it. Roads, buildings and bridges by the water keep their bank. Off, sand is a plain slab that ends at a bank like parks and paving.
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

- The same streets could be green in a large model and plain in a small one. Satellite land cover comes in tiles 30 to 40 km across, and one tile's forest was dropped from areas under about 10 km across as a regional polygon and kept in larger ones. Land cover is now picked by zoom level, so it's the same at any size. With trees on, small areas now get satellite forest trees too, like large ones already did.
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
- Small water touching large water is sunk with it at its level instead of sitting on the ground as a sheet.
- Land cover is cleared under buildings as well as under roads and water. Strips narrower than about 0.2 mm are removed.
- Bridges use a simpler network solve: loose ends touch down on the road, decks climb at most 8% to clear what they cross, and networks too low to read as bridges become roads.
- Buildings on the edge of the area are cut through instead of getting a new roof, and pyramid or dome roofs on concave footprints stay flat.

### Not included

- LiDAR buildings.
- Tidy Road Network (it was off by default in the add-on).
- Editing the model before export, and per-building objects with source metadata.
