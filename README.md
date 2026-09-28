# Jarvizar City Model

Jarvizar City Model is a Blender add-on that turns an area of a map into a
3D-printable city model. It downloads buildings, roads, water and land use from
Overture Maps and terrain from public elevation data, and builds a model sized
for FDM printing with a 0.4 mm nozzle.

![Chicago Loop at the default scale, 150 x 110 mm](docs/images/preview.png)

## Features

- Terrain from public elevation data, with rivers, lakes and the sea cut out
- Buildings with mapped heights and gabled, hipped, pyramid and dome roofs
- Optional LiDAR building heights and roofs from public surveys
- Roads, paths, railways and airports, sized to print with a 0.4 mm nozzle
- Optional bridges on piers and optional trees
- Parks, forest, sand, rock and paving as separate colour layers
- Recessed ponds and fountains
- Fixed print scale: 0.07 mm per metre (1:14,286) by default
- Bambu Studio project export with one filament per colour
- STL export for other slicers, one file per colour
- Custom colour palettes, including a single-colour palette
- Place search, presets, and areas sized to a print or printer bed
- Crop to a rectangle, circle or hexagon frame
- Split large models across several plates
- Cached downloads; generation works offline

## Requirements

- Blender 4.2 or newer, or Blender 3.6. Tested on Blender 3.6 and 5.2.
- Python 3.10 or newer, for the downloader (3.11 to 3.13 recommended)
- An internet connection for downloading data
- 8 GB of RAM or more; large areas need more

## Installation

1. Download the add-on ZIP:
   - Blender 4.2 and newer: `jarvizar_city_model-<version>-extension.zip`
   - Blender 3.6 to 4.1: `jarvizar_city_model-<version>-blender36.zip`
2. Install it:
   - Blender 4.2 and newer: drag the ZIP into Blender, or use
     **Edit > Preferences > Get Extensions**, open the menu in the top right and
     choose **Install from Disk...**
   - Blender 3.6 to 4.1: **Edit > Preferences > Add-ons > Install...**, then
     enable **Object: Jarvizar City Model**
3. In the 3D Viewport press **N** and open the **City Model** tab.

Install only one of the two ZIPs in a given Blender. Each Blender version keeps
its own preferences and cache folder; after switching versions, click
**Detect** under **Setup and Cache**, and point **Cache Directory** at the old
folder to reuse downloads.

### Downloader setup

Map data is downloaded by a separate Python environment, outside Blender. This
is set up once per computer.

1. Install Python 3.11, 3.12 or 3.13 if it is not installed.
   - Windows: download it from [python.org](https://www.python.org/downloads/)
     and tick **Add python.exe to PATH** in the installer.
   - macOS: python.org, or `brew install python@3.12`.
   - Linux: `sudo apt install python3 python3-venv`, or your distribution's
     equivalent.
2. In the City Model tab, click **Set Up Downloader**.
3. Click **Copy Setup Command**, or **Copy with LiDAR** to include the LiDAR
   packages.
4. Paste the command into PowerShell (Windows) or Terminal (macOS/Linux) and
   press Enter. It takes a few minutes. On Windows you can instead click
   **Open Setup Folder** and double-click `setup_downloader.cmd`.
5. Back in Blender, click **Detect**, then **Test Downloader**. Every row should
   show a check mark.

Nothing is installed into Blender. The environment is created in
`%LOCALAPPDATA%\JarvizarCityModel\downloader-venv` on Windows,
`~/Library/Application Support/JarvizarCityModel/downloader-venv` on macOS and
`~/.local/share/jarvizar-city-model/downloader-venv` on Linux. Add-on updates do
not remove it. Running the setup command again updates it.

Note: Blender 4.2 and newer start with online access turned off. Turn it on in
**Edit > Preferences > System > Network > Allow Online Access**.

## Usage

1. Choose an area: click **Find Place** and search for a city or landmark, pick
   one of the **Presets**, or paste coordinates in west,south,east,north order.
2. Check the model size shown under **Print Scale**.
3. Turn features on or off with the checkboxes on the panel headers (Terrain,
   Parks and Land Cover, Water, Roads, Bridges, Trees, Buildings).
4. Pick colours in the **Colours** panel, or a preset such as **4-Colour AMS**
   or **Single Colour**.
5. Click **Download / Cache Data**.
6. Click **Generate Model**.
7. Optional: click **Add Frame** to crop the model to a rectangle, circle or
   hexagon, and edit the model in Blender.
8. Click **Export 3MF for Bambu** and open the file in Bambu Studio with
   **File > Open Project**, or click **Export STL** for other slicers.

See the [user guide](docs/USER_GUIDE.md) for all settings.

## Known Issues & Limitations

- Areas that cross the 180° meridian are not supported.
- Large areas take longer to download and generate and need more memory.
- Map data varies by city. Buildings without a mapped height use a default
  height, and some areas have few mapped buildings.
- Bridges are schematic: decks on evenly spaced piers, without towers, arches or
  trusses.
- The model is built from separate overlapping solids. Slicers join them; other
  tools may report them as intersecting.
- LiDAR preparation for large areas can take a long time and download several
  GB.
- The downloader setup has had less testing on macOS and Linux than on Windows.
  Blender installed from Flatpak or Snap on Linux cannot run the downloader.

## Troubleshooting

See [troubleshooting](docs/TROUBLESHOOTING.md). When reporting a problem, click
**Copy Support Info** under **Setup and Cache** and include the text.

## Data and Attribution

Map data © OpenStreetMap contributors, Overture Maps Foundation. Elevation data
from the AWS Terrain Tiles open dataset. See [data sources](docs/DATA_SOURCES.md)
for the full attribution and what to include with printed models.

## Development

See [development](docs/DEVELOPMENT.md) for building, testing and the project
layout, and [how it works](docs/HOW_IT_WORKS.md) for how each layer is built.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
