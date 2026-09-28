# Changelog

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
