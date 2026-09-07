# Jarvizar City Model

Jarvizar City Model is a Blender add-on for turning a WGS84 bounding box into
clean, editable, printable miniature geometry. It is aimed at the existing
Jarvizar printable-map workflow, not at general-purpose GIS visualization, and
it does not use BLOSM for geometry generation.

The current release generates a complete miniature:

- **Terrain** displaced from public elevation tiles, as one closed solid with a
  flat bottom a fixed thickness below the lowest surviving land, plus an
  optional raised display rim;
- **Water** cut clean out of the terrain, with the shoreline following the real
  bank rather than the terrain grid, and an optional full-depth slab that drops
  into the opening as a separate printable part;
- **Ground kept under structures over the water**: a narrow causeway of terrain
  under every bridge that crosses the opening, and a pedestal under every
  building, dock, or mapped pier that stands in it, so nothing hangs over empty
  space and nothing is extruded down to the build plate;
- **Land cover** — parks, grass, gardens, forest floor, plazas, sand, and rock —
  as thin slabs that follow the ground and stop at the water's edge;
- **Trees**, from Overture's individually mapped tree points plus a
  deterministic scatter inside mapped forest polygons and, by default, the
  coarser satellite forest cover that fills in wooded hillsides;
- **Roads and railways**, buffered from centerlines at rule-resolved widths and
  draped onto the terrain, with railway bridges read from `rail_flags`, and
  with sidewalks and crossings left out by default so a street prints as one
  ribbon rather than three;
- **Bridges and overpasses**, solved as one network so every fork and joint
  has one height, continuing the road surface where they meet it, lifted two
  layers clear of whatever they cross at a real road grade, and standing on
  piers that reach real ground -- the bank or the causeway;
- **Buildings and building parts**, extruded from ground level to their stated
  height, with class-aware fallbacks, every part of one building founded on
  that building's lowest terrain point, and **shaped roofs** -- gabled, hipped,
  skillion, pyramidal, and dome -- wherever the source says so, which is what
  gives a tower its crown.

Every generated solid is watertight. On the sample 6 km bounding box that is
about 15,800 objects across 10,900 distinct meshes and roughly 1.35 million
polygons, generated in about 16 seconds, with zero non-manifold edges.

See [the implementation plan](docs/IMPLEMENTATION_PLAN.md),
[schema research](docs/OVERTURE_SCHEMA.md), and
[bridge design](docs/BRIDGE_DESIGN.md) for the staged design.

## Install the downloader

Do not install Overture's compiled dependency stack into Blender. From this
repository in PowerShell, run:

```powershell
.\scripts\setup_overture_env.ps1
```

This creates `.venv-overture` and installs the tested official client
`overturemaps==1.0.2`. It prints the interpreter path to paste into Blender's
**Overture Python** field:

```text
C:\path\to\3dmapcreator\.venv-overture\Scripts\python.exe
```

macOS/Linux:

```bash
bash scripts/setup_overture_env.sh python3.11
```

Use `<repository>/.venv-overture/bin/python` in Blender. Full manual and
platform-specific instructions are in [DEPENDENCIES.md](docs/DEPENDENCIES.md).

The same interpreter also runs the elevation downloader, which needs only the
standard library.

## Build the add-on ZIP

Run:

```powershell
python .\scripts\build_addon.py
```

This creates two archives in `dist`:

- `jarvizar_city_model-0.8.0-blender36.zip` — classic add-on layout for
  Blender 3.6 and later;
- `jarvizar_city_model-0.8.0-extension.zip` — extension layout for Blender 4.2
  and later, including declared network/file permissions.

The virtual environment, cache, tests, and downloaded data are never bundled.

## Install in Blender 3.6

1. Open **Edit > Preferences > Add-ons**.
2. Click **Install...** and select
   `dist/jarvizar_city_model-0.8.0-blender36.zip`.
3. Enable **Object: Jarvizar City Model**.
4. In the 3D View press **N**, then open **City Model**.

For Blender 4.2+, use **Edit > Preferences > Get Extensions > menu > Install
from Disk** and select the extension ZIP.

## Print scale

The default is **Fixed Print Scale** at **0.07 mm per real metre** (1:14286).
The scale is the input; the finished model size is whatever that implies.

That is the right way round for a printed map, because printability is decided
by real feature sizes rather than by the bounding box:

| At 0.07 mm/m | Printed width |
|---|---|
| Motorway, 14 m | 0.98 mm, narrowed to the 0.70 mm cap |
| Primary, 11 m | 0.77 mm, narrowed to the 0.70 mm cap |
| Secondary, 9.5 m | 0.67 mm |
| Residential, 6.5 m | 0.455 mm |
| Service, 4.5 m | widened to the 0.45 mm floor |

A 0.4 mm nozzle needs about 0.45 mm to lay down a bead, which is exactly a
residential street at this scale. At the other end a motorway at true scale
is nearly a millimetre wide and reads as a runway between the streets, so
widths are also held under **Maximum Road Width** (0.7 mm by default); the
hierarchy of classes survives below the cap and flattens at it, and bridge
decks follow the same rule. Roads are 0.6 mm tall by default, which is three
layers at a 0.2 mm layer height.

**Fit to Size** mode is still available and behaves as before, fitting the bbox
into a target width and height. Its drawback is visible in the same table: on a
6 km bbox fitted to 170 mm the scale falls to 0.033 mm/m, where the 0.45 mm
printable floor stands for 13.6 m of real road, so footways come out as wide as
motorways.

The panel shows the resulting ratio, the model size, and what the minimum road
width means in real metres before you generate anything.

### Getting it into a slicer

The model is generated directly in millimetres, with one Blender unit as one
millimetre. Export STL with Blender's default settings — **leave "Scene Unit"
unchecked** — and import at **100%**. No scaling step is needed at either end.

Checked directly: a 2.1 km selection at 0.07 mm/m exports an STL spanning
151.6 units, which a slicer reads as 151.6 mm. With "Scene Unit" ticked the
same export spans 0.1516, because Blender then converts to metres, and the
slicer would read it as a sixth of a millimetre.

#### 3MF: use **Export 3MF for Bambu**, not File ▸ Export

A generated city is dozens of objects, one per road class and surface
category, so that each can carry its own colour. A 3MF file records each
top-level object as its own *build item*, and Bambu Studio treats a build item
as a separate printable object: it re-centres each one on its own bounding
box, drops it onto the bed, and will rotate it and move it to another plate to
make things fit. The parts all arrive, but every one of them has lost its
height relative to the others.

Measured on the sample bbox, exported through the `io_mesh_3mf` add-on and
read back out of Bambu Studio: 42 build items became **4 plates**, 13 objects
were **rotated**, and the per-object Z offsets spanned **7.49 mm** on a model
only 16.7 mm tall — the terrain rose while the bridges sank under it.

The **Export 3MF for Bambu** button in the sidebar writes the same geometry as
one object with one part per collection. The same round trip then reports one
build item, 42 parts, one plate, no rotation and a single shared Z offset, and
Bambu's own mesh repair finds nothing to fix. Each part keeps its material, so
multi-material assignment still works per road class.

The button also fixes the scale. `io_mesh_3mf` multiplies the scene's metric
scale by the *display* unit as well, so with **Set Scene Units** on (metric
0.001, display millimetres) a plain File ▸ Export ▸ 3MF writes the model a
thousand times too small. The button passes the compensating factor, and the
file comes out at true millimetres — 364.2 × 201.4 × 16.7 mm for the sample,
terrain plus the 2 mm border rim. Exporting by hand instead needs **Scale
1000** typed into the export panel.

It needs the `io_mesh_3mf` add-on enabled, and only exports what the add-on
generated, so a leftover default cube in the scene is left out.

## Generate a model

1. Enter the bbox as decimal degrees in west, south, east, north order. The
   default is `-84.53370,39.08554,-84.47422,39.11094` (Cincinnati).
   **Paste Coordinates** fills all four fields from one line on the clipboard,
   which is the format the **Copy** button at
   [prochitecture.com/blender-osm](https://prochitecture.com/blender-osm)
   produces: `-84.53576,39.08541,-84.48473,39.11475`. Commas, spaces,
   semicolons, surrounding brackets and a `bbox=` prefix all read the same;
   the order does not, because several other orders are still a legal box
   somewhere else on earth. If the clipboard does not hold a box, the button
   asks for the text instead of guessing.
2. Choose the print scale, as above.
3. Under **Features**, enable what you want. Each feature only downloads the
   Overture types it actually needs.
4. Set **Cache Directory**. The **Overture Python** path comes from add-on
   preferences; only fill the sidebar field to override it for this scene.
5. Click **Download / Cache Data**. Matching cached types are reused; only the
   missing ones are fetched, so enabling roads later does not re-download
   buildings.
6. Click **Generate Model**.

The add-on replaces its previous tagged `CITY_MODEL` hierarchy when generating.
It does not remove unrelated user objects. If enabled, **Set Scene Units to
Millimetres** configures metric scale `0.001`, so one Blender unit displays as
one millimetre.

Collections are organized as:

```text
CITY_MODEL
├── TERRAIN
│   ├── LAND_SURFACES
│   └── TERRAIN_SUPPORTS
├── VEGETATION
├── WATER
├── ROADS
│   ├── SURFACE_ROADS
│   ├── BRIDGES
│   └── BRIDGE_SUPPORTS
└── BUILDINGS
    └── BUILDING_PARTS
```

By default every building and building part is one `BUILDINGS` object (parts
in their own material slot) and every tree is one `TREES` object under
`VEGETATION`, so a dense city is a few dozen objects rather than fifteen
thousand. Each mass inside a merged object keeps its own vertices, so the
object is a set of individually watertight shells, which is what a slicer
wants. Untick **Merge Buildings and Trees** to get one object per building
carrying its source properties (`overture_id`, `height_source`,
`roof_geometry`, `terrain_base_source`, `underside`) and one linked duplicate
per tree; `BUILDING_PARTS` is only populated then. Roads, decks, piers, and
terrain supports are batched either way.

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
| Roofs | Taken out of a whole building's stated height; added on top of a part's height, clamped to the parent's total, because that is how the source publishes a tower's crown |
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

These are honest descriptions of what the generator does, not aspirations.

**Height resolution** is deterministic:

1. Overture `height`;
2. otherwise `num_floors * Floor Height`;
3. otherwise `Default Building Height`.

Bottom elevation uses `min_height`, then `min_floor * Floor Height`, then zero.
`height` is an extrusion extent, so the top is `terrain + min_height + height`.
`roof_height` is retained as metadata but never added. Missing heights are
never randomized.

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
`skipped_sidepaths`. Nothing is repaired afterwards: a park path that used to
join a sidewalk now ends at the kerb, which at this scale is invisible.

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
`height` is the one place this project departs from the OpenStreetMap
definition: a whole building's `height` includes its roof, but the parts in
the data do not -- the Great American Tower's crown is published as
`min_height` 140, `height` 162.7, `roof_height` 40 under a parent of 202.7 m,
which only adds up with the dome on top -- so a part's roof is added above its
height and clamped to the parent's stated total. A shaped roof with no
`roof_height` gets an ordinary pitch recorded as `roof_height_source =
default`.

**Trees are deliberately enlarged.** A real 11 m tree at this scale is about
0.2 mm and neither prints nor reads. Trees are scaled up to **Minimum Tree
Height**, and the applied factor is recorded as `tree_size_exaggeration` in the
generation metadata.

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
solved level. Only lowering is applied, so a polygon that slightly overlaps a
bank does not flood it. The number of grid nodes changed is reported as
`terrain_nodes_flattened_to_water`.

**Open water is cut out of the terrain, not covered over.** A body larger than
the cut threshold (0.5 ha by default) is removed from the terrain solid, so the
river reads as an opening. The bank is not a staircase along cell boundaries:
the shoreline's exact crossing of each grid line is recorded when the polygon
is rasterised, and every cell the shore passes through is clipped against it.
Overlapping water polygons are combined before choosing those crossings, so
an edge inside another water body cannot leave a false strip of terrain.
Small water — ponds, fountain basins, rooftop pools — stays a surface slab,
because a hole a few tenths of a millimetre across only weakens the print.

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
[water cutout investigation](docs/WATER_CUTOUTS.md) for the source comparison
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
height. Every node
stays at least **Bridge Clearance** (0.4 mm, two layers of daylight) plus the
deck's thickness above the terrain, plus one road thickness when the deck
passes over a road, plus a lower deck's top where it crosses one at a real
angle. The deck never rises or falls faster than **Maximum Deck Grade** (8 %).
What comes out is the lowest profile that satisfies all of that: a piece too
short to reach its clearance humps as high as the grade allows, and a network
that never rises **Minimum Bridge Lift** (0.2 mm, one layer) above the road
surface is built as an ordinary road, counted in `bridge_decks_demoted`. Decks
are as thick as roads (0.6 mm), and piers reach 0.1 mm up into the deck they
carry so none stops a hairline short. A road that crosses cut-out water with no
bridge flag at all has that crossing recovered as a deck, recorded as
`bridge_evidence: crosses_cut_water`, and is never demoted; a run shorter than
the minimum span is mapping slop along a bank and stays a surface road, draped
to the bank's grade rather than dipping to the water. Railway bridges come
from `rail_flags`, which the road-only reader used to ignore.

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
- downloads block the Blender UI while the external process runs;
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

## Tests

Dependency-free unit tests (270 of them, no Blender and no network):

```powershell
python -m unittest discover -s tests -v
```

Blender smoke test — synthetic data covering every generator, the bridge
anti-sag property, a rail bridge, an unflagged river crossing, a boathouse in
the river, a park running out over the water, gabled, pyramid and dome roofs,
the regional-polygon guard, and a manifold check:

```powershell
& "C:\Program Files\Blender Foundation\Blender 3.6\blender.exe" `
  --background --factory-startup --python .\tests\blender_smoke.py
```

Against a real populated cache, the integration check reports counts, polygon
statistics, and manifold status for every generated mesh:

```powershell
& "C:\Program Files\Blender Foundation\Blender 3.6\blender.exe" `
  --background --factory-startup --python .\tests\blender_live_full.py `
  -- --cache <cache-root>
```

To look at the result, render a three-quarter aerial preview. `--water 0`
leaves the river open, which is the reference look for the print, and
`--target x,y --span mm` aims the camera at one bridge or one bank:

```powershell
& "C:\Program Files\Blender Foundation\Blender 3.6\blender.exe" `
  --background --factory-startup --python .\tests\render_preview.py `
  -- --cache <cache-root> --output preview.png --water 0 --target -113,-55 --span 60
```

To measure rather than look, the embed probe samples every cap face of the
roads, land surfaces, buildings, piers, and supports against the height field
the generator aligned to, and reports how deep undersides sit, how high tops
stand, and how many samples lie over the cut-out water, with the worst
offenders by location:

```powershell
& "C:\Program Files\Blender Foundation\Blender 3.6\blender.exe" `
  --background --factory-startup --python .\tests\blender_embed_probe.py `
  -- --cache <cache-root>
```
