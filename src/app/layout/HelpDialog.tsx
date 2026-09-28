import { Dialog } from '../components/Dialog';
import { GithubMark } from '../components/Icons';
import { keepUnits } from '../lib/format';
import { setHelpOpen, useApp } from '../state/store';
import { REPO_URL } from './TopBar';

const STEPS = [
  {
    title: 'Choose an area',
    text: 'Search for a place, pick a preset, or drag the box on the map. Drag a corner to resize it and the round handle to rotate it.',
  },
  {
    title: 'Set the size and layers',
    text: 'Check the printed size under Print size and pick your printer. Turn layers such as bridges or trees on or off, and choose colours.',
  },
  {
    title: 'Generate the model',
    text: 'Map data and elevation are downloaded and the model is built in your browser. Small areas take under a minute. The 3D view opens when it is done.',
  },
  {
    title: 'Download and slice',
    text: 'Pick a format under Export and download. Open a Bambu Studio project with File > Open Project, then check the filaments and slice.',
  },
];

const TIPS = [
  'The defaults assume a 0.4 mm nozzle and 0.2 mm layers.',
  'The default scale, 0.07 mm per metre (1:14,286), keeps roads at least 0.45 mm wide, about the narrowest line a 0.4 mm nozzle prints well. A much smaller scale turns streets into lines too thin to print.',
  'Each colour is one filament. The Colours section shows how many the model needs.',
  'One Bambu AMS unit holds four filaments. The 4-Colour AMS preset keeps the model to four. With more, you need a second unit or manual filament swaps.',
  'In Bambu Studio, pick your actual filaments and recalculate the flushing volumes before slicing.',
  'A model larger than the bed can be split into sections with Multi-plate export. Each section prints on its own plate and the pieces fit together. No connectors are added.',
  'The water and the terrain are separate parts, so water can be a different colour or left out.',
];

export function HelpDialog() {
  const open = useApp((state) => state.ui.helpOpen);
  return (
    <Dialog open={open} onClose={() => setHelpOpen(false)} title="How it works" className="help-dialog">
      <p className="help-intro">
        Jarvizar City Model turns an area of the map into a multicolour 3D printable model: terrain, water, parks, roads,
        buildings and trees, each as its own part so every colour can be its own filament.
      </p>

      <ol className="help-steps">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <span className="help-step-number" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <h3>{step.title}</h3>
              <p>{keepUnits(step.text)}</p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className="help-heading">Printing tips</h3>
      <ul className="help-list">
        {TIPS.map((tip) => (
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
          , OpenStreetMap contributors. Satellite imagery © Esri and its partners.
        </li>
        <li>Place search by Photon from komoot, using OpenStreetMap data.</li>
        <li>If you share or sell prints, credit OpenStreetMap contributors and Overture Maps Foundation.</li>
      </ul>

      <h3 className="help-heading">Privacy</h3>
      <p className="help-text">
        Everything runs in your browser. There is no account and no server of ours: map data, elevation and map tiles are
        downloaded straight from their public sources. Place search sends what you type to Photon (photon.komoot.io). Your
        settings are saved in this browser only.
      </p>

      <p className="help-footer">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
          <GithubMark size={15} />
          Source code and issues on GitHub
        </a>
      </p>
    </Dialog>
  );
}
