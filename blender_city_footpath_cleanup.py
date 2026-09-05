"""
Remove separately-mapped pedestrian geometry from an .osm XML extract, then
repair and thin what is LEFT of the footpath network.

This is blender_city_cleanup_script.txt with the linework passes from
jarvizar_blosm_to_bambu_svg.py bolted onto the back of it. The removal rules are
unchanged -- sidewalks, crossings, cycle crossings and traffic-island paths
still go -- but instead of stopping there, the surviving footpaths are welded
into routes, culled where they duplicate something already on the map, snapped
and bridged where the removals cut them, and pruned where they lead nowhere.

WHY THE SECOND HALF EXISTS
--------------------------
Deleting a sidewalk deletes the thing a park path used to join, so the path now
stops at the kerb pointing at nothing. Deleting a crossing cuts the one link
between the paths either side of a road. Neither is visible in the OSM file --
they are visible on the print, as spurs that lead nowhere and as breaks in
walkways that obviously ought to be continuous. The passes below are the ones
the laser exporter uses on exactly that problem, ported from print millimetres
to OSM metres and taught to write their results back as valid OSM.

WHAT IS PORTED, AND FROM WHERE
------------------------------
    weld_routes             <- weld_paths
    cull_routes             <- cull_ranked / cull_against_grid / _shadowed
    snap_dangling_ends      <- snap_dangling_ends
    bridge_gaps             <- (new) the inverse of the removal pass
    prune_dangling_stubs    <- prune_dangling_stubs
    prune_compact_tangles   <- prune_compact_tangles
    relieve_dense_clusters  <- relieve_dense_clusters (density + mesh thinning)
    SegmentGrid, TaggedIndex, and the geometry primitives under them.

NOT ported: collapse_filled_loops. It contracts a ring to its centre, which
means moving nodes that other ways share, and its whole justification is beam
width -- a ring that encloses less wood than the laser burns. There is no
equivalent number for a printed map, so choosing one here would be inventing a
threshold rather than porting one.

ONLY FOOTPATHS AND CYCLEWAYS ARE TOUCHED
----------------------------------------
Nothing else is edited at all. Roads, railways, buildings, water, tracks,
bridleways, pedestrian streets and everything else are written back byte for
byte: not welded, not trimmed, not deleted, and not given so much as an extra
node. Every geometry pass READS them -- a footpath running alongside a road is
a duplicate, and a footpath ending on one is connected rather than dangling --
but the only ways this script may rewrite are the ones in
FOOT_HIGHWAYS_TO_CLEAN.

HOW GEOMETRY CHANGES REACH THE FILE
-----------------------------------
Ways are welded internally into `Route` objects that carry their node ids
alongside their coordinates, so every geometric decision maps back to an exact
edit: a surviving route is written out as ONE way, reusing an original way's
element -- and therefore its id, tags and attributes -- while the ways it
absorbed are deleted. A route trimmed into pieces emits one way per piece.
Nothing is ever emitted with invented coordinates: a snapped node moves onto a
line that already existed, and a bridge reuses nodes that are already in the
file.
"""

from pathlib import Path
from collections import Counter, defaultdict
import copy
import heapq
import math
import re
import shutil
import sys
import time


# ===========================================================================
# XML parser
# ===========================================================================

# lxml is generally considerably faster for large OSM XML files.
# Fall back to Python's standard XML library if lxml isn't installed.
try:
    from lxml import etree as ET
    USING_LXML = True
except ImportError:
    import xml.etree.ElementTree as ET
    USING_LXML = False


# ===========================================================================
# Configuration -- files
# ===========================================================================
#
# Normally you do not set any of this. Leave INPUT_OSM as None and the script
# works out which extract you are on:
#
#   1. the .osm file named by the objects in the open .blend, when this is run
#      from Blender's Scripting tab -- blosm names every object it creates
#      "<osm file>_<layer>", e.g. "map_86.osm_roads_primary", so the objects
#      say which extract they came from
#   2. blosm's own import settings, if it was pointed at a file by hand
#   3. failing both, the most recently written extract in OSM_CACHE_DIR
#
# Set INPUT_OSM to a Path to override the lot.

OSM_CACHE_DIR = Path(
    r"C:\Users\adamj\Documents\BLOSM\cache\osm"
)

INPUT_OSM = None
OUTPUT_OSM = None

# Write over the input instead of writing a "_cleaned" copy beside it, keeping
# the untouched original as "<name>.osm.original".
#
# The point of this is that blosm goes on reading the filename it already has,
# so there is nothing to re-point: clean, re-import, done. Re-running is safe
# and repeatable -- once a backup exists the script always reads THAT, so the
# passes never compound on their own output, and you can retune a threshold and
# run again as often as you like.
OVERWRITE_IN_PLACE = False
BACKUP_SUFFIX = ".original"

# Suffix for the copy written when OVERWRITE_IN_PLACE is off.
CLEANED_SUFFIX = "_cleaned"

# Ignored when scanning the cache: this script's own output, its backups, and
# blosm's companion files.
IGNORED_STEM_SUFFIXES = ("_extra",)


# ===========================================================================
# Configuration -- removal (unchanged from blender_city_cleanup_script.txt)
# ===========================================================================

# Remove separately mapped sidewalks:  highway=footway + footway=sidewalk
REMOVE_SIDEWALKS = True

# Remove pedestrian crossing geometry: highway=footway + footway=crossing.
# Also catches footway/path ways carrying crossing=*.
REMOVE_CROSSINGS = True

# Remove bicycle crossing geometry:    cycleway=crossing
REMOVE_CYCLE_CROSSINGS = True

# Remove short paths through pedestrian refuge islands: footway=traffic_island
REMOVE_TRAFFIC_ISLAND_PATHS = True

# The laser exporter recognises a few more ways that trace something else:
#
#     is_sidepath=yes      explicit, and increasingly common
#     footway=link         the stub joining a sidewalk to a crossing
#     cycleway=sidewalk    a cycle track mapped as part of the pavement
#     path=sidewalk|crossing
#     crossing=marked|unmarked|zebra|traffic_signals|uncontrolled
#
# These are the same class of object as the four rules above, and removing them
# leaves fewer orphaned stubs behind -- footway=link ways are precisely the
# connectors between the sidewalks and crossings that are already going.
REMOVE_EXTRA_SIDEPATH_TAGS = True

# ---------------------------------------------------------------------------
# Optional removal
# ---------------------------------------------------------------------------

REMOVE_STEPS = False              # highway=steps
REMOVE_INDOOR_FOOTWAYS = False    # indoor pedestrian ways
REMOVE_ALL_CYCLEWAYS = False      # also kills useful standalone trails
REMOVE_ALL_FOOTWAYS = False       # also kills park paths
REMOVE_PEDESTRIAN_ROADS = False   # highway=pedestrian: streets and plazas

# Remove untagged nodes no longer referenced by any way or relation.
# Runs LAST, so nodes kept alive by a new bridge way are safe.
REMOVE_ORPHAN_NODES = True


# ===========================================================================
# Configuration -- footpath geometry cleanup
# ===========================================================================
#
# Every distance here is REAL-WORLD METRES on the ground, not millimetres on
# the print. That is the one honest unit at this stage: the .osm file is what
# Blosm reads, and the print scale is chosen later. As a sanity check, a city
# extract 8 km wide printed 200 mm wide is 40 m per mm, so 8 m on the ground is
# 0.2 mm on the plate -- about one nozzle.

CLEAN_FOOTPATHS = True

# The ONLY ways this script may rewrite. Footpaths and cycleways, and nothing
# else: every other highway value is reference geometry, read but never edited.
#
# `pedestrian` is deliberately absent -- those are streets and plazas, and they
# belong on the road side of the argument, so a footway running down the middle
# of one is the duplicate rather than the other way round. So is `bridleway`,
# which is neither a footpath nor a cycleway. `steps` is here because it is a
# footpath with a gradient: OSM splits a stepped route into footway/steps/
# footway, and leaving the steps out would break the weld in the middle of
# every one of them. Delete the line if you would rather they were left alone.
FOOT_HIGHWAYS_TO_CLEAN = frozenset({
    "footway",
    "path",
    "cycleway",
    "steps",
})

# A way that belongs to a relation is left completely alone by the geometry
# passes: never welded (welding dissolves its id and the relation loses its
# member), never trimmed, never deleted. It still acts as an obstacle and as
# support for everything around it. Long-distance trails and park routes are
# the usual members, and those are exactly the paths worth keeping.
PROTECT_RELATION_MEMBER_WAYS = True


# ---------------------------------------------------------------------------
# Merge coincident ends
# ---------------------------------------------------------------------------
#
# OSM sometimes has two paths meeting at two DIFFERENT nodes a few centimetres
# apart. Nothing downstream can see that as a junction, because everything
# downstream joins on node id. Fusing the pair first is what lets welding find
# the join at all.
MERGE_COINCIDENT_ENDS = True
COINCIDENT_END_TOLERANCE_M = 0.75


# ---------------------------------------------------------------------------
# Welding
# ---------------------------------------------------------------------------
#
# OSM splits one walkway into a dozen ways wherever a tag changes, so before
# welding a "path" is an arbitrary fragment rather than a route. That matters
# twice over: fewer, longer ways for Blosm, and -- much more important -- the
# culling and pruning below stop mistaking a real 400 m route for a pile of
# 30 m stubs. WELDING RUNS FIRST for that reason, exactly as it does in the
# laser exporter.
#
# Two ways are welded only when they meet at a node where nothing else in their
# group ends, and only when their tags are IDENTICAL, so a lit path never
# silently absorbs an unlit one or inherits its name.
WELD_FOOTPATHS = True


# ---------------------------------------------------------------------------
# Culling duplicates
# ---------------------------------------------------------------------------
#
# Drop a footpath that runs close to AND roughly parallel with something
# already on the map. The rule is "close AND parallel", never just "close", so
# a path running INTO a road keeps its connection and no gap opens at the
# junction.
#
# Roads are seeded into the index before any footpath is considered, so a path
# is always the side that loses; footpaths are then taken in rank order,
# longest first, and tested against everything already kept, which handles
# paths duplicating each other in the same sweep.
CULL_PARALLEL_FOOTPATHS = True
MIN_PATH_SEPARATION_M = 8.0
CULL_PARALLEL_ANGLE_DEG = 28.0

# Trim a path segment by segment rather than keeping or dropping it whole.
# The laser exporter does this for its `paths` group and not for roads, and the
# reason applies here too: a welded route that hugs a road for 80% of its
# length still has a 20% spur that genuinely goes somewhere, and whole-path
# culling throws that away with the rest. Set False to keep or drop each route
# entire.
CULL_TRIM_PARTIAL_PATHS = True

# Used only when trimming is off: how much of a route has to be shadowed before
# the whole thing goes.
CULL_PATH_SHADOW_FRACTION = 0.68

# An OFFCUT shorter than this is not worth keeping. This only ever applies
# to the pieces culling itself cut a route into; a route that came through
# untouched is never deleted for being short, because that is the stub
# pruner's decision and it checks both ends first.
MIN_PATH_RUN_M = 12.0


# ---------------------------------------------------------------------------
# Snapping
# ---------------------------------------------------------------------------
#
# OSM is full of ways that stop a hair short of the thing they join. At full
# density nobody notices; once the sidewalks are gone, those near-misses are
# the visible breaks. A loose end is pulled onto the line it nearly meets --
# never further than SNAP_GAP_M, never if it already touches something, and
# never if the node is shared, tagged, or on the crop boundary.
SNAP_DANGLING_ENDS = True
SNAP_GAP_M = 6.0

# Allow an end to snap onto a ROAD as well as onto another footpath. A path
# that stops at the kerb is joined to the street network rather than left
# hanging a lane's width away, which is what most of the visible breaks around
# a removed crossing actually are. The road is not edited -- only the path's
# own end node moves. Set False to snap paths to paths only.
SNAP_ONTO_ROADS = True

# Anything already this close counts as touching, and is left alone.
TOUCH_TOLERANCE_M = 0.5

# Also insert the moved node into the way it landed on, so the junction is real
# topology rather than two lines that happen to cross. The node is placed
# exactly on the segment it splits, so the target does not change shape.
#
# This only ever applies when the target is another footpath or cycleway. An
# end that lands on a ROAD still moves onto it -- that is the gap being closed
# -- but the road itself is not rewritten, because no way outside
# FOOT_HIGHWAYS_TO_CLEAN is edited by this script under any circumstances.
SNAP_INSERT_INTO_TARGET = True


# ---------------------------------------------------------------------------
# Bridging -- filling the gaps this script's own removals opened
# ---------------------------------------------------------------------------
#
# Snapping closes the hairline gaps. This closes the deliberate ones. When a
# crossing is deleted, the paths on either side of the road are left facing
# each other across it, and no amount of snapping will reach that far. So the
# removed ways are kept in memory, and where BOTH ends of one are still loose
# ends of surviving footpaths, the link is put back -- along the removed way's
# own node list, so the reconnection follows the geometry that was there rather
# than a straight line somebody guessed.
#
# It cannot invent a connection: both ends must already be dangling, and by
# default the gap must lie over ground a removal actually cleared.
BRIDGE_GAPS = True
BRIDGE_MAX_M = 30.0

# Both ends must point roughly at each other. This is what stops two unrelated
# path ends that happen to stop near the same kerb from being wired together
# across the corner between them.
BRIDGE_ALIGN_DEG = 55.0

# Require the bridge to lie over geometry this script removed. Turning this off
# lets it close any well-aligned gap under BRIDGE_MAX_M, which reaches breaks
# that were already in the source data -- and invents links OSM never had.
BRIDGE_REQUIRE_REMOVED_CORRIDOR = True
BRIDGE_CORRIDOR_M = 8.0

# Whether a bridge may CROSS a road. Off, and that default is not caution -- it
# is the instruction. A bridge over a removed crossing is a line drawn across a
# carriageway, which is the exact geometry REMOVE_CROSSINGS exists to delete;
# putting it back under another name would undo the cleanup. So the two halves
# of a severed walkway are joined to the STREET instead, by SNAP_ONTO_ROADS
# above, and the print reads as continuous without a zebra on it.
#
# What bridging still does, and what it is for, is the gap that is nowhere near
# a carriageway: the footway=link, the sidewalk fragment inside a park, the
# traffic-island path in the middle of a square. Those were load-bearing, and
# nothing else puts them back.
#
# Turn it on if you would rather the path network reconnected across roads;
# every other guard still applies, so it will only ever happen where a removal
# actually cut something.
BRIDGE_ACROSS_ROADS = False

# Skip a bridge whose two ends already reach each other through the path
# network by a detour no longer than this many times the gap. They are joined
# already; a second link would only be a shortcut nobody walks.
BRIDGE_DETOUR = 6.0

# Tags for the ways this creates. The marker tag is ignored by Blosm and lets
# you find them again in JOSM.
BRIDGE_TAGS = {
    "highway": "footway",
    "jarvizar:bridge": "yes",
}


# ---------------------------------------------------------------------------
# Pruning
# ---------------------------------------------------------------------------
#
# The kerb stubs left when a crossing goes, plus OSM's own spurs. An end counts
# as CONNECTED when any other line passes within tolerance of it -- not merely
# when another line's endpoint coincides with it. After welding, a side path
# almost always meets the MIDDLE of a route, and judging by endpoints alone
# declares those junctions dangling and deletes the path.
#
# A fragment connected at both ends is never removed however short, and an end
# on the crop boundary is clipped, not dangling.
PRUNE_DANGLING_STUBS = True
PRUNE_STUB_M = 18.0

# A tiny maze of mutually connected paths -- a plaza, a playground, a car park
# aisle set -- has no dangling end and no parallel road, so neither culling nor
# stub pruning can see it. Measure it instead: a component that is both
# physically small AND unusually line-dense for its size is removed whole. A
# simple loop stays well under the length/span ratio.
PRUNE_COMPACT_TANGLES = True
TANGLE_MAX_SPAN_M = 45.0
TANGLE_MIN_SEGMENTS = 20
TANGLE_MIN_LENGTH_TO_SPAN = 3.6


# ---------------------------------------------------------------------------
# Density relief -- OFF by default
# ---------------------------------------------------------------------------
#
# Culling is PAIRWISE: it asks whether this path runs along that one. It never
# notices that a dozen individually legal neighbours have piled into one patch,
# which is what prints as a raised blob rather than as paths. This measures the
# pile directly -- metres of path per square metre of ground over a window --
# and applies a wider separation ONLY over the limit.
#
# It is off because, unlike every other threshold here, the right limit depends
# on your print scale and nozzle, and I have no measurement of your plate to
# set it from. Turn it on and raise DENSE_LIMIT_M_PER_M2 until only the blobs
# are being touched. As a starting point, 0.35 m/m2 is roughly "a path line
# every 3 metres".
RELIEVE_DENSE_CLUSTERS = False
DENSE_LIMIT_M_PER_M2 = 0.35
DENSE_WINDOW_M = 25.0
DENSE_SEPARATION_M = 12.0

# How much of a path must lie in a dense patch before it is a candidate, and
# how much of it a SURVIVING path must run along before it is actually dropped.
# The second is the safety catch: at 0.88 only a path doubled almost end to end
# goes.
DENSE_HOT_FRACTION = 0.60
DENSE_SHADOW_FRACTION = 0.88

# Mesh thinning, for the patches the shadow test cannot reach: a plaza criss-
# crossed by short links where nothing duplicates anything but the block still
# prints as one mass. A link shorter than this may be dropped ONLY when its two
# ends still reach each other without it, by a detour no longer than
# DENSE_MESH_DETOUR times its own length. That is a graph fact, not an
# estimate, so no junction can come apart. 0 disables.
DENSE_MESH_MAX_M = 40.0
DENSE_MESH_DETOUR = 4.0


# ---------------------------------------------------------------------------
# Crop boundary
# ---------------------------------------------------------------------------

# A path end within this distance of the extract's edge left the crop; it is
# clipped, not dangling, so it is never pruned, snapped or bridged.
BOUNDARY_TOLERANCE_M = 10.0


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

# After the geometry passes, report how much of the ORIGINAL footpath length is
# still represented by some surviving line within this distance. This is the
# number that says whether a path actually disappeared, as opposed to merely
# being merged into a neighbour. Costs a second or two.
REPORT_PATH_COVERAGE = True
COVERAGE_TOLERANCE_M = 6.0


# ===========================================================================
# Tag definitions
# ===========================================================================

RELEVANT_KEYS = frozenset({
    "highway",
    "footway",
    "cycleway",
    "path",
    "indoor",
    "crossing",
    "is_sidepath",
    "area",
})


FOOT_HIGHWAYS = frozenset({
    "footway",
    "path",
})


# Ported from the laser exporter: a way carrying any of these traces something
# else rather than being a route in its own right.
SIDEPATH_TAGS = {
    "footway": {"sidewalk", "crossing", "traffic_island", "link"},
    "cycleway": {"crossing", "sidewalk"},
    "path": {"sidewalk", "crossing"},
    "is_sidepath": {"yes"},
    "crossing": {"marked", "unmarked", "zebra", "traffic_signals",
                 "uncontrolled"},
}


# Ranking, so that when two lines shadow each other the LESS important one is
# the one that goes. Lower number wins. Ported verbatim; only the foot classes
# at the bottom are ever removed here, but roads need ranks to seed the index.
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

UNRANKED = 12


# ===========================================================================
# Helpers -- tags and removal rules
# ===========================================================================

def get_tags(element, keys=RELEVANT_KEYS):
    """Return only the OSM tags used by the removal rules."""
    tags = {}
    for tag in element.iterfind("tag"):
        key = tag.get("k")
        if keys is None or key in keys:
            tags[key] = tag.get("v")
    return tags


def all_tags(element):
    """Every tag on an element, for weld grouping."""
    return {tag.get("k"): tag.get("v") for tag in element.iterfind("tag")}


def is_sidepath(tags):
    """True for sidewalks, crossings and other ways that trace a road."""
    for key, unwanted in SIDEPATH_TAGS.items():
        value = tags.get(key)
        if value is not None and str(value).casefold() in unwanted:
            return True
    return False


def removal_reason(tags):
    """
    Determine whether an OSM way should be removed.

    Returns a string describing the reason, or None to keep the way.
    """
    highway = tags.get("highway")
    footway = tags.get("footway")
    cycleway = tags.get("cycleway")
    crossing = tags.get("crossing")
    indoor = tags.get("indoor")

    # --- separately mapped sidewalks ---------------------------------------
    if (REMOVE_SIDEWALKS
            and highway in FOOT_HIGHWAYS
            and footway == "sidewalk"):
        return "sidewalk"

    # --- pedestrian crossings / crosswalks ---------------------------------
    if REMOVE_CROSSINGS:
        if highway in FOOT_HIGHWAYS and footway == "crossing":
            return "pedestrian crossing"

        # Catch paths carrying a crossing=* attribute as well. Restricted to
        # pedestrian/path ways so that crossing tags elsewhere do not
        # accidentally remove unrelated road geometry.
        if highway in FOOT_HIGHWAYS and crossing is not None:
            return "pedestrian crossing"

    # --- bicycle crossings -------------------------------------------------
    if REMOVE_CYCLE_CROSSINGS and cycleway == "crossing":
        return "cycle crossing"

    # --- traffic/refuge island paths ---------------------------------------
    if (REMOVE_TRAFFIC_ISLAND_PATHS
            and highway in FOOT_HIGHWAYS
            and footway == "traffic_island"):
        return "traffic-island path"

    # --- the laser exporter's wider sidepath test --------------------------
    #
    # Only ever applied to pedestrian/cycle ways, for the same reason the
    # crossing=* rule above is: these keys mean something different on a road.
    if (REMOVE_EXTRA_SIDEPATH_TAGS
            and (highway in FOOT_HIGHWAYS or highway in {"cycleway", "steps"})
            and is_sidepath(tags)):
        return "sidepath (extra tags)"

    # --- optional: steps ---------------------------------------------------
    if REMOVE_STEPS and highway == "steps":
        return "steps"

    # --- optional: indoor paths --------------------------------------------
    if (REMOVE_INDOOR_FOOTWAYS
            and highway in FOOT_HIGHWAYS
            and indoor in {"yes", "room", "corridor"}):
        return "indoor footway"

    # --- optional: ALL cycleways -------------------------------------------
    if REMOVE_ALL_CYCLEWAYS and highway == "cycleway":
        return "cycleway"

    # --- optional: ALL footways --------------------------------------------
    if REMOVE_ALL_FOOTWAYS and highway == "footway":
        return "footway"

    # --- optional: pedestrian streets / plazas -----------------------------
    if REMOVE_PEDESTRIAN_ROADS and highway == "pedestrian":
        return "pedestrian road"

    return None


def is_foot_way(tags):
    """True for a way this script's geometry passes are allowed to change."""
    if str(tags.get("area", "")).casefold() == "yes":
        return False
    return tags.get("highway") in FOOT_HIGHWAYS_TO_CLEAN


def is_road_way(tags):
    """
    True for a line the footpaths are measured against but never edited.

    Anything with a highway tag that is not one of ours, which puts
    `pedestrian` here: a footway drawn down the middle of a pedestrian street
    is the duplicate, and this is what makes it lose.
    """
    highway = tags.get("highway")
    if highway is None:
        return False
    if str(tags.get("area", "")).casefold() == "yes":
        return False
    return highway not in FOOT_HIGHWAYS_TO_CLEAN


def rank_for_tags(tags):
    return HIGHWAY_RANK.get(tags.get("highway"), UNRANKED)


# ===========================================================================
# Projection
# ===========================================================================
#
# Everything geometric below works in metres on a local equirectangular plane.
# Over a city extract the distortion is far smaller than any threshold here
# cares about, and the inverse is exact, so a snapped node round-trips back to
# lat/lon without drift.

EARTH_RADIUS_M = 6371008.8


class Projection:

    def __init__(self, lat0, lon0):
        self.lat0 = lat0
        self.lon0 = lon0
        self.ky = EARTH_RADIUS_M * math.pi / 180.0
        self.kx = self.ky * math.cos(math.radians(lat0))
        if abs(self.kx) < 1e-6:
            self.kx = 1e-6

    def to_xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def to_latlon(self, x, y):
        return (self.lat0 + y / self.ky, self.lon0 + x / self.kx)


# ===========================================================================
# Geometry primitives -- ported from the laser exporter
# ===========================================================================

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


def _closest_point_on_segment(p, a, b):
    """Returns (point, parameter along the segment)."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-18:
        return a, 0.0
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_sq
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return (a[0] + t * dx, a[1] + t * dy), t


def _unit(a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    n = math.hypot(dx, dy)
    if n <= 1e-18:
        return None
    return dx / n, dy / n


def path_length(points):
    return sum(
        math.hypot(b[0] - a[0], b[1] - a[1])
        for a, b in zip(points[:-1], points[1:])
    )


def _sample_points(a, b, spacing, cap=8):
    """Samples along a segment, endpoints included."""
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    count = int(length / spacing) if spacing > 0 else 0
    count = max(1, min(count, cap))
    return [
        (a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count)
        for i in range(count + 1)
    ]


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


def _alongside(point, a, b, threshold_sq):
    """
    Is `point` within reach of the INSIDE of segment a->b?

    "Another line runs along this one" has to mean beside it, not past the end
    of it. A short link's own neighbours are collinear with it and touch it, so
    measuring to their nearest endpoint reports every link in a mesh as fully
    doubled by the very paths it connects to.
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

    def within(self, point, threshold_sq):
        for a, b, _ in self.near(point):
            if _point_segment_distance_sq(point, a, b) <= threshold_sq:
                return True
        return False


class TaggedIndex:
    """
    Segment index that remembers WHICH line and WHICH segment each entry is.

    The plain SegmentGrid answers "is something near here". Snapping needs
    "near what, exactly, and where along it", because that answer becomes an
    insertion into a specific way's node list.
    """

    def __init__(self, cell):
        self.cell = max(cell, 1e-9)
        self.cells = {}

    def key(self, x, y):
        return (int(math.floor(x / self.cell)), int(math.floor(y / self.cell)))

    def add(self, owner, points):
        for index, (a, b) in enumerate(zip(points[:-1], points[1:])):
            entry = (owner, index, a, b)
            steps = int(math.hypot(b[0] - a[0], b[1] - a[1]) / self.cell) + 1
            seen = set()
            for i in range(steps + 1):
                t = i / steps
                seen.add(self.key(a[0] + (b[0] - a[0]) * t,
                                  a[1] + (b[1] - a[1]) * t))
            for k in seen:
                self.cells.setdefault(k, []).append(entry)

    def near(self, point):
        cx, cy = self.key(point[0], point[1])
        out = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                found = self.cells.get((cx + dx, cy + dy))
                if found:
                    out.extend(found)
        return out


def _shadowed(a, b, direction, grid, threshold_sq, cos_limit, spacing):
    """How much of this segment runs close to and parallel with the grid."""
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


# ===========================================================================
# The route model
# ===========================================================================

class Route:
    """
    A run of footpath, carrying its node ids alongside its coordinates.

    That pairing is the whole trick to writing geometry decisions back as OSM:
    every vertex the passes below look at is a real node in the file, so a
    surviving route is a node list, a trimmed piece is a slice of one, and a
    bridge is two node ids that already exist.
    """

    __slots__ = ("nodes", "points", "way_ids", "rank", "tag_key", "locked")

    def __init__(self, nodes, points, way_ids, rank, tag_key, locked):
        self.nodes = nodes
        self.points = points
        self.way_ids = way_ids
        self.rank = rank
        self.tag_key = tag_key
        self.locked = locked

    def length(self):
        return path_length(self.points)

    def closed(self):
        return len(self.nodes) > 2 and self.nodes[0] == self.nodes[-1]

    def slice(self, start, stop):
        """A sub-route over vertices [start, stop). Shares the source way ids."""
        return Route(
            self.nodes[start:stop],
            self.points[start:stop],
            list(self.way_ids),
            self.rank,
            self.tag_key,
            self.locked,
        )


class RoadLine:
    """A way the footpaths are measured against and may be snapped onto."""

    __slots__ = ("way_id", "nodes", "points")

    def __init__(self, way_id, nodes, points):
        self.way_id = way_id
        self.nodes = nodes
        self.points = points


BRIDGE_TAG_KEY = ("__bridge__",)


def dedupe(nodes, points):
    """
    Drop consecutive repeats.

    A zero-length segment has no direction, so every pass below would have to
    special-case it. Removing them once here is cheaper than testing forever.
    """
    out_nodes = []
    out_points = []
    for node, point in zip(nodes, points):
        if out_nodes and out_nodes[-1] == node:
            continue
        if out_points and math.hypot(point[0] - out_points[-1][0],
                                     point[1] - out_points[-1][1]) <= 1e-9:
            continue
        out_nodes.append(node)
        out_points.append(point)
    return out_nodes, out_points


# ===========================================================================
# Pass: merge coincident ends
# ===========================================================================

def merge_coincident_ends(routes, tolerance, node_users, protected_nodes):
    """
    Fuse two nodes that sit on top of each other but are not the same node.

    Everything downstream joins on node id, so a pair of duplicate nodes a few
    centimetres apart is invisible as a junction. This finds loose ends that
    coincide and rewrites one to the other, which is what lets welding see the
    join at all.

    Only an end that belongs to exactly one way and carries no tags is folded
    away -- fusing a shared or tagged node would drag unrelated geometry with
    it, or relocate a gate.

    Returns (remap, merged_count), where `remap` is old node id -> new node id.
    """
    if tolerance <= 0.0 or len(routes) < 2:
        return {}, 0

    cell = max(tolerance * 2.0, 1e-9)

    def key(point):
        return (int(math.floor(point[0] / cell)),
                int(math.floor(point[1] / cell)))

    ends = []
    for index, route in enumerate(routes):
        if route.closed():
            continue
        for end in (0, -1):
            ends.append((index, route.nodes[end], route.points[end]))

    buckets = defaultdict(list)
    for slot, (_, _, point) in enumerate(ends):
        buckets[key(point)].append(slot)

    # old node id -> (surviving node id, surviving coordinate)
    remap = {}
    taken = set()
    merged = 0

    for slot, (index, node, point) in enumerate(ends):
        if slot in taken or node in remap:
            continue
        cx, cy = key(point)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other_slot in buckets.get((cx + dx, cy + dy), ()):
                    if other_slot <= slot or other_slot in taken:
                        continue
                    other_index, other_node, other_point = ends[other_slot]
                    if other_index == index or other_node == node:
                        continue
                    if other_node in remap:
                        continue
                    if math.hypot(other_point[0] - point[0],
                                  other_point[1] - point[1]) > tolerance:
                        continue
                    # Only fold away a node nothing else depends on.
                    if (len(node_users.get(other_node, ())) != 1
                            or other_node in protected_nodes):
                        continue
                    remap[other_node] = (node, point)
                    taken.add(other_slot)
                    merged += 1

    if remap:
        for route in routes:
            nodes = []
            points = []
            for node, point in zip(route.nodes, route.points):
                replacement = remap.get(node)
                if replacement is None:
                    nodes.append(node)
                    points.append(point)
                else:
                    # The survivor's coordinate wins. The folded node moved at
                    # most `tolerance`, which is well under every threshold
                    # anything downstream measures with.
                    nodes.append(replacement[0])
                    points.append(replacement[1])
            route.nodes, route.points = dedupe(nodes, points)

    return {old: new for old, (new, _) in remap.items()}, merged


# ===========================================================================
# Pass: welding
# ===========================================================================

def weld_routes(routes):
    """
    Join routes that meet end to end into single continuous runs.

    OSM splits one walkway into many ways wherever a tag changes. Welding them
    matters twice over: Blosm gets one long way instead of a dozen, and -- much
    more important -- a genuine long route stops looking like a pile of short
    stubs to the pruner below.

    Only routes with IDENTICAL tags are welded, so a lit path never absorbs an
    unlit one or inherits its name, and junctions where three or more ends meet
    are left alone: there is no single correct continuation. Locked routes
    (relation members, and the bridges this script creates) are never welded,
    because welding dissolves the id the relation refers to.

    Returns (routes, joins_made).
    """
    if len(routes) < 2:
        return list(routes), 0

    output = []
    weldable = []
    for route in routes:
        if route.locked or route.closed() or len(route.nodes) < 2:
            output.append(route)
        else:
            weldable.append(route)

    buckets = defaultdict(list)
    for route in weldable:
        buckets[route.tag_key].append(route)

    joins = 0

    for bucket in buckets.values():
        # endpoint node id -> [(index within bucket, is_tail)]
        at_node = defaultdict(list)
        for index, route in enumerate(bucket):
            at_node[route.nodes[0]].append((index, False))
            at_node[route.nodes[-1]].append((index, True))

        used = [False] * len(bucket)
        order = sorted(range(len(bucket)), key=lambda i: -len(bucket[i].nodes))

        for start in order:
            if used[start]:
                continue
            used[start] = True
            source = bucket[start]
            nodes = list(source.nodes)
            points = list(source.points)
            way_ids = list(source.way_ids)
            rank = source.rank

            # Grow forwards, then backwards.
            for forwards in (True, False):
                while True:
                    end_node = nodes[-1] if forwards else nodes[0]
                    here = at_node.get(end_node, ())

                    # Three or more ends meet here: no single continuation.
                    if len(here) != 2:
                        break

                    nxt = None
                    for other, other_tail in here:
                        if not used[other]:
                            nxt = (other, other_tail)
                            break
                    if nxt is None:
                        break

                    other, other_tail = nxt
                    used[other] = True
                    piece = bucket[other]
                    piece_nodes = list(piece.nodes)
                    piece_points = list(piece.points)
                    if other_tail:
                        piece_nodes.reverse()
                        piece_points.reverse()

                    joins += 1
                    if forwards:
                        nodes.extend(piece_nodes[1:])
                        points.extend(piece_points[1:])
                    else:
                        nodes = list(reversed(piece_nodes[1:])) + nodes
                        points = list(reversed(piece_points[1:])) + points
                    way_ids.extend(piece.way_ids)
                    rank = min(rank, piece.rank)

            nodes, points = dedupe(nodes, points)
            if len(nodes) >= 2:
                output.append(Route(nodes, points, way_ids, rank,
                                    source.tag_key, False))

    return output, joins


# ===========================================================================
# Pass: culling duplicates
# ===========================================================================

def cull_routes(routes, seed_grid, separation, max_angle_deg,
                trim_partial, shadow_fraction, min_run_length):
    """
    Drop footpath that duplicates something already on the map.

    `seed_grid` arrives holding every road, so a path is always the side that
    loses -- there is no ranking argument in which a footway beats the street
    it runs beside. Footpaths are then taken in rank order, longest first, and
    tested against everything already accepted, which handles paths duplicating
    each other in the same sweep.

    A piece is redundant when it runs within `separation` of another line AND
    within `max_angle_deg` of parallel to it. Perpendicular approaches are never
    culled, so a path running into a road keeps its junction.

    With `trim_partial` a route is cut at its shadowed segments and the clear
    runs survive; otherwise it is kept or dropped entire on `shadow_fraction`.

    Returns (kept, stats).
    """
    stats = {"dropped": 0, "trimmed": 0, "short_pieces": 0,
             "removed_m": 0.0}
    if not routes or separation <= 0.0:
        return list(routes), stats

    ordered = sorted(routes, key=lambda r: (r.rank, -r.length()))
    grid = seed_grid
    threshold_sq = separation * separation
    cos_limit = math.cos(math.radians(max_angle_deg))

    kept = []

    for route in ordered:
        if route.locked or grid.empty or len(route.points) < 2:
            kept.append(route)
            grid.add(route.points)
            continue

        flags = []
        shadowed_length = 0.0
        total_length = 0.0

        for a, b in zip(route.points[:-1], route.points[1:]):
            direction = _unit(a, b)
            if direction is None:
                flags.append(False)
                continue
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            hits, samples = _shadowed(
                a, b, direction, grid, threshold_sq, cos_limit, separation
            )
            # Most of a segment has to be shadowed before it goes, so a segment
            # that merely touches a road survives.
            is_shadowed = hits * 5 >= samples * 3
            flags.append(is_shadowed)
            total_length += length
            if is_shadowed:
                shadowed_length += length

        if total_length <= 0.0:
            continue

        if not trim_partial:
            if shadowed_length / total_length >= shadow_fraction:
                stats["dropped"] += 1
                stats["removed_m"] += total_length
            else:
                kept.append(route)
                grid.add(route.points)
            continue

        # Runs of consecutive clear segments become pieces, recorded as vertex
        # ranges so that a piece is a slice of the route's node list.
        pieces = []
        start = None
        for index, is_shadowed in enumerate(flags):
            if is_shadowed:
                if start is not None:
                    pieces.append((start, index + 1))
                    start = None
                continue
            if start is None:
                start = index
        if start is not None:
            pieces.append((start, len(flags) + 1))

        if not pieces:
            stats["dropped"] += 1
            stats["removed_m"] += total_length
            continue

        trimmed = len(pieces) != 1 or pieces[0] != (0, len(route.points))
        if trimmed:
            stats["trimmed"] += 1

        for first, last in pieces:
            piece = route.slice(first, last)
            if len(piece.points) < 2:
                continue
            # The short-run filter applies only to the offcuts culling itself
            # made. A route that came through untouched is short because that
            # is how long it is, and a 10 m link joining two walkways is not
            # rubbish -- deleting it here would be deleting it for being
            # short, with none of the connectivity reasoning the stub pruner
            # does before it takes anything.
            if (trimmed and min_run_length > 0.0
                    and piece.length() < min_run_length):
                stats["short_pieces"] += 1
                stats["removed_m"] += piece.length()
                continue
            kept.append(piece)
            grid.add(piece.points)

    return kept, stats


# ===========================================================================
# Shared: what a footpath end is connected to
# ===========================================================================

def build_line_index(routes, roads, cell):
    """
    One index over everything a footpath end could be connected to.

    Owners are ("route", i) or ("road", j), which is how the callers tell what
    they may edit: roads are read here, and written only by the single node
    insertion that snapping is allowed to make.
    """
    index = TaggedIndex(cell)
    for i, route in enumerate(routes):
        index.add(("route", i), route.points)
    for j, road in enumerate(roads):
        index.add(("road", j), road.points)
    return index


def end_is_supported(index, owner, point, touch_sq):
    """Does any OTHER line pass within touching distance of this point?"""
    for other, _, a, b in index.near(point):
        if other == owner:
            continue
        if _point_segment_distance_sq(point, a, b) <= touch_sq:
            return True
    return False


# ===========================================================================
# Pass: snapping
# ===========================================================================

def snap_dangling_ends(routes, roads, snap_m, touch_m, on_boundary,
                       node_users, protected_nodes, insert_into_target,
                       onto_roads):
    """
    Pull a loose end onto the line it nearly meets.

    OSM is full of ways that stop a hair short of the road they join. At full
    density nobody notices, but once the sidewalks and duplicates are gone
    those near-misses are the visible gaps. Anything already touching is left
    alone, ends that leave the crop are left alone, and nothing is ever moved
    further than `snap_m`, so this closes gaps without inventing junctions.

    The node is only moved when it belongs to exactly one way and carries no
    tags: moving a shared node would drag the other way with it, and moving a
    tagged one would relocate a gate or a bollard.

    With `insert_into_target` the moved node is also spliced into the line it
    landed on, which turns a coincidence into real topology. It is placed
    exactly on the segment it splits, so nothing changes shape. Only another
    FOOTPATH is ever spliced: an end that lands on a road still moves onto it,
    but the road is left exactly as it was found.

    Returns (moves, insertions, snapped_count), where `moves` is
    node id -> new (x, y) and `insertions` is route index -> [(segment, t,
    node)].
    """
    moves = {}
    insertions = defaultdict(list)
    snapped = 0

    if snap_m <= 0.0 or not routes:
        return moves, insertions, snapped

    index = build_line_index(routes, roads, max(snap_m * 2.0, 1e-9))
    snap_sq = snap_m * snap_m
    touch_sq = touch_m * touch_m

    for i, route in enumerate(routes):
        if route.locked or route.closed() or len(route.points) < 2:
            continue

        # A route no longer than the gap it would be snapped across is a nub,
        # not a path that stops short. Snapping one collapses it to nothing;
        # leave it for the stub pruner instead.
        if route.length() <= snap_m:
            continue

        for end in (0, -1):
            node = route.nodes[end]
            point = route.points[end]

            if on_boundary(point):
                continue
            if node in moves:
                continue
            if len(node_users.get(node, ())) != 1 or node in protected_nodes:
                continue

            best = None
            best_distance = None
            touching = False

            for other, seg, a, b in index.near(point):
                if other == ("route", i):
                    continue
                distance = _point_segment_distance_sq(point, a, b)
                if distance <= touch_sq:
                    touching = True
                    break
                if other[0] == "road" and not onto_roads:
                    continue
                if distance <= snap_sq and (best_distance is None
                                            or distance < best_distance):
                    best_distance = distance
                    best = (other, seg, a, b)

            if touching or best is None:
                continue

            other, seg, a, b = best
            target, t = _closest_point_on_segment(point, a, b)

            # Never collapse the segment we are moving.
            neighbour = route.points[1] if end == 0 else route.points[-2]
            if math.hypot(target[0] - neighbour[0],
                          target[1] - neighbour[1]) <= touch_m:
                continue

            route.points[end] = target
            moves[node] = target
            snapped += 1

            # A road is never rewritten, so it is never spliced. The end still
            # moved onto it, which is the gap closed; Blosm reads the geometry,
            # not the topology.
            if (insert_into_target and other[0] == "route"
                    and 1e-9 < t < 1.0 - 1e-9):
                insertions[other[1]].append((seg, t, node))

    return moves, insertions, snapped


def apply_insertions(routes, insertions):
    """
    Splice snapped nodes into the footpaths they landed on.

    Applied in descending (segment, t) order, so earlier indices stay valid
    while later ones are still being inserted. A route needs no further
    bookkeeping, because it is rewritten wholesale at the end anyway.
    """
    for position, entries in insertions.items():
        route = routes[position]
        entries.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)

        for seg, t, node in entries:
            if seg + 1 >= len(route.points):
                continue
            if node in route.nodes:
                continue
            a = route.points[seg]
            b = route.points[seg + 1]
            route.nodes.insert(seg + 1, node)
            route.points.insert(
                seg + 1,
                (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t),
            )

        route.nodes, route.points = dedupe(route.nodes, route.points)


# ===========================================================================
# Pass: bridging
# ===========================================================================

def _orientation(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(p1, p2, p3, p4):
    """
    Do these two segments properly intersect?

    Proper, not touching: two lines that merely share an endpoint are a
    junction, and a bridge is allowed to start at one.
    """
    d1 = _orientation(p3, p4, p1)
    d2 = _orientation(p3, p4, p2)
    d3 = _orientation(p1, p2, p3)
    d4 = _orientation(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def _crosses_a_road(chain, road_grid):
    """True if this bridge would draw a line over a carriageway."""
    for a, b in zip(chain[:-1], chain[1:]):
        seen = set()
        for point in _sample_points(a, b, road_grid.cell, cap=16):
            for oa, ob, _ in road_grid.near(point):
                key = (oa, ob)
                if key in seen:
                    continue
                seen.add(key)
                if _segments_cross(a, b, oa, ob):
                    return True
    return False


def _foot_graph(routes):
    """Node id -> [(neighbour node id, length)] over the surviving footpaths."""
    graph = defaultdict(list)
    for route in routes:
        for (u, v), (a, b) in zip(zip(route.nodes[:-1], route.nodes[1:]),
                                  zip(route.points[:-1], route.points[1:])):
            if u == v:
                continue
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            graph[u].append((v, length))
            graph[v].append((u, length))
    return graph


def _connected_within(graph, start, goal, budget):
    """
    Do these two nodes already reach each other for less than `budget`?

    Cost-bounded Dijkstra. The budget is what keeps it local and cheap: a gap's
    way round is a block or two, never half the city.
    """
    if start == goal:
        return True
    best = {start: 0.0}
    queue = [(0.0, start)]
    while queue:
        cost, node = heapq.heappop(queue)
        if cost > best.get(node, cost):
            continue
        for other, step in graph.get(node, ()):
            reached = cost + step
            if reached > budget:
                continue
            if other == goal:
                return True
            if reached >= best.get(other, budget + 1.0):
                continue
            best[other] = reached
            heapq.heappush(queue, (reached, other))
    return False


def bridge_gaps(routes, roads, removed_geometry, removed_by_endpoints,
                node_coords, projection, max_gap, align_deg,
                require_corridor, corridor_m, detour, touch_m, on_boundary,
                across_roads):
    """
    Put back the links this script's own removals cut.

    Deleting a crossing severs the paths either side of the road; deleting the
    sidewalk a park path joined leaves that path pointing at nothing. Snapping
    cannot reach either -- the gap is a carriageway wide. So the removed ways
    are kept in memory and consulted here.

    A pair of loose ends is bridged when:

        - both are genuinely dangling (nothing passes within touching distance
          of either) and neither is on the crop boundary
        - they are within `max_gap` of each other
        - each END POINTS AT THE OTHER, within `align_deg`. This is what stops
          two unrelated paths that both happen to stop near the same kerb from
          being wired together across the corner between them.
        - the gap lies over ground a removal actually cleared, when
          `require_corridor`. Without that this reaches breaks that were
          already in the source data -- and invents links OSM never had.
        - they do not already reach each other through the network for less
          than `detour` times the gap. If they do, they are joined already and
          a second link is just a shortcut.
        - the link does not cross a road, unless `across_roads`. A bridge over
          a removed crossing is a line drawn across a carriageway, which is the
          exact geometry the removal pass exists to delete; snapping joins
          those two halves to the street instead.

    Where the pair is exactly the two ends of one removed way, that way's own
    node list is used, so the reconnection follows the geometry that was there.
    Otherwise the bridge is the straight line between two nodes that both
    already exist. Either way, no coordinate is invented.

    Returns (bridges, count), where a bridge is a list of node ids.
    """
    if not routes or max_gap <= 0.0:
        return [], 0

    index = build_line_index(routes, roads, max(max_gap, 1e-9))
    touch_sq = touch_m * touch_m

    ends = []
    for i, route in enumerate(routes):
        if route.closed() or len(route.points) < 2:
            continue
        for end in (0, -1):
            point = route.points[end]
            if on_boundary(point):
                continue
            if end_is_supported(index, ("route", i), point, touch_sq):
                continue
            inward = route.points[1] if end == 0 else route.points[-2]
            outward = _unit(inward, point)
            if outward is None:
                continue
            ends.append((i, route.nodes[end], point, outward))

    if len(ends) < 2:
        return [], 0

    corridor = (SegmentGrid(removed_geometry, max(corridor_m, 1e-9))
                if require_corridor else None)
    corridor_sq = corridor_m * corridor_m

    road_grid = None
    if not across_roads:
        road_grid = SegmentGrid((), max(max_gap, 1e-9))
        for road in roads:
            road_grid.add(road.points)

    cos_limit = math.cos(math.radians(align_deg))

    cell = max(max_gap, 1e-9)
    buckets = defaultdict(list)
    for slot, (_, _, point, _) in enumerate(ends):
        buckets[(int(math.floor(point[0] / cell)),
                 int(math.floor(point[1] / cell)))].append(slot)

    # Every candidate pair, shortest first: the closest facing ends are the
    # ones most likely to be the two halves of one removed link.
    candidates = []
    seen = set()

    for slot, (route_index, node, point, outward) in enumerate(ends):
        cx = int(math.floor(point[0] / cell))
        cy = int(math.floor(point[1] / cell))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other_slot in buckets.get((cx + dx, cy + dy), ()):
                    if other_slot <= slot:
                        continue
                    pair = (slot, other_slot)
                    if pair in seen:
                        continue
                    seen.add(pair)

                    (other_index, other_node,
                     other_point, other_outward) = ends[other_slot]
                    if other_node == node:
                        continue

                    gap = math.hypot(other_point[0] - point[0],
                                     other_point[1] - point[1])
                    if gap > max_gap or gap <= 1e-9:
                        continue

                    # Both ends must face the gap.
                    towards = _unit(point, other_point)
                    if towards is None:
                        continue
                    if (outward[0] * towards[0]
                            + outward[1] * towards[1]) < cos_limit:
                        continue
                    if (other_outward[0] * -towards[0]
                            + other_outward[1] * -towards[1]) < cos_limit:
                        continue

                    candidates.append((gap, slot, other_slot))

    candidates.sort()

    graph = _foot_graph(routes)
    used = set()
    bridges = []

    for gap, slot, other_slot in candidates:
        if slot in used or other_slot in used:
            continue

        node = ends[slot][1]
        point = ends[slot][2]
        other_node = ends[other_slot][1]
        other_point = ends[other_slot][2]

        recorded = removed_by_endpoints.get(frozenset((node, other_node)))

        if corridor is not None and recorded is None:
            # Not a removed way's own two ends, so demand that the straight
            # line between them runs over ground a removal cleared.
            samples = _sample_points(point, other_point,
                                     max(corridor_m * 0.5, 1e-9), cap=16)
            if any(not corridor.within(s, corridor_sq) for s in samples):
                continue

        if _connected_within(graph, node, other_node, gap * detour):
            continue

        bridge_nodes = None
        if recorded is not None and len(recorded) >= 2:
            chain = list(recorded)
            if chain[0] != node:
                chain.reverse()
            # Every node on a removed way is still in the table: the orphan
            # sweep has not run yet, and reusing them keeps the link on the
            # geometry that was actually there.
            if chain[0] == node and chain[-1] == other_node and all(
                n in node_coords for n in chain
            ):
                bridge_nodes = chain

        if bridge_nodes is None:
            bridge_nodes = [node, other_node]

        if road_grid is not None and not road_grid.empty:
            chain = [projection.to_xy(*node_coords[n]) for n in bridge_nodes]
            if _crosses_a_road(chain, road_grid):
                continue

        bridges.append(bridge_nodes)
        used.add(slot)
        used.add(other_slot)

        # Keep the graph honest, so a chain of three loose ends cannot be
        # bridged twice around the same corner.
        for u, v in zip(bridge_nodes[:-1], bridge_nodes[1:]):
            ax, ay = projection.to_xy(*node_coords[u])
            bx, by = projection.to_xy(*node_coords[v])
            step = math.hypot(bx - ax, by - ay)
            graph[u].append((v, step))
            graph[v].append((u, step))

    return bridges, len(bridges)


# ===========================================================================
# Pass: pruning dangling stubs
# ===========================================================================

def prune_dangling_stubs(routes, roads, max_stub_m, touch_m, on_boundary):
    """
    Remove short fragments that lead nowhere.

    Deleting sidewalks and crossings leaves the walkway that used to reach them
    stopping at the kerb, and OSM itself is full of short spurs. Both read as a
    path that stops just short of somewhere.

    An end counts as CONNECTED when any other line passes within tolerance of
    it -- not merely when another line's endpoint coincides with it. That
    distinction matters enormously after welding: a path almost always meets
    the MIDDLE of a route or a road, and judging by endpoints alone declares
    those junctions dangling and deletes the path, punching a hole in the
    network.

    Roads support permanently, because nothing here can remove one, so an end
    resting on a road can never come loose. A fragment connected at both ends
    is never removed however short, and an end that leaves the crop is clipped,
    not dangling.

    Removal cascades: taking a stub can strand the stub behind it, which is
    exactly the chain of kerb fragments a removed crossing leaves.

    Returns (kept, removed_count).
    """
    if not routes or max_stub_m <= 0.0:
        return list(routes), 0

    touch_sq = touch_m * touch_m
    index = build_line_index(routes, roads, max(touch_m * 4.0, 1e-9))

    lengths = [route.length() for route in routes]
    anchored = [
        (on_boundary(route.points[0]), on_boundary(route.points[-1]))
        for route in routes
    ]

    def supporters(i, point):
        """(rests on a road, set of other route indices touching this point)"""
        on_road = False
        found = set()
        for other, _, a, b in index.near(point):
            if other == ("route", i):
                continue
            if _point_segment_distance_sq(point, a, b) > touch_sq:
                continue
            if other[0] == "road":
                on_road = True
            else:
                found.add(other[1])
        return on_road, found

    support = [
        (supporters(i, route.points[0]), supporters(i, route.points[-1]))
        for i, route in enumerate(routes)
    ]

    # Reverse map, so removing a route can cheaply invalidate whoever leaned on
    # it.
    dependents = defaultdict(set)
    for i, ((_, first), (_, last)) in enumerate(support):
        for other in first | last:
            dependents[other].add(i)

    removed_flags = [False] * len(routes)

    def is_stub(i):
        if removed_flags[i] or routes[i].locked:
            return False
        if lengths[i] >= max_stub_m or routes[i].closed():
            return False
        (road_first, first), (road_last, last) = support[i]
        free_first = not road_first and not any(
            not removed_flags[o] for o in first
        )
        free_last = not road_last and not any(
            not removed_flags[o] for o in last
        )
        return ((free_first and not anchored[i][0])
                or (free_last and not anchored[i][1]))

    queue = [i for i in range(len(routes)) if is_stub(i)]
    removed = 0

    while queue:
        i = queue.pop()
        if not is_stub(i):
            continue
        removed_flags[i] = True
        removed += 1
        for other in dependents.get(i, ()):
            if not removed_flags[other] and is_stub(other):
                queue.append(other)

    return (
        [route for route, gone in zip(routes, removed_flags) if not gone],
        removed,
    )


# ===========================================================================
# Pass: pruning compact tangles
# ===========================================================================

def prune_compact_tangles(routes, max_span, min_segments, min_length_to_span,
                          touch_m):
    """
    Remove tiny, line-dense components of footpath.

    A compact maze of mutually connected paths -- a plaza, a playground, the
    aisles of a car park -- can have no dangling end and no nearby parallel
    road. Culling and stub pruning therefore keep it even when it is far too
    dense to print. Candidates are joined into components when an endpoint
    touches another candidate's line; only components that are both physically
    small AND unusually line-dense for their size are removed. A simple loop
    stays well below the length/span threshold.

    Returns (kept, removed_count).
    """
    if (not routes or max_span <= 0.0 or min_segments <= 0
            or min_length_to_span <= 0.0):
        return list(routes), 0

    candidates = []
    for i, route in enumerate(routes):
        if route.locked or len(route.points) < 2:
            continue
        xs = [p[0] for p in route.points]
        ys = [p[1] for p in route.points]
        if math.hypot(max(xs) - min(xs), max(ys) - min(ys)) <= max_span:
            candidates.append(i)

    if not candidates:
        return list(routes), 0

    touch_sq = touch_m * touch_m
    index = TaggedIndex(max(touch_m * 4.0, 1e-9))
    for local, i in enumerate(candidates):
        index.add(local, routes[i].points)

    parent = list(range(len(candidates)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[rb] = ra

    for local, i in enumerate(candidates):
        route = routes[i]
        for point in (route.points[0], route.points[-1]):
            for other, _, a, b in index.near(point):
                if other != local and (
                    _point_segment_distance_sq(point, a, b) <= touch_sq
                ):
                    union(local, other)

    components = defaultdict(list)
    for local in range(len(candidates)):
        components[root(local)].append(local)

    doomed = set()
    for members in components.values():
        paths = [routes[candidates[m]].points for m in members]
        xs = [p[0] for path in paths for p in path]
        ys = [p[1] for path in paths for p in path]
        span = math.hypot(max(xs) - min(xs), max(ys) - min(ys))
        segments = sum(max(0, len(path) - 1) for path in paths)
        total = sum(path_length(path) for path in paths)
        if (span <= max_span and segments >= min_segments
                and total >= min_length_to_span * max(span, 1e-12)):
            doomed.update(candidates[m] for m in members)

    return (
        [route for i, route in enumerate(routes) if i not in doomed],
        len(doomed),
    )


# ===========================================================================
# Pass: density relief
# ===========================================================================

def relieve_dense_clusters(routes, roads, density_limit, window, separation,
                           max_angle_deg, hot_fraction, shadow_fraction,
                           mesh_max, mesh_detour):
    """
    Thin the densest patches of footpath, and only those.

    Culling is PAIRWISE: it asks whether this path runs along that one. It
    therefore never notices that a dozen individually legal neighbours have
    piled into one patch, which is what prints as a raised blob rather than as
    paths. Raising MIN_PATH_SEPARATION_M does catch those, but it is a tax on
    the whole map.

    So measure the pile directly -- metres of path per square metre of ground,
    read over a `window` box -- and apply the wider `separation` ONLY inside
    cells over `density_limit`. Everywhere else keeps exactly the behaviour it
    had.

    A route is eligible when `hot_fraction` of it lies in those cells, and it is
    taken only when `shadow_fraction` of it already runs along a line that is
    staying. The removal test is the same one culling uses, close AND parallel,
    so a path running INTO the cluster is never taken and the junction
    survives. Candidates are offered shortest-first and the grid is updated
    after every removal, so once a patch is back under the limit the rest of
    its paths stop being candidates -- that is what thins a cluster instead of
    hollowing it out.

    MESH THINNING is the second test, for the case the shadow test cannot
    reach: a plaza criss-crossed by short links where nothing is a duplicate of
    anything but the block still prints as one mass. A link shorter than
    `mesh_max` may be dropped when its two ends REMAIN CONNECTED to each other
    without it, by a detour no longer than `mesh_detour` times its own length.
    That is a graph fact, not an estimate, so nothing can come apart.

    Returns (kept, stats).
    """
    stats = {"dropped": 0, "removed_m": 0.0, "hot_cells": 0,
             "considered": 0, "mesh_dropped": 0}
    if (not routes or density_limit <= 0.0 or window <= 0.0
            or separation <= 0.0):
        return list(routes), stats

    cell = window / 3.0
    step = cell * 0.5

    def cell_key(x, y):
        return (int(math.floor(x / cell)), int(math.floor(y / cell)))

    load = {}

    def deposit(points, sign):
        """Spread a line's length over the cells it crosses."""
        for a, b in zip(points[:-1], points[1:]):
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

    for route in routes:
        deposit(route.points, 1.0)
    for road in roads:
        deposit(road.points, 1.0)

    # Density is read over the 3x3 block around a cell, so `window` is the size
    # of the patch the eye reads, not of the bookkeeping cell.
    block_area = (3.0 * cell) ** 2

    def is_hot(point):
        cx, cy = cell_key(point[0], point[1])
        total = 0.0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                total += load.get((cx + dx, cy + dy), 0.0)
        return total / block_area > density_limit

    stats["hot_cells"] = sum(
        1 for key in load
        if is_hot(((key[0] + 0.5) * cell, (key[1] + 0.5) * cell))
    )

    index = build_line_index(routes, roads, max(separation, 1e-9))
    threshold_sq = separation * separation
    cos_limit = math.cos(math.radians(max_angle_deg))
    removed = set()

    def shadowed_fraction(i, points):
        """How much of this route a SURVIVING line already runs along."""
        hit = total = 0.0
        for a, b in zip(points[:-1], points[1:]):
            direction = _unit(a, b)
            if direction is None:
                continue
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            total += length
            for point in _interior_samples(a, b, separation):
                found = False
                for other, _, oa, ob in index.near(point):
                    if other == ("route", i):
                        continue
                    if other[0] == "route" and other[1] in removed:
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
                    hit += length
                    break
        return (hit / total) if total > 0.0 else 0.0

    # Vertex graph for the mesh test. Every node is a vertex and every segment
    # an edge tagged with the route it came from; endpoints alone are not
    # enough, because in a mesh most links meet the MIDDLE of another link and
    # an endpoint-only graph comes apart into fragments.
    adjacency = defaultdict(list)
    if mesh_max > 0.0:
        for i, route in enumerate(routes):
            for (u, v), (a, b) in zip(
                zip(route.nodes[:-1], route.nodes[1:]),
                zip(route.points[:-1], route.points[1:]),
            ):
                if u == v:
                    continue
                edge_length = math.hypot(b[0] - a[0], b[1] - a[1])
                adjacency[u].append((v, i, edge_length))
                adjacency[v].append((u, i, edge_length))

    def still_connected(i):
        """Do this route's two ends still reach each other without it?"""
        route = routes[i]
        start, goal = route.nodes[0], route.nodes[-1]
        if start == goal:
            return False
        budget = route.length() * mesh_detour
        best = {start: 0.0}
        queue = [(0.0, start)]
        while queue:
            cost, node = heapq.heappop(queue)
            if cost > best.get(node, cost):
                continue
            for other, edge, edge_length in adjacency.get(node, ()):
                if edge == i or edge in removed:
                    continue
                reached = cost + edge_length
                if reached > budget:
                    continue
                if other == goal:
                    return True
                if reached >= best.get(other, budget + 1.0):
                    continue
                best[other] = reached
                heapq.heappush(queue, (reached, other))
        return False

    # Shortest first, then by position, so the result does not depend on the
    # order the ways happened to arrive in.
    order = sorted(
        range(len(routes)),
        key=lambda i: (routes[i].length(), routes[i].points[0]),
    )

    for i in order:
        route = routes[i]
        if route.locked or len(route.points) < 2:
            continue

        samples = [p for a, b in zip(route.points[:-1], route.points[1:])
                   for p in _sample_points(a, b, step)]
        if not samples:
            continue
        hot = sum(1 for p in samples if is_hot(p))
        if hot < hot_fraction * len(samples):
            continue

        stats["considered"] += 1
        mesh = False
        if shadowed_fraction(i, route.points) < shadow_fraction:
            # Nothing runs along it, so it is not a duplicate. It may still be
            # one strand of a mesh too fine to print, and a strand whose ends
            # stay joined without it can go without breaking anything.
            if (mesh_max <= 0.0 or route.length() > mesh_max
                    or not still_connected(i)):
                continue
            mesh = True

        removed.add(i)
        if mesh:
            stats["mesh_dropped"] += 1
        deposit(route.points, -1.0)
        stats["dropped"] += 1
        stats["removed_m"] += route.length()

    return (
        [route for i, route in enumerate(routes) if i not in removed],
        stats,
    )


# ===========================================================================
# Coverage report
# ===========================================================================

def path_coverage(original, final, tolerance):
    """
    Fraction of the original footpath length still represented by SOME line.

    Culling a duplicated path is fine; making a walkway disappear is not. This
    tells the two apart, and it is the one number worth reading before trusting
    a threshold change.
    """
    kept = [route.points for route in final]
    if not kept:
        return 0.0

    grid = SegmentGrid(kept, tolerance)
    threshold_sq = tolerance * tolerance
    covered = 0.0
    total = 0.0

    for points in original:
        for a, b in zip(points[:-1], points[1:]):
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            if length <= 1e-12:
                continue
            total += length
            samples = _sample_points(a, b, tolerance)
            hits = sum(1 for s in samples if grid.within(s, threshold_sq))
            covered += length * hits / len(samples)

    return covered / total if total > 0.0 else 0.0


# ===========================================================================
# OSM writing helpers
# ===========================================================================

def set_way_nodes(way, node_ids):
    """
    Replace a way's <nd> list, leaving its <tag> children in place.

    Rebuilding the child list in one assignment is the same trick the removal
    pass uses on the root: repeated Element.remove() on a large tree is slow.
    """
    others = [child for child in way if child.tag != "nd"]
    rebuilt = []
    for node_id in node_ids:
        nd = ET.Element("nd")
        nd.set("ref", node_id)
        rebuilt.append(nd)
    way[:] = rebuilt + others


def make_way(way_id, node_ids, tags):
    """A brand new way, for the bridges."""
    way = ET.Element("way")
    way.set("id", str(way_id))
    way.set("version", "1")
    for node_id in node_ids:
        nd = ET.SubElement(way, "nd")
        nd.set("ref", node_id)
    for key, value in tags.items():
        tag = ET.SubElement(way, "tag")
        tag.set("k", key)
        tag.set("v", value)
    return way


# ===========================================================================
# Footpath cleanup, start to finish
# ===========================================================================

def clean_footpaths(way_elements, way_tags, way_nodes, node_coords,
                    node_elements, tagged_nodes, relation_way_ids,
                    relation_node_ids, removed_geometry, removed_by_endpoints,
                    projection, on_boundary, removed_way_ids, removed_counts):
    """
    Run every geometry pass and write the result back into the XML tree.

    The order is the laser exporter's, and each step depends on the one before:

        merge coincident ends   so welding can see a junction at all
        WELD                    so a route is a route, not a pile of fragments
        cull                    now that whole-path decisions mean something
        snap                    onto lines that are definitely staying
        bridge                  across the gaps the removals opened
        tangles / density       structural removals, on the repaired network
        WELD again              culling cut pieces; merging made new joins
        prune stubs             last, so a bridged path is no longer a stub

    Returns (stats, new_way_elements, coverage).
    """
    stats = Counter()

    # Which surviving node is used by which surviving ways. Snapping and end
    # merging both refuse to move a node that more than one way holds.
    node_users = defaultdict(list)
    for way_id, refs in way_nodes.items():
        for ref in set(refs):
            node_users[ref].append(way_id)

    protected_nodes = tagged_nodes | relation_node_ids

    routes = []
    roads = []
    original_points = []

    for way_id, tags in way_tags.items():
        refs = way_nodes.get(way_id, ())
        if len(refs) < 2:
            continue
        points = [projection.to_xy(*node_coords[ref]) for ref in refs]
        nodes, points = dedupe(list(refs), points)
        if len(nodes) < 2:
            continue

        if is_foot_way(tags):
            locked = PROTECT_RELATION_MEMBER_WAYS and way_id in relation_way_ids
            # Welding is only allowed between ways whose tags match exactly, so
            # the tag signature is the group key.
            tag_key = tuple(sorted(all_tags(way_elements[way_id]).items()))
            routes.append(Route(nodes, points, [way_id], rank_for_tags(tags),
                                tag_key, locked))
            original_points.append(list(points))
        elif is_road_way(tags):
            roads.append(RoadLine(way_id, nodes, points))

    stats["foot_ways_in"] = len(routes)
    stats["road_lines"] = len(roads)

    if not routes:
        return stats, [], None

    # --- merge coincident ends ---------------------------------------------
    if MERGE_COINCIDENT_ENDS:
        node_remap, merged = merge_coincident_ends(
            routes, COINCIDENT_END_TOLERANCE_M, node_users, protected_nodes
        )
        stats["merged_ends"] = merged
        if node_remap:
            # A folded node may also sit on a way that has already been
            # removed, so the bridge lookup has to follow it.
            removed_by_endpoints = {
                frozenset(node_remap.get(n, n) for n in pair):
                    [node_remap.get(n, n) for n in refs]
                for pair, refs in removed_by_endpoints.items()
            }
            for old, new in node_remap.items():
                if new in node_coords:
                    node_coords[old] = node_coords[new]

    # --- weld ---------------------------------------------------------------
    if WELD_FOOTPATHS:
        routes, joins = weld_routes(routes)
        stats["welded_joins"] += joins

    # --- cull duplicates ----------------------------------------------------
    if CULL_PARALLEL_FOOTPATHS:
        seed = SegmentGrid((), max(MIN_PATH_SEPARATION_M, 1e-9))
        for road in roads:
            seed.add(road.points)
        routes, cull_stats = cull_routes(
            routes, seed,
            MIN_PATH_SEPARATION_M, CULL_PARALLEL_ANGLE_DEG,
            CULL_TRIM_PARTIAL_PATHS, CULL_PATH_SHADOW_FRACTION,
            MIN_PATH_RUN_M,
        )
        stats["culled_paths"] = cull_stats["dropped"]
        stats["trimmed_paths"] = cull_stats["trimmed"]
        stats["short_offcuts"] = cull_stats["short_pieces"]
        stats["culled_m"] = int(cull_stats["removed_m"])

    # --- snap near-misses ---------------------------------------------------
    #
    # After culling, so nothing is ever snapped onto a line that is about to be
    # deleted.
    node_moves = {}
    if SNAP_DANGLING_ENDS:
        node_moves, insertions, snapped = snap_dangling_ends(
            routes, roads, SNAP_GAP_M, TOUCH_TOLERANCE_M, on_boundary,
            node_users, protected_nodes, SNAP_INSERT_INTO_TARGET,
            SNAP_ONTO_ROADS,
        )
        apply_insertions(routes, insertions)
        stats["snapped_ends"] = snapped

    # --- bridge the gaps the removals opened --------------------------------
    bridges = []
    if BRIDGE_GAPS:
        bridges, bridged = bridge_gaps(
            routes, roads, removed_geometry, removed_by_endpoints,
            node_coords, projection,
            BRIDGE_MAX_M, BRIDGE_ALIGN_DEG,
            BRIDGE_REQUIRE_REMOVED_CORRIDOR, BRIDGE_CORRIDOR_M,
            BRIDGE_DETOUR, TOUCH_TOLERANCE_M, on_boundary,
            BRIDGE_ACROSS_ROADS,
        )
        stats["bridged_gaps"] = bridged

    # Bridges join the network BEFORE the pruning passes run, so a path that
    # has just been reconnected is no longer a stub. They are locked, so
    # nothing can weld through them or take them away again.
    bridge_routes = []
    for chain in bridges:
        points = [projection.to_xy(*node_coords[n]) for n in chain]
        nodes, points = dedupe(list(chain), points)
        if len(nodes) >= 2:
            bridge_routes.append(
                Route(nodes, points, [], UNRANKED, BRIDGE_TAG_KEY, True)
            )

    combined = routes + bridge_routes

    # --- structural removals ------------------------------------------------
    if PRUNE_COMPACT_TANGLES:
        combined, pruned = prune_compact_tangles(
            combined, TANGLE_MAX_SPAN_M, TANGLE_MIN_SEGMENTS,
            TANGLE_MIN_LENGTH_TO_SPAN, TOUCH_TOLERANCE_M,
        )
        stats["pruned_tangles"] = pruned

    if RELIEVE_DENSE_CLUSTERS:
        combined, dense_stats = relieve_dense_clusters(
            combined, roads,
            DENSE_LIMIT_M_PER_M2, DENSE_WINDOW_M, DENSE_SEPARATION_M,
            CULL_PARALLEL_ANGLE_DEG, DENSE_HOT_FRACTION,
            DENSE_SHADOW_FRACTION, DENSE_MESH_MAX_M, DENSE_MESH_DETOUR,
        )
        stats["dense_dropped"] = dense_stats["dropped"]
        stats["dense_mesh"] = dense_stats["mesh_dropped"]
        stats["dense_m"] = int(dense_stats["removed_m"])
        stats["dense_cells"] = dense_stats["hot_cells"]

    # Weld again: culling can cut a route into pieces and merging can bring two
    # ends onto one node, and both leave joins the first pass could not see.
    if WELD_FOOTPATHS:
        combined, joins = weld_routes(combined)
        stats["welded_joins"] += joins

    if PRUNE_DANGLING_STUBS:
        combined, pruned = prune_dangling_stubs(
            combined, roads, PRUNE_STUB_M, TOUCH_TOLERANCE_M, on_boundary
        )
        stats["pruned_stubs"] = pruned

    routes = [r for r in combined if r.tag_key != BRIDGE_TAG_KEY]
    bridge_routes = [r for r in combined if r.tag_key == BRIDGE_TAG_KEY]
    stats["bridges_kept"] = len(bridge_routes)

    coverage = None
    if REPORT_PATH_COVERAGE:
        coverage = path_coverage(original_points, combined,
                                 COVERAGE_TOLERANCE_M)

    # -----------------------------------------------------------------------
    # Write the routes back as ways
    # -----------------------------------------------------------------------
    #
    # Each surviving route becomes ONE way, reusing an original way's element
    # so that its id, tags and attributes survive. The ways it absorbed are
    # deleted, and a route trimmed into pieces takes a fresh id for every piece
    # after the first.

    max_way_id = 0
    for way_id in list(way_elements) + list(removed_way_ids):
        try:
            max_way_id = max(max_way_id, int(way_id))
        except ValueError:
            continue
    next_way_id = max_way_id + 1

    foot_way_ids = {
        way_id for way_id, tags in way_tags.items() if is_foot_way(tags)
    }
    consumed = set()
    new_way_elements = []

    for route in routes:
        element = None
        for way_id in route.way_ids:
            if way_id not in consumed and way_id in way_elements:
                consumed.add(way_id)
                element = way_elements[way_id]
                break

        if element is None:
            source_id = next(
                (w for w in route.way_ids if w in way_elements), None
            )
            if source_id is None:
                continue
            element = copy.deepcopy(way_elements[source_id])
            element.set("id", str(next_way_id))
            next_way_id += 1
            new_way_elements.append(element)

        set_way_nodes(element, route.nodes)

    for route in bridge_routes:
        new_way_elements.append(
            make_way(next_way_id, route.nodes, BRIDGE_TAGS)
        )
        next_way_id += 1

    # Every footpath way not claimed by a surviving route is gone.
    for way_id in foot_way_ids - consumed:
        removed_way_ids.add(way_id)
        removed_counts["footpath cleanup"] += 1

    stats["foot_ways_out"] = len(consumed) + len(new_way_elements)

    # Snapped nodes move on the ground. Each one belongs to exactly one
    # footpath way -- snapping refuses to move a shared node -- so no way
    # outside FOOT_HIGHWAYS_TO_CLEAN changes shape because of this.
    for node_id, (x, y) in node_moves.items():
        element = node_elements.get(node_id)
        if element is None:
            continue
        lat, lon = projection.to_latlon(x, y)
        element.set("lat", f"{lat:.7f}")
        element.set("lon", f"{lon:.7f}")

    return stats, new_way_elements, coverage


# ===========================================================================
# Working out which extract to clean
# ===========================================================================
#
# Run from Blender's Scripting tab this reads the scene; run from a terminal it
# falls back to the cache directory. Same file either way, so there is nothing
# to keep in step by hand.

# Deliberately NOT `import bpy`. Blender has always imported it before it runs
# a script, so its presence in sys.modules is the reliable test for "am I in
# Blender" -- and importing it speculatively is actively harmful, because the
# pip `bpy` package is a complete headless Blender that takes seconds to load
# and prints a wall of registration noise. Looking it up costs nothing and
# cannot drag that in.
bpy = sys.modules.get("bpy")


# Blender's ".001" duplicate suffix, which sits AFTER the layer name.
_BLENDER_SUFFIX = re.compile(r"\.\d{3}$")

# blosm names everything "<osm file>_<layer>". The collection at the top is
# often just "<osm file>" on its own, hence the alternation.
_OSM_IN_NAME = re.compile(r"^(?P<file>.+?\.osm)(?:_|$)", re.IGNORECASE)


def is_ignored_extract(path):
    """Our own output, our backups, and blosm's companion files."""
    if path.suffix.casefold() != ".osm":
        return True
    stem = path.stem.casefold()
    if stem.endswith(CLEANED_SUFFIX.casefold()):
        return True
    return any(stem.endswith(s.casefold()) for s in IGNORED_STEM_SUFFIXES)


def osm_names_in_blend():
    """
    Every .osm filename mentioned by an object or collection, most used first.

    blosm stamps the source filename onto everything it imports, so the open
    .blend already knows which extract it is showing. Counting rather than
    taking the first match matters when a scene holds leftovers from an earlier
    import: the extract you are actually working on is the one most of the
    objects came from.
    """
    if bpy is None:
        return Counter()

    counts = Counter()

    for datablock in (bpy.data.objects, bpy.data.collections):
        for item in datablock:
            # Strip ".001" BEFORE matching, or a duplicate reads as a
            # different source file.
            name = _BLENDER_SUFFIX.sub("", str(item.name))
            match = _OSM_IN_NAME.match(name)
            if match:
                counts[match.group("file")] += 1

    return counts


def osm_path_from_blosm_settings():
    """The file blosm was pointed at, when it was pointed at one by hand."""
    if bpy is None:
        return None

    try:
        settings = getattr(bpy.context.scene, "blosm", None)
        raw = getattr(settings, "osmFilepath", None) if settings else None
    except AttributeError:
        # No scene in this context (a restricted or headless run).
        return None

    if not raw:
        return None

    try:
        resolved = Path(bpy.path.abspath(raw))
    except Exception:
        return None

    return resolved if resolved.is_file() else None


def newest_extract_in_cache():
    """The most recently written extract in the cache directory."""
    if not OSM_CACHE_DIR.is_dir():
        return None

    candidates = [
        path for path in OSM_CACHE_DIR.glob("*.osm")
        if path.is_file() and not is_ignored_extract(path)
    ]
    if not candidates:
        return None

    return max(candidates, key=lambda path: path.stat().st_mtime)


def resolve_input_osm():
    """
    Decide which extract to clean.

    Returns (path, how_it_was_found). Raises if nothing can be found, because
    silently cleaning the wrong city is worse than stopping.
    """
    if INPUT_OSM is not None:
        return Path(INPUT_OSM), "set by hand in INPUT_OSM"

    # 1. What the .blend says it is showing.
    counts = osm_names_in_blend()
    if counts:
        ranked = counts.most_common()

        # Prefer a name that actually exists in the cache: a scene can carry a
        # renamed or hand-imported object whose name is not a real file.
        for name, _ in ranked:
            candidate = OSM_CACHE_DIR / name
            if candidate.is_file():
                how = f"named by {counts[name]} object(s) in the .blend"
                if len(ranked) > 1:
                    others = ", ".join(n for n, _ in ranked[1:4] if n != name)
                    how += f" (scene also mentions {others})"
                return candidate, how

    # 2. blosm's own settings, for a hand-picked file.
    from_settings = osm_path_from_blosm_settings()
    if from_settings is not None:
        return from_settings, "blosm's osmFilepath setting"

    # 3. Whatever was downloaded last.
    newest = newest_extract_in_cache()
    if newest is not None:
        if counts:
            # The scene named something, but no such file is in the cache --
            # say so rather than quietly cleaning a different map.
            named = counts.most_common(1)[0][0]
            return newest, (
                f"newest file in the cache -- the .blend names '{named}', "
                f"which is not in {OSM_CACHE_DIR}"
            )
        return newest, "newest file in the cache"

    raise FileNotFoundError(
        f"\nCould not work out which .osm to clean.\n"
        f"Nothing usable in: {OSM_CACHE_DIR}\n"
        f"and the open .blend names no .osm file.\n"
        f"Set INPUT_OSM at the top of this script to the file you want.\n"
    )


def resolve_paths():
    """
    Work out what to read and what to write.

    In-place mode reads the BACKUP once one exists. That is what makes a re-run
    repeatable: the passes always start from the untouched extract, so changing
    a threshold and running again gives the result that threshold deserves,
    rather than that threshold applied on top of the last one.

    Returns (source, destination, backup_to_make, how_it_was_found).
    """
    target, how = resolve_input_osm()

    if not OVERWRITE_IN_PLACE:
        destination = (
            Path(OUTPUT_OSM) if OUTPUT_OSM is not None
            else target.with_name(f"{target.stem}{CLEANED_SUFFIX}.osm")
        )
        return target, destination, None, how

    backup = target.with_name(target.name + BACKUP_SUFFIX)

    if backup.is_file():
        # Already cleaned at least once: the pristine copy is the backup.
        return backup, target, None, f"{how}, re-reading {backup.name}"

    return target, target, backup, how


# ===========================================================================
# Main
# ===========================================================================

def main():

    source, destination, backup_to_make, how = resolve_paths()

    if not source.is_file():
        raise FileNotFoundError(
            f"\nCould not find OSM file:\n{source}\n"
            f"(chosen because: {how})\n"
        )

    print()
    print("=" * 68)
    print("OSM PEDESTRIAN CLEANUP + FOOTPATH REPAIR")
    print("=" * 68)
    print(f"\nInput:\n{source}")
    print(f"  found by: {how}")
    if bpy is not None:
        print("  running inside Blender")
    print(f"\nOutput:\n{destination}")
    if backup_to_make is not None:
        print(f"  original kept as: {backup_to_make.name}")

    t0 = time.perf_counter()

    # -----------------------------------------------------------------------
    # Parse
    # -----------------------------------------------------------------------

    tree = ET.parse(str(source))
    root = tree.getroot()

    t_parsed = time.perf_counter()

    # -----------------------------------------------------------------------
    # Node table, projection and crop rectangle
    # -----------------------------------------------------------------------
    #
    # Read once, up front: the geometry passes need coordinates for every node
    # a way touches, and the bridging pass needs them for nodes on ways that
    # have already been deleted.

    node_elements = {}
    node_coords = {}
    tagged_nodes = set()

    for node in root.iterfind("node"):
        node_id = node.get("id")
        if node_id is None:
            continue
        node_elements[node_id] = node
        try:
            node_coords[node_id] = (float(node.get("lat")),
                                    float(node.get("lon")))
        except (TypeError, ValueError):
            continue
        if node.find("tag") is not None:
            tagged_nodes.add(node_id)

    if not node_coords:
        raise ValueError("No usable <node> elements found in the input.")

    extent = None
    bounds_element = root.find("bounds")
    if bounds_element is not None:
        try:
            extent = (
                float(bounds_element.get("minlat")),
                float(bounds_element.get("minlon")),
                float(bounds_element.get("maxlat")),
                float(bounds_element.get("maxlon")),
            )
        except (TypeError, ValueError):
            extent = None

    if extent is None:
        lats = [lat for lat, _ in node_coords.values()]
        lons = [lon for _, lon in node_coords.values()]
        extent = (min(lats), min(lons), max(lats), max(lons))

    min_lat, min_lon, max_lat, max_lon = extent

    projection = Projection((min_lat + max_lat) * 0.5,
                            (min_lon + max_lon) * 0.5)

    crop_min = projection.to_xy(min_lat, min_lon)
    crop_max = projection.to_xy(max_lat, max_lon)

    def on_boundary(point):
        """An end this close to the extract's edge left the crop."""
        edge = BOUNDARY_TOLERANCE_M
        return (point[0] - crop_min[0] <= edge
                or crop_max[0] - point[0] <= edge
                or point[1] - crop_min[1] <= edge
                or crop_max[1] - point[1] <= edge)

    t_read = time.perf_counter()

    # -----------------------------------------------------------------------
    # Remove unwanted ways
    # -----------------------------------------------------------------------

    removed_way_ids = set()
    removed_counts = Counter()
    original_way_count = 0

    # Removed geometry is kept, not discarded: the bridging pass reconnects
    # only over ground these ways used to occupy.
    removed_geometry = []
    removed_by_endpoints = {}

    way_elements = {}
    way_tags = {}
    way_nodes = {}

    for way in root.iterfind("way"):
        original_way_count += 1
        way_id = way.get("id")
        if way_id is None:
            continue

        refs = [nd.get("ref") for nd in way.iterfind("nd")]
        refs = [ref for ref in refs if ref in node_coords]

        tags = get_tags(way)
        reason = removal_reason(tags)

        if reason is None:
            way_elements[way_id] = way
            way_tags[way_id] = tags
            way_nodes[way_id] = refs
            continue

        removed_way_ids.add(way_id)
        removed_counts[reason] += 1

        if len(refs) >= 2:
            removed_geometry.append(
                [projection.to_xy(*node_coords[ref]) for ref in refs]
            )
            # Only a way with two distinct ends can be a link across a gap; a
            # closed loop is not one.
            if refs[0] != refs[-1]:
                removed_by_endpoints.setdefault(
                    frozenset((refs[0], refs[-1])), refs
                )

    t_filtered = time.perf_counter()

    # -----------------------------------------------------------------------
    # Relation membership
    # -----------------------------------------------------------------------
    #
    # Read before anything is edited: a way in a relation is protected from the
    # geometry passes, because welding dissolves the id the relation refers to.

    relation_way_ids = set()
    relation_node_ids = set()

    for relation in root.iterfind("relation"):
        for member in relation.iterfind("member"):
            ref = member.get("ref")
            if ref is None:
                continue
            if member.get("type") == "way":
                relation_way_ids.add(ref)
            elif member.get("type") == "node":
                relation_node_ids.add(ref)

    # -----------------------------------------------------------------------
    # Footpath geometry cleanup
    # -----------------------------------------------------------------------

    geometry_stats = Counter()
    new_way_elements = []
    coverage = None

    if CLEAN_FOOTPATHS:
        geometry_stats, new_way_elements, coverage = clean_footpaths(
            way_elements, way_tags, way_nodes, node_coords, node_elements,
            tagged_nodes, relation_way_ids, relation_node_ids,
            removed_geometry, removed_by_endpoints, projection, on_boundary,
            removed_way_ids, removed_counts,
        )

    t_geometry = time.perf_counter()

    # -----------------------------------------------------------------------
    # Rebuild the root, dropping removed ways and adding the new ones
    # -----------------------------------------------------------------------
    #
    # Replacing the child list in one assignment is significantly faster than
    # repeatedly calling root.remove() on a large tree.

    kept_children = []
    last_way_slot = None

    for child in root:
        if child.tag == "way" and child.get("id") in removed_way_ids:
            continue
        kept_children.append(child)
        if child.tag == "way":
            last_way_slot = len(kept_children)

    if new_way_elements:
        if last_way_slot is None:
            kept_children.extend(new_way_elements)
        else:
            kept_children[last_way_slot:last_way_slot] = new_way_elements

    root[:] = kept_children

    # -----------------------------------------------------------------------
    # Remove stale relation references
    # -----------------------------------------------------------------------

    relation_members_removed = 0

    if removed_way_ids:
        for relation in root.iterfind("relation"):
            kept_members = []
            changed = False

            for member in relation.findall("member"):
                if (member.get("type") == "way"
                        and member.get("ref") in removed_way_ids):
                    relation_members_removed += 1
                    changed = True
                else:
                    kept_members.append(member)

            if changed:
                # Preserve non-member children such as <tag> elements.
                rebuilt = []
                member_index = 0
                for child in list(relation):
                    if child.tag == "member":
                        if member_index < len(kept_members):
                            rebuilt.append(kept_members[member_index])
                            member_index += 1
                    else:
                        rebuilt.append(child)
                relation[:] = rebuilt

    t_relations = time.perf_counter()

    # -----------------------------------------------------------------------
    # Remove orphan nodes
    # -----------------------------------------------------------------------

    removed_node_count = 0

    if REMOVE_ORPHAN_NODES:

        referenced_node_ids = set()

        for way in root.iterfind("way"):
            for nd in way.iterfind("nd"):
                ref = nd.get("ref")
                if ref:
                    referenced_node_ids.add(ref)

        for relation in root.iterfind("relation"):
            for member in relation.iterfind("member"):
                if member.get("type") != "node":
                    continue
                ref = member.get("ref")
                if ref:
                    referenced_node_ids.add(ref)

        kept_children = []

        for child in root:
            if child.tag != "node":
                kept_children.append(child)
                continue

            node_id = child.get("id")

            # Still used somewhere.
            if node_id in referenced_node_ids:
                kept_children.append(child)
                continue

            # Preserve tagged standalone nodes / POIs.
            if child.find("tag") is not None:
                kept_children.append(child)
                continue

            removed_node_count += 1

        root[:] = kept_children

    t_orphans = time.perf_counter()

    # -----------------------------------------------------------------------
    # Write output
    # -----------------------------------------------------------------------
    #
    # ET.indent() is intentionally NOT used: indenting enormous XML trees adds
    # substantial runtime and output size without helping Blosm.
    #
    # The backup is taken HERE, not at the start: everything above can still
    # raise, and a half-made backup beside an untouched file is worse than no
    # backup at all. By this line the cleaned tree is complete in memory.

    if backup_to_make is not None:
        shutil.copy2(str(source), str(backup_to_make))

    tree.write(
        str(destination),
        encoding="utf-8",
        xml_declaration=True,
    )

    t_done = time.perf_counter()

    # -----------------------------------------------------------------------
    # Statistics
    # -----------------------------------------------------------------------

    remaining_way_count = (
        original_way_count - len(removed_way_ids) + len(new_way_elements)
    )

    print()
    print("=" * 68)
    print("CLEANUP COMPLETE")
    print("=" * 68)

    print("\nRemoved geometry:")
    if removed_counts:
        for reason, count in sorted(removed_counts.items()):
            print(f"  {reason:<38} {count:>10,}")
    else:
        print("  No matching ways found.")

    if CLEAN_FOOTPATHS and geometry_stats:
        print("\nFootpath repair:")
        for key, label in (
            ("foot_ways_in",   "Footpath ways in"),
            ("road_lines",     "Road lines used as reference"),
            ("merged_ends",    "Coincident ends fused"),
            ("welded_joins",   "Fragments welded together"),
            ("culled_paths",   "Duplicate paths dropped whole"),
            ("trimmed_paths",  "Paths trimmed of duplicate runs"),
            ("short_offcuts",  "  ...offcuts too short to keep"),
            ("culled_m",       "Metres of duplicate removed"),
            ("snapped_ends",   "Near-miss ends snapped shut"),
            ("bridged_gaps",   "Gaps bridged back together"),
            ("bridges_kept",   "  ...bridges surviving the pruners"),
            ("pruned_tangles", "Compact tangles removed"),
            ("dense_dropped",  "Dense-cluster paths dropped"),
            ("dense_mesh",     "  ...of those, redundant mesh links"),
            ("dense_m",        "Metres of dense cluster removed"),
            ("dense_cells",    "Dense cells found"),
            ("pruned_stubs",   "Dangling stubs pruned"),
            ("foot_ways_out",  "Footpath ways out"),
        ):
            if key in geometry_stats:
                print(f"  {label:<38} {geometry_stats[key]:>10,}")

        if coverage is not None:
            print(f"  {'Original footpath length still covered':<38} "
                  f"{coverage * 100:>9.1f}%")

    print()
    print(f"Total ways removed:             {len(removed_way_ids):,}")
    print(f"Ways created (pieces/bridges):  {len(new_way_elements):,}")
    print(f"Relation members removed:       {relation_members_removed:,}")

    if REMOVE_ORPHAN_NODES:
        print(f"Unused untagged nodes removed:  {removed_node_count:,}")

    print()
    print(f"Ways before:                    {original_way_count:,}")
    print(f"Ways after:                     {remaining_way_count:,}")

    print()
    print(f"Parser:                         "
          f"{'lxml' if USING_LXML else 'xml.etree (stdlib)'}")

    print()
    print("Timing:")
    print(f"  Parse:                        {t_parsed - t0:.2f}s")
    print(f"  Read nodes:                   {t_read - t_parsed:.2f}s")
    print(f"  Filter ways:                  {t_filtered - t_read:.2f}s")
    print(f"  Footpath repair:              {t_geometry - t_filtered:.2f}s")
    print(f"  Relations:                    {t_relations - t_geometry:.2f}s")
    if REMOVE_ORPHAN_NODES:
        print(f"  Orphan nodes:                 "
              f"{t_orphans - t_relations:.2f}s")
    print(f"  Write:                        {t_done - t_orphans:.2f}s")
    print(f"  TOTAL:                        {t_done - t0:.2f}s")

    print()
    print("Cleaned file:")
    print(destination)
    if OVERWRITE_IN_PLACE:
        print("\nWritten over the input, so blosm needs no re-pointing --")
        print("just re-import. Run again any time; the untouched original is")
        print(f"kept as {source.name if backup_to_make is None else backup_to_make.name}"
              " and is always what gets read.")
    else:
        print("\nPoint blosm at this file (Import -> OpenStreetMap, source")
        print("'file'), or set OVERWRITE_IN_PLACE = True to skip that step.")
    print()
    print("=" * 68)


# ===========================================================================
# Run
# ===========================================================================

if __name__ == "__main__":
    main()
