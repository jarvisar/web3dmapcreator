# Development

Notes for working on the code. See [how it works](HOW_IT_WORKS.md) for what each part of the pipeline does, and [SVG maps](SVG_MAPS.md) for the flat maps.

## Setup

1. Install [Node.js](https://nodejs.org) 24 or newer.
2. Run `npm install`.
3. Run `npm run dev` and open the address it prints.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm test` | Unit tests (vitest), no network |
| `npx tsc --noEmit` | Type check |
| `npm run build` | Type check and build the site into `build/` |
| `npm run preview` | Serve the built site |

The build goes to `build/`, not `dist/`. In this repository `dist/` held the Blender add-on's release archives.

## Layout

| Folder | Contents |
| --- | --- |
| `src/core/geo/` | Projection from WGS84 to model millimetres, area shapes, bounds parsing |
| `src/core/data/` | Overture GeoParquet reads, elevation tiles, HTTP retries and the IndexedDB cache |
| `src/core/geometry/` | Polygon booleans (Clipper2), the prism mesher, spatial indexes, mesh checks |
| `src/core/terrain/` | The shared terrain height grid |
| `src/core/lidar/` | LiDAR: survey discovery, EPT and COPC reading, building measurement, and roofs cut from the LiDAR only surface |
| `src/core/dsm/` | LiDAR only models: reading a survey into a grid, the height rules, the mesh and the model |
| `src/core/pipeline/` | Generation: water, roads, bridges, land cover, buildings, trees, meshing, plates |
| `src/core/export/` | Bambu Studio, PrusaSlicer, 3MF and STL writers |
| `src/core/edit/` | The model editor: the edits document, applying it to a generated model, road tiles, land fill and added shapes |
| `src/core/svgmap/` | SVG maps: vector tiles, piece layout, line cleanup, fills and hatching, titles and the SVG writer |
| `src/core/engine/` | Messages between the page and the worker |
| `src/worker/` | The Web Worker that downloads, generates and exports, the LiDAR workers it starts, and the SVG map worker |
| `src/app/` | The React interface: state, map, panels and 3D viewer. `src/app/viewer/` has the editor's picking, overlays and tools, and `src/app/svgmap/` the SVG map sections, preview, render client and route picker |
| `scripts/` | Command-line tools for testing |

`src/core` has no DOM or React code. It runs the same in the worker and in Node, which is how the tests and scripts use it.

The 3D model and the SVG map share the area, place search, presets, share link and saved settings, but not their engines. The SVG engine reads OpenFreeMap vector tiles and never touches the Overture pipeline.

## Scripts

```powershell
# Generate a model from the command line and write a 3MF or STL zip
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --out out/loop.3mf
npx tsx scripts/generate.ts --bbox -82.83485,27.96044,-82.79572,27.98152 --format stl-zip --out out/clearwater.zip
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --lidar --out out/loop-lidar.3mf
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --lidar-only --out out/loop-surface.3mf

# Download an area's data and print what came back
npx tsx scripts/fetch-area.ts --bbox -87.635,41.875,-87.625,41.885 --out out/area.json

# Time the pipeline on a synthetic grid city, offline
npx tsx scripts/bench-synthetic.ts 3

# Round-trip sample projects through the installed Bambu Studio
npx tsx scripts/check-bambu.ts

# An options file exported from the app, edits and all, as the app would export it
npx tsx scripts/generate.ts --options city-model-options.json --out out/options.3mf

# Random edits on a real area, checking exports are closed and match the 3D view
npx tsx scripts/fuzz-edits.ts --preset "Chicago - The Loop (small)" --steps 40 --seed 1

# Screenshot the running site, or run a full generate and download in Edge
node scripts/shot.mjs http://localhost:5173/ out/shot.png
node scripts/e2e.mjs http://localhost:5173/ out/e2e
node scripts/e2e.mjs http://localhost:5173/ out/e2e-svg --svg --all-formats
node scripts/e2e-mobile.mjs http://localhost:5173/ out/e2e-mobile
node scripts/e2e-edit.mjs http://localhost:5173/ out/e2e-edit
node scripts/e2e-edit.mjs http://localhost:5173/ out/e2e-edit-phone --phone
node scripts/e2e-edit.mjs http://localhost:5173/ out/e2e-edit-svg --svg
```

`generate.ts` takes `--shape`, `--rotation`, `--scale`, `--fit`, `--format`, `--printer`, `--multi-plate`, `--section`, `--bridges`, `--trees`, `--flat`, `--cut-water` (large water through the base), `--lidar` and `--settings file.json` (merged onto the defaults). The `out/` folder is ignored.

With `--lidar`, point data and batch results are kept in `out/lidar-cache` (or `--lidar-cache folder`), which is never evicted, so delete it to start over. Batches run in worker threads, one fewer than the cores up to four (`--lidar-threads n`, 1 to stay on the main thread). `--lidar-records file.json` writes the measured records for comparing runs.

`--lidar-only` builds a LiDAR only model instead, with its blocks checkpointed in the same folder and up to eight threads. `--detail mm` sets its cell size, `--water-layer` prints its water as a thin layer, `--cut-water` cuts it away, `--no-map-water` leaves out Overture's water outlines, and `--surface-out folder` writes the grid's layers as raw binaries with a `grid.json`, for looking at them in something else.

`check-bambu.ts` gives Bambu Studio its own data folder, so your own settings, presets and recent files are never touched.

`--options` takes an options file exported with its map area: the area, settings, colours, export options and the 3D editor's edits. Other flags override it, and `--no-edits` leaves the edits out. It's the quickest way to rebuild what someone downloaded.

`fuzz-edits.ts` makes random edits (removals, heights, road widths, layers, shapes with odd sizes and points) and every few steps exports in one plate and in sections. It checks every part is closed and finite, no building part floats, and the export has the same volume per colour as the 3D view would show, with nothing hidden and with a random few parts hidden. Shapes are also put on roofs and bridge decks the way the editor places them, and no part of a shape may hang in the air or stand on water alone. `--lidar-water cut` or `layer` goes with `--lidar-only`. A failing step is saved as an options file for `generate.ts --options`. `--selftest` exports the step before's edits, which the checks have to catch. It takes `--trees`, `--bridges`, `--shape`, `--rotation` and `--lidar-only` like `generate.ts`.

`e2e-edit.mjs` goes through the editor like a person would, then opens every export format to check the custom layer is in it. `--phone` does it at phone size with taps, and `--svg` picks roads for an SVG route. On desktop it also tries `Undo all` and putting the edits back, a share link opened over other edits in the same tab and in a new one, an idle tab closing, and hiding every part but a custom layer. The SVG run tries `Undo all picks` and checks `Reset all settings` keeps the picks.

## Tests

`npm test` covers the projection, the classifiers, linear referencing, water, roads, bridges, land cover, buildings and roofs (checked against the add-on's rules), the mesher, the exporters and the data layer against small parquet fixtures. The pipeline tests build models and check that every part is made of closed, consistently wound shells.

The LiDAR tests run offline. The rectangle, centroid and rotation tests compare against Shapely output saved in `src/core/lidar/testdata/`. Some measurement tests use point clouds from an exact copy of numpy's random generator (`src/core/lidar/test-helpers.ts`), as the add-on's did. The readers are tested against small synthetic EPT and COPC files with a pass-through decoder, and discovery against canned catalog answers.

The SVG map tests render a saved OpenFreeMap tile of Canada Place in Vancouver (`src/core/svgmap/fixtures`) in every output mode, and cover the cleanup, layout, titles and tile stitching.

The live data tests are skipped by default. Run them with:

```powershell
$env:NETWORK = '1'; npx vitest run src/core/data
$env:NETWORK = '1'; $env:SVG_OUT = 'out/svg'; npx vitest run src/core/svgmap/e2e.test.ts
```

The second renders the Chicago Loop from live tiles for a laser, a plotter and print, and writes the SVGs to `SVG_OUT` when it's set.

The parquet fixtures in `src/core/data/testdata/` are made by `make_fixtures.py`, which needs pyarrow.

When changing geometry, check closure and winding on real areas as well as the tests. `generate.ts` prints open and repeated edges for every part. Chicago, Clearwater and Rome cover rivers, the sea, beaches, fountains and dense old buildings.

## Deployment

`.github/workflows/deploy.yml` tests, builds and publishes the site to GitHub Pages on every push to `main`. In the repository settings, set `Pages > Build and deployment > Source` to `GitHub Actions` once. Asset paths are relative, so the site works from any subpath.

The build includes a service worker (`vite-plugin-pwa`, set up in `vite.config.ts`). It precaches the app, the engine workers and the title fonts, and caches OpenFreeMap tiles as they're used. The LiDAR worker and decoder load on first use instead. A new deploy waits for the reload notice. There's no service worker under `npm run dev`, so check offline behaviour with `npm run build` and `npm run preview`.

## Data services

Everything is fetched from the browser, so every service must send CORS headers:

- `stac.overturemaps.org` for the release list and file index
- `overturemaps-us-west-2.s3.us-west-2.amazonaws.com` for the GeoParquet files, with range requests
- `s3.amazonaws.com/elevation-tiles-prod` for Terrarium elevation tiles
- `tiles.openfreemap.org` for the basemap and SVG maps, and `photon.komoot.io` for place search

With LiDAR on:

- `raw.githubusercontent.com` for the USGS catalog and the Open LiDAR Data inventory
- `s3-us-west-2.amazonaws.com/usgs-lidar-public` for USGS EPT
- `data.geopf.fr` for IGN's tile index and COPC files
- `maps-cartes.services.geo.ca` for NRCan's tile index and `canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com` for its COPC files
- `data.geo.admin.ch` for swisstopo's STAC and COPC files
- `open-lidar-data.s3.eu-central-1.amazonaws.com` for Open LiDAR Data

Surveys that only come as whole files are offered in the app and only downloaded once the user approves them. Hosts without CORS headers, like `rockyweb.usgs.gov` (USGS's staged LAZ) and `geodaten.bayern.de`, still can't be read at all. If one is worth adding later, a CORS proxy that forwards `Range` and exposes `Content-Range` would be the way in.

The Azure copy of Overture's data doesn't send CORS headers, so the S3 copy is used.
