"""
Jarvizar BLOSM -> Bambu Suite laser SVG exporter
================================================

Exports a Blender scene imported with the blosm add-on to an SVG sized in
millimetres for Bambu Suite:

    road / path CURVES          -> open SVG paths        -> Laser Line
    building / water MESHES     -> closed SVG paths      -> Laser Fill
    coastlines (edge meshes)    -> one filled ocean path -> Laser Fill
    stadium / plaza outlines    -> open SVG paths        -> Laser Line
    decorative border           -> line or filled band   -> Laser Line / Fill
    outer cut rectangle         -> closed SVG path       -> Laser Cut

The rectangular object named by BOUNDS_OBJECT_NAME -- or by any of
BOUNDS_OBJECT_ALIASES, so an imported cutout.stl works unrenamed -- defines
the exact crop.
Geometry is clipped to it mathematically -- lines by Liang-Barsky, fills by
Sutherland-Hodgman -- so a Boolean crop modifier in Blender is optional.

Setting up the crop
-------------------
Draw LASER_BOUNDS as a plain, axis-aligned rectangle. Two details matter:

  * A plain filled rectangle crops to its own extent. A FRAME -- a flat shape
    with a hole in it, like a boolean cutter -- crops to its window instead,
    which is almost certainly what you meant by drawing a frame. BOUNDS_MODE
    controls this; the export log always says which edge it used.
  * Do not rotate the crop. It is read as an axis-aligned box, so a rotated one
    exports a larger area than the rectangle you drew (41% larger at 45
    degrees). To turn the map, rotate the imported geometry instead: rotation
    about Z is exact at any angle. Do not TILT it out of the XY plane -- fills
    are a top-down projection, so a tilt foreshortens buildings and a 90 degree
    tilt deletes them, while roads carry on looking correct.
  * Only the XY extent is read. Faces, thickness and Z position are ignored, so
    a flat plane, a solid slab and an extruded cutter all behave the same.

The SIZE is up to you, because only the ratio between the crop and the geometry
inside it is ever used. Either works:

  * Leave the blosm import at its native scale (1 Blender unit = 1 metre) and
    draw the crop in metres, e.g. 2000 x 2945 m.
  * Scale the whole import down until it fits a plaque-sized rectangle, and
    draw the crop at that size.

Either way, give the crop a width:height ratio matching the MAP AREA inside the
decorative border, not the whole plaque -- the export log prints the exact
number to use. FIT_MODE handles a mismatch, but "crop" trims ground to do it.


What blosm actually produces (checked against the add-on source)
---------------------------------------------------------------
blosm names every layer "<osm file name>_<layer id>", for example
`map.osm_roads_primary`. There is no plain "roads" collection, and there is one
layer per road class, not one per group. This exporter therefore matches by
layer id SUFFIX and accepts both of blosm's output modes:

  * "Import as a single object" ON (the default) -- one OBJECT per layer, all of
    them in a single collection named after the .osm file.
  * "Import as a single object" OFF -- one COLLECTION per layer, plus an EMPTY
    parent of the same name, and OSM tags copied onto each object as custom
    properties.

Roads and paths arrive as CURVE objects with a bevel/profile object giving them
width; this exporter reads the underlying centreline, so leave them as curves.
Water bodies arrive as polygons, but seas and oceans arrive only as COASTLINE
EDGES with no faces -- blosm never builds the sea surface. Reconstructing it is
what the coastline section below does.


Bambu Suite import notes
------------------------
* Import the SVG, then CHECK THE MILLIMETRE SIZE before doing anything else.
  Suite has a known 96-vs-72 DPI import bug that scales artwork by 4/3 (an 80 mm
  square arriving as 106.7 mm). The plate should read exactly
  OUTPUT_WIDTH_MM x OUTPUT_HEIGHT_MM; rescale if it does not.
* Every group below is given its OWN colour, because Suite separates imported
  artwork by colour when assigning processes. Groups that share a colour can end
  up sharing one process. Merging processes in Suite afterwards is easy;
  splitting one is not.
* SVG stroke-width is artwork styling, not a laser width. A "Laser Line" process
  traces the path with the beam, so a 0.80 mm stroke and a 0.10 mm stroke burn
  identically. Set THICK_BORDER_AS_FILL to get a border band with a real width.
* Do not add live text. Suite does not read fonts; any lettering has to arrive
  as closed vector outlines.
"""

import re
import time
import math
from collections import defaultdict, Counter
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.geometry import interpolate_bezier


# =============================================================================
# QUICK SETTINGS -- the three things that change from plaque to plaque
# =============================================================================

# The lettering on the plaque. Converted to vector outlines through Blender,
# never emitted as live SVG text. Set it to "" (or EXPORT_LABEL = False further
# down) for no label at all.
LABEL_TEXT = "CINCINNATI"

# Which corner the label sits in, inset from the thin border:
# "lower_right", "lower_left", "upper_right", or "upper_left".
LABEL_CORNER = "lower_right"

# Turn the label, for a portrait plaque or a title running up one side. Right
# angles only: 0, 90, 180 or 270 degrees clockwise. At 90 or 270 the box and the
# map knockout beneath it turn with the lettering, so the padding stays measured
# from the text and the corner inset is unchanged.
LABEL_ROTATION_DEG = 0

# The rest of the label -- font, size, padding, colours -- is in the label
# section of the configuration below.


# =============================================================================
# CONFIGURATION
# =============================================================================

# Rectangular Blender object defining the map crop. Any object works; its
# world-space XY bounding box is used.
BOUNDS_OBJECT_NAME = "LASER_BOUNDS"

# Other names accepted for that same object, tried in order after the one above.
# An STL imported as "cutout.stl" arrives as an object called "cutout", so it
# works as the crop without being renamed. Matching ignores case and Blender's
# duplicate suffix, so "Cutout" and "cutout.001" are found too.
BOUNDS_OBJECT_ALIASES = ["cutout"]

# How to read the crop object.
#   "auto"  - if it is a frame (a flat shape with a hole), crop to the HOLE;
#             otherwise crop to its outer bounding box. Recommended.
#   "outer" - always the outer bounding box, hole or not.
#   "inner" - require a hole, and fail if there is not exactly one.
# A frame's outer edge and its window differ by the frame thickness, which is a
# few percent of the map, so it is worth being explicit about which you meant.
BOUNDS_MODE = "auto"

# Final physical size in Bambu Suite.
OUTPUT_WIDTH_MM = 170.5
OUTPUT_HEIGHT_MM = 119.5

# Pad the exported SVG out to a standard 5 x 7 inch blank, landscape.
#
# This changes NOTHING about the artwork: the map, the decorative border and
# the label keep their OUTPUT_WIDTH_MM x OUTPUT_HEIGHT_MM size and their
# spacing, and are simply centred in a larger canvas. All that is added around
# them is blank space -- 3.65 mm left and right, 3.75 mm top and bottom.
#
# The one thing that does grow is the CUT, which follows the canvas edge so the
# piece comes off the bed at a true 5 x 7 with a plain unengraved margin. The
# decorative border does NOT move out with it: the margin sits outside it.
EXPAND_TO_5x7 = True

# The blank to pad out to. 5 x 7 inches, landscape. Padding is only ever added,
# so a target smaller than the plaque in either axis leaves that axis alone.
EXPAND_TO_WIDTH_MM = 177.8
EXPAND_TO_HEIGHT_MM = 127.0

# Where the SVG is written. "{blend}" becomes the .blend file's own name, so
# each city writes its own file instead of every export overwriting one
# shared name. "//" is Blender's "beside the .blend"; an unsaved file has
# nowhere for that to point, so it falls back to your home folder and the
# name falls back to "jarvizar" -- the log always prints the path used.
OUTPUT_SVG = "//{blend}_laser_map.svg"

# How to reconcile the crop rectangle's aspect ratio with the plaque's.
#   "crop"    centre-crop the Blender bounds to the plaque aspect. No distortion,
#             fills the plaque, trims a little geography. Recommended.
#   "fit"     letterbox inside the map area. No distortion, leaves blank margins.
#   "stretch" scale X and Y independently. Fills the plaque, distorts the map.
FIT_MODE = "crop"

# Source layers. Each entry is matched case-insensitively against collection AND
# object names, as an exact match or as a "_<name>" suffix, so both the raw blosm
# names (map.osm_roads_primary) and hand-renamed collections (roads) are found.
LINE_LAYERS = {
    "roads": [
        "roads", "roads_motorway", "roads_trunk", "roads_primary",
        "roads_secondary", "roads_tertiary", "roads_unclassified",
        "roads_residential", "roads_service", "roads_pedestrian",
        "roads_track", "roads_other",
    ],
    "paths": [
        "paths", "paths_footway", "paths_steps", "paths_cycleway",
        "paths_bridleway",
    ],
    "railways": ["railways"],
}

# Line layers where a CLOSED spline means an area outline rather than a route:
# pedestrian plazas and railway platforms. Roundabouts and cul-de-sac loops in
# the ordinary road layers are left alone. This is geometric, so it works even
# in blosm's single-object mode where no OSM tags survive.
DROP_CLOSED_LINES_IN_LAYERS = ["roads_pedestrian", "railways"]

# Skip sidewalks, crossings and other sidepaths. Needs OSM tags, so it only
# takes effect when blosm imported with "Import as a single object" OFF. With it
# ON there are no tags at all and the overlap culling below is what saves you.
EXCLUDE_SIDEPATHS = True

# Skip ways tagged as areas (plazas, platforms). Also tag-based.
EXCLUDE_AREA_LINES = True

FILL_LAYERS = {
    "buildings": ["buildings"],
    "water": ["water"],
}

COASTLINE_LAYERS = ["coastlines", "coastline"]

# Mapped surfaces that are LAND even though they sit out over water: pedestrian
# decks, piers and breakwaters. OSM maps the coastline along the shore and the
# structure separately, so without these the sea runs straight under a pier and
# everything on it merges into one dark mass -- Canada Place in Vancouver is a
# building plus 265 mm2 of deck that was being drawn as open sea.
#
# blosm gives area-mapped highways their own layers. If your import names them
# differently, add the name here; the export log lists which ones matched.
DECK_LAYERS = [
    "areas_pedestrian", "areas_footway", "areas_pier",
    "piers", "breakwaters",
]

# Cut decks out of the water, so they read as land and whatever stands on them
# reads against them.
EXPORT_DECKS = True

# Decks are a knockout, not artwork: engraving them would put a solid dark slab
# over the pier and the buildings on it would vanish into it all over again,
# which is the problem they exist to fix. Set True to burn them as well.
ENGRAVE_DECKS = False
DECKS_GROUP_ID = "decks"

# Never exported. blosm gives roads their width with small bevel curves named
# "profile_<layer>" (profile_roads_primary, ...) kept in a "way_profiles"
# collection. Their names end with the layer id, so without the prefix rule they
# would be picked up as roads and exported as stray stubs at the origin.
EXCLUDE_LAYERS = ["way_profiles"]
EXCLUDE_NAME_PREFIXES = ["profile_"]

ENABLED_LINE_GROUPS = {"roads": True, "paths": True, "railways": False}
ENABLED_FILL_GROUPS = {"buildings": True, "water": True}

# Rebuild the sea/ocean fill from coastline edges.
EXPORT_OCEAN = True
OCEAN_GROUP_ID = "ocean"

# Order the fill groups are written in. Suite separates by colour so this makes
# no difference to the burn, but it decides what the preview SVG looks like in a
# browser, and water painted over the buildings hid them completely.
FILL_DRAW_ORDER = [OCEAN_GROUP_ID, "water", DECKS_GROUP_ID, "buildings"]

# Rebuild water areas whose outline is incomplete. When a bbox extract omits
# some member ways of a big river multipolygon, blosm cannot close the ring and
# falls back to rendering it as LINESTRINGS -- edges with no faces -- so the
# river silently disappears. This closes those edges against the crop instead.
CLOSE_INCOMPLETE_WATER = True

# Refuse a repaired water ring that would cover more than this much of the map;
# that means the water side could not be identified and flooding the plaque
# would be worse than leaving the gap.
MAX_REPAIRED_WATER_AREA_FRACTION = 0.60

# -----------------------------------------------------------------------------
# Overlap culling -- the fix for scorching.
#
# A Laser Line process burns every path it is handed. Two lines closer together
# than roughly one beam width get burned as one over-cooked band, which is what
# scorches the wood. This drops a line that runs close to AND roughly parallel
# with a line already being burned.
#
# The rule is "close AND parallel", never just "close", so a footpath running
# INTO a road keeps its connection and no gap opens at the junction.
#
# MIN_LINE_SEPARATION_MM is in FINAL MILLIMETRES, so set it from your laser, not
# from the map: about one kerf width. Raising it removes real map detail --
# at a typical city crop 1 mm is roughly 60-100 m, so 0.15 mm culls lines within
# ~10-15 m of each other, which is sidewalk distance.
CULL_OVERLAPPING_LINES = True
MIN_LINE_SEPARATION_MM = 0.3
CULL_PARALLEL_ANGLE_DEG = 28.0

# Keep or drop each path whole, so culling never breaks a road in the middle.
# Set False to trim segment by segment: removes more, but fragments.
CULL_WHOLE_PATHS_ONLY = True
CULL_PATH_SHADOW_FRACTION = 0.68

# Apply the destructive cleanup more strongly to the low-priority `paths`
# group. Roads still use whole-path culling, while footpaths may have only their
# shadowed sections removed. Compact line tangles target tiny maze-like path
# networks that have no free ends and therefore cannot be caught by ordinary
# dangling-stub pruning. Disable this one switch to restore the conservative
# behaviour for paths.
AGGRESSIVE_PATH_CLEANUP = True
PATH_DANGLING_STUBS_MM = 1.20
PATH_TANGLE_MAX_SPAN_MM = 6.00
PATH_TANGLE_MIN_SEGMENTS = 20
PATH_TANGLE_MIN_LENGTH_TO_SPAN = 3.60

# Contract a ring that encloses less wood than the beam is wide.
#
# A turning circle or a small roundabout cannot burn as a ring at this scale --
# it burns as a solid dot, and a dot is what the eye picks out of the finished
# plaque. Culling can never catch one, because a ring is only ever close to
# ITSELF and culling compares a path with OTHER paths. Deleting the ring is no
# answer either: every road that met it would stop in mid-air a diameter short
# of the rest. So the ring is contracted to its centre and everything that
# touched it comes with it -- the dot becomes a plain junction, and nothing
# comes apart.
#
# Only CLOSED paths qualify, and that restriction is the whole safety argument.
# An ordinary crossroads is a cycle in the network but it is not a closed path:
# on this Chicago plaque 1161 network cycles fit inside a 0.9 mm disc, while
# only 13 closed rings enclose less than MIN_LOOP_OPEN_RADIUS_MM. Contracting
# the former was tried and wrecked the map -- it dragged whole road bundles into
# starbursts. Set the radius from the beam: it is the radius of unburnt wood a
# ring has to keep to read as a ring at all.
COLLAPSE_FILLED_LOOPS = True
MIN_LOOP_OPEN_RADIUS_MM = 0.25

# Thin the darkest patches, and only those.
#
# Culling above is PAIRWISE: it asks whether this line runs along that one. It
# cannot see that a dozen individually legal neighbours have piled into one
# square millimetre, which is what burns as a localised black knot -- a
# roundabout traced twice, a plaza's footpaths, four carriageways plus their
# footways. Raising MIN_LINE_SEPARATION_MM would catch those, but it taxes the
# whole map: measured on this Chicago plaque, 0.22 -> 0.35 mm took coverage from
# 98.1% to 92.4% and took interior road gaps -- a stretch missing with road
# still drawn on BOTH sides -- from 6 to 22. That is the regression welding
# exists to prevent.
#
# So measure the pile directly, in millimetres of line per square millimetre of
# wood over a DENSE_CLUSTER_WINDOW_MM box, and apply the wider
# DENSE_CLUSTER_SEPARATION_MM ONLY where it is over the limit. Set the limit
# from the beam: at a burn about MIN_LINE_SEPARATION_MM wide, density D inks
# roughly D x that much of the wood, so 2.7 mm/mm2 is about 60% inked, which is
# where a patch stops reading as lines. The rest of the map is untouched.
#
# Measured on this plaque: ground denser than 3.2 mm/mm2 fell from 197.8 to
# 81.6 mm2 and denser than 3.5 from 63.1 to 12.7 mm2, for 1.9% of the linework,
# with interior road gaps unchanged at 6 and coverage 97.1%.
RELIEVE_DENSE_CLUSTERS = True
DENSE_CLUSTER_LIMIT_MM_PER_MM2 = 2.7
DENSE_CLUSTER_WINDOW_MM = 2.0
DENSE_CLUSTER_SEPARATION_MM = 0.50

# How much of a path has to lie in a dark patch before it is a candidate at
# all, and how much of it a SURVIVING line has to run along before it is
# actually dropped. The second is the safety catch: at 0.88 only a line that is
# doubled almost end to end goes, which is why this costs no interior gaps.
DENSE_CLUSTER_HOT_FRACTION = 0.60
DENSE_CLUSTER_SHADOW_FRACTION = 0.88

# Nothing this important or better is ever removed for being in a dark patch,
# whatever runs alongside it. A through-street with a cycle track laid down its
# length is shadowed end to end and would otherwise qualify: on this plaque that
# took out 86 secondary and 5 trunk roads, North Dearborn in front of Block 37
# among them. 6 = residential, so motorway down to residential streets are safe
# and pedestrian ways, service roads, tracks, cycleways and footpaths are not.
# See HIGHWAY_RANK / LAYER_RANK for the numbers.
DENSE_CLUSTER_PROTECT_RANK = 6

# Mesh thinning, for the dark patches the shadow test cannot reach: a plaza or
# a podium criss-crossed by short footpaths, where nothing duplicates anything
# but the block still burns as one mass. A link shorter than this may be
# dropped ONLY when its two ends still reach each other without it, by a detour
# no longer than DENSE_CLUSTER_MESH_DETOUR times its own length. That is a
# graph fact rather than an estimate, so no junction can come apart -- and a
# street is never eligible, being far longer than this once welded. 0 disables.
DENSE_CLUSTER_MESH_MAX_MM = 2.5
DENSE_CLUSTER_MESH_DETOUR = 4.0

# Count ground a Laser Fill already burns solid as dark, when measuring density.
# It IS dark -- it is at 100% ink before a line is drawn on it -- so a line
# there is a second pass over the same wood: invisible, and it scorches. The
# footpath mesh over the Lakeshore East podium measured only 2.19 mm/mm2 of
# line, well under the limit, yet burned darker than every building around it.
#
# This is not a ban on lines inside buildings and must not become one. It only
# makes them CANDIDATES; a path still has to be a duplicate or a redundant mesh
# link to go, and DENSE_CLUSTER_PROTECT_RANK still keeps every street. A lone
# footway crossing a building is neither, so it stays.
# On covered ground the limit is multiplied by this, rather than being ignored
# outright -- that is the difference between thinning a mesh piled on a podium
# and refusing to draw a footway across a building at all.
DENSE_CLUSTER_COUNTS_SOLID_FILL = True
DENSE_CLUSTER_COVERED_LIMIT_SCALE = 0.60
SOLID_FILL_GROUPS = ["buildings", "water", OCEAN_GROUP_ID]

# Join fragments that meet end to end. OSM splits one street into many ways, so
# welding cuts the number of separate burns sharply and stops a real street
# looking like a pile of stubs to the pruner below.
WELD_CONNECTED_PATHS = True
STUB_WELD_TOLERANCE_MM = 0.03

# Pull a loose end onto the line it nearly meets. OSM is full of ways that stop
# a hair short of the road they join; at full density nobody notices, but once
# the sidewalks and duplicates are gone those near-misses are the visible gaps
# left on the plaque. Nothing is moved further than this. 0 disables.
SNAP_GAP_MM = 0.30

# Remove short fragments that lead nowhere -- the kerb stubs left behind when
# crossings are dropped, plus OSM's own spurs. 0 disables.
PRUNE_DANGLING_STUBS_MM = 0.70

# After culling, report how much of the ORIGINAL linework is still represented
# by some line within CULL_COVERAGE_TOLERANCE_MM. This is the number that says
# whether anything actually disappeared, as opposed to merely being merged into
# a neighbour, so it is worth the extra second.
REPORT_LINE_COVERAGE = True
CULL_COVERAGE_TOLERANCE_MM = 0.20

# Areas exported as an outline instead of a solid fill (stadiums, plazas).
EXPORT_OUTLINES = True
OUTLINE_NAME_HINTS = ["stadium", "pitch"]
OUTLINE_TAG_MATCHES = [("leisure", "stadium"), ("leisure", "pitch")]
OUTLINES_GROUP_ID = "outlines"

# Outer rectangle, for the final cut.
EXPORT_BORDER = True
BORDER_GROUP_ID = "cut_border"

# Decorative border, measured inward from the wood edge.
EXPORT_DECORATIVE_BORDER = True
DECORATIVE_BORDER_GROUP_ID = "decorative_border"
DECORATIVE_BORDER_FILL_GROUP_ID = "decorative_border_band"
OUTER_GAP_MM = 1.50
THICK_BORDER_STROKE_WIDTH_MM = 0.80
THICK_TO_THIN_GAP_MM = 1.00
THIN_BORDER_STROKE_WIDTH_MM = 0.25
INNER_MAP_GAP_MM = 1.50

# Emit the thick border as a closed band assigned to Laser Fill, so it actually
# comes out THICK_BORDER_STROKE_WIDTH_MM wide. Set False to emit it as a stroked
# line instead, which Suite will burn as a single hairline pass regardless of the
# stroke width above.
THICK_BORDER_AS_FILL = True

# Optional map label, inset from the lower-right thin border like the reference
# plaque. Text is converted to vector outlines through Blender, never emitted as
# live SVG text. The box knocks out all map geometry beneath it before its thin
# line border and lettering are added.
# LABEL_TEXT, LABEL_CORNER and LABEL_ROTATION_DEG are at the top of the file.
EXPORT_LABEL = True
# Copperplate Gothic Bold, not Engravers MT. Engravers MT is a high-contrast
# face: on this plaque its main stems come out 0.89 mm wide but its hairlines
# only 0.11 mm, which is at or under the beam, so those strokes burn as one
# pass however the label is set. Copperplate Gothic Bold is near-monoline --
# every stroke 0.97 to 1.06 mm here -- and has no hairline to lose. It is a
# static TTF like Engravers MT, so there is no weight axis to turn either way;
# a heavier or lighter label means a different file on this line.
LABEL_FONT_PATH = r"C:\Windows\Fonts\COPRGTB.TTF"
LABEL_GROUP_ID = "map_label"
LABEL_BORDER_GROUP_ID = "map_label_border"
# The outer plaque keeps the larger 20% default. The lettering is scaled down
# inside it for a little horizontal breathing room.
LABEL_BOX_SCALE = 1.20
LABEL_TEXT_SCALE = 0.95
LABEL_TEXT_HEIGHT_MM = 4.32 * LABEL_BOX_SCALE
LABEL_MAX_TEXT_WIDTH_MM = 43.20 * LABEL_BOX_SCALE
LABEL_PADDING_X_MM = 1.10 * LABEL_BOX_SCALE
LABEL_PADDING_Y_MM = 0.86 * LABEL_BOX_SCALE
LABEL_BORDER_WIDTH_MM = THIN_BORDER_STROKE_WIDTH_MM
LABEL_BORDER_GAP_MM = THICK_TO_THIN_GAP_MM

# Emit each fill group as ONE SVG path with many subpaths, instead of one path
# per solid, WHEN NOTHING IN THAT GROUP CAN OVERLAP.
#
# Bambu Suite lists one object per PATH, not per <g>: the groups below are
# already there and Suite flattens them, which is why a plaque with 300
# buildings arrives as 300 entries in the object list. The label is the proof
# that a path is the unit -- its letters are one path with a subpath per
# contour, and Suite lists them as a single object.
#
# Combining is NOT always safe, which is why it is conditional rather than
# unconditional. A fill rule applies within one path, so two solids that
# OVERLAP would cancel there and burn as bare wood -- invariant 11, and the
# reason a refused union keeps its rings in separate paths. So the exporter
# only combines a group it has a positive reason to believe is disjoint: the
# union reports whether it merged everything it found (nothing refused, nothing
# skipped), the ocean is composed as a single compound path by construction,
# and a knockout hands back boolean output. Anything else stays one path per
# solid and the export log says so. Nothing is merged geometrically either way.
COMBINE_FILL_PATHS = True

# Roads, paths, railways and outlines are exported as bare open polylines:
# fill="none", no closing Z, no outlining, no width baked into the geometry.
# Laser Line traces the path itself, so this stroke width is preview styling
# only -- it is deliberately a hairline so nothing downstream is tempted to
# treat a road as a ribbon with two sides. Raising it does NOT widen the burn.
LINE_STROKE_WIDTH_MM = 0.05

# One colour per laser process. Suite separates artwork by colour, so no two
# groups that need different processes may share one.
SVG_GROUP_STYLES = {
    "buildings": {"fill": "#1A1A1A", "stroke": "none"},
    "water": {"fill": "#1F77B4", "stroke": "none"},
    OCEAN_GROUP_ID: {"fill": "#17557F", "stroke": "none"},
    OUTLINES_GROUP_ID: {"fill": "none", "stroke": "#7F3FBF"},
    "roads": {"fill": "none", "stroke": "#D55E00"},
    "paths": {"fill": "none", "stroke": "#009E73"},
    "railways": {"fill": "none", "stroke": "#8C564B"},
    DECORATIVE_BORDER_GROUP_ID: {"fill": "none", "stroke": "#B8860B"},
    DECORATIVE_BORDER_FILL_GROUP_ID: {"fill": "#B8860B", "stroke": "none"},
    DECKS_GROUP_ID: {"fill": "#C49A6C", "stroke": "none"},
    LABEL_GROUP_ID: {"fill": "#1A1A1A", "stroke": "none"},
    LABEL_BORDER_GROUP_ID: {"fill": "none", "stroke": "#CC79A7"},
    BORDER_GROUP_ID: {"fill": "none", "stroke": "#E31A1C"},
}

# Samples per Bezier segment. blosm emits POLY splines, so this rarely applies.
BEZIER_SAMPLES_PER_SEGMENT = 12

# A face counts as part of the top-down footprint if its world normal points up
# by at least this much. 0.01 keeps very shallow roofs and rejects walls.
UPWARD_NORMAL_Z_MIN = 0.01

# Projected faces smaller than this fraction of the map area are numerical junk.
MIN_PROJECTED_FACE_AREA_RATIO = 1e-12

# blosm often represents a large venue as several overlapping building solids:
# a main footprint plus roof sections and building parts. Merge those into one
# outline with a real polygon union, so nothing downstream has to decide what an
# overlap means. Suite is not documented to honour fill-rule, and under even-odd
# every overlap becomes a white hole -- which is what made buildings look broken.
# Measured on a Vancouver crop: even-odd painted 2941 mm2 of building where
# non-zero painted 3187 mm2. After the union both rules paint 3187 mm2.
# Real courtyards run the opposite way round and stay empty.
UNION_OVERLAPPING_BUILDING_PARTS = True

# Water bodies overlap each other for exactly the same reason building parts do:
# one piece of ground gets mapped more than once. It is not rare and it is not a
# broken extract -- at the Chicago River confluence the South Branch relation,
# the Main Stem relation and the way actually named "The Confluence" all cover
# the junction, and Ogden Slip sits 16 of its 23 nodes inside the main stem.
#
# Overlapping rings in one fill path cancel each other out, so the junction came
# out as bare wood while Blender showed a perfectly solid river. It cancels under
# BOTH fill rules -- even-odd cancels the overlap directly, and non-zero cancels
# it too once nesting has wound the enclosed ring as a hole -- so no fill-rule
# attribute can rescue it. Only a real union can, which is invariant 6.
#
# Measured on a 1.5 km Chicago crop, 33 clipped water rings: 637.17 mm2 of water
# painted before the union, 847.08 mm2 after. 209.91 mm2 -- 24.8% of the river on
# the plaque -- was cancelling itself out. Both rules agree before and after; the
# union is what makes the "after" the correct number.
UNION_OVERLAPPING_WATER = True

# Rings that overlap each other are merged in one go. A dense downtown block can
# chain a few dozen together; the largest cluster on a Vancouver crop was 95.
# Past this, the merge is skipped for that cluster and it falls back to non-zero
# filling, because the work grows as roughly the square of the cluster. Measured
# on 12-sided rings: 400 rings take 1.0 s, 800 take 4.4 s, 1200 take 10.3 s.
MAX_UNION_CLUSTER_RINGS = 800

# Water and ocean are Laser Fill, and so are buildings. A building standing in
# the water therefore burns into the same dark mass as the water around it and
# vanishes -- Canada Place in Vancouver is 513 mm2 of pier building that came out
# invisible. Cut the structure, plus a small unburnt margin, out of the water
# instead, so the silhouette reads against it.
KNOCK_STRUCTURES_OUT_OF_WATER = True

# Width of that unburnt margin, in FINAL MILLIMETRES. This is the gap that makes
# the building legible, so set it from what your laser can hold: below about one
# kerf the two burns close up again.
WATER_KNOCKOUT_HALO_MM = 0.35

# Corners of the margin are rounded with this many segments. 8 is invisible at
# 0.35 mm and keeps the boolean cheap.
WATER_KNOCKOUT_SEGMENTS = 8

# Above this many loops in one object, skip the hole/nesting analysis and rely on
# fill-rule=evenodd alone. Only matters for importers that ignore fill-rule.
MAX_LOOPS_FOR_NESTING = 20000

SVG_DECIMALS = 4

# Export objects that are hidden in the viewport.
INCLUDE_HIDDEN_OBJECTS = True


# --- SHARED LINE CODE (BEGIN) ---
# Mirrored verbatim from jarvizar_lines.py by sync_coastline.py.
# Edit that file, not this block, then re-run: python sync_coastline.py

# --- tag rules ---------------------------------------------------------------

# A way carrying any of these is a sidepath: it traces something else.
SIDEPATH_TAGS = {
    "footway": {"sidewalk", "crossing", "traffic_island", "link"},
    "cycleway": {"crossing", "sidewalk"},
    "path": {"sidewalk", "crossing"},
    "is_sidepath": {"yes"},
    "crossing": {"marked", "unmarked", "zebra", "traffic_signals", "uncontrolled"},
}

# Values of `highway` that describe an AREA rather than a line when area=yes.
AREA_HIGHWAYS = {"pedestrian", "footway", "path", "services", "platform"}

# Railway furniture blosm can emit as closed outlines.
AREA_RAILWAYS = {"platform", "station", "turntable"}


def is_sidepath(tags):
    """True for sidewalks, crossings and other ways that trace a road."""
    for key, unwanted in SIDEPATH_TAGS.items():
        value = tags.get(key)
        if value is not None and str(value).casefold() in unwanted:
            return True
    return False


def is_area_like(tags, closed):
    """
    True for plazas, platforms and other polygons that blosm hands over as
    closed lines. Engraving their outline adds a rectangle nobody asked for.
    """
    if str(tags.get("area", "")).casefold() == "yes":
        return True
    if tags.get("railway") in AREA_RAILWAYS:
        return True
    if closed and tags.get("highway") in AREA_HIGHWAYS:
        return True
    if closed and tags.get("public_transport") in {"platform", "station"}:
        return True
    return False


# Mapped man-made SURFACES: ground you can stand on, even where it sits out over
# water. A pier deck is not sea, so the water fill must not run underneath it --
# which is what made Canada Place in Vancouver read as a building floating in
# the harbour. These are never engraved; they exist to be cut out of the water.
#
# `bridge` is deliberately absent: it would put an unburnt band across every
# river crossing on the map, which is a bigger change than the pier problem
# needs. Add it here if you want that.
DECK_MAN_MADE = {"pier", "breakwater"}

# Area-mapped highways that are a surface rather than a route. Same set the line
# rules already treat as areas, so a way is either a deck or a line, never both.
DECK_HIGHWAYS = {"pedestrian", "footway"}


def is_deck(tags, closed):
    """True for a mapped surface that should read as land, not water."""
    if tags.get("man_made") in DECK_MAN_MADE:
        return True
    if tags.get("highway") in DECK_HIGHWAYS:
        return closed or str(tags.get("area", "")).casefold() == "yes"
    return False


def should_drop_line(tags, closed, drop_sidepaths=True, drop_areas=True):
    if drop_sidepaths and is_sidepath(tags):
        return "sidepath"
    if drop_areas and is_area_like(tags, closed):
        return "area"
    return None


# --- importance ranking -------------------------------------------------------
#
# When two lines shadow each other, the LESS important one must be the one that
# goes. Ranking by road class guarantees a motorway is never dropped in favour
# of a service road that happens to run beside it. Lower number wins.

HIGHWAY_RANK = {
    "motorway": 0, "motorway_link": 0,
    "trunk": 1, "trunk_link": 1,
    "primary": 2, "primary_link": 2,
    "secondary": 3, "secondary_link": 3,
    "tertiary": 4, "tertiary_link": 4,
    "unclassified": 5,
    "residential": 6, "living_street": 6,
    "pedestrian": 7,
    "service": 8,
    "track": 9,
    "cycleway": 10,
    "bridleway": 11,
    "footway": 11, "path": 11, "steps": 11,
}

# blosm layer ids, for when no OSM tags survived the import.
LAYER_RANK = {
    "roads_motorway": 0, "roads_trunk": 1, "roads_primary": 2,
    "roads_secondary": 3, "roads_tertiary": 4, "roads_unclassified": 5,
    "roads_residential": 6, "roads_pedestrian": 7, "roads_service": 8,
    "roads_track": 9, "roads_other": 9,
    "railways": 10, "paths_cycleway": 10,
    "paths_bridleway": 11, "paths_footway": 11, "paths_steps": 11,
}

UNRANKED = 12


def rank_for_tags(tags):
    return HIGHWAY_RANK.get(tags.get("highway"), UNRANKED)


def rank_for_layer(layer):
    if not layer:
        return UNRANKED
    name = str(layer).casefold()
    for key, rank in LAYER_RANK.items():
        if name == key or name.endswith("_" + key):
            return rank
    return UNRANKED


def path_length(path):
    return sum(
        math.hypot(b[0] - a[0], b[1] - a[1])
        for a, b in zip(path[:-1], path[1:])
    )


# --- geometry ----------------------------------------------------------------

def _point_segment_distance_sq(p, a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-18:
        return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_sq
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    ex = p[0] - (a[0] + t * dx)
    ey = p[1] - (a[1] + t * dy)
    return ex * ex + ey * ey


def _unit(a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    n = math.hypot(dx, dy)
    if n <= 1e-18:
        return None
    return dx / n, dy / n


class SegmentGrid:
    """
    Uniform grid over line segments, for "what is near this point" lookups.

    Segments are added incrementally so a culling pass can insert what it keeps
    as it goes, instead of rebuilding the index for every path.
    """

    def __init__(self, paths=(), cell=1.0):
        self.cell = max(cell, 1e-9)
        self.cells = {}
        self.empty = True
        for path in paths:
            self.add(path)

    def _key(self, x, y):
        return (int(math.floor(x / self.cell)), int(math.floor(y / self.cell)))

    def add(self, path):
        for a, b in zip(path[:-1], path[1:]):
            direction = _unit(a, b)
            if direction is None:
                continue
            item = (a, b, direction)
            self.empty = False
            steps = int(math.hypot(b[0] - a[0], b[1] - a[1]) / self.cell) + 1
            seen = set()
            for i in range(steps + 1):
                t = i / steps
                seen.add(self._key(a[0] + (b[0] - a[0]) * t,
                                   a[1] + (b[1] - a[1]) * t))
            for key in seen:
                self.cells.setdefault(key, []).append(item)

    def near(self, point):
        cx, cy = self._key(point[0], point[1])
        out = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                found = self.cells.get((cx + dx, cy + dy))
                if found:
                    out.extend(found)
        return out


def _sample_points(a, b, spacing, cap=8):
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    count = int(length / spacing) if spacing > 0 else 0
    count = max(1, min(count, cap))
    return [
        (a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count)
        for i in range(count + 1)
    ]


def _shadowed(a, b, direction, grid, threshold_sq, cos_limit, spacing):
    """Fraction of this segment that runs close to and parallel with the grid."""
    samples = _sample_points(a, b, spacing)
    hits = 0
    for point in samples:
        for oa, ob, other_dir in grid.near(point):
            if _point_segment_distance_sq(point, oa, ob) > threshold_sq:
                continue
            dot = direction[0] * other_dir[0] + direction[1] * other_dir[1]
            if abs(dot) >= cos_limit:
                hits += 1
                break
    return hits, len(samples)


def cull_against_grid(paths, grid, min_separation, max_angle_deg=30.0,
                      min_run_length=0.0):
    """Cull `paths` against a prebuilt SegmentGrid. Returns (kept, removed_mm)."""
    if not paths or min_separation <= 0.0 or grid.empty:
        return list(paths), 0.0

    threshold_sq = min_separation * min_separation
    cos_limit = math.cos(math.radians(max_angle_deg))

    kept = []
    removed_length = 0.0

    for path in paths:
        run = []
        for a, b in zip(path[:-1], path[1:]):
            direction = _unit(a, b)
            if direction is None:
                continue

            hits, total = _shadowed(
                a, b, direction, grid, threshold_sq, cos_limit, min_separation
            )

            # Most of the piece has to be shadowed before it is dropped, so a
            # segment that merely touches a road survives.
            if hits * 5 >= total * 3:
                if len(run) >= 2:
                    kept.append(run)
                run = []
                removed_length += math.hypot(b[0] - a[0], b[1] - a[1])
                continue

            if not run:
                run = [a, b]
            else:
                run.append(b)

        if len(run) >= 2:
            kept.append(run)

    if min_run_length > 0.0:
        trimmed = []
        for path in kept:
            length = sum(
                math.hypot(b[0] - a[0], b[1] - a[1])
                for a, b in zip(path[:-1], path[1:])
            )
            if length >= min_run_length:
                trimmed.append(path)
            else:
                removed_length += length
        kept = trimmed

    return kept, removed_length


def cull_overlapping(paths, against, min_separation, max_angle_deg=30.0,
                     min_run_length=0.0):
    """
    Drop the parts of `paths` that shadow a line in `against`.

    A piece is redundant when it runs within `min_separation` of another line
    AND within `max_angle_deg` of parallel to it. Perpendicular approaches are
    never culled, so junctions stay connected.

    Returns (kept_paths, removed_length).
    """
    if not paths or not against or min_separation <= 0.0:
        return list(paths), 0.0

    grid = against if isinstance(against, SegmentGrid) else SegmentGrid(
        against, min_separation
    )
    return cull_against_grid(
        paths, grid, min_separation, max_angle_deg, min_run_length
    )


def cull_self_duplicates(paths, min_separation, max_angle_deg=15.0):
    """
    Remove geometry duplicated WITHIN one group.

    Two ways digitised along the same alignment burn the same line twice. Each
    path is tested against the ones already kept -- the index grows as we go,
    rather than being rebuilt per path, so this stays linear in practice.
    """
    if min_separation <= 0.0 or len(paths) < 2:
        return list(paths), 0.0

    grid = SegmentGrid((), min_separation)
    kept = []
    removed_length = 0.0

    for path in sorted(paths, key=len, reverse=True):
        survivors, removed = cull_against_grid(
            [path], grid, min_separation, max_angle_deg
        )
        removed_length += removed
        for survivor in survivors:
            grid.add(survivor)
            kept.append(survivor)

    return kept, removed_length

def cull_ranked(items, min_separation, max_angle_deg=30.0,
                whole_paths=True, shadow_fraction=0.7, min_run_length=0.0):
    """
    Cull a whole map's linework in one ranked pass.

    `items` is an iterable of (rank, key, path); lower rank is more important
    and is processed -- and therefore kept -- first. Everything is culled
    against everything already accepted, so this handles duplicated geometry and
    parallel sidepaths in the same sweep.

    With `whole_paths` (the default) a path is either kept entire or dropped
    entire, decided by how much of its length is shadowed. That is what stops
    culling from introducing new broken ends mid-road. Set it False to trim
    paths segment by segment instead, which removes more but fragments. It may
    also be a callable receiving the item's key, for group-specific behaviour.

    Returns (kept, stats) where kept is a list of (rank, key, path).
    """
    ordered = sorted(items, key=lambda item: (item[0], -path_length(item[2])))
    grid = SegmentGrid((), max(min_separation, 1e-9))
    threshold_sq = min_separation * min_separation
    cos_limit = math.cos(math.radians(max_angle_deg))

    kept = []
    stats = {"dropped": 0, "trimmed": 0, "removed_length": 0.0}

    for rank, key, path in ordered:
        if min_separation <= 0.0 or grid.empty:
            kept.append((rank, key, path))
            grid.add(path)
            continue

        shadowed_length = 0.0
        total_length = 0.0
        flags = []

        for a, b in zip(path[:-1], path[1:]):
            direction = _unit(a, b)
            if direction is None:
                flags.append(False)
                continue
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            hits, samples = _shadowed(
                a, b, direction, grid, threshold_sq, cos_limit, min_separation
            )
            is_shadowed = hits * 5 >= samples * 3
            flags.append(is_shadowed)
            total_length += length
            if is_shadowed:
                shadowed_length += length

        if total_length <= 0.0:
            continue

        keep_whole = whole_paths(key) if callable(whole_paths) else whole_paths
        if keep_whole:
            if shadowed_length / total_length >= shadow_fraction:
                stats["dropped"] += 1
                stats["removed_length"] += total_length
            else:
                kept.append((rank, key, path))
                grid.add(path)
            continue

        run = []
        pieces = []
        for (a, b), is_shadowed in zip(zip(path[:-1], path[1:]), flags):
            if is_shadowed:
                if len(run) >= 2:
                    pieces.append(run)
                run = []
                stats["removed_length"] += math.hypot(b[0] - a[0], b[1] - a[1])
                continue
            run = [a, b] if not run else run + [b]
        if len(run) >= 2:
            pieces.append(run)

        if len(pieces) != 1 or pieces[0] != path:
            stats["trimmed"] += 1
        for piece in pieces:
            if min_run_length > 0.0 and path_length(piece) < min_run_length:
                stats["removed_length"] += path_length(piece)
                continue
            kept.append((rank, key, piece))
            grid.add(piece)

    return kept, stats


def prune_dangling_stubs(items, max_stub_length, weld_tolerance,
                         on_boundary=None):
    """
    Remove short fragments that lead nowhere.

    Deleting sidewalks and crossings leaves the walkway that used to reach them
    stopping at the kerb, and OSM itself is full of short spurs. Both read as a
    road that stops just short of an intersection.

    An end counts as CONNECTED when any other path passes within tolerance of
    it -- not merely when another path's endpoint coincides with it. That
    distinction matters enormously after welding: a side street almost always
    meets the MIDDLE of a welded main road, and judging by endpoints alone
    declares those junctions dangling and deletes the side street, punching a
    hole in the network.

    `on_boundary(point)` marks endpoints that leave the crop: those are clipped,
    not dangling. A fragment connected at both ends is never removed, however
    short, so real links between roads survive.

    `max_stub_length` may be a callable receiving the item's key, so less
    important line groups can be pruned more aggressively.

    Returns (kept_items, removed_count).
    """
    if not items:
        return list(items), 0
    if not callable(max_stub_length) and max_stub_length <= 0.0:
        return list(items), 0

    tolerance = max(weld_tolerance, 1e-12)
    tolerance_sq = tolerance * tolerance
    alive = list(items)
    lengths = [path_length(item[2]) for item in alive]
    limits = [
        max(0.0, float(
            max_stub_length(item[1])
            if callable(max_stub_length) else max_stub_length
        ))
        for item in alive
    ]
    anchored = [
        (bool(on_boundary and on_boundary(item[2][0])),
         bool(on_boundary and on_boundary(item[2][-1])))
        for item in alive
    ]

    # Spatial index of segments, tagged with the path they belong to, so an
    # endpoint can be tested against every OTHER path including mid-span.
    cell = max(tolerance * 4.0, 1e-9)
    buckets = {}

    def key(x, y):
        return (int(math.floor(x / cell)), int(math.floor(y / cell)))

    for index, (_, _, path) in enumerate(alive):
        for a, b in zip(path[:-1], path[1:]):
            steps = int(math.hypot(b[0] - a[0], b[1] - a[1]) / cell) + 1
            seen = set()
            for i in range(steps + 1):
                t = i / steps
                seen.add(key(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            for k in seen:
                buckets.setdefault(k, []).append((index, a, b))

    def supporters(index, point):
        """Other live paths touching this point."""
        cx, cy = key(point[0], point[1])
        found = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other, a, b in buckets.get((cx + dx, cy + dy), ()):
                    if other == index:
                        continue
                    if _point_segment_distance_sq(point, a, b) <= tolerance_sq:
                        found.add(other)
        return found

    support = [
        (supporters(i, item[2][0]), supporters(i, item[2][-1]))
        for i, item in enumerate(alive)
    ]

    # Reverse map, so removing a path can cheaply invalidate whoever leaned on it.
    dependents = {}
    for index, (first, last) in enumerate(support):
        for other in first | last:
            dependents.setdefault(other, set()).add(index)

    removed_flags = [False] * len(alive)

    def is_stub(index):
        if (removed_flags[index] or limits[index] <= 0.0
                or lengths[index] >= limits[index]):
            return False
        first, last = support[index]
        free_first = not any(not removed_flags[o] for o in first)
        free_last = not any(not removed_flags[o] for o in last)
        return (
            (free_first and not anchored[index][0])
            or (free_last and not anchored[index][1])
        )

    queue = [i for i in range(len(alive)) if is_stub(i)]
    removed = 0

    while queue:
        index = queue.pop()
        if not is_stub(index):
            continue
        removed_flags[index] = True
        removed += 1
        for other in dependents.get(index, ()):
            if not removed_flags[other] and is_stub(other):
                queue.append(other)

    return [item for item, gone in zip(alive, removed_flags) if not gone], removed


def weld_paths(items, tolerance, group_fn=None):
    """
    Join fragments that meet end to end into single continuous polylines.

    OSM splits one street into many ways wherever a tag changes, and a park
    walkway can be a dozen short pieces. Welding them matters twice over: the
    laser stops lifting and re-starting mid-street, and a genuine long route
    stops looking like a pile of short stubs to the pruner below.

    Only fragments in the same group are welded, so a footpath never merges
    into a road and inherit its process. Junctions where three or more
    fragments meet are left alone -- there is no single correct continuation.

    Returns (welded_items, joins_made).
    """
    if tolerance <= 0.0 or len(items) < 2:
        return list(items), 0

    group_fn = group_fn or (lambda key: None)
    quantum = max(tolerance, 1e-12)

    def node(point):
        return (round(point[0] / quantum), round(point[1] / quantum))

    buckets = {}
    for item in items:
        buckets.setdefault(group_fn(item[1]), []).append(item)

    output = []
    joins = 0

    for bucket in buckets.values():
        paths = [list(item[2]) for item in bucket]
        meta = [(item[0], item[1]) for item in bucket]

        # endpoint node -> [(path index, is_tail)]
        at_node = {}
        for index, path in enumerate(paths):
            at_node.setdefault(node(path[0]), []).append((index, False))
            at_node.setdefault(node(path[-1]), []).append((index, True))

        used = [False] * len(paths)

        def continuation(index, tail):
            """The single other fragment continuing from this end, if any."""
            key = node(paths[index][-1] if tail else paths[index][0])
            here = at_node.get(key, ())
            if len(here) != 2:
                return None
            for other, other_tail in here:
                if other != index and not used[other]:
                    return other, other_tail
            return None

        order = sorted(range(len(paths)), key=lambda i: -len(paths[i]))
        for start in order:
            if used[start]:
                continue
            used[start] = True
            chain = list(paths[start])
            rank, key = meta[start]

            # Grow forwards, then backwards.
            for forwards in (True, False):
                while True:
                    end_point = chain[-1] if forwards else chain[0]
                    at = at_node.get(node(end_point), ())
                    if len(at) != 2:
                        break
                    nxt = None
                    for other, other_tail in at:
                        if not used[other]:
                            nxt = (other, other_tail)
                            break
                    if nxt is None:
                        break
                    other, other_tail = nxt
                    used[other] = True
                    piece = list(paths[other])
                    if other_tail:
                        piece.reverse()
                    joins += 1
                    if forwards:
                        chain.extend(piece[1:])
                    else:
                        chain = list(reversed(piece[1:])) + chain
                    rank = min(rank, meta[other][0])

            output.append((rank, key, chain))

    return output, joins

def _tagged_segment_index(items, cell):
    """cell -> [(path index, a, b)], so a point can be tested against OTHER paths."""
    buckets = {}

    def key(x, y):
        return (int(math.floor(x / cell)), int(math.floor(y / cell)))

    for index, (_, _, path) in enumerate(items):
        for a, b in zip(path[:-1], path[1:]):
            steps = int(math.hypot(b[0] - a[0], b[1] - a[1]) / cell) + 1
            seen = set()
            for i in range(steps + 1):
                t = i / steps
                seen.add(key(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            for k in seen:
                buckets.setdefault(k, []).append((index, a, b))

    return buckets, key


def prune_compact_tangles(items, max_span, min_segments,
                          min_length_to_span, touch_tolerance,
                          target_fn=None):
    """
    Remove tiny, line-dense components from a selected line group.

    A compact maze of mutually connected footpath splines can have no dangling
    end and no nearby parallel road. Ordinary culling and stub pruning therefore
    keep it even when it is far too dense to engrave. Candidate splines are
    joined into components when an endpoint touches another candidate's line;
    only components that are both physically small and unusually line-dense
    are removed. A simple loop stays below the length/span threshold.

    `target_fn`, when supplied, receives an item's key. Returns
    (kept_items, removed_path_count).
    """
    if (not items or max_span <= 0.0 or min_segments <= 0
            or min_length_to_span <= 0.0):
        return list(items), 0

    alive = list(items)
    candidate_indices = []
    for index, (_, item_key, path) in enumerate(alive):
        if target_fn and not target_fn(item_key):
            continue
        if len(path) < 2:
            continue
        xs = [point[0] for point in path]
        ys = [point[1] for point in path]
        span = math.hypot(max(xs) - min(xs), max(ys) - min(ys))
        if span <= max_span:
            candidate_indices.append(index)

    if not candidate_indices:
        return alive, 0

    candidates = [alive[index] for index in candidate_indices]
    tolerance = max(touch_tolerance, 1e-12)
    tolerance_sq = tolerance * tolerance
    buckets, bucket_key = _tagged_segment_index(
        candidates, max(tolerance * 4.0, 1e-9)
    )

    parent = list(range(len(candidates)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(first, second):
        first_root = root(first)
        second_root = root(second)
        if first_root != second_root:
            parent[second_root] = first_root

    for index, (_, _, path) in enumerate(candidates):
        for point in (path[0], path[-1]):
            cx, cy = bucket_key(point[0], point[1])
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other, a, b in buckets.get((cx + dx, cy + dy), ()):
                        if other != index and (
                            _point_segment_distance_sq(point, a, b) <= tolerance_sq
                        ):
                            union(index, other)

    components = {}
    for index in range(len(candidates)):
        components.setdefault(root(index), []).append(index)

    removed_local = set()
    for component in components.values():
        paths = [candidates[index][2] for index in component]
        points = [point for path in paths for point in path]
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        span = math.hypot(max(xs) - min(xs), max(ys) - min(ys))
        segments = sum(max(0, len(path) - 1) for path in paths)
        total_length = sum(path_length(path) for path in paths)
        if (span <= max_span and segments >= min_segments
                and total_length >= min_length_to_span * max(span, 1e-12)):
            removed_local.update(component)

    removed_global = {candidate_indices[index] for index in removed_local}
    return (
        [item for index, item in enumerate(alive) if index not in removed_global],
        len(removed_global),
    )


def collapse_filled_loops(items, min_open_radius, touch_tolerance):
    """
    Turn a ring the beam simply fills into the junction it actually is.

    A turning circle or a small roundabout encloses less wood than the beam is
    wide, so it does not burn as a ring: it burns as a solid dot, and a dot is
    what stands out on the finished plaque. Culling cannot help -- it compares
    a path against OTHER paths, and a ring is only ever close to itself.

    Deleting the ring is not the answer either: every road that met it would
    stop in mid-air a diameter short of the others, which is the gap that
    welding and snapping exist to prevent. So the ring is contracted to its
    centre and everything that touched it is brought to that same point. The
    dot becomes a plain junction, the ink goes away, and nothing comes apart.

    Only CLOSED paths are eligible, which is what keeps this off ordinary
    crossroads: an intersection of four streets is a cycle in the network but
    it is not a closed path, and on the Chicago plaque 1161 network cycles fit
    inside a 0.9 mm disc while only 15 closed rings enclose less than
    `min_open_radius`. Contracting the former was tried and wrecked the map --
    it dragged whole road bundles into starbursts.

    `min_open_radius` is the radius of white the ring has to keep to read as a
    ring; set it from the beam, not from the map. Returns (kept, collapsed).
    """
    if not items or min_open_radius <= 0.0:
        return list(items), 0

    collapses = []
    doomed = set()
    for index, (_, _, path) in enumerate(items):
        if len(path) < 4:
            continue
        if math.hypot(path[-1][0] - path[0][0],
                      path[-1][1] - path[0][1]) > touch_tolerance:
            continue
        area = abs(sum(a[0] * b[1] - b[0] * a[1]
                       for a, b in zip(path[:-1], path[1:]))) * 0.5
        perimeter = path_length(path)
        if perimeter <= 1e-9:
            continue
        # Radius of the largest disc of untouched wood the ring can hold.
        if 2.0 * area / perimeter >= min_open_radius:
            continue
        cx = sum(p[0] for p in path[:-1]) / (len(path) - 1)
        cy = sum(p[1] for p in path[:-1]) / (len(path) - 1)
        reach = max(math.hypot(p[0] - cx, p[1] - cy) for p in path)
        collapses.append(((cx, cy), reach + touch_tolerance, path))
        doomed.add(index)

    if not collapses:
        return list(items), 0

    # Deterministic, so two runs of the exporter agree.
    collapses.sort(key=lambda c: c[0])

    # Index the rings by cell, so rebuilding the map does not test every vertex
    # against every ring. A default blosm import is tens of thousands of
    # vertices and a big crop can hold hundreds of rings.
    cell = max(max(reach for _, reach, _ in collapses), 1e-9)
    lookup = {}
    for entry in collapses:
        (cx, cy), reach, _ = entry
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                key = (int(math.floor(cx / cell)) + dx,
                       int(math.floor(cy / cell)) + dy)
                lookup.setdefault(key, []).append(entry)

    def moved(point, endpoint):
        key = (int(math.floor(point[0] / cell)),
               int(math.floor(point[1] / cell)))
        for centre, reach, ring in lookup.get(key, ()):
            if (math.hypot(point[0] - centre[0], point[1] - centre[1])
                    > reach):
                continue
            # A vertex sitting ON the ring is part of the junction. So is any
            # loose END inside it: OSM routinely stops a footway a hair short
            # of the circle it joins, and leaving that one behind while the
            # ring goes is exactly the gap this is trying not to make.
            if endpoint or any(
                _point_segment_distance_sq(point, a, b)
                <= touch_tolerance * touch_tolerance
                for a, b in zip(ring[:-1], ring[1:])
            ):
                return centre
        return point

    kept = []
    for index, (rank, key, path) in enumerate(items):
        if index in doomed:
            continue
        rebuilt = []
        for position, point in enumerate(path):
            new_point = moved(point, position in (0, len(path) - 1))
            if not rebuilt or (rebuilt[-1][0] != new_point[0]
                               or rebuilt[-1][1] != new_point[1]):
                rebuilt.append(new_point)
        if len(rebuilt) >= 2:
            kept.append((rank, key, rebuilt))

    return kept, len(collapses)


def _alongside(point, a, b, threshold_sq):
    """
    Is `point` within reach of the INSIDE of segment a->b?

    "Another line runs along this one" has to mean beside it, not past the end
    of it. A short link's own neighbours in the network are collinear with it
    and touch it, so measuring to their nearest endpoint reports every link in
    a mesh as fully doubled by the very paths it connects to -- and removing it
    on that basis is removing it for being connected. Requiring the closest
    point to be strictly INSIDE the neighbour draws the line between a
    carriageway running beside a street and the same street carrying on.
    """
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-18:
        return False
    t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_sq
    if t <= 0.0 or t >= 1.0:
        return False
    ex = point[0] - (a[0] + t * dx)
    ey = point[1] - (a[1] + t * dy)
    return ex * ex + ey * ey <= threshold_sq


def _interior_samples(a, b, spacing, cap=8):
    """
    Sample strictly inside a segment.

    The endpoints are the one place a line is guaranteed to touch its
    neighbours, so including them biases every short path towards looking
    doubled.
    """
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    count = int(length / spacing) if spacing > 0 else 0
    count = max(1, min(count, cap))
    return [
        (a[0] + (b[0] - a[0]) * (i + 0.5) / count,
         a[1] + (b[1] - a[1]) * (i + 0.5) / count)
        for i in range(count)
    ]


def relieve_dense_clusters(items, density_limit, window, separation,
                           max_angle_deg=30.0, hot_fraction=0.6,
                           shadow_fraction=0.8, protect_rank=-1,
                           mesh_max_length=0.0, mesh_detour=4.0,
                           weld_tolerance=0.03, covered_fn=None,
                           covered_limit_scale=1.0, target_fn=None):
    """
    Thin the darkest patches of the map, and only those.

    Ordinary culling is PAIRWISE: it asks whether this line runs along that
    one. It therefore never notices that a dozen individually legal
    neighbours have piled into one square millimetre, which is what burns as
    a black knot -- a roundabout traced twice, a plaza's footpaths, four
    carriageways and their footways side by side. Raising
    MIN_LINE_SEPARATION_MM everywhere does fix those, but it is a tax on the
    whole map: measured on the Chicago plaque, 0.22 -> 0.35 mm took coverage
    from 98.1% to 92.4% and put the count of facing road ends UP from 354 to
    555, which is the gap regression welding exists to prevent.

    So measure the pile directly -- millimetres of line per square
    millimetre of wood, read over a `window` mm box -- and apply the wider
    `separation` ONLY inside cells over `density_limit`. Everywhere else
    keeps exactly the behaviour it had.

    A path is eligible when `hot_fraction` of it lies in those cells, and it
    is taken only when `shadow_fraction` of it already runs along a line that
    is staying. The removal test is the same one culling uses, close AND
    parallel, so a path running INTO the cluster is never taken and the
    junction survives.
    Candidates are offered least-important-first, so a service road's
    duplicate goes before the arterial beside it is even considered, and the
    grid is updated after every removal: once a patch is back under the
    limit, the rest of its lines stop being candidates. That is what stops
    this from hollowing out a dense area instead of thinning it.

    `protect_rank` puts a floor under all of it: nothing that important or
    better is ever removed on density grounds, whatever it runs beside. A
    through-street with a cycle track laid along it is shadowed end to end
    and would otherwise go -- on the Chicago plaque that took out 86 secondary
    and 5 trunk roads, including North Dearborn in front of Block 37.

    `covered_fn` marks ground a Laser FILL already burns solid, and on that
    ground the limit is multiplied by `covered_limit_scale`. It is already at
    100% ink before a line is drawn on it, so a line there is a second pass over
    the same wood: it cannot be seen, and it scorches. On the Chicago plaque the
    footpath mesh over the Lakeshore East podium measured only 2.19 mm/mm2 of
    line -- nowhere near the plain limit -- yet burned darker than every
    building around it for exactly this reason.

    Scaling the limit rather than declaring covered ground hot outright is the
    proportionate version: a lone footway crossing a building is nowhere near
    even the tightened limit and is never looked at, while a mesh piled on a
    podium is. That is deliberate, and this must not become a ban on lines
    inside buildings: being hot only makes a path a CANDIDATE. It still has to
    be a duplicate or a redundant mesh link to be removed, and `protect_rank`
    still keeps every street.

    MESH THINNING is the second removal test, for the case the shadow test
    cannot reach: a plaza or podium criss-crossed by short footpaths, where
    nothing is a duplicate of anything but the whole block still burns as one
    black mass. A link shorter than `mesh_max_length` may be dropped when its
    two ends REMAIN CONNECTED to each other without it, by a detour no longer
    than `mesh_detour` times its own length. That is a graph fact, not an
    estimate, so nothing can come apart: every junction the link served is
    still reachable, and every OTHER path keeps both its ends. A street is
    never eligible -- welding has already made it far longer than any sane
    `mesh_max_length`, and `protect_rank` rules it out anyway.

    Returns (kept, stats).
    """
    stats = {"dropped": 0, "removed_length": 0.0, "hot_cells": 0,
             "considered": 0, "mesh_dropped": 0}
    if (not items or density_limit <= 0.0 or window <= 0.0
            or separation <= 0.0):
        return list(items), stats

    cell = window / 3.0
    step = cell * 0.5

    def cell_key(x, y):
        return (int(math.floor(x / cell)), int(math.floor(y / cell)))

    load = {}

    def deposit(path, sign):
        """Spread a path's length over the cells it crosses."""
        for a, b in zip(path[:-1], path[1:]):
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            if length <= 1e-12:
                continue
            count = int(length / step) + 1
            share = sign * length / count
            for i in range(count):
                t = (i + 0.5) / count
                key = cell_key(a[0] + (b[0] - a[0]) * t,
                               a[1] + (b[1] - a[1]) * t)
                load[key] = load.get(key, 0.0) + share

    for _, _, path in items:
        deposit(path, 1.0)

    # Density is read over the 3x3 block around a cell, so `window` is the
    # size of the patch the eye reads, not of the bookkeeping cell.
    block_area = (3.0 * cell) ** 2

    covered_limit = density_limit * covered_limit_scale

    def is_hot(point):
        cx, cy = cell_key(point[0], point[1])
        total = 0.0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                total += load.get((cx + dx, cy + dy), 0.0)
        limit = density_limit
        if covered_fn is not None and covered_fn(point):
            limit = covered_limit
        return total / block_area > limit

    stats["hot_cells"] = sum(
        1 for key in load if is_hot(((key[0] + 0.5) * cell,
                                     (key[1] + 0.5) * cell))
    )

    buckets, bucket_key = _tagged_segment_index(items, max(separation, 1e-9))
    threshold_sq = separation * separation
    cos_limit = math.cos(math.radians(max_angle_deg))
    removed = set()

    def shadowed_fraction(index, path):
        """How much of this path a SURVIVING line already runs along."""
        hit = total = 0.0
        for a, b in zip(path[:-1], path[1:]):
            direction = _unit(a, b)
            if direction is None:
                continue
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            total += length
            for point in _interior_samples(a, b, separation):
                cx, cy = bucket_key(point[0], point[1])
                found = False
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for other, oa, ob in buckets.get((cx + dx, cy + dy), ()):
                            if other == index or other in removed:
                                continue
                            if not _alongside(point, oa, ob, threshold_sq):
                                continue
                            other_dir = _unit(oa, ob)
                            if other_dir is None:
                                continue
                            dot = (direction[0] * other_dir[0]
                                   + direction[1] * other_dir[1])
                            if abs(dot) >= cos_limit:
                                found = True
                                break
                        if found:
                            break
                    if found:
                        break
                if found:
                    hit += length
                    break
        return (hit / total) if total > 0.0 else 0.0

    # Vertex graph, for the mesh test. Every polyline vertex is a node and
    # every segment an edge, tagged with the path it came from. Endpoints
    # alone are not enough: in a mesh most links meet the MIDDLE of another
    # link, and OSM shares that vertex, so an endpoint-only graph comes apart
    # into fragments and the test can never answer yes. Built once; removing a
    # path just marks its edges dead.
    quantum = max(weld_tolerance, 1e-12)

    def node_of(point):
        return (round(point[0] / quantum), round(point[1] / quantum))

    adjacency = {}
    endpoints = [(None, None, 0.0)] * len(items)
    if mesh_max_length > 0.0:
        for index, (_, _, path) in enumerate(items):
            nodes = [node_of(point) for point in path]
            for (a, b), (u, v) in zip(zip(path[:-1], path[1:]),
                                      zip(nodes[:-1], nodes[1:])):
                if u == v:
                    continue
                # NOT `step`: that name is the density sampling stride, and
                # clobbering it silently reduces every path to two samples.
                edge_length = math.hypot(b[0] - a[0], b[1] - a[1])
                adjacency.setdefault(u, []).append((v, index, edge_length))
                adjacency.setdefault(v, []).append((u, index, edge_length))
            endpoints[index] = (nodes[0], nodes[-1], path_length(path))

    def still_connected(index):
        """Do this path's two ends still reach each other without it?"""
        start_node, goal, length = endpoints[index]
        if start_node is None or start_node == goal:
            return False
        budget = length * mesh_detour
        # Cost-bounded search. The budget is what keeps it local and cheap: a
        # mesh link's way round is a cell or two, never half the map.
        best = {start_node: 0.0}
        stack = [(start_node, 0.0)]
        while stack:
            node, cost = stack.pop()
            if cost > best.get(node, cost):
                continue
            for other, edge, step in adjacency.get(node, ()):
                if edge == index or edge in removed:
                    continue
                reached = cost + step
                if reached > budget or reached >= best.get(other, budget + 1.0):
                    continue
                if other == goal:
                    return True
                best[other] = reached
                stack.append((other, reached))
        return False

    # Least important first, shortest first, then by position so the result
    # does not depend on the order the layers happened to arrive in.
    order = sorted(
        range(len(items)),
        key=lambda i: (-items[i][0], path_length(items[i][2]),
                       items[i][2][0]),
    )

    for index in order:
        rank, key, path = items[index]
        if rank <= protect_rank:
            # Important enough that no amount of local darkness justifies
            # removing it. This is the floor invariant 1 relies on.
            continue
        if target_fn and not target_fn(key):
            continue
        if len(path) < 2:
            continue

        samples = [point for a, b in zip(path[:-1], path[1:])
                   for point in _sample_points(a, b, step)]
        if not samples:
            continue
        hot = sum(1 for point in samples if is_hot(point))
        if hot < hot_fraction * len(samples):
            continue

        stats["considered"] += 1
        mesh = False
        if shadowed_fraction(index, path) < shadow_fraction:
            # Nothing runs along it, so it is not a duplicate. It may still be
            # one strand of a mesh too fine to read, and a strand whose ends
            # stay joined without it can go without breaking anything.
            if (mesh_max_length <= 0.0
                    or path_length(path) > mesh_max_length
                    or not still_connected(index)):
                continue
            mesh = True

        removed.add(index)
        if mesh:
            stats["mesh_dropped"] += 1
        deposit(path, -1.0)
        stats["dropped"] += 1
        stats["removed_length"] += path_length(path)

    return (
        [item for i, item in enumerate(items) if i not in removed],
        stats,
    )


def _closest_point_on_segment(p, a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-18:
        return a
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_sq
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return (a[0] + t * dx, a[1] + t * dy)


def snap_dangling_ends(items, snap_tolerance, touch_tolerance, on_boundary=None):
    """
    Pull a loose end onto the line it nearly meets.

    OSM is full of ways that stop a hair short of the road they join. At full
    density nobody notices, but once the sidewalks and duplicates are gone those
    near-misses are the visible gaps left on the plaque. Anything already
    touching is left alone, endpoints that leave the crop are left alone, and
    nothing is ever moved further than `snap_tolerance`, so this closes gaps
    without inventing junctions.

    Returns (items, snapped_count).
    """
    if snap_tolerance <= 0.0 or len(items) < 2:
        return list(items), 0

    cell = max(snap_tolerance * 2.0, 1e-9)
    buckets, key = _tagged_segment_index(items, cell)
    snap_sq = snap_tolerance * snap_tolerance
    touch_sq = touch_tolerance * touch_tolerance

    output = []
    snapped = 0

    for index, (rank, item_key, path) in enumerate(items):
        path = list(path)

        # A path no longer than the gap it would be snapped across is a nub, not
        # a road that stops short. Snapping one collapses it to zero length and
        # leaves a degenerate path for the welder to trip over; leave it for the
        # stub pruner instead.
        if path_length(path) <= snap_tolerance:
            output.append((rank, item_key, path))
            continue

        for end in (0, -1):
            point = path[end]
            if on_boundary and on_boundary(point):
                continue

            cx, cy = key(point[0], point[1])
            best = None
            best_distance = None
            already_touching = False

            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other, a, b in buckets.get((cx + dx, cy + dy), ()):
                        if other == index:
                            continue
                        distance = _point_segment_distance_sq(point, a, b)
                        if distance <= touch_sq:
                            already_touching = True
                            break
                        if distance <= snap_sq and (
                            best_distance is None or distance < best_distance
                        ):
                            best_distance = distance
                            best = (a, b)
                    if already_touching:
                        break
                if already_touching:
                    break

            if already_touching or best is None:
                continue

            target = _closest_point_on_segment(point, best[0], best[1])
            neighbour = path[1] if end == 0 else path[-2]
            # Never collapse the segment we are moving.
            if math.hypot(target[0] - neighbour[0],
                          target[1] - neighbour[1]) <= touch_tolerance:
                continue

            path[end] = target
            snapped += 1

        output.append((rank, item_key, path))

    return output, snapped

# --- SHARED LINE CODE (END) ---


# --- SHARED COASTLINE CODE (BEGIN) ---
# Mirrored verbatim from jarvizar_coastline.py by sync_coastline.py.
# Edit that file, not this block, then re-run: python sync_coastline.py

# Chains shorter than this carry no usable direction information.
MIN_CHAIN_POINTS = 2

# Seeds used to sanity check the land/water side. Subsampled for speed.
MAX_ORIENTATION_SEEDS = 800


# -----------------------------------------------------------------------------
# geometry primitives
# -----------------------------------------------------------------------------

def polygon_area(points):
    """Signed area. Positive is counter-clockwise in a Y-up coordinate system."""
    if len(points) < 3:
        return 0.0
    total = 0.0
    for i, p in enumerate(points):
        q = points[(i + 1) % len(points)]
        total += p[0] * q[1] - q[0] * p[1]
    return 0.5 * total


def point_in_polygon(point, polygon):
    x, y = point
    inside = False
    previous = polygon[-1]
    for current in polygon:
        xi, yi = current
        xj, yj = previous
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        previous = current
    return inside


def polygon_bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), max(xs), min(ys), max(ys)


def point_in_bbox(point, bbox):
    return bbox[0] <= point[0] <= bbox[1] and bbox[2] <= point[1] <= bbox[3]


def rect_eps(rect):
    xmin, xmax, ymin, ymax = rect
    return max(max(xmax - xmin, ymax - ymin) * 1e-9, 1e-12)


def same_point(a, b, eps):
    return abs(a[0] - b[0]) <= eps and abs(a[1] - b[1]) <= eps


# -----------------------------------------------------------------------------
# rectangle boundary parameterisation (counter-clockwise, Y up)
# -----------------------------------------------------------------------------

def rect_perimeter(rect):
    xmin, xmax, ymin, ymax = rect
    return 2.0 * ((xmax - xmin) + (ymax - ymin))


def rect_ring(rect):
    xmin, xmax, ymin, ymax = rect
    return [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)]


def clamp_to_rect(point, rect):
    """Push a point that should be on the rectangle edge exactly onto it."""
    xmin, xmax, ymin, ymax = rect
    x = min(max(point[0], xmin), xmax)
    y = min(max(point[1], ymin), ymax)

    candidates = (
        (abs(x - xmin), (xmin, y)),
        (abs(xmax - x), (xmax, y)),
        (abs(y - ymin), (x, ymin)),
        (abs(ymax - y), (x, ymax)),
    )
    return min(candidates, key=lambda item: item[0])[1]


def rect_param_ccw(point, rect):
    """
    Distance travelled counter-clockwise from the bottom-left corner.

    CCW order with Y up: bottom edge -> right edge -> top edge -> left edge.
    """
    xmin, xmax, ymin, ymax = rect
    width = xmax - xmin
    height = ymax - ymin
    x, y = clamp_to_rect(point, rect)

    candidates = (
        (abs(y - ymin), x - xmin),
        (abs(x - xmax), width + (y - ymin)),
        (abs(y - ymax), width + height + (xmax - x)),
        (abs(x - xmin), width + height + width + (ymax - y)),
    )
    return min(candidates, key=lambda item: item[0])[1] % rect_perimeter(rect)


def rect_corner_params(rect):
    xmin, xmax, ymin, ymax = rect
    width = xmax - xmin
    height = ymax - ymin
    return (
        (0.0, (xmin, ymin)),
        (width, (xmax, ymin)),
        (width + height, (xmax, ymax)),
        (width + height + width, (xmin, ymax)),
    )


def rect_corners_between(t_start, t_end, rect):
    """Corner points strictly between two CCW parameters, in travel order."""
    perimeter = rect_perimeter(rect)
    eps = max(perimeter * 1e-9, 1e-12)
    span = (t_end - t_start) % perimeter

    corners = []
    for t_corner, point in rect_corner_params(rect):
        offset = (t_corner - t_start) % perimeter
        if eps < offset < span - eps:
            corners.append((offset, point))

    corners.sort(key=lambda item: item[0])
    return [point for _, point in corners]


# -----------------------------------------------------------------------------
# directional stitching
# -----------------------------------------------------------------------------

def _key(point, quantum):
    return (round(point[0] / quantum), round(point[1] / quantum))


def stitch_directed_chains(ways, quantum):
    """
    Join directed polylines head-to-tail into maximal chains.

    Endpoints are matched by POSITION, not by vertex index: blosm creates a
    fresh vertex per OSM node, so two ways sharing a node still end up with two
    coincident but distinct vertices.

    Returns a list of (points, is_closed).
    """
    segments = [list(w) for w in ways if len(w) >= MIN_CHAIN_POINTS]
    if not segments:
        return []

    starts = {}
    for index, seg in enumerate(segments):
        starts.setdefault(_key(seg[0], quantum), []).append(index)

    end_keys = set()
    for seg in segments:
        end_keys.add(_key(seg[-1], quantum))

    consumed = [False] * len(segments)

    def grow(index):
        consumed[index] = True
        chain = list(segments[index])
        while True:
            following = [
                j
                for j in starts.get(_key(chain[-1], quantum), ())
                if not consumed[j]
            ]
            if not following:
                break
            j = following[0]
            consumed[j] = True
            chain.extend(segments[j][1:])
            if _key(chain[0], quantum) == _key(chain[-1], quantum):
                break
        return chain

    chains = []

    # Prefer starting where nothing flows in, so chains come out maximal.
    for index, seg in enumerate(segments):
        if not consumed[index] and _key(seg[0], quantum) not in end_keys:
            chains.append(grow(index))
    for index in range(len(segments)):
        if not consumed[index]:
            chains.append(grow(index))

    result = []
    for chain in chains:
        closed = (
            len(chain) >= 4
            and _key(chain[0], quantum) == _key(chain[-1], quantum)
        )
        if closed:
            chain = chain[:-1]
        if len(chain) >= MIN_CHAIN_POINTS:
            result.append((chain, closed))
    return result


# -----------------------------------------------------------------------------
# directional clipping
# -----------------------------------------------------------------------------

def _clip_segment(p0, p1, rect):
    """Liang-Barsky. Returns (start, end, entered, exited) or None."""
    xmin, xmax, ymin, ymax = rect
    x0, y0 = p0
    x1, y1 = p1
    dx = x1 - x0
    dy = y1 - y0

    u1, u2 = 0.0, 1.0
    limits = (
        (-dx, x0 - xmin),
        (dx, xmax - x0),
        (-dy, y0 - ymin),
        (dy, ymax - y0),
    )

    for pi, qi in limits:
        if abs(pi) < 1e-15:
            if qi < 0.0:
                return None
            continue
        t = qi / pi
        if pi < 0.0:
            if t > u2:
                return None
            u1 = max(u1, t)
        else:
            if t < u1:
                return None
            u2 = min(u2, t)

    return (
        (x0 + u1 * dx, y0 + u1 * dy),
        (x0 + u2 * dx, y0 + u2 * dy),
        u1 > 0.0,
        u2 < 1.0,
    )


def _on_rect_edge(point, rect, eps):
    xmin, xmax, ymin, ymax = rect
    x, y = point
    if not (xmin - eps <= x <= xmax + eps and ymin - eps <= y <= ymax + eps):
        return False
    return (
        abs(x - xmin) <= eps
        or abs(x - xmax) <= eps
        or abs(y - ymin) <= eps
        or abs(y - ymax) <= eps
    )


def _ray_exit(origin, direction, rect):
    """Where a ray leaving `origin` along `direction` crosses the rectangle."""
    xmin, xmax, ymin, ymax = rect
    dx, dy = direction
    if abs(dx) < 1e-18 and abs(dy) < 1e-18:
        return None

    best = None
    for pi, limit in ((dx, xmax if dx > 0.0 else xmin),
                      (dy, ymax if dy > 0.0 else ymin)):
        if abs(pi) < 1e-18:
            continue
        origin_component = origin[0] if pi is dx else origin[1]
        t = (limit - origin_component) / pi
        if t > 0.0 and (best is None or t < best):
            best = t

    if best is None:
        return None
    return clamp_to_rect((origin[0] + best * dx, origin[1] + best * dy), rect)


def extend_piece_to_rect(piece, rect):
    """
    Repair a coastline piece that stops inside the crop.

    Coastline data downloaded for a bounding box simply ends at the download
    edge, so a crop larger than the data leaves dangling ends. Dropping those
    loses a whole landmass, which is far worse than continuing the terminal
    segment in its own direction until it leaves the rectangle.

    Returns (piece, extended_ends) or (None, 0) when it cannot be repaired.
    """
    eps = rect_eps(rect)
    points = list(piece)
    extended = 0

    if not _on_rect_edge(points[0], rect, eps):
        direction = (points[0][0] - points[1][0], points[0][1] - points[1][1])
        exit_point = _ray_exit(points[0], direction, rect)
        if exit_point is None:
            return None, 0
        points.insert(0, exit_point)
        extended += 1

    if not _on_rect_edge(points[-1], rect, eps):
        direction = (points[-1][0] - points[-2][0], points[-1][1] - points[-2][1])
        exit_point = _ray_exit(points[-1], direction, rect)
        if exit_point is None:
            return None, 0
        points.append(exit_point)
        extended += 1

    return points, extended


def clip_chain(points, rect, closed):
    """
    Clip a directed chain to the rectangle, preserving direction.

    Returns (open_pieces, interior_rings). An open piece is returned only when
    BOTH of its ends lie on the rectangle edge. A piece that simply stops inside
    the crop means the coastline data is broken there and cannot be closed, so
    it is reported as dropped rather than guessed at.
    """
    work = list(points)
    if closed and len(work) >= 3:
        work.append(work[0])

    if len(work) < 2:
        return [], [], 0, 0

    eps = rect_eps(rect)
    pieces = []
    current = []

    for a, b in zip(work[:-1], work[1:]):
        clipped = _clip_segment(a, b, rect)
        if clipped is None:
            if len(current) >= 2:
                pieces.append(current)
            current = []
            continue

        c0, c1, _entered, exited = clipped
        if not current:
            current = [c0, c1]
        elif same_point(current[-1], c0, eps):
            current.append(c1)
        else:
            if len(current) >= 2:
                pieces.append(current)
            current = [c0, c1]

        if exited:
            # The chain left the rectangle here, so close this piece off.
            if len(current) >= 2:
                pieces.append(current)
            current = []

    if len(current) >= 2:
        pieces.append(current)

    open_pieces = []
    interior_rings = []
    dropped = 0
    extended = 0

    fully_inside = closed and len(pieces) == 1

    for piece in pieces:
        cleaned = [piece[0]]
        for p in piece[1:]:
            if not same_point(cleaned[-1], p, eps):
                cleaned.append(p)
        if len(cleaned) < 2:
            continue

        start_on = _on_rect_edge(cleaned[0], rect, eps)
        end_on = _on_rect_edge(cleaned[-1], rect, eps)

        if fully_inside and not start_on and not end_on:
            # Never touched the edge: a whole island or lake inside the crop.
            if len(cleaned) >= 4 and same_point(cleaned[0], cleaned[-1], eps):
                cleaned = cleaned[:-1]
            if len(cleaned) >= 3:
                interior_rings.append(cleaned)
            continue

        if start_on and end_on:
            open_pieces.append(
                [clamp_to_rect(cleaned[0], rect)]
                + cleaned[1:-1]
                + [clamp_to_rect(cleaned[-1], rect)]
            )
            continue

        # The chain stops inside the crop, so the coastline data ran out before
        # the crop edge. Continue the terminal segment rather than losing the
        # landmass it bounds.
        repaired, added = extend_piece_to_rect(cleaned, rect)
        if repaired is None:
            dropped += 1
            continue
        open_pieces.append(repaired)
        extended += added

    return open_pieces, interior_rings, dropped, extended


# -----------------------------------------------------------------------------
# ring assembly
# -----------------------------------------------------------------------------

def _dedupe(points, eps):
    cleaned = [points[0]]
    for p in points[1:]:
        if not same_point(cleaned[-1], p, eps):
            cleaned.append(p)
    while len(cleaned) >= 2 and same_point(cleaned[0], cleaned[-1], eps):
        cleaned.pop()
    return cleaned


def assemble_rings(open_pieces, rect):
    """
    Close open coastline pieces into rings by walking counter-clockwise along
    the rectangle edge from each exit point to the next entry point.

    With coastlines directed land-on-the-left, the rings produced are LAND and
    are wound counter-clockwise.
    """
    if not open_pieces:
        return []

    perimeter = rect_perimeter(rect)
    eps = max(perimeter * 1e-9, 1e-12)

    entries = [rect_param_ccw(piece[0], rect) for piece in open_pieces]
    exits = [rect_param_ccw(piece[-1], rect) for piece in open_pieces]

    def next_piece(index):
        t_exit = exits[index]
        best = None
        best_gap = None
        for j, t_entry in enumerate(entries):
            gap = (t_entry - t_exit) % perimeter
            if gap < eps:
                gap = 0.0
            if best_gap is None or gap < best_gap:
                best_gap = gap
                best = j
        return best

    successor = [next_piece(i) for i in range(len(open_pieces))]

    rings = []
    visited = [False] * len(open_pieces)

    for start in range(len(open_pieces)):
        if visited[start]:
            continue

        ring = []
        index = start

        while not visited[index]:
            visited[index] = True
            ring.extend(open_pieces[index])

            following = successor[index]
            if following is None:
                break

            ring.extend(rect_corners_between(exits[index], entries[following], rect))
            index = following

        if len(ring) >= 3:
            ring = _dedupe(ring, rect_eps(rect))
            if len(ring) >= 3:
                rings.append(ring)

    return rings


# -----------------------------------------------------------------------------
# orientation check
# -----------------------------------------------------------------------------

def subsample(items, limit):
    if len(items) <= limit:
        return list(items)
    step = max(len(items) // limit, 1)
    return list(items)[::step]


def seeds_inside(rings, seeds):
    if not rings or not seeds:
        return 0
    prepared = [(polygon_bbox(r), r) for r in rings if len(r) >= 3]
    hits = 0
    for seed in seeds:
        for bbox, ring in prepared:
            if point_in_bbox(seed, bbox) and point_in_polygon(seed, ring):
                hits += 1
                break
    return hits


def _point_segment_distance(p, a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 0.0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_sq))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _crop_centre_is_water(chains, rect):
    """True when the rectangle centre lies to the right of the nearest coastline."""
    cx = (rect[0] + rect[1]) * 0.5
    cy = (rect[2] + rect[3]) * 0.5

    best = None
    best_distance = None

    for points, closed in chains:
        work = list(points)
        if closed and len(work) >= 3:
            work.append(work[0])
        for a, b in zip(work[:-1], work[1:]):
            distance = _point_segment_distance((cx, cy), a, b)
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best = (a, b)

    if best is None:
        return False

    a, b = best
    cross = (b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0])
    # A negative cross product puts the centre to the RIGHT of a->b, i.e. water.
    return cross < 0.0


# -----------------------------------------------------------------------------
# winding helpers
# -----------------------------------------------------------------------------

def wound(ring, ccw):
    area = polygon_area(ring)
    if (area < 0.0) == bool(ccw):
        return list(reversed(ring))
    return list(ring)


def _compose(rect, land_rings, extra_water_rings):
    rings = [wound(rect_ring(rect), ccw=True)]
    rings.extend(wound(r, ccw=False) for r in land_rings if len(r) >= 3)
    rings.extend(wound(r, ccw=True) for r in extra_water_rings if len(r) >= 3)
    return rings


# -----------------------------------------------------------------------------
# public entry point
# -----------------------------------------------------------------------------

def build_water_rings(chains, rect, land_seeds=None):
    """
    Build the compound ring set whose filled area is water.

    chains     -- list of (points, is_closed) directed coastline chains, in the
                  same coordinate space as `rect`, Y up.
    rect       -- (xmin, xmax, ymin, ymax) crop rectangle.
    land_seeds -- optional points known to be on land (building centroids), used
                  only to verify that the coastline direction convention holds.

    Returns (rings, info). `rings` is ready to emit as one compound path: the
    first ring is counter-clockwise and every land ring is clockwise, so it
    fills as water under fill-rule=evenodd and fill-rule=nonzero alike.
    """
    info = {
        "chains": len(chains),
        "open_pieces": 0,
        "interior_rings": 0,
        "land_rings": 0,
        "dropped_pieces": 0,
        "extended_ends": 0,
        "flipped": False,
        "mode": "none",
    }

    if not chains:
        return [], info

    open_pieces = []
    interior_rings = []
    dropped = 0
    extended = 0

    for points, closed in chains:
        pieces, rings, chain_dropped, chain_extended = clip_chain(points, rect, closed)
        open_pieces.extend(pieces)
        interior_rings.extend(rings)
        dropped += chain_dropped
        extended += chain_extended

    info["open_pieces"] = len(open_pieces)
    info["interior_rings"] = len(interior_rings)
    info["dropped_pieces"] = dropped
    info["extended_ends"] = extended

    seeds = subsample(land_seeds or (), MAX_ORIENTATION_SEEDS)

    # A closed ring inside the crop is an island (CCW = land, becomes a hole in
    # the water) or a lake (CW = water enclosed by land, added back).
    islands = [r for r in interior_rings if polygon_area(r) > 0.0]
    lakes = [r for r in interior_rings if polygon_area(r) < 0.0]

    if open_pieces:
        land_rings = assemble_rings(open_pieces, rect)

        # Verify the land-on-the-left convention actually holds for this data.
        # If most known-land seeds fall outside the rings we built, the source
        # linework is reversed, so rebuild from reversed pieces.
        if seeds:
            hits = seeds_inside(land_rings, seeds)
            if hits * 2 < len(seeds):
                flipped_rings = assemble_rings(
                    [list(reversed(p)) for p in open_pieces],
                    rect,
                )
                if seeds_inside(flipped_rings, seeds) > hits:
                    land_rings = flipped_rings
                    islands, lakes = lakes, islands
                    info["flipped"] = True

        land_rings = land_rings + islands
        info["land_rings"] = len(land_rings)
        info["mode"] = "crossing"
        return _compose(rect, land_rings, lakes), info

    # Nothing crosses the crop rectangle.
    if interior_rings:
        if islands:
            # Islands sit in open water: the crop is water with island holes.
            info["mode"] = "islands"
            info["land_rings"] = len(islands)
            return _compose(rect, islands, lakes), info

        if lakes:
            # Enclosed water inside land: only the lakes are water.
            info["mode"] = "lakes"
            return [wound(r, ccw=True) for r in lakes], info

    # Coastline exists but misses the crop entirely, so the crop is all land or
    # all water. Decide from the side of the nearest coastline segment.
    if _crop_centre_is_water(chains, rect):
        info["mode"] = "all_water"
        return [wound(rect_ring(rect), ccw=True)], info

    info["mode"] = "all_land"
    return [], info

# -----------------------------------------------------------------------------
# repairing water areas whose outline is incomplete
# -----------------------------------------------------------------------------

# A repaired ring covering more than this much of the crop means the water side
# was not actually identified; flooding the plaque is worse than a gap.
MAX_REPAIRED_AREA_FRACTION = 0.60

# Without positive water evidence the only thing left is "this candidate is
# small and has no buildings in it". That is a weak argument, so it gets a much
# tighter area limit and has to be completely free of buildings.
MAX_REPAIRED_AREA_FRACTION_NO_EVIDENCE = 0.25


def clip_open_ring_strict(points, rect):
    """
    Clip an open outline to the rect, keeping only pieces that BOTH start and
    end on the rect edge.

    Unlike the coastline clipper this never extends a dangling end. A coastline
    that stops inside the crop ran out of downloaded data and continuing it is
    reasonable; an arbitrary water way that stops inside the crop is usually a
    centreline or a data error, and closing it against the edge would swallow
    the whole map.
    """
    eps = rect_eps(rect)
    pieces = []
    current = []

    for a, b in zip(points[:-1], points[1:]):
        clipped = _clip_segment(a, b, rect)
        if clipped is None:
            if len(current) >= 2:
                pieces.append(current)
            current = []
            continue

        c0, c1, _entered, exited = clipped
        if not current:
            current = [c0, c1]
        elif same_point(current[-1], c0, eps):
            current.append(c1)
        else:
            if len(current) >= 2:
                pieces.append(current)
            current = [c0, c1]

        if exited:
            if len(current) >= 2:
                pieces.append(current)
            current = []

    if len(current) >= 2:
        pieces.append(current)

    usable = []
    for piece in pieces:
        cleaned = [piece[0]]
        for point in piece[1:]:
            if not same_point(cleaned[-1], point, eps):
                cleaned.append(point)
        if len(cleaned) < 2:
            continue
        if not (_on_rect_edge(cleaned[0], rect, eps)
                and _on_rect_edge(cleaned[-1], rect, eps)):
            continue
        usable.append(
            [clamp_to_rect(cleaned[0], rect)]
            + cleaned[1:-1]
            + [clamp_to_rect(cleaned[-1], rect)]
        )

    return usable


def close_open_water_ring(points, rect, water_seeds=(), land_seeds=(),
                          max_area_fraction=MAX_REPAIRED_AREA_FRACTION):
    """
    Close a water outline that runs off the edge of the OSM extract.

    Walking the rect edge one way or the other from the clipped piece gives
    exactly two candidate polygons. Water outlines carry no direction
    convention, so the side is decided by evidence: the candidate must contain
    waterway centreline nodes and MORE of them than it contains buildings.

    Returns (ring, reason). `ring` is None when the water side could not be
    identified, and `reason` says why.
    """
    if len(points) < 2:
        return None, "too short"

    pieces = clip_open_ring_strict(points, rect)
    if not pieces:
        return None, "does not cross the crop edge"

    crop_area = (rect[1] - rect[0]) * (rect[3] - rect[2])

    candidates = []
    for piece in pieces:
        for oriented in (piece, list(reversed(piece))):
            for ring in assemble_rings([oriented], rect):
                if len(ring) < 3:
                    continue
                bbox = polygon_bbox(ring)
                candidates.append((
                    abs(polygon_area(ring)),
                    sum(1 for seed in water_seeds
                        if point_in_bbox(seed, bbox) and point_in_polygon(seed, ring)),
                    sum(1 for seed in land_seeds
                        if point_in_bbox(seed, bbox) and point_in_polygon(seed, ring)),
                    ring,
                ))

    if not candidates:
        return None, "no closable piece"

    def pick(limit, accept):
        best = None
        best_score = None
        oversized = False
        for area, wet, dry, ring in candidates:
            if not accept(wet, dry):
                continue
            if area > limit:
                oversized = True
                continue
            score = (wet - dry, -area)
            if best_score is None or score > best_score:
                best_score = score
                best = ring
        return best, oversized

    saw_oversized = False

    # Strongest argument first: the candidate holds known water AND more water
    # than buildings.
    if water_seeds:
        best, oversized = pick(
            crop_area * max_area_fraction,
            lambda wet, dry: wet > 0 and wet > dry,
        )
        saw_oversized |= oversized
        if best is not None:
            return best, "repaired"

    # Otherwise the only argument left is "small, and no buildings in it", which
    # is weak, so it gets a much tighter limit. Reached either when there is no
    # water evidence at all or when the evidence sits nowhere near this piece.
    best, oversized = pick(
        crop_area * min(max_area_fraction, MAX_REPAIRED_AREA_FRACTION_NO_EVIDENCE),
        lambda wet, dry: dry == 0,
    )
    saw_oversized |= oversized
    if best is not None:
        return best, "repaired (no buildings enclosed)"
    if saw_oversized:
        return None, "candidate too large to trust"
    return None, "water side not identifiable"

# --- SHARED COASTLINE CODE (END) ---


# --- SHARED POLYGON CODE (BEGIN) ---
# Mirrored verbatim from jarvizar_polygons.py by sync_coastline.py.
# Edit that file, not this block, then re-run: python sync_coastline.py

TAU = 2.0 * math.pi

# Coordinates are snapped to this fraction of the working extent before anything
# is compared, so "the same corner" really does produce the same dictionary key.
# 1e-9 of a 2 km map is 2 microns: far below anything OSM records, far above
# float64 noise at those magnitudes.
SNAP_RATIO = 1e-9

# How far to either side of a fragment to ask "is this ground inside?". Must be
# larger than the snap grid and smaller than the narrowest real feature. 1e-8 of
# a 2 km map is 0.02 mm on the ground, 0.16 microns on the finished plaque --
# nothing the laser could resolve, and still ten times the snap grid, so a probe
# point is never in doubt about which side of a snapped edge it sits on.
#
# It was 1e-7, and that was too coarse for dense data: where a building and its
# building:part run a hair apart, a probe reached past the neighbouring edge and
# answered for the wrong piece of ground. Adjacent fragments then disagreed about
# inside/outside, the boundary stopped forming closed cycles, and `_walk_rings`
# dropped what it could not close -- a whole city block at a time. Measured over
# the 644 overlapping-building clusters on the Midtown Manhattan plaque:
#
#     PROBE_RATIO   clusters that came back short   ground lost
#         1e-6                122                    1476.8 mm2
#         1e-7                 24                     179.5 mm2
#         1e-8                  3                      14.0 mm2
#
# Going the other way -- a coarser snap grid -- makes it far worse (1e-8 snap:
# 122 clusters short), so this is the probe, not the snap. Clamping the probe to
# a fraction of each fragment's own length was tried and is not what matters:
# at 1e-7 it recovered 4 clusters of the 24, at 1e-8 it changed nothing.
# `union_covers` is the backstop for whatever still slips through.
PROBE_RATIO = 1e-8

# Boolean work grows as roughly the square of the edges in one cluster of
# overlapping rings. Clusters are normally two or three parts of one building --
# the largest on a Vancouver crop was 95 -- so this cap is only there to stop a
# pathological scene from looking like a hang. Measured on 12-sided rings in a
# single cluster: 400 rings take 1.0 s, 800 take 4.4 s, 1200 take 10.3 s.
# Three separate O(n^2) hangs have been fixed in this pipeline already.
MAX_CLUSTER_RINGS = 800

# Detail finer than this fraction of an offset distance is dropped before the
# offset runs. Anything moved is moved by less than the offset itself, so the
# grown outline still covers the shape it came from.
SIMPLIFY_FRACTION = 0.25


# -----------------------------------------------------------------------------
# predicates -- the only thing that differs between the boolean operations
# -----------------------------------------------------------------------------

def union_predicate(a, b):
    return a != 0 or b != 0


def difference_predicate(a, b):
    return a != 0 and b == 0


def intersection_predicate(a, b):
    return a != 0 and b != 0


# -----------------------------------------------------------------------------
# winding numbers
# -----------------------------------------------------------------------------

class RingSet:
    """
    Edges of a ring collection, bucketed by row for fast winding numbers.

    A cluster can hold a few hundred edges and every fragment needs two winding
    queries, so the naive scan is quadratic enough to be worth avoiding.
    """

    ROWS = 48

    def __init__(self, rings):
        self.edges = []
        for ring in rings:
            if len(ring) < 3:
                continue
            for index, start in enumerate(ring):
                end = ring[(index + 1) % len(ring)]
                if start != end:
                    self.edges.append((start, end))

        self.rows = defaultdict(list)
        if not self.edges:
            self.ymin = self.ymax = 0.0
            self.scale = 0.0
            return

        ys = [p[1] for edge in self.edges for p in edge]
        self.ymin, self.ymax = min(ys), max(ys)
        height = self.ymax - self.ymin
        self.scale = (self.ROWS / height) if height > 0.0 else 0.0

        for index, ((_, y0), (_, y1)) in enumerate(self.edges):
            low, high = (y0, y1) if y0 <= y1 else (y1, y0)
            for row in range(self._row(low), self._row(high) + 1):
                self.rows[row].append(index)

    def _row(self, y):
        return max(0, min(self.ROWS, int((y - self.ymin) * self.scale)))

    def winding(self, point):
        """Winding number of `point`, positive for counter-clockwise rings."""
        if not self.edges:
            return 0
        px, py = point
        if py < self.ymin or py > self.ymax:
            return 0

        total = 0
        for index in self.rows.get(self._row(py), ()):
            (x0, y0), (x1, y1) = self.edges[index]
            # Half-open in y, so a vertex is counted by exactly one of its edges.
            if y0 <= py:
                if y1 > py and (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0.0:
                    total += 1
            elif y1 <= py and (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0.0:
                total -= 1
        return total


# -----------------------------------------------------------------------------
# edge splitting
# -----------------------------------------------------------------------------

def _snapper(rings, snap_ratio=SNAP_RATIO):
    """Build a quantiser sized to the geometry actually being processed."""
    points = [p for ring in rings for p in ring]
    if not points:
        return (lambda p: p), 1.0
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    extent = max(max(xs) - min(xs), max(ys) - min(ys))
    if extent <= 0.0:
        return (lambda p: p), 1.0

    quantum = extent * snap_ratio

    def snap(point):
        return (round(point[0] / quantum) * quantum,
                round(point[1] / quantum) * quantum)

    return snap, extent


class _EdgeGrid:
    """Uniform grid over edge bounding boxes, for finding candidate pairs."""

    def __init__(self, edges, extent):
        count = max(len(edges), 1)
        # Roughly sqrt(n) cells per axis keeps the cell occupancy near constant.
        divisions = max(1, min(64, int(math.sqrt(count)) + 1))
        self.cell = (extent / divisions) if extent > 0.0 else 1.0
        self.cells = defaultdict(list)
        for index, (a, b) in enumerate(edges):
            for key in self._keys(a, b):
                self.cells[key].append(index)

    def _keys(self, a, b):
        x0 = int(min(a[0], b[0]) / self.cell)
        x1 = int(max(a[0], b[0]) / self.cell)
        y0 = int(min(a[1], b[1]) / self.cell)
        y1 = int(max(a[1], b[1]) / self.cell)
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                yield (cx, cy)

    def pairs(self):
        seen = set()
        for bucket in self.cells.values():
            for i in range(len(bucket)):
                for j in range(i + 1, len(bucket)):
                    pair = (bucket[i], bucket[j])
                    if pair not in seen:
                        seen.add(pair)
                        yield pair


def _parameter_on(point, a, b, tolerance):
    """Where `point` sits along a->b, or None if it is not on the segment."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 0.0:
        return None

    t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_sq
    if t <= 0.0 or t >= 1.0:
        return None

    # Perpendicular distance, squared, without the square root.
    cross = (point[0] - a[0]) * dy - (point[1] - a[1]) * dx
    if cross * cross > tolerance * tolerance * length_sq:
        return None
    return t


def _split_parameters(a0, a1, b0, b1, tolerance):
    """
    Parameters at which two segments meet, on each of them.

    Covers proper crossings, T-junctions and collinear overlap in one place:
    the endpoint tests alone already handle the last two, so no separate
    collinear branch is needed.
    """
    ts, us = [], []

    dax, day = a1[0] - a0[0], a1[1] - a0[1]
    dbx, dby = b1[0] - b0[0], b1[1] - b0[1]
    denominator = dax * dby - day * dbx
    if denominator != 0.0:
        ex, ey = b0[0] - a0[0], b0[1] - a0[1]
        t = (ex * dby - ey * dbx) / denominator
        u = (ex * day - ey * dax) / denominator
        if 0.0 < t < 1.0 and 0.0 < u < 1.0:
            ts.append(t)
            us.append(u)

    for point in (b0, b1):
        t = _parameter_on(point, a0, a1, tolerance)
        if t is not None:
            ts.append(t)
    for point in (a0, a1):
        u = _parameter_on(point, b0, b1, tolerance)
        if u is not None:
            us.append(u)

    return ts, us


def _fragments(rings, snap, extent):
    """Split every edge at every meeting point and return directed fragments."""
    edges = []
    for ring in rings:
        if len(ring) < 3:
            continue
        for index, start in enumerate(ring):
            end = ring[(index + 1) % len(ring)]
            if start != end:
                edges.append((start, end))

    if not edges:
        return []

    tolerance = extent * SNAP_RATIO
    cuts = defaultdict(set)
    grid = _EdgeGrid(edges, extent)

    for i, j in grid.pairs():
        a0, a1 = edges[i]
        b0, b1 = edges[j]
        ts, us = _split_parameters(a0, a1, b0, b1, tolerance)
        for t in ts:
            cuts[i].add(t)
        for u in us:
            cuts[j].add(u)

    fragments = []
    for index, (a, b) in enumerate(edges):
        parameters = sorted(cuts.get(index, ()))
        previous = a
        for t in parameters:
            point = snap((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            if point != previous:
                fragments.append((previous, point))
            previous = point
        if b != previous:
            fragments.append((previous, b))

    return fragments


# -----------------------------------------------------------------------------
# walking classified fragments back into rings
# -----------------------------------------------------------------------------

def _next_fragment(fragments, outgoing, used, index):
    """
    The next edge clockwise around the shared vertex.

    That is the standard rule for tracing the face that lies to the LEFT of a
    set of directed edges, which is where the filled side is by construction.
    """
    start, vertex = fragments[index]
    back = math.atan2(start[1] - vertex[1], start[0] - vertex[0])

    best = None
    best_delta = None
    for candidate in outgoing.get(vertex, ()):
        if used[candidate]:
            continue
        ahead = fragments[candidate][1]
        angle = math.atan2(ahead[1] - vertex[1], ahead[0] - vertex[0])
        delta = (back - angle) % TAU
        if delta <= 1e-12:
            # Doubling straight back is a last resort, never a first choice.
            delta = TAU
        if best_delta is None or delta < best_delta:
            best, best_delta = candidate, delta
    return best


def _walk_rings(fragments):
    outgoing = defaultdict(list)
    for index, (start, _) in enumerate(fragments):
        outgoing[start].append(index)

    used = [False] * len(fragments)
    rings = []

    for seed in range(len(fragments)):
        if used[seed]:
            continue

        ring = []
        closed = False
        index = seed
        while index is not None and not used[index]:
            used[index] = True
            ring.append(fragments[index][0])
            if fragments[index][1] == fragments[seed][0]:
                closed = True
                break
            index = _next_fragment(fragments, outgoing, used, index)

        # An open walk means the classification left a gap. Dropping it is the
        # honest outcome: half a ring would fill as nonsense.
        if closed and len(ring) >= 3:
            rings.append(ring)

    return rings


# -----------------------------------------------------------------------------
# nesting
# -----------------------------------------------------------------------------

def _contains(outer, point):
    x, y = point
    inside = False
    previous = outer[-1]
    for current in outer:
        xi, yi = current
        xj, yj = previous
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        previous = current
    return inside


def group_into_solids(rings):
    """
    Pair each hole with the smallest ring that contains it.

    Emitting one SVG path per solid is the second half of the fix: fill rules
    only apply within a single path, so two solids can never cancel each other
    out no matter which rule the importer picks.
    """
    entries = []
    for ring in rings:
        if len(ring) >= 3:
            entries.append((polygon_area(ring), polygon_bbox(ring), ring))

    outers = [e for e in entries if e[0] > 0.0]
    holes = [e for e in entries if e[0] < 0.0]
    outers.sort(key=lambda e: e[0])

    solids = [[wound(ring, ccw=True)] for _, _, ring in outers]

    for _, _, hole in holes:
        sample = hole[0]
        for position, (_, bbox, outer) in enumerate(outers):
            if (bbox[0] <= sample[0] <= bbox[1] and bbox[2] <= sample[1] <= bbox[3]
                    and _contains(outer, sample)):
                solids[position].append(wound(hole, ccw=False))
                break
        else:
            # A clockwise ring with nothing around it is a flipped normal far
            # more often than a courtyard floating in space, and buildings are
            # never allowed to vanish, so it becomes a solid of its own.
            solids.append([wound(hole, ccw=True)])

    return [solid for solid in solids if solid]


def _interior_point(ring):
    """
    A point strictly inside `ring`, for asking which other rings enclose it.

    A vertex will not do: rings that share a wall touch at their vertices, so a
    corner sits exactly on a neighbour's boundary and the containment test there
    is a coin flip. The scanline is placed between two DISTINCT vertex heights,
    which is the one height at which it cannot graze a vertex either.
    """
    heights = sorted({point[1] for point in ring})
    if len(heights) < 2:
        return ring[0]

    middle = len(heights) // 2
    y = 0.5 * (heights[middle - 1] + heights[middle])

    crossings = []
    count = len(ring)
    for index in range(count):
        x0, y0 = ring[index]
        x1, y1 = ring[(index + 1) % count]
        if (y0 > y) != (y1 > y):
            crossings.append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))

    if len(crossings) < 2:
        return ring[0]
    crossings.sort()
    return (0.5 * (crossings[0] + crossings[1]), y)


def orient_by_nesting(rings):
    """
    Wind a ring set by how deeply nested each ring is, ignoring the winding it
    arrived with.

    OSM promises no direction for multipolygon members. On `Laguna di Venezia`
    the outer ring runs clockwise while its 42 island members inside the Venice
    crop split 32 counter-clockwise to 10 clockwise. Read under even-odd every
    island is a hole and the map is right; read under non-zero the 10 that match
    the outer are not holes at all and those islands flood. Bambu Suite does not
    say which rule it uses, so that fill is a coin flip -- invariant 6.

    Depth is what actually decides it: a ring enclosed by an even number of
    other rings is solid and is wound counter-clockwise, one enclosed by an odd
    number is a hole and is wound clockwise. That reads the same under both
    rules, and it still gets an island-in-a-lake-on-an-island right, which
    sign-of-area never could.

    `group_into_solids` classifies by the sign it is given, which is correct for
    boolean OUTPUT because the walk assigns those signs deliberately. This is
    for INPUT, where the signs mean nothing.
    """
    prepared = []
    for ring in rings:
        if len(ring) < 3:
            continue
        area = polygon_area(ring)
        if area == 0.0:
            continue
        prepared.append((abs(area), polygon_bbox(ring), ring, _interior_point(ring)))

    if not prepared:
        return []

    # Only a LARGER ring can enclose a smaller one, so ordering by area means a
    # ring never has to be tested against anything it could contain itself.
    prepared.sort(key=lambda entry: entry[0], reverse=True)

    spans = [max(box[1] - box[0], box[3] - box[2]) for _, box, _, _ in prepared]
    cell = max(sum(spans) / len(spans), 1e-12)
    grid = defaultdict(list)
    for index, (_, (xmin, xmax, ymin, ymax), _, _) in enumerate(prepared):
        for cx in range(int(xmin / cell), int(xmax / cell) + 1):
            for cy in range(int(ymin / cell), int(ymax / cell) + 1):
                grid[(cx, cy)].append(index)

    oriented = []
    for index, (_, _, ring, sample) in enumerate(prepared):
        key = (int(sample[0] / cell), int(sample[1] / cell))
        depth = 0
        # Any ring enclosing the sample has a bbox covering it, so it is indexed
        # in the sample's own cell. One bucket is the whole candidate list.
        for other in grid.get(key, ()):
            if other >= index:
                continue
            _, box, candidate, _ = prepared[other]
            if not (box[0] <= sample[0] <= box[1] and box[2] <= sample[1] <= box[3]):
                continue
            if _contains(candidate, sample):
                depth += 1
        oriented.append(wound(ring, ccw=(depth % 2 == 0)))

    return oriented


# -----------------------------------------------------------------------------
# the boolean itself
# -----------------------------------------------------------------------------

def boolean_rings(a_rings, b_rings, predicate):
    """
    Combine two ring sets and return non-overlapping, correctly wound rings.

    Both inputs are read under NON-ZERO winding, which is the convention blosm's
    roof faces already produce. The output is wound so that it reads the same
    under either fill rule, because Bambu Suite does not say which it uses.
    """
    a_rings = [r for r in a_rings if len(r) >= 3]
    b_rings = [r for r in b_rings if len(r) >= 3]
    if not a_rings and not b_rings:
        return []

    snap, extent = _snapper(a_rings + b_rings)
    a_rings = [[snap(p) for p in ring] for ring in a_rings]
    b_rings = [[snap(p) for p in ring] for ring in b_rings]

    fragments = _fragments(a_rings + b_rings, snap, extent)
    if not fragments:
        return []

    a_set = RingSet(a_rings)
    b_set = RingSet(b_rings)
    probe = extent * PROBE_RATIO

    kept = []
    seen = set()
    for start, end in fragments:
        # One decision per piece of ground, whichever ring or direction it came
        # from: coincident edges are the normal case, not an exception.
        key = (start, end) if start <= end else (end, start)
        if key in seen:
            continue
        seen.add(key)

        dx, dy = end[0] - start[0], end[1] - start[1]
        length = math.hypot(dx, dy)
        if length <= 0.0:
            continue

        mx, my = 0.5 * (start[0] + end[0]), 0.5 * (start[1] + end[1])
        nx, ny = -dy / length * probe, dx / length * probe
        left = (mx + nx, my + ny)
        right = (mx - nx, my - ny)

        inside_left = predicate(a_set.winding(left), b_set.winding(left))
        inside_right = predicate(a_set.winding(right), b_set.winding(right))
        if inside_left == inside_right:
            # Same on both sides: not a boundary of the result. A shared wall
            # between two merged parts lands here, and so does an edge of the
            # clip that falls outside the subject entirely.
            continue

        # The result must end up on the LEFT, so a clip boundary -- which is
        # handed to us pointing the other way -- gets reversed here.
        kept.append((start, end) if inside_left else (end, start))

    rings = _walk_rings(kept)

    cleaned = []
    for ring in rings:
        ring = _drop_collinear(ring, extent * SNAP_RATIO)
        if len(ring) >= 3 and abs(polygon_area(ring)) > 0.0:
            cleaned.append(ring)

    return [ring for solid in group_into_solids(cleaned) for ring in solid]


def _drop_collinear(ring, tolerance):
    """Remove points that add nothing, which splitting leaves behind."""
    if len(ring) < 3:
        return ring
    out = []
    count = len(ring)
    for index in range(count):
        previous = ring[index - 1]
        current = ring[index]
        following = ring[(index + 1) % count]
        cross = ((current[0] - previous[0]) * (following[1] - previous[1])
                 - (current[1] - previous[1]) * (following[0] - previous[0]))
        span = math.hypot(following[0] - previous[0], following[1] - previous[1])
        if abs(cross) > tolerance * span:
            out.append(current)
    return out if len(out) >= 3 else ring


def union_rings(rings):
    """Flatten one overlapping ring set into non-overlapping rings."""
    return boolean_rings(rings, [], union_predicate)


def difference_rings(subject, clip):
    """Subject minus clip."""
    if not clip:
        return boolean_rings(subject, [], union_predicate)
    return boolean_rings(subject, clip, difference_predicate)


def intersect_rings(subject, clip):
    return boolean_rings(subject, clip, intersection_predicate)


# -----------------------------------------------------------------------------
# outward offset, built from the union
# -----------------------------------------------------------------------------

def _simplify_for_offset(ring, tolerance):
    """
    Drop detail smaller than the offset itself before offsetting.

    A real footprint is full of corners finer than a 0.35 mm halo -- Canada Place
    has nine edges shorter than one -- and offsetting those produces microscopic,
    nearly parallel edges whose intersections are numerically hopeless. Nothing
    is moved further than `tolerance`, which is a fraction of the offset, so the
    grown outline still contains the original everywhere.
    """
    points = []
    for point in ring:
        if not points or math.hypot(point[0] - points[-1][0],
                                    point[1] - points[-1][1]) > tolerance:
            points.append(point)

    while (len(points) > 3
           and math.hypot(points[0][0] - points[-1][0],
                          points[0][1] - points[-1][1]) <= tolerance):
        points.pop()

    if len(points) < 3:
        return ring

    kept = []
    for index, current in enumerate(points):
        previous = points[index - 1] if kept == [] else kept[-1]
        following = points[(index + 1) % len(points)]
        cross = ((current[0] - previous[0]) * (following[1] - previous[1])
                 - (current[1] - previous[1]) * (following[0] - previous[0]))
        span = math.hypot(following[0] - previous[0], following[1] - previous[1])
        if span <= 0.0 or abs(cross) / span > tolerance:
            kept.append(current)

    return kept if len(kept) >= 3 else points


def _offset_ring(ring, distance, segments):
    """
    Push every edge of one ring outward by `distance`, rounding the corners.

    Outward is to the RIGHT of the direction of travel: an outer ring runs
    counter-clockwise and a hole runs clockwise, so both keep the solid on their
    left and both grow the solid when pushed right.

    A corner that turns the other way leaves the two offset edges crossing each
    other. That is left in deliberately -- the union afterwards removes it, and
    it is a plain transversal crossing, which is the case the boolean handles
    most reliably.
    """
    points = []
    count = len(ring)

    def normal(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length <= 0.0:
            return None
        return (dy / length * distance, -dx / length * distance)

    for index in range(count):
        previous = ring[index - 1]
        current = ring[index]
        following = ring[(index + 1) % count]

        incoming = normal(previous, current)
        outgoing = normal(current, following)
        if incoming is None or outgoing is None:
            continue

        points.append((current[0] + incoming[0], current[1] + incoming[1]))

        # Cross product of the two directions: positive is a left turn, which on
        # a ring wound this way is a convex corner and opens a wedge outside.
        turn = (current[0] - previous[0]) * (following[1] - current[1]) -                (current[1] - previous[1]) * (following[0] - current[0])
        if turn > 0.0:
            start = math.atan2(incoming[1], incoming[0])
            finish = math.atan2(outgoing[1], outgoing[0])
            sweep = (finish - start) % TAU
            steps = max(1, min(segments, int(sweep / (TAU / segments)) + 1))
            for step in range(1, steps):
                angle = start + sweep * step / steps
                points.append((current[0] + math.cos(angle) * distance,
                               current[1] + math.sin(angle) * distance))

        points.append((current[0] + outgoing[0], current[1] + outgoing[1]))

    return points


def dilate_rings(rings, distance, segments=8):
    """
    Grow a solid outward by `distance` on every side.

    Each ring is offset on its own and the results are then unioned, which
    cleans up the crossings an offset leaves behind wherever a corner turns back
    on itself or a feature is narrower than twice the distance. Real building
    footprints have plenty of both -- Canada Place has nine edges shorter than a
    0.35 mm halo -- so the cleanup is the normal path, not the exception.
    """
    rings = [r for r in rings if len(r) >= 3]
    if not rings or distance <= 0.0:
        return [wound(r, ccw=polygon_area(r) > 0.0) for r in rings]

    offset = []
    for ring in rings:
        simplified = _simplify_for_offset(ring, distance * SIMPLIFY_FRACTION)
        grown_ring = _offset_ring(simplified, distance, segments)
        if len(grown_ring) >= 3:
            offset.append(grown_ring)
    if not offset:
        return [wound(r, ccw=polygon_area(r) > 0.0) for r in rings]

    cleaned = union_rings(offset)

    # A tidy, non-overlapping result is preferable, but not required: every
    # caller reads this back under non-zero winding, and the raw offset already
    # describes the right region there -- the crossings it leaves behind at a
    # concave corner enclose no area under that rule. So when the cleanup cannot
    # resolve the shape, hand back the raw offset rather than something smaller
    # than the footprint it is supposed to cover.
    before = sum(polygon_area(r) for r in rings)
    if cleaned and sum(polygon_area(r) for r in cleaned) >= before:
        return cleaned
    return offset


def structures_touching(solids, water_rings, samples=8):
    """
    Which structures stand in the water.

    Only these need cutting out of it, and testing is much cheaper than cutting:
    the ocean fill is built from the crop rectangle, so a bounding box test would
    say every building on the plaque touches it.
    """
    if not water_rings:
        return []

    water = RingSet(water_rings)
    touching = []

    for solid in solids:
        outer = solid[0]
        centroid = (sum(p[0] for p in outer) / len(outer),
                    sum(p[1] for p in outer) / len(outer))
        probes = [centroid]
        step = max(1, len(outer) // samples)
        probes.extend(outer[::step])
        if any(water.winding(point) != 0 for point in probes):
            touching.append(solid)

    return touching


def subtract_structures(water_rings, solids, distance, segments=8,
                        overshoot=1.05):
    """
    Cut the structures standing in a water fill out of it, plus a margin.

    Returns `(rings, structures_cut, reason)`. `reason` is None on success.

    Water and buildings are both Laser Fill, so a building standing in water
    burns into the same dark mass as the water around it and disappears. The
    margin is what makes the silhouette read: without it the hole is exactly
    building shaped and the building simply fills it in again.

    The result is checked before it is handed back. Losing more water than the
    knockout could possibly account for means the boolean did not resolve, and a
    plaque with the sea eaten out of it is far worse than one merged building --
    the same reasoning as the water repair, which also refuses rather than
    guesses.
    """
    touching = structures_touching(solids, water_rings)
    if not touching:
        return water_rings, 0, None

    knockout = []
    for solid in touching:
        knockout.extend(dilate_rings(solid, distance, segments))
    if not knockout:
        return water_rings, 0, None

    result = difference_rings(water_rings, knockout)
    if not result:
        return water_rings, 0, "the difference produced nothing"

    before = abs(sum(polygon_area(r) for r in water_rings))
    after = abs(sum(polygon_area(r) for r in result))
    budget = abs(sum(polygon_area(r) for r in knockout)) * overshoot
    if before - after > budget:
        return water_rings, 0, (
            f"it would have removed {before - after:.4g} of water where the "
            f"structures cover at most {budget:.4g}"
        )

    return result, len(touching), None


# -----------------------------------------------------------------------------
# clustering -- only rings that actually overlap need the boolean
# -----------------------------------------------------------------------------

def _overlapping_clusters(rings, tolerance=0.0):
    """
    Group rings whose bounding boxes overlap with real area.

    Merely TOUCHING is not enough. Two buildings sharing a wall have boxes that
    meet along a line and no overlapping area, so no fill rule can break them --
    clustering those together would chain a whole city block into one cluster
    and hand the boolean a problem it does not need to solve.
    """
    boxes = [polygon_bbox(ring) for ring in rings]
    parent = list(range(len(rings)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def merge(a, b):
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[rb] = ra

    if boxes:
        spans = [max(b[1] - b[0], b[3] - b[2]) for b in boxes]
        cell = max(sum(spans) / len(spans), 1e-9)
        grid = defaultdict(list)
        for index, (xmin, xmax, ymin, ymax) in enumerate(boxes):
            for cx in range(int(xmin / cell), int(xmax / cell) + 1):
                for cy in range(int(ymin / cell), int(ymax / cell) + 1):
                    grid[(cx, cy)].append(index)

        tested = set()
        for bucket in grid.values():
            for i in range(len(bucket)):
                for j in range(i + 1, len(bucket)):
                    a, b = bucket[i], bucket[j]
                    if (a, b) in tested:
                        continue
                    tested.add((a, b))
                    ax0, ax1, ay0, ay1 = boxes[a]
                    bx0, bx1, by0, by1 = boxes[b]
                    if (min(ax1, bx1) - max(ax0, bx0) > tolerance
                            and min(ay1, by1) - max(ay0, by0) > tolerance):
                        merge(a, b)

    clusters = defaultdict(list)
    for index in range(len(rings)):
        clusters[root(index)].append(index)
    return list(clusters.values())


def _is_simple_nesting(rings):
    """True when at most one ring is filled, so nothing can overlap anything."""
    outers = [r for r in rings if polygon_area(r) > 0.0]
    if len(outers) != 1:
        return False

    xmin, xmax, ymin, ymax = polygon_bbox(outers[0])
    for ring in rings:
        if ring is outers[0]:
            continue
        bx0, bx1, by0, by1 = polygon_bbox(ring)
        if bx0 < xmin or bx1 > xmax or by0 < ymin or by1 > ymax:
            return False
    return True


def union_covers(inputs, output):
    """
    True when a merged outline still covers every piece of ground its input did.

    The boolean is the one step that can quietly lose a whole building.
    `_walk_rings` drops a ring whose walk does not close -- the honest thing to
    do with half a ring, but the ground it covered goes unpainted, and nothing
    downstream can tell. Measured over the 644 overlapping-building clusters on
    the Midtown Manhattan plaque, 24 came back short and eight of those lost
    EVERYTHING (19 rings in, 0 out): whole city blocks absent from the engraving
    while Blender showed them standing there.

    One interior point per input ring is enough, and it is exact in the
    direction that matters: a point strictly inside a FILLED input ring must lie
    inside the union, so a point that is filled before and empty after proves
    ground was lost. Points that the input did not fill (a hole, or a clockwise
    ring inside a larger one) are skipped, because the union owes them nothing.
    On that Manhattan plaque it caught all 24 with no false alarms, for 0.22 s
    across every cluster on the map.

    Same rule as the water repair and the structure knockout: refuse rather than
    guess. The caller keeps the un-merged rings, which still cover the right
    ground -- they merely overlap, which costs a second burn rather than a hole.
    """
    if not output:
        return False

    source = RingSet(inputs)
    result = RingSet(output)

    for ring in inputs:
        if len(ring) < 3:
            continue
        sample = _interior_point(ring)
        if source.winding(sample) != 0 and result.winding(sample) == 0:
            return False
    return True


def flatten_overlaps(rings, max_cluster_rings=MAX_CLUSTER_RINGS, on_skip=None,
                     on_refuse=None):
    """
    Rewrite an overlapping ring soup as a list of independent solids.

    Returns `(solids, stats)`. Each solid is `[outer] + holes`, ready to become
    one SVG path. Rings that overlap nothing are passed through untouched, which
    is nearly all of them -- a default blosm import is one object holding tens of
    thousands of building rings and only a handful of real overlaps.

    A merge that loses ground is refused and the un-merged rings kept instead
    (`union_covers`), so a cluster the boolean cannot resolve costs a doubled
    burn where two rings overlap, never a missing building.
    """
    rings = [r for r in rings if len(r) >= 3]
    stats = {"clusters": 0, "rings_in": len(rings), "merged": 0, "skipped": 0,
             "refused": 0}
    if not rings:
        return [], stats

    solids = []
    passthrough = []

    for cluster in _overlapping_clusters(rings):
        if len(cluster) == 1:
            passthrough.append(rings[cluster[0]])
            continue

        member_rings = [rings[i] for i in cluster]
        if _is_simple_nesting(member_rings):
            # An outer ring with courtyards inside it has no overlapping FILLED
            # regions, so no fill rule can break it and the boolean has nothing
            # to do. This is by far the commonest multi-ring building.
            passthrough.extend(member_rings)
            continue

        stats["clusters"] += 1
        if len(cluster) > max_cluster_rings:
            stats["skipped"] += len(cluster)
            if on_skip is not None:
                on_skip(len(cluster))
            passthrough.extend(member_rings)
            continue

        flattened = union_rings(member_rings)
        if union_covers(member_rings, flattened):
            stats["merged"] += len(cluster)
            solids.extend(group_into_solids(flattened))
        else:
            # The merge lost ground. Keep what we were given: overlapping rings
            # burn twice, a missing building cannot be recovered at all.
            stats["refused"] += len(cluster)
            if on_refuse is not None:
                on_refuse(len(cluster))
            passthrough.extend(member_rings)

    # Whatever never needed the boolean still has to be grouped into solids, so
    # a courtyard stays with the building it belongs to.
    solids.extend(group_into_solids(passthrough))
    return solids, stats

# --- SHARED POLYGON CODE (END) ---


# =============================================================================
# LOGGING
# =============================================================================

_WARNINGS = Counter()


def log(message):
    print(f"[Jarvizar SVG] {message}")


def warn(message, key=None, limit=5):
    """Warn, but collapse repeats so one bad layer cannot flood the console."""
    key = key or message
    _WARNINGS[key] += 1
    if _WARNINGS[key] <= limit:
        print(f"[Jarvizar SVG WARNING] {message}")
    elif _WARNINGS[key] == limit + 1:
        print(f"[Jarvizar SVG WARNING] ... further '{key}' warnings suppressed")


# =============================================================================
# BASIC HELPERS
# =============================================================================

def fmt(value):
    if abs(value) < 0.5 * (10 ** -SVG_DECIMALS):
        value = 0.0
    return f"{value:.{SVG_DECIMALS}f}"


def sanitize_id(name):
    value = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name).strip())
    if not value:
        value = "group"
    if value[0].isdigit():
        value = "_" + value
    return value


def svg_group_style(group_id, defaults):
    style = dict(defaults)
    style.update(SVG_GROUP_STYLES.get(group_id, {}))
    return " ".join(f'{name}="{value}"' for name, value in style.items())


# =============================================================================
# BLOSM LAYER RESOLUTION
# =============================================================================

_BLENDER_SUFFIX = re.compile(r"\.\d{3}$")


def base_name(name):
    """Strip Blender's .001 duplicate suffix."""
    return _BLENDER_SUFFIX.sub("", str(name)).casefold()


def name_matches_layer(name, layer):
    """
    True when `name` is a blosm layer name for `layer`.

    blosm names layers "<osm file>_<layer id>", so an exact match or a
    "_<layer id>" suffix both count. That also accepts hand-renamed collections.
    """
    candidate = base_name(name)
    target = layer.casefold()
    return candidate == target or candidate.endswith("_" + target)


def is_excluded(obj):
    name = base_name(obj.name)
    if any(name.startswith(prefix.casefold()) for prefix in EXCLUDE_NAME_PREFIXES):
        return True
    return any(
        name_matches_layer(obj.name, layer)
        or any(name_matches_layer(c.name, layer) for c in obj.users_collection)
        for layer in EXCLUDE_LAYERS
    )


def object_visible(obj):
    if INCLUDE_HIDDEN_OBJECTS:
        return True
    try:
        return not obj.hide_get()
    except RuntimeError:
        # Not linked to the active view layer.
        return True


def objects_for_layers(layers, quiet=False):
    """
    Collect objects belonging to any of the named blosm layers.

    Matches both collections (blosm's per-layer collections, or your own) and
    object names (blosm's single-object mode), so it works in either import mode.
    """
    found = []
    seen = set()
    matched_layers = set()

    def take(obj, layer):
        if obj.name in seen or obj.type == "EMPTY":
            return
        if is_excluded(obj) or not object_visible(obj):
            return
        seen.add(obj.name)
        matched_layers.add(layer)
        found.append(obj)

    for layer in layers:
        for collection in bpy.data.collections:
            if name_matches_layer(collection.name, layer):
                for obj in collection.all_objects:
                    take(obj, layer)

        for obj in bpy.data.objects:
            if name_matches_layer(obj.name, layer):
                take(obj, layer)

    if not found and not quiet:
        warn(
            f"No objects found for layers {layers}. "
            "Check the names in the Outliner; blosm calls them "
            "'<osm file>_<layer>', e.g. 'map.osm_roads_primary'."
        )

    return found, sorted(matched_layers)


def custom_property_value(obj, key):
    for source in (obj, getattr(obj, "data", None), obj.parent):
        if source is None:
            continue
        try:
            if key in source:
                return source[key]
        except TypeError:
            continue
    return None


LINE_TAG_KEYS = (
    "highway", "footway", "cycleway", "path", "is_sidepath", "crossing",
    "area", "railway", "public_transport", "service",
)


def object_tags(obj):
    """
    OSM tags blosm copied onto the object.

    Only populated when blosm imported with "Import as a single object" OFF; in
    single-object mode this is empty and the geometric rules do the work.
    """
    tags = {}
    for key in LINE_TAG_KEYS:
        value = custom_property_value(obj, key)
        if value is not None:
            tags[key] = str(value)
    return tags


def line_drop_reason(obj, matched_layer, has_closed_spline):
    """Why this line object should not be exported, or None to keep it."""
    tags = object_tags(obj)
    if tags:
        reason = should_drop_line(
            tags,
            has_closed_spline,
            drop_sidepaths=EXCLUDE_SIDEPATHS,
            drop_areas=EXCLUDE_AREA_LINES,
        )
        if reason:
            return reason

    if has_closed_spline and matched_layer and any(
        name_matches_layer(matched_layer, layer)
        for layer in DROP_CLOSED_LINES_IN_LAYERS
    ):
        return "closed area outline"

    return None


def layer_for_object(obj, layers):
    """Which of `layers` this object was matched by."""
    for layer in layers:
        if name_matches_layer(obj.name, layer):
            return layer
        if any(name_matches_layer(c.name, layer) for c in obj.users_collection):
            return layer
    return None


def is_outline_object(obj):
    """
    Areas drawn as an outline rather than engraved solid.

    OSM tags are only available when blosm imported with "single object" OFF, so
    fall back to matching the object name.
    """
    for key, expected in OUTLINE_TAG_MATCHES:
        value = custom_property_value(obj, key)
        if value is not None and str(value).casefold() == expected.casefold():
            return True

    names = [obj.name.casefold()]
    if obj.data is not None:
        names.append(obj.data.name.casefold())
    return any(hint in name for hint in OUTLINE_NAME_HINTS for name in names)


# =============================================================================
# BOUNDS, LAYOUT AND COORDINATE MAPPING
# =============================================================================

def get_bounds_from_object(obj):
    """
    World-space XY bounding box of the crop object.

    Nothing here assumes a particular unit scale. blosm imports at 1 Blender
    unit = 1 metre, but scaling the whole import down so it sits inside a
    plaque-sized rectangle works just as well: the exporter only ever uses the
    RATIO between the crop and the geometry inside it.

    Note this is the object's OUTER extent. If you model the crop as a frame or
    a boolean cutter with a hole in it, you get the outside of the frame, not
    the window. Use a plain rectangle or plane.
    """
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    xs = [p.x for p in corners]
    ys = [p.y for p in corners]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)

    if xmax <= xmin or ymax <= ymin:
        raise RuntimeError(
            f'"{obj.name}" has zero width or height in XY. '
            "The crop object must be a rectangle lying flat in the XY plane. "
            "An Empty has no size; use a plane or a mesh rectangle."
        )

    # A rotated crop object silently exports its axis-aligned bounding box,
    # which is bigger than the rectangle you drew (41% bigger at 45 degrees).
    rotation = getattr(obj, "rotation_euler", None)
    if rotation is not None and any(abs(angle) > 1e-4 for angle in rotation):
        warn(
            f'"{obj.name}" is rotated. The crop uses its axis-aligned bounding '
            "box, which is larger than the rectangle you drew, so more ground "
            "is exported than you selected. Clear the rotation, or rotate the "
            "imported map instead of the crop."
        )

    return xmin, xmax, ymin, ymax


def bounds_from_inner_hole(obj, depsgraph):
    """
    Bounding box of the largest hole in a frame-shaped crop object.

    Reuses the same top-down silhouette machinery as the building fills: the
    edges belonging to only one upward face form the boundary loops, and a frame
    has two of them -- the outside and the window. Returns None when the object
    is not a frame.
    """
    if obj.type != "MESH":
        return None

    obj_eval = obj.evaluated_get(depsgraph)
    try:
        mesh = obj_eval.to_mesh()
    except Exception:
        return None

    if mesh is None or not mesh.polygons:
        return None

    try:
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        xs = [p.x for p in corners]
        ys = [p.y for p in corners]
        outer_area = (max(xs) - min(xs)) * (max(ys) - min(ys))

        boundary, world_vertices = boundary_edges_from_upward_faces(
            mesh, obj_eval.matrix_world, outer_area
        )
        if not boundary:
            return None

        index_loops, _ = stitch_boundary_loops(boundary)
        rings = []
        for loop in index_loops:
            ring = [(world_vertices[i].x, world_vertices[i].y) for i in loop]
            if len(ring) >= 3 and abs(polygon_area(ring)) > 0.0:
                rings.append(ring)

        if len(rings) < 2:
            return None

        rings.sort(key=lambda ring: abs(polygon_area(ring)), reverse=True)
        if len(rings) > 2:
            warn(
                f'"{obj.name}" has {len(rings) - 1} holes. Using the largest. '
                "A crop object should be a simple frame with one window."
            )

        hole = rings[1]
        hx = [p[0] for p in hole]
        hy = [p[1] for p in hole]
        return min(hx), max(hx), min(hy), max(hy)
    finally:
        obj_eval.to_mesh_clear()


def resolve_bounds(obj, depsgraph):
    """Crop rectangle from the bounds object, honouring BOUNDS_MODE."""
    outer = get_bounds_from_object(obj)
    mode = BOUNDS_MODE.casefold()

    if mode == "outer":
        return outer, "outer bounding box"

    hole = bounds_from_inner_hole(obj, depsgraph)

    if hole is None:
        if mode == "inner":
            raise RuntimeError(
                f'BOUNDS_MODE is "inner" but "{obj.name}" has no hole in it. '
                "Either model it as a frame, or set BOUNDS_MODE to 'auto'."
            )
        return outer, "outer bounding box (no hole found)"

    shrink_x = (outer[1] - outer[0]) - (hole[1] - hole[0])
    shrink_y = (outer[3] - outer[2]) - (hole[3] - hole[2])
    log(
        f'"{obj.name}" is a frame; cropping to its WINDOW, which is '
        f"{shrink_x:.4g} x {shrink_y:.4g} Blender units smaller than its outside "
        'edge. Set BOUNDS_MODE = "outer" if you meant the outside.'
    )
    return hole, "interior hole"


def world_xy_extent(objects):
    """Combined world-space XY bounding box of some objects, or None."""
    xs = []
    ys = []
    for obj in objects:
        try:
            corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        except (AttributeError, TypeError):
            continue

        ox = [p.x for p in corners]
        oy = [p.y for p in corners]
        # A zero-size box is a point, not an extent; including it would drag the
        # measured map extent towards the object's origin.
        if max(ox) - min(ox) <= 0.0 and max(oy) - min(oy) <= 0.0:
            continue

        xs.extend(ox)
        ys.extend(oy)

    if not xs:
        return None
    return min(xs), max(xs), min(ys), max(ys)


def check_source_transforms(objects):
    """
    Warn about source objects that are tilted or mirrored.

    Rotating the imported map about Z is completely safe -- footprints and
    centrelines come out exact at any angle. TILTING it is not: the fills are a
    top-down projection of upward-facing faces, so a tilt foreshortens every
    building (30 degrees costs 13% of the footprint) and a 90 degree tilt makes
    them vanish outright. Roads are unaffected either way, so a tilt fails
    quietly and by halves.
    """
    tilted = []
    mirrored = []

    for obj in objects:
        try:
            basis = obj.matrix_world.to_3x3()
            up = basis @ Vector((0.0, 0.0, 1.0))
        except (AttributeError, TypeError, ValueError):
            continue

        length = (up.x ** 2 + up.y ** 2 + up.z ** 2) ** 0.5
        if length <= 0.0:
            continue
        if up.z / length < 0.999:
            tilted.append(obj.name)

        x_axis = basis @ Vector((1.0, 0.0, 0.0))
        y_axis = basis @ Vector((0.0, 1.0, 0.0))
        cross_z = x_axis.x * y_axis.y - x_axis.y * y_axis.x
        if cross_z * up.z < 0.0:
            mirrored.append(obj.name)

    if tilted:
        warn(
            f"{len(tilted)} source object(s) are TILTED out of the XY plane "
            f"(e.g. {', '.join(tilted[:3])}). Building and water fills are a "
            "top-down projection, so tilting foreshortens them and a 90 degree "
            "tilt removes them entirely, while roads carry on looking fine. "
            "Rotate about Z only."
        )

    if mirrored:
        warn(
            f"{len(mirrored)} source object(s) have a MIRRORED transform "
            f"(negative scale, e.g. {', '.join(mirrored[:3])}). That reverses "
            "polygon winding, which inverts the OSM land-on-the-left coastline "
            "convention. The ocean builder should correct itself from building "
            "positions, but check the result."
        )


def bounds_object_names():
    """Every name this exporter will accept for the crop object."""
    return [BOUNDS_OBJECT_NAME] + [
        name for name in BOUNDS_OBJECT_ALIASES if name != BOUNDS_OBJECT_NAME
    ]


def find_bounds_object():
    """
    The crop object, under any of its accepted names.

    Exact matches win, in the order the names are configured, so a scene holding
    both LASER_BOUNDS and an imported cutout still crops to LASER_BOUNDS. Only
    then does it fall back to a loose match -- case-insensitive, and ignoring
    the ".001" suffix Blender adds when the same STL is imported twice.
    """
    names = bounds_object_names()
    for name in names:
        obj = bpy.data.objects.get(name)
        if obj is not None:
            return obj

    def loose(name):
        return re.sub(r"\.\d+$", "", name).casefold()

    for name in names:
        wanted = loose(name)
        for obj in bpy.data.objects:
            if loose(obj.name) == wanted:
                return obj
    return None


def bounds_object_label():
    """What to call the crop object in a message: its real name if it exists."""
    obj = find_bounds_object()
    return obj.name if obj is not None else BOUNDS_OBJECT_NAME


def check_crop_against_source(bounds, source_objects):
    """
    Sanity-check the crop against the geometry it is supposed to cut.

    Comparing the two is what makes this unit-agnostic. Whether the scene is at
    blosm's native metres or scaled down to plaque size, the crop should sit
    inside the map and cover a useful part of it. Only the RATIO is suspicious,
    never the absolute size.
    """
    extent = world_xy_extent(source_objects)
    if extent is None:
        return

    xmin, xmax, ymin, ymax = bounds
    dxmin, dxmax, dymin, dymax = extent

    if xmax <= dxmin or xmin >= dxmax or ymax <= dymin or ymin >= dymax:
        raise RuntimeError(
            f'"{bounds_object_label()}" does not overlap the imported map at all. '
            f"crop: X {xmin:.4g}..{xmax:.4g} Y {ymin:.4g}..{ymax:.4g}; "
            f"map data: X {dxmin:.4g}..{dxmax:.4g} Y {dymin:.4g}..{dymax:.4g}. "
            "        Move the crop over the map, or check you scaled the crop "
            "and the map by the same amount."
        )

    crop_area = (xmax - xmin) * (ymax - ymin)
    data_area = (dxmax - dxmin) * (dymax - dymin)
    if data_area > 0.0 and crop_area / data_area < 1e-6:
        warn(
            f'"{bounds_object_label()}" covers {crop_area / data_area * 100:.6f}% '
            "of the imported map, which will export almost nothing. blosm "
            "imports at 1 Blender unit = 1 METRE, so a crop drawn at the plaque "
            "size in millimetres asks for a patch of ground a few centimetres "
            "across. Either size the crop in metres, or scale the imported map "
            "down to match the crop. " + suggested_bounds_message()
        )


def suggested_bounds_message():
    """Tell the user the exact crop size to draw, in metres."""
    inset = map_inset_mm()
    map_w = OUTPUT_WIDTH_MM - 2.0 * inset
    map_h = OUTPUT_HEIGHT_MM - 2.0 * inset
    return (
        f"Draw LASER_BOUNDS with a width:height ratio of {map_w / map_h:.4f} "
        f"(the map area is {map_w:.1f} x {map_h:.1f} mm), sized in metres -- "
        f"e.g. 2000 x {2000.0 * map_h / map_w:.1f} m."
    )


def map_inset_mm():
    if not EXPORT_DECORATIVE_BORDER:
        return 0.0
    return (
        OUTER_GAP_MM
        + THICK_BORDER_STROKE_WIDTH_MM
        + THICK_TO_THIN_GAP_MM
        + THIN_BORDER_STROKE_WIDTH_MM
        + INNER_MAP_GAP_MM
    )


def build_layout(bounds):
    """
    Reconcile the Blender crop rectangle with the plaque, honouring FIT_MODE.

    Returns (bounds, map_rect, note) where map_rect is (x, y, w, h) in mm.
    """
    inset = map_inset_mm()
    map_w = OUTPUT_WIDTH_MM - 2.0 * inset
    map_h = OUTPUT_HEIGHT_MM - 2.0 * inset

    if map_w <= 0.0 or map_h <= 0.0:
        raise RuntimeError("Border settings leave no room for map geometry.")

    xmin, xmax, ymin, ymax = bounds
    source_aspect = (xmax - xmin) / (ymax - ymin)
    target_aspect = map_w / map_h
    mode = FIT_MODE.casefold()

    # 0.1% of aspect is about 0.16 mm across the plaque: not worth cropping for,
    # and reporting it as a crop would just be confusing noise.
    if abs(source_aspect / target_aspect - 1.0) <= 1e-3:
        return bounds, (inset, inset, map_w, map_h), "aspect ratios already match"

    if mode == "crop":
        if source_aspect > target_aspect:
            keep = (ymax - ymin) * target_aspect
            centre = (xmin + xmax) * 0.5
            xmin, xmax = centre - keep * 0.5, centre + keep * 0.5
        else:
            keep = (xmax - xmin) / target_aspect
            centre = (ymin + ymax) * 0.5
            ymin, ymax = centre - keep * 0.5, centre + keep * 0.5
        kept_area = (xmax - xmin) * (ymax - ymin)
        original_area = (bounds[1] - bounds[0]) * (bounds[3] - bounds[2])
        trimmed = 100.0 * (1.0 - kept_area / original_area) if original_area else 0.0
        note = (
            f"centre-cropped bounds to {xmax - xmin:.4g} x {ymax - ymin:.4g} "
            f"Blender units, trimming {trimmed:.1f}% of the area you selected. "
            "No distortion. Match the ratio below to trim nothing"
        )
        return (xmin, xmax, ymin, ymax), (inset, inset, map_w, map_h), note

    if mode == "fit":
        if source_aspect > target_aspect:
            fitted_h = map_w / source_aspect
            rect = (inset, inset + (map_h - fitted_h) * 0.5, map_w, fitted_h)
        else:
            fitted_w = map_h * source_aspect
            rect = (inset + (map_w - fitted_w) * 0.5, inset, fitted_w, map_h)
        note = f"letterboxed map area to {rect[2]:.3f} x {rect[3]:.3f} mm"
        return bounds, rect, note

    warn(
        "FIT_MODE='stretch' scales X and Y independently, so the map is "
        f"distorted by {abs(source_aspect / target_aspect - 1.0) * 100:.1f}%. "
        "Use 'crop' or 'fit' to keep the geography true."
    )
    return bounds, (inset, inset, map_w, map_h), "stretched to fill"


def make_transform(bounds, map_rect):
    """
    Build a world -> SVG millimetre converter once.

    Hoisting this out of the inner loop matters: a city export converts millions
    of points, and recomputing the layout per point dominated the old runtime.
    """
    xmin, xmax, ymin, ymax = bounds
    map_x, map_y, map_w, map_h = map_rect
    scale_x = map_w / (xmax - xmin)
    scale_y = map_h / (ymax - ymin)
    top = map_y + map_h

    def to_svg(x, y):
        # SVG Y grows downward, Blender Y grows upward.
        return (map_x + (x - xmin) * scale_x, top - (y - ymin) * scale_y)

    return to_svg


# =============================================================================
# CLIPPING
# =============================================================================

def clip_polyline(points, bounds, cyclic=False):
    """Clip a polyline to the crop, returning a list of open polylines."""
    if len(points) < 2:
        return []

    eps = rect_eps(bounds)
    work = list(points)
    if cyclic:
        work.append(points[0])

    result = []
    current = []

    for a, b in zip(work[:-1], work[1:]):
        clipped = _clip_segment(a, b, bounds)
        if clipped is None:
            if len(current) >= 2:
                result.append(current)
            current = []
            continue

        c0, c1, _entered, exited = clipped
        if not current:
            current = [c0, c1]
        elif same_point(current[-1], c0, eps):
            current.append(c1)
        else:
            if len(current) >= 2:
                result.append(current)
            current = [c0, c1]

        if exited:
            if len(current) >= 2:
                result.append(current)
            current = []

    if len(current) >= 2:
        result.append(current)

    cleaned = []
    for polyline in result:
        pts = [polyline[0]]
        for p in polyline[1:]:
            if not same_point(pts[-1], p, eps):
                pts.append(p)
        if len(pts) >= 2:
            cleaned.append(pts)
    return cleaned


def clip_polygon_to_rect(points, bounds):
    """
    Sutherland-Hodgman clip of a closed ring against the crop rectangle.

    Lets the exporter crop fills itself, so the Boolean crop modifier in Blender
    becomes optional rather than required.
    """
    xmin, xmax, ymin, ymax = bounds

    def clip_edge(subject, keep, intersect):
        if not subject:
            return []
        output = []
        previous = subject[-1]
        previous_in = keep(previous)
        for current in subject:
            current_in = keep(current)
            if current_in:
                if not previous_in:
                    output.append(intersect(previous, current))
                output.append(current)
            elif previous_in:
                output.append(intersect(previous, current))
            previous, previous_in = current, current_in
        return output

    def cut(a, b, value, axis):
        other = 1 - axis
        span = b[axis] - a[axis]
        t = 0.0 if abs(span) < 1e-18 else (value - a[axis]) / span
        point = [0.0, 0.0]
        point[axis] = value
        point[other] = a[other] + (b[other] - a[other]) * t
        return (point[0], point[1])

    ring = list(points)
    ring = clip_edge(ring, lambda p: p[0] >= xmin, lambda a, b: cut(a, b, xmin, 0))
    ring = clip_edge(ring, lambda p: p[0] <= xmax, lambda a, b: cut(a, b, xmax, 0))
    ring = clip_edge(ring, lambda p: p[1] >= ymin, lambda a, b: cut(a, b, ymin, 1))
    ring = clip_edge(ring, lambda p: p[1] <= ymax, lambda a, b: cut(a, b, ymax, 1))

    if len(ring) < 3:
        return []

    eps = rect_eps(bounds)
    cleaned = [ring[0]]
    for p in ring[1:]:
        if not same_point(cleaned[-1], p, eps):
            cleaned.append(p)
    while len(cleaned) >= 2 and same_point(cleaned[0], cleaned[-1], eps):
        cleaned.pop()

    return cleaned if len(cleaned) >= 3 else []


def ring_needs_clipping(ring, bounds):
    xmin, xmax, ymin, ymax = bounds
    for x, y in ring:
        if x < xmin or x > xmax or y < ymin or y > ymax:
            return True
    return False


# =============================================================================
# CURVES -> OPEN SVG PATHS
# =============================================================================

def sample_bezier_spline(spline, matrix_world):
    points = spline.bezier_points
    if len(points) < 2:
        return []

    result = []
    count = len(points)
    segments = count if spline.use_cyclic_u else count - 1

    for i in range(segments):
        a = points[i]
        b = points[(i + 1) % count]
        samples = interpolate_bezier(
            a.co, a.handle_right, b.handle_left, b.co,
            BEZIER_SAMPLES_PER_SEGMENT + 1,
        )
        for j, p in enumerate(samples):
            if result and j == 0:
                continue
            world = matrix_world @ p
            result.append((world.x, world.y))

    return result


def spline_to_world_polyline(spline, matrix_world):
    if spline.type == "POLY":
        return [
            (lambda w: (w.x, w.y))(matrix_world @ Vector((p.co.x, p.co.y, p.co.z)))
            for p in spline.points
        ]

    if spline.type == "BEZIER":
        return sample_bezier_spline(spline, matrix_world)

    # NURBS control points are not the evaluated centreline, so exporting them
    # would silently distort the road.
    warn(
        f"Skipped a {spline.type} spline; only POLY and BEZIER splines carry an "
        "exact centreline. Convert it to a poly curve if you need it.",
        key=f"spline:{spline.type}",
    )
    return []


def extract_curve_paths(obj, depsgraph, bounds, drop_closed=False):
    """Read a curve's centreline and clip it to the crop."""
    if obj.type != "CURVE":
        warn(
            f'"{obj.name}" is {obj.type}, not CURVE, so it has no centreline to '
            "export. Keep the original blosm curves for line output.",
            key="line source not a curve",
        )
        return [], 0

    # to_curve() on an ORIGINAL object ignores modifiers even with
    # apply_modifiers=True; only the evaluated object honours them.
    source = obj.evaluated_get(depsgraph)
    try:
        curve = source.to_curve(depsgraph, apply_modifiers=True)
    except Exception:
        # Falling back to the unevaluated curve: the centreline is still exact,
        # but any deform modifier (blosm adds Shrinkwrap when terrain is on) is
        # not applied, so the line will not follow the terrain.
        warn(
            f'Read "{obj.name}" without its modifiers; curve deform modifiers '
            "such as Shrinkwrap will not be reflected in the SVG.",
            key="curve modifiers skipped",
        )
        source = obj
        try:
            curve = source.to_curve(depsgraph)
        except Exception as exc:
            warn(f'Could not read curve "{obj.name}": {exc}', key="curve read failed")
            return [], 0

    matrix = source.matrix_world
    paths = []
    dropped_closed = 0
    try:
        for spline in curve.splines:
            cyclic = bool(spline.use_cyclic_u)
            if cyclic and drop_closed:
                # A closed spline in a pedestrian or railway layer is a plaza or
                # platform outline, not a route.
                dropped_closed += 1
                continue
            points = spline_to_world_polyline(spline, matrix)
            if len(points) >= 2:
                paths.extend(clip_polyline(points, bounds, cyclic=cyclic))
    finally:
        source.to_curve_clear()

    return paths, dropped_closed


# =============================================================================
# MESHES -> CLOSED SVG PATHS (TOP-DOWN SILHOUETTE)
# =============================================================================

def in_coastline_layer(obj):
    """
    Coastlines are identified by LAYER, not by "has edges but no faces".

    A broken water multipolygon also arrives as edges with no faces, and it has
    no land-on-the-left convention, so treating it as coastline would invert
    whole regions.
    """
    if any(name_matches_layer(obj.name, layer) for layer in COASTLINE_LAYERS):
        return True
    return any(
        name_matches_layer(c.name, layer)
        for c in obj.users_collection
        for layer in COASTLINE_LAYERS
    )


def is_edge_only(mesh):
    return mesh is not None and len(mesh.polygons) == 0 and len(mesh.edges) > 0


def boundary_edges_from_upward_faces(mesh, matrix_world, map_area):
    """
    Find the top-down footprint perimeter using only upward-facing faces.

    Roofs and flat tops cover the footprint; walls are vertical and ignored;
    floors point down and are ignored. Interior ridge edges are shared by two
    upward faces, perimeter and courtyard edges by one.
    """
    world_vertices = [matrix_world @ v.co for v in mesh.vertices]

    try:
        normal_matrix = matrix_world.to_3x3().inverted().transposed()
    except ValueError:
        normal_matrix = matrix_world.to_3x3()

    min_face_area = max(map_area * MIN_PROJECTED_FACE_AREA_RATIO, 1e-16)

    def collect(want_upward):
        chosen = []
        for poly in mesh.polygons:
            normal = normal_matrix @ poly.normal
            if normal.length_squared > 0.0:
                normal.normalize()
            if want_upward:
                if normal.z <= UPWARD_NORMAL_Z_MIN:
                    continue
            elif normal.z >= -UPWARD_NORMAL_Z_MIN:
                continue

            pts = [(world_vertices[i].x, world_vertices[i].y) for i in poly.vertices]
            if abs(polygon_area(pts)) <= min_face_area:
                continue
            chosen.append(poly)
        return chosen

    selected = collect(True)
    if not selected:
        selected = collect(False)
        if selected:
            warn(
                "Used downward-facing faces because no upward faces were found; "
                "check the object's normals.",
                key="inverted normals",
            )

    edge_counts = Counter()
    edge_directions = {}
    for poly in selected:
        indices = list(poly.vertices)
        if len(indices) < 3:
            continue

        # Normalize every selected face to CCW in the projected XY plane. Its
        # outer silhouette will then be CCW and any true interior boundary CW.
        # This also handles downward-face fallback and mirrored transforms.
        projected = [(world_vertices[i].x, world_vertices[i].y) for i in indices]
        if polygon_area(projected) < 0.0:
            indices.reverse()

        for i, a in enumerate(indices):
            b = indices[(i + 1) % len(indices)]
            if a != b:
                edge = (a, b) if a < b else (b, a)
                edge_counts[edge] += 1
                edge_directions[edge] = (a, b)

    boundary = [
        edge_directions[edge]
        for edge, count in edge_counts.items()
        if count == 1
    ]
    return boundary, world_vertices


def stitch_boundary_loops(boundary_edges):
    """Turn unordered perimeter edges into closed vertex-index loops."""
    if not boundary_edges:
        return [], 0

    adjacency = defaultdict(list)
    unused = set()
    for a, b in boundary_edges:
        adjacency[a].append(b)
        adjacency[b].append(a)
        unused.add((a, b) if a < b else (b, a))

    loops = []
    unclosed = 0

    while unused:
        start, current = next(iter(unused))
        unused.discard((start, current))
        loop = [start, current]

        while True:
            if current == start:
                break
            following = None
            for neighbour in adjacency[current]:
                edge = (current, neighbour) if current < neighbour else (neighbour, current)
                if edge in unused:
                    following = neighbour
                    unused.discard(edge)
                    break
            if following is None:
                break
            current = following
            loop.append(current)

        if current == start:
            if loop[-1] == loop[0]:
                loop.pop()
            if len(loop) >= 3:
                loops.append(loop)
        else:
            unclosed += 1

    return loops, unclosed


def stitch_directed_boundary_loops(boundary_edges):
    """Turn directed roof-face perimeter edges into directed closed loops."""
    if not boundary_edges:
        return [], 0

    outgoing = defaultdict(list)
    unused = Counter(boundary_edges)
    for a, b in boundary_edges:
        outgoing[a].append(b)

    loops = []
    unclosed = 0

    while unused:
        start, current = next(iter(unused))
        edge = (start, current)
        unused[edge] -= 1
        if unused[edge] <= 0:
            del unused[edge]
        loop = [start, current]

        while current != start:
            following = None
            for neighbour in outgoing.get(current, ()):
                edge = (current, neighbour)
                if unused.get(edge, 0) > 0:
                    following = neighbour
                    unused[edge] -= 1
                    if unused[edge] <= 0:
                        del unused[edge]
                    break
            if following is None:
                break
            current = following
            loop.append(current)

        if current == start:
            loop.pop()
            if len(loop) >= 3:
                loops.append(loop)
        else:
            unclosed += 1

    return loops, unclosed


def extract_mesh_loops(obj, depsgraph, bounds, map_area):
    """Extract closed, cropped footprint rings from an evaluated mesh."""
    if obj.type not in {"MESH", "FONT"}:
        warn(
            f'"{obj.name}" is {obj.type}, not MESH or FONT; skipped.',
            key="fill not a mesh",
        )
        return [], 0

    obj_eval = obj.evaluated_get(depsgraph)
    try:
        mesh = obj_eval.to_mesh()
    except Exception as exc:
        warn(f'Could not evaluate "{obj.name}": {exc}', key="mesh eval failed")
        return [], 0

    if mesh is None:
        return [], 0

    try:
        if in_coastline_layer(obj) or is_edge_only(mesh):
            # Handled by the ocean builder or the open-water repair instead.
            return [], 0

        boundary, world_vertices = boundary_edges_from_upward_faces(
            mesh, obj_eval.matrix_world, map_area
        )
        if not boundary:
            warn(
                f'No top-facing silhouette in "{obj.name}"; check its normals.',
                key="no silhouette",
            )
            return [], 0

        index_loops, unclosed = stitch_directed_boundary_loops(boundary)

        eps = rect_eps(bounds)
        min_area = max(map_area * 1e-12, 1e-16)
        rings = []

        for loop in index_loops:
            points = [(world_vertices[i].x, world_vertices[i].y) for i in loop]

            cleaned = [points[0]]
            for p in points[1:]:
                if not same_point(cleaned[-1], p, eps):
                    cleaned.append(p)
            while len(cleaned) >= 2 and same_point(cleaned[0], cleaned[-1], eps):
                cleaned.pop()
            if len(cleaned) < 3 or abs(polygon_area(cleaned)) <= min_area:
                continue

            if ring_needs_clipping(cleaned, bounds):
                cleaned = clip_polygon_to_rect(cleaned, bounds)
                if len(cleaned) < 3 or abs(polygon_area(cleaned)) <= min_area:
                    continue

            rings.append(cleaned)

        return rings, unclosed

    finally:
        obj_eval.to_mesh_clear()


def extract_deck_rings(obj, depsgraph, bounds, map_area):
    """
    Closed footprint rings for a deck object, whichever way blosm built it.

    An area-mapped highway can arrive as a flat mesh or as a closed curve
    depending on the import settings, and a deck is worth having either way.
    """
    if obj.type == "CURVE":
        source = obj.evaluated_get(depsgraph)
        try:
            curve = source.to_curve(depsgraph, apply_modifiers=True)
        except Exception:
            source = obj
            try:
                curve = source.to_curve(depsgraph)
            except Exception as exc:
                warn(f'Could not read deck curve "{obj.name}": {exc}',
                     key="deck curve read failed")
                return []

        min_area = max(map_area * 1e-12, 1e-16)
        rings = []
        try:
            for spline in curve.splines:
                if not spline.use_cyclic_u:
                    # An open spline is a route through the area, not its edge.
                    continue
                points = spline_to_world_polyline(spline, source.matrix_world)
                if len(points) < 3:
                    continue
                if ring_needs_clipping(points, bounds):
                    points = clip_polygon_to_rect(points, bounds)
                if len(points) >= 3 and abs(polygon_area(points)) > min_area:
                    rings.append(points)
        finally:
            source.to_curve_clear()
        return rings

    rings, _ = extract_mesh_loops(obj, depsgraph, bounds, map_area)
    return rings


def build_decks(depsgraph, bounds, map_area, counts):
    """
    Collect the mapped surfaces that must read as land rather than water.

    Returns solids in WORLD winding, ready to be cut out of the water fills.
    """
    objects, matched = objects_for_layers(DECK_LAYERS, quiet=True)
    if not objects:
        log(
            "Decks: no pedestrian-area or pier layers found. blosm only creates "
            "them when the matching area import is enabled, and clean_osm.py "
            "must not have stripped them. Without decks the sea runs under any "
            "pier."
        )
        return []

    rings = []
    for obj in objects:
        rings.extend(extract_deck_rings(obj, depsgraph, bounds, map_area))

    if not rings:
        return []

    solids, stats = flatten_overlaps(rings, MAX_UNION_CLUSTER_RINGS)
    counts["deck_rings"] += len(rings)
    counts["deck_union_refused"] += stats["refused"]
    counts["deck_union_skipped"] += stats["skipped"]
    log(
        f"Decks: {len(objects)} object(s) -> {len(rings)} rings -> "
        f'{len(solids)} surface(s) (layers: {", ".join(matched)})'
        + (f'; merged {stats["merged"]} overlapping rings' if stats["merged"] else "")
    )
    return solids


# =============================================================================
# COASTLINES -> OCEAN FILL
# =============================================================================

def trace_directed_runs(directed_edges):
    """
    Follow directed edges head-to-tail into maximal runs.

    Direction is the whole point: blosm builds each coastline edge from the OSM
    way's own point order, so v1 -> v2 still has land on the left.
    """
    outgoing = defaultdict(list)
    indegree = Counter()
    for a, b in directed_edges:
        if a != b:
            outgoing[a].append(b)
            indegree[b] += 1

    def walk(start):
        run = [start]
        current = start
        while outgoing[current]:
            following = outgoing[current].pop()
            run.append(following)
            current = following
            if current == start:
                break
        return run

    runs = []
    vertices = list(outgoing.keys())
    for vertex in vertices:
        if indegree[vertex] == 0:
            while outgoing[vertex]:
                runs.append(walk(vertex))
    for vertex in vertices:
        while outgoing[vertex]:
            runs.append(walk(vertex))

    return runs


def coastline_ways_from_mesh(obj, depsgraph):
    obj_eval = obj.evaluated_get(depsgraph)
    try:
        mesh = obj_eval.to_mesh()
    except Exception as exc:
        warn(f'Could not evaluate coastline "{obj.name}": {exc}', key="coast eval")
        return []

    if mesh is None:
        return []

    try:
        if not (in_coastline_layer(obj) or is_edge_only(mesh)):
            return []

        matrix = obj_eval.matrix_world
        vertices = [matrix @ v.co for v in mesh.vertices]
        edges = [(e.vertices[0], e.vertices[1]) for e in mesh.edges]

        return [
            [(vertices[i].x, vertices[i].y) for i in run]
            for run in trace_directed_runs(edges)
            if len(run) >= 2
        ]
    finally:
        obj_eval.to_mesh_clear()


def coastline_ways_from_curve(obj, depsgraph):
    source = obj.evaluated_get(depsgraph)
    try:
        curve = source.to_curve(depsgraph, apply_modifiers=True)
    except Exception:
        source = obj
        try:
            curve = source.to_curve(depsgraph)
        except Exception:
            return []

    try:
        ways = []
        for spline in curve.splines:
            points = spline_to_world_polyline(spline, source.matrix_world)
            if spline.use_cyclic_u and len(points) >= 3:
                points = points + [points[0]]
            if len(points) >= 2:
                ways.append(points)
        return ways
    finally:
        source.to_curve_clear()


def build_ocean(objects, depsgraph, bounds, land_seeds):
    ways = []
    for obj in objects:
        if obj.type == "MESH":
            ways.extend(coastline_ways_from_mesh(obj, depsgraph))
        elif obj.type == "CURVE":
            ways.extend(coastline_ways_from_curve(obj, depsgraph))

    if not ways:
        return [], {"mode": "none", "ways": 0}

    chains = stitch_directed_chains(ways, quantum=rect_eps(bounds))
    rings, info = build_water_rings(chains, bounds, land_seeds=land_seeds)
    info["ways"] = len(ways)
    return rings, info


# =============================================================================
# INCOMPLETE WATER AREAS -> CLOSED FILLS
# =============================================================================

def face_free_edge_runs(mesh):
    """
    Edges that belong to no face.

    That is exactly what blosm leaves behind for a broken water multipolygon:
    it gives up on building the polygon and renders the members as linestrings.
    """
    face_edges = set()
    for poly in mesh.polygons:
        indices = list(poly.vertices)
        for i, a in enumerate(indices):
            b = indices[(i + 1) % len(indices)]
            if a != b:
                face_edges.add((a, b) if a < b else (b, a))

    loose = [
        (e.vertices[0], e.vertices[1])
        for e in mesh.edges
        if (min(e.vertices), max(e.vertices)) not in face_edges
    ]
    return trace_directed_runs(loose)


def open_water_ways(obj, depsgraph):
    obj_eval = obj.evaluated_get(depsgraph)
    try:
        mesh = obj_eval.to_mesh()
    except Exception:
        return []

    if mesh is None:
        return []

    try:
        matrix = obj_eval.matrix_world
        vertices = [matrix @ v.co for v in mesh.vertices]
        return [
            [(vertices[i].x, vertices[i].y) for i in run]
            for run in face_free_edge_runs(mesh)
            if len(run) >= 2
        ]
    finally:
        obj_eval.to_mesh_clear()


def close_open_water(ways, bounds, water_seeds, land_seeds):
    """
    Close a water outline that runs off the edge of the imported OSM area.

    Water outlines carry no direction convention, so the side is decided by
    evidence rather than guessed: the candidate must contain points known to be
    water AND more of them than it contains buildings, and it must not cover
    most of the crop. Without that evidence the repair is refused -- a gap in
    the river is much better than a flooded plaque.

    Water evidence here comes from the water polygons blosm DID manage to build,
    since a broken fragment normally sits next to a complete one.
    """
    seeds = subsample(land_seeds or (), MAX_ORIENTATION_SEEDS)
    rings = []
    reasons = Counter()

    for points in ways:
        ring, reason = close_open_water_ring(
            points,
            bounds,
            water_seeds=water_seeds,
            land_seeds=seeds,
            max_area_fraction=MAX_REPAIRED_WATER_AREA_FRACTION,
        )
        reasons[reason] += 1
        if ring:
            rings.append(ring)

    return rings, reasons


# =============================================================================
# RING ORIENTATION FOR NON-ZERO FILL
# =============================================================================

class NestingIndex:
    """
    Grid index for "which larger rings contain this point".

    A single blosm buildings object can hold tens of thousands of rings, and the
    naive all-pairs containment test is quadratic enough to look like a hang.
    """

    RESOLUTION = 96

    def __init__(self, entries, bounds):
        self.bounds = bounds
        self.cells = defaultdict(list)
        xmin, xmax, ymin, ymax = bounds
        self.scale_x = self.RESOLUTION / max(xmax - xmin, 1e-12)
        self.scale_y = self.RESOLUTION / max(ymax - ymin, 1e-12)
        self.xmin = xmin
        self.ymin = ymin

        for entry in entries:
            bbox = entry[1]
            for key in self._keys(bbox):
                self.cells[key].append(entry)

    def _keys(self, bbox):
        x0 = int((bbox[0] - self.xmin) * self.scale_x)
        x1 = int((bbox[1] - self.xmin) * self.scale_x)
        y0 = int((bbox[2] - self.ymin) * self.scale_y)
        y1 = int((bbox[3] - self.ymin) * self.scale_y)
        x0 = max(0, min(self.RESOLUTION, x0))
        x1 = max(0, min(self.RESOLUTION, x1))
        y0 = max(0, min(self.RESOLUTION, y0))
        y1 = max(0, min(self.RESOLUTION, y1))
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                yield (cx, cy)

    def containing(self, point):
        key = (
            max(0, min(self.RESOLUTION, int((point[0] - self.xmin) * self.scale_x))),
            max(0, min(self.RESOLUTION, int((point[1] - self.ymin) * self.scale_y))),
        )
        return self.cells.get(key, ())


def orient_rings(rings, bounds, y_flips=True):
    """
    Wind rings so the compound path is correct under BOTH fill rules.

    fill-rule=evenodd alone would be enough for a well-behaved renderer, but
    Bambu Suite is not documented to honour it, so outer rings and holes are
    given opposite winding as well.
    """
    usable = [r for r in rings if len(r) >= 3]
    if not usable:
        return []

    entries = []
    for ring in usable:
        area = polygon_area(ring)
        entries.append((abs(area), polygon_bbox(ring), ring))
    entries.sort(key=lambda item: item[0], reverse=True)

    if len(entries) > MAX_LOOPS_FOR_NESTING:
        warn(
            f"{len(entries)} rings in one object; skipping hole detection and "
            "relying on fill-rule=evenodd. Raise MAX_LOOPS_FOR_NESTING to force "
            "the analysis, or split the object.",
            key="nesting skipped",
        )
        return [_wind_for_svg(ring, hole=False, flip=y_flips) for _, _, ring in entries]

    index = NestingIndex(entries, bounds)
    oriented = []

    for area, _bbox, ring in entries:
        sample = ring[0]
        depth = 0
        for other_area, other_bbox, other in index.containing(sample):
            if other is ring or other_area <= area:
                continue
            if point_in_bbox(sample, other_bbox) and point_in_polygon(sample, other):
                depth += 1
        oriented.append(_wind_for_svg(ring, hole=depth % 2 == 1, flip=y_flips))

    return oriented


def orient_projected_face_rings(rings, y_flips=True):
    """
    Preserve roof-face topology for non-zero SVG filling.

    Directed extraction produces CCW outer boundaries and CW true holes.
    Normalize both for the SVG Y flip without reclassifying a nested building
    part as a courtyard merely because its footprint sits inside another one.
    """
    return [
        _wind_for_svg(ring, hole=polygon_area(ring) < 0.0, flip=y_flips)
        for ring in rings
        if len(ring) >= 3
    ]


def merge_fill_parts(rings, counts, kind, title):
    """
    Merge overlapping fill rings into non-overlapping outlines.

    Returns a list of solids in WORLD winding (outer counter-clockwise, holes
    clockwise). The rings must arrive with their TOPOLOGICAL winding -- outer
    rings counter-clockwise, real holes clockwise -- which is what the mesh
    extraction produces, because the boolean reads its inputs under non-zero.
    Do not run them through `orient_rings` first: re-deriving the winding from
    nesting turns a merely-overlapping ring into a hole, which is the bug this
    exists to prevent.

    The merge has to see every ring at once rather than one object at a time. In
    blosm's multi-object mode the parts of one venue -- and the pieces of one
    river -- arrive as separate objects.
    """
    def on_skip(size):
        warn(
            f"{size} overlapping {kind} rings in one cluster is past "
            f"MAX_UNION_CLUSTER_RINGS ({MAX_UNION_CLUSTER_RINGS}); they were "
            "left overlapping. Each still gets its own path so nothing turns "
            "white, but the overlaps burn twice. Raise the cap to merge them.",
            key=f"union cluster too large: {kind}",
        )

    def on_refuse(size):
        warn(
            f"Merging {size} overlapping {kind} rings would have lost ground, "
            "so the merge was refused and they were left overlapping. They all "
            "still burn -- each solid is its own path -- but the overlaps burn "
            "twice. This is the boolean failing to resolve a dense cluster, "
            "not missing data.",
            key=f"union refused: {kind}",
        )

    solids, stats = flatten_overlaps(
        rings, MAX_UNION_CLUSTER_RINGS, on_skip, on_refuse
    )
    counts[f"{kind}_parts_merged"] += stats["merged"]
    counts[f"{kind}_union_clusters"] += stats["clusters"]
    counts[f"{kind}_union_skipped"] += stats["skipped"]
    counts[f"{kind}_union_refused"] += stats["refused"]

    if stats["clusters"]:
        log(
            f'{title}: merged {stats["merged"]} overlapping rings in '
            f'{stats["clusters"]} cluster(s) into single outlines, so the '
            "result reads the same under either SVG fill rule."
            + (f' Refused {stats["refused"]} ring(s) whose merge would have '
               "lost ground; those were kept un-merged."
               if stats["refused"] else "")
        )
    return solids


def union_was_complete(counts, kind):
    """
    True when every overlap the union found in `kind` was actually merged.

    That is what makes a fill group safe to write as one path. `flatten_overlaps`
    only ever leaves rings overlapping in two cases -- a cluster it refused
    because the merge lost ground, and one it skipped as too large -- and both
    are counted. Everything else it returns is either boolean output or a ring
    whose bounding box overlaps nothing else with real area, so no two of those
    solids can share ground.
    """
    return (counts[f"{kind}_union_refused"] == 0
            and counts[f"{kind}_union_skipped"] == 0)


def merge_building_parts(rings, counts):
    """
    Merge overlapping building parts into one non-overlapping outline each.

    blosm represents a venue as a main footprint plus roof sections and building
    parts, and those overlap.
    """
    return merge_fill_parts(rings, counts, "building", "Buildings")


def merge_water_parts(rings, counts):
    """
    Merge overlapping water bodies into one non-overlapping outline each.

    OSM maps the same water twice more often than it maps the same building
    twice: a river relation, the basin beside it and the named junction between
    them all cover shared ground. Left overlapping they cancel and the river
    burns as bare wood -- see UNION_OVERLAPPING_WATER for the measured cost.
    """
    return merge_fill_parts(rings, counts, "water", "Water")


def solids_to_paths(solids, prefix):
    """One SVG path per solid; a fill rule can then never cross between them."""
    return [
        (
            f"{prefix}_{index:05d}",
            [
                _wind_for_svg(ring, hole=polygon_area(ring) < 0.0, flip=True)
                for ring in solid
            ],
        )
        for index, solid in enumerate(solids, 1)
    ]


def knock_structures_out_of_water(group_rings, solids, units_per_mm, counts,
                                  label):
    """Cut structures out of one water fill, and say what happened."""
    result, cut, reason = subtract_structures(
        group_rings, solids,
        WATER_KNOCKOUT_HALO_MM * units_per_mm,
        WATER_KNOCKOUT_SEGMENTS,
    )
    if reason:
        warn(
            f"Cutting structures out of the {label} fill was refused because "
            f"{reason}. The fill was left as it was, so any building standing "
            "in it will burn into the same dark mass.",
            key="water knockout refused",
        )
        return group_rings, 0
    if not cut:
        return group_rings, 0

    counts[f"{label}_structures_knocked_out"] += cut
    log(
        f"{label.capitalize()}: cut {cut} structure(s) standing in it out of "
        f"the fill, with a {WATER_KNOCKOUT_HALO_MM} mm unburnt margin, so they "
        "read against the water instead of merging into it."
    )
    return result, cut


def _wind_for_svg(ring, hole, flip):
    # The SVG transform mirrors Y, which reverses the apparent winding.
    want_ccw_in_world = not hole
    if flip:
        want_ccw_in_world = not want_ccw_in_world
    return wound(ring, ccw=want_ccw_in_world)


# =============================================================================
# SVG PATH BUILDING
# =============================================================================

def canvas_size_mm():
    """
    The SVG's own size, which is the plaque unless EXPAND_TO_5x7 pads it.

    Everything upstream of the emitters -- culling, clipping, label placement,
    coverage -- works in plaque millimetres and knows nothing about this. The
    padding is applied once, here at the point where coordinates become text.
    """
    if not EXPAND_TO_5x7:
        return OUTPUT_WIDTH_MM, OUTPUT_HEIGHT_MM
    return (
        max(EXPAND_TO_WIDTH_MM, OUTPUT_WIDTH_MM),
        max(EXPAND_TO_HEIGHT_MM, OUTPUT_HEIGHT_MM),
    )


def canvas_offset_mm():
    """Plaque millimetres -> canvas millimetres, as a centring translation."""
    width, height = canvas_size_mm()
    return 0.5 * (width - OUTPUT_WIDTH_MM), 0.5 * (height - OUTPUT_HEIGHT_MM)


def polyline_to_d(points):
    """Points are already in output millimetres."""
    ox, oy = canvas_offset_mm()
    return " ".join(
        f"{'M' if index == 0 else 'L'} {fmt(x + ox)},{fmt(y + oy)}"
        for index, (x, y) in enumerate(points)
    )


def transform_line_groups(line_results, to_svg):
    """
    Convert every line path to output millimetres.

    Culling thresholds are laser numbers, so the culling has to run in
    millimetres rather than Blender units.
    """
    return {
        group_id: [
            (name, [[to_svg(x, y) for x, y in path] for path in paths])
            for name, paths in objects
        ]
        for group_id, objects in line_results.items()
    }


def weld_line_items(items, stats):
    """Join fragments end to end, counting the joins into `stats`."""
    if not WELD_CONNECTED_PATHS:
        return items
    items, joins = weld_paths(
        items, STUB_WELD_TOLERANCE_MM, group_fn=lambda key: key[0]
    )
    stats["welded_joins"] += joins
    return items


def solid_fill_tester(fill_results, to_svg):
    """
    "Is this millimetre of wood already burnt solid by a fill?"

    The fills are the last word on what burns dark, so the test is built from
    the geometry actually being written, after the water knockout has taken the
    piers and buildings back out of it. Rings arrive already wound for the SVG Y
    flip, outer against hole, so a non-zero winding test reads a courtyard as
    what it is: unburnt wood.
    """
    edges = []
    for group_id in SOLID_FILL_GROUPS:
        for _, rings in fill_results.get(group_id, ()):
            for ring in rings:
                points = [to_svg(x, y) for x, y in ring]
                for index, start in enumerate(points):
                    end = points[(index + 1) % len(points)]
                    if start != end:
                        edges.append((start, end))

    if not edges:
        return None

    # Row buckets, sized from the data rather than fixed: a whole city of
    # buildings in 48 rows would put a thousand edges under every query.
    lows = [min(a[1], b[1]) for a, b in edges]
    highs = [max(a[1], b[1]) for a, b in edges]
    lowest, highest = min(lows), max(highs)
    rows = max(64, min(4096, len(edges) // 8))
    scale = rows / max(highest - lowest, 1e-12)

    buckets = {}
    for index, (low, high) in enumerate(zip(lows, highs)):
        first = max(0, min(rows, int((low - lowest) * scale)))
        last = max(0, min(rows, int((high - lowest) * scale)))
        for row in range(first, last + 1):
            buckets.setdefault(row, []).append(index)

    def covered(point):
        x, y = point
        if y < lowest or y > highest:
            return False
        winding = 0
        for index in buckets.get(max(0, min(rows, int((y - lowest) * scale))), ()):
            (x0, y0), (x1, y1) = edges[index]
            # Half-open in y, so a vertex is counted by exactly one of its edges.
            if y0 <= y:
                if y1 > y and (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0.0:
                    winding += 1
            elif y1 <= y and (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0.0:
                winding -= 1
        return winding != 0

    return covered


def cull_line_groups(line_results, layer_by_object, covered_fn=None):
    """
    Weld the linework into continuous routes, remove what would burn twice,
    then prune fragments that lead nowhere.

    Everything is ranked by road class first, so a motorway is never dropped in
    favour of a service road running beside it: paths enter the index in order
    of importance, and a path can only ever be culled by something already in
    the index, which is at least as important as itself.

    WELDING RUNS FIRST, and that order is the whole reason roads stay whole.
    OSM splits one street into a dozen ways wherever a tag changes, so before
    welding a "whole path" is an arbitrary fragment, not a route. Whole-path
    culling would then happily delete the one fragment of a motorway that runs
    beside its own off-ramp -- the ramp is `motorway_link`, which ranks EQUAL to
    `motorway`, so rank does not save it -- and the road loses a piece out of
    its middle while the halves either side survive. Welded, that motorway is
    one path, and a ramp alongside 10% of it cannot reach
    CULL_PATH_SHADOW_FRACTION, so it is kept entire.

    Measured on the Cincinnati extract (map_73.osm) cropped to the plaque at
    8 km wide: culling first dropped 433 whole paths and left 12 interior gaps
    -- stretches of road with surviving road on BOTH sides, which is what reads
    as a broken road; welding first drops 138 and leaves 0, at the same 99.2%
    coverage. How much it matters depends on how hard the culling bites: on a
    tight crop where only a dozen paths are culled at all, the same change moved
    the facing-gap count from 30 to 28.
    """
    stats = Counter()

    def group_counts(current):
        return Counter(key[0] for _, key, _ in current)

    items = []
    for group_id, objects in line_results.items():
        for name, paths in objects:
            rank = layer_by_object.get(name, UNRANKED)
            for path in paths:
                items.append((rank, (group_id, name), path))
                stats["paths_before"] += 1

    stages = {"input": group_counts(items)}

    items = weld_line_items(items, stats)
    stages["after_weld"] = group_counts(items)

    if CULL_OVERLAPPING_LINES:
        def keep_whole_path(key):
            return CULL_WHOLE_PATHS_ONLY and not (
                AGGRESSIVE_PATH_CLEANUP and key[0] == "paths"
            )

        items, cull_stats = cull_ranked(
            items,
            MIN_LINE_SEPARATION_MM,
            CULL_PARALLEL_ANGLE_DEG,
            whole_paths=keep_whole_path,
            shadow_fraction=CULL_PATH_SHADOW_FRACTION,
        )
        stats["culled_paths"] = cull_stats["dropped"]
        stats["trimmed_paths"] = cull_stats["trimmed"]
        stats["culled_mm"] = int(cull_stats["removed_length"])
    stages["after_cull"] = group_counts(items)

    if COLLAPSE_FILLED_LOOPS:
        items, collapsed = collapse_filled_loops(
            items, MIN_LOOP_OPEN_RADIUS_MM, STUB_WELD_TOLERANCE_MM
        )
        stats["collapsed_loops"] = collapsed

    edge = STUB_WELD_TOLERANCE_MM

    def on_boundary(point):
        return (
            point[0] <= edge or point[0] >= OUTPUT_WIDTH_MM - edge
            or point[1] <= edge or point[1] >= OUTPUT_HEIGHT_MM - edge
        )

    if SNAP_GAP_MM > 0.0:
        items, snapped = snap_dangling_ends(
            items, SNAP_GAP_MM, STUB_WELD_TOLERANCE_MM, on_boundary=on_boundary
        )
        stats["snapped_gaps"] = snapped

    if AGGRESSIVE_PATH_CLEANUP:
        items, removed = prune_compact_tangles(
            items,
            PATH_TANGLE_MAX_SPAN_MM,
            PATH_TANGLE_MIN_SEGMENTS,
            PATH_TANGLE_MIN_LENGTH_TO_SPAN,
            STUB_WELD_TOLERANCE_MM,
            target_fn=lambda key: key[0] == "paths",
        )
        stats["pruned_compact_paths"] = removed
    stages["after_tangle"] = group_counts(items)

    # Thinning runs LAST of the removals, after the structural passes have had
    # their say. Before them it took a bite out of a compact tangle that
    # prune_compact_tangles would have removed whole, and the remnant then
    # fell under that pass's segment count and survived. It also gets a better
    # graph for the mesh test this way round, because snapping has already
    # joined the near-misses.
    if RELIEVE_DENSE_CLUSTERS:
        items, dense_stats = relieve_dense_clusters(
            items,
            DENSE_CLUSTER_LIMIT_MM_PER_MM2,
            DENSE_CLUSTER_WINDOW_MM,
            DENSE_CLUSTER_SEPARATION_MM,
            CULL_PARALLEL_ANGLE_DEG,
            hot_fraction=DENSE_CLUSTER_HOT_FRACTION,
            shadow_fraction=DENSE_CLUSTER_SHADOW_FRACTION,
            protect_rank=DENSE_CLUSTER_PROTECT_RANK,
            mesh_max_length=DENSE_CLUSTER_MESH_MAX_MM,
            mesh_detour=DENSE_CLUSTER_MESH_DETOUR,
            weld_tolerance=STUB_WELD_TOLERANCE_MM,
            covered_fn=covered_fn if DENSE_CLUSTER_COUNTS_SOLID_FILL else None,
            covered_limit_scale=DENSE_CLUSTER_COVERED_LIMIT_SCALE,
        )
        stats["dense_dropped"] = dense_stats["dropped"]
        stats["dense_mesh"] = dense_stats["mesh_dropped"]
        stats["dense_mm"] = int(dense_stats["removed_length"])
        stats["dense_cells"] = dense_stats["hot_cells"]
    stages["after_density"] = group_counts(items)


    # Weld again: culling can trim a path into pieces and snapping can bring two
    # ends together, and both leave joins the first pass could not have seen.
    items = weld_line_items(items, stats)
    stages["after_reweld"] = group_counts(items)

    if PRUNE_DANGLING_STUBS_MM > 0.0:
        def stub_limit(key):
            if AGGRESSIVE_PATH_CLEANUP and key[0] == "paths":
                return PATH_DANGLING_STUBS_MM
            return PRUNE_DANGLING_STUBS_MM

        items, pruned = prune_dangling_stubs(
            items, stub_limit, STUB_WELD_TOLERANCE_MM,
            on_boundary=on_boundary,
        )
        stats["pruned_stubs"] = pruned
    stages["after_prune"] = group_counts(items)

    group_ids = set().union(*(counts.keys() for counts in stages.values()))
    stats["by_group"] = {
        group_id: {stage: counts[group_id] for stage, counts in stages.items()}
        for group_id in sorted(group_ids)
    }

    rebuilt = {group_id: {} for group_id in line_results}
    for _, (group_id, name), path in items:
        rebuilt.setdefault(group_id, {}).setdefault(name, []).append(path)
        stats["paths_after"] += 1

    return (
        {gid: list(objs.items()) for gid, objs in rebuilt.items()},
        stats,
    )


def line_coverage(original, final):
    """
    Fraction of the original linework still represented by SOME kept line.

    Culling a duplicated carriageway is fine; making a street disappear is not.
    This tells the two apart.
    """
    kept = [path for objects in final.values() for _, paths in objects for path in paths]
    if not kept:
        return 0.0

    tolerance = CULL_COVERAGE_TOLERANCE_MM
    grid = SegmentGrid(kept, tolerance)
    covered = 0.0
    total = 0.0

    for objects in original.values():
        for _, paths in objects:
            for path in paths:
                for a, b in zip(path[:-1], path[1:]):
                    length = math.hypot(b[0] - a[0], b[1] - a[1])
                    total += length
                    midpoint = ((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)
                    near = grid.near(midpoint)
                    if near and min(
                        _point_segment_distance_sq(midpoint, x, y)
                        for x, y, _ in near
                    ) <= tolerance * tolerance:
                        covered += length

    return covered / total if total else 0.0


def rings_to_d(rings, to_svg):
    ox, oy = canvas_offset_mm()
    chunks = []
    for ring in rings:
        if len(ring) < 3:
            continue
        pieces = []
        for index, (x, y) in enumerate(ring):
            sx, sy = to_svg(x, y)
            pieces.append(
                f"{'M' if index == 0 else 'L'} {fmt(sx + ox)},{fmt(sy + oy)}"
            )
        pieces.append("Z")
        chunks.append(" ".join(pieces))
    return " ".join(chunks)


def rect_d(x, y, width, height):
    ox, oy = canvas_offset_mm()
    x, y = x + ox, y + oy
    x2, y2 = x + width, y + height
    return (
        f"M {fmt(x)},{fmt(y)} L {fmt(x2)},{fmt(y)} "
        f"L {fmt(x2)},{fmt(y2)} L {fmt(x)},{fmt(y2)} Z"
    )


def cut_rect_d():
    """
    The cut outline, which follows the CANVAS edge rather than the plaque's.

    Everything else in the SVG is plaque artwork centred by canvas_offset_mm();
    this is the one thing EXPAND_TO_5x7 grows, because the padding is meant to
    come off the bed as part of the piece -- a blank margin outside the
    decorative border -- not to be trimmed away with the offcut.
    """
    width, height = canvas_size_mm()
    return (
        f"M {fmt(0.0)},{fmt(0.0)} L {fmt(width)},{fmt(0.0)} "
        f"L {fmt(width)},{fmt(height)} L {fmt(0.0)},{fmt(height)} Z"
    )


def rect_line_d(x, y, width, height):
    """A rectangle as four open line segments, not one closed path."""
    ox, oy = canvas_offset_mm()
    x, y = x + ox, y + oy
    x2, y2 = x + width, y + height
    return (
        f"M {fmt(x)},{fmt(y)} L {fmt(x2)},{fmt(y)} "
        f"M {fmt(x2)},{fmt(y)} L {fmt(x2)},{fmt(y2)} "
        f"M {fmt(x2)},{fmt(y2)} L {fmt(x)},{fmt(y2)} "
        f"M {fmt(x)},{fmt(y2)} L {fmt(x)},{fmt(y)}"
    )


def band_d(centre_inset, thickness):
    """A closed rectangular band, as an outer ring plus a reversed inner ring."""
    pad_x, pad_y = canvas_offset_mm()
    outer = centre_inset - thickness * 0.5
    inner = centre_inset + thickness * 0.5
    ow = OUTPUT_WIDTH_MM - 2.0 * outer
    oh = OUTPUT_HEIGHT_MM - 2.0 * outer
    iw = OUTPUT_WIDTH_MM - 2.0 * inner
    ih = OUTPUT_HEIGHT_MM - 2.0 * inner

    outer_x, outer_y = outer + pad_x, outer + pad_y
    inner_x, inner_y = inner + pad_x, inner + pad_y
    ox2, oy2 = outer_x + ow, outer_y + oh
    ix2, iy2 = inner_x + iw, inner_y + ih
    return (
        f"M {fmt(outer_x)},{fmt(outer_y)} L {fmt(ox2)},{fmt(outer_y)} "
        f"L {fmt(ox2)},{fmt(oy2)} L {fmt(outer_x)},{fmt(oy2)} Z "
        f"M {fmt(inner_x)},{fmt(inner_y)} L {fmt(inner_x)},{fmt(iy2)} "
        f"L {fmt(ix2)},{fmt(iy2)} L {fmt(ix2)},{fmt(inner_y)} Z"
    )


def rect_band_d(x, y, width, height, thickness):
    """A rectangular filled band whose supplied rectangle is its outside."""
    ox, oy = canvas_offset_mm()
    x, y = x + ox, y + oy
    x2, y2 = x + width, y + height
    ix, iy = x + thickness, y + thickness
    ix2, iy2 = x2 - thickness, y2 - thickness
    return (
        f"M {fmt(x)},{fmt(y)} L {fmt(x2)},{fmt(y)} "
        f"L {fmt(x2)},{fmt(y2)} L {fmt(x)},{fmt(y2)} Z "
        f"M {fmt(ix)},{fmt(iy)} L {fmt(ix)},{fmt(iy2)} "
        f"L {fmt(ix2)},{fmt(iy2)} L {fmt(ix2)},{fmt(iy)} Z"
    )


def outside_rect_regions(bounds, cut_rect):
    """Non-overlapping rectangles covering `bounds` except `cut_rect`."""
    xmin, xmax, ymin, ymax = bounds
    cut_x, cut_y, cut_w, cut_h = cut_rect
    x0 = max(xmin, cut_x)
    x1 = min(xmax, cut_x + cut_w)
    y0 = max(ymin, cut_y)
    y1 = min(ymax, cut_y + cut_h)
    if x0 >= x1 or y0 >= y1:
        return [bounds]

    regions = []
    for region in (
        (xmin, xmax, ymin, y0),
        (xmin, xmax, y1, ymax),
        (xmin, x0, y0, y1),
        (x1, xmax, y0, y1),
    ):
        if region[1] > region[0] and region[3] > region[2]:
            regions.append(region)
    return regions


def clip_line_results_outside_rect(line_results, cut_rect):
    """Geometrically remove every line segment hidden by the label box."""
    canvas = (0.0, OUTPUT_WIDTH_MM, 0.0, OUTPUT_HEIGHT_MM)
    regions = outside_rect_regions(canvas, cut_rect)
    clipped = {}
    for group_id, objects in line_results.items():
        output_objects = []
        for name, paths in objects:
            output_paths = []
            for path in paths:
                for region in regions:
                    output_paths.extend(clip_polyline(path, region))
            if output_paths:
                output_objects.append((name, output_paths))
        clipped[group_id] = output_objects
    return clipped


def clip_fill_results_outside_rect(fill_results, bounds, cut_bounds):
    """Geometrically remove filled map artwork hidden by the label box."""
    regions = outside_rect_regions(bounds, (
        cut_bounds[0], cut_bounds[2],
        cut_bounds[1] - cut_bounds[0], cut_bounds[3] - cut_bounds[2],
    ))
    min_area = max(
        (bounds[1] - bounds[0]) * (bounds[3] - bounds[2]) * 1e-12,
        1e-16,
    )
    clipped = {}
    for group_id, objects in fill_results.items():
        output_objects = []
        for name, rings in objects:
            output_rings = []
            for ring in rings:
                for region in regions:
                    piece = clip_polygon_to_rect(ring, region)
                    if len(piece) >= 3 and abs(polygon_area(piece)) > min_area:
                        output_rings.append(piece)
            if output_rings:
                output_objects.append((name, output_rings))
        clipped[group_id] = output_objects
    return clipped


def svg_rect_to_world_bounds(rect, bounds, map_rect):
    """Inverse of make_transform for an axis-aligned SVG rectangle."""
    x, y, width, height = rect
    xmin, xmax, ymin, ymax = bounds
    map_x, map_y, map_w, map_h = map_rect
    scale_x = map_w / (xmax - xmin)
    scale_y = map_h / (ymax - ymin)
    top = map_y + map_h

    world_x0 = xmin + (x - map_x) / scale_x
    world_x1 = xmin + (x + width - map_x) / scale_x
    world_y0 = ymin + (top - (y + height)) / scale_y
    world_y1 = ymin + (top - y) / scale_y
    return (
        min(world_x0, world_x1), max(world_x0, world_x1),
        min(world_y0, world_y1), max(world_y0, world_y1),
    )


def layout_label_rings(rings):
    """Scale outlined glyph rings and anchor their box in the configured corner."""
    points = [point for ring in rings for point in ring]
    if not points:
        return None

    min_x = min(point[0] for point in points)
    max_x = max(point[0] for point in points)
    min_y = min(point[1] for point in points)
    max_y = max(point[1] for point in points)
    raw_width = max_x - min_x
    raw_height = max_y - min_y
    if raw_width <= 1e-12 or raw_height <= 1e-12:
        return None

    box_scale = min(
        LABEL_TEXT_HEIGHT_MM / raw_height,
        LABEL_MAX_TEXT_WIDTH_MM / raw_width,
    )
    text_scale = box_scale * LABEL_TEXT_SCALE
    box_text_width = raw_width * box_scale
    box_text_height = raw_height * box_scale
    text_width = raw_width * text_scale
    text_height = raw_height * text_scale
    box_width = box_text_width + 2.0 * (LABEL_PADDING_X_MM + LABEL_BORDER_WIDTH_MM)
    box_height = box_text_height + 2.0 * (LABEL_PADDING_Y_MM + LABEL_BORDER_WIDTH_MM)

    rotation = int(LABEL_ROTATION_DEG) % 360
    if rotation not in (0, 90, 180, 270):
        raise RuntimeError(
            "LABEL_ROTATION_DEG must be 0, 90, 180 or 270 -- the box and the "
            "knockout behind it stay axis-aligned, so only right angles work."
        )
    if rotation in (90, 270):
        box_width, box_height = box_height, box_width

    thin_centre = (
        OUTER_GAP_MM
        + THICK_BORDER_STROKE_WIDTH_MM
        + THICK_TO_THIN_GAP_MM
        + 0.5 * THIN_BORDER_STROKE_WIDTH_MM
    )
    thin_inner_edge = thin_centre + 0.5 * THIN_BORDER_STROKE_WIDTH_MM
    inset = thin_inner_edge + LABEL_BORDER_GAP_MM
    corner = LABEL_CORNER.lower().strip().replace("-", "_").replace(" ", "_")

    if corner in {"lower_right", "bottom_right"}:
        left = OUTPUT_WIDTH_MM - inset - box_width
        top = OUTPUT_HEIGHT_MM - inset - box_height
    elif corner in {"lower_left", "bottom_left"}:
        left = inset
        top = OUTPUT_HEIGHT_MM - inset - box_height
    elif corner in {"upper_right", "top_right"}:
        left = OUTPUT_WIDTH_MM - inset - box_width
        top = inset
    elif corner in {"upper_left", "top_left"}:
        left = inset
        top = inset
    else:
        raise RuntimeError(
            'LABEL_CORNER must be one of "lower_right", "lower_left", '
            '"upper_right", or "upper_left".'
        )

    if (
        left <= thin_inner_edge or top <= thin_inner_edge
        or left + box_width >= OUTPUT_WIDTH_MM - thin_inner_edge
        or top + box_height >= OUTPUT_HEIGHT_MM - thin_inner_edge
    ):
        raise RuntimeError(
            "Label does not fit inside the decorative border. Reduce "
            "LABEL_TEXT_HEIGHT_MM, LABEL_MAX_TEXT_WIDTH_MM, or its padding."
        )

    centre_x = left + box_width * 0.5
    centre_y = top + box_height * 0.5
    # Right angles only, so rounding makes these exactly 0 or +/-1.
    cos_a = round(math.cos(math.radians(rotation)))
    sin_a = round(math.sin(math.radians(rotation)))
    transformed = []
    for ring in rings:
        placed = []
        for x, y in ring:
            offset_x = (x - min_x) * text_scale - text_width * 0.5
            offset_y = (max_y - y) * text_scale - text_height * 0.5
            placed.append((
                centre_x + offset_x * cos_a - offset_y * sin_a,
                centre_y + offset_x * sin_a + offset_y * cos_a,
            ))
        transformed.append(placed)
    return {
        "box": (left, top, box_width, box_height),
        "rings": transformed,
        "text_width": text_width,
        "text_height": text_height,
    }


def build_label_artwork():
    """Convert LABEL_TEXT in the label font to closed SVG-ready outline rings."""
    if not EXPORT_LABEL or not LABEL_TEXT.strip():
        return None

    font_path = Path(LABEL_FONT_PATH)
    if not font_path.exists():
        raise RuntimeError(
            f'Label font not found at "{font_path}". Set LABEL_FONT_PATH to '
            "an installed .ttf -- COPRGTB.TTF is Copperplate Gothic Bold -- "
            "or disable EXPORT_LABEL."
        )

    curve = None
    obj = None
    try:
        font = bpy.data.fonts.load(str(font_path), check_existing=True)
        curve = bpy.data.curves.new("Jarvizar_Label_Font", type="FONT")
        curve.body = LABEL_TEXT
        curve.font = font
        curve.size = 1.0
        curve.fill_mode = "BOTH"
        curve.resolution_u = 12

        obj = bpy.data.objects.new("Jarvizar_Label_Font", curve)
        bpy.context.scene.collection.objects.link(obj)
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        rings, unclosed = extract_mesh_loops(
            obj, depsgraph, (-1000.0, 1000.0, -1000.0, 1000.0), 1.0
        )
        if unclosed:
            warn(
                f"Label font produced {unclosed} unclosed outline(s).",
                key="label unclosed outlines",
            )
        artwork = layout_label_rings(rings)
        if artwork is None:
            raise RuntimeError("Label font produced no usable outline geometry.")
        return artwork
    finally:
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)
        if curve is not None:
            bpy.data.curves.remove(curve)


# =============================================================================
# SVG WRITER
# =============================================================================

def write_svg(path, to_svg, line_results, fill_results, label_artwork=None,
              fill_disjoint=None):
    canvas_w, canvas_h = canvas_size_mm()
    pad_x, pad_y = canvas_offset_mm()
    padding_note = (
        ""
        if pad_x <= 0.0 and pad_y <= 0.0 else
        f" The artwork is {fmt(OUTPUT_WIDTH_MM)} x {fmt(OUTPUT_HEIGHT_MM)} mm, "
        f"centred with {fmt(pad_x)} mm of blank space left and right and "
        f"{fmt(pad_y)} mm top and bottom (EXPAND_TO_5x7); cut_border is the "
        "canvas edge."
    )
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            '<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{fmt(canvas_w)}mm" '
            f'height="{fmt(canvas_h)}mm" '
            f'viewBox="0 0 {fmt(canvas_w)} {fmt(canvas_h)}">'
        ),
        (
            "  <metadata>Jarvizar laser map. One colour per intended Bambu Suite "
            "process. Filled paths = Laser Fill, open paths = Laser Line, "
            "cut_border = Laser Cut. A fill group is one path where its solids "
            "cannot overlap, and one path per solid where they can, so no fill "
            "rule can make two of them cancel. Verify the imported size is "
            f"{fmt(canvas_w)} x {fmt(canvas_h)} mm."
            f"{padding_note}</metadata>"
        ),
    ]

    thick_centre = OUTER_GAP_MM + 0.5 * THICK_BORDER_STROKE_WIDTH_MM
    thin_centre = (
        OUTER_GAP_MM
        + THICK_BORDER_STROKE_WIDTH_MM
        + THICK_TO_THIN_GAP_MM
        + 0.5 * THIN_BORDER_STROKE_WIDTH_MM
    )

    if EXPORT_DECORATIVE_BORDER and THICK_BORDER_AS_FILL:
        style = svg_group_style(DECORATIVE_BORDER_FILL_GROUP_ID, {"stroke": "none"})
        out.append(
            f'  <g id="{sanitize_id(DECORATIVE_BORDER_FILL_GROUP_ID)}" '
            f'{style} fill-rule="evenodd">'
        )
        out.append(
            f'    <path id="decorative_border_band" '
            f'd="{band_d(thick_centre, THICK_BORDER_STROKE_WIDTH_MM)}"/>'
        )
        out.append("  </g>")

    # Fills first, so the preview stacks the way the engraving reads: water
    # underneath, buildings on top of it rather than buried under the sea.
    ordered = [g for g in FILL_DRAW_ORDER if g in fill_results]
    ordered += [g for g in fill_results if g not in ordered]

    disjoint = fill_disjoint or {}

    for group_id in ordered:
        objects = fill_results[group_id]
        if not objects:
            continue
        style = svg_group_style(group_id, {"fill": "#000000", "stroke": "none"})
        out.append(
            f'  <g id="{sanitize_id(group_id)}" {style} fill-rule="evenodd">'
        )

        # ONE PATH PER SOLID UNLESS THE SOLIDS ARE KNOWN NOT TO OVERLAP. A fill
        # rule only applies within a single path, so two solids sharing ground
        # in one path cancel to bare wood -- which is what lets a refused merge
        # (see `union_covers`) keep overlapping rings safely, one path each.
        # Disjoint solids cannot cancel under either rule, so combining those
        # into one path is only a change of bookkeeping: Suite lists one object
        # per path, and 300 separate building paths is 300 entries to organise.
        # `fill_disjoint` carries a fact the pipeline established, never a
        # guess; without one, this stays one path per solid.
        if COMBINE_FILL_PATHS and disjoint.get(group_id):
            chunks = []
            for _, rings in objects:
                d = rings_to_d(rings, to_svg)
                if d:
                    chunks.append(d)
            if chunks:
                out.append(
                    f'    <path id="{sanitize_id(group_id)}_all" '
                    f'd="{" ".join(chunks)}"/>'
                )
        else:
            for index, (name, rings) in enumerate(objects, 1):
                d = rings_to_d(rings, to_svg)
                if d:
                    out.append(
                        f'    <path id="{sanitize_id(group_id)}_{index:05d}" '
                        f'd="{d}"/>'
                    )
        out.append("  </g>")

    for group_id, objects in line_results.items():
        if not objects:
            continue
        style = svg_group_style(group_id, {"fill": "none", "stroke": "#000000"})
        out.append(
            f'  <g id="{sanitize_id(group_id)}" {style} '
            f'stroke-width="{fmt(LINE_STROKE_WIDTH_MM)}" '
            f'stroke-linecap="butt" stroke-linejoin="round">'
        )
        chunks = []
        for name, paths in objects:
            for polyline in paths:
                d = polyline_to_d(polyline)
                if not d:
                    continue
                chunks.append(d)
        if chunks:
            out.append(
                f'    <path id="{sanitize_id(group_id)}_all" '
                f'd="{" ".join(chunks)}"/>'
            )
        out.append("  </g>")

    if label_artwork:
        style = svg_group_style(LABEL_GROUP_ID, {"fill": "#1A1A1A", "stroke": "none"})
        x, y, width, height = label_artwork["box"]
        text_d = rings_to_d(label_artwork["rings"], lambda px, py: (px, py))
        if text_d:
            out.append(
                f'  <g id="{sanitize_id(LABEL_GROUP_ID)}" {style} fill-rule="nonzero">'
            )
            out.append(f'    <path id="map_label_text" d="{text_d}"/>')
            out.append("  </g>")

        border_style = svg_group_style(
            LABEL_BORDER_GROUP_ID, {"fill": "none", "stroke": "#CC79A7"}
        )
        out.append(
            f'  <g id="{sanitize_id(LABEL_BORDER_GROUP_ID)}" {border_style} '
            f'stroke-width="{fmt(LABEL_BORDER_WIDTH_MM)}" '
            f'stroke-linecap="butt" stroke-linejoin="miter">'
        )
        out.append(
            f'    <path id="map_label_border_line" '
            f'd="{rect_line_d(x, y, width, height)}"/>'
        )
        out.append("  </g>")

    if EXPORT_DECORATIVE_BORDER:
        style = svg_group_style(DECORATIVE_BORDER_GROUP_ID, {"fill": "none"})
        out.append(
            f'  <g id="{sanitize_id(DECORATIVE_BORDER_GROUP_ID)}" '
            f'{style} stroke-linejoin="miter">'
        )
        if not THICK_BORDER_AS_FILL:
            out.append(
                f'    <path id="decorative_border_thick" '
                f'd="{rect_d(thick_centre, thick_centre, OUTPUT_WIDTH_MM - 2.0 * thick_centre, OUTPUT_HEIGHT_MM - 2.0 * thick_centre)}" '
                f'stroke-width="{fmt(THICK_BORDER_STROKE_WIDTH_MM)}"/>'
            )
        out.append(
            f'    <path id="decorative_border_thin" '
            f'd="{rect_d(thin_centre, thin_centre, OUTPUT_WIDTH_MM - 2.0 * thin_centre, OUTPUT_HEIGHT_MM - 2.0 * thin_centre)}" '
            f'stroke-width="{fmt(THIN_BORDER_STROKE_WIDTH_MM)}"/>'
        )
        out.append("  </g>")

    if EXPORT_BORDER:
        style = svg_group_style(BORDER_GROUP_ID, {"fill": "none"})
        out.append(
            f'  <g id="{sanitize_id(BORDER_GROUP_ID)}" {style} '
            f'stroke-width="{fmt(LINE_STROKE_WIDTH_MM)}">'
        )
        out.append(
            f'    <path id="map_border" '
            f'd="{cut_rect_d()}"/>'
        )
        out.append("  </g>")

    out.append("</svg>")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out), encoding="utf-8")


# =============================================================================
# MAIN
# =============================================================================

def blend_name():
    """
    The .blend file's own name, for naming the export after it.

    An unsaved file has no name at all, so it gets the project's name rather
    than an empty one -- a file called "_laser_map.svg" is not a useful answer.
    """
    stem = Path(bpy.data.filepath).stem
    return stem or "jarvizar"


def resolve_output_path():
    raw = bpy.path.abspath(OUTPUT_SVG.replace("{blend}", blend_name()))
    resolved = Path(raw)
    if raw.startswith("//") or not resolved.is_absolute():
        resolved = Path.home() / resolved.name
        warn(
            f"The .blend file is unsaved, so '//' has nowhere to resolve to. "
            f"Writing to {resolved} instead."
        )
    return resolved


def main():
    start = time.perf_counter()
    _WARNINGS.clear()
    log("Starting export...")

    bounds_obj = find_bounds_object()
    if bounds_obj is None:
        wanted = " or ".join(f'"{name}"' for name in bounds_object_names())
        raise RuntimeError(
            f"Bounds object not found -- looked for {wanted}. Add a rectangle "
            "with one of those names around the area you want, or change "
            "BOUNDS_OBJECT_NAME / BOUNDS_OBJECT_ALIASES."
        )

    depsgraph = bpy.context.evaluated_depsgraph_get()
    raw_bounds, bounds_source = resolve_bounds(bounds_obj, depsgraph)

    # Compare the crop with the geometry it is cutting. That is what makes the
    # check work whether the scene is at blosm's native metres or scaled down to
    # fit the plaque.
    all_layers = [
        layer
        for layers in list(LINE_LAYERS.values()) + list(FILL_LAYERS.values())
        for layer in layers
    ] + COASTLINE_LAYERS + DECK_LAYERS
    source_objects, _ = objects_for_layers(all_layers, quiet=True)
    check_crop_against_source(raw_bounds, source_objects)
    check_source_transforms(source_objects)

    bounds, map_rect, layout_note = build_layout(raw_bounds)
    to_svg = make_transform(bounds, map_rect)

    xmin, xmax, ymin, ymax = bounds
    map_area = (xmax - xmin) * (ymax - ymin)

    units_per_mm = (xmax - xmin) / map_rect[2]
    log(f'Bounds "{bounds_obj.name}": X {xmin:.4g}..{xmax:.4g}, Y {ymin:.4g}..{ymax:.4g}')
    log(f"Crop covers {xmax - xmin:.4g} x {ymax - ymin:.4g} Blender units "
        f"(from the {bounds_source})")
    log(f"Plaque: {OUTPUT_WIDTH_MM} x {OUTPUT_HEIGHT_MM} mm")
    _canvas_w, _canvas_h = canvas_size_mm()
    _pad_x, _pad_y = canvas_offset_mm()
    if _pad_x > 0.0 or _pad_y > 0.0:
        log(
            f"Canvas: {_canvas_w:.4g} x {_canvas_h:.4g} mm -- plaque centred "
            f"with {_pad_x:.3f} mm blank left/right and {_pad_y:.3f} mm "
            "top/bottom (EXPAND_TO_5x7). The cut follows the canvas edge; the "
            "decorative border stays where it is, inside the margin."
        )
    elif EXPAND_TO_5x7:
        warn(
            f"EXPAND_TO_5x7 is on but the plaque already fills "
            f"{EXPAND_TO_WIDTH_MM} x {EXPAND_TO_HEIGHT_MM} mm; no padding added."
        )
    log(f"Map area: {map_rect[2]:.3f} x {map_rect[3]:.3f} mm at ({map_rect[0]:.3f}, {map_rect[1]:.3f})")
    log(
        f"Scale: 1 mm on the wood = {units_per_mm:.4g} Blender units"
        + (
            f" (= {units_per_mm:.1f} m of ground if the map is still at blosm's "
            "native scale)" if units_per_mm > 0.5 else
            "; the map looks pre-scaled to plaque size"
        )
    )
    log(f"Fit mode '{FIT_MODE}': {layout_note}")
    if "already match" not in layout_note:
        log("  " + suggested_bounds_message())

    line_results = {}
    fill_results = {}
    # Per fill group: are its solids known not to overlap each other? Only then
    # may write_svg put the group in one path. See COMBINE_FILL_PATHS.
    fill_disjoint = {}
    building_solids = []
    land_seeds = []
    layer_by_object = {}
    counts = Counter()

    # ---------------------------------------------------------------- fills
    for group_id, layers in FILL_LAYERS.items():
        if not ENABLED_FILL_GROUPS.get(group_id, True):
            log(f'Fill group "{group_id}" disabled.')
            continue

        objects, matched = objects_for_layers(layers)
        group_output = []
        outline_output = []
        union_input = []

        for obj in objects:
            rings, unclosed = extract_mesh_loops(obj, depsgraph, bounds, map_area)
            counts["unclosed_loops"] += unclosed

            if group_id == "water" and CLOSE_INCOMPLETE_WATER:
                ways = open_water_ways(obj, depsgraph)
                if ways:
                    # Points inside the water polygons that DID build are the
                    # only reliable "this is water" evidence available here.
                    water_seeds = [
                        (sum(p[0] for p in ring) / len(ring),
                         sum(p[1] for p in ring) / len(ring))
                        for ring in rings
                    ]
                    repaired, reasons = close_open_water(
                        ways, bounds, water_seeds, land_seeds
                    )
                    # A repaired piece is always SOLID water, never a hole, but
                    # its winding falls out of which way the walk went round the
                    # crop edge. That did not matter while `orient_rings` re-wound
                    # everything by nesting; it matters now, because the union
                    # reads its inputs under non-zero and would subtract a
                    # clockwise ring instead of adding it.
                    rings = rings + [wound(ring, ccw=True) for ring in repaired]
                    counts["water_repaired"] += len(repaired)
                    for reason, n in reasons.items():
                        # "repaired" and "repaired (no water evidence)" are both
                        # successes; only the rest are worth warning about.
                        if not reason.startswith("repaired"):
                            counts[f"water_unrepaired: {reason}"] += n

            if not rings:
                continue

            if group_id == "buildings":
                for ring in rings:
                    land_seeds.append((
                        sum(p[0] for p in ring) / len(ring),
                        sum(p[1] for p in ring) / len(ring),
                    ))

            if EXPORT_OUTLINES and is_outline_object(obj):
                outline_output.append((obj.name, [r + [r[0]] for r in rings]))
                continue

            # Held back so the union can see every part of a feature at once.
            # In blosm's multi-object mode the pieces of one building -- and the
            # pieces of one river -- arrive as separate objects, so a per-object
            # merge would miss them. These stay in WORLD winding, which is what
            # the boolean and the water knockout both need.
            if group_id == "buildings":
                union_input.extend(rings)
                if UNION_OVERLAPPING_BUILDING_PARTS:
                    counts["fill_objects"] += 1
                    counts["fill_rings"] += len(rings)
                    continue
            elif group_id == "water" and UNION_OVERLAPPING_WATER:
                union_input.extend(rings)
                counts["fill_objects"] += 1
                counts["fill_rings"] += len(rings)
                continue

            oriented = orient_rings(rings, bounds)
            group_output.append((obj.name, oriented))
            counts["fill_objects"] += 1
            counts["fill_rings"] += len(rings)

        if union_input and group_id == "water":
            group_output.extend(
                solids_to_paths(merge_water_parts(union_input, counts), "water")
            )
        elif union_input and UNION_OVERLAPPING_BUILDING_PARTS:
            building_solids = merge_building_parts(union_input, counts)
            group_output.extend(solids_to_paths(building_solids, "buildings"))
        elif union_input:
            # The water knockout still needs to know where the buildings are, so
            # the two settings stay independent of each other.
            building_solids = group_into_solids(union_input)

        fill_results[group_id] = group_output
        # Merged output is disjoint by construction, provided the union merged
        # everything it found. Per-object output is not: two objects can cover
        # the same ground, which is the whole reason the union exists.
        merged_kind = {"buildings": "building", "water": "water"}.get(group_id)
        union_ran = bool(union_input) and (
            (group_id == "buildings" and UNION_OVERLAPPING_BUILDING_PARTS)
            or (group_id == "water" and UNION_OVERLAPPING_WATER)
        )
        fill_disjoint[group_id] = bool(
            union_ran and union_was_complete(counts, merged_kind)
        )

        if outline_output:
            line_results.setdefault(OUTLINES_GROUP_ID, []).extend(outline_output)

        log(
            f'Fill group "{group_id}": {len(group_output)} paths, '
            f'{sum(len(r) for _, r in group_output)} rings '
            f'(layers: {", ".join(matched) or "none"})'
        )

    # ---------------------------------------------------------------- decks
    deck_solids = build_decks(depsgraph, bounds, map_area, counts) if EXPORT_DECKS else []
    if deck_solids and ENGRAVE_DECKS:
        fill_results[DECKS_GROUP_ID] = solids_to_paths(deck_solids, "deck")
        fill_disjoint[DECKS_GROUP_ID] = union_was_complete(counts, "deck")

    # ---------------------------------------------------------------- ocean
    ocean_rings = []
    if EXPORT_OCEAN:
        coast_objects, _ = objects_for_layers(COASTLINE_LAYERS, quiet=True)
        if coast_objects:
            rings, info = build_ocean(coast_objects, depsgraph, bounds, land_seeds)
            ocean_rings = rings
            log(
                f"Ocean: {info.get('ways', 0)} coastline ways -> "
                f"{info.get('chains', 0)} chains, {info.get('open_pieces', 0)} "
                f"crossings, {info.get('land_rings', 0)} land rings, mode "
                f"'{info.get('mode')}'"
            )
            if info.get("flipped"):
                log(
                    "  Coastline direction was reversed relative to the OSM "
                    "land-on-the-left convention; corrected using building "
                    "positions."
                )
            if info.get("extended_ends"):
                warn(
                    f"{info['extended_ends']} coastline end(s) stopped inside the "
                    "crop and were extended to the edge. That happens when "
                    f'"{bounds_object_label()}" reaches past the imported OSM area; '
                    "shrink it slightly for an exact shoreline."
                )
            if info.get("dropped_pieces"):
                warn(
                    f"{info['dropped_pieces']} coastline piece(s) could not be "
                    "closed and were skipped."
                )
        else:
            log(
                "Ocean: no coastline objects found. blosm only creates them when "
                "'water' is enabled and the area actually touches a sea."
            )

    # ------------------------------------------------ structures in the water
    # Piers, wharves and anything else built out over water: OSM maps the
    # coastline along the shore and the structure separately, so the water fill
    # runs straight underneath. Both are Laser Fill, so the building merges into
    # the sea and disappears -- Canada Place in Vancouver is 513 mm2 of pier
    # building lost that way. Cut the structure and a small margin out instead.
    structures = building_solids + deck_solids
    if KNOCK_STRUCTURES_OUT_OF_WATER and structures:
        if ocean_rings:
            ocean_rings, _ = knock_structures_out_of_water(
                ocean_rings, structures, units_per_mm, counts, "ocean"
            )

        water_output = fill_results.get("water") or []
        if water_output:
            # These rings have already been wound for the SVG Y flip, so their
            # winding is the mirror image of the ocean's. That does not matter:
            # the boolean reads its inputs under NON-ZERO, which only asks
            # whether the winding is zero, and it re-winds what it returns.
            water_rings = [r for _, rings in water_output for r in rings]
            knocked, changed = knock_structures_out_of_water(
                water_rings, structures, units_per_mm, counts, "water"
            )
            if changed:
                # The difference is boolean output, so whatever the union left
                # overlapping has been resolved: these solids are disjoint.
                fill_results["water"] = solids_to_paths(
                    group_into_solids(knocked), "water"
                )
                fill_disjoint["water"] = True

    if ocean_rings:
        # `build_water_rings` composes the sea as ONE compound ring set -- the
        # crop rectangle, land wound as holes, lakes wound solid again -- which
        # is designed to read the same under either fill rule in a single path.
        # A knockout only replaces it with boolean output, which is disjoint too.
        fill_results[OCEAN_GROUP_ID] = solids_to_paths(
            group_into_solids(ocean_rings), "ocean"
        )
        fill_disjoint[OCEAN_GROUP_ID] = True
    elif EXPORT_OCEAN:
        fill_results[OCEAN_GROUP_ID] = []

    # ---------------------------------------------------------------- lines
    for group_id, layers in LINE_LAYERS.items():
        if not ENABLED_LINE_GROUPS.get(group_id, True):
            log(f'Line group "{group_id}" disabled.')
            continue

        objects, matched = objects_for_layers(layers)
        group_output = []

        for obj in objects:
            layer = layer_for_object(obj, layers)
            tags = object_tags(obj)
            # Prefer the OSM tag when blosm kept it; fall back to the layer id.
            layer_by_object[obj.name] = (
                rank_for_tags(tags) if tags.get("highway")
                else rank_for_layer(layer)
            )
            drop_closed = bool(layer) and any(
                name_matches_layer(layer, closed_layer)
                for closed_layer in DROP_CLOSED_LINES_IN_LAYERS
            )

            reason = line_drop_reason(obj, layer, has_closed_spline=False)
            if reason:
                counts[f"dropped_{reason}"] += 1
                continue

            paths, dropped_closed = extract_curve_paths(
                obj, depsgraph, bounds, drop_closed=drop_closed
            )
            counts["dropped_closed_outline"] += dropped_closed

            if paths:
                group_output.append((obj.name, paths))
                counts["line_objects"] += 1
                counts["line_paths"] += len(paths)

        line_results[group_id] = group_output
        log(
            f'Line group "{group_id}": {len(group_output)} objects, '
            f'{sum(len(p) for _, p in group_output)} paths '
            f'(layers: {", ".join(matched) or "none"})'
        )

    if line_results.get(OUTLINES_GROUP_ID):
        log(
            f'Line group "{OUTLINES_GROUP_ID}": '
            f'{len(line_results[OUTLINES_GROUP_ID])} objects'
        )

    # ------------------------------------------------------- cull and write
    line_results = transform_line_groups(line_results, to_svg)
    before_cull = line_results
    line_results, cull_stats = cull_line_groups(
        line_results, layer_by_object,
        covered_fn=solid_fill_tester(fill_results, to_svg)
        if DENSE_CLUSTER_COUNTS_SOLID_FILL else None,
    )

    log(
        f"Lines: {cull_stats['paths_before']} -> {cull_stats['paths_after']} "
        f"paths ({cull_stats['culled_paths']} whole paths culled as overlapping, "
        f"{cull_stats['trimmed_paths']} paths trimmed, "
        f"~{cull_stats['culled_mm']} mm removed; "
        f"{cull_stats['welded_joins']} fragments "
        f"welded; {cull_stats['snapped_gaps']} near-miss gaps closed; "
        f"{cull_stats['pruned_compact_paths']} compact path splines pruned; "
        f"{cull_stats['pruned_stubs']} dangling stubs pruned)"
    )

    if COLLAPSE_FILLED_LOOPS and cull_stats["collapsed_loops"]:
        log(
            f"  Filled rings: {cull_stats['collapsed_loops']} loop(s) enclosing "
            f"less than {MIN_LOOP_OPEN_RADIUS_MM} mm of open wood contracted to "
            f"their centres, so they burn as junctions rather than as dots. "
            f"Everything that touched them came with them; no end was left "
            f"loose."
        )

    if RELIEVE_DENSE_CLUSTERS:
        log(
            f"  Dense-patch relief: {cull_stats['dense_cells']} patches over "
            f"{DENSE_CLUSTER_LIMIT_MM_PER_MM2} mm/mm2 thinned by dropping "
            f"{cull_stats['dense_dropped']} paths "
            f"({cull_stats['dense_mesh']} of them mesh links whose ends stay "
            f"joined without them; the rest doubled) "
            f"(~{cull_stats['dense_mm']} mm). Only lines inside those patches "
            f"were eligible, and nothing ranked "
            f"{DENSE_CLUSTER_PROTECT_RANK} or better was touched; the rest of "
            f"the map kept {MIN_LINE_SEPARATION_MM} mm separation."
        )

    for group_id, group_stats in cull_stats["by_group"].items():
        log(
            f'  Line cleanup "{group_id}": {group_stats["input"]} input -> '
            f'{group_stats["after_weld"]} after welding -> '
            f'{group_stats["after_cull"]} after cull -> '
            f'{group_stats["after_tangle"]} after compact-tangle pruning -> '
            f'{group_stats["after_density"]} after dense-patch relief -> '
            f'{group_stats["after_reweld"]} after re-welding -> '
            f'{group_stats["after_prune"]} final'
        )

    if REPORT_LINE_COVERAGE and CULL_OVERLAPPING_LINES:
        coverage = line_coverage(before_cull, line_results)
        message = (
            f"Coverage: {coverage * 100:.1f}% of the original linework is still "
            f"represented by a line within {CULL_COVERAGE_TOLERANCE_MM} mm"
        )
        if coverage >= 0.97:
            log(message + " (removals were duplicates, nothing vanished).")
        else:
            warn(
                message + ". Below 97% means real detail was removed, not just "
                "doubled lines. Lower MIN_LINE_SEPARATION_MM and/or "
                "PRUNE_DANGLING_STUBS_MM."
            )

    label_artwork = build_label_artwork()
    if label_artwork:
        line_results = clip_line_results_outside_rect(
            line_results, label_artwork["box"]
        )
        label_world_bounds = svg_rect_to_world_bounds(
            label_artwork["box"], bounds, map_rect
        )
        fill_results = clip_fill_results_outside_rect(
            fill_results, bounds, label_world_bounds
        )
        x, y, width, height = label_artwork["box"]
        log(
            f'Label "{LABEL_TEXT}": {width:.2f} x {height:.2f} mm at '
            f"({x:.2f}, {y:.2f}) in {LABEL_CORNER} "
            f"rotated {int(LABEL_ROTATION_DEG) % 360} deg; map geometry beneath it "
            "was removed"
        )

    if COMBINE_FILL_PATHS:
        combined = [
            f"{group_id} ({len(objects)} solids -> 1 path)"
            for group_id, objects in fill_results.items()
            if objects and fill_disjoint.get(group_id)
        ]
        split = [
            f"{group_id} ({len(objects)})"
            for group_id, objects in fill_results.items()
            if objects and not fill_disjoint.get(group_id)
        ]
        if combined:
            log(
                "Fill groups written as ONE SVG path each, so Bambu Suite lists "
                f'one object per group: {", ".join(combined)}. Nothing was '
                "merged geometrically; the solids simply cannot overlap, so no "
                "fill rule can make two of them cancel."
            )
        if split:
            log(
                "Fill groups left as one path per solid, because two of their "
                "solids could cover the same ground and would cancel if they "
                f'shared a path: {", ".join(split)}.'
            )

    output = resolve_output_path()
    write_svg(output, to_svg, line_results, fill_results, label_artwork,
              fill_disjoint=fill_disjoint)

    log("Export complete.")
    log(f"  line objects {counts['line_objects']}, paths {counts['line_paths']}")
    log(f"  fill objects {counts['fill_objects']}, rings {counts['fill_rings']}")
    for reason in ("sidepath", "area", "closed area outline"):
        if counts.get(f"dropped_{reason}"):
            log(f"  line objects dropped as {reason}: {counts[f'dropped_{reason}']}")
    if counts["dropped_closed_outline"]:
        log(
            "  closed area outlines dropped from pedestrian/railway layers: "
            f"{counts['dropped_closed_outline']}"
        )
    if counts["unclosed_loops"]:
        log(f"  unclosed silhouette loops skipped: {counts['unclosed_loops']}")
    if counts["water_repaired"]:
        log(
            f"  incomplete water areas closed against the crop: "
            f"{counts['water_repaired']}"
        )
    for key, n in sorted(counts.items()):
        if key.startswith("water_unrepaired: "):
            warn(
                f"{n} incomplete water area(s) left out -- "
                f"{key.split(': ', 1)[1]}. The OSM extract is missing member "
                "ways; re-download with a larger bounding box."
            )
    log(f"  output: {output}")
    log(f"  time: {time.perf_counter() - start:.2f} s")
    _canvas_w, _canvas_h = canvas_size_mm()
    log(
        "In Bambu Suite: import, CHECK the size reads "
        f"{_canvas_w:.4g} x {_canvas_h:.4g} mm, then assign each colour a "
        "process (fills -> Laser Fill, lines -> Laser Line, cut_border -> cut)."
    )


if __name__ == "__main__":
    main()
