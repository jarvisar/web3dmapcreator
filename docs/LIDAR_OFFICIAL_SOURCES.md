# Official LiDAR coverage in 0.17.0

Direct official providers extend the existing acquisition registry. USGS,
Flai/Open LiDAR Data, OpenTopography and configured STAC catalogs remain available,
including as fallbacks where direct coverage is absent or unusable. There are no
country overrides or country-specific building/terrain processing paths.

Coverage means a discoverable point-cloud tile, not a guarantee that every roof
will pass the existing measurement and FDM printability checks.

## Implemented direct sources

| Area | Source and discovery interface | Delivery and limits |
| --- | --- | --- |
| France | [IGN LiDAR HD](https://geoservices.ign.fr/lidarhd), `data.geopf.fr/wfs`, layer `IGNF_LIDAR-HD_METADONNEE:metadata` | Classified COPC. Query intersecting metadata polygons; use the published range-enabled `/chunk/telechargement/` endpoint. Acquisition dates, actual tile density, datum and processing level enter ranking; manual classification is preferred on otherwise comparable acquisitions. Availability follows the published tiles, not a claim of complete national coverage. |
| Canada | [NRCan CanElevation LiDAR Point Clouds](https://open.canada.ca/data/en/dataset/7069387e-9986-4297-9f55-0288e9676947), official ArcGIS `lidar_point_cloud_canelevation_en/MapServer/1/query` | Project-specific COPC on NRCan's public S3. Spatially query only relevant tiles and stream their octrees. Coverage is incomplete across Canada; no entire acquisition project is downloaded. |
| England | [EA Time Stamped Point Cloud](https://www.data.gov.uk/dataset/977a4ca4-1759-4f26-baa7-b566bd7ca7bf/lidar-time-stamped-point-cloud) and National LIDAR Programme. Official survey-index WFS joined to `environment.data.gov.uk/tiles/collections/survey/search` | Ordinary LAZ, offered with explicit consent. EA's minimum delivery is a **5 km ZIP**; that archive can contain points outside the map. Only indexed intersecting members enter preparation. The UI discloses this granularity. This is England, not UK-wide coverage. |
| Scotland | [Scottish National Land LiDAR Programme](https://www.data.gov.uk/dataset/80187dd8-6cae-47fb-b712-8afd98b7b3c9/scottish-land-lidar-programme-2025-capture-las), its [public S3 bucket](https://registry.opendata.aws/scottish-lidar/) | LAZ, consent required. Query OS National Grid prefixes in the published national-programme inventory and use only actual returned keys. Rollout is partial. Older separate phases are not claimed by this direct adapter. Unknown survey dates stay unknown; individual unidentified tiles are not merged into a fictitious common epoch. |
| Germany: NRW | [Geobasis NRW 3D-Messdaten](https://www.bezreg-koeln.nrw.de/geobasis-nrw/produkte-und-dienste/hoehenmodelle/3d-messdaten), official XML file inventory and companion survey CSV | Listed 1 km LAZ tiles, consent required. Grid footprints, acquisition date, density, file size, datum and original metadata are retained. Roof/object class 20 is normalized as unclassified, never as confirmed buildings. |
| Germany: Bavaria | [Bavarian OpenData](https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=laserdaten), official `poly2metalink/metalink/laser` polygon query | Listed 1 km LAZ tiles, consent required. Use catalog URLs, not guessed files. Missing dates remain unknown and unidentified tiles remain independent candidates. Synthetic ground/object classes are excluded according to the official class table. |
| Spain: Castilla-La Mancha | Official [PNOA second-coverage ArcGIS tile index](https://geoservicios.castillalamancha.es/arcgis/rest/services/Vector/Rejilla_Descargas_Laz2Cober/MapServer) | Classified, orthometric LAZ using index polygons and actual delivery URLs, consent required. This is regional second-generation PNOA coverage, **not** nationwide or third-generation PNOA. The documented capture-year/lot identifier provides acquisition-year precision. |

Metadata queries use a 24-hour disk cache, short network timeouts and bounded
responses/pagination. NRW's reusable inventory is metadata only. Scotland uses
bounded spatial S3 prefixes rather than a national file listing. Provider errors
are logged and do not stop other discovery or offline model generation. A failed
shared download exhausts retries once per preparation, not once per building batch;
a later preparation can retry it.

## Investigated but not claimed as implemented

| Area/source | Finding and limitation |
| --- | --- |
| Germany, BKG DigiZ-DE | BKG describes a minimum 40 points/m², but [the published access procedure](https://share.bkg.bund.de/spaces/DDP/pages/129892521/Hochpr%C3%A4zise%2B3D-Datengrundlage%2Bdurch%2BLiDAR) requires an emailed request and supplied download link. No anonymous spatial tile interface was verified. No automatic account/request/order is created. |
| Germany, Baden-Württemberg ALS_3 | [The official product page](https://www.lgl-bw.de/Produkte/3D-Produkte/Laserscandaten/ALS_3/index.html) describes ordering and handling charges. No reliable anonymous point-tile endpoint was verified. Existing GeoSN/Saxony coverage through Flai is preserved. |
| Spain, nationwide CNIG PNOA and Catalonia | [PNOA products](https://pnoa.ign.es/pnoa-lidar/productos-a-descarga) and [third coverage](https://pnoa.ign.es/web/portal/pnoa-lidar/tercera-cobertura) are available, but CNIG's tested download flow was interactive/session-based. No suitable public spatial point-cloud API was confirmed. ICGC publishes [high-quality territorial LiDAR](https://www.icgc.cat/es/Geoinformacion-y-mapas/Datos-y-productos/Elevaciones/Elevaciones-territorial/LiDAR-Territorial), but the advertised DataCloud endpoints timed out during investigation. Those UIs are not scraped. Flai remains useful for Madrid/Barcelona and other published Spanish acquisitions. |
| Italy | RNDT/national and regional catalogs were investigated. FVG's official WFS exposes `GRIGLIEGEO:QU_LAS_LIDAR_FVG` footprints and survey dates, but no verified public point-file URLs. Tuscany's catalog linked an interactive download portal. [Trentino's catalog](https://dati.trentino.it/dataset/lidar-rilievo-2006-2007-2008-link-al-servizio-di-download) describes raw point files by request. No brittle URL templates, city-specific archives or raster-as-point-cloud adapters were added. **No direct Italian provider is claimed.** This does not mean Italian LiDAR does not exist. |
| Wales / Northern Ireland | Authoritative raster and localized survey catalogs were found, but no stable automated point-cloud delivery was verified for this release. England and Scotland adapters do not imply coverage here. Existing international catalogs still run. |

## Metadata, ranking and duplicate handling

All adapters return the same candidate/tile contract. `lidar_services.py` shares
WFS/ArcGIS paging and compatible survey grouping. `lidar_archives.py` adds one
generic acquisition mechanism for named members of minimum ZIP delivery tiles.
The existing COPC/EPT/LAZ readers, preparation, roof fitting and Blender generators
remain shared. No geometry thresholds or FDM defaults changed.

Quality and coverage govern selection; official authority is a tie-breaker.
Good EPT/COPC remains preferred over ordinary LAZ unless reliable metadata shows a
material quality advantage. Unsupported regions and failed/inadequate direct
sources can use Flai/OpenTopography/STAC. An aggregator's efficient mirror can
still be useful even where its original publisher also exists.

Acquisition dates must be evidence, not publication timestamps. In NRCan's
[documented filename convention, section 6.3.5](https://natural-resources.canada.ca/science-data/science-research/natural-hazards/flood-mapping/federal-airborne-lidar-data-acquisition-guideline),
the collection date is the **end** of acquisition. That remains end-only and
cannot establish a newer survey's lower date bound or assign a year to all points.
The optional large FileGDB metadata product is not decoded by this release;
density/accuracy/start dates absent from the spatial service remain unknown.

Header CRS and vertical-unit metadata take priority. Provider specifications fill
known missing units; unknown datums remain explicit. No geoid correction is
invented. Building heights remain roof-minus-ground within one survey. Source
classification policies exclude synthetic/noise classes; NRW class 20 and IGN's
unconfirmed building class 67 use the conservative unclassified-roof route.
Specifications: [IGN classes](https://geoservices.ign.fr/sites/default/files/2024-09/DC_LiDAR_HD_1-0.pdf),
[NRW classes](https://www.bezreg-koeln.nrw.de/system/files/media/document/file/geobasis_hm_3dm_nutzerinfo_3d-messdaten_aus_dem_laserscanning.pdf),
[Bavarian classes](https://www.ldbv.bayern.de/mam/ldbv/dateien/laserdaten_punktklassenbeschreibung.pdf).

Duplicate suppression uses scoped survey identifiers, existing EPT input
provenance, shared original URLs, and recognized acquisition-specific EA/PNOA
identifiers retained by Flai. It applies only inside matched tile coverage.
Successfully read duplicate streams are skipped unless materially improved;
transfer failures permit another delivery. Bare grid filenames or similar titles
do not establish identity. Unknown mirror editions remain unknown, so not every
possible duplicate can be proven before acquisition. Already resolved buildings
do not enter another streamed source's batches.

## Practical verification (2026-09-10)

Tests used small real map selections. Production provider logic contains none of
these city names or coordinates. Retained point totals below refer to cropped
reader probes; the larger building selections were separate preparation tests.

| Test | Observed result |
| --- | --- |
| Paris | Official classified COPC streamed; 63,888 retained points in the initial small crop. Larger preparation adopted 57 building measurements; all-provider discovery selected IGN and retained Flai as fallback. Blender emitted 57 LiDAR buildings, 19,848 faces across the building test model, with no non-manifold/inconsistently wound edges. |
| Toronto | Three NRCan projects discovered. Correctly ranked GTA 2023 ahead of York 2019 and GTA 2015 using documented collection dates. GTA crop: 75,810 points using about 5 MiB of metadata/ranges. Larger preparation adopted 34 measurements; Blender emitted 34 LiDAR buildings, 17,499 building-model faces, with closed consistently wound meshes. |
| Cologne | Official NRW LAZ read/cropped; 64,743 points. Class 20 normalization exercised with actual data. Preparation adopted 32 measurements; print/geometry filtering emitted 30 LiDAR buildings, 13,945 building-model faces, closed and consistently wound. |
| Munich | Official Metalink-selected LAZ read/cropped; 91,212 points. Preparation adopted 39 measurements; geometry emitted 38 LiDAR buildings, 17,019 building-model faces, closed and consistently wound. |
| London | Five official survey candidates. The 2020 delivery initially timed out, then recovered: 9,385 cropped points from the selected ~163 MiB ZIP. A 2012 fallback ZIP also decoded, yielding 7,335 points. Flai independently found 2012 and 2007 COPC coverage. A neighboring official delivery timed out during the wider preparation probe; this exposed the repeated-download retry issue fixed in this release. A subsequent selection inside the working tile completed shared preparation but adopted zero roof measurements; source-building fallback was retained. |
| Campbeltown, Scotland | Published national-programme LAZ discovered via its spatial S3 prefix and decoded: 86,963 cropped points. |
| Toledo | Regional official PNOA 2019 LAZ decoded: 11,744 points. The larger old-city building selection adopted zero measurements because of sparse/noisy roofs and insufficient ground. Blender generated the source-building fallback model successfully with closed consistently wound meshes. Thresholds were not weakened to claim success. |
| Madrid / Barcelona | No direct coverage from the regional CLM adapter, as expected. Preserved Flai discovery found one Madrid and two Barcelona COPC acquisitions. |
| Dresden | Existing Flai/GeoSN COPC discovery still found coverage. |
| Trieste / Rome | Existing international catalogs returned no usable candidates at the tested bounds. No Italian preparation success is claimed. |
| Chicago | Fresh USGS EPT/TNM discovery succeeded; bounded EPT read returned 26,775 points. Ordinary TNM LAZ was not downloaded. |

The complete Python suite passed **647 tests**. It includes existing
USGS/COPC/STAC/consent regressions and new
official-provider fixtures for paging, axis order, cache expiry, source failures,
classification differences, capture-date precision, spatial tile selection,
ZIP extraction and scoped duplicate suppression. Focused Blender smoke, LiDAR,
facets, minimum-height, preference and modal-operator checks were also run.
A full offline Paris model was generated through the normal Blender operator
using Blender's exact request signature and all default providers: 57 LiDAR
buildings, two meshes, 19,785 faces, zero non-manifold/inconsistently wound edges,
0.31 seconds generation. This fixture used a flat base, 0.07 mm/m and height scale
1.0; unrelated road/water/tree layers were disabled. The separate synthetic smoke
test covers those layers with terrain. No terrain/geometry thresholds were changed.

Reproduce metadata queries (external LiDAR environment required):

```powershell
.\.venv-overture\Scripts\python.exe tests/live_lidar_official.py --case paris --case toronto --case london
.\.venv-overture\Scripts\python.exe tests/live_lidar_official.py --case madrid --case barcelona --case trieste --aggregators
```

Explicit bounded point-read and shared-preparation tests:

```powershell
.\.venv-overture\Scripts\python.exe tests/live_lidar_official.py --case toronto --acquire
.\.venv-overture\Scripts\python.exe tests/live_lidar_official.py --case cologne --acquire --use-offers
.\.venv-overture\Scripts\python.exe tests/live_lidar_official.py --case paris --prepare --all-providers
.\.venv-overture\Scripts\python.exe tests/live_lidar_official.py --case munich --prepare --use-offers
```

The test script writes JSON reports and prints the prepared bundle path.
`--prepare` downloads real Overture footprints; `--use-offers` explicitly consents
to the test's reviewed staged deliveries. Normal add-on consent is unchanged.
To run the existing Blender building-generation/closure check on a prepared bundle:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe' --background --factory-startup --python-exit-code 1 --python tests/blender_lidar.py -- --bundle <bundle-path>
```

Keep live reports/caches in ignored `scratchpad/`. Live availability can change;
zero candidates or a recorded provider error must remain an honest result.
