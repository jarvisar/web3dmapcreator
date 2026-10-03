# SVG Maps

Notes on the flat maps. They started as SVGmap, a separate app, and the engine came across mostly unchanged. It's in `src/core/svgmap/` and runs in its own worker (`src/worker/svg.worker.ts`), so a preview can update while a 3D model generates.

## Data

SVG maps are drawn from [OpenFreeMap](https://openfreemap.org) vector tiles in the OpenMapTiles schema, the same tiles as the basemap, not from Overture. The line cleanup was tuned on those tiles, and they're quick to fetch: a city centre at 1:20,000 is 4 to 12 tiles. Any TileJSON URL, `{z}/{x}/{y}` template or `.pmtiles` file in the same schema works under `Map data`.

The one exception is `Add missing buildings from Overture` under `Map data`, off by default. Overture's buildings are OSM's plus machine-learning footprints from Microsoft and Google (and a few other datasets) wherever no OSM building overlaps them. Only those other footprints are read, since the OSM ones are already in the tiles (`src/core/svgmap/overture.ts`). One that overlaps a tile building by more than a quarter of its area is dropped too, for buildings mapped in OSM after Overture's release. What's left goes into the buildings layer like any tile building.

How much it adds depends a lot on the place. Over a 2 km window it added 0.1% to the building area in the Chicago Loop, 0.3% in Rome, 5 to 10% in Lagos, Dhaka, Jakarta, Chandler AZ and Milton Keynes, 16% in Kibera, 25% in Katy TX, 42% on São Paulo's outskirts, and about eight times what OSM has in Iztapalapa, Mexico City (241 OSM buildings, 4,771 added). Each of those was a 3 to 9 MB download that took under 2 seconds. Some limits:

- It only works on zoom 14 tiles. Lower zooms leave out small OSM buildings, so ML footprints added there would stand out. A map that drops a zoom level gets a warning instead.
- Maps that need more than 150 MB of building data are left without them, with a warning. A failed download draws the map without them and tries again a minute later.
- ML footprints are rougher than mapped ones: blobby corners, blocks merged into one shape, and now and then something that isn't a building, like a few in parks.
- Maps across the 180th meridian can't have them, since the Overture reader doesn't take boxes that wrap.
- Every settings change goes through the fills again, and those slow down with the number of buildings. In Iztapalapa at the default 1:20,000 (15,000 added) a change takes 1.6 s against 0.3 s without them, and an 8 km wide map (76,000 added) takes 7 s. Most of it is Clipper booleans in `resolveSurfaces` touching every building. Cutting those down to the buildings near each layer would help every dense map, but it could change the default output, so it's left for now.

Tiles store coordinates to about half a metre, so at large scales (under about 1:5,000) curves can look slightly angular. An area that would need more than the tile limit (400 by default) drops a zoom level at a time and says so in a warning. The tiles don't mark sidewalks, so they can't be removed by tag.

## The piece and the area

The area on the map is the piece's map window, the part inside the margin and border. Its proportions and corner radius come from the piece, and its width sets the scale: 1:n is the window's width on the ground over its width on the piece. `src/app/svgmap/piece.ts` does the fitting whenever the area or the piece changes. A margin moves the window on the piece, and the area moves with it (`setPieceSize`), so a bigger margin only crops its own side of the map.

With the scale locked, the default, it works the other way round: the width comes from the scale, so you give it the piece size and a scale and the box on the map is sized for you. The corner handles go away, and a new piece or place keeps the scale and changes the area. The scale is typed in mm per metre like a model's and kept as 1:n (`svg.scale`, with `scaleLocked` for the lock). It starts at 0.05 mm per metre, 1:20,000. Unlocked, presets and pasted bounds grow the window until it covers them, and `Fit to map view` fits it inside the view.

The shape is shared with 3D models, so a round coaster is a circular model too. Hexagons weren't in SVGmap and were added here so both outputs take the same shapes.

The engine works in Web Mercator scaled at the centre, the way MapLibre draws the map, while the box on the map uses the 3D models' local projection. Over a city-sized area they agree to under a pixel.

## Output modes

- Laser: filled areas engrave, lines score and the edge cuts. Every layer gets its own colour so it can get its own process. `LightBurn layer palette` uses LightBurn's colours so each layer lands on its own LightBurn layer, and `Minimal` gives three processes (engrave, score, cut).
- Plotter: everything is a stroke. Filled areas are hatched and the strokes are ordered to cut down pen-up travel. Each pen colour becomes a numbered layer (`1 - pen #000000`) that AxiDraw, vpype and saxi can split on.
- Print: coloured themes with wider lines for bigger roads.

Fills never overlap. LightBurn fills even-odd across a whole layer, so overlapping rings can cancel out and burn as bare wood. Every layer is unioned and split by priority, and water is cut away around buildings and piers standing in it so they stay readable.

## Line cleanup

Two lines closer together than the beam burn as one dark band. The cleanup comes from the Blender add-on and does the following, in order:

- Joins pieces of the same street into one line, including across tile edges
- Removes lines that run close and parallel to a more important one (sidewalks next to roads, doubled tracks)
- Shrinks tiny roundabouts into junctions, since they burn as dots
- Closes small gaps where paths stop just short of a road
- Removes tangles of footpaths that are too dense to read
- Thins out dense patches, but never removes residential streets or anything more important
- Removes short dead ends

A road is never removed in favour of a less important one. The preview shows how much of the road network was kept, and a warning appears below 97%.

`Line spacing` is the main setting. `Standard` sets it from the output: 0.3 mm for a laser, 1.7 times the pen width for a plotter and 0.35 mm for print. `Light` and `Strong` take 0.7 and 1.4 times that. The rest is under `All settings`.

## Routes

Roads picked in the preview go into routes, each drawn in its own colour on its own layer, or are left out. OpenFreeMap merges ways with the same tags and has no names on road lines, so a pick is saved as the line's shape in longitude and latitude, not an ID. Each render matches it back to the lines lying along it: at least 70% of a line within 4 m of the pick, or 0.25 mm printed if that's more. That happens before the line cleanup, so a route's lines only join each other and the cleanup never thins them out (`src/core/svgmap/routes.ts`).

Picks are kept in the browser under a key of their own, in exported options when the map area goes too and `Include edits` is on, and deflated in a copied share link (`p=`) unless that would make it longer than about 6,000 characters. A link only takes the lines with a point on the map, and the routes that have some (`linkScope.ts`). Picks nothing on the map matched are listed on the route card, to drop them. They're usually off the map, on a layer that's off, or drawn too differently at another scale.

## Titles

Titles come in a box in a corner or a band across the piece, in six outline fonts, five single-line Hershey fonts or a font you load (TTF, OTF or WOFF, not WOFF2). A loaded font is kept in the browser's IndexedDB. Hebrew in a loaded font is laid out right to left, and Arabic is left to opentype.js, which does the same and joins the letters. Some fonts trip opentype.js up (Arabic in Arial or Segoe UI), and then the letters are drawn one at a time without joining, with a warning. The map on screen lays the title out with the same code as the render, so what's drawn on the map is what ends up in the file.

The corner positions are corners of the piece's bounding box, which are off a circle or hexagon. The box goes to the nearest spot where it fits (`src/core/svgmap/text/place.ts`). Where there's a flat edge it stays flush to it and slides along, so on a hexagon it sits on the flat bottom in the corner. A circle has no flat edge, so there the box's outer corner lands on the rim about 45 degrees round. A long title can be too wide to reach a corner at all on a small coaster, and then the corners come out near the top or bottom middle. Band text is made as large as fits anywhere in the band, which on a round piece is by the band's straight edge, then centred in the rows it fits in.

The title can be dragged on the map or in the preview. It's kept as an offset from where its position puts it, as a share of the space inside the border, or of the band, so it keeps roughly its place when the piece changes size. The layout clamps it to where the title still fits and reports the offset it ended up at, which is what gets saved when it's let go. Picking another position or piece preset clears it.

Clicking the title shows handles. On a box the corners change `Size`, which scales the text, padding and outline together, and the sides set `boxWidth` or `boxHeight`. Those are stored along the text at 100% size, so a turned box swaps them and `Size` still scales a resized box. A side that hasn't been resized follows the text. Text keeps its size in a bigger box and shrinks in a smaller one, and `Autofit text` makes it fill the box either way. On a band the edge handle sets the band height and the text's corners change `Size`, but those go with autofit on, since the text fills the band then. A box too big for the piece, at any setting, is scaled down as a whole until it fits. Handles that would crowd each other on a small title are left out, corners first.
