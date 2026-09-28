# Development

Notes for working on the code. See [how it works](HOW_IT_WORKS.md) for what each part of the pipeline does.

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
| `src/core/pipeline/` | Generation: water, roads, bridges, land cover, buildings, trees, meshing, plates |
| `src/core/export/` | Bambu Studio, PrusaSlicer, 3MF and STL writers |
| `src/core/engine/` | Messages between the page and the worker |
| `src/worker/` | The Web Worker that downloads, generates and exports |
| `src/app/` | The React interface: state, map, panels and 3D viewer |
| `scripts/` | Command-line tools for testing |

`src/core` has no DOM or React code. It runs the same in the worker and in Node, which is how the tests and scripts use it.

## Scripts

```powershell
# Generate a model from the command line and write a 3MF or STL zip
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --out out/loop.3mf
npx tsx scripts/generate.ts --bbox -82.83485,27.96044,-82.79572,27.98152 --format stl-zip --out out/clearwater.zip

# Download an area's data and print what came back
npx tsx scripts/fetch-area.ts --bbox -87.635,41.875,-87.625,41.885 --out out/area.json

# Time the pipeline on a synthetic grid city, offline
npx tsx scripts/bench-synthetic.ts 3

# Round-trip sample projects through the installed Bambu Studio
npx tsx scripts/check-bambu.ts

# Screenshot the running site, or run a full generate and download in Edge
node scripts/shot.mjs http://localhost:5173/ out/shot.png
node scripts/e2e.mjs http://localhost:5173/ out/e2e
```

`generate.ts` takes `--shape`, `--rotation`, `--scale`, `--fit`, `--format`, `--printer`, `--multi-plate`, `--section`, `--bridges`, `--trees`, `--flat` and `--settings file.json` (merged onto the defaults). The `out/` folder is ignored.

`check-bambu.ts` gives Bambu Studio its own data folder, so your own settings, presets and recent files are never touched.

## Tests

`npm test` covers the projection, the classifiers, linear referencing, water, roads, bridges, land cover, buildings and roofs (checked against the add-on's rules), the mesher, the exporters and the data layer against small parquet fixtures. The pipeline tests build models and check that every part is made of closed, consistently wound shells.

The live data tests are skipped by default. Run them with:

```powershell
$env:NETWORK = '1'; npx vitest run src/core/data
```

The parquet fixtures in `src/core/data/testdata/` are made by `make_fixtures.py`, which needs pyarrow.

When changing geometry, check closure and winding on real areas as well as the tests. `generate.ts` prints open and repeated edges for every part. Chicago, Clearwater and Rome cover rivers, the sea, beaches, fountains and dense old buildings.

## Deployment

`.github/workflows/deploy.yml` tests, builds and publishes the site to GitHub Pages on every push to `main`. In the repository settings, set `Pages > Build and deployment > Source` to `GitHub Actions` once. Asset paths are relative, so the site works from any subpath.

## Data services

Everything is fetched from the browser, so every service must send CORS headers:

- `stac.overturemaps.org` for the release list and file index
- `overturemaps-us-west-2.s3.us-west-2.amazonaws.com` for the GeoParquet files, with range requests
- `s3.amazonaws.com/elevation-tiles-prod` for Terrarium elevation tiles
- `tiles.openfreemap.org` for the basemap, and `photon.komoot.io` for place search

The Azure copy of Overture's data doesn't send CORS headers, so the S3 copy is used.
