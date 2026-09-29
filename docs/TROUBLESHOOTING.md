# Troubleshooting

## Generating

**"Could not reach the map data server."** The map data comes straight from Overture's files on Amazon S3 and the elevation from AWS. Check your connection. Some ad blockers, school or work networks block `amazonaws.com`. Try again on another network or with the blocker paused for the site.

**"This area is too large to download in the browser."** The area needs more than 300 MB of map data. Make it smaller, or turn off layers you don't need (buildings and roads are the biggest). Dense city centres need the most data for their size.

**It's slow or the tab runs out of memory.** Time and memory grow with the area and the number of buildings. Around 25 km² at the default scale is comfortable on a desktop browser. Close other heavy tabs, or split a large city into a few smaller models. Phones manage small areas only.

**The same area downloads again.** The downloaded data is kept for the session and in the browser's storage (up to 400 MB). A private window, or clearing the site's data, starts over. Moving the area reads new parts of the files, but anything already downloaded is reused.

**Few or no buildings.** Overture's building data varies by place. Some towns only have footprints without heights, which get a typical height for their type (a house 7 m, an office 20 m, anything unknown 10 m).

**The terrain looks flat.** At 1:14,286 a 30 m hill is only 2 mm tall, so most cities print nearly flat. Raise `Terrain > Exaggeration` to make hills read, or pick a hillier area.

**Water is missing or looks wrong.**
- Rivers and lakes at least 5,000 m² are cut through the base. Smaller water is a thin surface on the terrain, and ponds and fountains are recessed.
- Turning `Water` off leaves the openings empty.
- Water that isn't mapped as a polygon (only as a river line) doesn't show up.

**Roads cross rivers as solid causeways.** With `Bridges` off, roads over water keep a strip of ground under them so they print. Turn `Bridges` on to raise them on piers instead.

**LiDAR measured few or no buildings.** `Model details` shows how many were measured. The usual reasons:
- No streamed survey covers the area. The US, France, Canada and Switzerland are covered, other countries only where Open LiDAR Data has a dataset.
- A survey only counts for a building when it covers the whole footprint, so buildings on a survey's edge keep their mapped shape.
- Buildings under `Smallest footprint` are skipped, and so are buildings the scan barely reached or that were built after the survey.

**"LiDAR from ... could not be read."** That survey's server failed or refused the request. The other surveys and the mapped buildings are still used. Generating again retries it, since a result with failures isn't kept.

**The first LiDAR model is slow.** Surveys differ a lot in density. The `Chicago - The Loop (small)` preset (3.3 km²) reads about 790 MB and takes about 4 minutes on a desktop, and the `Paris - Eiffel Tower` preset (8 km²) about 2.2 GB and 15 minutes. Copenhagen's survey needs about 175 MB per km², downtown Toronto's about 430. It's kept in the browser (up to 1 GB), and the measured buildings are reused for a day, so changing other settings afterwards is quick.

**"No LiDAR survey that a browser can read covers this area."** A LiDAR only model needs a streamed survey over the area: the US, France, Canada and Switzerland, and other countries where Open LiDAR Data has a dataset. Switch back to `Map data` elsewhere.

**Flat patches, smeared edges or bumpy roofs in a LiDAR only model.** Glass, dark roofs and water return few points, and a sparse survey leaves gaps between its scan lines. Those cells take their neighbours' heights. When `Model details` shows larger cells than `Detail` asks for, the survey is too sparse for it, and a smaller `Detail` won't add points the survey doesn't have.

**A river or harbour prints as ground in a LiDAR only model.** Water comes from the survey alone, and some surveys file few or no water returns. IGN's survey of Paris leaves the Petit Bras beside Notre-Dame as holes, which take the height of the ground around them. For now `Map data` is the way to get that water, since it cuts Overture's water instead.

**Some water stays recessed with `Cut away water` on.** Water smaller than `Cut through the base above`, narrower than about 0.4 mm printed or up on a roof stays recessed. In a survey that doesn't mark water returns, only large holes on the ground count as water at all.

**A LiDAR only model is slow the first time.** It reads the survey over the whole area, but only as finely as the cells need. That came to about 75 MB per km² for Philadelphia's 2015 survey, 125 for Paris and 450 for San Francisco's densest survey at 0.25 m cells. A 600 m circle in downtown Chicago read 101 MB and took 30 seconds on a desktop. What's read is kept in the browser (up to 1 GB), so changing anything but the area, the scale or `Detail` builds again in seconds.

## SVG maps

**"Could not download any map data."** SVG maps come from OpenFreeMap's tiles at `tiles.openfreemap.org`. Check your connection, or the tile source under `Map data` if you changed it.

**The title doesn't fit.** A warning shows on the map when the title box or band has no room inside the border. Make the text smaller under `Title`, shorten it, or give the band more height.

**"Cleanup kept 95% of the roads."** Below 97% the cleanup removed streets, not just doubled lines. Lower `Line spacing` or the stub pruning under `Line cleanup > All settings`.

**The imported size is wrong.** The file is sized in millimetres. Check the size your laser software imports against the one shown in the preview.

**The area can't be resized.** The scale is locked. Unlock it next to `Scale` under `Area`.

**A loaded font doesn't work.** Fonts can be TTF, OTF or WOFF. WOFF2 files can't be read.

## The map and 3D view

**The map or the 3D view stays blank.** Both need WebGL. Turn on hardware acceleration in your browser's settings, update your graphics driver, or try another browser.

**"The 3D view stopped".** The browser reset the graphics, often because memory ran low. It usually comes back by itself. If it doesn't, reload the page and generate again. Your settings and area are kept.

## Exporting and slicing

**Bambu Studio imports plain geometry without filaments.** Open the file with `File > Open Project`, not `Import`.

**The colours in the slicer don't match my filaments.** The project starts from Bambu's PLA Basic and Matte presets in the colours you picked. Set each filament to what's loaded in your AMS before slicing, and recalculate the flushing volumes.

**The slicer warns about floating regions.** Some buildings have parts that start above the ground, like an overhanging upper floor, and bridge decks span open water. Turn on supports in the slicer. They're only needed under those spots.

**The model is bigger than the bed.** Turn on `Multi-plate export` under `Export`, or lower the scale. Each section goes on its own plate and the sections fit back together.

**STL files load in the wrong place.** Load all the files from the zip at once. PrusaSlicer and OrcaSlicer ask whether to treat them as one object with several parts: answer yes. In Cura, open them together, set each one's extruder, then select all and use `Merge Models`.

## Reporting a problem

Open an issue on [GitHub](https://github.com/jarvisar/web3dmapcreator/issues) with the share link (`Copy share link`), your browser, and what you expected to happen.
