---
description: Verify the checkout with Python, Blender smoke, and cached integration checks
---

Read [shared project context](../../CLAUDE.md). Run from the repository root;
commands below use PowerShell. Verify interpreter/executable paths on the
current machine. There is no fixed expected test count or mesh count.

1. Run the Python suite in the external environment so optional LiDAR tests
   execute. Without those dependencies, report skipped tests explicitly.

   ```powershell
   & .\.venv-overture\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -t tests
   ```

   Keep `-t tests`: tests import sibling fixture modules. This suite needs no
   Blender or network; dependencies are declared in `requirements-lidar.txt`.

2. Run synthetic full-pipeline verification against the checkout:

   ```powershell
   $blenderExe = 'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe'
   & $blenderExe --background --factory-startup --python-exit-code 1 --python .\tests\blender_smoke.py
   ```

   Require `JARVIZAR_BLENDER_SMOKE_OK`, no traceback, and successful exit. Check
   `$LASTEXITCODE` after every external command. Smoke uses its own fixtures and
   settings; it does not replace focused subsystem tests.

   For generation ownership, publication, or cleanup changes, also run:

   ```powershell
   & $blenderExe --background --factory-startup --python-exit-code 1 --python .\tests\blender_generation_transaction.py
   ```

   Require `JARVIZAR_GENERATION_TRANSACTION_OK` and successful exit. This offline
   fixture injects failures after generation phases and before destructive
   publication, then checks exact rollback and successful retries. It also covers
   material users, scene state, helpers, shared meshes, and name collisions.

   For responsive generation, also run the offline real-worker checks:

   ```powershell
   & $blenderExe --background --factory-startup --python-exit-code 1 --python .\tests\blender_generation_modal.py
   ```

   Require `JARVIZAR_GENERATION_MODAL_OK`. This launches local background Blender
   workers from the checkout, cancels them inside every generation phase, and
   tests append/publication, settings changes, failed termination and retry.
   `tests/generation_worker_fixture.py` deliberately pauses test workers; it is
   not packaged or used by the add-on.

   The real event-loop check needs a window and simulated events:

   ```powershell
   & $blenderExe --factory-startup --enable-event-simulate --python-exit-code 1 --python .\tests\blender_generation_gui.py
   ```

   Require `JARVIZAR_GENERATION_GUI_OK` and both `GUI_CANCEL_OK` markers (Esc and
   button), with successful exit. It operates only on a disposable factory scene,
   verifies timer heartbeats during a deliberately blocked worker, retries to
   success, and closes its own test process without saving user preferences.
   On Windows, launch background windowed test helpers with `Start-Process
   -WindowStyle Hidden` and capture both output streams.

3. Run the full cached model when its Overture/DEM bundle is available:

   ```powershell
   $modelCacheRoot = Join-Path $env:APPDATA 'Blender Foundation\Blender\3.6\datafiles\jarvizar_city_model\cache'
   & $blenderExe --background --factory-startup --python-exit-code 1 --python .\tests\blender_live_full.py -- --cache $modelCacheRoot
   ```

   This takes a **cache root**, uses the default Cincinnati fixture, and performs
   no download. It accepts `--bbox west,south,east,north`; count assertions assume
   a dense city with all feature types, so small selections are not equivalent
   fixtures. Require `JARVIZAR_LIVE_FULL_OK`, successful exit, and zero meshes
   reported as not closed. This checks undirected edge usage; winding, seating,
   overlap, and printability need the relevant focused checks. If the cache is
   absent, report this layer as unrun instead of silently downloading data.

Use the regression table in `CLAUDE.md` for changed systems. Run each standalone
Blender script in a fresh process. Inspect live-script arguments and fixture/output
requirements; they are not all interchangeable.

The legacy `blender_live_smoke.py` currently fails its building-only fixture:
pond recessing remains enabled, so generation requires uncached water. It needs
`recess_ponds_and_fountains=False` as well as its existing disabled water/cut
settings. Do not cite it as passing. Synthetic `blender_smoke.py` already
exercises merged and unmerged output.

`--factory-startup` does not load saved preferences; supply an explicit downloader
path for isolated acquisition tests. Installed-copy checks run separately without
repository path injection; see [installation](install-addon.md). Clipboard
integration needs a real window (`blender_gui_paste.py`). The embed probe prints
diagnostic distributions; `PROBE_OK` alone does not certify acceptable geometry.

Report actual test/skip/failure counts, success markers, live bbox/settings,
object/polygon totals, generation time, and closure/winding findings as applicable.
Compare identical inputs/settings. Distinguish existing harness failures from
regressions and state what was not run. Keep transient results in task reports or
ignored `scratchpad/`, not agent context.
