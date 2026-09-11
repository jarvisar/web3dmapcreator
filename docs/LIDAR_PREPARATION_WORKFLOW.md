# LiDAR preparation workflow — 0.20.0

This update improves feedback and reuse without changing reconstruction algorithm
13, acquisition selection, download consent, or geometry acceptance rules.

## Why preparation repeated work

The Blender shortcut discarded a prepared result on any source warning, even
when that warning affected zero buildings. Worker preparations always repeated
discovery. Measurement checkpoint keys included global footprint hashes and
discovery configuration, so unrelated edits could invalidate unaffected batches.
Downloaded bytes were cached, but decoded and normalized point arrays were not:
changing print scale required decoding the same tiles before fitting new roofs.

Progress was mostly acquisition/batch text. A large reconstruction batch could
remain on one message, with no building counter or visible progress bar.

## Current behavior

The top of City Model displays the preparation stage, survey, current operation,
elapsed time, cache reuse and Cancel button. Once a survey's candidate count is
known, the bar tracks building checks in that survey, including rejected or
deferred checks. It is not the fraction of buildings successfully enhanced or a
whole-job estimate. Discovery reports activity without an invented percentage.
EPT nodes, COPC tiles, LAS/LAZ chunks and individual roof reconstructions update
the status. Long native calls can still retain one message; elapsed time and
time since the last worker update remain visible. Esc and the button preserve
completed work and stop the existing worker through the same cancellation path.

Reuse proceeds at three levels before existing downloaded-tile reuse:

1. **Prepared result:** exact request/settings, valid records, source generations
   and an age under 24 hours allow immediate reuse, including offline. Actual
   failed building reads retry; zero-building provider warnings do not force a
   rebuild. After 24 hours, Prepare rechecks discovery. The age policy does not
   expire results during offline Generate Model.
2. **Measurement batches:** versioned keys include the actual batch footprints,
   mapped parts and neighbors, query bounds, source metadata/normalization and
   effective reconstruction settings. Unrelated discovery options and global
   file hashes no longer invalidate unchanged batches. Old exact-compatible
   checkpoints migrate when used. Missing, malformed or incomplete batches
   recompute; healthy batches remain reusable.
3. **Normalized points:** checksummed numeric arrays store geographic XY,
   metre Z and the reader's remaining classification/return/age evidence before
   projection. Changed scale or roof settings reconstruct from these points.
   Query bounds, selected source tiles/allowlists, source metadata, acquisition
   version and refresh generation must match. Corrupt arrays are discarded and
   recovered through the existing reader/download cache. Optional point-cache
   write failures do not abort preparation.

**Refresh Existing Cache** deliberately bypasses reuse and advances each
processed source's derived-cache generation. Returning to previously used print
settings cannot revive pre-refresh measurements or points. Ordinary Prepare and
changing settings do not require Refresh. Existing LAZ review/consent remains
required even when decoded data could satisfy the requested batch.

## Validation

- All **739 Python tests passed**, with optional LiDAR dependencies installed
  and no skipped tests. Integration checks cover ready reuse, expired discovery,
  zero-building warnings versus actual failures, corrupted points/checkpoints,
  legacy migration, changed footprints/neighbors/source units/acquisition version,
  print-scale changes, Refresh, and returning to an older scale after Refresh.
- Blender 3.6.1 operator tests passed for structured progress, Esc/button
  cancellation, failed cancellation recovery, changed settings, explicit LAZ
  consent, offline prepared reuse and a worker exiting without a valid result.
  The synthetic full-generation smoke test also passed.
- A disposable real Blender window ran a real external progress fixture. The
  event loop remained active through 27 timer ticks, the production progress
  widget visibly advanced through 10%, 20% and 30%, and the Cancel operator stopped
  its worker. The screenshot was inspected; user preferences were not saved.
- An offline replay of the full cached Chicago selection retained **all 986
  prepared building records exactly**, using **64 measurement batches / 2,240
  building checks**. Point reads and roof reconstruction were forbidden during
  the replay: neither occurred. Metadata rechecking took **6.35 seconds** and
  immediate prepared-result reuse **1.13 seconds** on this workstation.
- A separate actual Chicago roof fixture contained **171,063 captured points**.
  The initial preparation, immediate reuse and rescaled preparation performed
  only **one reader call in total**. Rescaling used the decoded-point cache and
  ran the real reconstruction. All three runs retained the building. Initial
  preparation took 8.11 seconds, immediate reuse 0.013 seconds and rescaling
  14.76 seconds; larger-scale roof fitting still costs time. These are individual
  local observations, not a general performance guarantee.

The real-data validations used cached metadata and captured points with network
access prohibited. They do not certify current remote-provider availability.
Detailed logs, GUI screenshot, fixture script and machine-readable results are
under `scratchpad/lidar-workflow/`. No geometry reconstruction math changed in
this release, and the full cached records matched exactly.

## Limitations

Reuse is conservative and batch-based. A footprint edit can alter grouping or
query bounds and invalidate nearby batches; arbitrary overlapping geographic
selections are not stitched from existing decoded arrays. Changed source
metadata or normalization can legitimately require another read. Data changed
at an unchanged URL without updated metadata remains subject to existing tile
cache behavior; use Refresh to deliberately reacquire it.

Older installations do not have normalized-point arrays until a batch is read
once. Reusing an old measurement checkpoint alone cannot populate those arrays.
Decoded arrays increase disk usage; there is no automatic eviction in this
release. The existing eight-million-point reader bound limits individual arrays,
not total cache storage. Cancellation during a batch retains earlier completed
batches; the interrupted roof fit itself restarts.

The bar resets for each survey. Point reading and a single large roof fit can
take substantial time between building completions, so no ETA is promised.
Blender 4.2+ extension packaging is verified, but runtime validation was on 3.6.1.
The separate skipped/rejected-building investigation remains outside this task.

## Installation

Installed **0.20.0** into
`%APPDATA%/Blender Foundation/Blender/3.6/scripts/addons/jarvizar_city_model`.
Both classic and extension archives match all 101 packaged source files.
Two fresh Blender processes verified the installed path/version, progress
properties, Cancel operator, algorithm 13, downloader dependencies and saved
enablement. Existing interpreter preferences and map/LiDAR caches were preserved.
The verified previous add-on and preference backup is
`dist/rollback-lidar-workflow-20260910-235653/`.
