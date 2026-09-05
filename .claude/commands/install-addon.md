---
description: Build the add-on and install it into Blender 3.6 safely
---

Build and install the add-on. **Blender must be closed** — it writes
`userpref.blend` on exit and will clobber preferences written underneath it,
and it does not re-import an already-loaded package, so a "live" install
silently keeps running the old code.

1. Build: `python scripts/build_addon.py` (writes both zips to `dist/`).

2. Check whether Blender is running:
   `Get-Process blender -ErrorAction SilentlyContinue`
   If it is, **ask the user before force-closing.** They have agreed to a force
   close once before; that is not standing permission.

3. Install (PowerShell), replacing `<VERSION>`:
   ```powershell
   $addons = Join-Path $env:APPDATA "Blender Foundation\Blender\3.6\scripts\addons"
   $target = Join-Path $addons "jarvizar_city_model"
   if (Test-Path $target) { Remove-Item -Recurse -Force $target }
   Expand-Archive -Path "dist\jarvizar_city_model-<VERSION>-blender36.zip" -DestinationPath $addons -Force
   Get-ChildItem -Recurse -Directory -Filter "__pycache__" $target | ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
   ```
   Removing the folder first matters: `Expand-Archive -Force` merges, so files
   deleted in the new version would survive as orphans.

4. Enable and persist preferences headless (do **not** use `--factory-startup`,
   it disables add-on preferences):
   ```python
   bpy.ops.preferences.addon_enable(module="jarvizar_city_model")
   a = bpy.context.preferences.addons["jarvizar_city_model"]
   a.preferences.overture_python_path = r"C:\Users\adamj\Desktop\3dmapcreator\.venv-overture\Scripts\python.exe"
   bpy.ops.wm.save_userpref()
   ```

5. Verify against the **installed** copy, not the repo (do not put the repo on
   `sys.path`): print `bl_info["version"]`, `m.__file__`, the preference value,
   and `probe_client(...)`. Expect `{'ok': True, 'client_version': '1.0.2'}`.

Then tell the user to open Blender. Say plainly that the sidebar's
**Override** box being blank is correct — the path lives in add-on preferences.
