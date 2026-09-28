# Changelog

## Unreleased

### Added

- LiDAR buildings, ported from the add-on. Turn on `Layers > LiDAR` to measure buildings from public surveys and rebuild them from their scanned roofs, or only correct their heights. Surveys come from USGS 3DEP (EPT), IGN LiDAR HD, NRCan, swisstopo and Open LiDAR Data (COPC), streamed with range requests. Tiled LAZ downloads aren't supported.
- LiDAR point data has its own browser cache of up to 1 GB, and measured buildings are reused for a day.
- The surveys a model used are listed in `Model details` and in the attribution of exported 3MF files.
- `Mapped bare rock` builds cliffs and outcrops mapped as bare rock from the LiDAR surface.
- `scripts/generate.ts --lidar` for the command line.
- Measured roofs are lighter than the add-on's: rim vertices on straight walls are thinned and the underside comes from the outline, about a quarter of the triangles for the same shape.

### Changed

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
