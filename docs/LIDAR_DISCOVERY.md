# LiDAR discovery and acquisition

Version 0.17.0 extends acquisition while retaining the existing footprint,
measurement, roof-reconstruction and printable geometry pipeline. Run
`pip install -r requirements-lidar.txt` in the **external** downloader environment
after upgrading. `pyshp==2.3.1` reads spatial indexes; nothing is installed in
Blender's Python. Prepare again after upgrading or changing discovery/units.

## Providers

| Adapter | Discovery | Automatic point acquisition |
| --- | --- | --- |
| USGS | Existing Hobu EPT boundaries, paginated TNM LPC products, linked survey metadata | Intersecting additive EPT nodes |
| Open LiDAR Data / Flai | Live publisher inventory, CRS area-of-use pruning, spatial tile indexes, selected DBF rows | Intersecting COPC octree nodes |
| STAC | User-configured public API/static catalog; GET/POST search, relative links, pagination, collection extents | EPT/COPC assets recognized by filename or media type |
| OpenTopography | Public `otCatalog`, dataset footprint and published `<alternateName>_TileIndex.zip` | Only if the index explicitly exposes a supported streaming format; ordinary LAS/LAZ remain offers |
| IGN France | LiDAR HD metadata WFS, intersecting classified tile polygons | COPC through IGN's range-enabled endpoint |
| NRCan Canada | CanElevation ArcGIS point-cloud tile index | Intersecting COPC nodes |
| Environment Agency England | Official WFS coverage plus survey tile search API | None; selected members of 5 km ZIP delivery tiles require consent |
| Scottish Government | National programme's public S3 index queried by OS grid prefix | None; intersecting indexed LAZ tiles require consent |
| Geobasis NRW | Published XML file inventory and companion survey CSV | None; intersecting 1 km LAZ tiles require consent |
| Bavaria LDBV | Official polygon-to-Metalink service | None; intersecting listed 1 km LAZ tiles require consent |
| PNOA / Castilla-La Mancha | Official ArcGIS coverage polygons and delivery URLs | None; intersecting LAZ tiles require consent |

See [official source coverage, limitations and practical tests](LIDAR_OFFICIAL_SOURCES.md).
The multi-nation providers remain available for unsupported areas and failed or
inadequate official coverage. Every candidate is ranked; countries never override
quality, coverage or consent. Original-source authority breaks quality/format ties.

Flai's inventory is its published Markdown table. A changed table/index schema
is reported instead of guessed. CRS area-of-use and index geometry locate data;
Flai tile names are not used to infer locations. Index `.prj` takes
precedence over inventory CRS for index geometry. COPC header CRS takes precedence
over tile/catalog CRS for points. National shapefile geometry is bounded to 64 MiB;
DBF reads fetch only the header and intersecting rows. OpenTopography zip expansion
is bounded to 128 MiB. Larger/broken indexes are reported as incomplete discovery.

STAC supports public HTTPS assets and catalogs, up to eight configured endpoints
and 256 documents per endpoint. Configure a collection endpoint for a large catalog.
Catalogs requiring authentication/signing, POST-only links with unsupported custom
semantics, non-LiDAR point products, or non-LAS EPT encodings are not supported.
Incomplete/repeated pages produce diagnostics while retaining discovered data.
STAC observation dates are used; `created`/`updated` are never acquisition dates.
Collection/delivery grouping alone is not proof of survey equivalence.

OpenTopography catalog availability does not guarantee bulk access. An unavailable
tile index or restricted download is reported with its dataset; no credentials,
processing jobs, subscription actions or alternate whole-file transfers are attempted.
Its ordinary LAZ is not treated as COPC merely because it lives on S3.

## Common contract and selection

`external/lidar_candidates.py` defines the candidate/settings contract. Candidates
carry `url`, `name`, `format`, WGS84 `coverage` and source metadata. Tiled deliveries
also carry `tiles` with HTTPS URLs, WGS84 bounds, revision and optional byte size.
Dataset identity is scoped to an authority; unknown identity stays unknown. The
legacy USGS dictionaries keep their existing keys and identity/provenance rules.

Providers only discover candidates. `lidar_acquisition.py` enriches/ranks them and
dispatches format readers. Add a national adapter to its registry and settings
catalog; no building-processing or geometry changes are necessary. Use explicit
survey/epoch identities; never group independently acquired surveys using proximity.

Selection first checks whole-building coverage. Within useful coverage it compares
reported acquisition intervals, density/spacing, comparable accuracy and classification,
with coverage fraction and known transfer sizes as further criteria. EPT and COPC
share the efficient streaming tier; EPT wins otherwise equal comparisons. Reported
full-asset byte sizes are estimates, not predicted COPC range-transfer totals.
Unknown metadata earns no quality advantage.

Ordinary LAS/LAZ must fill an eligible coverage/support/delivery gap or have a
material advantage over the preferred streamed dataset. Existing thresholds include
five years of acquisition separation, 1.5× and 0.25 m spacing improvement, or 2× and
2 points/m² density improvement. Accuracy comparisons require compatible units and
confidence definitions. A reconstruction rejection alone does not establish a gap.
Successfully read same-survey copies are redundant unless an actual delivery gap
was observed. Geometry/ground from independent surveys are never mixed.
Shared delivery URLs and original acquisition-specific EA/PNOA asset identifiers
retained by Flai establish per-tile aliases. These suppress duplicate streamed
reads and LAZ offers only inside the matched area; a streamed material quality
upgrade remains eligible. Generic grid names, titles and overlapping extents do
not prove equivalence. Unknown mirror identity remains unknown.

All EPT/COPC work precedes staged transfers. Ordinary Prepare, Refresh and scripted
preparation **never download ordinary LAS/LAZ**, including headers. The sidebar
offers useful intersecting tiles with reasons, geographic areas, provenance and
known sizes. **Download and Use Offered Tiles** grants consent only to that request,
dataset revision and reviewed building/tile set. Replays recheck eligibility;
expanded/changed offers require a new choice. Good streamed measurements remain
available until a complete usable replacement passes the existing measurement
selection. You can generate without accepting any offer.

## Coordinate and classification normalization

Every format returns the same seven columns: longitude, latitude, Z in metres,
internal class, single-return flag, capture year and date-evidence strength.
Horizontal transformation always uses explicit CRS and XY axis order. Vertical
units come from header vertical/3D CRS, GeoTIFF unit keys or explicit catalog units.
The established USGS EPSG:3857 mirror metre rule is preserved. Unknown vertical
datums are recorded; they are not guessed or transformed with a missing geoid grid.
Building Z is roof-minus-ground within one survey, never LiDAR-minus-terrain DEM.

**Missing Z Units** defaults to **Require Metadata**. Some Flai COPCs have only a
2D CRS or no CRS in their headers; catalog CRS can locate them, but does not prove
Z units. If source documentation establishes the units, choose the metre,
international-foot or US-survey-foot fallback. This only fills missing units and
participates in request/cache identity. Do not use it to override a known header.

LAS standard meanings are used unless an explicit classification mapping or LAS
ClassificationLookup VLR declares otherwise. Catalog `classification.mapping`
maps string codes to `ground`, `building`/`buildings`, or `unclassified`; unmapped
codes are excluded. An unknown custom convention without a mapping is rejected.
STAC `classification:classes` is converted to this mapping. Withheld, overlap,
noise and nonfinite points are filtered consistently. A reported single-year
acquisition can date wholly undated returns with `reported_acquisition` evidence;
multi-year intervals do not invent one year, and GPS evidence is never overwritten.

Useful STAC metadata includes `proj:epsg`, `proj:code`, `proj:wkt2`, observation
dates, `pc:density` (converted from projected square units), `file:size`, license
and citation. Explicit normalized fields such as `vertical_crs`, `vertical_units`,
`vertical_datum`, `point_spacing_m`, `vertical_rmse_m` and `classification` are also
accepted. Asset metadata overrides item metadata. Source audits, checkpoints and
building records preserve provider, survey metadata, CRS/datum and attribution.

COPC uses the pinned laspy reader through the existing strict cached Range
transport. A 206 response with matching range is mandatory; a 200 response is
rejected before reading its body. Header/hierarchy, node counts, decoded points and
group transfer allocations are bounded. Spatial subdivision handles dense crops;
there is no fallback to downloading the full file. Per-building 30 m ground halos
and tile allowlists are shared with staged acquisition.

## Verification and references

`test_lidar_international.py` exercises a locally generated compressed COPC,
pre-allocation limits, CRS/units/classification, static/API STAC pagination,
Flai and OpenTopography spatial indexes, failure isolation, ranking and dating.
Existing acquisition/offer/ranking tests cover USGS pagination, gap fallback,
redundancy, consent, upgrade offers, checkpoint replay and ordinary LAZ decoding.
`test_lidar_offer.py` also exercises automatic COPC plus explicit staged upgrades.

Publisher documentation used for the adapters:

- [Open LiDAR Data inventory and S3 access](https://github.com/flai-ai/open-lidar-data)
- [OpenTopography catalog API](https://portal.opentopography.org/apidocs/)
- [OpenTopography's published tile-index workflow](https://github.com/OpenTopography/OT_Tile_Index_Search)
- [STAC Item Search](https://github.com/radiantearth/stac-api-spec/tree/main/item-search)
- [STAC point-cloud metadata](https://github.com/stac-extensions/pointcloud)
- [laspy COPC reader](https://laspy.readthedocs.io/en/latest/api/laspy.copc.html)
