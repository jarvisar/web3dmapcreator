import { useEffect, useRef, useState } from 'react';
import { resetAllSettings, setHelpOpen, toast } from '../state/store';
import { AreaPanel } from './AreaPanel';
import { ColoursPanel } from './ColoursPanel';
import { ExportPanel } from './ExportPanel';
import { LayersPanel } from './LayersPanel';
import { PrintPanel } from './PrintPanel';

function ResetAll() {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`link-btn${confirming ? ' is-danger' : ''}`}
      onClick={() => {
        if (!confirming) {
          setConfirming(true);
          timer.current = window.setTimeout(() => setConfirming(false), 4000);
          return;
        }
        window.clearTimeout(timer.current);
        setConfirming(false);
        resetAllSettings();
        toast('Settings, colours and export options are back to their defaults', 'info');
      }}
    >
      {confirming ? 'Click again to reset everything but the area' : 'Reset all settings'}
    </button>
  );
}

export function Sidebar() {
  return (
    <div className="sidebar-scroll">
      <AreaPanel />
      <PrintPanel />
      <LayersPanel />
      <ColoursPanel />
      <ExportPanel />
      <footer className="sidebar-footer">
        <div className="sidebar-links">
          <ResetAll />
          <button type="button" className="link-btn" onClick={() => setHelpOpen(true)}>
            Help and attribution
          </button>
        </div>
        <p className="attribution">
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors (ODbL) and{' '}
          <a href="https://overturemaps.org" target="_blank" rel="noreferrer">
            Overture Maps Foundation
          </a>
          . Elevation from the AWS Terrain Tiles open dataset (Mapzen). Basemap © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.
        </p>
      </footer>
    </div>
  );
}
