# LiDAR sources

Which surveys the app reads, how, and which ones it can't. Everything is read from the browser with no server in between, so a publisher only works when both its index and its point files answer cross-origin requests (CORS). That rules out more open data than you'd expect, and the second half of this file lists what was checked and why it isn't used, so it doesn't need checking again.

Everything here was checked in late September 2026 by fetching from another origin in headless Edge, plainly and with a `Range` header. Curl's headers alone were misleading more than once: one server sends a header literally named `setifempty: Access-Control-Allow-Origin "*"`, and some redirect to a host without CORS.

## What's read

Each provider is a module in `src/core/lidar/sources/`, registered in `PROVIDERS` with a box around its territory. It's only asked about areas inside that box.

| Where | Source | Files | Notes |
| --- | --- | --- | --- |
| United States | USGS 3DEP, Hobu's mirror | EPT | |
| Hawaii, Puerto Rico, Virgin Islands, Guam, Marianas, American Samoa | NOAA Digital Coast | EPT | Only asked there, not on the mainland. Topobathy water surface (class 41) reads as water |
| Canada | NRCan CanElevation | COPC | |
| New Brunswick | GeoNB | LAZ, 1 km | Adds 2025 (Moncton, Saint John), which NRCan doesn't have |
| France | IGN LiDAR HD | COPC | |
| Switzerland, Liechtenstein | swisstopo swissSURFACE3D | COPC | 2024 on. Older editions through Flai |
| North Rhine-Westphalia | Geobasis NRW | LAZ, 1 km, 50-130 MB | Index is the zipped tile metadata (110 KB) |
| Rhineland-Palatinate | LVermGeo RLP | LAZ, 1 km, 80-320 MB | Only ground (2) and everything else (20) |
| Brandenburg | LGB | LAZ in a ZIP per km | The server gives about 80 KB/s per connection, so a tile takes minutes |
| Berlin | SenStadt, 2021 | Deflated LAS in district ZIPs of 1-50 GB | About 200 MB per km². No building class |
| Luxembourg | ACT, 2024 | COPC stored in ZIPs | Read in place by range. 2019 through Flai |
| Scotland | Scottish Remote Sensing Portal | LAZ, 1 km | National programme from 2025, phases 1-6 before. Phase 2 is non-commercial and left out |
| Slovenia | GURS CLSS 2023-2025 | EPT | The contractor's EPT behind clss.si, undocumented. Folder-style node paths |
| Basque Country | geoEuskadi, 2017 | LAZ, 500 m | 3-6 points per m², but the only data for Bilbao and San Sebastián |
| Trentino | Provincia autonoma di Trento | LAZ, 500 m | The only open Italian point cloud with CORS |
| Helsinki | City of Helsinki, 2021 and 2017 | LAZ, 500 m, 90 MB | The server ignores Range, so sheets download whole |
| Tokyo, Kanagawa, Yamanashi | G-Spatial Information Center | Deflated LAS in a ZIP per tile (Kanagawa 2024 is LAZ) | Index is vector tiles. 0.5-1.2 GB per km² |
| São Paulo | PMSP, 2017 | EPT | Classes 19 and 20 are undocumented, read as clutter and ground |
| New Zealand, Montreal 2015, Haiti, research sites | OpenTopography | LAZ | Only its own bulk data, not the federated USGS and NOAA entries |
| Much of Europe | Open LiDAR Data (Flai) | COPC | Belgium, Denmark, Estonia, Finland, Saxony, Latvia and Riga, the Netherlands (AHN4), Poland to 2023, Slovenia, Spain, Dublin, England to 2022 |

Flai's README is out of date: its bucket has datasets the table doesn't list, such as Spain's second coverage in UTM 30 (Madrid, Seville, Valencia), the 2022-2025 PNOA around Zaragoza and Riga 2022. The provider lists the bucket's folders for the countries near the area as well as reading the README. It leaves out Flai's copy of IGN France, since IGN is read directly and that index alone cost tens of MB near France.

Licences and the credit each one asks for are in [data sources](DATA_SOURCES.md).

## How files are read

`src/core/lidar/read/tiles.ts` reads any tile by what its header says, not what the catalog says:

- COPC: the hierarchy pages that meet the area, then those nodes, by range. EPT the same way through `ept.ts`.
- Plain LAZ: laszip writes a chunk table at the end of the file, decoded in `chunks.ts` (a port of laszip's arithmetic coder, checked against laz-rs on real files). Chunks are fetched in runs of about 8 MB and decoded one at a time. A LAZ file has no spatial index, so the first read of a tile decodes all of it and notes where each chunk lies. Later reads of the same tile, for the next batch or block, only fetch the chunks they need. In Cologne the first block took 31 s and the other three under a second each.
- Uncompressed LAS: the same, in slabs of 65,536 records.
- In a ZIP: a stored member is read in place by range, like Luxembourg's COPC. A deflated LAZ member is fetched in 4 MB pieces, six at a time, and inflated whole (Brandenburg, 140 MB). A deflated LAS member is inflated as it arrives and cropped on the way, so a 470 MB Berlin tile never sits in memory.
- A server that ignores Range (Helsinki) gets one whole download, kept in the cache.

A tile that needs reading whole costs its full size even for a small area. Expect anything from 50 MB per km² (NRW) to a GB (Tokyo's wards).

Catalog answers are kept for a day. If a catalog fails, a copy up to 30 days old stands in for it, since national servers go down for maintenance. A provider that takes over 90 s (NRCan 180 s) counts as failed and the rest carry on. Failures show in the model's warnings as either a catalog that couldn't be searched or a survey that couldn't be read.

Coordinate systems are in `read/crs.ts`, built in for every grid these providers use, including Japan's 19 plane zones. Files without a CRS (Scotland's phases, Helsinki, Berlin, Japan) get one from the provider.

## Checked and not used

Most of these have open data. They fail on CORS, a login or the format. A few would work if the publisher added one CORS header, and those are worth asking about.

| Where | What | Why not |
| --- | --- | --- |
| Netherlands | AHN5 and AHN6 COPC | The bucket's CORS rule only allows `basisdata.nl`. Worth asking Het Waterschapshuis. AHN4 comes through Flai |
| England | Environment Agency surveys after 2022 | No CORS on the search API or files, and 5 km ZIPs built on request |
| Wales, Ireland, Iceland | | Rasters only |
| Northern Ireland | Coastal survey | I3S scene layer only |
| Flanders | DHMV | WFS has CORS, the LAZ files don't |
| Wallonia, Brussels | | Province ZIPs of 45-253 GB without Range, Brussels without CORS |
| Bavaria | 1 km LAZ | The metalink service answers cross-origin, the files don't |
| Thuringia, Saarland, Saxony (official) | | No CORS on the files. Saxony comes through Flai |
| Baden-Württemberg, Hesse, Lower Saxony, Hamburg, Bremen, Schleswig-Holstein, Mecklenburg-Vorpommern | | Not open, ordered, or behind a login |
| Saxony-Anhalt | Halle 2017 | Works, but 2 km tiles of up to 600 MB in a 17 GB ZIP. Not worth it |
| Austria | Vorarlberg COPC | No CORS. The rest of Austria is rasters or on order |
| Denmark, Sweden, Norway, Finland (national) | | Token, login or export order. Denmark and Finland come through Flai |
| Poland | 2024-2026 | No CORS and no Range. 2018-2023 through Flai |
| Estonia | 2024 | No CORS. Older years through Flai, whose class 5 here is multiple returns, not high vegetation |
| Latvia, Lithuania, Czechia, Slovakia, Hungary, Croatia, Romania | | No CORS, login, or not open |
| Spain | CNIG third coverage | reCAPTCHA before every download |
| Catalonia | ICGC LiDAR Territorial | The file server didn't answer from here at all, and tiles are 300 MB to 1 GB |
| Navarra, Castilla y León, Castilla-La Mancha, Galicia | | No CORS or a captcha. Flai has the PNOA flights |
| Valencia | ICV | Works, but 0.5-1.4 points per m² and the same flights as Flai |
| Portugal | DGT 2024-2025 | STAC has CORS, every file needs a login |
| Italy | Genoa 2018 | Works, but uncompressed sheets of 0.5-1.7 GB |
| Italy | Friuli, South Tyrol, Emilia-Romagna, Milan, national | Email delivery, rasters only, or not open |
| British Columbia | LidarBC 2023-2025 | Index has CORS, the object store doesn't. Worth asking GeoBC |
| Quebec | MRNF | The WFS refuses any request with an Origin header |
| Nova Scotia | | Whole files only from an undocumented endpoint, no building class |
| Montreal, Vancouver, Surrey, Winnipeg | City portals | No CORS. NRCan covers them |
| Australia | ELVIS | Requester-pays buckets behind an email order |
| New Zealand | LINZ's own COPC | Needs an API key. OpenTopography has most surveys, a year or two behind |
| Uruguay | Montevideo 2024 | Index has CORS, the files don't |
| Caribbean Netherlands | AHN 2023-24 | Same bucket as AHN |
| Japan | Shizuoka | Works, but 1.4-3 GB per km². Left out for now |
| Hong Kong, Singapore, Korea, Taiwan, Israel | | Rasters only, by order, or nothing found |

## Adding a source

1. Check CORS for real: fetch the index and a point file from a page on another origin, plainly and with `Range: bytes=0-99`. A redirect needs CORS at every hop.
2. Write `sources/<name>.ts` exporting a `Provider` with an `areas` box and a `discover` that returns `Candidate`s with `tiles`. `common.ts` has paged WFS and ArcGIS queries, S3 listings, grid squares and `Surveys` for grouping tiles. `shapefile.ts` reads shapefile indexes, zipped or by range.
3. Give it a `classification` when its class codes aren't ASPRS. Codes a mapping doesn't name are dropped, except water and bridges in LiDAR only models.
4. Add the grid to `read/crs.ts` if it's missing, and `horizontalCrs` on the tiles if the files don't carry one.
5. Register it in `PROVIDERS` and add a test with canned answers next to the others.
6. Run a real model of a town in it with `scripts/generate.ts --lidar-only`, and look at it.
