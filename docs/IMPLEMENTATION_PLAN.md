# Architecture and staged implementation plan

## Design boundaries

This project is intentionally optimized for roughly 1–3 km printable city
selections. Blender remains the final editing, boolean, coloring, and export
workspace. Data access, schema parsing, metric conversion, and mesh creation are
separate so later phases can evolve without rewriting Phase 1.

```text
Overture/STAC
    │ official overturemaps client in external venv
    ▼
versioned bbox cache (GeoJSON + manifest)
    │ standard-library parsing
    ▼
source features ──► centralized WGS84/local ENU transform
    │                         │
    │                         └──► shared metres→miniature-mm scales
    ▼
feature-specific geometry policy
    │
    ▼
Blender mesh/collection/material helpers
    │
    ▼
editable CITY_MODEL hierarchy
```

## Source layout

Implemented modules:

```text
jarvizar_city_model/
    __init__.py                    add-on registration / Blender 3.6 metadata
    blender_manifest.toml          Blender 4.2+ extension metadata
    config.py                      scene settings
    operators.py                   paste-bbox/cache/generate/export-3mf/clear
                                   orchestration
    ui.py                          N-panel
    data/
        cache.py                   deterministic bbox cache + manifest
        geojson.py                 small-area GeoJSON parsing
        overture.py                external-client adapter
        projection.py              WGS84 ECEF → local ENU → miniature mm
        terrain.py                 TerrainSampler + FlatTerrain
    external/
        download_overture.py       official client process entry point
    geometry/
        buildings.py               pure height/part-selection policy
        roofs.py                   pure roof semantics and roof geometry
        building_generation.py     feature-to-Blender building generation
        heightfield.py             the one shared terrain grid, plus the cut
                                   and the ground kept back inside it
        watermask.py               wet nodes + exact shoreline crossings
        terrain_mesh.py            pure terrain solid, with water cut out
        dem_terrain.py             terrain solid and border rim objects
        surfaces.py                water, land cover, and the cut
        support.py                 causeways and pedestals over cut water
        roads.py / bridges.py      ribbons, decks, piers
        bridge_network.py          pure crossing recovery and joint keys
        deck_graph.py              pure whole-network deck height solve
        deck_profile.py            pure profile walking (stations, interpolation)
        vegetation.py              deterministic tree scatter
        planar.py                  shared pure planar geometry
    blender/
        collections.py             tagged hierarchy and safe cleanup
        materials.py               simple architectural materials
        mesh_utils.py              clipping, tessellation, closed extrusion
```

Planned modules will be added only when their phase is implemented and tested:

```text
data/transportation.py
data/water.py
data/dem.py
geometry/roads.py
geometry/bridges.py
geometry/water.py
geometry/dem_terrain.py
external/preprocess_linear.py
```

There are no fake success methods for these paths in Phase 1.

## Phase 1 — implemented (buildings and base)

- bbox UI and validation;
- official-client building/building-part download;
- atomic-ish per-bundle cache replacement and manifest provenance;
- exact decimal bbox text storage (avoids Blender float32 longitude rounding);
- local metric ENU projection without raw lon/lat mesh coordinates;
- aspect-preserving target footprint scaling;
- flat terrain sampler and watertight base;
- deterministic building extrusion;
- variable-height/elevated building parts, every part of one building founded
  on that building's lowest terrain point;
- shaped roofs (gabled, hipped, skillion, pyramidal, dome) built from
  `roof_shape`, with the roof taken out of a building's height and added on
  top of a part's;
- parent/part de-duplication policy, including a building the source
  publishes twice (a plain footprint over an outline that owns the parts);
- bbox clipping, polygon-hole tessellation, invalid-sliver rejection;
- generated-only cleanup and source metadata.

Acceptance test: install in Blender 3.6+, enter a bbox, cache data, and obtain an
editable flat base plus building/part mesh objects at the requested footprint.

## Phase 2 — roads (implemented)

`transportation/segment` and `transportation/connector` are downloaded.
Segments with `subtype == "road"` are kept, plus `subtype == "rail"` behind a
setting. Every centerline is split at the union of all linearly referenced rule
boundaries (`between`) in `road_flags`, `width_rules`, `level_rules`, and
`subclass_rules` before class, width, flags, or level are resolved, so a
partial bridge or a partial width change is never lost.

Footways and cycleways whose resolved `subclass` is `sidewalk`, `crosswalk`,
or `cycle_crossing` are skipped by default (`skip_sidepaths`); the pavement
beside a street is not a route of its own on a miniature.

Road width precedence, as built:

1. active `width_rules[].value`;
2. configurable class default;
3. widened to the printability floor if narrower.

OSM enrichment is not implemented and is not stubbed.

Centerlines are clipped to the metric bounds, simplified relative to their own
resolved width, densified for terrain draping, then buffered with round joins
and caps. A centerline whose corners are too tight, or that doubles back near
itself, is detected in linear time and built instead from overlapping convex
pieces — a rectangle per span plus a disc per vertex — because a folded offset
ring tessellates into an unprintable, non-manifold cap. That case is counted as
`decomposed_ribbons`.

**Deviation from the original plan:** no Shapely preprocessing step was built.
Same-level junctions are not unioned; road solids simply overlap. Each object
is individually watertight, which is what slicers need, and Blender remains the
place to boolean if a single fused manifold is wanted. `external/preprocess_linear.py`
remains unwritten rather than half-written.

Output is batched into one object per road class, not one per feature. A 1-3 km
selection produces on the order of 8,000 subsegments, and an object each makes
the scene unusable long before the geometry does. Since 0.8.0 buildings and
trees are merged the same way by default, into one `BUILDINGS` and one `TREES`
object; `MeshBuilder` never shares vertices between the solids it accumulates,
so a merged object is a set of individually closed shells and two buildings
with a common wall do not weld into a four-faced edge. The per-feature objects
with their source metadata remain available behind a toggle.

## Phase 3 — bridges and overpasses (implemented)

Subsegments whose active `road_flags` or `rail_flags` contain `is_bridge`,
and which are longer than a minimum span, become decks in `BRIDGES`, as does
the run of a surface road that crosses cut-out water (evidence
`crosses_cut_water`). The height solver in `geometry/deck_graph.py` is pure
and unit-tested, and solves the whole network at once:

- every centerline vertex is a node of one graph and pieces meeting at a
  joint share the node, so a fork has one height;
- a deck end where a surface road ends is an anchor, pinned to the road's
  top surface (terrain plus road thickness) so the deck continues the road;
- every node has a floor: terrain plus the printed clearance plus the deck
  thickness, plus a road thickness for a component that passes over a road,
  plus a lower deck's solved top where two decks of different `level` cross
  at a real angle (iterated to a fixed point; parallel decks never stack);
- the deck may not exceed the maximum grade, so the profile is the lower of
  the upper envelope of cones falling from the floors and the lower envelope
  of cones rising from the anchors, each one multi-source Dijkstra pass;
- a component that never rises one printed layer above the road surface is
  demoted to an ordinary road; a recovered water crossing never is.

`level` decides only which of two crossing decks is on top. Supports are
distributed by spacing with both ends excluded, skipped where the deck is
barely above the ground or nothing stands beneath it, and reach 0.1 mm up into
the deck. A deck too tight to offset into one ring is built from overlapping
convex pieces with the profile read at each vertex's nearest centerline point.

**Deviations from the original plan:** `base/infrastructure` is downloaded
for the water cut (piers, quays, breakwaters) but not yet used to recover or
corroborate bridge evidence, and connector topology is downloaded but not yet
used: what a deck crosses is inferred from proximity to road centerlines and
lower decks. Piers are therefore placed by spacing rules alone and are
schematic.

## Phase 4 — water, land cover, vegetation, and DEM terrain (implemented)

Water uses polygon/multipolygon `base/water` only, excluding swimming pools and
fountains. Each body is flat at the median of terrain sampled *inside* it,
rather than draped, so a river stays level. Sampling the outline instead would
read the banks, which are both higher and far more variable than the surface
being solved for.

Water is solved before anything else reads the height field, because the
terrain under each body is then carved down to its solved surface
(hydro-flattening). Without that step, DEM noise over open water — around 2 m
on the sample river — leaves islands of terrain standing above the water and
thin unprintable spikes inside the channel. Only lowering is applied, so a
polygon overlapping a bank cannot flood it.

Overlaps between water bodies are not unioned and bathymetry is not inferred.

Water above the cut threshold is then removed from the terrain solid outright,
which is what makes a river read at a glance without a second material. The
naive version of that cut can only follow whole grid cells, and a cell is
roughly 2 mm across on a city selection — a staircase along the bank next to a
0.45 mm road. `geometry/watermask.py` avoids it by rasterising each polygon by
scanline, once across the rows and once down the columns: that is one pass over
the edges per grid line rather than a point-in-polygon test per node, and the
exact crossing positions fall out of the same pass. `geometry/terrain_mesh.py`
then clips each shoreline cell against those crossings.

The cut is decided before the terrain is built and before roads or piers ask
the height field for ground, so every later stage agrees about where there is
none. The height field keeps the cut outlines as well as the mask, because the
mask's whole-cell answer is too coarse for a road along a bank; the exact test
(`over_open_water`) answers from the mask alone in cells that are wholly wet or
wholly dry and consults the outline only in shore cells.

Ground is then built back under exactly what needs it (`geometry/support.py`).
Every deck over open water gets a causeway following its corridor, every
ground-founded building whose footprint reaches over the water gets a pedestal
of that footprint, and every mapped pier or quay gets the same -- all from the
terrain's own underside up to the ground surface, batched in
`TERRAIN_SUPPORTS`. Registered supports count as ground for every later query,
so piers stand on the causeway. The mask restoration of mapped decks and
building footprints is kept as well; it cannot resolve anything narrower than
a terrain cell, which is what the pedestals are for. Trees are never planted
over open water, and a land slab whose polygon reaches the water is clipped to
the land on the terrain grid by the terrain's own closed-by-construction
routine, with a draped bottom, rather than draped into the opening.

Land surfaces come from `base/land`, `base/land_use`, and `base/land_cover`
through an allowlist in `data/land.py`: an unrecognized class produces no
geometry rather than a guessed surface. Trees come from Overture's individually
mapped `land` tree points plus a deterministic jittered-grid scatter inside
forest and wood polygons, emitted as one merged `TREES` object by default
(every tree its own watertight shell inside it) or, behind the **Merge
Buildings and Trees** toggle, as linked duplicates of one shared mesh.

A guard rejects any surface feature whose own unclipped extent exceeds the
selection by more than a set ratio. This was not in the original plan and was
added because Overture's bbox filter returns intersecting features: a single
`land_cover` forest polygon over the sample bbox measured roughly 500,000 times
the selection area and blanketed the entire model.

**Deviation from the original plan:** the DEM source is the AWS Terrain Tiles
open dataset (`elevation-tiles-prod`, Terrarium encoding), not Copernicus DEM
GLO-30. It is keyless, needs no STAC negotiation, and decodes with the standard
library alone, which keeps the elevation downloader dependency-free. Tiles are
fetched, decoded, and resampled onto a regular grid out of process; Blender
only reads a small float32 grid.

The `TerrainSampler` abstraction is unchanged, and flat mode remains available
offline. Nodata masks are not retained; missing tiles are counted in the grid
header instead.

`geometry/heightfield.py` is the load-bearing addition: the provider is
resampled once, in model millimetres, onto exactly the grid the terrain mesh is
built from, and every other generator interpolates that shared field. Without
it, a road draped on the analytic provider would sink into a hillside the
terrain mesh renders at lower resolution. It also carries the cut mask, for the
same reason: it is already what every generator asks about the ground, and
geometry founded over a hole has no ground to stand on.

The terrain solid is closed by construction rather than by assertion. Top faces
are wound counter-clockwise, the bottom is that same set mirrored at a constant
Z with the winding reversed, and a wall is raised on exactly those top edges
that only one face uses. Two cells sharing a grid edge always agree about it,
because they share both of its nodes and therefore both wetness bits, so the
cut introduces no T-junctions. The base is then placed below the lowest vertex
of the finished surface, not below the lowest height-field value, because the
cut has taken the channel bed away and the shoreline lies between a node and
the bank.

## Watertightness: how a solid is actually closed

Every generated solid goes through one function, `blender/mesh_utils.py`'s
`_prism_geometry`. Five rules there carry the whole watertight promise, and
each exists because of a specific observed failure:

1. **Side walls are derived from the cap's own boundary, never from the ring.**
   A triangulator is free to span a run of nearly collinear vertices however it
   likes, and Blender's does. Densifying a projected outline creates such runs
   constantly, because even a constant-latitude edge curves by a fraction of a
   micron once projected. A wall built from the ring then disagrees with the
   cap above it. Deriving the wall from the cap makes them agree whatever the
   triangulator did.

2. **The result is checked topologically, not by area.** Every edge of a closed
   solid is shared by exactly two faces. An area comparison cannot substitute:
   the observed failure was eleven triangles returned for a fourteen-sided ring
   needing twelve, whose missing sliver was far below any sane area tolerance
   yet was a genuine hole. The count is kept per *direction*, which costs the
   same and answers rule 5 as well.

3. **Ear clipping is the fallback.** When Blender's triangulator returns
   something that will not close, a ring without holes is retried with ear
   clipping, which uses every vertex and cannot overlap itself. This matters
   for draped surfaces specifically: the densified vertices Blender wants to
   optimise away are exactly where the slab samples the terrain. Rings with
   holes stay on Blender's triangulator, which reaches an inner ring through a
   deliberately degenerate channel that ear clipping does not build.

4. **Draped caps are refined by edge length, not per triangle.** A cap
   triangulated from its outline alone is a flat sheet between outline
   vertices, which on a hillside leaves the ground by whatever the hill curves
   in between. `refine_triangles` splits every edge longer than the drape
   spacing at its midpoint and drapes the new vertex; because the rule is a
   property of the edge, the two triangles either side of it always agree and
   no T-junction can appear, while an outline edge only ever splits into
   outline edges, so the walls raised on single-use edges are untouched.
   Zero-area cap triangles (collinear densified vertices) are refined like
   any other so their neighbours stay consistent; they carry no volume, and
   Blender's float32 storage may flip their winding, which is why a probe
   comparing face normals against the terrain must skip faces without area.

5. **Winding is settled by propagation when the per-triangle sign cannot be
   trusted.** Each cap triangle is wound from the sign of its own area in XY,
   and each wall takes the direction the cap handed it. That is exact until a
   cap triangle has no area: a ring that touches itself, or one the rectangle
   clip pinched into a zero-width corridor, produces slivers whose sign is
   float noise, and the full-size walls raised on their edges inherit it and
   face inward. Rule 2 cannot see this, because an undirected edge count is
   two either way. So when any *directed* edge is used twice,
   `planar.orient_faces_outward` re-derives the orientation by walking from
   face to neighbouring face — neighbours must cross a shared edge in
   opposite directions, which pins a sliver against its full-size neighbours
   — and flips each edge-connected component whole if it comes out enclosing
   a negative volume. On the sample this repaired 107 shells of 25,033
   (1,366 faces) without changing a single polygon.

Anything that still fails both paths is rejected and counted. It is never
emitted half-closed.

## Phase 5 — printability cleanup (not started)

- configurable minimum printable feature/edge size;
- part-volume overlap cleanup and optional union;
- coplanar-face detection;
- road/base union modes;
- non-manifold and thin-wall reporting;
- object batching option for dense selections, trading per-feature object
  metadata for viewport/export performance;
- roof shapes beyond gabled, hipped, skillion, pyramidal, and dome.

Each phase extends the established interfaces and collection contract instead
of replacing the working download, transform, cache, or building pipeline.

