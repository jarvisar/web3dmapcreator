# Development

Notes for working on the add-on itself. [CLAUDE.md](../CLAUDE.md) is the full
architecture and verification reference.

## Project layout

| Path | Contents |
| --- | --- |
| `jarvizar_city_model/` | The add-on package: settings (`config.py`), operators, sidebar UI (`ui.py`) |
| `jarvizar_city_model/data/` | Cache, projection, downloads, area search, palettes, export writers. No `bpy` |
| `jarvizar_city_model/external/` | Scripts run outside Blender: Overture, elevation and LiDAR downloaders, the generation worker |
| `jarvizar_city_model/geometry/` | Terrain, water, roads, bridges, buildings, trees |
| `jarvizar_city_model/blender/` | Materials, collections, export crop, generation and download sessions |
| `jarvizar_city_model/setup/` | Downloader requirements and setup scripts shipped to users |
| `tests/` | `test_*.py` run without Blender; `blender_*.py` run inside Blender |
| `scripts/` | Developer environment, build and install scripts |
| `docs/` | User and design documentation |

## Environment

1. Create the repository's downloader environment:

   ```powershell
   .\scripts\setup_overture_env.ps1
   ```

   On macOS/Linux: `bash scripts/setup_overture_env.sh python3.11`. This creates
   `.venv-overture` with the downloader requirements.
2. Install the LiDAR requirements too; the full test suite uses them:

   ```powershell
   & .\.venv-overture\Scripts\python.exe -m pip install -r requirements-lidar.txt
   ```

Version pins live in `jarvizar_city_model/setup/requirements-*.txt`. The
repository-root requirement files point to them.

## Tests

```powershell
& .\.venv-overture\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -t tests
$blender = 'C:\Program Files\Blender Foundation\Blender 3.6\blender.exe'
& $blender --background --factory-startup --python-exit-code 1 --python .\tests\blender_smoke.py
```

- `test_*.py` need neither Blender nor the network. Keep `-t tests`.
- Each `blender_*.py` prints a `*_OK` marker on success. Check the marker and
  the exit code.
- Run Blender-facing tests on Blender 3.6 and a current Blender (5.x).
- Some tests take arguments after `--`, for example
  `blender_setup_tools.py -- <downloader python>` and
  `blender_live_full.py -- --cache <cache root>`.
- Windowed tests (`*_gui.py`) run without `--background` and with
  `--enable-event-simulate`. On Blender 4.2+ add `--online-mode` to tests that
  download.

[verify.md](../.claude/commands/verify.md) lists the full verification steps.

## Build

```powershell
python .\scripts\build_addon.py
```

This writes two archives to `dist/`:

- `jarvizar_city_model-<version>-blender36.zip`: classic add-on layout
- `jarvizar_city_model-<version>-extension.zip`: Blender 4.2+ extension layout

The version comes from `jarvizar_city_model/blender_manifest.toml`; keep
`bl_info` in `__init__.py` the same. Both archives include `LICENSE` and the
`setup/` folder. Building again overwrites archives of the same version.

## Install locally

```powershell
& .\scripts\install_addon.ps1
```

Builds both archives and installs them into Blender 3.6 and the newest Blender
4.2+, with a backup of the previous installation in `dist/`. See
[install-addon.md](../.claude/commands/install-addon.md).

## Release checklist

1. Update the version in `blender_manifest.toml` and `bl_info`.
2. Move the changes under "Unreleased" in `CHANGELOG.md` to the new version.
3. Run the pure suite and the Blender tests on 3.6 and 5.x.
4. Build the archives.
5. Validate the extension:
   `blender --command extension validate dist\jarvizar_city_model-<version>-extension.zip`.
6. Install the ZIP into a clean Blender profile, set up the downloader, and
   download, generate and export one small area.
