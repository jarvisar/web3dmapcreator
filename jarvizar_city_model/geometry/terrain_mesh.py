"""The uncut terrain solid: a displaced grid over a flat base.

Watertightness is not asserted afterwards, it is a property of the construction.
Every top face is wound counter-clockwise, the bottom is the same set of faces
mirrored at a constant Z with the winding reversed, and a wall is raised on
exactly those top edges that only one face uses.  A directed edge therefore
appears once going each way in the finished solid, which is what manifold
means.

Terrain with open water cut out of it is built in Blender, along the water
outlines themselves; see :mod:`jarvizar_city_model.geometry.dem_terrain`.

This module is pure: it returns vertices and faces, and imports no Blender.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

Vertex = Tuple[float, float, float]
Face = Tuple[int, ...]


def terrain_solid_geometry(
    samples: Sequence[Sequence[float]],
    min_x: float,
    min_y: float,
    max_x: float,
    max_y: float,
    base_thickness: float,
) -> Tuple[List[Vertex], List[Face], Dict[str, Any]]:
    """Build a closed terrain solid from a row-major grid of top elevations.

    ``samples[row][column]`` is the top surface height in model millimetres,
    with row 0 at *min_y*.  The base is placed *base_thickness* below the
    lowest point of the top surface.
    """
    rows = len(samples)
    columns = len(samples[0]) if rows else 0
    if rows < 2 or columns < 2:
        raise ValueError("Heightfield requires at least a 2x2 grid")
    if any(len(row) != columns for row in samples):
        raise ValueError("Heightfield rows must all have the same length")

    step_x = (max_x - min_x) / (columns - 1)
    step_y = (max_y - min_y) / (rows - 1)

    vertices: List[Vertex] = []
    node_indices: Dict[Tuple[int, int], int] = {}

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

    tops: List[Face] = [
        (node(row, column), node(row, column + 1), node(row + 1, column + 1), node(row + 1, column))
        for row in range(rows - 1)
        for column in range(columns - 1)
    ]

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
    vertices.extend((x, y, bottom_z) for x, y, _z in list(vertices))

    faces: List[Face] = list(tops)
    faces.extend(tuple(bottom_offset + index for index in reversed(face)) for face in tops)
    faces.extend(
        (start, bottom_offset + start, bottom_offset + end, end) for start, end in boundary
    )

    statistics = {
        "cells_total": (rows - 1) * (columns - 1),
        "boundary_edges": len(boundary),
        "duplicate_edges": duplicated,
        "bottom_z": bottom_z,
    }
    return vertices, faces, statistics
