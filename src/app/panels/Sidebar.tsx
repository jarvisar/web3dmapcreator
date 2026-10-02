import { Box, PenTool } from 'lucide-react';
import { ConfirmButton } from '../components/ConfirmButton';
import { Segmented } from '../components/Segmented';
import { resetAllSettings, setHelpOpen, setOutput, toast, useApp } from '../state/store';
import { asChange, undoChange } from '../state/undo';
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
import { RoutesPanel } from './RoutesPanel';
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
  return (
    <ConfirmButton
      className="link-btn"
      confirmingClass="is-danger"
      confirm="Click again to reset everything but the area and your edits"
      onConfirm={() => {
        const step = asChange('Reset settings', resetAllSettings);
        toast('Settings, colours and export options are back to their defaults', 'info', step ? { label: 'Undo', run: () => undoChange(step) } : undefined);
      }}
    >
      Reset all settings
    </ConfirmButton>
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
          <RoutesPanel />
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
          . Elevation from the AWS Terrain Tiles open dataset (Mapzen). Basemap, SVG map and racetrack tiles © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.
          {output === 'svg' && ' Credit OpenStreetMap on anything you publish or sell.'}
        </p>
      </footer>
    </div>
  );
}
