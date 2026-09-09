# Overture schema research snapshot

Research date: 2026-09-04.

The current data release is `2026-08-19.0`, using schema `v1.18.0`. The tested
official client is `overturemaps==1.0.2`, which resolves the latest release from
Overture's STAC catalog. Release identifiers are recorded in each cache
manifest rather than compiled into geometry code.

Official references:

- [release notes](https://docs.overturemaps.org/blog/2026/08/19/release-notes/)
- [schema v1.18.0](https://github.com/OvertureMaps/schema/releases/tag/v1.18.0)
- [official Python client](https://docs.overturemaps.org/getting-data/overturemaps-py/)
- [building](https://docs.overturemaps.org/schema/reference/buildings/building/)
- [building part](https://docs.overturemaps.org/schema/reference/buildings/building_part/)
- [transportation segment](https://docs.overturemaps.org/schema/reference/transportation/segment/)
- [connector](https://docs.overturemaps.org/schema/reference/transportation/connector/)
- [infrastructure](https://docs.overturemaps.org/schema/reference/base/infrastructure/)
- [water](https://docs.overturemaps.org/schema/reference/base/water/)

## Selected types and fields

| Purpose | Current theme/type | Fields used or planned |
|---|---|---|
| Parent buildings | `buildings/building` | `id`, `geometry`, `sources`, `height`, `num_floors`, `min_height`, `min_floor`, `roof_height`, `roof_shape`, `roof_direction`, `roof_orientation`, `has_parts`, `is_underground`, `level`, `subtype`, `class` |
| Building components | `buildings/building_part` | same dimensional/roof fields plus required `building_id` |
| Roads | `transportation/segment`, `subtype=road` | `class`, `subclass`, `subclass_rules`, `width_rules`, `road_flags`, `level_rules`, `connectors`, `road_surface`, `sources` |
| Network topology | `transportation/connector` | connector point geometry and referenced connector IDs/positions |
| Physical bridge evidence/supports | `base/infrastructure` | `class`, `subtype`, `height`, `level`, `surface`, `source_tags`, `sources` |
| Surface water | `base/water` Polygon/MultiPolygon | `class`, `subtype`, `is_intermittent`, `is_salt`, `level`, `source_tags` |

Current `building` and `building_part` geometries may be Polygon or
MultiPolygon. Building parts refer to parents with `building_id`. `has_parts`
signals associated parts, but usable parts still need to be present in the bbox
response before suppressing the parent.

Height semantics, as measured on the sample data rather than as first
assumed:

- `height` is absolute from the ground to the top of the feature, and
  `min_height` is where the feature starts; a mass spans `min_height` to
  `height`. (The original reading, `terrain + min_height + height`, turned a
  tower's crown into a spire.)
- `min_floor` is a fallback for absent `min_height`.
- `roof_height` is inside explicit total heights for buildings and parts.
  The former blanket additive part rule was disproved by Chicago's
  177.4 m part with a 73 m roof (generated at 250.4 m). The Cincinnati
  162.7 + 40 = 202.7 m crown retains a narrow exception: the roof must not
  fit inside the part interval and an explicit parent must corroborate the
  additive top. See [the 0.10.0 investigation](LIDAR_BUILDINGS.md).
- `roof_direction` is the compass bearing the roof slopes down towards,
  verified on the eight skillion facets of a tower crown, whose directions all
  point away from the crown's centre.

Roof shapes gabled, hipped, skillion, pyramidal, and dome (with their common
synonyms) are built; others are stored as metadata and marked unimplemented.

## Transportation details that affect the design

The current bridge signal is a scoped rule:

```text
road_flags[].values contains "is_bridge"
```

`road_flags`, `width_rules`, `level_rules`, and subclass rules may each contain
`between: [start, end]`, where the positions are normalized distances along a
segment. A correct importer must split at the union of all active rule
boundaries; inspecting only the first rule would silently lose partial bridges.

`level_rules[].value` supplies relative stacking order, not a metric clearance.
Shared connectors prove physical network connection. A geometric crossing with
no shared connector is useful grade-separation evidence.

Road classes include motorway, trunk, primary, secondary, tertiary,
residential, living street, unclassified, service, pedestrian, footway, steps,
path, track, cycleway, bridleway, and unknown. `width_rules[].value` is the
current explicit edge-to-edge width in metres.

Important negative findings:

- current transportation segments do **not** contain a `lanes` property;
- segments do **not** expose raw `source_tags`;
- `sources[].record_id` can often identify an OSM entity for a separately
  licensed/attributed enrichment request;
- Overture's separately named GERS “bridge files” map IDs between datasets and
  are not physical bridge geometry.

`base/infrastructure` does expose `source_tags`. Useful classes include
`bridge`, `viaduct`, `bridge_support`, `trestle`, and sometimes `pier` or
`cantilever`. A generic `pier` must not automatically become a road support,
because waterfront piers share that class.

## Water details

`base/water` allows points and lines as well as polygons. Printable surface
water will select only Polygon/MultiPolygon and normally exclude
`subtype=physical`. Ocean polygons can be tiled and inland features may overlap,
so Phase 4 will clip and union them in local metric coordinates.

## Verified sample query

On 2026-09-04, the official client queried this exact bbox:

```text
-84.53370,39.08554,-84.47422,39.11094
```

Against release `2026-08-19.0` it returned 9,833 `building` features and 1,590
`building_part` features. The observed GeoJSON fields matched the v1.18 schema
listed above. Overture's bbox filtering selects intersecting features; it does
not clip their geometry, which is why clipping belongs in the add-on.

## Verified full-layer query (2026-09-04)

The same bbox was queried for every type the generator now uses, against
release `2026-08-19.0`:

| Type | Features | Notes |
|---|---|---|
| `building` | 9,833 | |
| `building_part` | 1,590 | |
| `segment` | 7,405 | `subtype` road and rail |
| `connector` | 12,918 | downloaded, not yet used |
| `water` | 89 | polygons, lines, and human-made basins mixed |
| `land` | 1,984 | mostly individually mapped tree points |
| `land_use` | 1,002 | |
| `land_cover` | 47 | coarse regional cover |

### base/land contains real trees

`base/land` publishes individually mapped trees as Point features with
`subtype = tree` and `class = tree`. In a 2 km sample window, 138 of 151 land
features were trees. Street and park trees are therefore real source data, not
decoration; only forest interiors need scatter.

### width_rules are rare

Only 2 of 937 road segments in the sample window carried `width_rules`. Class
defaults are the dominant width source in practice, not the fallback.

### Overture returns intersecting, not clipped, features

This matters far more for area features than for buildings. Measured against
the sample bbox, projected into model space:

| Type | Largest feature extent, relative to the selection |
|---|---|
| `land_cover` forest | ~531,000x |
| `land_cover` crop | ~94,000x |
| `land` (`class = land`, landmass) | ~660x |
| `land_use` (railway) | 0.15x |

Draping the first of those produced a green sheet over the whole model that
buried the water and terrain. The generator therefore rejects any surface
feature whose own unclipped extent exceeds the selection by more than a set
ratio, and excludes `land_cover` from tree scatter by default. `land_use` and
the `land` forest/wood polygons are genuinely local and need no such guard.

### land_cover carries its vocabulary on subtype

`land_cover` features have `class = null`; the useful value is `subtype`
(`forest`, `barren`, `shrub`, `crop`, `urban`). `urban` must not be treated as
a printable surface — it covers the built-up area wholesale.

### GeoJSON output is UTF-8

The client writes UTF-8 GeoJSON containing non-ASCII place names. Reading it
without an explicit encoding fails on a Windows default locale, so every read
in the add-on specifies UTF-8.

