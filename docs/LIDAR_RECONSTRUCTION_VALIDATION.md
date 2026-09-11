# LiDAR surface reconstruction validation

## Status and scope

This report covers reconstruction from existing, prepared LiDAR points through
the actual Blender building mesh. It does not evaluate discovery, downloads,
provider coverage, or a broad fix for buildings that skip enhancement. User
reference screenshots 1–2 are Micropolitan; screenshots 3–4 are the add-on.

The final comparison audits all 71 accepted generated geometries in Blender,
including one newly accepted international case. Nineteen representative
before/after pairs were rendered and inspected. A mesh can pass closure and
height checks while still containing poor narrow roof fragments, so visual
review and intermediate surface inspection are part of validation rather than
being replaced by aggregate statistics.

## Cause and reconstruction change

The previous Detailed Surfaces path started with the terrace representation:
supported grid samples were grouped by elevation, connected height regions
became polygonal tiers, and the later roof fitter used those tier boundaries.
Local noise and continuous slopes could therefore establish architectural
boundaries before a coherent surface was fitted. Keeping individual patches
as flat geometry on a fitting failure preserved those height steps. The
Blender builder faithfully extruded the prepared representation; its normals
were not the cause of the blockiness.

Detailed Surfaces now attempts coherent reconstruction before terrace fitting.
The grid limits evidence density and workload; it does not define roof height
bands. Compatible local planes establish regions, robust plane fits remove
measurement variation, and an adaptive faceted surface represents supported
curvature. Adjacent fitted planes meet at a common supported ridge or valley.
Region boundaries remain sharp where observations support a real wall or
setback. Footprints constrain exterior walls and courtyards; mapped parts help
only when measured regions corroborate them.

Small unsupported regions and statistically insignificant level differences
are filtered at the output scale. Narrow appendages are removed from otherwise
supported regions; connected gaps are assigned together to the locally
supported lower adjoining roof while retaining the broad roof cores. This
avoids creating detached tall blades or repeatedly exchanging thin fragments
between neighboring roofs. A bounded compatibility path retains the
established reconstruction when a full new surface envelope cannot be safely
fitted. This means some difficult buildings can still retain the previous
terraced appearance. The prepared `faceted_roof` record and actual Blender
prism construction remain the same public geometry path.

## Inputs and comparison controls

The task-start external reconstruction modules were copied to
`scratchpad/reconstruction-quality/baseline` before changes. All comparisons
replay identical point arrays, footprints, neighboring footprints, mapped
parts, and settings through this baseline and the current code. There were no
network acquisitions during these comparisons. The local arrays are not
committed test assets; their locations below document the actual validation
performed and permit replay on the development workstation.

| Set | Local provenance | Coverage and limitations |
| --- | --- | --- |
| Chicago, 42 buildings | `scratchpad/blockiness/*-fixture.json` and matching `*-points.npy`; prepared Cook County 2017 EPT data from `scratchpad/chicago-measurement-diagnostic/points-*.npy` | Previously accepted ordinary roofs, churches, large roof plants, irregular footprints, towers and setbacks. This is a deliberately challenging selection, not a random sample of the city. |
| International, 26 candidates | `scratchpad/official/{munich,toledo,toronto,paris,cologne}-points.npy`; corresponding cached building files identified by `scratchpad/official/live/*-bundle.txt` | Whole footprints contained in saved point bounds, transformed with a local metric projection. Baseline successes: nine Munich, one Toronto, four Paris. Saved Cologne bounds contain no complete eligible footprint; Toledo candidates mostly fail existing support checks. These are not evidence of successful Cologne/Toledo geometry reconstruction. |
| Four large Chicago landmarks | `scratchpad/lidar-v4/{wacker,mart}.npy`, `scratchpad/lidar-v5/{311,aon}.npy`, matching `*-features.json` | 71 South Wacker and 311 South Wacker are comparable successes. Merchandise Mart and Aon Center fail established roof/ground checks and are retained as limitations, not counted as successful comparisons. |
| Twelve deterministic synthetic roofs | `tests/lidar_surface_fixtures.py` | Flat, sloped, barrel, gabled, courtyard, steep crown/kink, diagonal and curved setbacks, rooftop plant, and three major levels. Known roof functions provide height and silhouette checks. |

Default settings are 0.07 printed mm per metre in XY and a 1.1 building height
multiplier, giving 0.077 mm per metre in Z. The former 0.1 mm detail width and
0.05 mm roof increment correspond to approximately 1.43 m and 0.65 m. All
rendered geometry uses this scale. Synthetic samples are spaced 0.45 m apart,
with deterministic 0.10–0.12 m variation on the noisy cases. Height probes are
inside known regions, not on an ambiguous discontinuity.

## What is measured

Measurement acceptance alone is insufficient. Serialized before/after records
are sent through the real Blender record validation, projection, building
generation, and merge paths. The audit checks that every independently closed
prism has two faces per edge, consistent directed winding, and positive
volume. It checks merged and unmerged geometry equivalence, courtyard voids,
footprint extent, and synthetic surface-height probes. These checks do not
claim that the aggregate building has been boolean-unioned into one shell.

Equal-camera renders use plain materials and the generated geometry, without
smooth shading or modifiers. Review focuses on the silhouette, coherent roof
planes, meaningful roof levels, ridges, curved forms, and thin fragments.
Facets are also inspected as prepared polygons to distinguish real surface
changes from triangulation needed to cap a valid polygon.

Facet and mesh counts track workload; they are not a direct noise score. A
continuous curved roof can correctly need more triangles than a staircase.
The separate roof-boundary metric evaluates shared polygon edges with each
side's fitted elevation. It counts discontinuities rather than coplanar
triangulation edges or continuous ridges:

- Minor walls: height jump greater than 0.05 m and less than 2 m.
- Minor walls at least one former default roof increment: jump from about
  0.65 m to 2 m.
- Minor wall area: the height jump integrated along the shared edge.
- Major walls: jump at least 2 m, reported separately so preserving setbacks
  is not treated as a defect.

These are descriptive metrics. A short wall may be real plant equipment, and
data-supported architectural levels must not be removed merely to improve a
score. For sloped caps the metric evaluates both surfaces along the same shared
line segments, splitting at the category thresholds and integrating their
linearly changing difference, rather than comparing unrelated median
elevations. The integration was checked against a known linearly increasing
0–3 m shared wall before computing both comparison sets.

## Results

| Check | Task-start baseline | Final reconstruction |
| --- | ---: | ---: |
| Accepted Chicago measurements | 42 / 42 | 42 / 42 |
| New coherent path among Chicago cases | — | 37 / 42 |
| Actual Blender Chicago adoption/closure checks | 42 / 42 | 42 / 42 |
| Accepted international measurements | 14 / 26 | 15 / 26 |
| Comparable international Blender checks | 14 / 14 | 14 / 14 |
| All accepted international Blender checks | 14 / 14 | 15 / 15 |
| New coherent path among international successes | — | 12 / 15 |
| Synthetic coherent fits and Blender checks | — | 12 / 12 |
| Accepted landmark Blender checks | 2 / 2 | 2 / 2 |
| New coherent path among landmark successes | — | 1 / 2 |
| Chicago prepared roof facets | 13,943 | 12,421 |
| Chicago actual mesh faces | 89,177 | 82,490 |
| Chicago actual mesh vertices | 95,110 | 86,084 |
| Chicago minor wall length, 0.05–2 m jumps | 9,223.91 m | 4,000.13 m |
| Chicago minor wall length, 0.65–2 m jumps | 8,742.89 m | 3,145.99 m |
| Chicago minor wall area | 11,102.63 m² | 4,300.08 m² |
| Chicago measurement time, 42 cases | 47.63 s | 49.48 s |

Timing is an observed local run, not a controlled benchmark; other development
work can affect scheduling. The added Paris case is audited for topology and
adoption, but excluded from paired before/after metrics. No previously accepted
measurement was lost. All 71 accepted outputs pass actual Blender adoption,
closure, winding, volume, and merge checks. Five Chicago cases use compatible
geometry: three lack roof boundary evidence, one has an unsupported slope, and
one cannot safely extrapolate the fitted surface. One of two successful large
landmarks and three international successes also use compatibility geometry.

Across all 42 Chicago pairs, including those fallbacks, minor wall length falls
56.6%, minor wall area falls 61.3%, and mesh faces fall 7.5%. The subset of minor
walls at least one former default increment falls 64.0%. These reductions are
not uniform: very small 0.05–0.65 m edge jumps increase from 481.02 m to 854.14 m,
so the result does not eliminate every micro-discontinuity. Noisy complex roofs
still require approximate surface interpretation.

For the 14 paired international successes, minor wall length falls from
301.36 m to 211.03 m, while faces increase from 3,561 to 3,912. This illustrates
why fewer triangles alone cannot establish better roofs. The twelve synthetic
cases remove the measured 120 m of false minor wall boundaries while retaining
their known major levels and passing all roof-height and courtyard probes.

The reviewed renders demonstrate recovered sloped Munich roofs, a clean
synthetic gable ridge, continuous barrel geometry, and retained tower/podium
levels. Kinzie Park Tower and 180 North Jefferson retain their major roof
structures with fewer arbitrary strips. Park Place's detached blade artifacts
were removed by the final partition repair, while its major tiers remain.
Small unsupported rooftop equipment disappears on the flat storage and Toronto
fixtures; the larger synthetic roof plant remains. 311 South Wacker and the
complex Munich church example show the limits of compatibility geometry, not
successful new surface fitting.

The synthetic circular tier's perimeter decreases from 159.76 m to 149.33 m
against an ideal 144.51 m; its approximately 0.71 m maximum contour error is
essentially unchanged. The diagonal tier's perimeter improves from 117.55 m to
109.84 m against an ideal 108 m, and its maximum contour error drops from
2.28 m to 0.68 m. Less stair-stepping therefore does not imply sub-survey
accuracy for every curved boundary.

Massing was checked by integrating the roof envelope over the footprint, not
by summing overlapping prism volumes. The median absolute change across the
42 Chicago buildings is 1.18%, but the largest change is 25.02%; the median
alone does not establish preservation. The three largest reductions, about
16–25%, were examined against their supported observations. Old St Patrick's
Church changes from an overfilled flat envelope to a sloped roof: its mean
absolute height error against the supported cells improves from 2.85 m to
0.24 m, and the old roof exceeded 213 supported cells by more than 2 m.

The two unnamed outliers contain narrow high strips beside neighboring roofs.
For `dc69b6f1`, 40 of 41 high cells match a nearby neighbor's elevation within
1 m, with median distance 0.45 m to the footprint edge. For `568aaa67`, all 22
examined high cells have nearby neighbor support, and 14 match within 1 m.
This is evidence consistent with boundary contamination rather than a broad
architectural roof tier. It is not independent ground truth: narrow genuine
features can remain ambiguous in airborne points and mapped footprints.
`real-massing.json`, `massing-evidence.json`, and
`massing-neighbor-evidence.json` retain these diagnostics. Synthetic massing
changes have median 0.20% and maximum 1.77%; the known roof functions and probes
provide a stronger geometric reference than the real-cloud comparisons.

One apparent new pit was checked against the original observations rather
than automatically smoothed away. Union Tower's approximately 121 m² roof
well has 624 classified roof returns across 69 independently occupied 1.5 m
cells. Their median height is 69.30 m, approximately 6.4 m below the main roof;
only four returns exceed 74 m. This is evidence for a meaningful recessed
level that the previous reconstruction concealed. The diagnostic is saved as
`scratchpad/reconstruction-quality/union-tower-well-evidence.json`.

## Reproduction commands

The checked-in deterministic fixture generator and Blender audit can be run
without the local real-data archive. A task-start snapshot is optional; when
omitted, the generator compares the explicit legacy Terraces mode with
Detailed Surfaces, which must not be described as the old Detailed Surfaces
baseline.

```powershell
.\.venv-overture\Scripts\python.exe tests\lidar_surface_fixtures.py --output scratchpad\roof-fixtures.json --baseline-dir scratchpad\reconstruction-quality\baseline
& 'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe' --background --factory-startup --python-exit-code 1 --python tests\blender_lidar_surfaces.py -- --fixtures scratchpad\roof-fixtures.json --report scratchpad\roof-audit.json --render-directory scratchpad\roof-renders
```

The workstation comparison harness records failures as well as successes:

```powershell
.\.venv-overture\Scripts\python.exe scratchpad\reconstruction-quality\measure_comparison.py --version after --only real
.\.venv-overture\Scripts\python.exe scratchpad\reconstruction-quality\measure_comparison.py --version after --only international
.\.venv-overture\Scripts\python.exe scratchpad\reconstruction-quality\measure_comparison.py --version after --only synthetic
.\.venv-overture\Scripts\python.exe scratchpad\reconstruction-quality\measure_comparison.py --version after --only landmarks
.\.venv-overture\Scripts\python.exe scratchpad\reconstruction-quality\roof_metrics.py --version after
.\.venv-overture\Scripts\python.exe scratchpad\reconstruction-quality\adoption_fixtures.py
.\.venv-overture\Scripts\python.exe scratchpad\reconstruction-quality\summarize.py
& 'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe' --background --factory-startup --python-exit-code 1 --python scratchpad\reconstruction-quality\audit_batch.py -- --fixtures scratchpad\reconstruction-quality\real-adoption.json --report scratchpad\reconstruction-quality\real-audit-all.json
```

Repeat the final command with international, synthetic, and landmark adoption
files. Newly accepted records are explicitly marked `unpaired_topology_only`
and are not used in paired metrics or before/after renders.
`render-comparison.json` selects representative cases for rendering;
passing `--render-directory` to the audit produces before/after PNGs. Outputs
are local artifacts under `scratchpad/reconstruction-quality`, not packaged
add-on files. `final-numbers.json` contains the final paired counts, audit
results, fallback reasons, and hashes of the surface reconstruction modules.
The inspected PNGs are under `review-renders/`, with a labeled local
`comparison-gallery.html` for review.

## Installation verification

Add-on 0.18.0, using LiDAR reconstruction algorithm 12, was installed after
validation. Two fresh Blender processes outside the checkout verified the
installed package, saved enablement, downloader interpreter, and required
native dependency versions. All 96 packaged files matched the release ZIP.
The verified previous installation and preferences are retained at
`dist/rollback-lidar-surfaces-20260910-190057`.

## Limits and separate Task 2 findings

- Roof reconstruction remains an airborne height envelope. It cannot infer
  missing facade observations, unsupported overhangs, or detail absent from
  the prepared cloud. Polygonal source outlines still limit exterior curves.
- The new representation is bounded in region/facet count and support. Some
  complex or sparsely observed roofs use the previous compatible geometry;
  their earlier terracing is not evidence of a successful new surface fit.
- Particularly complex roofs can take longer even when they ultimately fall
  back. The four archived landmark candidates took 25.86 s instead of 11.01 s,
  dominated by the rejected Merchandise Mart input; the 42-building Chicago
  sample remained near its previous total time.
- The tests exercise actual Blender 3.6.1 meshes. They do not establish Blender
  4.2+ runtime behavior, a slicer's union decisions, or a physical FDM print.
- Existing insufficient-ground, coverage, complex-roof, source-adoption, and
  cache matching failures still need separate investigation for Task 2.
  Aon Center's saved input fails ground support; Merchandise Mart's saved input
  fails roof interpretation. This task does not lower those evidence gates.
- The two narrow high strips described above suggest footprint registration
  and point ownership near neighboring buildings deserve separate review.
  Their elevation agreement is direct evidence; it does not establish that
  this is the cause of other buildings missing enhancement.
- Geometry-specific failure causes were fixed where necessary for this work:
  a convex-hull bridge probe demanded evidence outside a concave final roof;
  microscopic polygon remnants could spuriously report missing support; and
  nearly coincident cap edges could pass external geometry checks but collapse
  during Blender triangulation. These could cause a successfully measured
  building to fall back during geometry generation. Fixing them is not a
  general solution to skipped LiDAR buildings.
