# LiDAR sources

Which surveys the app reads, how, and which ones it can't. Everything is read from the browser with no server in between, so a publisher only works when both its index and its point files answer cross-origin requests (CORS). The one exception is a small proxy (`proxy/`, a Cloudflare Worker) for files on a fixed list of hosts without CORS, which builds of the site without it simply leave out. That rules out more open data than you'd expect, and the second half of this file lists what was checked and why it isn't used, so it doesn't need checking again.

Everything here was checked in late September 2026 by fetching from another origin in headless Edge, plainly and with a `Range` header. Curl's headers alone were misleading more than once: one server sends a header literally named `setifempty: Access-Control-Allow-Origin "*"`, and some redirect to a host without CORS.

## What's read

Each provider is a module in `src/core/lidar/sources/`, registered in `PROVIDERS` with a box around its territory. It's only asked about areas inside that box.

| Where | Source | Files | Notes |
| --- | --- | --- | --- |
| United States | USGS 3DEP, Hobu's mirror | EPT | |
| United States | USGS 3DEP work units Hobu's mirror hasn't built | LAZ through the proxy | Found with USGS's product search, which has CORS, and read from `rockyweb.usgs.gov`, which doesn't. That's about 180 work units from 2023 on (Houston, Portland, Pittsburgh, Baltimore, Salt Lake City, San Diego, Philadelphia, Miami) and Cincinnati's 2021-22 survey, about 33 returns per m². rockyweb gives each connection about 48 KB/s |
| United States and its territories | NOAA Digital Coast | EPT, COPC or LAZ tiles | NOAA's own builds of surveys USGS's mirror lacks: New York 2017 (23 returns per m² against 4), Philadelphia 2022, Miami-Dade 2021, DC, Richmond and Charleston 2025, Hawaii and the territories. A survey without an EPT is read through its zipped tile index, as COPC (Connecticut 2023) or as plain LAZ, which is offered. Topobathy water surface (class 41) reads as water |
| Kentucky | KyFromAbove | COPC, 5000 ft | Phase 2 (2019-2021, statewide) and phase 3 (from 2022). USGS's mirror has some of these flights, but over Louisville and Paducah only 2012-2013 data at 1-4.5 returns per m², against 5-7 here |
| Indiana's Lake Michigan shore | IndianaMap | COPC, 1250 ft | April 2025, about 35 returns per m², not in USGS's mirror yet |
| Illinois | ISGS clearinghouse | LAS, LAZ from 2023, 2000-2500 ft | Every county by year. Adds Cook 2022 (about 100 returns per m², buildings classified) and the 2019-2024 surveys USGS's mirror lacks. Cook 2022 tiles are 1.7-2 GB of uncompressed LAS each |
| Wisconsin | WisconsinView on UW-Madison's S3 | LAS or LAZ, 2250-2500 ft | Only the datasets USGS's mirror lacks, listed by hand since the host has no search by area: the 2024 counties (Dane, La Crosse, Portage, Taylor, Waushara), City of Madison 2022, Milwaukee MMSD 2020 (about 80 returns per m²) and three 2019 counties |
| Washington DC | DC OCTO 2024 | LAS, 800 m, 160-440 MB | Through its ArcGIS ImageServer, which ignores Range. About 15 returns per m², against 8 in NOAA's 2020 and 2022. Around the White House only ground is left, in NOAA's copies too, so it comes out flat |
| Salt Lake City, Denver | US DOT ARPA-I INSIGHTS, June 2025 | One COPC per flight area, 70 and 319 GB | Geiger-mode, about 135 and 75 returns per m², every return class 0 and single. Only LiDAR only models read it. Downtown Salt Lake is otherwise 2013. The highway corridors flown with it are left out, since their boxes would claim the ground beside the road |
| Alaska | Alaska DNR on NUVIEW's bucket | COPC, 750 m | 2023-2025, Seward, Skagway, Talkeetna, Hyder, Nenana, McGrath and about 30 more places. No index, so the projects are listed by hand and their tiles found by name. No building class |
| Canada | NRCan CanElevation | COPC | |
| New Brunswick | GeoNB | LAZ, 1 km | Adds 2025 (Moncton, Saint John), which NRCan doesn't have |
| France | IGN LiDAR HD | COPC | |
| Switzerland, Liechtenstein | swisstopo swissSURFACE3D | COPC | 2024 on. Older editions through Flai |
| North Rhine-Westphalia | Geobasis NRW | LAZ, 1 km, 50-130 MB | Index is the zipped tile metadata (110 KB) |
| Rhineland-Palatinate | LVermGeo RLP | LAZ, 1 km, 80-320 MB | Only ground (2) and everything else (20) |
| Brandenburg | LGB | LAZ in a ZIP per km | The server gives about 80 KB/s per connection, so a tile takes minutes |
| Halle (Saale) | LVermGeo Sachsen-Anhalt, 2017 | Deflated LAZ in one 17 GB ZIP, 2 km | 210-610 MB per tile, about 13 returns per m². Ground and non-ground only, like NRW. The rest of Saxony-Anhalt is on order |
| Berlin | SenStadt, 2021 | Deflated LAS in district ZIPs of 1-50 GB | About 200 MB per km². No building class |
| Luxembourg | ACT, 2024 | COPC stored in ZIPs | Read in place by range. 2019 through Flai |
| Scotland | Scottish Remote Sensing Portal | LAZ, 1 km | National programme from 2025, phases 1-6 before. Phase 2 is non-commercial and left out |
| Slovenia | GURS CLSS 2023-2025 | EPT | The contractor's EPT behind clss.si, undocumented. Folder-style node paths |
| Basque Country | geoEuskadi, 2017 | LAZ, 500 m | 3-6 points per m², but the only data for Bilbao and San Sebastián |
| Trentino | Provincia autonoma di Trento | LAZ, 500 m | The only open Italian point cloud with CORS |
| Genoa | Comune di Genova, 2018 | LAS, 1.7 x 1.4 km sheets, 0.5-1.7 GB | Whole city, 10-15 returns per m² on land. The WFS can't page, but it's only 157 sheets |
| Turku | City of Turku, 2021 | LAZ, 500 m, 115-150 MB | 71-86 returns per m², buildings classified. The city's index only answers its own site, so the sheet list is in the provider |
| Helsinki | City of Helsinki, 2021 and 2017 | LAZ, 500 m, 90 MB | The server ignores Range, so sheets download whole |
| Tokyo, Kanagawa, Yamanashi | G-Spatial Information Center | Deflated LAS in a ZIP per tile (Kanagawa 2024 is LAZ) | Index is vector tiles. 0.5-1.2 GB per km². In the 23 wards the COPC copies below are read instead |
| Tokyo's 23 wards, Nagasaki, Hyogo | AIST 3DDB | COPC | Copies of the prefectures' open data, found through 3DDB's API. Tokyo's are the same points as the ZIPs, read by range. 3DDB moved the heights to the ellipsoid (36-38 m higher), so Tokyo's tiles go back by the difference between the API's original lowest height and the file's. Nagasaki is all class 1. Hyogo's only covers the hills, so Kobe's port and plain come out flat |
| São Paulo | PMSP, 2017 | EPT | Classes 19 and 20 are undocumented, read as clutter and ground |
| New Zealand, Montreal 2015, Haiti, research sites | OpenTopography | LAZ | Only its own bulk data, not the federated USGS and NOAA entries |
| Northern Ireland's coast | DAERA 3D Coastal Survey 2021 | I3S scene layer | 28-31 returns per m², the coast and about 200 m inland: Belfast's harbour and Titanic Quarter, Bangor, Carrickfergus, Portrush. Not Belfast's centre or Derry |
| Christchurch | Canterbury Maps, 2020-21 | I3S scene layer | About 84 returns per m² in the centre. OpenTopography has the same flight as whole tiles, which this goes ahead of |
| Much of Europe | Open LiDAR Data (Flai) | COPC | Belgium, Denmark, Estonia, Finland, Saxony, Latvia and Riga, the Netherlands (AHN4), Poland to 2023, Slovenia, Spain, Dublin, England to 2022 |

Flai's README is out of date: its bucket has datasets the table doesn't list, such as Spain's second coverage in UTM 30 (Madrid, Seville, Valencia), the 2022-2025 PNOA around Zaragoza and Riga 2022. The provider lists the bucket's folders for the countries near the area as well as reading the README. It leaves out Flai's copy of IGN France, since IGN is read directly and that index alone cost tens of MB near France.

Licences and the credit each one asks for are in [data sources](DATA_SOURCES.md).

## Which survey is read

The newest survey that holds a building, or covers the whole area of a LiDAR only model, goes first, unless it can't fill the model's grid cells and an older one fills them clearly finer. USGS work units named like `CA_SanFrancisco_1_B23` count as 2023.

What counts is how finely a survey fills the cells actually asked for, not its density on its own. At the default scale the cells are 0.71 m and most surveys since about 2015 fill them, so the newest one wins. At 0.25 m cells only the densest do. An older survey goes first when the newest fills cells at least 1.25 times the size it does, and it's no more than `Older by up to` years older (5 by default), or twice that when the newest fills cells twice the size.

Densities come from each survey's own index around the area: an EPT's hierarchy or a few tiles' headers, a few KB. The catalogs' figures are averages over whole outlines and were 2x off in both directions. San Francisco's 2023 USGS survey averages 62 returns per m² and has 150 in the Financial District. King County's 2016-17 one averages 26 and has 14 in downtown Seattle, about what the 2021 survey has there.

Density alone misses holes. NOAA's 2025 Bay-Delta survey has 18 returns per m² in the Financial District but left 7% of 0.71 m cells empty between the towers, where USGS's 2023 survey left 0.5%. So when a survey 1.5 times denser than the newest could take its place, the newest is read on a 256 m block near the middle (the same probe a LiDAR only model uses for its cell size), and if it doesn't fill the cells there, so are the older ones that would beat it. That can be 25-55 MB for a dense survey, which is why it only happens when the choice depends on it. Probes are kept, so it's once per area and cell size. In the Mission, where there are no towers, the 2025 survey fills the cells and is read.

`Prefer` under `Layers > LiDAR` changes this. `Newest survey` always reads the most recent one. `Most detail` compares at 0.25 m cells whatever the age, without probing. `Survey` picks one by hand. It's read first and the others fill in where it doesn't reach. The list fills in by itself, in the order Automatic reads, with each survey's returns per m² around the area, and says why when Automatic passes over the newest. Finding surveys only reads catalogs and indexes.

## Whole files are asked about first

A survey that only comes as whole files (plain LAZ or LAS, a ZIP member, or a server that ignores Range) isn't downloaded until the user agrees, as in the add-on. The model is made without it and the action bar offers its tiles with their size, under `Download and regenerate`. A 300 x 250 m area of Cologne offers one 48 MB NRW tile for 41 buildings.

It's offered when it would measure buildings nothing else did, or fill part of a LiDAR only model nothing else reaches. Where something else was read, it's only offered when it's at least five years newer, or twice as dense around the area with two more returns per m² (not with `Newest survey`). Approved tiles are kept with the LiDAR cache. One tile's header is read before offering, so a survey that couldn't be read anyway is reported instead: OpenTopography's Indiana tiles have no height units and are 300 MB each. EPT and COPC are read without asking.

## How files are read

`src/core/lidar/read/tiles.ts` reads any tile by what its header says, not what the catalog says:

- COPC: the hierarchy pages that meet the area, then those nodes, by range. EPT the same way through `ept.ts`.
- Plain LAZ: laszip writes a chunk table at the end of the file, decoded in `chunks.ts` (a port of laszip's arithmetic coder, checked against laz-rs on real files). Chunks are fetched in runs of about 8 MB and decoded one at a time. A LAZ file has no spatial index, so the first read of a tile decodes all of it and notes where each chunk lies. Later reads of the same tile, for the next batch or block, only fetch the chunks they need. In Cologne the first block took 31 s and the other three under a second each.
- Uncompressed LAS: the same, in slabs of 65,536 records.
- In a ZIP: a stored member is read in place by range, like Luxembourg's COPC. A deflated LAZ member is fetched in 4 MB pieces, six at a time, and inflated whole (Brandenburg, 140 MB). A deflated LAS member is inflated as it arrives and cropped on the way, so a 470 MB Berlin tile never sits in memory.
- A server that ignores Range (Helsinki) gets one whole download, kept in the cache.
- An Esri I3S point cloud scene layer is walked like an EPT through its node pages, and each node is three requests: LEPCC positions (`read/lepcc.ts`), class codes and return numbers. Nodes are only small, so a 500 m square is 1,600 to 3,400 requests. Points from coarse nodes (over 5 cm of rounding) are left out. A layer's outline comes from its nodes of about 250 m under the area, so a coastal survey only claims the coast.

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
| Flanders | DHMV | WFS has CORS, the LAZ files don't |
| Wallonia, Brussels | | Province ZIPs of 45-253 GB without Range, Brussels without CORS |
| Bavaria | 1 km LAZ | The metalink service answers cross-origin, the files don't |
| Thuringia, Saarland, Saxony (official) | | No CORS on the files. Saxony comes through Flai |
| Baden-Württemberg, Hesse, Lower Saxony, Hamburg, Bremen, Schleswig-Holstein, Mecklenburg-Vorpommern | | Not open, ordered, or behind a login |
| Austria | Vorarlberg COPC, Salzburg SAGIS | No CORS on the files. Salzburg's is open (CC BY, about 43 returns per m² in the city, LAZ per 625 x 500 m sheet) and its index answers cross-origin, so it's worth asking. Vienna and Tyrol sell theirs, the rest is rasters |
| Denmark, Sweden, Norway, Finland (national) | | Token, login or export order. Norway's open projects now come as COPC with no login (Stavanger 2019), but only `hoydedata.no` itself may read them. Denmark and Finland come through Flai. Stockholm, Gothenburg and Malmö sell theirs |
| Poland | 2024-2026 | No CORS and no Range. 2018-2023 through Flai |
| Estonia | 2024 | No CORS. Older years through Flai, whose class 5 here is multiple returns, not high vegetation |
| Latvia, Lithuania, Czechia, Slovakia, Hungary, Croatia, Romania | | No CORS, login, or not open |
| Spain | CNIG third coverage | reCAPTCHA before every download |
| Spain | Madrid 2026 and 2023 | No CORS. The city's 2026 flight (67 returns per m², only around the F1 circuit so far) would be the best in Spain. The 2023 cloud is photogrammetric |
| Spain | Cantabria 2023, La Rioja, b5m Gipuzkoa | Cantabria's index has CORS and its ZIPs don't. La Rioja's files are behind a Cloudflare challenge. Gipuzkoa's works but is the same Basque surveys geoEuskadi serves |
| Catalonia | ICGC LiDAR Territorial | The file server didn't answer from here at all, and tiles are 300 MB to 1 GB |
| Navarra, Castilla y León, Castilla-La Mancha, Galicia | | No CORS or a captcha. Flai has the PNOA flights |
| Valencia | ICV | Works, but 0.5-1.4 points per m² and the same flights as Flai |
| Portugal | DGT 2024-2025 | STAC has CORS, every file needs a login |
| Italy | Friuli, South Tyrol, Emilia-Romagna, Milan, national | Email delivery, rasters only, or not open |
| British Columbia | LidarBC 2023-2025 | Index has CORS, the object store doesn't. Worth asking GeoBC |
| Quebec | MRNF | The WFS refuses any request with an Origin header |
| Nova Scotia | | Whole files only from an undocumented endpoint, no building class |
| Montreal, Vancouver, Surrey, Winnipeg | City portals | No CORS. NRCan covers them |
| Australia | ELVIS | Requester-pays buckets behind an email order |
| New Zealand | LINZ's own COPC | Needs an API key. OpenTopography has most surveys, a year or two behind |
| Uruguay | Montevideo 2024 | Index has CORS, the files don't |
| Curitiba, Merri-bek (Melbourne), Brisbane, Cairns, Noosa, Auckland 2024 | I3S scene layers | Readable now, but no licence stated (Curitiba's is an informal "free, credit IPPUC") or a contradictory one (Auckland). Worth asking |
| Caribbean Netherlands | AHN 2023-24 | Same bucket as AHN |
| Japan | Shizuoka | Works, but 1.5-2.1 GB per km² of stored LAS (Hamamatsu, Shizuoka city), and 3DDB has no COPC of it. Left out for now |
| Hong Kong, Singapore, Korea, Taiwan, Israel | | Rasters only, by order, or nothing found |
| United States | USGS's LAZ on S3 | `s3://usgs-lidar` is requester pays, so every anonymous request is refused, and `prd-tnm` only holds indexes, link lists and previews. The same files are read from rockyweb through the proxy instead |
| United States | Planetary Computer 3DEP COPC | 2012-2022 copies of what Hobu's EPT has |
| Texas | TxGIO | The catalog API has CORS, the files don't. Worth asking: nothing after 2018 is readable there |
| Lubbock, Salem OR | City-hosted LAZ, 2025 and 2023 | Both work, with CORS and Range. Lubbock's says it's for the city's internal use. Salem's forbids copying the data and its heights are NGVD29, about 1 m off NAVD88. Left out |
| Indiana | 2026 lake rim reflight in `usgspreliminary/` | Works (44 returns per m², uncompressed LAS), but the folder is temporary until USGS publishes it |
| North Carolina | 2024 Phase 3 statewide on NOAA (#15635) | NOAA lists it without files yet. Worth checking again: it would be the first modern survey of Raleigh, Durham, Greensboro and Charlotte |
| Washington, New York State, Pennsylvania, Omaha | DNR portal, `gisdata.ny.gov`, PASDA, `dcgis-lidar` | No CORS on the files. Long Island 2024, Pennsylvania's 2024 statewide QL1 (Philadelphia, Pittsburgh), Allentown 2025 and Omaha 2022 are nowhere else readable |
| Anchorage, Idaho Falls and Pocatello | Municipality of Anchorage 2025, Idaho State University's `ID_SouthernGaps` copy | Indexes have CORS, the LAZ files don't. Worth asking: USGS's mirror has nothing newer there |
| New Jersey, Connecticut (CT ECO), Hawaii | State buckets | No CORS, and nothing newer than NOAA or USGS have |
| Kentucky, Indiana | KyFromAbove phase 1, Indiana's statewide COPC and 2024 deliveries | The same flights as USGS's, or LAS and LAZ in folders that look temporary |

## Adding a source

1. Check CORS for real: fetch the index and a point file from a page on another origin, plainly and with `Range: bytes=0-99`. A redirect needs CORS at every hop. If only the files lack CORS, the proxy can read them: add their prefix to `PROXIED` in `src/core/data/corsProxy.ts`, check from a server that they answer `Range`, and have the provider return nothing when `proxyAvailable()` is false. The index still has to answer cross-origin itself.
2. Write `sources/<name>.ts` exporting a `Provider` with an `areas` box and a `discover` that returns `Candidate`s with `tiles`. `common.ts` has paged WFS and ArcGIS queries, S3 listings, grid squares and `Surveys` for grouping tiles. `shapefile.ts` reads shapefile indexes, zipped or by range.
3. Give it a `classification` when its class codes aren't ASPRS. Codes a mapping doesn't name are dropped, except water and bridges in LiDAR only models.
4. Add the grid to `read/crs.ts` if it's missing, and `horizontalCrs` on the tiles if the files don't carry one.
5. Register it in `PROVIDERS` and add a test with canned answers next to the others.
6. Run a real model of a town in it with `scripts/generate.ts --lidar-only`, and look at it.
