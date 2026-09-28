import {
  Camera,
  Grid2x2,
  Info,
  Layers,
  RefreshCw,
  RotateCcw,
  SquareDashed,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { printerByKey } from '../../core/settings';
import { ROLE_GROUP } from '../../core/types';
import { Tooltip } from '../components/HelpTip';
import { COARSE_QUERY, DARK_QUERY, downloadBlob, prefersDark, useMediaQuery } from '../lib/browser';
import { formatCount, formatMm, formatRatio, formatSeconds, capitalise } from '../lib/format';
import { generateModel } from '../state/actions';
import { fileBase, generationProblem } from '../state/derived';
import { getModelParts } from '../state/model';
import { setHiddenParts, setShowBed, toast, togglePartHidden, useApp } from '../state/store';
import { ViewerEngine } from './ViewerEngine';

function ToolButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="tool-btn"
        aria-label={label}
        aria-pressed={pressed}
        onClick={() => {
          setHover(false);
          onClick();
        }}
        onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={(event) => event.currentTarget.matches(':focus-visible') && setHover(true)}
        onBlur={() => setHover(false)}
      >
        {children}
      </button>
      <Tooltip anchor={anchor} open={hover} placement="bottom">
        {label}
      </Tooltip>
    </>
  );
}

type Panel = 'parts' | 'info' | 'warnings' | null;

// Its own component, so progress updates don't re-render the whole viewer.
function Banner() {
  const running = useApp((state) => state.generation.status === 'running');
  const label = useApp((state) => state.generation.progress?.label ?? 'Starting');
  const percent = useApp((state) => Math.round((state.generation.progress?.fraction ?? 0) * 100));
  const problem = useApp((state) => generationProblem(state.area, state.settings));
  const exporting = useApp((state) => state.exporting.status === 'running');
  if (running) {
    return (
      <div className="banner floating">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
        <span className="banner-muted">{percent}%</span>
      </div>
    );
  }
  return (
    <div className="banner floating">
      <span>Settings changed since this model was made.</span>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={problem !== null || exporting}
        title={problem ?? (exporting ? 'Wait for the download to finish' : undefined)}
        onClick={() => void generateModel()}
      >
        <RefreshCw size={14} aria-hidden="true" />
        Regenerate
      </button>
    </div>
  );
}

export default function ModelView({ active }: { active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const [lost, setLost] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const result = useApp((state) => state.generation.result);
  const running = useApp((state) => state.generation.status === 'running');
  const stale = useApp((state) => state.generation.stale);
  const palette = useApp((state) => state.palette);
  const hidden = useApp((state) => state.ui.hiddenParts);
  const showBed = useApp((state) => state.ui.showBed);
  const printerKey = useApp((state) => state.exportSettings.printer);
  const dark = useMediaQuery(DARK_QUERY);
  const coarse = useMediaQuery(COARSE_QUERY);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: ViewerEngine;
    try {
      engine = new ViewerEngine(host, { onContextLost: setLost });
    } catch {
      setLost(true);
      return;
    }
    engineRef.current = engine;
    const state = useApp.getState();
    engine.setTheme(prefersDark());
    engine.setPalette(state.palette);
    engine.setHidden(state.ui.hiddenParts);
    engine.setBed(printerByKey(state.exportSettings.printer), state.ui.showBed);
    const current = state.generation.result;
    if (current) engine.setModel(getModelParts(), current.bounds);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const version = result?.version;
  useEffect(() => {
    const current = useApp.getState().generation.result;
    if (current && engineRef.current) engineRef.current.setModel(getModelParts(), current.bounds);
    // A card from the last model (its warnings, say) may not apply to this one.
    setPanel(null);
  }, [version]);

  useEffect(() => engineRef.current?.setPalette(palette), [palette]);
  useEffect(() => engineRef.current?.setHidden(hidden), [hidden]);
  useEffect(() => engineRef.current?.setBed(printerByKey(printerKey), showBed), [printerKey, showBed]);
  useEffect(() => engineRef.current?.setTheme(dark), [dark]);
  useEffect(() => {
    if (active) engineRef.current?.resize();
  }, [active]);

  async function screenshot() {
    const blob = await engineRef.current?.screenshot();
    if (!blob) {
      toast('Could not take a screenshot', 'error');
      return;
    }
    const state = useApp.getState();
    downloadBlob(blob, `${fileBase(state.placeName, state.fileName)}.png`);
  }

  const size = result
    ? { w: result.bounds[3] - result.bounds[0], d: result.bounds[4] - result.bounds[1], h: result.bounds[5] - result.bounds[2] }
    : null;
  const stats = result ? Object.entries(result.stats).filter(([, value]) => value !== '' && value !== null) : [];
  const totalTime = result ? Object.values(result.timings).reduce((sum, value) => sum + value, 0) : 0;
  const allHidden = result ? result.parts.every((part) => hidden.includes(part.id)) : false;
  const infoRows: [string, string][] = result
    ? [
        ['Scale', `${formatRatio(result.mmPerMetre)}, ${Number(result.mmPerMetre.toFixed(4))} mm per metre`],
        ['Triangles', formatCount(result.triangles)],
        ['Parts', String(result.parts.length)],
        ...stats.map(([key, value]): [string, string] => [
          capitalise(key.replace(/_/g, ' ')),
          typeof value === 'number' ? formatCount(value) : String(value),
        ]),
        ...(result.release ? [['Map data', `Overture ${result.release}`] as [string, string]] : []),
        ...(result.lidar
          ? ([
              ['LiDAR', `${formatCount(result.lidar.measured)} of ${formatCount(result.lidar.candidates)} buildings measured`],
              ...result.lidar.surveys.map((s): [string, string] => [`Survey`, `${s.name} (${s.attribution}), ${formatCount(s.buildings)} buildings`]),
            ] as [string, string][])
          : []),
        ...(totalTime > 0 ? [['Generated in', formatSeconds(totalTime)] as [string, string]] : []),
      ]
    : [];

  return (
    <div className={`viewer${lost ? ' is-lost' : ''}`} aria-hidden={!active} inert={!active}>
      <div ref={hostRef} className="viewer-host" role="img" aria-label="3D preview of the generated model" />

      {result && size && (
        <div className="viewer-overlay viewer-top-left">
          <div className="chip floating" title="Printed width × depth × height">
            <span className="chip-strong">
              {formatMm(size.w)} × {formatMm(size.d)} × {formatMm(size.h)} mm
            </span>
            <span className="chip-muted">{formatRatio(result.mmPerMetre)}</span>
          </div>
          {result.warnings.length > 0 && (
            <button type="button" className="chip chip-warning floating" aria-expanded={panel === 'warnings'} onClick={() => setPanel(panel === 'warnings' ? null : 'warnings')}>
              <TriangleAlert size={14} aria-hidden="true" />
              {result.warnings.length === 1 ? '1 warning' : `${result.warnings.length} warnings`}
            </button>
          )}
          {panel === 'warnings' && (
            <div className="viewer-card floating">
              <ul className="warning-list">
                {result.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="viewer-overlay viewer-top-right">
          <div className="toolbar floating" role="toolbar" aria-label="View">
            <ToolButton label="Reset view" onClick={() => engineRef.current?.resetView()}>
              <RotateCcw size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="View from above" onClick={() => engineRef.current?.topView()}>
              <SquareDashed size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label={showBed ? 'Hide print bed' : 'Show print bed'} pressed={showBed} onClick={() => setShowBed(!showBed)}>
              <Grid2x2 size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Parts" pressed={panel === 'parts'} onClick={() => setPanel(panel === 'parts' ? null : 'parts')}>
              <Layers size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Model details" pressed={panel === 'info'} onClick={() => setPanel(panel === 'info' ? null : 'info')}>
              <Info size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Save screenshot" onClick={screenshot}>
              <Camera size={15} aria-hidden="true" />
            </ToolButton>
          </div>

          {panel === 'parts' && (
            <section className="viewer-card floating parts-card" aria-label="Parts">
              <header className="viewer-card-header">
                <h3>Parts</h3>
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Close parts" onClick={() => setPanel(null)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </header>
              <ul className="parts-list">
                {result.parts.map((part) => {
                  const visible = !hidden.includes(part.id);
                  return (
                    <li key={part.id}>
                      <label className="part-row">
                        <input type="checkbox" className="checkbox" checked={visible} onChange={() => togglePartHidden(part.id)} />
                        <span className="dot" style={{ background: palette[ROLE_GROUP[part.role]].hex }} aria-hidden="true" />
                        <span className="part-name">{part.name}</span>
                        <span className="part-count">{formatCount(part.triangles)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <footer className="viewer-card-footer">
                <span>Hidden parts are left out of the download.</span>
                {hidden.length > 0 && (
                  <button type="button" className="link-btn" onClick={() => setHiddenParts([])}>
                    Show all
                  </button>
                )}
              </footer>
            </section>
          )}

          {panel === 'info' && (
            <section className="viewer-card floating info-card" aria-label="Model details">
              <header className="viewer-card-header">
                <h3>Model details</h3>
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Close details" onClick={() => setPanel(null)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </header>
              <dl className="info-list">
                {infoRows.map(([key, value]) => (
                  <div className="info-pair" key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      )}

      {result && (stale || running) && (
        <div className="viewer-overlay viewer-banner">
          <Banner />
        </div>
      )}

      {result && allHidden && (
        <div className="viewer-empty">
          <p>Every part is hidden.</p>
          <button type="button" className="btn btn-sm" onClick={() => setHiddenParts([])}>
            Show all parts
          </button>
        </div>
      )}

      {result && !coarse && <div className="viewer-hint">Drag to orbit · Right-drag to pan · Scroll to zoom</div>}
      {result && coarse && <div className="viewer-hint">Drag to orbit · Pinch to zoom · Two fingers to pan</div>}

      {!result && (
        <div className="viewer-empty">
          <span className="spinner spinner-lg" aria-hidden="true" />
          <p>Building your model</p>
        </div>
      )}

      {lost && (
        <div className="viewer-lost">
          <div className="viewer-card floating">
            <h3>The 3D view stopped</h3>
            <p>
              The browser reset the graphics, often because memory ran low. It usually comes back by itself. Reloading
              keeps your settings, but the model has to be generated again.
            </p>
            <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
              Reload the page
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
