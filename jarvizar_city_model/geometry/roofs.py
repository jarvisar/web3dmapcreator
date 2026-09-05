"""Roof shapes for buildings and building parts.

Overture carries ``roof_shape``, ``roof_height``, ``roof_direction`` and
``roof_orientation`` straight from OpenStreetMap's Simple 3D Buildings
vocabulary.  On a city selection that is what makes the landmarks read: a
tower's crown is a ``dome`` part, a temple-topped tower has a ``pyramidal``
part, and a faceted top is a ring of ``skillion`` parts each sloping outward.
Without them every mass is a box with a flat lid and the skyline is anonymous.

Everything here is pure planar and vertical geometry, in whatever units the
caller passes.  Shapes fall into four constructions:

* **skillion** -- one sloping plane, so the mass is a prism whose top varies
  linearly along the downslope direction;
* **gabled / hipped** -- piecewise-planar tops.  The footprint is split into
  the regions of the roof that are planar (two for a gable, four for a hip),
  each region becomes its own prism with a planar top, and the regions are
  emitted all or nothing so a failed sliver never leaves a wedge missing;
* **pyramid / dome** -- an apex solid: the footprint ring, optional scaled
  rings for a dome, and a single apex, closed by construction;
* anything else -- flat, recorded as such.

Where ``roof_height`` sits relative to ``height`` differs between a whole
building and a part in the data this project was built against, and
:func:`resolve_roof` records the decision on every object.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable, List, Mapping, Optional, Sequence, Tuple

from .buildings import VerticalProfile
from .planar import EPSILON, clean_ring, ear_clip, oriented_ring, signed_area

Point = Tuple[float, float]
Vertex3 = Tuple[float, float, float]

# OpenStreetMap roof:shape values, folded onto the constructions above.
SHAPE_KINDS = {
    "flat": "flat",
    "sawtooth": "flat",
    "skillion": "skillion",
    "lean_to": "skillion",
    "lean-to": "skillion",
    "gabled": "gabled",
    "saltbox": "gabled",
    "round": "gabled",
    "hipped": "hipped",
    "half-hipped": "hipped",
    "half_hipped": "hipped",
    "mansard": "hipped",
    "gambrel": "hipped",
    "pyramidal": "pyramid",
    "cone": "pyramid",
    "dome": "dome",
    "onion": "dome",
}

# A dome is built from this many scaled rings between the wall top and the
# apex; three give a recognisable curve at miniature scale without turning a
# crown into a hundred faces.
DOME_STEPS = 3

# Walls keep at least this fraction of a whole building's height when the roof
# is taken out of it, so a mapper's over-large roof_height cannot reduce a
# house to a tent.
MINIMUM_WALL_FRACTION = 0.3


def roof_kind(shape: Any) -> str:
    """Map a source ``roof_shape`` onto a construction, or ``unsupported``."""
    name = str(shape or "").strip().lower()
    if not name:
        return "flat"
    return SHAPE_KINDS.get(name, "unsupported")


@dataclass(frozen=True)
class RoofProfile:
    """Where a roof starts and stops, in real metres above local ground."""

    kind: str
    shape: str
    wall_top_m: float
    roof_top_m: float
    direction_deg: Optional[float]
    orientation: Optional[str]
    source: str

    @property
    def height_m(self) -> float:
        return self.roof_top_m - self.wall_top_m

    @property
    def is_shaped(self) -> bool:
        return self.kind not in ("flat", "unsupported")


def _positive(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0.0 else None


def _finite(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def resolve_roof(
    properties: Mapping[str, Any],
    profile: VerticalProfile,
    is_part: bool,
    parent_top_m: Optional[float],
    footprint_width_m: float,
    default_pitch_m: float = 3.0,
) -> RoofProfile:
    """Decide the roof's vertical extent from the source fields.

    For a whole building ``height`` is the total height including the roof, as
    OpenStreetMap defines it, so the roof is taken out of the top of the mass.
    For a *part* the data says otherwise: the Great American Tower's crown is
    published as ``min_height`` 140, ``height`` 162.7, ``roof_height`` 40 under a
    parent of 202.7 m, which only adds up if the dome sits *on top of* the
    part's height -- and reading it the other way would put the dome's base
    below the part's own floor.  So a part's roof is added above its height,
    and clamped to the parent's stated total where there is one.

    A shaped roof with no ``roof_height`` gets an ordinary pitch for its kind,
    recorded as ``default`` rather than passed off as data.
    """
    shape = str(properties.get("roof_shape") or "")
    kind = roof_kind(shape)
    top = float(profile.top_m)
    if kind == "flat":
        return RoofProfile(kind, shape, top, top, None, None, "flat")
    if kind == "unsupported":
        return RoofProfile(kind, shape, top, top, None, None, f"unsupported:{shape}")

    roof_height = _positive(properties.get("roof_height"))
    if roof_height is None:
        if kind in ("pyramid", "dome"):
            roof_height = max(0.5 * footprint_width_m, 0.5)
        else:
            roof_height = max(min(default_pitch_m, 0.6 * footprint_width_m), 0.5)
        source = "default"
    else:
        source = "roof_height"

    direction = _finite(properties.get("roof_direction"))
    orientation = properties.get("roof_orientation")
    orientation = str(orientation).strip().lower() if orientation else None

    if is_part:
        wall_top = top
        roof_top = top + roof_height
        if (
            parent_top_m is not None
            and parent_top_m > wall_top
            and roof_top > parent_top_m + 0.5
        ):
            roof_top = float(parent_top_m)
            source += "+clamped_to_parent"
    else:
        thickness = top - float(profile.bottom_m)
        wall_top = max(top - roof_height, float(profile.bottom_m) + MINIMUM_WALL_FRACTION * thickness)
        roof_top = top
    if roof_top - wall_top <= 1.0e-6:
        return RoofProfile("flat", shape, top, top, None, None, "flat:no_room")
    return RoofProfile(kind, shape, wall_top, roof_top, direction, orientation, source)


# ---------------------------------------------------------------- geometry


def direction_vector(bearing_deg: float) -> Point:
    """Unit vector for a compass bearing: 0 is north (+y), 90 is east (+x)."""
    angle = math.radians(bearing_deg)
    return (math.sin(angle), math.cos(angle))


def clip_ring_linear(ring: Sequence[Point], values: Sequence[float]) -> List[Point]:
    """Keep the part of *ring* where a linear function is non-negative.

    *values* is the function at each vertex; along an edge it is interpolated
    linearly, so the crossing is exact.  This is Sutherland-Hodgman against a
    single half-plane, which is all a planar roof region needs.
    """
    count = len(ring)
    if count < 3:
        return []
    output: List[Point] = []
    for index in range(count):
        p, fp = ring[index], values[index]
        q, fq = ring[(index + 1) % count], values[(index + 1) % count]
        if fp >= 0.0:
            output.append(p)
        if (fp >= 0.0) != (fq >= 0.0):
            t = fp / (fp - fq)
            output.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return clean_ring(output, EPSILON)


@dataclass(frozen=True)
class RidgeFrame:
    """The footprint's ridge axis ``u``, the across axis ``v``, and extents."""

    centre: Point
    u: Point
    v: Point
    half_length: float
    half_width: float

    def local(self, point: Point) -> Point:
        dx = point[0] - self.centre[0]
        dy = point[1] - self.centre[1]
        return (dx * self.u[0] + dy * self.u[1], dx * self.v[0] + dy * self.v[1])


def ridge_frame(ring: Sequence[Point], orientation: Optional[str] = None) -> Optional[RidgeFrame]:
    """Return the ridge frame: along the longest edge, unless told ``across``.

    The extents are measured from the footprint's projection onto the axes, so
    the ridge is centred on the footprint's bounding box in its own frame
    rather than on its centroid; for an L-shaped house that keeps the ridge
    over the middle of the long wing rather than pulled towards the notch.
    """
    count = len(ring)
    if count < 3:
        return None
    best_length = 0.0
    u = (1.0, 0.0)
    for index in range(count):
        a, b = ring[index], ring[(index + 1) % count]
        length = math.dist(a, b)
        if length > best_length:
            best_length = length
            u = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
    if best_length <= EPSILON:
        return None
    if orientation == "across":
        u = (-u[1], u[0])
    v = (-u[1], u[0])
    along = [p[0] * u[0] + p[1] * u[1] for p in ring]
    across = [p[0] * v[0] + p[1] * v[1] for p in ring]
    half_length = (max(along) - min(along)) * 0.5
    half_width = (max(across) - min(across)) * 0.5
    if half_length <= EPSILON or half_width <= EPSILON:
        return None
    mid_along = (max(along) + min(along)) * 0.5
    mid_across = (max(across) + min(across)) * 0.5
    centre = (u[0] * mid_along + v[0] * mid_across, u[1] * mid_along + v[1] * mid_across)
    return RidgeFrame(centre, u, v, half_length, half_width)


def skillion_heights(
    ring: Sequence[Point],
    direction_deg: Optional[float],
    wall_top: float,
    roof_top: float,
    frame: Optional[RidgeFrame] = None,
) -> Optional[List[float]]:
    """Return the top height of each ring vertex for a single sloping plane.

    ``roof_direction`` is the compass bearing the roof slopes *down* towards,
    so the vertices furthest along it are at the wall top and the ones
    furthest against it at the roof top.  Verified on the eight facets of a
    tower crown, whose directions all point away from the tower's centre.
    Without a direction the slope runs across the footprint's short axis.
    """
    if len(ring) < 3:
        return None
    if direction_deg is not None:
        d = direction_vector(direction_deg)
    elif frame is not None:
        d = frame.v
    else:
        return None
    projected = [p[0] * d[0] + p[1] * d[1] for p in ring]
    low, high = min(projected), max(projected)
    span = high - low
    if span <= EPSILON:
        return None
    rise = roof_top - wall_top
    return [wall_top + rise * (high - value) / span for value in projected]


def planar_roof_regions(
    ring: Sequence[Point],
    kind: str,
    frame: RidgeFrame,
    wall_top: float,
    roof_top: float,
) -> Optional[List[List[Vertex3]]]:
    """Split a footprint into the planar regions of a gabled or hipped roof.

    In the ridge frame a gable is two half-planes either side of the ridge,
    each with height falling linearly from the ridge to the eaves.  A hip
    adds the two end faces, bounded by the 45-degree hip lines from the ends
    of the ridge, whose length is the footprint's length minus its width.
    Every region's top is a plane, so each can be a prism with a planar cap.

    Returns ``None`` unless the regions add back up to the footprint's own
    area, which is how a clip that degenerated on an awkward outline is told
    apart from a region the footprint simply has no area in.
    """
    height = roof_top - wall_top
    width = frame.half_width
    if width <= EPSILON or height <= 0.0:
        return None
    reach = max(frame.half_length - frame.half_width, 0.0)

    def clamp(z: float) -> float:
        return min(max(z, wall_top), roof_top)

    if kind == "gabled":
        specs: List[Tuple[List[Callable[[float, float], float]], Callable[[float, float], float]]] = [
            ([lambda a, b: b], lambda a, b: clamp(wall_top + height * (1.0 - b / width))),
            ([lambda a, b: -b], lambda a, b: clamp(wall_top + height * (1.0 + b / width))),
        ]
    elif kind == "hipped":
        specs = [
            (
                [lambda a, b: b, lambda a, b: b - a + reach, lambda a, b: b + a + reach],
                lambda a, b: clamp(wall_top + height * (1.0 - b / width)),
            ),
            (
                [lambda a, b: -b, lambda a, b: -b - a + reach, lambda a, b: -b + a + reach],
                lambda a, b: clamp(wall_top + height * (1.0 + b / width)),
            ),
            (
                [lambda a, b: a - reach, lambda a, b: a - reach - b, lambda a, b: a - reach + b],
                lambda a, b: clamp(wall_top + height * (1.0 - (a - reach) / width)),
            ),
            (
                [lambda a, b: -a - reach, lambda a, b: -a - reach - b, lambda a, b: -a - reach + b],
                lambda a, b: clamp(wall_top + height * (1.0 - (-a - reach) / width)),
            ),
        ]
    else:
        return None

    regions: List[List[Vertex3]] = []
    covered = 0.0
    for tests, top_of in specs:
        polygon = list(ring)
        for test in tests:
            values = [test(*frame.local(point)) for point in polygon]
            polygon = clip_ring_linear(polygon, values)
            if len(polygon) < 3:
                break
        if len(polygon) < 3:
            continue
        covered += abs(signed_area(polygon))
        regions.append([(x, y, top_of(*frame.local((x, y)))) for x, y in polygon])
    expected = abs(signed_area(ring))
    if not regions or expected <= 0.0 or abs(covered - expected) / expected > 0.01:
        return None
    return regions


def ring_centroid(ring: Sequence[Point]) -> Point:
    """Area centroid of a simple ring, falling back to the vertex mean."""
    area = signed_area(ring)
    if abs(area) <= 1.0e-12:
        return (
            sum(p[0] for p in ring) / len(ring),
            sum(p[1] for p in ring) / len(ring),
        )
    cx = cy = 0.0
    count = len(ring)
    for index in range(count):
        x0, y0 = ring[index]
        x1, y1 = ring[(index + 1) % count]
        cross = x0 * y1 - x1 * y0
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    return (cx / (6.0 * area), cy / (6.0 * area))


def apex_levels(
    ring: Sequence[Point],
    kind: str,
    wall_top: float,
    roof_top: float,
    steps: int = DOME_STEPS,
) -> Tuple[List[Tuple[List[Point], float]], Vertex3]:
    """Return the intermediate rings and apex of a pyramid or dome.

    A pyramid is the footprint rising straight to one apex over its centroid.
    A dome scales the footprint towards that centroid by the cosine of the
    latitude at each step and lifts it by the sine, which is a quarter circle
    in profile whatever the footprint's outline.
    """
    centre = ring_centroid(ring)
    height = roof_top - wall_top
    levels: List[Tuple[List[Point], float]] = []
    if kind == "dome":
        for step in range(1, max(1, int(steps)) + 1):
            angle = (math.pi * 0.5) * step / (steps + 1)
            scale = math.cos(angle)
            z = wall_top + height * math.sin(angle)
            levels.append(
                (
                    [
                        (centre[0] + (x - centre[0]) * scale, centre[1] + (y - centre[1]) * scale)
                        for x, y in ring
                    ],
                    z,
                )
            )
    return levels, (centre[0], centre[1], roof_top)


def apex_solid_geometry(
    ring: Sequence[Point],
    bottom_z: float | Callable[[float, float], float],
    wall_top_z: float,
    levels: Sequence[Tuple[Sequence[Point], float]],
    apex: Vertex3,
) -> Optional[Tuple[List[Vertex3], List[Tuple[int, ...]]]]:
    """Build a closed solid: a prism whose top continues up to an apex.

    Vertices are the footprint at the bottom and at the wall top, one copy per
    intermediate ring, and the apex.  Faces are the bottom cap (ear-clipped,
    wound downward), quads between consecutive rings, and a fan to the apex.
    Every edge is then checked to be used by exactly two faces, the same
    promise the rest of the project makes, so a self-touching outline is
    refused rather than emitted open.

    *bottom_z* is either one height or a function of ``(x, y)``, so the
    underside can follow the ground under each outline vertex.
    """
    outline = oriented_ring(ring, counter_clockwise=True)
    count = len(outline)
    if count < 3:
        return None
    triangles = ear_clip(outline)
    if not triangles:
        return None

    if callable(bottom_z):
        bottoms = [float(bottom_z(x, y)) for x, y in outline]
    else:
        bottoms = [float(bottom_z)] * count
    vertices: List[Vertex3] = []
    rings: List[List[int]] = []
    rings.append(list(range(count)))
    vertices.extend((x, y, z) for (x, y), z in zip(outline, bottoms))
    rings.append(list(range(len(vertices), len(vertices) + count)))
    vertices.extend((x, y, float(wall_top_z)) for x, y in outline)
    for level_ring, z in levels:
        if len(level_ring) != count:
            return None
        rings.append(list(range(len(vertices), len(vertices) + count)))
        vertices.extend((x, y, float(z)) for x, y in level_ring)
    apex_index = len(vertices)
    vertices.append((float(apex[0]), float(apex[1]), float(apex[2])))

    faces: List[Tuple[int, ...]] = []
    for a, b, c in triangles:
        faces.append((rings[0][c], rings[0][b], rings[0][a]))
    for lower, upper in zip(rings, rings[1:]):
        for index in range(count):
            following = (index + 1) % count
            faces.append((lower[index], lower[following], upper[following], upper[index]))
    last = rings[-1]
    for index in range(count):
        faces.append((last[index], last[(index + 1) % count], apex_index))

    usage = {}
    for face in faces:
        size = len(face)
        for offset in range(size):
            a, b = face[offset], face[(offset + 1) % size]
            key = (a, b) if a < b else (b, a)
            usage[key] = usage.get(key, 0) + 1
    if any(uses != 2 for uses in usage.values()):
        return None
    return vertices, faces
