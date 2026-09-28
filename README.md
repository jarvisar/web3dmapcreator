# Jarvizar City Model

Turn any area of the map into a multicolour 3D printable city model, right in your browser. It builds terrain, water, parks, roads and buildings from [Overture Maps](https://overturemaps.org) data and public elevation tiles, optionally measures the buildings from public LiDAR surveys, and sizes it all for FDM printing with a 0.4 mm nozzle, and exports a Bambu Studio project with one filament per colour.

Visit the [GitHub Pages site](https://citymodel.jarvisar.com/) to use the latest version.

![The Chicago Loop at the default scale, 149 x 110 mm](docs/images/preview.png)

This is the web version of my Blender add-on. It runs the same generation rules, ported to TypeScript, so there's nothing to install: no Blender and no Python downloader.

## How to Use

1. Search for a place, pick one of the `Presets`, or drag the box on the map. Drag a corner to resize it and the round handle to rotate it.
2. Pick a shape (rectangle, rounded, circle or hexagon) and check the printed size under `Print size`. The default scale is 0.07 mm per metre, so a 2 km wide area prints 140 mm wide.
3. Turn layers on or off under `Layers`, and pick filament colours under `Colours`. The Bambu PLA Basic and Matte colours are built in. Turn on `LiDAR` to measure buildings from a public survey where one covers the area.
4. Click `Generate model`. The map data downloads first, which takes a few seconds for a small area.
5. Look the model over in the 3D view, then click `Download`.

Open the 3MF in Bambu Studio with `File > Open Project`. Every part already has its filament, so check the filaments against what's loaded in your AMS, recalculate the flushing volumes and slice. For other slicers, pick a PrusaSlicer project, a 3MF with colours or an STL zip under `Export`.

`Copy share link` copies a link that opens the same area.

## Features

- Terrain from public elevation data, with rivers, lakes and the sea cut through the base as separate water parts
- Recessed ponds and fountains
- Parks, forest, sand, rock and paving, each as its own colour
- Roads, paths, railways and airport paving, widened where needed so they print with a 0.4 mm nozzle
- Buildings from mapped heights and building parts, with gabled, hipped, skillion, pyramid and dome roofs
- Optional LiDAR buildings, rebuilt from their scanned roofs with setbacks, towers, domes and spires, from USGS 3DEP, IGN France, NRCan, swisstopo and Open LiDAR Data
- Optional bridges on piers, trees and a border rim
- Crop to a rectangle, rounded rectangle, circle or hexagon, rotated to follow the street grid
- Fixed print scale, or fit the model to a size
- Large models split into sections, one per plate
- Exports a Bambu Studio project, a PrusaSlicer project, a 3MF with colours, or STL files
- Colour presets, including a 4-colour AMS palette and a single-colour one
- Runs entirely in the browser. Downloaded data is cached, so changing a setting regenerates quickly

## Printing Tips

- The defaults are made for a 0.4 mm nozzle and 0.2 mm layers. Roads stand 0.6 mm tall and parks 0.4 mm, whole numbers of layers.
- Every colour is one filament. One AMS holds four, and the `4-Colour AMS` preset stays within that.
- Most of the model prints without supports. Bridges and the odd building with an overhanging upper part are the exceptions, so let the slicer add supports only where it finds them.
- A model bigger than your bed can be split with `Multi-plate export`. The sections fit back together with no gaps or connectors.

## Local Installation

1. Install [Node.js](https://nodejs.org) 24 or newer.
2. Clone the repository and run `npm install`.
3. Run `npm run dev` and open the address it prints.

`npm test` runs the unit tests and `npm run build` builds the site into `build/`. See [development](docs/DEVELOPMENT.md) for the command-line tools and how the code is laid out.

Pushing to `main` deploys the site with GitHub Actions. Set `Settings > Pages > Source` to `GitHub Actions` once.

## Known Issues & Limitations

- Large areas take longer and need more memory. Around 25 km² at the default scale is comfortable on a desktop browser. Phones can manage small areas.
- An area that needs more than 300 MB of map data is refused. Make it smaller or pick fewer layers.
- Map data varies by city. Buildings without a mapped height get a typical height for their type, and some places have few mapped buildings.
- Bridges are schematic: decks on evenly spaced piers, without towers, arches or trusses.
- LiDAR is only read from surveys a browser can stream (EPT and COPC). Places only covered by tiled LAZ downloads, like England, most of Germany and Spain, keep their mapped buildings.
- LiDAR downloads are big: 150 to 450 MB per km² depending on the survey. The `Chicago - The Loop (small)` preset reads about 790 MB and takes about 4 minutes the first time, the `Paris - Eiffel Tower` preset about 2.2 GB and 15 minutes. Point data is cached in the browser up to 1 GB, and measured buildings are reused for a day.
- The model is made of separate overlapping parts, one per colour. Slicers join them, but other tools may report them as intersecting.
- The Bambu Studio project is tested in Bambu Studio 2.8. It hasn't been tested in OrcaSlicer.
- Areas that cross the 180th meridian aren't supported.

###### Note: The project starts from Bambu's PLA Basic and Matte presets. Check the filament types before slicing.

See [troubleshooting](docs/TROUBLESHOOTING.md) if something goes wrong, and [how it works](docs/HOW_IT_WORKS.md) for how each layer is built.

## Credits

Map data © OpenStreetMap contributors, Overture Maps Foundation. Elevation from the AWS Terrain Tiles open dataset. LiDAR from USGS 3DEP, IGN, NRCan, swisstopo and Open LiDAR Data by Flai when that layer is on. Basemap © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors. See [data sources](docs/DATA_SOURCES.md) for the full attribution, and what to include with printed models.

Built with React, MapLibre GL, three.js, hyparquet and Clipper2. LiDAR is decoded by [laz-rs](https://github.com/tmontaigu/laz-rs) (Apache-2.0) and reprojected with proj4js. The site's `licenses.md` and `laz-decoder-notices.md` list the licenses of everything it bundles.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
