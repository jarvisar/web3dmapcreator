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
