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
out. There is no server: data is read from public, CORS-enabled sources.

One model unit is one printed millimetre. Default scale 0.07 mm per metre
(1:14,286). Defaults live in `src/core/settings.ts` and follow the add-on.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/geo/` | `Projection` (WGS84 to local ENU, rotated to the area, scaled to mm), area shapes, bounds parsing |
| `src/core/data/` | Overture GeoParquet reads from S3 (STAC index, row-group pruning, two-pass page reads, hyparquet), Terrarium DEM tiles, IndexedDB byte cache, HTTP retries/limiter |
| `src/core/geometry/` | Clipper2 wrappers (`polygon.ts`), prism mesher (`mesher.ts`, Delaunator + Constrainautor CDT with earcut fallback), edge/raster indexes, mesh validation |
| `src/core/terrain/` | `HeightField`: the one grid every layer samples |
| `src/core/lidar/` | LiDAR: `sources/` discovery (USGS EPT, IGN, NRCan, swisstopo, Flai COPC), `read/` EPT/COPC/LAS reading with an injected LAZ decoder and projector, measurement (`measure.ts`, `envelope.ts`, ground, planes, terraces, selection), roof surfaces (`regularize.ts`, `delatin.ts`, `coarsen.ts`, `rim.ts`), `prepare.ts` batching and checkpoints |
| `src/core/pipeline/` | Generation stages: water, roads (+linework, airports, bridges), land, buildings (+`buildings/` selection, heights, roofs, printability), trees, orchestration (`generate.ts`), meshing, plates, row filter |
| `src/core/export/` | Bambu Studio project, PrusaSlicer project, generic 3MF, STL, zip streaming, section grid |
| `src/core/engine/` | Worker protocol and main-thread client |
| `src/worker/engine.worker.ts` | Downloads, generates, meshes and exports off the main thread |
| `src/app/` | React UI: state (zustand), MapLibre area editor, panels, three.js viewer |
| `scripts/` | `generate.ts` (CLI end to end), `fetch-area.ts`, `bench-synthetic.ts`, `check-bambu.ts`, `shot.mjs`, `e2e.mjs` and `e2e-mobile.mjs` (browser runs in the installed Edge) |

## Pipeline rules worth preserving

- Everything samples one `HeightField`. Never sample the DEM directly in a layer.
- Almost everything is a `PrismSolid` (polygon + top/bottom height + drape).
  Crop and multi-plate sections are 2D clips before meshing, so every shell
  stays closed. Trees are `MeshSolid`s, kept only where the whole crown is
  inside the crop, and left out of both sections when a crown crosses a seam.
- The mesher only accepts caps whose edges close exactly (`capIsClosed`).
  Pinched polygons (rings touching at a vertex, or a hole corner on another
  ring's edge) are shrunk by 1e-4 mm and retried. Never weld by coordinate.
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
  to 2 mm2 on random road networks). `clipToRect` is Sutherland-Hodgman.
- Boolean output is sorted into outers and holes by orientation, not tree
  depth. Where edges of two inputs nearly coincide, the engine can return a
  hole at the top level, and `placeStrays` puts it back into its owner.
- Road widths clamp to 0.45-0.7 mm and groups are unioned. Roads beat rail beat
  paths. Split segments at every `between` boundary before reading rules.
- Buildings follow the add-on's selection/height/roof rules. See comments in
  `src/core/pipeline/buildings/`.
- The row filter (`pipeline/filter.ts`) decides from small columns which rows
  need geometry. Keep it in step with the classifiers.

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
  loop forever.
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
- With `preferLidar` off, mapped assemblies with more levels or a shaped roof
  the measurement lacks are kept (`preferSourceDetail`).

## Verification

```powershell
npm test                     # vitest, offline
npx tsc --noEmit
$env:NETWORK=1; npx vitest run src/core/data   # live data tests
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --out out/loop.3mf
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --lidar   # point cache in out/lidar-cache
npx tsx scripts/check-bambu.ts   # round trip through installed Bambu Studio (isolated data dir)
npm run build                # site into build/ (not dist/, which holds old add-on archives)
```

For geometry work check closure and winding (`edgeReport`, `signedVolume`)
on real presets (Chicago Loop, Clearwater, Rome, San Francisco), and look at
renders. `scripts/shot.mjs` screenshots the dev server with the installed Edge.
Regression areas are fixtures, never reasons for location-specific code.

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