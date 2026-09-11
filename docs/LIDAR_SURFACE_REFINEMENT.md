# LiDAR surface refinement after Task 1

## Scope and baseline

This refinement builds on Task 1 (0.18.0, reconstruction algorithm 12). The new
version is 0.19.0, algorithm 13. The user's three new screenshots show the
post-Task-1 add-on output. The original Micropolitan images remain qualitative
references, not claims about how that product reconstructs buildings.

The unchanged Task 1 package and external modules were copied before editing to
`scratchpad/surface-refinement/baseline-package` and `baseline`; module hashes
are in `baseline-hashes.json`. Prepared point arrays, mapped footprints, neighboring
footprints, mapped parts and output scales are identical in each comparison.
No source discovery, point acquisition, provider normalization or general
skipped-building policy was redesigned. These comparisons use existing local
arrays from the Task 1 validation archive, not newly downloaded surveys.

## What still caused the blockiness

Task 1 removed elevation quantization from the coherent-surface path, but its
surface boundaries could still come from noisy Voronoi ownership polygons and
conservative measured contours. Simplification was small relative to the 1.5 m
support grid. A perfectly flat fitted roof therefore still acquired jagged
vertical walls when its outline was extruded. Separately refining neighboring
polygons also created unnecessary complementary strips and corners.

Plane merging happened before the final boundary/strip cleanup and before some
noisy regions acquired a usable final plane. Regions that eventually represented
almost the same roof remained separate. Adaptive meshing could also spend
vertices reproducing a shallow ripple even when a simpler plane represented it
within a small printed error. None of these artifacts came from Blender normals.

A separate, substantial source of remaining terraces was the complete legacy
fallback: one difficult patch could discard supported surface fitting elsewhere
in an otherwise accepted building. This remains a difficult case. An initial
attempt to retain only arbitrary failing polygons produced cleaner-looking
towers but also changed massing and cut new plateaus into continuous roofs; that
unrestricted behavior was rejected during validation.

## Reconstruction changes

`external/lidar_surface_models.py` now consolidates final supported planes after
the existing partition cleanup. Compatible neighboring surfaces share one model.
The merge preserves their independently measured gradients, so offset flat roofs
cannot become an invented ramp. Changes remain bounded against the original
models through repeated merges. Coherent residual structures prevent a coarse
plane from concealing a supported small crown.

Strict plane fitting remains first, preserving genuine shallow slopes. When it
does not fit, a coarser plane may suppress a subprint ripple only if its maximum
sample displacement meets the approximation budget. Larger curvature continues
through the existing adaptive surface fitter.

`external/lidar_surface_outlines.py` builds one shared internal boundary network.
Each interface is fitted once, then the network is polygonized with the exact
exterior and courtyard boundaries. Closed circles and rectangles are selected
only when the entire observed contour supports them within the displacement
budget. Other chains use bounded simplification and line fitting without imposing
right angles or a building-axis direction. Junction endpoints remain fixed.
Possible continuous joins are protected, and invalid coverage, changed ownership
or excessive movement retains the existing network.

The same boundary fitting can clean accepted compatibility envelopes while
preserving their existing elevations. `external/lidar_surface_completion.py`
can retain unresolved old roof surfaces while using fitted surfaces elsewhere.
It requires an already accepted complete building record, verifies actual XY
sample ownership, and expands retention over connected continuous old roofs.
It therefore cannot leave a podium-only result or cut arbitrary flat patches
into an existing continuous slope. Full coverage, height, vertex and facet
budgets still apply. Some difficult buildings consequently retain most or all
of their Task 1 geometry.

All geometry is emitted through the existing Blender building mesh path. No
smooth shading, normals adjustment, subdivision or smoothing modifier is used.
Terraces mode, source acquisition and disabled-LiDAR generation retain their
existing behavior.

## Scale and evidence budgets

The actual model transform supplies XY mm/m and building Z mm/m, including the
building-height multiplier. At defaults these are 0.07 and 0.077 mm/m. This is a
hybrid of print-scale budgets and survey-evidence floors, not a hardcoded city
resolution and not a promise of arbitrarily fine detail at large print scales.

| Decision | Budget |
| --- | --- |
| Initial surface evidence | Existing 1.5 m support grid and independently supported regions |
| Nominal plane residual | `max(0.2 m, 0.025 printed mm / Z scale)` |
| Bounded ripple approximation / final model change | `max(nominal residual, 0.05 printed mm / Z scale)` |
| Final neighboring-level significance | At least the existing rise budget; nominally 0.1 printed mm / Z scale |
| Internal contour displacement | `max(0.3 m, min(0.8 × cell size, 0.1 printed mm / XY scale))` |
| Independent feature width | Existing two-dimensional support and width checks; generally about 3 m at defaults |

These budgets do not globally smooth roofs. Large setbacks remain discontinuous;
strictly supported slopes retain their gradients; coherent residual structures
remain independently supported; and authoritative exterior/courtyard geometry
is unchanged. The old Minimum LiDAR Detail Width and Minimum Roof Step controls
remain Terraces-only.

## Validation inputs and method

The same 42 challenging Chicago buildings, 26 international candidates (15
accepted), and four large Chicago landmark candidates (two accepted) used in
Task 1 were replayed. Their local source provenance is documented in
[Task 1's report](LIDAR_RECONSTRUCTION_VALIDATION.md). Rejected candidates remain
in the reports; they are not counted as successful geometry.

The checked-in `tests/lidar_surface_fixtures.py` now supplies 15 deterministic
cases: flat/noisy/sloped/gabled/barrel roofs, a courtyard, steep slopes/folds,
diagonal and circular tiers, an irregular arc, multiple major levels, rooftop
plant on flat and sloped roofs, a broad subprint ripple, and a subprint level
offset. Roof-height probes lie inside known regions, not exactly on an uncertain
plant boundary. Both before and after use the same probe locations and tolerances.

All 74 accepted before/after pairs were generated through the actual Blender
3.6.1 building path. Audits check adoption, independent-shell closure, directed
winding, positive volume, merged/unmerged equivalence, footprint bounds,
courtyard voids, and known synthetic roof heights. Equal-camera, flat-shaded
individual-building renders are retained under `final-renders/`.

`tests/lidar_surface_metrics.py` measures shared roof discontinuities rather than
counting triangles as roof levels. It matches coincident edges within 10 microns
in survey metres and excludes microscopic derived base-fill strips below the
fitter's numerical sliver scale. The previous exact-edge metric missed some
nearly coincident interfaces and could count tiny numerical complement strips
as long walls. Both versions were recomputed with the same corrected metric.
Known linear-wall integrals, coplanar triangles and tiny coordinate gaps are
covered by checked-in tests. These numbers are therefore not directly comparable
with the older Task 1 report's interface totals.

## Results against Task 1

| Chicago, all 42 accepted buildings | Task 1 | Refinement |
| --- | ---: | ---: |
| Actual mesh faces | 82,490 | 64,479 |
| Actual mesh vertices | 86,084 | 65,850 |
| Prepared roof cap polygons | 12,421 | 9,242 |
| Minor wall length, 0.05–2 m jumps | 4,892.14 m | 4,142.33 m |
| Very small wall length, 0.05–0.65 m jumps | 1,020.66 m | 536.36 m |
| Wall length, 0.65–2 m jumps | 3,871.48 m | 3,605.98 m |
| Minor wall area | 5,300.26 m² | 4,905.10 m² |
| Observed measurement time | 49.48 s | 49.23 s |

Chicago mesh faces decrease 21.8%, vertices 23.5%, and cap polygons 25.6%.
Minor wall length decreases 15.3%; the very small-step subset decreases 47.5%.
The larger 0.65–2 m subset improves more modestly, by 6.9%. Not every such wall
is noise, so eliminating all of them would not be a valid objective. The final
pass merges 51 compatible plane regions. On networks eligible for outline
fitting, internal boundary vertices decrease from 6,376 to 4,858. Timings are
individual local runs, not controlled performance benchmarks.

The known circular tier's maximum outline error falls from 0.711 m to 0.176 m;
its perimeter approaches the ideal (149.33 → 145.25 m, ideal 144.51 m). The
diagonal rectangular tier improves from 0.678 m to 0.308 m maximum error.
The broad subprint ripple becomes one plane, the small offset loses its false
wall, and the genuine shallow slope, gable, barrel, rooftop plant and major
tiers pass their height probes. The 15 synthetic cases have zero measured
false minor walls after refinement versus 37.46 m before.

Across the 15 international successes, minor wall area decreases from 304.17
to 293.16 m² and the 0.65–2 m wall-length subset decreases from 237.40 to
222.00 m. Total minor wall length increases from 318.69 to 326.37 m, and faces
increase from 3,946 to 4,331. Improvement is therefore not uniform across these
small or difficult roofs. The large landmark comparison mainly reduces cap
complexity; 311 South Wacker retains its existing reconstruction.

Integrated roof-envelope volume is nearly unchanged: Chicago's median absolute
change is 0.020%, maximum 1.094%; international maximum is 0.089%; landmark
maximum is 0.004%; synthetic maximum is 1.000%. This is envelope integration,
not a sum of overlapping prism volumes. Comparisons to supported observations
on the inspected difficult buildings are recorded in `support-errors.json`.
Those checks caught and prevented much larger massing changes in rejected
intermediate candidates. Sparse, contaminated or ambiguously assigned boundary
observations remain a limitation, not independent architectural ground truth.

## Reproduction and artifacts

```powershell
.\.venv-overture\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -t tests
.\.venv-overture\Scripts\python.exe tests\lidar_surface_fixtures.py --output scratchpad\surface-fixtures.json --baseline-dir scratchpad\surface-refinement\baseline
& 'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe' --background --factory-startup --python-exit-code 1 --python tests\blender_lidar_surfaces.py -- --fixtures scratchpad\surface-fixtures.json --report scratchpad\surface-audit.json --render-directory scratchpad\surface-renders
```

Without `--baseline-dir`, the fixture generator compares Terraces to current
Detailed Surfaces; that must not be labeled a Task 1 comparison. The full local
archive replay uses `scratchpad/surface-refinement/measure_comparison.py`,
`adoption_fixtures.py`, `run_blender_checks.py`, `roof_metrics.py`,
`massing_metrics.py`, and `silhouette_metrics.py`. Inputs/outputs, failures,
timings, audits and the gallery remain under that scratch directory. These real
survey arrays are workstation-local, not checked-in test assets.

The final Python suite passes all 729 tests, with no skips (`pure-final.log`).
All 74 generated comparison pairs and six additional Blender regression scripts
pass; `blender-validation-final.json` records the final results, including the
synthetic rerun after correcting the ambiguous boundary probe. The complete
cached Chicago model with LiDAR disabled was separately regenerated: all 34
mesh fingerprints, 1,777,465 faces, 1,469,215 vertices and generation counts
match Task 1 exactly (`off-comparison.json`). This checks unrelated generated
geometry rather than relying only on code inspection.

Open `scratchpad/surface-refinement/comparison-gallery.html` for all 74 individual
comparisons. Task 1 is on the left and the refinement is on the right. The gallery
identifies records that retain some or all compatibility geometry.

## Remaining limitations and Task 2 observations

- The strongest improvement is in shared outlines, small false offsets and mesh
  complexity. Larger terraced patterns are only modestly reduced. This does not
  claim to eliminate the stacked appearance on every roof or match Micropolitan.
- Three Chicago cases retain a complete compatible envelope; two others retain
  some connected old roofs. Five complex Chicago cases therefore still contain
  compatibility geometry. Curved source footprint walls also remain constrained
  by their original polygon resolution. The algorithm does not invent facades,
  unsupported overhangs or unseen architectural detail.
- Survey support and numerical uncertainty impose floors in addition to the
  selected print scale. Increasing scale cannot recover absent observations.
  There is no physical print, slicer validation, or Blender 4.2+ runtime claim.
- Actual XY ownership can disagree with a patch's original logical sample
  assignment after contour/strip operations. This was a concrete quality hazard
  in attempted local replacements. The guarded completion retains existing
  geometry in those areas; it does not broadly resolve footprint registration
  or point ownership for Task 2.
- Existing ground/roof support, component coverage, source/epoch selection,
  cache matching and Blender adoption rejections remain separate Task 2 work.
  Merchandise Mart and Aon Center still fail their existing interpretation/ground
  checks. The local completion mechanism only consumes already accepted records;
  no previously rejected candidate in these comparisons was newly admitted.

## Installed release

Version 0.19.0, reconstruction algorithm 13, is installed at
`C:\Users\adamj\AppData\Roaming\Blender Foundation\Blender\3.6\scripts\addons\jarvizar_city_model`.
Both release ZIPs match all 99 packaged source files. Two fresh Blender 3.6.1
processes, run outside the checkout without factory startup, verified the
installed module location, exact archive contents, saved enablement, default
Detailed Surfaces mode, default scale, downloader preference and pinned native
dependencies. The valid existing downloader path was preserved.

The verified rollback copy of the previous package and `userpref.blend` is
`dist/rollback-surface-refinement-20260910-223009`. Installation and verification
records are `installation.json`, `installed-persist.json`, and
`installed-recheck.json` in the comparison directory. The installed classic
archive SHA-256 is
`d8789abafe4a28707520ac43be3b8b985acab83bc6a236316a19c0c65e358123`.

Existing scenes need **Prepare LiDAR Buildings**, then **Generate Model** to use
algorithm 13. Leave **Refresh Existing Cache** off to reuse the downloaded data.
