# Changelog

## Unreleased

### Added

- Find Place: search for a place or type a latitude and longitude, and set the
  area around it at a chosen print size.
- Resize Area, View Area on Map and Draw Area in Browser buttons.
- My Areas: save and remove your own area presets. They are stored outside the
  add-on folder and survive updates.
- Size hints: real size and area, and a warning when the model is larger than
  the printer's bed.
- Colours panel with presets (Default, Single Colour, 4-Colour AMS, Classic Map,
  Night), a Bambu filament picker and a filament count.
- Export STL for other slicers, one file per colour or one combined file.
- Add Frame: creates a rectangle, rounded rectangle, circle or hexagon cutout
  frame sized to the bed, the model or a custom size.
- Downloads run in the background with progress, Esc/Cancel, a log file per
  download and plain error messages.
- Generate offers to download missing data first.
- Map data attribution in exported 3MF and STL files.
- Downloader setup scripts for Windows, macOS and Linux ship with the add-on.
  They create the downloader environment in a per-user folder that add-on
  updates do not remove.
- Set Up Downloader dialog with Copy Setup Command, Detect and Test Downloader,
  and a first-run box in the main panel.
- Copy Support Info and Reset Settings.
- Place Search URL preference.

### Changed

- Built-in area presets have descriptive names; ten print-sized international
  presets were added.
- Generation keeps the colours chosen in the Colours panel instead of resetting
  the palette.
- The print size in the Print Scale box is now the exact generated size.
- LICENSE contains the full GPL-3.0 text, and both ZIPs include it.
- The downloader Python is also found in the default setup location when no
  path is set.
- Requirement pins moved to `jarvizar_city_model/setup/`; the root
  requirement files point to them.
- Extension manifest: maintainer, tags, copyright and permission texts.

### Fixed

- Blender 5: exports wrote one grey filament for materials that only set a
  viewport colour, and an extra white filament from an empty terrain material
  slot. `Material.use_nodes` deprecation warnings are gone.
- Downloads no longer freeze Blender or open a console window, and a download
  that runs out of time reports it instead of raising an error.
- Exports on a non-English Blender (Translate New Data on) wrote every part in
  one grey filament.
- Choosing a folder Blender cannot write to froze Blender; it now reports
  "Cannot write to <folder>".
- An empty or `//` Cache Directory in an unsaved file resolved to Blender's
  working folder. A `//` folder is now stored as a full path once the file is
  saved, so Save As keeps it.
- Exporting in Edit Mode exported the mesh from before the edits.
- A generated object with all faces deleted blocked the whole 3MF export.
- Generation errors repeated their prefix and phase and were cut off in the
  status box; the worker log is now kept in `<Cache Directory>/logs/`.
- Damaged cache files, an all-water area and exporting over an open file now
  give messages that say what to do.
- Basin Water Thickness above Recess Depth stopped every generation, even
  without ponds in the area.
- Coordinates with typographic minus signs (−84.5) were rejected; decimal
  commas and inverted boxes get clearer messages.
- The downloader Python path accepts surrounding quotes and a venv folder.
- Single-plate exports warn when the model is larger than the printer's bed.
- Tooltip wording.
