# LiDAR Only Models

Notes on how LiDAR only models are built, and the decisions that are easy to undo by accident. It's a port of the Blender add-on's LiDAR Only mode for streamed surveys. The add-on's own `docs/LIDAR_MODEL.md` has the survey-by-survey reasons behind most of the height rules.

The model is a digital surface model of the whole area: one height per grid cell, meshed into one closed solid in the terrain colour, and the water as a part of its own if you pick `Thin layer`. Nothing is traced per building, so towers, bridges, trees and the ground all come out of the same grid, and nothing depends on how well the city is mapped. The only map data it can use is Overture's water (see Water). The code is in `src/core/dsm/`.

## The Grid

The grid's vertices sit on the area's own rectangle in its rotated frame, with each cell centred on a vertex, so nothing is resampled between reading the survey and meshing it. A square area turned 90 degrees reads exactly the same cells as the unturned one.

The cell is `Detail` over the print scale, 0.71 m by default. Before the real read, up to three blocks near the middle are probed and the cell grows in 5% steps until at most 3% of the cells on land are empty. Returns come in scan lines, so the average density isn't enough to go on: without this, every empty cell beside a wall takes the street's height and roof edges come out notched. Past 8 million cells the cells grow as well, since composing and meshing a bigger grid takes minutes and more memory than a tab should use.

Land here is 2 m squares with a return that isn't filed as water. The add-on counts any return, and Lake Michigan's scattered water returns made the Chicago lakefront's probe grow its cells from 0.71 to 2.08 m.

## Reading

Only streamed surveys (EPT and COPC) are read, through the same discovery and readers as LiDAR buildings. The grid is read in blocks of about 256 m, up to eight at a time in workers. A block's returns are counted into its cells as they're decoded, so no block holds its point cloud (`raster.ts`). Each cell keeps its second highest return, the same without vegetation-like returns, the mean ground and water heights, and four counts (`layers.ts`).

Blocks are checkpointed in the LiDAR cache. A cancelled read picks up after the blocks it finished, and changing any setting except the area, the scale or `Detail` reads nothing again. A block whose read failed isn't kept, so the next Generate tries it again.

A survey covering the whole area goes first so blocks don't mix years, then the same ranking as for buildings (newest first). Each cell takes its returns from the first survey whose outline holds it, even when it has none there: water and dark roofs return nothing, and another survey's returns would be another year's surface.

Every surface seen from above is kept (`surfaceClassTable`), including returns nobody classified, since whole surveys come that way. Noise, overlap, wires and towers are dropped. A provider's own class mapping only names ground, buildings and vegetation, so water and bridges keep their standard codes.

Most of the time goes into decompressing LAZ. Projecting and counting the returns is about a fifth of it.

## Heights

`compose.ts` is a port of the add-on's `compose` and matches it on the add-on's prepared Chicago, Philadelphia and Boston grids. Grids are float32 here, and on survey heights quantized to whole centimetres that flips an exact threshold on 1 to 3 cells per grid, by at most 0.2 mm printed. The rules were tuned on real surveys, so don't swap them for simpler ones without looking at real areas. In short:

- A hole among one surface takes the median of its neighbours. A hole at the foot of a wall takes the street, since it's usually the wall's scan shadow.
- Water is where the survey files water returns. A survey that files none only gets water from large holes whose shore is mostly on the ground.
- Trees are found per blob: mostly vegetation, rough, hollow in places and thick enough. Kept, they're smoothed into domes and the mesher holds them to finer facets. Removed, they take the height of what's under them.
- With `Remove cars and clutter`, anything under 2 m above the ground goes, and so does anything narrower than three cells that's long or stands near the ground (crane jibs, wires, poles). A short one on a roof is a spire and stays.

Changes from the add-on:

- With trees removed, the cells under them get the same cleanup as everything else. The add-on left them out of it and meshed them as finely as crowns, which kept the cars and benches under the trees.
- For a round or six-sided area, only the cells inside the shape decide where the base goes.
- Water grows into cells beside it that have some water returns and stand within 0.3 m of its level, and takes in specks of land under 10 m² inside it that stand within 1 m of it. San Francisco's 2023 survey files open bay with about a third of its returns as water. Without these the bay was land at the water level, and clutter removal raised each stray return to the ground interpolated from the shore, a field of spikes over the water. They change 245 cells of the add-on's Chicago grid, 159 of Boston's and none of Philadelphia's.

## Water

By default water sits `Water depth` below its lowest bank, in the one solid. `Water` has two other ways to print it.

`Thin layer` prints it as a part of its own in the water colour, like map models do. The surface is cut along the water the way `Cut away` cuts it (below), and each opening gets a terrain floor with a slab of `Water thickness` on top, its surface where the recess would be. The base goes under the floors. Every body gets a layer whatever its size, as long as it's at least 0.4 mm wide printed and not up on a roof, and islands, boats and pilings stay since nothing can fall out. A piece of water holding two bodies takes the lower level, so the water never stands over a bank.

`Cut away` cuts it out of the model instead, leaving openings through the base. Which water goes is decided the add-on's way (`cutWater`):

- Bodies of at least `Cut through the base above`, 5,000 m² and shared with map models. Water within 40 m counts as one body. Bridges split a river into stretches, and before this a short stretch between two bridges in Chicago stayed recessed while the rest of the river was cut.
- Only water at least 0.4 mm wide printed. An opening narrower than that doesn't print as one, so that water stays recessed.
- Nothing more than 3 m above the ground. That's a pool or a pond on a roof, and the cut would go down through the building.

Land the cut leaves on its own under 4 mm² printed (boats, pilings) goes with the water. Real islands stay and print as separate pieces. The survey only sees the top of a bridge, so a bridge becomes a solid wall from its deck down to the base.

One change: specks of land under 10 m² are also filled before the 0.4 mm opening, not only after. A scatter of them every few metres made the water around each one too narrow, and half of San Francisco's bay stayed recessed. Otherwise it matches the add-on cell for cell, on 38 of 40 random grids without specks. The other two differ by a few hundred cells where a speck sat beside narrow water.

The add-on drops cut cells to the bottom before meshing. Here the surface is meshed whole and then clipped along the cut like any other outline, which `clipTin` already does for the area's shape. For three rings out from the shore the cut cells take their bank's height, so the clip crosses a level surface and the bank comes out as a vertical wall rather than a bevel. Carried further, a riverside tower's roof would spread across the river and only make work for the mesher. The outline is traced along the cells and their one-cell stairs straightened (Clipper's `simplifyPaths` at a cell and a half). Each stretch of it is a flat panel of bank wall, and at three quarters of a cell a gently curving shore came out as a row of narrow panels, ribbed like the walls (below). Past about two cells the outline cuts into the detail beside the bank instead of the level strip. Land narrower than 0.2 mm beside the water is opened away, as for map land slabs, and for a cut pieces under 4 mm² go here too, since the area's shape can cut off new ones.

### Map Water

The water comes from the survey first. The add-on compared it with Overture's water polygons on Chicago and the Schuylkill, and I checked the Chicago lakefront, San Francisco's waterfront and the Seine in Paris as well. They agree on 80 to 96% of the water, and where they differ the survey is nearly always right for this model. Overture's polygons run under every bridge, pier and boardwalk (15 bridges along the Chicago River, 16 in Paris, and the Ferry Building and the Bay Bridge in San Francisco) and under trees hanging over the bank, and sit a median 1.2 to 2.3 m off the scanned bank. Cut along them, the bridges go, and Paris falls apart into its two banks and two islands.

So `Water outlines from map data` (on by default) uses them for two things only, and keeps whatever the survey saw standing in the water:

- Holes. IGN files very few water returns in Paris, and the Petit Bras beside Notre-Dame is three holes with none. Since the survey files water elsewhere, holes don't count as water, and the arm printed as flat ground. A hole mostly inside mapped water that would be filled as ground is now water, at the level of the survey's water in the same mapped water (`mappedHoles`), and bodies grow into mapped cells without returns. Only cells without returns change this way. Wiping the returns from a stretch of the Chicago River between two bridges gave flat ground 0.8 mm above the river without it, and water at the river's level with it. A hole read as a dark roof stays a roof, since a harbour's outline usually takes in its piers and pier sheds.
- Shorelines. Thin layers and cuts follow Overture's smooth outline where it runs within 3 m of the survey's shore, even when that trims a metre or two of scanned bank, and the survey everywhere else (`followMap`). A bank comes out as one clean line instead of traced cells, and the bridges, piers, wharves and moored boats inside Overture's water keep the survey's edge. Mapped islands and ponds under about 6 m across are left to the survey too. Chicago's bridges have mapped pilings at their corners, and those came out as little columns at deck height. The bank's height reaches another 3 m into cut water, so the shore stays a vertical wall wherever the line lands.

On USGS surveys of the Chicago River, San Francisco's and Boston's waterfronts and the Schuylkill, the survey files water well and the holes rule added 0 to 30 cells. The difference is in the shorelines. It costs 3 to 5 MB of Overture data per area and puts a map data credit on the model.

What it doesn't fix:

- In a survey with no water class at all, water only shows up as large holes on the ground. Water that returns points isn't a hole, and a river stretch whose shore is mostly bridges fails both tests. Taking returns at the water's level from the map would fix those, but it also takes floating docks, low boats and dry basins, so it's left out.
- Cells outside the survey's outline have no returns. The east end of Navy Pier is outside Cook County's 2017 outline, so it joins the lake.

## Mesh

`mesh.ts` triangulates the heights as an RTIN (Mapbox's Martini) in tiles of 512 cells, then collapses edges cheapest first, priced by quadric error against the faces as they are now. That way a wall drawn in one-cell stairs keeps merging into one straight facet, where quadrics accumulated from the start stop at the first stair. Vertices on the edge of the grid only slide along their own side and the corners never move, so the outline stays the exact rectangle.

Priced only against the current faces, a vertex can drift a little with each collapse. That's what turned roof-cap penthouses into pyramids before (see [how it works](HOW_IT_WORKS.md#lidar)). So every collapse is also checked against the grid itself: no grid point may end up more than one cell (0.05 mm printed) from the surface, measured square to it, so across a wall it's how far the wall moved. Points beside a wall get two cells (see Walls). Tree cells are held to 0.4 of one, so crowns keep enough facets to read round instead of crystalline.

Tiles are simplified in the LiDAR workers with the points on their edges pinned, then the seams get a pass of their own. The Chicago Loop test area (1.3 km square, 3.2 million cells) comes out at about 145,000 triangles, and the `Chicago - The Loop (small)` preset at 315,000.

## Walls

Next to Micropolitan's models, tall walls here came out ribbed: a facade in narrow vertical stripes, each shaded a little differently. Three things caused it.

- Relief along a facade too narrow to print. The survey sees fins, pilasters and notches a metre or two across, and meshed faithfully each one is a pair of ribs. After compose, `fairFaces` straightens relief narrower than 0.3 mm printed where no height level moves more than 0.14 mm, the building caps' `fair` (`lidar/envelope.ts`) with the same sizes. It runs in `model.ts` rather than in compose, so compose still matches the add-on.
- A diagonal wall in one-cell stairs only just fits within one cell of a straight line, so with any noise along it the mesher kept a vertex at nearly every stair. Points beside a step of more than four cells may now be two cells from the surface.
- The foot of the wall. A wall is a band of steep triangles between its roof edge and its foot, and the foot is crooked from whatever stands along it (planters, canopies, a lower wing) as well as the stairs. A triangle from the roof edge down to a short stretch of crooked foot faces the way that stretch does, so a tall wall on a crooked foot is a fan of stripes from roof to street. After meshing, `straightenWalls` simplifies each roof edge to straight lines, moves the wall's foot onto a line parallel to it at the wall's median width, and collapses what's left in line. It doesn't move tree or rim vertices, and nothing moves if it would turn a triangle over.

On the three Micropolitan areas the height of those stripes went down 39% in Chicago, 40% in Philadelphia and 50% in San Francisco, with 21 to 29% fewer triangles. Chicago and Philadelphia now come close to Micropolitan's. San Francisco still has more than twice as much: its streets run at 45 degrees to a north-up grid, the worst case for stairs.

Tried and dropped: snapping cells caught partway up a wall to the roof or the street (slightly worse), building each wall into the triangulation as a pair of constrained lines (worse, and a lot more code), and meshing with the building caps' Delatin (twice the triangles).

## The Solid

The surface is a cap (`CapSolid`): the TIN on top, walls along its outline and a flat underside, like a measured roof. Cutting it to a circle or hexagon, cutting water out of it and splitting it into print sections are all 2D clips of the TIN (`clipTin`), so every piece stays closed. A TIN this size only sends the triangles near the cut through the constrained triangulation and keeps the rest whole. Cutting a section out of the Chicago surface took 5 s the old way and takes about half a second.

The border rim stands `Height` above the highest ground, not the tallest tower.

Without map water no map data goes into the model, so exports credit only the surveys (`LiDAR: USGS 3DEP; EPT mirror by Hobu`), in the 3MF metadata and in the STL header. With it they credit OpenStreetMap and Overture first, as map models do.

## Limits

- The model shows the city the year it was surveyed.
- Glass, dark roofs and water return few points. They're filled from around them, which can smear small details.
- Water the survey barely files can print as ground where map water can't help, and anything outside the survey's outline with water beside it can come out as water (see Map Water).
- It's 2.5D. Nothing has air under it, so skybridges, canopies and the L come out solid to the ground, and bridges over a water layer or cut water solid to the base. It prints without supports.
- Parts of Chicago's L still come out as rows of rounded trees. The ties make the deck rough and a fifth of its returns are filed as vegetation.
- A roof edge filed as vegetation slopes down to the street instead of standing as a wall.
- Crane masts wider than three cells stay.
- Walls at an angle to the grid can still show faint folds, San Francisco's more than most, and round towers come out as flat facets.
- Straightening facades also trims small pinnacles around a spire, like the Chicago Temple's. The spire itself stays.

Tests are in `src/core/dsm/`.
