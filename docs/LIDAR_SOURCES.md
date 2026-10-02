# LiDAR sources

Which surveys the app reads, how, and which ones it can't. Everything is read from the browser with no server in between, so a publisher only works when both its index and its point files answer cross-origin requests (CORS). The exception is a small proxy (`proxy/`, a Cloudflare Worker) that reads files, and a few catalogs, from a fixed list of hosts without CORS. Builds of the site without it leave those sources out. That still rules out a fair amount of open data, and the second half of this file lists what was checked and why it isn't used, so it doesn't need checking again.

The sources without the proxy were checked in late September 2026 by fetching from another origin in headless Edge, plainly and with a `Range` header. Curl's headers alone were misleading more than once: one server sends a header literally named `setifempty: Access-Control-Allow-Origin "*"`, and some redirect to a host without CORS. The ones behind the proxy were checked in October 2026 from a server, with the Worker's User-Agent and no cookies, which is all the Worker sends.

## What's read

Each provider is a module in `src/core/lidar/sources/`, registered in `PROVIDERS` with a box around its territory. It's only asked about areas inside that box. "Proxy" means the files (and sometimes the catalog) go through the proxy.

| Where | Source | Files | Notes |
| --- | --- | --- | --- |
| United States | USGS 3DEP, Hobu's mirror | EPT | |
| United States | USGS 3DEP work units Hobu's mirror hasn't built | LAZ, proxy | Found with USGS's product search, which has CORS, and read from `rockyweb.usgs.gov`, which doesn't. That's about 180 work units from 2023 on (Houston, Portland, Pittsburgh, Philadelphia, Baltimore, Salt Lake City, San Diego, Miami, Long Island, Idaho Falls) and Cincinnati's 2021-22 survey, about 33 returns per m². rockyweb gives each connection about 50 KB/s, so Pennsylvania's 2024 work units come from PASDA's copy and New York's from the state's, the same points 50 to 100 times faster, wherever the copy has every tile of the area |
| United States and its territories | NOAA Digital Coast | EPT, COPC or LAZ tiles | NOAA's own builds of surveys USGS's mirror lacks: New York 2017 (23 returns per m² against 4), Philadelphia 2022, Miami-Dade 2021, DC, Richmond and Charleston 2025, Hawaii and the territories. A survey without an EPT is read through its zipped tile index, as COPC (Connecticut 2023) or as plain LAZ, which is offered. Topobathy water surface reads as water and the seabed is left out, including in the EPT builds, where five-bit classes turn 40-45 into 8-13 ([LiDAR only models](LIDAR_MODEL.md#reading)) |
| Kentucky | KyFromAbove | COPC, 5000 ft | Phase 2 (2019-2021, statewide) and phase 3 (from 2022). USGS's mirror has some of these flights, but over Louisville and Paducah only 2012-2013 data at 1-4.5 returns per m², against 5-7 here |
| Indiana's Lake Michigan shore | IndianaMap | COPC, 1250 ft | April 2025, about 35 returns per m², not in USGS's mirror yet |
| Illinois | ISGS clearinghouse | LAS, LAZ from 2023, 2000-2500 ft | Every county by year. Adds Cook 2022 (about 100 returns per m², buildings classified) and the 2019-2024 surveys USGS's mirror lacks. Cook 2022 tiles are 1.7-2 GB of uncompressed LAS each |
| Wisconsin | WisconsinView on UW-Madison's S3 | LAS or LAZ, 2250-2500 ft | Only the datasets USGS's mirror lacks, listed by hand since the host has no search by area: the 2024 counties (Dane, La Crosse, Portage, Taylor, Waushara), City of Madison 2022, Milwaukee MMSD 2020 (about 80 returns per m²) and three 2019 counties |
| Washington DC | DC OCTO 2024 | LAS, 800 m, 160-440 MB | Through its ArcGIS ImageServer, which ignores Range. About 15 returns per m², against 8 in NOAA's 2020 and 2022. Around the White House only ground is left, in NOAA's copies too, so it comes out flat |
| Texas | TxGIO StratMap, 2019 on | Deflated LAZ in a ZIP per quarter quad, proxy | Austin 2021 (32 returns per m², against 8 in USGS's 2017), El Paso 2023, San Antonio 2021, Round Rock and San Marcos 2024, College Station 2025. Each ZIP holds 16 tiles of 1/64 degree, 90-830 MB, read whole. 11 north Austin tiles are over the 768 MiB the reader inflates and are left out. Dallas, Fort Worth and Houston already have newer USGS surveys. The CloudFront in front of the files wants a User-Agent starting with `Mozilla/5.0` |
| Salt Lake City, Denver | US DOT ARPA-I INSIGHTS, June 2025 | One COPC per flight area, 70 and 319 GB | Geiger-mode, about 135 and 75 returns per m², every return class 0 and single. Only LiDAR only models read it. Downtown Salt Lake is otherwise 2013. The highway corridors flown with it are left out, since their boxes would claim the ground beside the road |
| Anchorage | Municipality of Anchorage 2025 | LAZ, 2500 ft, about 80 MB, proxy | 30 returns per m², against 5 in USGS's 2015. No building class: roofs are mostly 1, with some tall towers filed as high vegetation |
| Alaska | Alaska DNR on NUVIEW's bucket | COPC, 750 m | 2023-2025, Seward, Skagway, Talkeetna, Hyder, Nenana, McGrath and about 30 more places. No index, so the projects are listed by hand and their tiles found by name. No building class |
| Canada | NRCan CanElevation | COPC | |
| British Columbia | LidarBC | LAZ, 1.8 x 1.4 km, about 300 MB, proxy | Vancouver 2025, Surrey 2024, Victoria 2023, Kelowna 2025 and older NDMP years, 22-23 returns per m² from 2023 on. NRCan has some NDMP years as COPC under the same tile names (some with a different date on the end), and those tiles are left to NRCan. No building class |
| Quebec | MRNF | LAZ, 1 km, proxy for the catalog too | Trois-Rivières 2021, Rimouski 2024, Quebec City 2025 and many towns NRCan lacks. Projects NRCan copied whole (CMM 2023 and others) are left to its COPC. The WFS refuses any request carrying an Origin header, which the proxy doesn't send |
| Winnipeg | City of Winnipeg 2020 | LAS, 1 km, 325-341 MB, proxy | 11 returns per m², 2.4 times NRCan's copy of the same flight, buildings classified. The files carry no CRS at all |
| New Brunswick | GeoNB | LAZ, 1 km | Adds 2025 (Moncton, Saint John), which NRCan doesn't have |
| France | IGN LiDAR HD | COPC | |
| Switzerland, Liechtenstein | swisstopo swissSURFACE3D | COPC | 2024 on. Older editions through Flai |
| Netherlands | AHN5 (2023-24) and AHN6 (2025), Het Waterschapshuis | COPC, 1 km, proxy | 23-27 returns per m² in the cities. The bucket's CORS rule only allows `basisdata.nl`. Flai's AHN4 (2020-22) is denser in old Amsterdam (35), so `Most detail` can still pick it. A tile the bucket lacks answers 403, so each one is checked first |
| Brussels | urban.brussels 2021 | Deflated LAS, one 1.5 GB ZIP per km, proxy | 72 returns per m², buildings classified, against Flai's DHMV II (2014, about 3.5). The heaviest download there is |
| North Rhine-Westphalia | Geobasis NRW | LAZ, 1 km, 50-130 MB | Index is the zipped tile metadata (110 KB) |
| Rhineland-Palatinate | LVermGeo RLP | LAZ, 1 km, 80-320 MB | Only ground (2) and everything else (20) |
| Saarland | LVGL 2025 | Deflated LAZ in six district ZIPs of 12-26 GB, proxy | The only open survey there. Thinned to one point per 0.5 m square (about 4 per m²), buildings classified |
| Bavaria | LDBV | LAZ, 1 km, 80-300 MB, proxy | 2020-2024 by area, 11-49 returns per m², buildings classified: Munich, Nuremberg, Augsburg, Regensburg, Würzburg. No date index, so each tile's header and first point say when it was flown. The server gzips LAZ for anyone who accepts gzip and then ignores Range |
| Saxony | GeoSN | Deflated LAZ in a ZIP per 2 km, 245-365 MB, proxy | Dresden 2024, Leipzig 2023, 14-18 returns per m², against Flai's 2017-18 copies at 7-8. Ground and everything else only. Tiles and dates come from GeoSN's currency WMS, since the files are on a Nextcloud share that locks out an address after failed requests |
| Thuringia | TLBG | Deflated LAZ in a ZIP per km, 55-70 MB, proxy | 2019-2025 by area (Erfurt was flown in December 2019), 10-14 returns per m². Ground and everything else only |
| Brandenburg | LGB | LAZ in a ZIP per km | The server gives about 80 KB/s per connection, so a tile takes minutes |
| Halle (Saale) | LVermGeo Sachsen-Anhalt, 2017 | Deflated LAZ in one 17 GB ZIP, 2 km | 210-610 MB per tile, about 13 returns per m². Ground and non-ground only, like NRW. The rest of Saxony-Anhalt is on order |
| Berlin | SenStadt, 2021 | Deflated LAS in district ZIPs of 1-50 GB | About 200 MB per km². No building class |
| Salzburg | SAGIS | LAZ per 625 x 500 m sheet, about 100 MB, proxy | Salzburg city 2022 at 42-48 returns per m², the Pinzgau 2024, and the previous epoch (2016-2023 by region) where the newest doesn't reach |
| Vorarlberg | VoGIS 2023 | COPC, 2.5 km, proxy | About 27 returns per m². The files' WKT names MGI / GK West without a datum shift, which put points about 70 m off, so `crs.ts` defines 31254 with it |
| Luxembourg | ACT, 2024 | COPC stored in ZIPs | Read in place by range. 2019 through Flai |
| Scotland | Scottish Remote Sensing Portal | LAZ, 1 km | National programme from 2025, phases 1-6 before. Phase 2 is non-commercial and left out |
| Slovenia | GURS CLSS 2023-2025 | EPT | The contractor's EPT behind clss.si, undocumented. Folder-style node paths |
| Poland | GUGiK 2024-2026 | LAZ sheets of about 0.4 km², 50-100 MB, proxy | Newer than Flai's 2018-2023 in every big city: Warsaw, Kraków, Wrocław and Lublin 2025, Łódź, Poznań and Gdańsk 2024. Mostly 12 returns per m² (Łódź 37, Wrocław 20). The server ignores Range and has taken up to two minutes to start answering |
| Estonia | Maa- ja Ruumiamet | LAZ, 1 km, proxy for the catalog too | Each year's flights as they come out, ahead of Flai's copy. Tartu 2024 at 28 returns per m². Class 5 is multiple returns, not high vegetation |
| Basque Country | geoEuskadi, 2017 | LAZ, 500 m | 3-6 points per m², but the only data for Bilbao and San Sebastián |
| Navarra | Gobierno de Navarra | LAZ, 1 km, proxy | Pamplona 2020 (56 returns per m², 200-650 MB a tile) and the whole region 2024 (9 per m²). Heights are on the ellipsoid, so each tile goes down by Spain's geoid model (EGM08-REDNAP, bundled every 0.125°) to meet Flai's PNOA within about 10 cm |
| Madrid | Ayuntamiento de Madrid 2026 | LAZ, 1 km, 310 MB, proxy | Only the first delivery so far, 11 tiles around IFEMA and Valdebebas at 69 returns per m². The rest of the city was flown in June 2026 and isn't out yet |
| Catalonia | ICGC LiDAR Territorial v3.1 (2021-2023) | LAZ, 1 km, 270-370 MB in Barcelona, proxy | 22 returns per m² in the Eixample, against PNOA's 1.2. ICGC's server didn't answer US addresses at all in October 2026, so from the US this may only show as a failed search |
| Trentino | Provincia autonoma di Trento | LAZ, 500 m | The only open Italian point cloud with CORS |
| Genoa | Comune di Genova, 2018 | LAS, 1.7 x 1.4 km sheets, 0.5-1.7 GB | Whole city, 10-15 returns per m² on land. The WFS can't page, but it's only 157 sheets |
| Turku | City of Turku, 2021 | LAZ, 500 m, 115-150 MB | 71-86 returns per m², buildings classified. The city's index only answers its own site, so the sheet list is in the provider |
| Helsinki | City of Helsinki, 2021 and 2017 | LAZ, 500 m, 90 MB | The server ignores Range, so sheets download whole |
| Tokyo, Kanagawa, Yamanashi | G-Spatial Information Center | Deflated LAS in a ZIP per tile (Kanagawa 2024 is LAZ) | Index is vector tiles. 0.5-1.2 GB per km². In the 23 wards the COPC copies below are read instead |
| Tokyo's 23 wards, Nagasaki, Hyogo | AIST 3DDB | COPC | Copies of the prefectures' open data, found through 3DDB's API. Tokyo's are the same points as the ZIPs, read by range. 3DDB moved the heights to the ellipsoid (36-38 m higher), so Tokyo's tiles go back by the difference between the API's original lowest height and the file's. Nagasaki is all class 1. Hyogo's only covers the hills, so Kobe's port and plain come out flat |
| São Paulo | PMSP, 2017 | EPT | Classes 19 and 20 are undocumented, read as clutter and ground |
| Montevideo | Intendencia de Montevideo 2024 | LAZ sheets of about 0.8 km², 118-182 MB, proxy | 22 returns per m², buildings classified. The files are Alfresco share links, which the proxy matches by pattern rather than prefix, so it doesn't open every share on the server |
| New Zealand, Montreal 2015, Haiti, research sites | OpenTopography | LAZ | Only its own bulk data, not the federated USGS and NOAA entries |
| Northern Ireland's coast | DAERA 3D Coastal Survey 2021 | I3S scene layer | 28-31 returns per m², the coast and about 200 m inland: Belfast's harbour and Titanic Quarter, Bangor, Carrickfergus, Portrush. Not Belfast's centre or Derry |
| Christchurch | Canterbury Maps, 2020-21 | I3S scene layer | About 84 returns per m² in the centre. OpenTopography has the same flight as whole tiles, which this goes ahead of |
| Much of Europe | Open LiDAR Data (Flai) | COPC | Belgium, Denmark, Estonia, Finland, Saxony, Latvia and Riga, the Netherlands (AHN4), Poland to 2023, Slovenia, Spain, Dublin, England to 2022 |

Flai's README is out of date: its bucket has datasets the table doesn't list, such as Spain's second coverage in UTM 30 (Madrid, Seville, Valencia), the 2022-2025 PNOA around Zaragoza and Riga 2022. The provider lists the bucket's folders for the countries near the area as well as reading the README. It leaves out Flai's copy of IGN France, since IGN is read directly and that index alone cost tens of MB near France. The other indexes are whole shapefiles too, so a first search near Spain or the UK still downloads about 32 MB. The 2022-2025 PNOA has no index, so its tiles are found by name, and only inside each block's own region: the same numbers name a square 6 degrees away in the next UTM zone, and Aragón's tiles turned up at Bragança.

Licences and the credit each one asks for are in [data sources](DATA_SOURCES.md).

## Which survey is read

The newest survey that holds a building goes first, or for a LiDAR only model the newest of those whose outlines cover about as much of the area as any does (within 5%), unless it can't fill the model's grid cells and an older one fills them clearly finer. USGS work units named like `CA_SanFrancisco_1_B23` count as 2023.

What counts is how finely a survey fills the cells actually asked for, not its density on its own. At the default scale the cells are 0.71 m and most surveys since about 2015 fill them, so the newest one wins. At 0.25 m cells only the densest do. An older survey goes first when the newest fills cells at least 1.25 times the size it does, and it's no more than `Older by up to` years older (5 by default), or twice that when the newest fills cells twice the size.

Densities come from each survey's own index around the area: an EPT's hierarchy or a few tiles' headers, a few KB. The catalogs' figures are averages over whole outlines and were 2x off in both directions. San Francisco's 2023 USGS survey averages 62 returns per m² and has 150 in the Financial District. King County's 2016-17 one averages 26 and has 14 in downtown Seattle, about what the 2021 survey has there. A survey whose index doesn't answer within 20 s keeps its catalog figure.

Outlines can claim far more than a survey has points for, so for an EPT the index also says where in the area it has any, from its hierarchy down to nodes about a fortieth of the area across (at least 32 m). Over downtown Miami NOAA's 2018-19 Irma topobathy survey claims the whole area and has points in 45% of it, and USGS's 2019 Florida Keys survey in 87%. A survey with no points under the area isn't listed, and the list shows the share with points. It doesn't decide the order though: an index can't tell water from land, and by the Ferry Building San Francisco's 2023 survey has nothing over the far side of the bay (85%), so with it a 2010 survey that does went first. That's 8 to 80 small requests per survey, kept for a day.

Density alone misses holes. NOAA's 2025 Bay-Delta survey has 18 returns per m² in the Financial District but left 7% of 0.71 m cells empty between the towers, where USGS's 2023 survey left 0.5%. So when a survey 1.5 times denser than the newest could take its place, the newest is read on a 256 m block near the middle (the same probe a LiDAR only model uses for its cell size), and if it doesn't fill the cells there, so are the older ones that would beat it. That can be 25-55 MB for a dense survey, which is why it only happens when the choice depends on it. Probes are kept, so it's once per area and cell size. In the Mission, where there are no towers, the 2025 survey fills the cells and is read.

`Prefer` under `Layers > LiDAR` changes this. `Newest survey` always reads the most recent one. `Most detail` compares at 0.25 m cells whatever the age, without probing. `Survey` picks one by hand. It's read first and the others fill in where it doesn't reach. The list fills in by itself, in the order Automatic reads, with each survey's returns per m² around the area, and says why when Automatic passes over the newest. Finding surveys only reads catalogs and indexes.

The newest isn't always what you'd want. Over Quebec City, MRNF's 2025 survey (about 8 returns per m², no buildings) goes ahead of NRCan's 2017 one (11), since the gap isn't big enough for the rule above.

## Whole files are asked about first

A survey that only comes as whole files (plain LAZ or LAS, a ZIP member, or a server that ignores Range) isn't downloaded until the user agrees, as in the add-on. The model is made without it and the action bar offers its tiles with their size, under `Download and regenerate`. A 300 x 250 m area of Cologne offers one 48 MB NRW tile for 41 buildings. A Brussels tile is 1.5 GB.

It's offered when it would measure buildings nothing else did, or fill part of a LiDAR only model nothing else reaches. Where something else was read, it's only offered when it's at least five years newer, or twice as dense around the area with two more returns per m² (not with `Newest survey`). Approved tiles are kept with the LiDAR cache. One tile's header is read before offering, so a survey that couldn't be read anyway is reported instead: OpenTopography's Indiana tiles have no height units and are 300 MB each. EPT and COPC are read without asking.

## How files are read

`src/core/lidar/read/tiles.ts` reads any tile by what its header says, not what the catalog says:

- COPC: the hierarchy pages that meet the area, then those nodes, by range. EPT the same way through `ept.ts`.
- Plain LAZ: laszip writes a chunk table at the end of the file, decoded in `chunks.ts` (a port of laszip's arithmetic coder, checked against laz-rs on real files). Chunks are fetched in runs of about 8 MB and decoded one at a time. A LAZ file has no spatial index, so the first read of a tile decodes all of it and notes where each chunk lies. Later reads of the same tile, for the next batch or block, only fetch the chunks they need. In Cologne the first block took 31 s and the other three under a second each.
- Uncompressed LAS: the same, in slabs of 65,536 records.
- In a ZIP: a stored member is read in place by range, like Luxembourg's COPC. A deflated member is fetched in pieces six at a time (4 MB, or 16 MB through the proxy, which counts requests) and inflated as they arrive. A LAZ member is inflated once, up to 768 MiB, and held for every block that reads it. A LAS member is cropped on the way and never held, so a 2.9 GB Brussels tile is fine.
- A server that ignores Range (Helsinki, Poland) gets one whole download, kept in the cache.
- An Esri I3S point cloud scene layer is walked like an EPT through its node pages, and each node is three requests: LEPCC positions (`read/lepcc.ts`), class codes and return numbers. Nodes are only small, so a 500 m square is 1,600 to 3,400 requests. Points from coarse nodes (over 5 cm of rounding) are left out. A layer's outline comes from its nodes of about 250 m under the area, so a coastal survey only claims the coast.

A tile that needs reading whole costs its full size even for a small area. Expect anything from 50 MB per km² (NRW) to 1.5 GB (Brussels).

Catalog answers are kept for a day. If a catalog fails, a copy up to 30 days old stands in for it, since national servers go down for maintenance. An ArcGIS error (a 200 with `{"error": ...}`) counts as a failure too and isn't kept. A provider that takes over 90 s (NRCan 180 s, Salzburg 240 s, ICGC 20 s) counts as failed and the rest carry on, and it's left out of searches for the next 5 minutes. Failures show in the model's warnings as either a catalog that couldn't be searched or a survey that couldn't be read.

Coordinate systems are in `read/crs.ts`, built in for every grid these providers use, including Japan's 19 plane zones. Files without a CRS (Scotland's phases, Helsinki, Berlin, Japan, Bavaria, Salzburg, Brussels, Winnipeg) get one from the provider. A code in a file's WKT is only taken from the CRS itself, not its unit or datum, and a grid without a code of its own (NOAA's NAD83(CORS96) / UTM zone 10N) is read through its WKT. A WKT record that isn't one (`''` in some of GUGiK's sheets) is passed over and one LAStools wrote as a JSON string (Estonia's 2024 tiles) is unquoted, so the GeoKeys decide.

## Checked and not used

Most of these have open data. They fail on a login, the licence, the format, or have nothing newer than what's read. A few would work if the publisher said yes, and those are worth asking about.

| Where | What | Why not |
| --- | --- | --- |
| Netherlands | TU Delft GeoTiles | The same AHN flights as plain LAZ. The bucket's COPC is read instead |
| Caribbean Netherlands | AHN 2023-24 | Works through the proxy (plain LAZ, 22 returns per m² on Bonaire), but only small towns and new CRS codes. Left out for now |
| England | Environment Agency surveys after 2022 | The survey index has CORS now, but files are 5 km ZIPs built per request, without Range or a length, with each member's size only after its data. Only Cambridge, Oxford, Southampton, Brighton and a corner of Birmingham have anything after Flai's 2022 |
| Wales, Ireland, Iceland | | Rasters only |
| Flanders | DHMV | Only DHMV I and II exist, Flai has DHMV II, and the files ignore Range |
| Wallonia | | Province ZIPs of 45-253 GB without Range. Flai has it |
| Gelsenkirchen | City survey 2024 | Works (stored LAZ in one 23 GB ZIP, buildings classified), but NRW's 2025 tiles cover the city at the same density |
| Baden-Württemberg, Hesse, Lower Saxony, Hamburg, Bremen, Schleswig-Holstein, Mecklenburg-Vorpommern | | Not open, ordered, or behind a login |
| Austria (the rest) | | Vienna, Tyrol and Styria sell theirs, the others publish rasters |
| Norway | hoydedata.no COPC | Readable through the proxy, but only 53 of 1,240 open projects have COPC so far and Stavanger 2019 (13 per m², no buildings) is the only city. Bergen and Trondheim 2022 are open but not converted, Oslo is restricted. Discovery goes through the viewer's anonymous token, which isn't documented for other sites |
| Denmark, Sweden, Finland (national) | | API key, Basic auth account or async jobs. Sweden's is 1.4-2 points per m² anyway. Denmark and Finland come through Flai. Stockholm, Gothenburg and Malmö sell theirs |
| Latvia, Lithuania | | Latvia's open list is still the 2013-2019 cycle, which Flai has. Lithuania's 2025-26 survey is listed as public but delivered by order |
| Vilnius | City survey 2019 | Works (41 returns per m², uncompressed LAS of 1.8 GB per km², index with CORS), but no licence is stated anywhere. Worth asking the city |
| Czechia, Slovakia, Hungary, Croatia, Romania | | Czechia's open points are 0.44 per m² or ground only. Slovakia, Hungary and Croatia by order, Romania rasters |
| Spain | CNIG third coverage | reCAPTCHA before every download. The route without it signs URLs into a development bucket where the files aren't |
| Spain | Madrid 2023 | Image matching, not LiDAR (thinned to 100 points per m², classes 2 and 6 only) |
| Spain | Cantabria 2023 | Works through the proxy, but every ZIP carries a non-commercial licence |
| Spain | La Rioja, Gipuzkoa, Castilla y León, Castilla-La Mancha, Galicia, Balearics, Andalusia | La Rioja behind a Cloudflare challenge, Galicia a captcha. The rest are the same PNOA flights Flai has, or Gipuzkoa the same Basque surveys geoEuskadi serves |
| Spain | Àrea Metropolitana de Barcelona 2012-13, Barcelona city | A registered login, and a bot detection page |
| Valencia | ICV | Works, but 0.5-1.4 points per m² and the same flights as Flai |
| Portugal | DGT 2024-2025 | STAC has CORS, every file needs a personal login |
| Italy | Friuli, South Tyrol, Emilia-Romagna, Milan, national | Email delivery, rasters only, or not open |
| Nova Scotia | | Whole files only from an undocumented endpoint, no building class |
| Vancouver, Surrey, Montreal | City portals | Vancouver's sits behind a Cloudflare challenge. Surrey 2025 is 60 returns per m² but 1.1 GB of deflated LAS per km², and LidarBC covers it at 23. Montreal 2015 is OpenTopography's |
| Australia | ELVIS | Its API refuses anything but its own page, and the buckets are requester pays behind an email order |
| New Zealand | LINZ's own COPC | Needs an API key. One held by the proxy would work, but LINZ's terms tie a key to one person and forbid sharing access. Worth asking LINZ: it would add Wellington 2025 and Christchurch 2024-25. OpenTopography has most surveys, a year or two behind |
| Curitiba, Merri-bek (Melbourne), Brisbane, Cairns, Noosa, Auckland 2024 | I3S scene layers | Readable now, but no licence stated (Curitiba's is an informal "free, credit IPPUC", for its LAS on UFPR's mirror too) or a contradictory one (Auckland). Worth asking |
| São Paulo | GeoSampa 2020 | Works through the proxy as whole ZIPs (15 returns per m², 3 years newer than the EPT), but no licence is named. Worth asking PMSP |
| Japan | Shizuoka | Works, but 1.5-2.1 GB per km² of stored LAS (Hamamatsu, Shizuoka city), and 3DDB has no COPC of it. Left out for now |
| Hong Kong, Singapore, Korea, Taiwan, Israel | | Rasters only, by order, or nothing found |
| United States | USGS's LAZ on S3 | `s3://usgs-lidar` is requester pays, so every anonymous request is refused, and `prd-tnm` only holds indexes, link lists and previews. The same files are read from rockyweb through the proxy instead |
| United States | Planetary Computer 3DEP COPC | 2012-2022 copies of what Hobu's EPT has |
| Lubbock, Salem OR | City-hosted LAZ, 2025 and 2023 | Both work, with CORS and Range. Lubbock's says it's for the city's internal use. Salem's forbids copying the data and its heights are NGVD29, about 1 m off NAVD88. Left out |
| Indiana | 2026 lake rim reflight in `usgspreliminary/` | Works (44 returns per m², uncompressed LAS), but the folder is temporary until USGS publishes it |
| North Carolina | 2024 Phase 3 statewide on NOAA (#15635) | Still no files in October 2026. Worth checking again: it would be the first modern survey of Raleigh, Durham, Greensboro and Charlotte |
| Washington | DNR lidar portal | A POST query and a ZIP built per request behind a cookie gate, no licence stated. Worth asking DNR: Everett, Bremerton and Oak Harbor 2024-25 and Bellingham 2023 have nothing else modern |
| Philadelphia, Allentown | City survey 2025 on PASDA, Allentown 2025 | Philadelphia's own survey (37 returns per m², buildings classified, 0.7-0.95 GB of LAS per tile) is under an unclear "City of Philadelphia License". Allentown's (47 per m²) is a USGS work unit not in USGS's search yet, and will turn up through it |
| Omaha | Douglas County 2022 | Works (16 returns per m², buildings classified), but no licence is stated |
| Lincoln NE | Lancaster County 2022 | Non-commercial |
| Alaska | DGGS elevation portal | Nothing newer than what's read |
| New York State, Pennsylvania | `gisdata.ny.gov`, PASDA | Upstate cities have nothing newer than USGS's mirror. Their copies of USGS's 2024 work units are read, above |
| New Jersey, Connecticut (CT ECO), Hawaii, Maryland | State buckets and iMAP | Nothing newer than NOAA or USGS have. Maryland's iMAP was down for maintenance both times |
| Kentucky, Indiana | KyFromAbove phase 1, Indiana's statewide COPC and 2024 deliveries | The same flights as USGS's, or LAS and LAZ in folders that look temporary |

## Adding a source

1. Check CORS for real: fetch the index and a point file from a page on another origin, plainly and with `Range: bytes=0-99`. A redirect needs CORS at every hop. If they lack it, the proxy can read them: add a rule to `PROXIED` in `src/core/data/corsProxy.ts` (a `prefix`, or a `pattern` where a random id comes before the file name, and `noHead` where the host won't answer a HEAD with a length), check from a server that the files answer `Range` with the proxy's User-Agent, and have the provider return nothing when `proxyAvailable()` is false. GET catalogs can go through the proxy too, a POST-only one needs CORS itself.
2. Write `sources/<name>.ts` exporting a `Provider` with an `areas` box and a `discover` that returns `Candidate`s with `tiles`. `common.ts` has paged WFS and ArcGIS queries, S3 listings, grid squares, `Surveys` and `YearGroups` for grouping tiles, and `lasStart` for a file's header and first point date. `shapefile.ts` reads shapefile indexes, zipped or by range.
3. Give it a `classification` when its class codes aren't ASPRS. Codes a mapping doesn't name are dropped, except water and bridges in LiDAR only models.
4. Add the grid to `read/crs.ts` if it's missing, and `horizontalCrs` on the tiles if the files don't carry one. Heights on the ellipsoid need a `zOffset` per tile (Navarra, Tokyo's 3DDB copies).
5. Register it in `PROVIDERS` and add a test with canned answers next to the others.
6. Run a real model of a town in it with `scripts/generate.ts --lidar-only`, and look at it.
