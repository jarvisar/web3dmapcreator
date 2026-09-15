# 3MF export boundary

`JARVIZAR_OT_export_3mf` writes a native Bambu project from temporary export
copies (see [EXPORT_3MF.md](EXPORT_3MF.md)); `blender/export_cutout.py` prepares
those copies before the writer reads their evaluated meshes.
Only objects returned by `generated_objects(scene)` qualify; the scene object
named exactly `cutout` is excluded even if it has the generated tag.

## Opening extraction

The evaluated frame supplies its geometry and complete world transform. Face
normal areas rank candidate section planes, including applied rotations and
triangulated imports. Each candidate must have an inner closed loop throughout
its thickness profile. Surface area alone cannot select the axis: tall frame
walls can have more area than the annular caps, producing a side-on section
with no opening. A temporary frame mesh is centred and duplicate import
vertices are welded before sectioning. Of the closed section loops, the loop
nested inside the outside perimeter is the opening. The frame's physical mesh
is never a subtraction tool.

Sections on both sides of changes in the frame's thickness profile select the
tightest nested opening. This retains bevelled inner corners and handles
tapered mouths. Multiple holes, open/branching sections, incompatible profiles,
zero scale, and highly nonplanar frames are rejected rather than silently
exporting outside a guessed boundary. A finite planar mesh with one through
opening is required. Numerical tolerances derive from the actual frame size;
no opening dimensions, map identities, or coordinates are built into the code.

The crop is an unbounded prism along the frame's local thickness direction,
transformed by the frame's full matrix. Its height in the scene is not a top
or bottom clipping plane. Tilt, rotation, nonuniform scale and parent
transforms therefore affect the boundary in the same way as the frame.

## Clipping and ownership

1. Classify evaluated object bounds before copying mesh data. Inside objects
   share their original mesh on export-only object copies; outside objects
   allocate no export geometry.
2. Traverse connected shells in crossing objects. Generated merged meshes
   intentionally contain independent solids, often overlapping. Keep inside
   shells and batch removal of outside shells. Never weld neighbouring map
   solids by coordinate.
3. Copy only crossing shells into their own BMesh. BMesh operator setup scans
   its entire mesh even with a restricted geometry argument, so operating on
   small shell subsets of a large shared BMesh is still prohibitively slow.
4. Rectangular and other convex openings use inward half-space intersections
   with BMesh plane cuts. Fill each shell's section loops together so holes
   remain holes. Restore any collinear wall vertices omitted by Blender's
   triangulator by splitting the corresponding cap triangles. Only new caps
   are oriented, using the retained walls as their winding reference.
   If Blender's fill overlaps itself on a nearly collinear section, use the
   existing double-precision ear clipper for hole-free contours.
5. Concave openings use the existing prism builder and an Exact intersection
   on one crossing shell at a time, with `use_self=False`. The cutter is the
   opening volume extended beyond that shell's height. Validate closure and
   boundary containment before accepting the result.
6. Retained faces keep material indices. New caps use the dominant adjacent
   wall material within that shell. Parts and material slots are not joined.

The export context owns every temporary object and mesh and releases them on
success, an empty crop, clipping failure, and writer failure. Original objects
are never reparented. Object copies retain current world placement while their
parent/constraints are cleared. Crossing meshes bake current evaluation before
clipping. The operator leaves selection and the active object untouched.

Without `cutout`, full-model export remains unchanged. An invalid existing
`cutout` is an error, never a reason to export an uncropped model.

## Regression checks

Run `tests/blender_export_cutout.py` in Blender 3.6 with `--background
--factory-startup --python-exit-code 1`. It exercises dimensions, inside/outside
paths, independent overlapping shells, hollow caps, convex and concave shapes,
notches crossing faces whose corners are all inside, bevels, unwelded imports,
applied and object/parent transforms, modifiers, materials, failure cleanup,
and real project archives with both factory and millimetre scene units.

`tests/blender_export_cutout_live.py` generates a cached map or opens a generated
blend, checks every cropped mesh for manifold edges, consistent winding and
opening containment, and records clipping times. `--export` also writes a real
3MF. `--save-generated` saves the generated fixture for subsequent crop probes.

Validated on 2026-09-09: 432 pure tests and 15 Blender export regressions pass.
Cached Cincinnati: ~7.1 seconds cropping, 567 crossing shells, 38 closed output
meshes, 149,308 outside shells skipped. Rotating the same frame 17 degrees:
~7.2 seconds, 1,021 crossing shells, 38 closed output meshes. The default-frame
archive measures exactly 170.5 × 119.5 mm; Bambu Studio 02.08.02.61 round-trip
retains one build item / 38 parts and reports zero repairs in every mesh-stat
category. The Blender-written archive retains 13 material definitions. Evidence
and a rendered preview are in `scratchpad/export-cutout/`. No physical print or
full slicing run was performed.
