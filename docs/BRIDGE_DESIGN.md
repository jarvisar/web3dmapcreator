# Bridge and overpass generation

Bridge geometry is implemented. This document is both the design and a record
of what was and was not built; each section marks its own status.

The height solver is pure and lives in `geometry/deck_graph.py`; profile
walking helpers are in `geometry/deck_profile.py`; mesh construction is in
`geometry/bridges.py`. The solver has unit tests covering joints, cones,
anchoring, road-crossing lift, stacking, and demotion.

## Detection and segmentation

Steps 1-5 are implemented. Step 6 is not.

1. Download transportation `segment` and `connector`, plus base
   `infrastructure`, for the bbox.
2. Keep road segments (`subtype == "road"`), plus `rail` behind a setting.
   Only `is_tunnel` is currently excluded; abandoned and construction-only
   filtering is not implemented.
3. Split each centerline at every boundary from scoped `road_flags`,
   `rail_flags`, `width_rules`, `level_rules`, and subclass rules. Rail is
   split by the same routine as road, under one `rail` class and one width;
   before `rail_flags` were read, a railway bridge over the river was draped
   straight into the water.
4. Mark a subsegment as a primary bridge candidate when its active road or
   rail flags contain `is_bridge`. The evidence is recorded per deck
   (`road_flags.is_bridge`, `rail_flags.is_bridge`).
5. A surface subsegment whose centerline stands over *cut-out water* for at
   least the minimum span length is a crossing whatever its flags say: the run
   over open water, extended a few metres onto each bank so the deck starts
   where an abutment would, is split off and elevated with evidence
   `crosses_cut_water`. The test is exact against the printed shoreline, not
   per terrain cell, because a road along a riverbank sits in shore cells for
   its whole length. Shorter runs are mapping slop and stay surface roads,
   draped to the nearest surviving land's grade. Recovery from nearby
   `base/infrastructure` bridge outlines is still not built.
6. **Not implemented, and not stubbed.** Optionally resolve OSM source IDs for
   tags unavailable on transportation segments.

## Deck geometry

Implemented. The centerline subsegment is offset by half the resolved deck
width, which comes from active `width_rules` and otherwise the road class
default, clamped to the same printable range as a road. The polygon is
extruded downward by the deck thickness, producing a closed mesh in `BRIDGES`.
The deck is as thick as a road by default (0.6 mm, three layers), so a bridge
continues the road it carries with the same number of printed layers.

A deck whose centerline is too tight to offset into one simple ring -- an
interchange loop ramp, typically -- is built from overlapping convex pieces
instead, exactly as a tight surface road is, with every ring vertex taking
the profile height at its nearest point on the centerline. It used to be built
from disjoint per-span slabs, which left a wedge missing on the outside of
every bend where a pier could stand under nothing.

## Heights: one solve for the whole network

Implemented, replacing the single-span solver. Overture splits an interchange
into dozens of short flagged pieces that meet at forks and merge into each
other; on the sample city 212 of 233 pieces stood alone and 39 joints were
forks. Solving each piece or chain on its own gave every joint whatever height
each side happened to reach, anchored forks to the ground under them, lifted
decks by a multiple of their `level` tag, and humped them to three times the
clearance: motorway ramps four millimetres in the air over a one-millimetre
city, with the deck ends pinned 0.6 mm *below* the road surface they
continued.

Every vertex of every deck centerline is now a node of one graph; pieces
meeting at a joint share the node, so a fork is a node with three edges and
gets one height. Three ingredients decide the profile:

- **Anchors.** A joint where an ordinary surface road ends is where the deck
  comes down to the ground. Its height is pinned to the road surface there
  (terrain plus road thickness), so the deck continues the road without a
  step. A deck end that nothing continues -- a skywalk into a building, a
  ramp whose approach was not mapped, a footbridge landing three metres from
  the path it serves -- touches down the same way, because nothing in the
  model holds it up: left free, such an end hung at floor height, and on the
  sample city 63 of 72 loose ends were exactly that, most of them downtown
  skywalks printing as boxes in the air on a pier. A short piece anchored to
  the ground at both ends cannot climb a layer and is built as a path on the
  ground instead. The one exception is an end on the selection rectangle,
  where the bridge is cut off by the bbox rather than by the data; it keeps
  its solved height so the viaduct runs out to the edge of the model.
- **Floors.** The lowest a deck top may be at each node: the terrain, plus the
  printed **clearance** (0.4 mm, two layers of daylight), plus the deck's own
  thickness. A connected component that passes over any surface road is lifted
  by one road thickness more, because it has to clear the road's *top*; the
  road that continues the deck at its anchor does not count. A deck that
  crosses a lower-`level` deck at a real angle gets, at the crossing, the
  lower deck's solved top plus clearance and thickness, iterated to a fixed
  point. Parallel decks never stack each other: the two carriageways of the
  Brent Spence Bridge carry level tags that swap between pieces, and treating
  a parallel neighbour as "the deck below" lifted each carriageway by the
  other, a millimetre a round, until the bridge stood five millimetres over
  the river.
- **Grade.** The deck may not rise or fall faster than the **maximum deck
  grade** (8 %).

The lowest profile that respects the floors and the grade is the upper
envelope of cones falling away from every floor value at the grade, computed
as one multi-source shortest-path pass over the graph. The highest profile
the anchors allow is the lower envelope of cones rising from the anchors. The
deck takes the smaller of the two at every node: it is as low as it can be,
meets every anchor exactly, and a piece too short to reach its floor at the
grade simply humps as high as the grade lets it. A component that never rises
one printed layer above the road surface (**minimum bridge lift**, 0.2 mm)
would print as a bump rather than a bridge, and is built as an ordinary road
instead; the count is `bridge_decks_demoted`, broken down by class and
evidence in `bridge_demoted_by_class`. A crossing recovered from the water is
never demoted, because built as a road it would hang in the opening.

Over the cut river the floor is the flattened water level plus clearance and
thickness, which the bank anchors usually already satisfy, so river bridges
run level at the bank road's height and the causeway below them stays at the
water level. A `level` tag decides only *which* of two crossing decks is on
top; it no longer scales any height.

Remaining simplifications:

- what a deck crosses is inferred from proximity to surface road centerlines
  and to lower decks; it does not read `connector` topology, so a road that
  merely runs alongside a viaduct within a road width also lifts it;
- a deck component's road lift is uniform along the component, so a long
  viaduct that crosses one street is lifted over its whole length rather than
  dipping between crossings;
- adjacent road and deck endpoints do **not** share vertices. They meet
  because the deck's end is pinned to the road surface derived from the same
  height field, not because continuity is enforced.

## Ground under a deck over cut water

Cutting the river out of the terrain takes the ground from under every deck
that crosses it. The deck is not extended down to the plate -- that would print
a bridge as a tall wall of terrain-coloured plastic and defeat the point of the
opening. Instead the terrain is built back under the deck only: a **causeway**,
the deck's corridor buffered by half its width plus a small margin, from the
terrain's own underside up to the ground surface the height field describes
(the flattened water level inside the river, rising onto the bank where the
strip overlaps it). The corridor is the run of the deck centerline over open
water, found on a finely sampled copy of the centerline and extended onto the
land at both ends so it overlaps the bank solidly, then simplified at its own
half-width so a sidewalk's metre-scale jog cannot fold the offset ring.

Every support is a separate watertight solid in `TERRAIN_SUPPORTS`; overlaps
with the bank and with each other union in the slicer. Its top sits 0.05 mm
below the height field so it never shares a face with the terrain it overlaps.
The same builder makes pedestals under buildings and mapped piers, so a river
crossing, a boathouse, and a floating dock are all handled by one mechanism
(`geometry/support.py`). Registered support footprints count as ground for
every later query, which is how piers know they can come down onto the strip.

## Supports

**Not implemented:** explicit infrastructure with `class == "bridge_support"`
is not consulted, so no support is ever recovered from source data.

The implemented placement is the derived fallback:

1. omit supports below the configurable short-span threshold;
2. reserve exclusion distances from both span ends/shore intersections;
3. distribute candidates approximately at the requested real-world spacing;
4. **not implemented** — shift/reject candidates near connector-based
   intersections;
5. **not implemented** — reject candidates whose footprint overlaps a building;
6. construct a simple rectangular pier, aligned with the deck, from the deck
   underside down into the shared terrain height field, skipping any station
   where the deck is barely above the ground, and skipping any station with no
   ground beneath it at all -- which, now that decks over the river stand on a
   causeway, means only the bank cells the strip does not reach.

A pier's top is pushed 0.1 mm up into the deck it carries. The deck's underside
between two ring vertices is a straight line while the pier reads the
centerline's own profile, and on a tight curve the two differ by a few
hundredths; measured with rays on the sample city, every pier now ends inside
its deck rather than a hairline below it.

Supports are intentionally schematic. They must be watertight, above the
minimum printable cross-section -- both plan dimensions are held at or above
**Minimum Pier Size**, 0.6 mm by default, because a footbridge deck at the
minimum ribbon width would otherwise get piers a fraction of a nozzle across
-- and live only in `BRIDGE_SUPPORTS`. No railings, lamps, trusses, or
photorealistic details are planned. The sample bbox's `base/infrastructure`
does carry `bridge:structure` tags (suspension, arch, truss) on its named river
bridges; using them for towers and arches is a possible next step, not a
current feature.

## Failure and audit behavior

Ambiguous spans remain ordinary roads rather than being silently elevated: a
subsegment is only a deck if it carries an active `is_bridge` flag and exceeds
the minimum span length, or crosses cut-out water, and it is only *built* as a
deck if its network can rise a printed layer.

Because decks are batched by road class rather than emitted per feature, the
audit trail currently lives on the batched object (`feature_type`,
`road_class`, `bridge_evidence`, `source`) and in the root collection's
generation counts (`bridge_components`, `bridge_anchored_ends`,
`bridge_road_crossing_components`, `bridge_stacked_crossings`,
`bridge_decks_demoted`, `bridge_demoted_by_class`), rather than per individual
deck. Per-deck provenance — `overture_id`, source OSM ID, resolved width
source, level, support-placement source, and endpoint elevations — is not
retained, and is the main thing to restore if per-feature bridge auditing
becomes necessary.
