import { Box, PenTool } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Segmented } from '../components/Segmented';
import { resetAllSettings, setHelpOpen, setOutput, toast, useApp } from '../state/store';
import { CleanupPanel } from '../svgmap/CleanupPanel';
import { DataPanel } from '../svgmap/DataPanel';
import { LayersPanel as SvgLayersPanel } from '../svgmap/LayersPanel';
import { OutputPanel } from '../svgmap/OutputPanel';
import { SizePanel } from '../svgmap/SizePanel';
import { TitlePanel } from '../svgmap/TitlePanel';
import { AreaPanel } from './AreaPanel';
import { ColoursPanel } from './ColoursPanel';
import { ExportPanel } from './ExportPanel';
import { LayersPanel } from './LayersPanel';
import { PrintPanel } from './PrintPanel';
import { OptionsFiles } from './OptionsFiles';

function OutputSwitch() {
  const output = useApp((state) => state.output);
  return (
    <div className="output-switch">
      <Segmented
        label="What to make"
        value={output}
        stretch
        onChange={setOutput}
        options={[
          {
            value: 'model',
            label: (
              <>
                <Box size={15} aria-hidden="true" />
                <span>3D model</span>
              </>
            ),
          },
          {
            value: 'svg',
            label: (
              <>
                <PenTool size={15} aria-hidden="true" />
                <span>SVG map</span>
              </>
            ),
          },
        ]}
      />
      <p className="output-note">
        {output === 'model'
          ? 'A multicolour model for FDM printing, as a 3MF project or STL.'
          : 'A flat map for laser engraving, pen plotters or print, as an SVG.'}
      </p>
    </div>
  );
}

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
      {confirming ? 'Click again to reset everything but the area and your edits' : 'Reset all settings'}
    </button>
  );
}

export function Sidebar() {
  const output = useApp((state) => state.output);
  return (
    <div className="sidebar-scroll">
      <OutputSwitch />
      <AreaPanel />
      {output === 'model' ? (
        <>
          <PrintPanel />
          <LayersPanel />
          <ColoursPanel />
          <ExportPanel />
        </>
      ) : (
        <>
          <SizePanel />
          <OutputPanel />
          <SvgLayersPanel />
          <TitlePanel />
          <CleanupPanel />
          <DataPanel />
        </>
      )}
      <footer className="sidebar-footer">
        <OptionsFiles />
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
          . Elevation from the AWS Terrain Tiles open dataset (Mapzen). Basemap and SVG map tiles © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.
          {output === 'svg' && ' Credit OpenStreetMap on anything you publish or sell.'}
        </p>
      </footer>
    </div>
  );
}
