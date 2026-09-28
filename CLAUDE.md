# Jarvizar City Model (web): shared agent context

Read [AGENTS.md](AGENTS.md) for development principles. Implementation,
configuration and tests are authoritative. Keep transient results out of here.

## What it is

A browser-only app (Vite + React + TypeScript, deployed to GitHub Pages) that
turns a map area into a multicolour FDM city model: terrain, water, land
surfaces, roads/rail, optional schematic bridges and trees, and buildings with
roofs from Overture Maps. It is a port of the Jarvizar City Model Blender
add-on (separate repo `3dmapcreator`, not a dependency). LiDAR was deliberately
left out. There is no server: data is read from public, CORS-enabled sources.

One model unit is one printed millimetre. Default scale 0.07 mm per metre
(1:14,286). Defaults live in `src/core/settings.ts` and follow the add-on.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/geo/` | `Projection` (WGS84 to local ENU, rotated to the area, scaled to mm), area shapes, bounds parsing |
| `src/core/data/` | Overture GeoParquet reads from S3 (STAC index, row-group pruning, two-pass page reads, hyparquet), Terrarium DEM tiles, IndexedDB byte cache, HTTP retries/limiter |
| `src/core/geometry/` | Clipper2 wrappers (`polygon.ts`), prism mesher (`mesher.ts`, Delaunator + Constrainautor CDT with earcut fallback), edge/raster indexes, mesh validation |
| `src/core/terrain/` | `HeightField`: the one grid every layer samples |
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
  stays closed. Trees are `MeshSolid`s assigned to a section by anchor.
- The mesher only accepts caps whose edges close exactly (`capIsClosed`).
  Pinched polygons (rings touching at a vertex, or a hole corner on another
  ring's edge) are shrunk by 1e-4 mm and retried. Never weld by coordinate.
- Water: cut (>= 5,000 m2, full-depth fill), basins (ponds/fountains by tags,
  recessed 1 mm), sheets (small, 0.18 mm above flattened ground). Cut water
  level is the interior median raised to the low tenth of its shoreline. The
  grid is flattened under it and the shore raised, and the fill sits 0.25 mm
  below the bank.
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

## Verification

```powershell
npm test                     # vitest, offline
npx tsc --noEmit
$env:NETWORK=1; npx vitest run src/core/data   # live data tests
npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --out out/loop.3mf
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

This applies to all code comments and anything public (READMEs, docs, PR descriptions). Write it like a developer leaving useful context for another developer, not like a technical writer, a tutorial, or an AI trying to make the codebase look well documented.

My older READMEs are the reference for tone: pre-2024 versions in jarvisar/solar-system, sorting-algos, interpreter, exoplanet-classifier, and senior-design. Don't use my newer repos as a reference, some of those are AI generated.

## General

- Plain, direct, and practical. Use a normal word when one works. Nothing corporate, academic, or overly polished.
- Short sentences. Describe actual behavior with concrete details, numbers, and examples.
- Focus on intent: what something is supposed to do, why a decision was made, and any constraints or tradeoffs.
- Call out real limits, exceptions, and edge cases. If something is uncertain, just say so.
- Qualifiers like "currently", "for now", "normally", "only when needed", "this should still..." or "we don't want..." are fine when they clarify scope.
- Keep it proportional to the problem. Don't invent terminology or structure for simple behavior.
- No em dashes, semicolons, emojis, arrows, bold scattered through sentences, or other punctuation and formatting regular people don't use.
- No AI patterns: "it's not just X, it's Y", rhetorical flourishes, intros that restate the title, "Overall, ..." wrap-ups, repeated summaries, filler adjectives like powerful, seamless, or robust.

## READMEs

- Open with a sentence or two on what it is. e.g. "This is a simple proxy server that adds the necessary headers to allow Cross-Origin Resource Sharing (CORS) for a specified website." or "My first real Three.js project."
- Link the live build if there is one: "Visit the [GitHub Pages site](...) to access the latest deployment."
- Controls and usage as short imperatives: "Use W/S to increase or decrease throttle. Use A/D to roll. Press the escape key at any time to exit flight mode."
- State limits plainly: "Currently the maximum amount is 512." or "Note that large searches can take up to 15 seconds to process."
- Small side notes can go on an h6 line: "###### Note: Assembly generator currently only supports integers"
- Usual sections, only when there's something to put in them: Usage or How to Use, Features, Local Installation (numbered steps with the command in backticks), Known Issues & Limitations, Screenshots, Credits.
- Title Case headings. "&" is fine in titles ("Solar System & Flight Simulator").
- Backticks for buttons, keys, files, branches, and commands.
- Keep it short. Most of my older READMEs were 250 to 550 words, bigger projects around 1,200 to 1,500.

## Code comments

- Sparse. Only for non-obvious logic, reasons behind a decision, edge cases, limitations, unusual behavior, or something another developer might be tempted to "fix".
- Don't narrate straightforward code or restate the function name. Don't add doc blocks just to have them.
- Short and plain, a fragment is fine. e.g. "# Use WSL to run the commands if on Windows" or "# If the input contains an equal sign, skip code generation"

## Attributes

Never list Claude or any AI tool as an author or co-author: no `Co-Authored-By` trailers, "Generated with" lines or session links in commits or pull requests, and no AI names in author, maintainer or copyright fields. The user (jarvisar) is the sole author and should appear as the sole Contributor on the GitHub repository.