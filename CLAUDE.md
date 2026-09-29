# Jarvizar City Model (web): shared agent context

Read [AGENTS.md](AGENTS.md) for development principles. Implementation,
configuration and tests are authoritative. Keep transient results out of here.

## What it is

A browser-only app (Vite + React + TypeScript, deployed to GitHub Pages) that
turns a map area into a multicolour FDM city model: terrain, water, land
surfaces, roads/rail, optional schematic bridges and trees, and buildings with
roofs from Overture Maps. It is a port of the Jarvizar City Model Blender
add-on (separate repo `3dmapcreator`, not a dependency). Its LiDAR pipeline is
ported for streamed surveys only (EPT and COPC). Staged LAZ downloads were left
out. `settings.modelSource = 'lidar'` (LiDAR only) builds the whole model from
a survey alone instead, as one solid in the terrain colour (`src/core/dsm/`).
There is no server: data is read from public, CORS-enabled sources.

The same app makes flat SVG maps for laser engraving, pen plotters and print
(`output: 'svg'`), from OpenFreeMap vector tiles. That engine came from the
SVGmap app (separate repo `SVGmap`, not a dependency) and lives in
`src/core/svgmap/`. The two outputs share the area, search, presets, share
link and saved state, not their engines.

One model unit is one printed millimetre. Default scale 0.07 mm per metre
(1:14,286). Defaults live in `src/core/settings.ts` and follow the add-on.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/geo/` | `Projection` (WGS84 to local ENU, rotated to the area, scaled to mm), area shapes, bounds parsing |
| `src/core/data/` | Overture GeoParquet reads from S3 (STAC index, row-group pruning, two-pass page reads, hyparquet), Terrarium DEM tiles, IndexedDB byte cache, HTTP retries/limiter |
| `src/core/geometry/` | Clipper2 wrappers (`polygon.ts`), prism mesher (`mesher.ts`, Delaunator + Constrainautor CDT with earcut fallback), edge/raster indexes, mesh validation |
| `src/core/terrain/` | `HeightField`: the one grid every layer samples |
| `src/core/dsm/` | LiDAR only models: `prepare.ts` reads a survey into a grid (`raster.ts`, `grid.ts`), `compose.ts`/`filters.ts` the height rules, `mesh.ts` RTIN and edge collapse, `model.ts` the `ModelSpec` |
| `src/core/lidar/` | LiDAR: `sources/` discovery (USGS EPT, IGN, NRCan, swisstopo, Flai COPC), `read/` EPT/COPC/LAS reading with an injected LAZ decoder and projector, measurement (`measure.ts`, `envelope.ts`, ground, planes, terraces, selection), roof surfaces (`regularize.ts`, `delatin.ts`, `coarsen.ts`, `rim.ts`), `prepare.ts` batching and checkpoints |
| `src/core/pipeline/` | Generation stages: water, roads (+linework, airports, bridges, `network/` tidy), land, buildings (+`buildings/` selection, heights, roofs, printability), trees, orchestration (`generate.ts`), meshing, plates, row filter |
| `src/core/export/` | Bambu Studio project, PrusaSlicer project, generic 3MF, STL, zip streaming, section grid |
| `src/core/engine/` | Worker protocol and main-thread client |
| `src/worker/engine.worker.ts` | Downloads, generates, meshes and exports off the main thread |
| `src/worker/svg.worker.ts` | Renders SVG maps, separate so a preview updates while a model generates |
| `src/core/svgmap/` | SVG maps: tile fetch/decode/stitch, piece layout (`layout/`), line cleanup (`lines/`), fills and hatching, titles (`text/`), SVG writer, `service.ts` (the render with its caches) |
| `src/app/` | React UI: state (zustand), MapLibre area editor, panels, three.js viewer. `src/app/svgmap/` has the SVG sections, preview, render client, piece fitting and share encoding |
| `scripts/` | `generate.ts` (CLI end to end), `fetch-area.ts`, `bench-synthetic.ts`, `check-bambu.ts`, `shot.mjs`, `e2e.mjs` and `e2e-mobile.mjs` (browser runs in the installed Edge) |

## Pipeline rules worth preserving

- Everything samples one `HeightField`. Never sample the DEM directly in a layer.
- Between nodes the terrain is the grid split along each cell's low-to-high
  diagonal (`geometry/lattice.ts`), `heightAt` included, and draped solids
  (terrain, land, roads, grounded buildings) are cut from those triangles
  (`latticeCap`). Separately triangulated caps parted from the ground by more
  than the embed on steep ground with big cells: 0.4 mm at 3 mm cells.
  `latticeTin` only builds the cells a polygon touches (its bounding box was
  1.8 GB for a thin diagonal beach), and beach tapers split cells no finer
  than `BEACH_CELLS` allows. A footprint is only left undraped when it lies
  in one triangle (`inOneTriangle`), not when it's smaller than a cell.
- Almost everything is a `PrismSolid` (polygon + top/bottom height + drape).
  Crop and multi-plate sections are 2D clips before meshing, so every shell
  stays closed. Trees are `MeshSolid`s, kept only where the whole crown is
  inside the crop, and left out of both sections when a crown crosses a seam.
- The mesher only accepts caps whose edges close exactly (`capIsClosed`).
  Pinched polygons (rings touching at a vertex, or a hole corner on another
  ring's edge) are shrunk by 1e-4 mm and retried (`PINCH_MM`). Never weld by
  coordinate. A cap cut to a print section gets the same retry, for a
  section line through a concave corner of its outline.
- Water: cut (>= 5,000 m2 of the whole feature, full-depth fill), basins
  (ponds/fountains by tags, recessed 1 mm), sheets (small, 0.18 mm above
  flattened ground). Basins and sheets are trimmed to what lies outside cut
  water. Cut water level is the interior median raised to the low tenth of
  its shoreline (grid nodes inside the crop only). Cut bodies that overlap
  merge into one at their area-weighted median level. The grid is
  flattened under it and the shore raised, and the fill sits 0.25 mm below
  the bank.
- Ground is kept under roads, buildings and mapped piers over cut water
  (`settings.supports`) by leaving it out of the cut, not with extra solids.
- Land categories never overlap (priority order). Water, roads and building
  footprints are cut out of slabs, and slivers under ~0.2 mm are opened away.
  Above 250 mm this runs in 50 mm tiles with a 1 mm margin (`tiled`), so
  each boolean only sees what's near it and seams match a single pass.
- Don't bring back Clipper2's `rectClip`. It drops a corner when a ring
  leaves the rectangle through one side and comes back through the next (up
  to 2 mm2 on random road networks). `clipToRect` (`geometry/clipRect.ts`,
  shared with SVG maps) is Sutherland-Hodgman, and needs a NonZero boolean
  after it.
- Boolean output is sorted into outers and holes by orientation, not tree
  depth. Where edges of two inputs nearly coincide, the engine can return a
  hole at the top level, and `placeStrays` puts it back into its owner.
- Road widths clamp to 0.45-0.7 mm and groups are unioned. Roads beat rail beat
  paths. Split segments at every `between` boundary before reading rules.
  Tunnels and indoor corridors are skipped.
- Buildings follow the add-on's selection/height/roof rules. See comments in
  `src/core/pipeline/buildings/`.
- The row filter (`pipeline/filter.ts`) decides from small columns which rows
  need geometry. Keep it in step with the classifiers.

Road network tidy (`pipeline/network/`, `roads.tidy`, run in `collectRoadPieces`
before bridges are split off):

- A rewrite of the add-on's `road_network.py`, not a port. The cull keeps its
  rules (ranks, 28 degrees, streets dropped at 68% doubled, welding through a
  junction only when the continuation is unambiguous from both sides, or a
  divided street's kept carriageway hops sides). Pruning is the web app's own:
  a graph of the lines as printed, a node wherever an end lands in another
  ribbon or two centerlines cross, spurs judged from the loose end to the
  first junction. That one rule replaced the add-on's terminal bends, loop
  anchoring and "leaned on" checks.
- `alongside` ignores a kept line past its ends, or the stem of a divided
  street through an intersection reads as doubled by the carriageway it
  continues.
- End origins decide what may move. `met` ends (their partner was left out or
  culled) join within twice the gap and go as stubs. `dead` ends only join
  when the ground left wouldn't print and only go as nubs. `portal` ends
  (tunnels, indoor corridors) never join far but can go as stubs. Skipped
  sidewalks and crossings go in `leftOut`, or every path that met one reads
  as a dead end.
- A part lying wholly inside a ribbon at least as important is dropped. Such
  scraps passed every other rule and printed as slivers.
- Decks and ground never double each other, deck ends never move, and decks
  only meet the ground where their lines meet.
- The kept carriageway of a divided street moves halfway to its dropped twin
  (`center.ts`), or the road jogs by half the median wherever the
  carriageways split. Twins match on class and subclass (a parking aisle
  isn't a service road's twin, a ramp isn't the motorway's). The shift is
  sideways only, worked along chains of the street's pieces, changes no
  faster than 1:3 and is held at zero where three or more ends meet. It never
  carries a line into the corridor of one it wasn't doubling: upper and lower
  Wacker each moved towards twins between them and met.
- `fillGaps` fills ground narrower than the gap between two lines alongside
  each other with strips from centerline to centerline, in the same union as
  the roads (`gaps.ts`). A closing of the whole footprint was tried: round
  joins filleted every block corner, mitred ones left zero-area slivers, and
  it cost seconds on large areas.
- Road polygons of one group touching at a single vertex are pulled apart
  by 0.2 µm (`separateTouching`), or their prisms share a wall edge.
- Every step has its own switch and the tidy off gives the untidied network.
  Check changes on the regression areas with before/after renders: specks,
  loose ends that met something and doubled length should drop, and no
  street should lose a stretch from its middle.

LiDAR (`src/core/lidar/`, generation in `pipeline/lidar.ts` and `buildings.ts`):

- Measurement is a port of the add-on's `lidar_*.py` (algorithm 29) up to the
  faired roof raster. Tests use a numpy PCG64 copy, and `geos.ts`, `centroid`
  and `rotate` follow GEOS 3.13 and Shapely to the bit (the grid follows the
  minimum rotated rectangle, whose opposite sides tie). Don't swap any of
  these for generic versions, or the raster drifts from the add-on's.
- Buffers are Clipper's, not GEOS's, so the 25 m ground ring differs at its
  arcs and the ground can move by up to ~0.7 mm.
- The roof surface on the raster is the web app's own. `regularize.ts` grows
  planes, then labels each cell with a plane or leaves it as measured,
  trading how far cells move against boundary length. Anything under about
  0.3 mm across and a 0.2 mm layer tall, printed, goes, and pits narrower
  than 0.3 mm go at any depth. `delatin.ts` and `coarsen.ts` triangulate
  within one cell up and down on flat roofs and half a cell across walls.
  Don't bring back an edge collapse priced against the current faces: it let
  vertices slide down walls until penthouses were pyramids. Spire cells skip
  all of it, keep their upper returns and get a quarter of the error.
- Records are measured in a metric frame at scale 1 and published in lon/lat.
  Generation projects them like any other feature.
- A roof envelope is a `CapSolid` (TIN top, flat underside, boundary walls).
  Section cuts clip the TIN with `clipTin` (CDT arrangement), so caps stay
  closed. `capBoundary` rejects pinched TINs rather than welding them. The
  underside is triangulated from the outline (`undersideTriangles`), with
  outline vertices earcut skips put back, and checked with `capIsClosed`.
- `clipTin` caps Constrainautor's work (`Bounded`) and retries a stuck cut
  with the region moved in slightly. Without the cap, a grazing outline can
  loop forever. It returns an empty TIN when the region misses the surface
  and null only when the triangulation failed, so a section that only the
  cap's box reaches isn't counted as a failure.
- `thinRim` (not in the add-on) removes rim vertices on straight walls after
  the envelope is clipped. It cut roof triangles about four times.
- `src/core` has no LAZ or proj dependency. `src/worker/lidarCodecs.ts`
  installs laz-rs (`@voxelkloud/wasm-codecs`) and proj4 with `setLazDecoder`
  and `setProjector`, for the workers and scripts. Tests use a pass-through
  decoder.
- Batches are plain `BatchJob`s run by a `BatchRunner`: a pool of
  `lidar.worker.ts` workers in the browser, worker threads in the CLI, or in
  the calling thread. Checkpoints and survey choice stay in `prepare.ts`, and
  each building is in one batch per round, so finishing order doesn't matter.
  Workers send downloads to the pool (`lidarProtocol.ts`, `Fetcher.serve`),
  which fetches each file once. Separate caches per worker downloaded
  Chicago's LiDAR about three times over.
- Readers only use range reads that come back whole (exact header, VLR, page
  and node ranges). A server ignoring `Range` is an error.
- Prepared results and batch checkpoints are keyed by the source properties
  the measurement reads, listed in `measuredProps` (`source.ts`). A property
  read anywhere new goes on that list. Catalog answers are only cached when
  they parse, so a maintenance page served with a 200 isn't kept.
- With `preferLidar` off, mapped assemblies with more levels or a shaped roof
  the measurement lacks are kept (`preferSourceDetail`).

LiDAR only (`src/core/dsm/`, design notes in `docs/LIDAR_MODEL.md`):

- The grid is the area's own rectangle in its rotated frame, a cell centred
  on each vertex. Nothing is resampled between reading and meshing. A square
  area turned 90 degrees reads identical cells, which is a good check after
  touching projection or rasterizing.
- `compose.ts` is a port of the add-on's `dsm_model.compose` and matches it on
  its prepared Chicago, Philadelphia and Boston grids (float32 flips 1 to 3
  cells per grid on exact thresholds). Keep the rules and their order. The
  deliberate differences: removed trees are ordinary cells again, `inside`
  limits the base to the area shape, water grows into partly wet cells at
  its level and takes in specks (`GROW_M`, `takeSpecks`, for San Francisco's
  2023 survey), and cut water takes its bank's height for `BANK_RINGS` rings,
  then the TIN is clipped along it (the add-on drops cut cells to the bottom
  before meshing).
- The density probe (`occupiedCell`) counts land as 2 m squares with a
  return that isn't water. The add-on counts any return, which grew the
  Chicago lakefront's cells to 2.08 m. Probe results are saved under
  `PROBE_VERSION`.
- Blocks are counted into cells as they're read (`BlockRaster`), never held as
  points, and checkpointed in the LiDAR cache under `VERSION`. Raise it when
  what a block stores changes. A block with a failed read isn't saved.
- Surveys: whole-area coverage first, then `rankOrder`. A cell belongs to the
  first survey whose outline holds it, returns or not.
- The mesher prices collapses by memoryless quadrics against the current
  faces (the add-on's, so stair walls straighten), and also checks every
  collapse against the grid (`GridBound`): no grid point further than one
  cell from the surface (two beside a wall), square to it. Don't drop that check. Without it
  vertices drift until penthouses are pyramids, the reason roof caps moved to
  Delatin. Tiles are simplified in workers with edge points pinned, then the
  seams get their own pass.
- Walls come out ribbed without two extra steps: `fairFaces` straightens
  facade relief under 0.3 mm printed before meshing (in `model.ts`, not
  `compose`, which keeps its parity), and `straightenWalls` puts each wall's
  foot on a line parallel to its straightened roof edge after meshing. A tall
  triangle on a crooked stretch of foot faces its own way, and a row of them
  is the ribs. The cut water outline is simplified at 1.5 cells for the same
  reason.
- The model is one `CapSolid`, cut to shapes, sections and cut water by
  `clipTin`. `clipBand` only triangulates the triangles near the outline, and
  a triangle counts as near when an outline edge crosses its box, so both
  triangles on any edge the outline touches are near. Keep it that way or
  the two parts won't meet.
- `Cut away water` is the add-on's `cut_water` (`cutWater`): survey water
  of at least `water.cutMinAreaM2` (shared with map models), water within
  40 m counting as one body across bridges, opened to 0.4 mm printed, none
  more than 3 m above the ground (roof pools), and land it leaves alone
  under 4 mm² printed goes too. The one change is that specks under
  `SPECK_M2` are also filled before the opening. Overture water was
  compared and rejected, see `docs/LIDAR_MODEL.md`.

SVG maps (`src/core/svgmap/`, UI in `src/app/svgmap/`, notes in `docs/SVG_MAPS.md`):

- The engine is SVGmap's, moved with its tests. At the merge, live renders of
  the Chicago Loop were byte-identical to SVGmap's for laser, plotter and
  print. Hexagons were added (`layout/shapes.ts`, `availableWidthAt` in
  `text/label.ts`, the plotter band in `compose.ts`).
- In SVG mode the area is the piece's map window: `fitAreaToPiece` gives it
  the window's proportions and corner radius and sets `svg.scale` (1:n) from
  its width, or its width from the scale when `scaleLocked`. Every area or
  piece change goes through it in the store. The shape is shared with 3D.
- Area sizes are rounded to the centimetre (`lib/area.ts`), not the metre,
  so a typed 1:5,000 on a small piece stays 1:5,000.
- The box on the map uses the ENU `Projection`, the engine Web Mercator at
  the centre. The piece overlay on the map is one affine transform from
  where the area's axes land (`AreaEditor.layout`).
- The live preview re-renders whenever the settings key differs from both
  the result's and the last tried key (`svgmap/render.ts`), so a failed or
  cancelled render isn't retried until something changes. The action bar
  offers the retry instead.
- Every number in the SVG settings has its range in `core/svgmap/limits.ts`.
  The panels offer it, share links, saved and imported settings are held to
  it, and the engine clamps again: a hand-edited dense window hung the line
  cleanup. Ranges have to hold what the app works out itself too (line
  spacing from a 3 mm pen, a hexagon's height, the scale of a tiny or huge
  piece), which `settings.test.ts` checks.
- The SVG worker acknowledges each message by sequence number. One busy
  with a render that doesn't answer a newer render or a cancel within 8 s is
  stuck in a loop and is replaced (`svgmap/render.ts`). Only an ack for the
  message the watchdog waits on, or a later one, clears it.
- Plotter files put every layer of one pen together, so `compose` sorts the
  drafts by pen before ordering paths and adding up travel.
- Tiles and the window box are cut with `clipToRect`, not the `rectClip`
  SVGmap used, so renders are no longer byte-identical to SVGmap's. A
  polygon crossing a tile edge is unioned in `decode.ts` right after its
  clip. The clip's edges back and forth along the tile edge cancel at tile
  resolution but not once a rotated map rounds them, and they left hairline
  cracks along the seams.
- Share links: `#a=...&o=svg`, and a copied link adds `s=` (settings that
  differ from the defaults, base64url JSON). An area without `o=` opens as
  a model, whatever mode the recipient was in. Old SVGmap links (`#s=` with
  the area inside) still open. The `s=` part is dropped from the address
  bar once read.

## Verification

```powershell
npm test                     # vitest, offline
npx tsc --noEmit
$env:NETWORK=1; npx vitest run src/core/data   # live data tests
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --out out/loop.3mf
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --lidar   # point cache in out/lidar-cache
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --lidar-only --out out/loop-surface.3mf   # --cut-water to cut the river
npx tsx scripts/check-bambu.ts   # round trip through installed Bambu Studio (isolated data dir)
$env:NETWORK=1; npx vitest run src/core/svgmap/e2e.test.ts   # SVG maps from live tiles ($env:SVG_OUT to keep them)
node scripts/e2e.mjs http://localhost:4173/ out/e2e-svg --svg --all-formats   # SVG map in Edge
npm run build                # site into build/ (not dist/, which holds old add-on archives)
```

For geometry work check closure and winding (`edgeReport`, `signedVolume`)
on real presets (Chicago Loop, Clearwater, Rome, San Francisco), and look at
renders. `scripts/shot.mjs` screenshots the dev server with the installed Edge.
Regression areas are fixtures, never reasons for location-specific code.
LiDAR only output can be compared against the Micropolitan reference STLs in
`examples_and_inspiration/` (git-ignored).

Machine-local folders carried over from the add-on (`scratchpad/`, `dist/`,
`.venv-overture/`) are ignored and unrelated to the web app.

# Writing style

This applies to code comments and anything public like READMEs, docs, and PR descriptions. Write like the developer who built the project leaving useful context for somebody else. Do not write like a technical writer, tutorial author, or AI documenting everything it found in the codebase.

My older READMEs are the main reference for tone: pre-2024 versions in `jarvisar/solar-system`, `sorting-algos`, `interpreter`, `exoplanet-classifier`, and `senior-design`. Don't use newer repos as a style reference since some of those were AI generated.

## General

- Plain, direct, and practical. Use normal words.
- Don't try to sound polished. Slightly casual or imperfect wording is fine if it sounds natural.
- Keep sentences fairly short, but don't force every sentence into the same length or pattern.
- Write what is actually useful to know. Do not document something just because you found it in the code.
- Prefer a few important details over exhaustive coverage.
- Don't systematically explain every subsystem, edge case, fallback, constant, or implementation decision unless the document actually needs it.
- Avoid giving every section the same amount of detail. Some things may need a paragraph, some need one sentence, and some do not need mentioning at all.
- Don't turn code inspection into an encyclopedia of how the project works.
- Assume the reader is a developer. Obvious implementation details usually don't need explanation.
- Focus on things I would realistically remember being worth mentioning: weird behavior, important constraints, decisions that are easy to misunderstand, useful examples, and limitations.
- Concrete numbers and implementation details are good when they matter, but don't dump constants into documentation just because they exist.
- Explain why something works a certain way only when the reason is useful or non-obvious. Not every behavior needs a justification.
- It's fine to say things like "currently", "for now", "I ended up doing this because...", "this is a little weird", "we don't want...", or "this should still..." when natural.
- First person is fine when talking about a decision I made. Don't artificially rewrite everything into detached authoritative prose.
- If something is uncertain, unfinished, hacky, or likely to change, say that normally instead of making it sound finalized.
- Keep structure proportional to the amount of information. Don't invent categories, terminology, or sections just to make the documentation look complete.
- Don't add an intro or conclusion unless there is actually something useful to say.
- Don't repeat a point in prose after already showing it in a command, example, heading, or list.
- No em dashes, semicolons, emojis, arrows, bold scattered through sentences, or overly decorative formatting.
- Avoid AI writing patterns like "it's not just X, it's Y", rhetorical contrasts, fake enthusiasm, title-restating intros, "Overall..." conclusions, repeated summaries, or filler words like powerful, seamless, robust, comprehensive, sophisticated, and elegant.
- Avoid repetitive explanatory constructions like "This ensures...", "This allows...", "This means...", or "This prevents..." paragraph after paragraph.
- Don't make every statement sound absolute. Human-written project docs are often scoped to how the project works right now.
- When in doubt, write less.

## READMEs

- Open with one or two normal sentences saying what the project is. For example: "This is a simple proxy server that adds the necessary headers to allow Cross-Origin Resource Sharing (CORS) for a specified website." or "My first real Three.js project."
- Link the live build if there is one: "Visit the [GitHub Pages site](...) to access the latest deployment."
- Don't explain the entire architecture unless the project actually needs an architecture section.
- Prefer documenting what somebody needs to run, use, understand, or modify the project.
- Controls and usage should be short and direct: "Use W/S to increase or decrease throttle. Use A/D to roll. Press the escape key at any time to exit flight mode."
- State limits plainly: "Currently the maximum amount is 512." or "Note that large searches can take up to 15 seconds to process."
- Small side notes can go on an h6 line: "###### Note: Assembly generator currently only supports integers"
- Common sections are Usage or How to Use, Features, Local Installation, Known Issues & Limitations, Screenshots, and Credits, but only add them when they are useful.
- Don't force every README into the same template.
- Title Case headings. `&` is fine in titles.
- Backticks for buttons, keys, files, branches, and commands.
- Keep it short. Most of my older READMEs were around 250 to 550 words. Bigger projects can be around 1,200 to 1,500, but don't aim for a word count if there isn't that much worth saying.
- If a technical detail is easy to find by reading one function, it probably doesn't belong in the README.
- A README can leave implementation details out. It does not need to prove that every part of the project was considered.

## Technical docs

- Technical docs can be more detailed than the README, but still shouldn't read like generated reference documentation.
- Start from the reason the document exists, not from a desire to describe the whole system.
- Don't automatically create one section per subsystem.
- Don't walk through the entire pipeline in order unless understanding that sequence is the point of the document.
- Mention source files where they are genuinely useful for finding the implementation, not after every paragraph.
- Avoid exhaustive lists of thresholds, fallback rules, caches, data sources, and special cases unless those details are the subject of the document.
- Examples and odd cases are often more useful than a complete formal description.
- It's fine for a technical document to say "The rest is handled in `foo.ts`" rather than explaining every step.
- Leave out details that are likely to become stale unless they are important enough to maintain.
- Don't make the implementation sound more deliberate or formally designed than it really was.

## Code comments

- Keep comments sparse.
- Only comment non-obvious logic, reasons behind a decision, edge cases, limitations, unusual behavior, or something another developer might be tempted to "fix".
- Don't narrate straightforward code or restate the function name.
- Don't add doc blocks just because a function is public.
- Don't explain every branch of complicated code. Comment the weird part or the reason the code has to be complicated.
- Fragments are fine.
- Comments can sound like quick developer notes rather than miniature documentation paragraphs.
- Good: `# Use WSL to run the commands if on Windows`
- Good: `# If the input contains an equal sign, skip code generation`
- Good: `// Keep this separate from the road union or tiny paths disappear`
- Bad: `// This ensures that the road geometry is correctly processed before proceeding to the next stage.`

# Attribution

Never list Claude or any other AI tool as an author or co-author. Do not add `Co-Authored-By` trailers, "Generated with" lines, session links, or AI names to commits, pull requests, author fields, maintainer fields, or copyright notices.

The user (`jarvisar`) is the sole author and should appear as the sole contributor on the GitHub repository.