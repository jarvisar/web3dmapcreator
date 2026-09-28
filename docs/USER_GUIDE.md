# User Guide

This guide covers the City Model panel and every setting. See the
[README](../README.md) for installation.

- [Workflow](#workflow)
- [Choosing an area](#choosing-an-area)
- [Print scale](#print-scale)
- [Downloading data](#downloading-data)
- [Generating a model](#generating-a-model)
- [Feature settings](#feature-settings)
- [Colours](#colours)
- [Editing before export](#editing-before-export)
- [Exporting](#exporting)
- [Printing tips](#printing-tips)
- [Setup and cache](#setup-and-cache)
- [Files and folders](#files-and-folders)

## Workflow

The panel is in the 3D Viewport sidebar (press **N**) under the **City Model**
tab. The main panel follows the order of use:

1. **Area**: the map area to build.
2. **Print Scale**: how many printed millimetres per real metre.
3. **Download / Cache Data**: downloads what the enabled features need.
4. **Prepare LiDAR Buildings** (only when LiDAR Buildings is enabled).
5. **Generate Model**: builds the model from the downloaded data. No internet
   is needed for this step.
6. **Export**: writes a Bambu Studio project or STL files.

The last result is shown under the buttons. **Clear Generated Model** removes
everything the add-on generated and nothing else.

The closed panels below the main panel hold the settings for each feature. The
checkbox on a panel header turns that feature on or off.

## Choosing an area

The **Area** box holds the bounding box as decimal degrees, in west, south,
east, north order. Fill it in any of these ways:

- **Presets**: a built-in area, or one of your own under **My Areas**.
- **Paste Coordinates**: pastes one `west,south,east,north` line from the
  clipboard, for example from the Copy button at
  [prochitecture.com/blender-osm](https://prochitecture.com/blender-osm) or the
  Box value at [bboxfinder.com](https://bboxfinder.com). Commas, spaces and
  brackets are accepted; the order must be west, south, east, north.
- **Find Place**: type a place, address or landmark, or a latitude and
  longitude such as `41.8781, -87.6298`, then choose the size. With Fixed Print
  Scale the size is the printed width and height in mm; the default fits the
  selected printer's bed with a margin (200 x 200 mm on a 256 mm bed). With
  Fit to Size the size is in km. If several places match, pick one from the
  list. The area is centred on the place.
- **Resize** (arrows button): changes the size and keeps the centre. The
  **Fit P1S Bed** button (named after the selected printer) uses the largest
  size that fits its bed.
- **Draw** (pencil button): opens bboxfinder.com at the current area. Draw a
  rectangle, copy its Box value, then click **Paste Coordinates**.
- **Map** (globe button): opens the current area on openstreetmap.org.

The real size and area are shown under the buttons. Hints appear when the model
is larger than the printer's bed, when the area is over 50 km², and when the
print would be less than 25 mm across. They do not block anything.

Note: Find Place uses the OpenStreetMap Nominatim service and needs an internet
connection. Typed coordinates work offline. Search results © OpenStreetMap
contributors.

### My Areas

**Presets > Save Current Area** saves the area under a name; it then appears
under **My Areas**. **Remove Saved Area** deletes one. Saved areas are stored in
Blender's user config folder, for example
`%APPDATA%\Blender Foundation\Blender\4.2\config\jarvizar_city_model\bounds_presets.txt`,
so add-on updates keep them. The file has one `Name: west,south,east,north` line
per area and can be edited by hand.

Note: areas that cross the 180° meridian are not supported.

## Print scale

**Fixed Print Scale** (default) builds at an exact scale. The default is
**0.07 mm per metre** (1:14,286). At this scale a 6.5 m residential street is
0.455 mm wide, which is about the narrowest line a 0.4 mm nozzle prints well.
The finished size follows from the area: a 3 km wide area prints about 210 mm
wide.

The panel shows the model size, the ratio, and what the minimum and maximum
road widths mean in real metres.

| At 0.07 mm/m | Printed width |
| --- | --- |
| Motorway, 14 m | 0.98 mm, narrowed to the 0.70 mm maximum |
| Primary, 11 m | 0.77 mm, narrowed to the 0.70 mm maximum |
| Secondary, 9.5 m | 0.67 mm |
| Residential, 6.5 m | 0.455 mm |
| Service, 4.5 m | widened to the 0.45 mm minimum |

**Fit to Size** fits the area into a target width and height instead. The scale
then depends on the area. Large areas at a small scale lose detail: roads are
held at the printable minimum width, so footways end up as wide as main roads.

Note: all settings in millimetres are printed millimetres. One Blender unit is
one millimetre.

## Downloading data

**Download / Cache Data** downloads the data the enabled features need:

- Overture Maps layers (buildings, roads, water, land, land use, land cover,
  infrastructure) with the separate downloader Python.
- Elevation tiles from the AWS Terrain Tiles dataset when Terrain uses
  Elevation (DEM).

Data is cached per area. Pressing the button again reuses the cache and only
downloads missing layers, so turning on a feature later does not download
everything again. **Refresh Existing Cache** downloads the latest Overture
release again instead of reusing the cache.

The download runs in the background and Blender stays usable. A box at the top
of the panel shows the current step (Overture data, then elevation), the layer
or tile being downloaded, and the elapsed time. Press **Esc** or
**Cancel Download** to stop. Cached files are left as they were; a step that
already finished stays cached. While a download runs, the area fields,
Generate, Export, Prepare LiDAR and Clear are unavailable.

If **Generate Model** is pressed before the data is downloaded, the add-on lists
the missing data and offers to download it and then generate.

Each download writes a log to `<Cache Directory>/logs/download-<date>.log`. The
newest 20 logs are kept. See [troubleshooting](TROUBLESHOOTING.md) for common
download errors.

## Generating a model

**Generate Model** builds the model from the cache. It runs in a separate
background Blender process; the panel shows the current step and progress.
Press **Esc** or **Cancel Generation** to stop. The previous model is kept
until the new one is finished, so a failed or cancelled run changes nothing.

Regenerating replaces the previous generated model, including manual edits
made to it.

Generated objects are organized in collections:

```text
CITY_MODEL
├── TERRAIN
│   ├── LAND_SURFACES
│   └── TERRAIN_SUPPORTS
├── VEGETATION
├── WATER
├── ROADS
│   ├── SURFACE_ROADS
│   ├── BRIDGES
│   └── BRIDGE_SUPPORTS
└── BUILDINGS
    └── BUILDING_PARTS
```

Each object is made of separate closed solids. Overlapping solids are not
merged; slicers join them when printing.

## Feature settings

Defaults are listed for each setting.

### Terrain

| Setting | Default | Description |
| --- | --- | --- |
| Terrain | Elevation (DEM) | Elevation tiles, or a flat base (no elevation download) |
| Terrain Resolution | 192 | Grid cells across the longer side. Roads and water follow this grid |
| Terrain Smoothing (cells) | 1 | Mean filter radius. Removes 1–2 m of elevation noise that prints as bumps along roads |
| Terrain Exaggeration | 1.0 | Multiplies height differences |
| Base Thickness (mm) | 1.3 | Solid base below the lowest terrain point |
| Border Rim | Off | Raised frame around the edge |
| Rim Height (mm) | 1.5 | Rim height above the highest terrain point |
| Rim Width (mm) | 2.0 | Rim wall thickness |

### Parks and Land Cover

Parks, grass, forest floor, sand, rock and paved areas are thin slabs on top
of the terrain, each with its own colour.

| Setting | Default | Description |
| --- | --- | --- |
| Land Surface Rise (mm) | 0.4 | Height above the terrain (two 0.2 mm layers) |
| Embed Into Terrain (mm) | 0.15 | How far slabs, roads, buildings and piers reach below the terrain surface |
| Slope Beaches Into Water | On | Sand slopes down to the waterline next to cut water |
| Beach Slope Width (mm) | 1.5 | Width of that slope |
| Surface Priority | paved > sand > rock > green > forest | Which surface wins where two overlap. Use the arrows to reorder |

### Water

The checkbox on the Water header only controls the water fill. Rivers and lakes
are still cut out of the terrain when it is off, which leaves them open.

| Setting | Default | Description |
| --- | --- | --- |
| Water Thickness (mm) | 1.2 | Thickness of the water fill |
| Cut Water From Terrain | On | Removes rivers, lakes and the sea from the terrain |
| Minimum Cut Area (m²) | 5000 | Smaller water is not cut through the base |
| Keep Ground Under Structures | On | Keeps terrain under bridges, buildings and piers that stand in cut water |
| Skip Ponds, Fountains and Basins | Off | Leaves them out entirely |
| Recess Ponds, Fountains and Basins | On | Recesses them into the terrain with a solid floor instead of cutting through |
| Recess Depth (mm) | 1.0 | Depth below the local bank |
| Basin Water Thickness (mm) | 0.8 | Water fill thickness in a recess |

### Roads

| Setting | Default | Description |
| --- | --- | --- |
| Road Thickness (mm) | 0.6 | Height above the terrain (three 0.2 mm layers) |
| Minimum Road Width (mm) | 0.45 | Narrower roads are widened to this |
| Maximum Road Width (mm) | 0.7 | Wider roads are narrowed to this |
| Include Paths and Footways | On | Pedestrian paths and footways |
| Skip Sidewalks and Crossings | On | Leaves out sidewalks and crossings mapped beside streets |
| Include Railways | On | Railway lines |
| Tidy Road Network | Off | Merges doubled carriageways, joins near misses and removes short stubs |
| Minimum Road Gap (mm) | 0.4 | Closest two parallel roads may run before one is dropped (Tidy only) |
| Cut Roads at Export | On | Cuts roads out of parks when exporting instead of when generating. See [Editing before export](#editing-before-export) |

Airport runways, taxiways and aprons print with the roads.

### Bridges

Off by default. Mapped bridges become decks on piers, lifted clear of what they
cross.

| Setting | Default | Description |
| --- | --- | --- |
| Bridge Deck Thickness (mm) | 0.6 | Deck thickness |
| Bridge Clearance (mm) | 0.4 | Gap under a deck |
| Maximum Deck Grade | 0.08 | Steepest slope of a deck |
| Minimum Bridge Lift (mm) | 0.2 | Bridges that would rise less than this are built as roads |
| Bridge Support Spacing (m) | 30 | Real-world spacing between piers |
| Minimum Pier Size (mm) | 0.6 | Smallest pier width |
| Causeway Margin (mm) | 0.3 | Width of terrain kept beside a deck over cut water |

### Trees

Off by default. Trees are simple three-tier solids sized to print.

| Setting | Default | Description |
| --- | --- | --- |
| Remove Trees Over Roads/Paths | On | Skips trees whose crowns overlap roads |
| Mapped Trees | On | Individually mapped trees |
| Scatter in Forests | On | Trees scattered in mapped forests and woods |
| Scatter in Satellite Forest | On | Trees scattered in land cover forest |
| Tree Spacing (m) | 26 | Scatter spacing |
| Size Variation | 0.18 | Random size variation |
| Maximum Trees | 24000 | Upper limit |
| Minimum Tree Height (mm) | 1.6 | Smallest tree height |
| Minimum Tree Width (mm) | 1.1 | Smallest crown width |

### Buildings

| Setting | Default | Description |
| --- | --- | --- |
| Default Building Height (m) | 10 | Used when the map has no height or floor count |
| Floor Height (m) | 3 | Metres per floor when only a floor count is mapped |
| Building Height Scale | 1.1 | Multiplies building heights. Footprints are unchanged |
| Shaped Roofs | On | Gabled, hipped, skillion, pyramid and dome roofs where mapped |
| Restore Missing Main Bodies | On | Adds a building's main body when its mapped parts cover less than half of it |
| Merge Buildings and Trees | On | One BUILDINGS object and one TREES object. Off gives one object per building with its source data |
| Minimum Building Height (mm) | 0.8 | Short buildings are raised to this |
| Raise Only Footprints Over (mm) | 0.6 | Only footprints at least this size are raised, so sheds and walls stay low |
| Minimum Building Width (mm) | 0 (off) | Drops narrower buildings |
| Maximum Building Slenderness | 0 (off) | Drops buildings taller than this multiple of their width |
| Always Keep Wider Than (mm) | 0.45 | Never drops buildings at least this wide for slenderness |

Building heights come from the mapped height, then floor count × floor height,
then a default for the building type, then **Default Building Height**.

### LiDAR Buildings

Optional. Measures building heights and roofs from public LiDAR surveys, where
available (USA, Canada, England, Scotland, France, parts of Germany and Spain,
and other areas covered by the OpenTopography and Open LiDAR Data catalogues). It needs the LiDAR packages in the downloader environment.
Buildings without usable LiDAR keep their map geometry.

1. Download / Cache Data for the area.
2. Enable **LiDAR Buildings** and click **Prepare LiDAR Buildings**. This can
   take a long time for large areas. Esc or Cancel keeps completed work.
3. If the panel offers LAZ/LAS tiles, **Download Offered Tiles** is optional.
4. Generate the model.

| Setting | Default | Description |
| --- | --- | --- |
| Min Footprint (mm²) | 0.7 | Skips LiDAR for smaller buildings |
| Correct Heights Only | Off | Only fixes clearly wrong heights; keeps map shapes and roofs |
| Prefer LiDAR on Conflicts | On | Uses a usable scan even when it disagrees with the map |
| Mapped Rock Surfaces | Off | Also measures mapped bare rock |
| Roofs | Roof Envelope | Roof Envelope drapes one surface over the scan; Terraces uses flat tiers |
| International Discovery | On | Searches national and regional LiDAR sources outside the USA |
| Parallel Downloads | 4 | Simultaneous tile downloads |

Changing most LiDAR settings, the area or the scale needs Prepare again. See
[LiDAR buildings](LIDAR_BUILDINGS.md) and
[LiDAR preparation workflow](LIDAR_PREPARATION_WORKFLOW.md) for details.

## Colours

The **Colours** panel sets the colour of each part of the model and, for the
Bambu export, the PLA line (Basic or Matte) of its filament. Colours are saved
with the .blend file. Changing a colour recolours an existing model right
away; Generate and Export use the same colours.

The menu at the top applies a preset:

| Preset | Description |
| --- | --- |
| Default | PLA Matte Ivory White terrain, PLA Matte Caramel buildings, PLA Basic Dark Gray roads and paving, PLA Basic Bambu Green parks |
| Single Colour | Everything in PLA Matte Ivory White: one filament, for printers without multi-material |
| 4-Colour AMS | At most four filaments: white terrain and buildings, dark gray roads, green parks and trees, blue water |
| Classic Map | Beige terrain, terracotta buildings, white roads, light green parks, light blue water |
| Night | Black terrain, gray buildings, gold roads, dark blue water |

The menu shows **Custom** once the colours no longer match a preset.

- Click a swatch to pick any colour. The swatch's Hex value is the colour
  written to the exported file, so a filament's hex code can be typed in.
- The button next to each swatch lists Bambu PLA Basic and Matte filaments by
  name. Choosing one sets the colour and the PLA line.
- **PLA Lines** shows each group's PLA line instead of its colour.
- **Filaments** counts the distinct filaments used by the enabled features.
  Above four, one AMS unit is not enough.
- **Apply Colours to Model** recolours the model from the panel.
- **Read Colours From Model** copies colours edited on the `JCM_*` materials
  back into the panel, so the next Generate keeps them.

Note: colours in the viewport look lighter than the printed filament.

## Editing before export

The generated model can be edited in Blender before exporting.

- Roads are one object per road class. In Edit Mode, hover over a road piece
  and press **L** to select it, then delete it. A long road is usually several
  pieces.
- With **Cut Roads at Export** on, parks and other surfaces stay whole under
  roads in Blender. The export cuts out the roads that exist at that moment, so
  deleting or moving a road leaves no hole.
- Hidden objects are still exported.
- Exports include changes still open in Edit Mode. An object whose faces were
  all deleted is left out.
- **Generate Model** replaces all generated objects, including edits.

## Exporting

The export box in the main panel has two exports. Both only include objects the
add-on generated, cut roads out of parks (see above), and crop to the cutout
frame when there is one.

### Export 3MF for Bambu

Writes a Bambu Studio project: one object per plate, with one named part per
layer (`Terrain`, `Roads (Residential)`, `Greenery`, ...) and every relative
height kept. Each colour becomes one filament, and each part is already
assigned its filament. Set **Printer** first; it sets the bed size, plate
layout and starting presets. P1S is the default; A1 mini, A1, P1P, P2S,
X1 Carbon, X1E, X2D, A2L, H2C, H2S, H2D and H2D Pro are available.

Open the file in Bambu Studio with **File > Open Project**.

Note: File > Export > 3MF in Blender writes each object as a separate item.
Bambu Studio then moves each one to the bed on its own and the heights no
longer line up. Use the add-on's export instead.

### Export STL

For PrusaSlicer, OrcaSlicer, Cura and other slicers. Choose a folder and a
name such as `city.stl`, then choose **Files** in the file browser's side
panel:

- **One per Colour** writes one file per colour, for example
  `city_1_buildings_AE835B.stl` and `city_2_terrain_FFFFFF.stl`, numbered like
  the Bambu project's filaments. All files share one position.
- **One Combined File** writes `city.stl`, for single-colour printing.

With Multi-Plate Export on, each section gets its own set (`city_R1C1_...`).
Exporting again with the same name replaces the earlier set.

To load a colour set:

- **PrusaSlicer / OrcaSlicer**: import all files of the set at once (Ctrl+I)
  and answer **Yes** when asked to load them as a single object with multiple
  parts. Then set each part's filament in the object list.
- **Cura**: open all files of the set, set each model's extruder, select all
  (Ctrl+A), then right-click > **Merge Models** (Ctrl+Alt+G) to restore their
  positions.

### Cutout frame

A cutout frame limits the export to the area inside it. Click **Add Frame**
under the export button and choose a shape and size:

- Shapes: Rectangle, Rounded Rectangle, Circle, Hexagon.
- **Fit Printer Bed**: the selected printer's bed minus a margin.
- **Fit Model**: the generated model's width and depth.
- **Custom**: width and height in mm. Circles and hexagons are the largest
  that fit.

A red frame named `cutout` appears above the model. Move (G), rotate (R) or
scale (S) it and check the area from the top view (Numpad 7). Its height does
not matter. Click **Add Frame** again to change the shape or size; the position
and rotation are kept. Delete the frame to export the whole model. Clear and
Generate never remove it.

Any mesh named exactly `cutout` with one opening through it works as a frame.
See [export crop details](EXPORT_CUTOUT.md).

### Multi-Plate Export

For models larger than the bed. It needs a cutout frame. The area inside the
frame is split into a grid of sections no larger than **Max Section Size**
(210 x 210 mm by default, at most the bed size). The grid
follows the frame's rotation. Sections are named `Section R1 C1`,
`Section R1 C2` and so on, rows from north to south. Each section is its own
plate in the Bambu project, or its own set of STL files. Empty sections are
left out. Bambu Studio allows up to 36 plates. No connectors or gaps are added
between sections.

## Printing tips

- The defaults assume a 0.4 mm nozzle and 0.2 mm layers.
- Open the 3MF in Bambu Studio with **File > Open Project**. Importing it as
  geometry loses the plates, part names and filaments.
- Select your actual filaments in Bambu Studio and recalculate flushing volumes
  before slicing.
- Water fills and the terrain are separate parts; water can be printed in a
  different colour or left out.

## Setup and cache

| Setting | Default | Description |
| --- | --- | --- |
| Cache Directory | Blender user data folder | Where downloaded data is stored |
| Downloader | | Status of the downloader Python. **Detect** finds it, **Test** checks it |
| Override for this scene | Empty | A different downloader Python for this scene only. Normally empty |
| Reusable LiDAR Cache (GiB) | 30 | Size limit for LiDAR tiles and points shared between areas |
| Keep Disk Space Free (GiB) | 10 | LiDAR preparation stops before the disk gets fuller than this |
| Review Cache Cleanup | | Shows how much reusable LiDAR data can be removed, then removes it |
| Millimetre Scene Units | On | Sets the scene units so one Blender unit shows as one millimetre |

The **Help** buttons at the bottom:

- **Set Up Downloader** opens the setup steps (see the README).
- **Copy Support Info** copies a report for support requests: add-on and
  Blender versions, operating system, downloader status, area and scale,
  changed settings, the last status and recent logs. It is also saved in
  `<Cache Directory>/support/`. Paths in your home folder are shown as `~`.
- **Reset Settings** sets every setting back to its default. The area, cache
  directory and downloader paths are kept. It can be undone with Ctrl+Z.

The add-on preferences (**Edit > Preferences > Add-ons > Jarvizar City
Model**) hold the downloader Python, the LiDAR storage limits and
**Place Search URL**, which switches Find Place to another
Nominatim-compatible server.

## Files and folders

- **Cache**: one `bbox_<id>` folder per area under the cache directory, with
  the downloaded layers, the elevation grid and `manifest.json`. The default
  cache is in Blender's user data folder under `jarvizar_city_model/cache`. It
  can be changed under **Setup and Cache**. Deleting a bbox folder only means
  it is downloaded again next time.
- **LiDAR**: prepared buildings are stored with each area. Reusable LiDAR tiles
  and points are shared between areas and limited to the configured size.
- **Logs**: `<Cache Directory>/logs/` holds the newest 20 download logs and the
  logs of failed generations. **Copy Support Info** lists the newest ones and
  saves its report in `<Cache Directory>/support/`.
