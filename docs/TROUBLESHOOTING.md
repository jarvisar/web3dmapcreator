# Troubleshooting

Problems are listed by where they show up. When asking for help, click
**Copy Support Info** under **Setup and Cache** and include the copied text.

## Downloader setup

**"First-time setup needed" / "Downloader not found"**
Follow [Downloader setup](../README.md#downloader-setup). Then click **Detect**
under **Setup and Cache**.

**"Python 3.10 or newer was not found"**
Install Python from [python.org](https://www.python.org/downloads/). On
Windows tick **Add python.exe to PATH**. Open a new terminal and run the setup
command again.

**"Microsoft Store placeholder"**
Windows has a `python` command that only opens the Microsoft Store. Install
Python from python.org instead.

**"running scripts is disabled on this system"**
Use the command from **Copy Setup Command**; it runs the script with
`-ExecutionPolicy Bypass`. Or double-click `setup_downloader.cmd` in the setup
folder.

**Linux: "could not create the environment"**
Install the `python3-venv` package.

**The installation fails with a pip error**
Check the internet connection. If only Python 3.14 or newer is installed, some
packages may not be available for it yet; install Python 3.12 and run the setup
again.

**"LiDAR packages missing"**
LiDAR needs extra packages. Click **Copy with LiDAR** in the setup dialog and
run that command.

**Linux: Blender from Flatpak or Snap**
These builds cannot start the system's Python, so downloads do not work. Use
the blender.org download instead.

## Downloading

The status line under the buttons names the cause of a failed download. Each
download also writes a log to `<Cache Directory>/logs/download-<date>.log`.

**"Enable Allow Online Access"**
Blender 4.2 and newer start with online access turned off. Turn it on in
**Edit > Preferences > System > Network > Allow Online Access**. Areas that are
already downloaded still generate offline.

**"Could not reach the Overture servers" / "elevation tile server"**
Check the internet connection. A VPN, firewall, proxy or antivirus can block the
downloader's Python. Try again, or try another network.

**"The downloader Python is missing overturemaps"** or
**"The Overture Python cannot run the downloader"**
The downloader environment is incomplete or uses Python older than 3.10. Run
the downloader setup again (see [Downloader setup](../README.md#downloader-setup)).

**"Not enough disk space"** or **"Cannot write to the cache folder"**
Free some space, or choose another **Cache Directory** under
**Setup and Cache**.

**"... timed out after 30 minutes"**
The area is too large for one download, or the connection is slow. Select a
smaller area or try again.

**"The downloader ran out of memory"** or **"stopped by the system"**
Select a smaller area.

**"The downloader stopped unexpectedly"**
Try again. If it keeps happening, include the newest download log when asking
for help.

## Choosing an area

**"West is not a number" / "use a point for decimals"**
Coordinates are decimal degrees with a point: `-84.5337`, not `-84,5337`.

**"West must be less than East" / "South must be less than North"**
The coordinates are in the wrong order. The order is west, south, east, north.
Areas that cross the 180° meridian are not supported.

**"Cache Directory is empty" / "relative to a .blend file that is not saved"**
Choose a full folder path for **Cache Directory** under **Setup and Cache**, or
save the .blend file first.

**"Cannot write to <folder>. Choose another folder."**
Blender cannot create files there, for example inside Program Files. Choose a
folder in your user folder.

## Generating

**"No downloaded map data for this area"**
The area or enabled features changed since the last download. Click
**Download / Cache Data**, or press **Generate Model** and accept the offer to
download first.

**"The cached ... data is damaged"**
A downloaded file is incomplete. Turn on **Refresh Existing Cache** and click
**Download / Cache Data**.

**"Cached elevation grid does not cover this bounding box"**
Enable **Refresh Existing Cache** and download again.

**"No land left after cutting water"**
The area is all water. Include some land, or turn off
**Cut Water From Terrain** in the Water panel.

**"Basin Water Thickness must be ... no more than Recess Depth"**
In the Water panel, set **Basin Water Thickness** to at most **Recess Depth**.

**Why did generation fail?**
The worker's log is kept in `<Cache Directory>/logs/generation-<date>.log` and
is listed by **Copy Support Info**.

**Blender uses a lot of memory or closes during Generate**
Large areas need a lot of memory: the new model is built in a separate Blender
process while the previous model is kept, and both are in memory while the new
one is loaded. Use a smaller area, turn off Trees, or clear the previous model
first with **Clear Generated Model**.

**Generation takes a long time**
Time grows with the area and the number of buildings and roads. Terrain
Resolution, Trees and Tidy Road Network also add time. Esc or
**Cancel Generation** keeps the previous model.

**Buildings are missing or have the wrong height**
Map data varies by city. A building without a mapped height or floor count
uses a default height for its type, then **Default Building Height**. Very
small buildings can be dropped for printability (see the Buildings panel).
Where public LiDAR exists, **LiDAR Buildings** can measure heights and roofs.

**Small lakes or ponds are not cut through the base**
Water smaller than **Minimum Cut Area** (5000 m² by default) is not cut through.
Ponds, fountains and basins are recessed instead.

## Exporting

**"Nothing to export: generate a model first"**
Only generated objects are exported. Generate the model first.

**"Nothing to export inside cutout's inner opening"**
The `cutout` frame does not overlap the model. Move the frame over the model
(top view, Numpad 7), or delete it to export the whole model.

**The cutout frame is not accepted**
The frame must be a mesh named exactly `cutout` with one opening through it.
Use **Add Frame** to create a valid one.

**Heights are wrong in Bambu Studio / parts are scattered on the bed**
The file was exported with Blender's File > Export, or opened with Import
instead of **File > Open Project**. Use **Export 3MF for Bambu** and open the
file as a project.

**Too many filaments for the AMS**
Each distinct colour is one filament. Use the **4-Colour AMS** or
**Single Colour** preset in the **Colours** panel, or give several groups the
same colour.

**"the model is ... larger than the ... bed"**
The export finished, but the model does not fit the selected printer. Add a
cutout frame and enable **Multi-Plate Export**, or choose a smaller area or
scale.

**"Close <name> in other programs or choose another name"**
The file is open in the slicer or another program. Close it there, or export
under another name.

**Edits made in Edit Mode**
Exports include changes made in Edit Mode, and objects whose faces were all
deleted are skipped.

## Blender versions

The add-on is developed on Blender 3.6 and tested on Blender 5.2. On Blender
4.2 and newer install the extension ZIP; on 3.6 to 4.1 install the classic ZIP.
