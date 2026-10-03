import { useEffect, useState } from 'react';
import { CACHE_LIMIT, cacheSize, clearCache, LIDAR_CACHE_LIMIT } from '../../core/data/cache';
import { Dialog } from '../components/Dialog';
import { GithubMark } from '../components/Icons';
import { formatBytes, keepUnits } from '../lib/format';
import { setHelpOpen, toast, useApp } from '../state/store';
import { REPO_URL } from './TopBar';

const STEPS = [
  {
    title: 'Choose an area',
    text: 'Search for a place, pick a preset, or drag the box on the map. Drag a corner to resize it and the round handle to rotate it. Under Size, the lock next to the scale keeps it as it is. Unlock it to keep the printed size instead, so resizing the box changes the scale and a new scale resizes the box. Ctrl+Z undoes the last change to the area or the settings, like a move, a search or a dragged title, and Ctrl+Y redoes it. The arrows next to the logo do the same.',
  },
  {
    title: 'Pick what to make',
    text: 'At the top of the settings, pick 3D model or SVG map. For a model, check the printed size, the scale and your printer under Size, then the layers and colours. For an SVG map, pick a size like a plaque, a sheet of paper or a coaster, then Laser, Plotter or Print under Output. The box on the map becomes the map inside the border, with the piece and its title drawn around it.',
  },
  {
    title: 'Generate',
    text: 'Map data is downloaded and everything is built in your browser. A small model takes under a minute and an SVG map a few seconds. The 3D view or the preview opens when it is done. The preview keeps up with the settings while it is open.',
  },
  {
    title: 'Download',
    text: 'Pick a format under Export and download the model. Open a Bambu Studio project with File > Open Project, then check the filaments and slice. An SVG is sized in millimetres, so check the imported size in your laser or plotter software.',
  },
];

const MODEL_TIPS = [
  'The defaults assume a 0.4 mm nozzle and 0.2 mm layers.',
  'The default scale, 0.07 mm per metre (1:14,286), keeps roads at least 0.45 mm wide, about the narrowest line a 0.4 mm nozzle prints well. A much smaller scale turns streets into lines too thin to print.',
  'Each colour is one filament. The Colours section shows how many the model needs.',
  'One Bambu AMS unit holds four filaments. The 4-Colour AMS preset keeps the model to four. With more, you need a second unit or manual filament swaps.',
  'In Bambu Studio, pick your actual filaments and recalculate the flushing volumes before slicing.',
  'A model larger than the bed can be split into sections with Multi-plate export. Each section prints on its own plate and the pieces fit together. No connectors are added.',
  'The water and the terrain are separate parts, so water can be a different colour or left out.',
  'A LiDAR only model shows the city the year it was surveyed. Glass, dark roofs and water return few points, so those spots are filled in from around them.',
  'Import a run or ride under Routes, or drop the GPX, FIT or other file on the page. It prints in its own colour, and Snap to roads moves a recording onto the streets it took.',
  'The pencil next to a route edits it on the map, and Draw a route starts a new one. Drag a point to move it or the line to add one, and with Follow roads on it goes along the streets. Click a point and Shift-click another to snap, straighten or cut out the section between them. Keys: , and . step through the points, S snaps one to a road, Delete removes it, D draws and Esc backs out.',
];

const EDIT_TIPS = [
  'Press the pencil at the top right of the 3D view to change the model before you download it. Click a building, road, path, tree or body of water to select it, or find it by name in the search box. Shift-click adds to the selection and Shift-drag selects everything in a box. The Select several tool does both without a key, and on a touch screen a tap there adds or drops one thing.',
  "Drag the arrow on a selected building or shape to change its height. Looking straight down it's hidden, so a drag there moves a shape instead. Roads and paths can be made wider or taller, and Whole street picks up every connected piece with the same name. A building mapped in parts lists them, to pick one.",
  'A click on a road picks one block of it, between the junctions where other roads meet it, so a colour or width goes on that stretch only. Split a road (X) ends a block anywhere else: click the road where it should end, and click the orange split again to join it. Make it a drawn road puts a drawn road in its place along the same line, to drag point by point.',
  'A new layer gives whatever you put in it a colour of its own. Each layer is exported as its own part with its own filament, so a racetrack or a favourite route can print in a different colour.',
  "Removing a road or building gives the ground back to the park or plaza it was cut out of. Whatever you add on the ground takes it again, and a drawn road also takes the place of the roads and paths under it. Water you leave out is filled with ground up to its banks, unless you keep its hollow.",
  'The tools on the left add text, map pins, boxes and cylinders, or draw your own roads and buildings. A drawn line starts out as a road and a drawn outline as a building. Drag a selected shape to move it and the points of a drawn one to reshape it. Tap or click a point, then Delete point, to take it out.',
  "Everything you add is built down to what it stands on, so nothing floats: the ground, a roof or bridge you raised it onto, or the bottom of the water. Letters thinner than the nozzle prints well get a warning.",
  'Edits follow the map features, not the mesh, so they stay when you change settings and generate again. A copied share link carries them too, unless there are too many.',
  'Keys while editing: V, M, X, T, P, B, C, L and A pick the tools. Delete removes the selection, F looks at it, [ and ] turn shapes and the arrow keys nudge them (with Shift for bigger steps). Ctrl+D duplicates. Ctrl+Z undoes an edit and Ctrl+Shift+Z redoes it, unless the focus is in the sidebar, where they undo settings. Enter finishes a road or outline, and Esc stops drawing or calls off a drag.',
];

const SVG_TIPS = [
  'Two lines closer together than the laser beam burn as one dark band. Set Line spacing under Line cleanup to about your beam width, or 1.5 to 2 times your pen width. The presets change it for each output.',
  'For a laser, filled areas engrave, lines score and the edge cuts. Every layer has its own colour so it can have its own process. The LightBurn layer palette puts each layer on its own LightBurn layer.',
  'For a plotter, each pen colour is a numbered layer (1 - pen #000000) that AxiDraw, vpype and saxi split on. The single-line Hershey fonts are made for pens.',
  'The preview shows how much of the road network the cleanup kept. Below 97% a warning appears, since streets were removed and not just doubled lines.',
  'The scale starts locked at 0.05 mm per metre (1:20,000), so the box on the map takes its size from the piece and the scale, and keeps that scale while you try other places or piece sizes. Unlock it under Size to size the box yourself. The piece always keeps its size.',
  'The wood preview is only a rough idea of how the fills burn. Test your settings on scrap.',
  'To draw a route in its own colour, press the route button over the preview and click the roads, paths or railways it follows. Each click adds a road or drops it again, and Along the road picks up the rest of the street. Each route is its own layer in the SVG.',
];

function StoredData() {
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void cacheSize().then((size) => live && setBytes(size));
    return () => {
      live = false;
    };
  }, []);

  async function clear() {
    await clearCache();
    setBytes(await cacheSize());
    toast('Downloaded map data cleared', 'info');
  }

  return (
    <p className="help-text">
      Downloaded map data is kept in this browser, up to {formatBytes(CACHE_LIMIT)}, and LiDAR up to another {formatBytes(LIDAR_CACHE_LIMIT)}, so an area loads faster
      the next time.{' '}
      {bytes !== null && bytes > 0 && (
        <>
          It holds {formatBytes(bytes)} right now.{' '}
          <button type="button" className="link-btn" onClick={() => void clear()}>
            Clear it
          </button>
        </>
      )}
    </p>
  );
}

export function HelpDialog() {
  const open = useApp((state) => state.ui.helpOpen);
  return (
    <Dialog open={open} onClose={() => setHelpOpen(false)} title="How it works" className="help-dialog">
      <p className="help-intro">
        Jarvizar City Model turns an area of the map into a multicolour 3D printable model, with terrain, water, parks, roads,
        buildings and trees as separate parts so every colour can be its own filament. It also makes flat SVG maps for
        laser engraving, pen plotters and print.
      </p>

      <ol className="help-steps">
        {STEPS.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{keepUnits(step.text)}</p>
          </li>
        ))}
      </ol>

      <h3 className="help-heading">3D printing tips</h3>
      <ul className="help-list">
        {MODEL_TIPS.map((tip) => (
          <li key={tip}>{keepUnits(tip)}</li>
        ))}
      </ul>

      <h3 className="help-heading">Editing a model</h3>
      <ul className="help-list">
        {EDIT_TIPS.map((tip) => (
          <li key={tip}>{keepUnits(tip)}</li>
        ))}
      </ul>

      <h3 className="help-heading">Laser, plotter and print tips</h3>
      <ul className="help-list">
        {SVG_TIPS.map((tip) => (
          <li key={tip}>{keepUnits(tip)}</li>
        ))}
      </ul>

      <h3 className="help-heading">Data and attribution</h3>
      <ul className="help-list">
        <li>
          Map data ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>{' '}
          (ODbL) and the{' '}
          <a href="https://overturemaps.org" target="_blank" rel="noreferrer">
            Overture Maps Foundation
          </a>
          .
        </li>
        <li>
          Elevation from the{' '}
          <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">
            AWS Terrain Tiles
          </a>{' '}
          open dataset (Mapzen).
        </li>
        <li>
          Basemap ©{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
            OpenFreeMap
          </a>
          ,{' '}
          <a href="https://openmaptiles.org" target="_blank" rel="noreferrer">
            OpenMapTiles
          </a>
          , OpenStreetMap contributors. Satellite imagery © Esri and its partners. SVG maps are drawn from the same OpenFreeMap vector tiles, and models take their racetracks from them since Overture has none.
        </li>
        <li>
          Title fonts for SVG maps: Montserrat, Josefin Sans, Cinzel, Oswald, Bebas Neue and Bitter, under the SIL Open Font License. The Hershey Fonts were
          originally created by Dr. A. V. Hershey while working at the U.S. National Bureau of Standards. The format of the font data was originally created
          by James Hurt, Cognition, Inc. Glyph data from{' '}
          <a href="https://github.com/techninja/hersheytextjs" target="_blank" rel="noreferrer">
            hersheytext
          </a>
          .
        </li>
        <li>
          LiDAR from USGS 3DEP (public domain, through Hobu's EPT mirror and copies at PASDA and New York State), NOAA Digital Coast, KyFromAbove, IndianaMap, the Illinois State Geological Survey, WisconsinView, DC OCTO, TxGIO, the Municipality of Anchorage, Alaska DNR, US DOT ARPA-I, IGN LiDAR HD (Licence Ouverte 2.0), NRCan
          CanElevation, LidarBC, the Gouvernement du Québec, the City of Winnipeg and GeoNB, swisstopo, AHN (Het Waterschapshuis), urban.brussels, Geobasis NRW, LVermGeo RLP, LVGL Saarland, the Bayerische Vermessungsverwaltung, GeoSN, GDI-Th, LGB Brandenburg, Geoportal Berlin, LVermGeo Sachsen-Anhalt, Land Salzburg, Land Vorarlberg, ACT Luxembourg, the Scottish
          Government, GURS Slovenia, GUGiK, Maa- ja Ruumiamet, geoEuskadi, the Gobierno de Navarra, the Ayuntamiento de Madrid, ICGC, the Province of Trento, the Comune di Genova, the Cities of Helsinki and Turku, Tokyo, Kanagawa, Yamanashi, Nagasaki and Hyogo prefectures (some through AIST 3DDB),
          São Paulo, the Intendencia de Montevideo, DAERA (Northern Ireland), Canterbury Maps, OpenTopography and{' '}
          <a href="https://github.com/flai-ai/open-lidar-data" target="_blank" rel="noreferrer">
            Open LiDAR Data
          </a>{' '}
          by Flai, each under its own open licence. The surveys a model used, and the credit each asks for, are listed in its details and in
          exported 3MF files.
        </li>
        <li>Place search by Photon from komoot, using OpenStreetMap data.</li>
        <li>
          Licenses of the code the site bundles are in{' '}
          <a href="licenses.md" target="_blank" rel="noreferrer">
            licenses.md
          </a>{' '}
          and, for the LAZ decoder,{' '}
          <a href="laz-decoder-notices.md" target="_blank" rel="noreferrer">
            laz-decoder-notices.md
          </a>
          .
        </li>
        <li>
          If you share or sell prints, credit OpenStreetMap contributors and Overture Maps Foundation for a model made from map data, and any LiDAR survey the
          model used. Credit OpenStreetMap contributors on anything made from an SVG map.
        </li>
      </ul>

      <h3 className="help-heading">Privacy</h3>
      <p className="help-text">
        Everything runs in your browser. There is no account and no server of ours: map data, elevation, LiDAR and map
        tiles are downloaded straight from their public sources. Place search sends what you type to Photon (photon.komoot.io). Your
        settings, and any font you load for a title, are saved in this browser only.
      </p>
      {open && <StoredData />}

      <p className="help-footer">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-sm">
          <GithubMark size={15} />
          Source code and issues on GitHub
        </a>
      </p>
    </Dialog>
  );
}
