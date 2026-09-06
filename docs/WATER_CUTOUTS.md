# Water cutout investigation (0.9.7)

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

The terrain still has finite grid resolution: multiple shore turns or narrow
openings inside one cell can be approximated. The shared polygon projector
also still drops holes crossing the crop boundary; correcting those into open
notches requires a separate clipping change. This release does not infer water
where the input lacks a usable polygon.
