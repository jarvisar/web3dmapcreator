"""The terrain solid, optionally with open water cut clean out of it.

The top surface is built one grid cell at a time.  A cell entirely on dry land
becomes a quad; a cell entirely under water becomes nothing; a cell the shore
runs through is clipped against the shoreline, using the exact crossings the
water mask recorded, so the bank follows the real river rather than the grid.

Watertightness is not asserted afterwards, it is a property of the construction.
Every top face is wound counter-clockwise, the bottom is the same set of faces
mirrored at a constant Z with the winding reversed, and a wall is raised on
exactly those top edges that only one face uses.  A directed edge therefore
appears once going each way in the finished solid, which is what manifold
means.  Two cells sharing a grid edge always agree about that edge, because
they share both of its nodes and therefore both of its wetness bits -- so the
cut introduces no T-junctions.

This module is pure: it returns vertices and faces, and imports no Blender.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .watermask import WaterMask

Vertex = Tuple[float, float, float]
Face = Tuple[int, ...]


def terrain_solid_geometry(
    samples: Sequence[Sequence[float]],
    min_x: float,
    min_y: float,
    max_x: float,
    max_y: float,
    base_thickness: float,
    mask: Optional[WaterMask] = None,
    draped_bottom: bool = False,
) -> Tuple[List[Vertex], List[Face], Dict[str, Any]]:
    """Build a closed terrain solid from a row-major grid of top elevations.

    ``samples[row][column]`` is the top surface height in model millimetres,
    with row 0 at *min_y*.  When *mask* is given, every cell it reports as water
    is removed and the opening is walled down to the base.

    The base is placed *base_thickness* below the lowest point of the finished
    top surface, which is only known once the surface exists: cutting a river
    away takes its bed with it, and the shoreline sits between a grid node and
    the bank rather than on either.  Measuring the built vertices makes the
    stated thickness exactly true instead of approximately so.

    With *draped_bottom* the underside follows the top at a constant
    *base_thickness* below it instead of being flat.  That turns the same
    construction into a ground slab -- a park clipped exactly to the dry land
    around a cut river -- while keeping every closure argument intact: the
    bottom is still the top's face set mirrored with reversed winding, and the
    walls still stand on exactly the boundary edges.
    """
    rows = len(samples)
    columns = len(samples[0]) if rows else 0
    if rows < 2 or columns < 2:
        raise ValueError("Heightfield requires at least a 2x2 grid")
    if any(len(row) != columns for row in samples):
        raise ValueError("Heightfield rows must all have the same length")
    if mask is not None and (mask.columns != columns or mask.rows != rows):
        raise ValueError("Water mask does not match the height field grid")

    step_x = (max_x - min_x) / (columns - 1)
    step_y = (max_y - min_y) / (rows - 1)

    vertices: List[Vertex] = []
    node_indices: Dict[Tuple[int, int], int] = {}
    crossing_indices: Dict[Tuple[str, int, int], int] = {}

    def node(row: int, column: int) -> int:
        key = (row, column)
        index = node_indices.get(key)
        if index is None:
            index = len(vertices)
            vertices.append(
                (
                    min_x + step_x * column,
                    min_y + step_y * row,
                    float(samples[row][column]),
                )
            )
            node_indices[key] = index
        return index

    def crossing(corner: Tuple[int, int], other: Tuple[int, int], corner_wet: bool) -> int:
        """Return the shared shoreline vertex on the grid edge between two nodes.

        Keying by the grid edge rather than by the cell is what welds the two
        cells either side of the bank together.
        """
        (row_a, column_a), (row_b, column_b) = corner, other
        if row_a == row_b:
            row = row_a
            column = min(column_a, column_b)
            wet_on_left = corner_wet if column_a < column_b else not corner_wet
            key = ("h", row, column)
            index = crossing_indices.get(key)
            if index is None:
                x = mask.row_crossing(row, column, wet_on_left)
                t = (x - (min_x + step_x * column)) / step_x
                z = samples[row][column] * (1.0 - t) + samples[row][column + 1] * t
                index = len(vertices)
                vertices.append((x, min_y + step_y * row, float(z)))
                crossing_indices[key] = index
            return index

        column = column_a
        row = min(row_a, row_b)
        wet_below = corner_wet if row_a < row_b else not corner_wet
        key = ("v", row, column)
        index = crossing_indices.get(key)
        if index is None:
            y = mask.column_crossing(row, column, wet_below)
            t = (y - (min_y + step_y * row)) / step_y
            z = samples[row][column] * (1.0 - t) + samples[row + 1][column] * t
            index = len(vertices)
            vertices.append((min_x + step_x * column, y, float(z)))
            crossing_indices[key] = index
        return index

    tops: List[Face] = []
    cells_removed = 0
    cells_clipped = 0

    for row in range(rows - 1):
        for column in range(columns - 1):
            corners = (
                (row, column),
                (row, column + 1),
                (row + 1, column + 1),
                (row + 1, column),
            )
            if mask is None:
                tops.append(tuple(node(r, c) for r, c in corners))
                continue

            flags = [mask.is_wet(c, r) for r, c in corners]
            wet_count = sum(flags)
            if wet_count == 4:
                cells_removed += 1
                continue
            if wet_count == 0:
                tops.append(tuple(node(r, c) for r, c in corners))
                continue

            # Walk the cell boundary counter-clockwise, keeping dry corners and
            # inserting the shoreline wherever the boundary changes state.  This
            # is Sutherland-Hodgman with the water as the clipping half-plane,
            # so the result is already wound the same way as a whole cell.
            polygon: List[int] = []
            for index in range(4):
                following = (index + 1) % 4
                if not flags[index]:
                    polygon.append(node(*corners[index]))
                if flags[index] != flags[following]:
                    polygon.append(
                        crossing(corners[index], corners[following], flags[index])
                    )
            polygon = _drop_repeats(polygon)
            if len(polygon) >= 3:
                tops.append(tuple(polygon))
                cells_clipped += 1

    if not tops:
        raise ValueError("Terrain solid has no dry land left to build")

    bottom_z = min(vertex[2] for vertex in vertices) - float(base_thickness)

    # A directed edge used by one top face is on the boundary; used by two it is
    # interior.  Anything else means a face was emitted twice and the solid
    # would not close, so it is reported rather than silently walled.
    directed: Dict[Tuple[int, int], int] = {}
    for face in tops:
        count = len(face)
        for index in range(count):
            pair = (face[index], face[(index + 1) % count])
            directed[pair] = directed.get(pair, 0) + 1

    boundary = [pair for pair, uses in directed.items() if uses == 1 and (pair[1], pair[0]) not in directed]
    duplicated = sum(1 for uses in directed.values() if uses > 1)

    bottom_offset = len(vertices)
    if draped_bottom:
        vertices.extend(
            (x, y, z - float(base_thickness)) for x, y, z in list(vertices)
        )
    else:
        vertices.extend((x, y, bottom_z) for x, y, _z in list(vertices))

    faces: List[Face] = list(tops)
    faces.extend(tuple(bottom_offset + index for index in reversed(face)) for face in tops)
    faces.extend(
        (start, bottom_offset + start, bottom_offset + end, end) for start, end in boundary
    )

    statistics = {
        "cells_total": (rows - 1) * (columns - 1),
        "cells_removed": cells_removed,
        "cells_clipped": cells_clipped,
        "boundary_edges": len(boundary),
        "duplicate_edges": duplicated,
        "bottom_z": bottom_z,
    }
    return vertices, faces, statistics


def _drop_repeats(indices: Sequence[int]) -> List[int]:
    """Remove consecutive duplicate vertices, including across the wrap."""
    result: List[int] = []
    for index in indices:
        if not result or result[-1] != index:
            result.append(index)
    while len(result) > 1 and result[0] == result[-1]:
        result.pop()
    return result
