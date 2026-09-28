# How It Works

Technical reference for how each layer is built. For installation and everyday
use, see the [README](../README.md) and the [user guide](USER_GUIDE.md).

## How the pieces fit together

Everything is aligned to **one shared terrain height field**. The elevation
provider is resampled once, in model millimetres, onto exactly the grid the
terrain mesh is built from. Roads, water, parks, trees, and building
foundations then interpolate that same field. This is why a road does not sink
into a hillside the terrain mesh renders differently: they are reading the same
numbers, not two different approximations of the same hill.

Feature-specific vertical behavior:

| Feature | Vertical rule |
|---|---|
| Land cover, roads | Draped: the outline *and the interior* follow the terrain, 0.15 mm below it and a fixed height above it (0.4 mm for land cover, 0.6 mm for roads), so the slab fuses with the ground in a slicer without burying its colour in the hill |
| Water | Level per feature, at the median of the terrain sampled *inside* it. Bodies above the cut threshold are removed from the terrain entirely; the optional slab then fills the opening from the model's underside up to that level |
| Buildings | Heights are measured from the **lowest** terrain point under the footprint, so no corner floats on a slope, and every part of one building shares that building's base, so parts of equal height end level with each other. The underside itself follows the terrain 0.15 mm below it, so the walls are as tall as the slope makes them but nothing is hidden deeper in the hill |
| Roofs | Explicit total heights include the roof for buildings and parts; floor-derived walls receive the roof once, with a narrow parent-corroborated legacy crown exception |
| Bridges | Every deck vertex is a node of one graph. A deck's top is pinned to the road surface where a surface road ends, kept at least a printed gap plus its own thickness above the terrain (plus a road thickness where it passes over a road, plus a lower deck's top where it crosses one), and never steeper than the maximum grade |
| Ground supports | From the terrain's own underside up to the ground surface, over exactly the footprint of the bridge corridor, building, or pier that needs it |
| Trees | Placed on the terrain surface, scaled up for printability; never planted in cut-out water |

## Data sources

Overture Maps supplies buildings, building parts, transportation segments,
water, land, land use, land cover, and infrastructure (piers, quays,
breakwaters) through the official Python client. The release identifier is
recorded in each cache manifest. A cache made before infrastructure was part of
the set still generates; **Download / Cache Data** fetches only what is missing.

Elevation comes from the public, keyless **AWS Terrain Tiles** open dataset
(`elevation-tiles-prod`), decoded from its Terrarium RGB encoding. These are
orthometric (sea-level) heights, not WGS84 ellipsoid heights. Because the grid
is normalized against its own minimum, that datum difference is a constant that
cancels out of a relative miniature; the offset is recorded in the grid header
rather than silently discarded.

Overture content derived from OpenStreetMap carries ODbL attribution
obligations. Confirm the current Overture and AWS Terrain Tiles license terms
for your intended use — this project does not restate them, and does not
redistribute either dataset.

## Behavior and limitations


**Height resolution** is deterministic:

1. Overture `height`;
2. otherwise `num_floors * Floor Height`;
3. otherwise a class-specific default, then `Default Building Height`.

Bottom elevation uses `min_height`, then `min_floor * Floor Height`, then zero.
The top is `terrain + height`; `min_height` is the underside, not an extra
height. Explicit totals include roofs, for buildings and parts. Inverted
intervals are reported and skipped instead of inventing a taller top.
Missing heights are never randomized.

**Optional LiDAR buildings.** Install `requirements-lidar.txt`
in the existing external downloader environment, cache buildings normally,
then use **Buildings > LiDAR Buildings > Prepare LiDAR Buildings** and
**Generate Model**. The default **Roof Envelope** drapes a continuous upper
surface over the LiDAR returns, spanning narrow facade recesses while retaining
broad curves and supported roof caps inside the mapped footprint. Keep **Generate
Roof Shapes** enabled for measured slopes. **Prefer LiDAR on Conflicts** is on
by default: use a usable measured envelope even when source heights, floor
counts, construction dates, other surveys or mapped roof detail disagree.
Turn it off to restore conservative source-height and capture-age checks.
OSM/Overture still supplies footprints, identity, tags and fallback geometry;
measurements from different surveys are never combined. Invalid, sparse or
unbuildable measurements still fall back. Incomplete source roof assemblies
can receive a measured main mass and corrected part heights while keeping
their mapped shapes. Neighboring roof edges do not determine a part's height.
Roof Envelope adapts to the output scale and replaces the former Detailed
Surfaces mode. After updating from that mode, Prepare again with Refresh off
to reuse cached points and tiles. The optional **Terraces** mode retains the
**0.1 mm width / 0.05 mm step** defaults; those controls apply only to Terraces.
Minimum Building Height lifts measured roofs together, preserving their shape.
Preparation runs in the background;
Esc cancels and the next preparation resumes completed work. Small building
batches replace the old whole-map point, area, download and time caps. Larger
selections require more time and disk space. Preparation and generation counts
appear in Buildings. Overlapping surveys are compared using supported roof detail,
coverage and capture age.
Automatic discovery includes USGS EPT/TNM, Open LiDAR Data / Flai COPC and
OpenTopography's public point-cloud catalog. **STAC Catalog URLs** adds public
STAC APIs or static catalogs. EPT and COPC stream the required bounds automatically;
ordinary LAS/LAZ files require **Download and Use Offered Tiles**. Offers identify
meaningful coverage gaps or substantial upgrades, with dataset metadata, reasons,
areas and known sizes. Good streamed coverage stays unless you choose a worthwhile
upgrade. Same-survey duplicates are reserved for actual delivery failures.
All sources use the existing building measurement and generation pipeline.

Leave **EPT / COPC URL** empty for discovery, or supply one streaming asset to
override the provider set. **International LiDAR Discovery** can be disabled to
retain only USGS plus any configured STAC catalogs. **LAZ Manifest URL** retains
USGS catalog matching; unlocated URLs are skipped without fetching LAS headers.

Keep **Missing Z Units** at **Require Metadata** unless source documentation
establishes a fallback unit. Some Flai deliveries lack vertical units; their CRS
alone does not establish Z units. Metre, international-foot and US-survey-foot
fallbacks are available. Explicit header units always take precedence. Unknown
classification conventions are skipped unless metadata supplies a semantic mapping.
Building heights use same-survey ground subtraction; datums from different surveys
or the terrain DEM are never mixed. Broken providers do not block map generation.
See [international discovery and supported metadata](LIDAR_DISCOVERY.md).

Consistency skips now report roof coverage, ground inside footprints and outside
roofs separately. Boundary cells count only their tested area, reducing false
rejections without lowering the coverage or point-support requirements.
Direct official sources now include IGN France and NRCan Canada COPC, England's
Environment Agency, Scotland's National LiDAR programme, NRW, Bavaria and regional
PNOA delivery in Castilla-La Mancha. Coverage is regional/project-specific;
Flai and OpenTopography remain available to fill gaps. See the
[coverage table and access limitations](LIDAR_OFFICIAL_SOURCES.md).

After upgrading to 0.17.0, or changing sources, units, conflict preference or
detail settings, **Prepare LiDAR Buildings again**; downloaded tiles are reused.
Existing scenes retain explicitly saved detail values; set width/step to
0.1/0.05 mm to use the new defaults.
See [LiDAR setup, height diagnosis,
validation and limits](LIDAR_BUILDINGS.md).

**Buildings are boosted 10% on Z by default.** **Building Height Scale**
(default 1.1) multiplies every mass's height above its own terrain base, so
the massing reads clearly over the 0.6 mm road ribbons. Footprints, roads,
terrain, trees, and the print scale itself do not move, and a building's parts
are scaled with it, so parts still sit inside their parent and equal-height
masses still end level. The recorded `height_m` metadata stays the source
value; the multiplier is reported once as `building_height_scale`. Two side
effects on the sample bbox, both from measuring the *printed* mass: 73 more
roofs clear the 0.15 mm minimum and get their real shape (320 shaped, was
247), and 34 more sub-nozzle needles fail the slenderness test (144, was 110)
-- masses already under 0.45 mm wide, which the scale makes 10% more slender.
Set it to 1.0 for true scale.

**A qualifying building prints at least 0.8 mm tall.** Roads stand 0.6 mm
over the ground, so a two-storey building at true scale barely clears them and
prints as a plate. **Minimum Building Height** is a floor on that clearance: a
mass shorter than it is stretched upwards -- walls only, so a shaped roof keeps
its pitch -- until its top clears the *highest* terrain under its footprint by
exactly the minimum. Measuring from the highest, not the lowest, is what makes
the guarantee hold on the uphill side of a slope; for a building with parts the
figure is taken over the whole building, so sibling parts are stretched by the
same amount and their tops stay level.

**Only footprints over the threshold are stretched.** **Raise Only Footprints
Over** (0.6 mm, about 8.6 m square at print scale) demands two things of a
footprint: it covers at least that square, and it is not a ribbon of that area
-- a square of side S has an effective width of S/2, so anything thinner is a
wall fragment, a covered walkway or a row of garages mapped as one strip.
Stretching one of those is what would produce a fin. On the sample bbox 5,504
buildings and 212 parts are raised of 10,823 masses, by a median 0.36 mm and at
most 2.03 mm, and every raised mass ends exactly at the minimum. The threshold
is worth tuning to the city: at 0.4 mm 8,765 masses are raised, at 1.0 mm only
1,023, and at 1.5 mm 422. Set **Minimum Building Height** to 0 to switch the
floor off entirely. Counts are `buildings_raised_to_minimum` and
`building_parts_raised_to_minimum`, and each unmerged object records its own
`minimum_height_lift_mm`.

**Sidewalks and crossings are left out by default.** Overture maps the
pavement beside a street and the crossing at each corner as footways and
cycleways of their own, carrying `subclass` `sidewalk`, `crosswalk`, or
`cycle_crossing`. On a miniature they triple the ribbons along every downtown
street without adding a route that was not already there. **Skip Sidewalks and
Crossings** drops exactly those; footways with no such subclass -- park paths,
trails, footbridges -- stay, and steps are untouched. The count is
`skipped_sidepaths`. The network tidy below then repairs what that leaves: a
park path that used to join a sidewalk is pulled onto the street instead.

**The road network is tidied before it is widened.** Overture hands over both
carriageways of a divided street, the cycle track laid along it, footways that
are sidewalks in all but tag, and every fragment of a street that was split at
a tag change. Buffered one by one those print as a double-wide ribbon with a
lens-shaped seam where the two overlap, and as ribbons too close together for
a strip of terrain to print between them. **Tidy Road Network** (off by
default) ranks every piece by class -- motorway down to footway, rail between
the streets and the service roads -- welds pieces that meet end to end into
routes, and drops a route that runs close to *and* parallel with a more
important route already kept. "Close" is measured between the printed edges:
**Minimum Road Gap** (0.4 mm, one nozzle line) is the narrowest strip of ground
allowed between two ribbons running alongside each other. A less important
road never removes a more important one. A street loses only what is actually
doubled: the losing carriageway of a divided street goes block by block while
the stem through each intersection stays, and a stretch that parts from the
road that doubled it -- a ramp curving away, carriageways splitting round an
island, a road carrying on past its partner's end -- stays on its own path and
tapers back into the kept road where it was cut. Footways, cycleways, paths and
tracks lose only their shadowed sections, so a cycle track that follows a
street and then turns into a park keeps the park.

The tidy repairs only what removal broke. It knows which ends met something in
the source -- sidewalks and crossings included -- and which were real dead ends.
An end whose partner was removed (a park path that ended on a dropped
sidewalk) is joined to a street within twice the gap of its edge; a real dead
end, such as a cul-de-sac or a driveway stopping short of the next street, is
only joined when the ground left would be thinner than the gap itself. A join
adds a short connector or tapers the end in; it never tilts the existing line.
Short fragments left leading nowhere by removal -- the kerb stubs of dropped
crossings, the leg of a trimmed path that stops inside the corridor of the
next street -- are removed, while short spurs that are real dead ends stay
unless they show less than their own width past the road. A fragment that
another route's end rests on, or whose loose end nearly reaches another
route, is never removed, so pruning closes gaps rather than opening them.
Specks that touch nothing at all -- a flight of steps between two dropped
sidewalks -- go when shorter than 1.4 mm in total. Bridge decks and the
ground under them never shadow each other, and deck ends are never moved.
The counts are `network_culled_pieces`, `network_trimmed_pieces`,
`network_culled_length_mm`, `network_snapped_ends`, `network_pruned_stubs`,
`network_pruned_nubs`, `network_pruned_islands` and `network_welded_joins`.
Turning the toggle off restores the untidied network exactly.

**Airports print with the roads.** Runways, stopways, taxiways and taxilanes
from Overture's `infrastructure` layer are mapped as centerlines; each is
widened by its mapped width (or 45 m for runways, 23 m for taxiways, 15 m for
taxilanes) into an area, square-ended for runways. Aprons and helipads are
used as mapped. All of them are built road-thick over their whole area in one
object of their own, road class `airport` (exported as "Roads (Airport)"), so
land cover is cut from beneath them and trees avoid them like any ground road.
The airport grounds polygon itself is not paved. The count is
`airport_surfaces`.

**Roads are widened to stay printable.** Below **Minimum Road Width**, a class
is widened to that floor. At the default 0.07 mm/m that floor is 6.4 m of real
road, so only service roads and narrower are affected. At coarser scales the
floor swallows more classes, and the panel states what it currently means.

**Unprintable building masses are dropped.** Overture publishes chimneys,
spires, and wall fragments as masses in their own right. On the sample bbox,
123 of them extrude into needles as narrow as 0.02 mm and up to 5 mm tall —
the shards that read as glitched geometry in the viewport. Two filters remove
them: **Minimum Building Width** measures a footprint's narrow dimension as
twice its area over its perimeter, which is what tells a 2 m x 60 m wall from a
small house of the same area, and **Maximum Building Slenderness** drops a mass
taller than a set multiple of that width. The slenderness test only applies
below **Always Keep Wider Than** (0.45 mm, one nozzle line): a mass that wide
prints whatever its height, and on the sample bbox the only such masses the
filter had been dropping were Carew Tower's shaft and two wings of the Great
American Tower. Both counts are reported as `rejected_too_narrow` and
`rejected_too_slender`.

**Roofs follow the source shape.** `roof_shape` is built for `gabled`
(`saltbox` and `round` are treated the same), `hipped` (with `half-hipped`,
`mansard`, `gambrel`), `skillion`, `pyramidal` (and `cone`), and `dome` (and
`onion`); everything else stays a flat extrusion and the object says so in
`roof_geometry`. A gable or hip is split into the planar regions of the roof
and built as one prism per region, all or none; a pyramid or dome is a single
closed solid rising to an apex; a skillion is a prism with a sloping top along
`roof_direction`, which is the compass bearing the roof slopes *down* towards
(checked against the eight facets of a tower crown, whose directions all point
away from its centre). A roof shorter than 0.15 mm at print scale is left flat
and counted as `roofs_below_minimum`. Where the roof sits relative to
`height` follows the same total-height rule for buildings and parts. The
legacy additive reading survives only when the roof cannot fit inside its
part interval and the parent total corroborates the sum, as with Great
American Tower's 162.7 + 40 = 202.7 m crown. This fixes double-counted part
roofs, including a Chicago part inflated from 177.4 to 250.4 m. A shaped roof with no
`roof_height` gets an ordinary pitch recorded as `roof_height_source =
default`.

**Trees have compact, three-tier foliage and no trunk.** Their broad bases embed
directly in terrain, even beneath raised land surfaces or roads. Each tree is one
closed low-poly solid; the tiers have sloped undersides for FDM printing.
Under **Trees**, **Minimum Tree Width** (1.1 mm across flats)
and **Minimum Tree Height** (1.6 mm) apply independently after **Size Variation**
(18%). **Tree Spacing** defaults to 26 m for forests. All tree sources share a
0.2 mm gap between finished crowns, with mapped trees placed first, so overlapping
forest polygons cannot stack trees on top of one another. Pointed tips and small
tier notches may soften when sliced at 0.2 mm layers. Regenerate to apply changes;
saved scenes retain explicitly stored settings, which can be reset in this panel.

**Regional source polygons are rejected.** Overture's bbox filter returns every
feature that *intersects* the selection, including continental ones — a single
`land_cover` forest polygon over the sample bbox measured roughly 500,000 times
the selection area. Any surface feature whose own unclipped extent is more than
8x the selection is skipped and counted, rather than draped over the whole
model. With that guard in place, coarse `land_cover` forest is planted with
trees by default (**Scatter in Satellite Forest**); on the sample bbox it adds
about 1,900 trees to hillsides no mapped forest polygon covers.

**Terrain under water is modified.** An elevation dataset reports open water as
a noisy near-flat plateau; over the sample river that noise was about 2 m tall
and left 7% of the channel standing above the water surface. Where a source
polygon says "this is water", the terrain beneath it is carved down to the
solved level. For ordinary water only lowering is applied, so a polygon that
slightly overlaps a bank does not flood it. Water cut out of the terrain is
set to its level both ways: some elevation data carries bathymetry (San
Francisco Bay's median is its seabed, about 20 m below the piers), so a cut
body is never solved below the lowest tenth of its connected shoreline, and
its grid nodes are raised to that level. The shoreline then stays at the bank
instead of interpolating down into the seabed. The number of grid nodes
changed is reported as `terrain_nodes_flattened_to_water`.

**Open water is cut out of the terrain, not covered over.** A body larger than
the cut threshold (0.5 ha by default) is removed from the terrain solid, so the
river reads as an opening. The bank is not a staircase along cell boundaries:
the shoreline's exact crossing of each grid line is recorded when the polygon
is rasterised, and every cell the shore passes through is clipped against it.
Overlapping water polygons are combined before choosing those crossings, so
an edge inside another water body cannot leave a false strip of terrain.
**Ponds, fountains and mapped water basins recess by default.**
All recessed fills share a separate `WATER_RECESSED` object, while other water
remains in `WATER_SURFACE`. Both are in the `WATER` collection and can be
selected, hidden or deleted independently.

Under Water →
Ponds, Fountains and Basins, enable/disable the mode and set recess depth (1.0 mm) and
water thickness (0.8 mm). The water top is therefore 0.2 mm below the lowest
sampled local bank. Water stays level; higher banks have a larger drop. The
terrain retains a solid floor, and natural land-cover surfaces are excluded from the
basin. Turning Water off leaves the empty recess; disabling basin mode restores
the previous behavior. Mapped pond/fountain/water-basin polygons qualify, including
OSM tags retained by the importer. Small polygons mapped only as generic water
also recess when their full source area is below 5,000 m². Explicit rivers,
lakes and reservoirs keep their existing handling; a small viewport does not
reclassify a large water feature. Other water keeps the existing cut/slab
thresholds, and swimming pools remain excluded. **Skip Ponds, Fountains and
Basins** instead leaves those same waters out of the model entirely: no recess,
cut, fill, surface exclusion or support. It overrides the recess.

With **Keep Ground Under Structures** enabled, buildings and roads/paths over
recessed water stay at the surrounding terrain grade, with terrain foundations
under their footprints. This prevents paths from dipping at the bank and
buildings from sinking into the water.

All water footprints clear overlapping forest, green, sand and rock surfaces,
even when the slab sits above the water. The cut follows the water outline and
preserves islands, including for small ordinary water bodies and with recessing
disabled. Paving remains on terrain supports when **Keep Ground Under Structures**
is enabled; it is cut away when supports are disabled. Natural land-cover surfaces
never receive these supports.

Non-bridge foundations rise at least 0.2 mm above retained water, and buildings,
roads and paving sit on the same raised grade. Cut water sits 0.25 mm below the
bank it is flattened to, so over a cut that grade is the bank itself: structures
at the shore sit on the terrain rather than on pedestals raised above it, and
ground already kept for a pier or boathouse needs no second solid. Bridge
causeways over cut water are lowered just under its surface, so bridges still
look like crossings and keep their foundations when the water fill is hidden.

**Ground is kept under anything the cut leaves standing over the opening.**
Removing the river also removes the ground under every bridge that crosses it,
every dock and boathouse mapped inside it, and every mapped pier. Extending
those down to the build plate would print a bridge as a tall wall in the wrong
colour, so the generator does the opposite: it builds the terrain back, but
only under the structure. Each bridge deck standing over open water gets a
**causeway** -- a strip of terrain following the deck, the deck's width plus a
small margin (**Causeway Margin**) -- and its piers come down onto that strip
at the water level, as a real bridge model has them. Each ground-founded
building whose footprint reaches over the water gets a pedestal of exactly its
own footprint, and mapped piers and quays get the same. Every support runs from
the terrain's own underside to the ground surface, so it shares the model's
base; the rest of the water stays open. Supports are batched into one object
in `TERRAIN_SUPPORTS`, in the terrain material, and are counted per kind as
`terrain_support_kinds`. **Keep Ground Under Structures** turns them off, in
which case piers over the opening are dropped as before.

Support candidates are checked against the surviving terrain and supports
already built, so a dry quay or a deck fully restored by the terrain grid does
not get a redundant pedestal. Required supports keep their exact footprints;
their caps are sampled across the interior as well as the outline, using the
same draping refinement as roads and land slabs. This prevents a broad support
from spanning over a terrain hollow and protruding through the ground. The
existing small embed below the terrain is retained to avoid coincident faces
where a necessary support meets the bank. Skipped candidates are reported as
`terrain_supports_already_grounded`.

Marina and harbor facility boundaries can include open water; they do not
restore terrain or create supports. Their separately mapped physical piers,
quays, and breakwaters still keep their ground. See the
[water cutout investigation](WATER_CUTOUTS.md) for the source comparison
and regression checks behind this behavior.

**Bridges are solved as one network.** Overture splits an interchange into
dozens of short flagged pieces that meet at forks and merge back into each
other, and splits a river bridge mid-span. Solved one piece at a time, every
joint took whatever height each side happened to reach, forks were anchored to
the ground under them, and a tag-driven lift with a sine hump put motorway
ramps four millimetres over a one-millimetre city, with each deck end pinned
0.6 mm *below* the road surface it continued. Now every deck vertex is a node
of one graph, pieces meeting at a joint share the node, and the whole network
is solved at once. A deck end where a surface road ends is pinned to that
road's surface, so the bridge continues the road without a step. A deck end
that nothing continues at all -- a skywalk into a building, a ramp whose
approach was never mapped, a footbridge landing a few metres from its path --
touches down the same way rather than hanging at floor height, and a stub too
short to climb a layer from there is built as a path on the ground; only an
end on the selection edge, where the bbox cut the bridge off, keeps its
height. The general network solver requests **Bridge Clearance**
(0.4 mm, two layers of daylight) plus the
deck's thickness above the terrain, plus one road thickness when the deck
passes over a road, plus a lower deck's top where it crosses one at a real
angle, subject to the approaches and **Maximum Deck Grade** (8 %).
A network
that never rises **Minimum Bridge Lift** (0.2 mm, one layer) above the road
surface is built as an ordinary road, counted in `bridge_decks_demoted`. Decks
are as thick as roads (0.6 mm), and piers reach 0.1 mm up into the deck they
carry so none stops a hairline short. A road that crosses cut-out water with no
bridge flag at all has that crossing recovered as a deck, recorded as
`bridge_evidence: crosses_cut_water`, and is never demoted; a run shorter than
the minimum span is mapping slop along a bank and stays a surface road, draped
to the bank's grade rather than dipping to the water. Railway bridges come
from `rail_flags`, which the road-only reader used to ignore.

Short, simple bridges use the available approach length to choose their height.
If the connected span cannot gain the usual road clearance at the configured
grade, it starts with a straight profile between its bank/approach heights.
Terrain and actual crossing roads can raise that profile; a parallel road or
bare ground alone does not add a hump. Long, branched, stacked and boundary-cut
overpasses retain their existing height policy.

Pier spacing also limits the unsupported run between ground contact and actual
piers. Short end exclusions or a gap below **Minimum Pier Height** no longer
leave a long section unsupported: an extra pier, or a full-width low abutment,
fills an excessive gap where there is a foundation. Added supports avoid road,
rail and lower-deck openings. Existing piers retain their positions. Where no
clear foundation is available, the gap remains open; this is not a guarantee
that every bridge can be printed without slicer supports.

**Surface types do not overlap.** The default order is **paved > sand > rock >
greens > forest**. In **Parks and Land Cover > Surface Priority**, use the up/down
arrows to reorder the five categories; the top entry wins. The order is saved
with the scene and applied when you click **Generate Model**. Higher-priority
footprints are removed through the full thickness of lower-priority slabs,
preserving their terrain slopes and polygon holes. Ground roads retain their
existing priority over all land surfaces.

**Land cover stops at the water.** A slab polygon that runs out over cut water
-- typically coarse satellite forest along a riverbank, or a riverside park
mapped out to the state line mid-river -- would drape into the opening as a
sheet at water level. Such a polygon is instead clipped to the land on the
terrain grid, by the same closed-by-construction routine that cuts the terrain
itself, with a bottom that follows the ground. Its outline then has the
resolution of the riverbank rather than of its own vertices, which for a
satellite polygon is no loss; polygons that never reach the water, along their
edge or anywhere inside, are draped exactly as before. Where the slab's own
outline and the shoreline cross the same grid line, the slab ends at whichever
comes first from the land, so it never reaches out over the opening. The count
is `land_surfaces_clipped_to_land`.

**Ground roads take priority over land cover.** Generated road footprints cut
full-depth openings in grass, parks, forest floors, plazas, sand and rock slabs.
The openings follow the actual road mesh, including bends, junctions and end
caps, with 0.005 mm of clearance per XY axis (at most 0.0071 mm diagonally).
The terrain/base, water, individual trees and structures remain intact, and
elevated bridges keep the landcover beneath them. Excluded roads leave no cuts.
Surviving slab pieces retain their original slopes and thickness and are closed
solids. This adds geometry and generation time. Footprints are extracted from
road outlines, avoiding the many interior triangles needed only for terrain
draping; progress updates during footprint preparation and surface cutting.
On the cached Milwaukee selection, this reduced the cutting step from about
134 seconds to 46 seconds. Road dimensions are unchanged.

**Everything sits on the ground, not in it.** Roads, land cover, buildings,
and piers reach 0.15 mm below the terrain surface (**Embed Into Terrain**) and
no further. That is enough for the solids to overlap in a slicer, which is all
the overlap is for; anything deeper is colour laid down inside the hill, which
in a multi-material print is a filament change on every layer it spans and
nothing to show for it. For that to hold on a hillside the undersides have to
follow the ground everywhere, not just at their outlines: the caps of a slab
or a ribbon are refined until no triangle edge is longer than the drape
spacing and every inserted vertex is draped, and a building's underside is
draped the same way instead of being one flat plate at its lowest corner. The
printed shape is unchanged -- what is below ground is inside the terrain either
way -- but a park no longer shows as green wedges where its flat cap crossed
the slope, and a slab never hangs above a hollow. Land cover stands 0.4 mm
above the terrain (**Land Surface Rise**): two layers, enough to read as a
colour region of its own and still below a 0.6 mm road.

**The terrain is lightly smoothed.** The elevation tiles carry a metre or two
of pixel noise, which at this scale is a fifth of a printed layer: a road
draped over it flips between layers every few millimetres and prints as a
scatter of one-layer coins along the street. **Terrain Smoothing** (one cell
by default, a 3×3 mean over the terrain grid) halves those on the sample city
while moving the terrain by a few hundredths of a millimetre almost
everywhere; only cliffs and the river banks, which the water cut re-sharpens
anyway, change by more. It is applied once, to the shared height field, so
roads, buildings, slabs, and the terrain itself all see the same ground. Set
it to zero to use the tiles as they are.

**The base is measured against the land that survives.** Base thickness is the
distance below the *lowest point of the finished top surface*, which is only
known once the cut has been made: removing a river takes its bed with it, and
the shoreline sits between a grid node and the bank rather than on either. The
solid measures its own vertices rather than the height field, so the requested
thickness is exact.

**Other overlapping solids are not booleaned.** Roads overlap each other at
junctions, and surfaces overlap the terrain. Each object is individually
watertight, which is what slicers need, but the model is not one fused
manifold. Union is left to Blender, where you can control it.

**Building height is read as absolute, not as a thickness.** Overture reports
`height` as the distance from the ground to the top of the feature and
`min_height` as the level it starts at, so a mass spans `min_height` to
`height`. Adding the two instead turns a tower's crown section into a spire
taller than the tower: on the sample bbox, Great American Tower's crown is
published as `min_height` 140 / `height` 162.7 against a real building height of
202.7 m, and stacking them produced a 302.7 m needle.

**A building published twice is built once.** The source sometimes carries a
building as a plain named footprint with a height *and* as an unnamed outline
that owns its parts; the Scripps Center arrives as a 143 m box standing exactly
over eleven tiered parts, and the box hid the tiers and the crown. A partless
building whose footprint lies at least 90% inside another building's parts is
that building over again and is dropped, as is the less-described of two
partless footprints that each cover the other. The count is
`duplicate_outlines_suppressed`; on the sample bbox it is 8.

**A missing height falls back on the feature's class.** About 29% of buildings
in the sample bbox carry neither a height nor a floor count. One number for all
of them makes a stadium, a parking deck, and a garden shed the same height, so
each Overture class has an ordinary real-world default — 30 m for `stadium`,
3 m for `shed` — and the configured default is used only for a class with no
entry. The chosen source is recorded per object as `height_source`, either
`height`, `num_floors`, `class_default:<name>`, or `default`.

**Malformed source footprints are rejected, not repaired.** Every solid is
checked topologically before it is emitted: each edge must be shared by exactly
two faces. Blender's triangulator does occasionally return an incomplete or
self-overlapping triangulation for an awkward outline — eleven triangles for a
fourteen-sided ring that needs twelve — and the shortfall can be far too small
for an area comparison to notice while still being a real hole. Such outlines
are retried with ear clipping, and only rejected and counted if that also
fails. On the sample bbox 3 of 10,854 solids fail both.

Still not implemented:

- roof shapes outside the list above, and `round` as a true barrel vault
  rather than a gable; those objects are marked `roof_geometry =
  unimplemented:<shape>`;
- bridge supports recovered from Overture `base/infrastructure`, and bridge
  structure (suspension towers, arches, trusses) from its `bridge:structure`
  tags; piers are placed by spacing rules and are schematic;
- what a deck crosses is inferred from proximity to road centerlines and to
  lower decks, not from connector topology, so a road running alongside a
  viaduct within a road width lifts it too, and a deck's road lift is uniform
  along its connected network;
- connector topology is downloaded but not yet used to merge junctions;
- antimeridian-crossing bboxes.

## Source metadata

Generated building objects carry `overture_id`, `osm_id`, `feature_type`,
`height_source`, `height_m`, `mass_thickness_m`, `min_height_source`,
`min_height_m`, `terrain_base_mm`, `terrain_base_source`, `building_id`,
`num_floors`, `min_floor`, `level`, `has_parts`, `subtype`, `class`,
`roof_height`, `roof_shape`, `roof_direction`, `roof_orientation`,
`roof_geometry`, `roof_height_source`, `roof_wall_top_m`, `roof_top_m`, and
`underside` (`draped_to_terrain` for a ground-founded mass, `elevated` for a
part that starts above the ground).

Batched objects (roads, bridges, surfaces) carry `feature_type`, their class or
category, `source`, and `solid_count`. The root collection stores the Overture
release and client version, the bbox, the exact transform metadata, and full
generation counts including everything that was skipped and why.
