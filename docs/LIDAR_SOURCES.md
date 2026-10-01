# LiDAR sources

Which surveys the app reads, how, and which ones it can't. Everything is read from the browser with no server in between, so a publisher only works when both its index and its point files answer cross-origin requests (CORS). That rules out more open data than you'd expect, and the second half of this file lists what was checked and why it isn't used, so it doesn't need checking again.

Everything here was checked in late September 2026 by fetching from another origin in headless Edge, plainly and with a `Range` header. Curl's headers alone were misleading more than once: one server sends a header literally named `setifempty: Access-Control-Allow-Origin "*"`, and some redirect to a host without CORS.

## What's read

Each provider is a module in `src/core/lidar/sources/`, registered in `PROVIDERS` with a box around its territory. It's only asked about areas inside that box.

| Where | Source | Files | Notes |
| --- | --- | --- | --- |
| United States | USGS 3DEP, Hobu's mirror | EPT | |
| United States and its territories | NOAA Digital Coast | EPT, COPC or LAZ tiles | NOAA's own builds of surveys USGS's mirror lacks: New York 2017 (23 returns per m² against 4), Philadelphia 2022, Miami-Dade 2021, DC, Richmond and Charleston 2025, Hawaii and the territories. A survey without an EPT is read through its zipped tile index, as COPC (Connecticut 2023) or as plain LAZ, which is offered. Topobathy water surface (class 41) reads as water |
| Kentucky | KyFromAbove | COPC, 5000 ft | Phase 2 (2019-2021, statewide) and phase 3 (from 2022). USGS's mirror has some of these flights, but over Louisville and Paducah only 2012-2013 data at 1-4.5 returns per m², against 5-7 here |
| Indiana's Lake Michigan shore | IndianaMap | COPC, 1250 ft | April 2025, about 35 returns per m², not in USGS's mirror yet |
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

## Which survey is read

The newest survey that holds a building, or covers the whole area of a LiDAR only model, goes first. An older one with 2.5 times the returns per m² goes ahead of one less than five years newer, so San Francisco's 2023 USGS survey stays ahead of NOAA's sparser 2025 one. USGS work units named like `CA_SanFrancisco_1_B23` count as 2023. `Survey` under `Layers > LiDAR` picks one by hand. It's read first and the others fill in where it doesn't reach.

## Whole files are asked about first

A survey that only comes as whole files (plain LAZ or LAS, a ZIP member, or a server that ignores Range) isn't downloaded until the user agrees, as in the add-on. The model is made without it and the action bar offers its tiles with their size, under `Download and regenerate`. A 300 x 250 m area of Cologne offers one 48 MB NRW tile for 41 buildings.

It's offered when it would measure buildings nothing else did, or fill part of a LiDAR only model nothing else reaches. Where something else was read, it's only offered when it's at least five years newer, or twice as dense with two more returns per m². Approved tiles are kept with the LiDAR cache. One tile's header is read before offering, so a survey that couldn't be read anyway is reported instead: OpenTopography's Indiana tiles have no height units and are 300 MB each. EPT and COPC are read without asking.

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
| United States | USGS's staged LAZ (TNM) | `rockyweb.usgs.gov` has no CORS, `prd-tnm` only holds link lists and `s3://usgs-lidar` is requester pays. Hobu's EPT and NOAA cover most of it |
| United States | Planetary Computer 3DEP COPC | 2012-2022 copies of what Hobu's EPT has |
| Illinois | ISGS clearinghouse | Works. Chicago 2022 is about 100 returns per m², but uncompressed LAS of 1.7-2 GB per 762 m tile. Not added yet |
| Wisconsin | WisconsinView on UW's S3 | Works, with a GeoJSON index per dataset but no search by area. Madison 2024 and Milwaukee 2021 would need a hand-made list. Not added yet |
| Washington DC | OCTO 2024 ImageServer | Works, but whole uncompressed LAS of about 300 MB without Range. NOAA has 2020 and 2022 |
| Alaska | DNR COPC in `nuview-state-opendata` | Works, but only small towns and no index. Not added yet |
| Texas | TxGIO | The catalog API has CORS, the files don't. Worth asking: nothing after 2018 is readable there |
| Washington, New York State, Pennsylvania, Omaha | DNR portal, `gisdata.ny.gov`, PASDA, `dcgis-lidar` | No CORS on the files. Long Island 2024 and Philadelphia 2025 are nowhere else |
| New Jersey, Connecticut (CT ECO), Hawaii | State buckets | No CORS, and nothing newer than NOAA or USGS have |
| Kentucky, Indiana | KyFromAbove phase 1, Indiana's statewide COPC and 2024 deliveries | The same flights as USGS's, or LAS and LAZ in folders that look temporary |

## Adding a source

1. Check CORS for real: fetch the index and a point file from a page on another origin, plainly and with `Range: bytes=0-99`. A redirect needs CORS at every hop.
2. Write `sources/<name>.ts` exporting a `Provider` with an `areas` box and a `discover` that returns `Candidate`s with `tiles`. `common.ts` has paged WFS and ArcGIS queries, S3 listings, grid squares and `Surveys` for grouping tiles. `shapefile.ts` reads shapefile indexes, zipped or by range.
3. Give it a `classification` when its class codes aren't ASPRS. Codes a mapping doesn't name are dropped, except water and bridges in LiDAR only models.
4. Add the grid to `read/crs.ts` if it's missing, and `horizontalCrs` on the tiles if the files don't carry one.
5. Register it in `PROVIDERS` and add a test with canned answers next to the others.
6. Run a real model of a town in it with `scripts/generate.ts --lidar-only`, and look at it.
