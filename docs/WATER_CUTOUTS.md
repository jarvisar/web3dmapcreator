# Water and coastline geometry

## Ponds, fountains and water basins

Ground Surfaces → **Ponds, Fountains and Basins** offers an enabled-by-default
**Recess Ponds, Fountains and Basins** toggle and two model-millimetre dimensions:

| Setting | Default |
| --- | ---: |
| Recess depth below the local bank | 1.0 mm |
| Water thickness above the basin floor | 0.8 mm |
| Resulting water surface below the bank (depth minus thickness) | 0.2 mm |

Recessed fills are batched into `WATER_RECESSED`, separate from ordinary water
in `WATER_SURFACE`. Both objects stay in the `WATER` collection and use the
water material. Either can be selected, hidden or deleted independently.

The water stays level, using the lowest sampled bank height (including island
banks) as the local reference. On a slope the drop below higher banks is larger.
Overlapping mapped parts of one basin share the lowest reference. Water
thickness must be positive and no greater than depth; the UI shows the resulting
drop and identifies invalid dimensions. The base extends downward if needed
to preserve the configured solid base thickness beneath the recessed floor.

Selection primarily uses OSM `source_tags`: `amenity=fountain` or
`natural=water` + `water=pond`/`water=basin`, with normalized pond/fountain/basin
class/subtype as fallback. A mapped `class=basin` qualifies even with the broader
`subtype=reservoir`; ordinary reservoirs retain their existing behavior.
Other explicit water types do not become basins. Generic unclassified water
polygons below 5,000 m² use the same shallow-recess geometry without being
relabelled as ponds. The fallback checks uncropped source area across all parts,
so a small crop of a large water body keeps ordinary water handling. Names do
not affect classification. Infrastructure fountain polygons are included, with
OSM-identity and identical-footprint deduplication across layers. Points and
lines have no invented basin. The existing minimum surface area still applies.

Basins retain solid floors rather than entering the river/ocean void mask.
Their exact prepared polygons cut the built terrain with a finite-depth Exact
Boolean, so a basin smaller than one terrain cell still appears. Construction
uses a temporary mesh and checks closure plus actual floor heights before
committing. Islands and clipped outlines survive. Basins overlapping another
water type are skipped and counted, preserving that type's existing behavior
and preventing its surface from hiding the recessed fill.
Natural land-cover slabs (forest, green, sand and rock) are cut
through their full thickness over every validated water footprint, including
ordinary water below the terrain-cut area threshold. Exact outlines preserve
water islands and clear surfaces at the shore. Water visibility and basin mode
do not control these exclusions once water data is being processed.
Paving stays on terrain foundations when **Keep Ground Under Structures** is
enabled; otherwise water cuts it away too. Only surviving paved caps receive
foundations, preserving courtyards and category priority. Natural surfaces do
not generate terrain supports.

With **Keep Ground Under Structures** enabled, roads, paths and buildings retain
their pre-recess terrain grade. Terrain-colored foundations rise under their
footprints, including narrow overlaps at the shoreline, rather than draping
structures down to the basin floor. Mapped bridge decks also retain ground
beneath their basin crossings. Basin islands and building courtyards are
preserved; water outside the supported footprints stays recessed. This also
works with the Water fill hidden or ordinary through-cuts disabled.
Non-bridge foundations have a minimum top 0.2 mm above retained water. Structures
use the corresponding raised grade without changing their heights or thickness.
Bridge causeways keep their existing field-relative height beneath the water.
`tests/blender_visible_supports.py` verifies that exception and structure contact;
`tests/blender_paved_supports.py` checks paving, natural cover, holes and toggles.
`tests/blender_untyped_water.py` checks generic small water, cropped large water,
explicit-type exclusions, visible bank clearance and foundation height.

Turning off **Water** hides the fill while retaining the recess. Turning off
**Recess Ponds, Fountains and Basins** restores the previous water rules.
**Cut Water From Terrain** continues to control other water and its existing
minimum cut area. Terrain must be enabled for the new basin mode.

Run `tests/blender_pond_basins.py` inside Blender for exact dimension, island,
sub-cell, crop, slope, overlap, failure, UI/toggle and scene-persistence checks.
`tests/blender_basin_support.py` checks structure placement against unrecessed
terrain, shoreline widths, foundation contact, bridge supports and holes.
The new classification tests are in `tests/test_land.py`. Generation reports
`water_basins`, `water_recesses_built`, `water_basin_surfaces`,
`water_basin_duplicates`, `water_basin_groups`, `water_basin_other_water_skipped`,
and `land_surface_water_cuts`. `tests/blender_water_surfaces.py` checks all
surface categories, ordinary and recessed water, islands, slope/thickness
preservation, fully covered slabs and protected structure geometry.

Validation: 432 pure tests, Blender smoke, focused basin/settings tests and the
existing water-cut regression pass. Full Cincinnati generation has 14 basin
parts in 12 groups and 42 closed meshes. `tests/blender_pond_basins_live.py`
checks actual cached DEM and water/infrastructure geometry: Clearwater has 3
basins / 123 floor-and-fill probes, San Francisco 16 / 238, and Chicago 22 /
590. Chicago skips two ambiguous overlaps with other mapped water. Each built
basin's water is 0.8 mm thick and its floor matches the solved local reference.

## Cropped islands and missing coastal water (2026-09-09)

The cached source polygons in both reported selections are valid. The defects
were introduced after loading the Overture water layer:

- Clearwater `-82.83485,27.96044,-82.79572,27.98152`: the ocean polygon has
  783 land holes. Five intersect the model frame; the shared ring projector
  discarded them because they were no longer closed interior holes. That
  replaced **4,379.15 mm² of model land (893,704 m² at 0.07 mm/m)** with water.
  One completely enclosed island was already retained.
- San Francisco `-122.44417,37.76678,-122.37834,37.81745`: clipping the shell
  as a single ring created an overlapping return edge on the west frame. The
  clipped ring self-intersected at model `(-203.00958, 105.87386)`. Terrain
  subtraction accepted it, but the later densified water prism failed mesh
  construction. The missing coastal body covers **54,191.73 mm²** in the model.
  The raw undensified ring happened to triangulate, hiding the clipping defect
  until the extra boundary vertices were introduced.

`geometry/water_geometry.py` validates each Polygon member, including all its
holes, and intersects the complete area with the model rectangle. It retains
directed source edges inside the frame and closes them with only the frame
intervals inside that polygon. Crossing holes become notches; concave shells
and land strips that cross the frame may produce several independent water
polygons. Enclosed holes are assigned to their containing component. Source
winding is normalized by ring role, not used to guess land/water tags.

Malformed coordinates, unclosed rings, self-intersections, orphan/overlapping
holes, and ambiguous boundary graphs reject the affected Polygon. A bad hole
is never dropped while its surrounding water is kept. Valid siblings of a
MultiPolygon still work. This is an area clip, not reconstruction of incomplete
coastlines or inference of water from lines.

`solve_water_bodies` continues to use `is_printable_water`. It cleans and
validates the clipped rings, then constructs a closed unit-height prism with
the existing mesh builder **before** flattening or subtracting terrain. Only
accepted bodies reach either operation. `generate_water` reuses that exact
topology at the solved water height and terrain bottom. Flat water requires no
boundary densification. Minimum-area/cut thresholds use net water area, with
islands subtracted. Counts include `water_invalid_polygons` and
`water_meshes_rejected`; surface/plug counts measure successfully added meshes.

The shared non-water projector, tag classification, physical deck restoration,
building foundations, bridge support logic, and water-mask interval composition
are unchanged. Turning off water visibility still leaves intentional cutouts.
The clipper and validation use the standard library; Shapely was used only as
an independent test oracle in the downloader environment.

### Coastline detail

The source has detailed shoreline and pier outlines. The self-intersecting
frame spur was a clipping bug; remaining small irregularities in the terrain
edge are largely its finite grid approximation, not missing source vertices.
Grid-line intersections retain exact shore positions, but a cell joins them
with straight edges and retains the existing 2% node inset. Multiple turns,
narrow channels, or tiny islands within one cell cannot all be represented.
San Francisco's cell spacing is about 2.13 mm at resolution 192, 1.59 mm at 256,
and 0.80 mm at 512. Comparing those footprints to the source shows the error
shrinking with resolution. The fix does not smooth away mapped coastline or
alter the terrain/bridge resolution policy.

### Coastline regressions

`tests/test_water_geometry.py` covers each frame edge, corners, enclosing and
enclosed holes, split components, reversed winding, coincident edges, the
self-intersecting crop-spur pattern, malformed rings and MultiPolygon isolation.
`tests/blender_water_cut.py` additionally ray-tests terrain and water over
cropped islands, rejects mesh failures before terrain mutation, and verifies
net-area thresholds alongside the existing harbor/support tests.

The cached real-data audit is reproducible without downloading:

```text
blender --background --factory-startup --python-exit-code 1 --python tests/blender_coastline_live.py -- --cache <cache-root> --area clearwater
blender --background --factory-startup --python-exit-code 1 --python tests/blender_coastline_live.py -- --cache <cache-root> --area sf
```

Optional `--render <image.png>` and `--report <report.json>` save an overhead
model preview and mesh/probe results. The test runs full generation, asserts
every accepted body has a water surface, ray-tests source land/water locations,
and checks every generated mesh for closure and consistent winding.

The full pure suite passes 427 tests. Independent Shapely intersections match
all printable source polygons in both selections to less than 1e-5 mm², and
450 randomized valid concave polygon clips also match. Local diagnostic data,
mesh audit reports and previews are in `scratchpad/*coast*`.

Full generation checks passed for Clearwater (28 closed, consistently wound
meshes / 777,742 faces; 2 water bodies and surfaces) and San Francisco (35
meshes / 4,144,483 faces; 11 bodies and surfaces). The six Clearwater land
probes cover all five formerly discarded islands plus the already preserved
island; neighboring channels and three San Francisco bay probes have water
surfaces and no terrain. Neither selection rejected water for topology or
mesh failure. The existing Chicago harbor regression passes all four probes
with 40 closed meshes, and Cincinnati passes with 42 closed meshes. Blender
smoke, focused water geometry and ground-support regressions also pass.

## Earlier Chicago cutout investigation (0.9.7)

The Chicago selection `-87.64875,41.84962,-87.59743,41.89455` already contained
the missing harbor water in its cached Overture polygons. The failure happened
after water identification, when the add-on restored ground, and separately
when it chose shoreline crossings between overlapping polygons.

## Causes and corrections

`data/land.py` included `marina` in `WATER_DECK_CLASSES`. Thus
`cut_water_from_terrain` marked the whole marina dry and scheduled its entire
footprint for a `TERRAIN_SUPPORTS` pedestal. A marina is a facility extent that
can contain both land and water, as described by the
[OSM marina definition](https://wiki.openstreetmap.org/wiki/Tag:leisure%3Dmarina).
It is now excluded from physical deck restoration. Existing pier, quay,
breakwater, dam, weir, boardwalk, groyne, building, and bridge handling remains.

In the cached Chicago data, the Monroe Harbor marina is about 701,958 m² and
the larger Chicago Harbor marina about 2,826,135 m² within the model. At a
256-column terrain resolution, mapped decks previously reduced 16,979 water
nodes to 6,747. With the marina correction, 16,930 remain water; only the actual
physical structures restore nodes. These counts precede building restoration
and bridge supports, and overlapping marina areas must not be added together.

`geometry/watermask.py` already combined water coverage correctly at grid
nodes, but stored every polygon's individual boundary crossings. Selecting a
crossing could therefore choose an edge inside another water polygon. Two
overlapping water areas beginning at x=4.2 and x=4.8 within the same grid cell
could cut at x=4.8, leaving land between x=4.2 and x=4.8. The cached Chicago
water-only mask had six affected mixed grid edges at resolution 192, with a
maximum displacement of about 11 real metres.

The mask now composes wet intervals on each row and column: adding a polygon
unions its water spans, and restoring a structure subtracts its dry spans.
Only boundaries of the resulting intervals are used for the shoreline. Holes
belong to their own polygon, and another water polygon can cover them. The same
composition serves land-surface clipping, so terrain, surface slabs, and ground
queries agree. Existing cell topology, crossing inset, and selection among
multiple genuine transitions in one edge are preserved.

## Comparison with the SVG reference

`examples_and_inspiration/jarvizar_blosm_to_bambu_svg.py` consumes imported BLOSM
geometry; it does not download OSM itself. Its relevant stages are:

- `stitch_directed_chains`: joins coastline pieces head-to-tail while
  preserving OSM's land-on-left direction.
- Coastline closure: clips lines to the crop and walks its boundary to close
  land regions; water is the crop minus land, including island holes and
  enclosed lakes. Building seeds help detect inconsistent orientation.
- Loose water boundary repair: compares both crop-boundary closures using
  existing water and building evidence, rejects large or ambiguous repairs,
  and treats coastline tangent extension separately from ordinary water lines.
- Water merging: unions overlapping water coverage without treating unrelated
  nested or overlapping features as holes.
- Deck handling: restores physical structures such as piers and breakwaters;
  it does not interpret whole marina extents as solid decks.

The add-on receives Overture polygonal water extents, rather than the SVG
exporter's loose BLOSM edges. No new coastline inference or centerline filling
is needed for this failure: the harbor footprint is already present. The
transferable rules are to preserve the union's boundary and restore only
physical structure footprints. Guessing closure for ordinary river centerlines
would not supply reliable evidence of a bank.

## Validation

Run the pure regression suite:

```text
python -m unittest discover -s tests -p "test_*.py" -t tests
```

Run the Blender geometry regression without downloaded data:

```text
blender --background --factory-startup --python-exit-code 1 --python tests/blender_water_cut.py
```

It probes actual terrain, support, and park meshes for harbor voids, preserved
narrow structures, dry islands, and overlapping water in both input orders.
It also checks mesh closure, winding, and nondegenerate faces. Restoring the
old marina classification makes the harbor probe fail; the old crossing logic
fails the overlapping-water probe.

With the Chicago cache populated, run:

```text
blender --background --factory-startup --python-exit-code 1 --python tests/blender_water_cut_live.py -- --cache <cache-root>
```

This runs full generation and the manifold audit, then independently casts
rays through four harbor locations against terrain, supports, and land slabs.
The cached Chicago run passed all four probes and checked 40 meshes with
5,640,470 polygons: none had non-manifold edges. Mask construction with the
same physical decks and buildings took 0.055 seconds before and 0.058 seconds
after the interval correction, with identical wet-node states.

## Scope and existing limits

Water visibility remains independent of cutting, and the existing minimum
cut-area setting is unchanged. No coordinates or feature identifiers are used
by the production fix. Coastline reconstruction, shared polygon projection,
and mesh construction have not been replaced.

The shared non-water polygon projector still drops holes crossing the crop
boundary; water now uses the complete-area clip described above. Water is not
inferred where the input lacks a usable polygon.

## Exact terrain cut (2026-09-13)

The grid cut described above joined two edge crossings with a straight chord
per cell, and marked water only at grid nodes. At the default resolution a
cell is about 26 m, so water narrower than that was mostly missed while its
full-depth fill still followed the exact polygon. On the cached Magic Kingdom
selection (`-81.60576,28.39744,-81.55542,28.42994`, buildings and trees off)
the Jungle Cruise channel and castle moat were left standing inside their
water fills, single wet nodes opened diamond holes with islands missing, and
convex shores showed see-through wedges. Ray samples at 0.2 mm found 526 mm²
of terrain inside cut water outlines and 81 mm² of gaps.

`WaterMask` now keeps the outlines it rasterises and answers `contains`
exactly, and the terrain is cut along them in one constrained triangulation
of the grid nodes and outlines. Kept-ground footprints (decks, buildings in
the water) are removed from the cut exactly as well. The same samples found
no gaps; the remaining 24 mm² is ground intentionally kept under mapped docks
below their water fill. Land slabs are draped whole and cleared from the exact
water footprints rather than grid clipped.
