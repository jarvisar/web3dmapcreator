# Downloader dependencies

Optional USGS LiDAR preparation adds `laspy[lazrs]==2.7.0`, `pyproj==3.7.2`
and `shapely==2.1.2` through `requirements-lidar.txt`, installed explicitly in
the same external environment. Blender imports none of these. See
[LiDAR setup and limits](LIDAR_BUILDINGS.md). PDAL is not required; 0.11.0 adds
roof-plane fitting and resumable batches using these same dependencies.
Version 0.12.0 adds source confidence, missing main masses and part-height
corrections using the same dependencies; no packages are added inside Blender.
Versions 0.13.0–0.14.0 improve massing, minimum height and LiDAR preference
using those same dependencies; there are no additional installation steps.

Jarvizar City Model keeps Overture's Python client outside Blender. The
Blender add-on itself uses Blender's `bpy` module and the Python standard
library; a separate virtual environment performs Overture downloads and writes
GeoJSON into the cache.

This separation is deliberate. The official Overture client depends on native
packages including PyArrow, Shapely, orjson, and NumPy. Blender ships its own
Python and NumPy versions, which differ between Blender releases. Installing a
second NumPy or binary wheel set into Blender can break Blender or another
add-on, and a Blender upgrade can discard packages installed into its bundled
Python.

`requirements-downloader.txt` pins the tested client:

```text
overturemaps==1.0.2
```

GeoPandas and pyproj are not required for Phase 1. The downloader uses the
official client's Arrow reader, while the add-on reads cached GeoJSON and
performs its small-area local projection itself.

## Automated setup

Run the setup command from the repository root. Both scripts create or reuse
`.venv-overture` in this repository, upgrade pip inside that environment, and
install `requirements-downloader.txt`. They never modify Blender's Python.

Python 3.11 is recommended. The selected Python must be version 3.10 or newer.

### Windows

Install 64-bit Python 3.11 from python.org with the Python launcher enabled,
then open PowerShell in the repository root:

```powershell
.\scripts\setup_overture_env.ps1
```

The script prefers `py -3.11`. To select a particular interpreter:

```powershell
.\scripts\setup_overture_env.ps1 -Python "C:\Path\To\Python311\python.exe"
```

If local PowerShell policy blocks scripts, use a process-only bypass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup_overture_env.ps1
```

Configure the add-on's **Overture Python** field with the absolute path to:

```text
<repository>\.venv-overture\Scripts\python.exe
```

### macOS

One reproducible way to obtain Python 3.11 is Homebrew:

```bash
brew install python@3.11
bash scripts/setup_overture_env.sh "$(brew --prefix python@3.11)/bin/python3.11"
```

Configure **Overture Python** with the absolute path to:

```text
<repository>/.venv-overture/bin/python
```

### Linux

On Debian or Ubuntu, install Python and its virtual-environment module, then
run the setup script:

```bash
sudo apt update
sudo apt install python3 python3-venv
bash scripts/setup_overture_env.sh python3
```

The distribution's `python3` must be version 3.10 or newer. On another
distribution, install its equivalent Python and venv packages and pass that
interpreter as the script's first argument. Configure **Overture Python** with
the absolute path to:

```text
<repository>/.venv-overture/bin/python
```

With no argument, the shell script tries `python3.11` and then `python3`.

## Manual equivalent

The setup scripts only run ordinary venv and pip commands. Their Windows
equivalent is:

```powershell
py -3.11 -m venv .venv-overture
.\.venv-overture\Scripts\python.exe -m pip install --upgrade pip
.\.venv-overture\Scripts\python.exe -m pip install --requirement requirements-downloader.txt
```

The macOS/Linux equivalent is:

```bash
python3.11 -m venv .venv-overture
.venv-overture/bin/python -m pip install --upgrade pip
.venv-overture/bin/python -m pip install --requirement requirements-downloader.txt
```

Verify the environment by running the project's downloader probe:

```powershell
# Windows
.\.venv-overture\Scripts\python.exe .\jarvizar_city_model\external\download_overture.py --probe
```

```bash
# macOS or Linux
.venv-overture/bin/python jarvizar_city_model/external/download_overture.py --probe
```

A successful probe prints JSON containing `"ok": true` and client version
`1.0.2`. The optional `JARVIZAR_OVERTURE_PYTHON` environment variable can hold
the same interpreter path, but the explicit add-on setting is easier to audit.

## Blender 3.6 and Blender 4.2+

Blender 3.6 uses the classic add-on format. Its ZIP must contain a top-level
`jarvizar_city_model` package whose `__init__.py` supplies `bl_info` and the
registration hooks. Install it through **Edit > Preferences > Add-ons >
Install**. Blender 3.6 does not use an extension manifest.

Blender 4.2 introduced the Extensions format. For an extension archive,
`blender_manifest.toml` and the add-on `__init__.py` are placed at the archive
root. Install a locally built ZIP through **Edit > Preferences > Get
Extensions > Install from Disk**. A distributable manifest should declare the
network and file permissions used for downloading and caching. Use relative
imports because installed extensions run in Blender's extension namespace.
Blender 4.2 can still load classic/legacy add-ons, but the Extensions format is
preferred for current distribution.

The source code can support both Blender generations, but the ZIP layout and
installation entry point differ. Do not include `.venv-overture` in either
archive.

## No runtime package installation

The add-on must not invoke pip, `ensurepip`, download wheels, or write into
Blender's `site-packages`. Blender's extension guidelines disallow runtime
package installation, and doing so would make dependency state platform- and
Blender-version-dependent. Run one of the setup scripts explicitly outside
Blender instead. The add-on may probe the configured interpreter and report a
clear error, but it must not repair or alter that environment automatically.

Relevant upstream documentation:

- [Official Overture Maps Python client](https://github.com/OvertureMaps/overturemaps-py)
- [Overture Maps package metadata](https://pypi.org/project/overturemaps/)
- [Blender extension add-ons](https://docs.blender.org/manual/en/4.2/advanced/extensions/addons.html)
- [Blender extension guidelines](https://developer.blender.org/docs/handbook/extensions/addon_guidelines/)
- [Blender Python wheel packaging](https://docs.blender.org/manual/en/5.0/advanced/extensions/python_wheels.html)

## Elevation tiles

Terrain uses the public AWS Terrain Tiles open dataset at
`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.

It needs no API key and no account. `jarvizar_city_model/external/download_dem.py`
depends only on the Python standard library: it fetches the covering tiles with
`urllib`, decodes the 8-bit truecolour PNGs with `zlib` and `struct`, converts
the Terrarium RGB encoding to metres, and resamples onto a regular grid written
as a small JSON header plus a raw float32 array.

That means the elevation path adds **no** new third-party dependency to either
environment. It is still run out of process, through the same interpreter as
the Overture client, so that Blender performs neither the network request nor
the PNG decode.

Zoom level is chosen from the requested grid spacing and clamped, with a tile
budget, so a large selection cannot silently request thousands of tiles. For
the 6 km sample bbox this resolves to zoom 13: four tiles, about 15 m per
pixel, fetched and resampled in under two seconds.

Elevations are orthometric (sea level), not WGS84 ellipsoid heights. The grid
is normalized against its own minimum, so the datum difference becomes a
constant offset that cancels out of a relative miniature. The offset and the
datum note are recorded in the grid header rather than silently discarded.

Confirm the current AWS Terrain Tiles license terms for your intended use. This
project reads the dataset at generation time and does not redistribute it.

