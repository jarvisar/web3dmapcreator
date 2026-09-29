// The generated SVG map. While it's on screen it renders again whenever the
// settings change, the way SVGmap's preview did.
import { Info, Maximize, Minus, Plus, TriangleAlert, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { OutputGroup, RenderResult } from '../../core/svgmap/result';
import type { ElementId } from '../../core/svgmap/settings';
import { Segmented } from '../components/Segmented';
import { ToolButton } from '../components/ToolButton';
import { COARSE_QUERY, useMediaQuery } from '../lib/browser';
import { formatBytes, formatInteger, formatNumber, formatSeconds } from '../lib/format';
import { type PreviewLook, setPreviewLook, useApp } from '../state/store';
import { renderSvgNow, svgProblem, useSvgKey } from './actions';
import { renderFraction, useSvgRender } from './render';

// The part of the piece in view, in mm. The height follows the stage.
interface Box {
  x: number;
  y: number;
  w: number;
}

type Point = [number, number];

const WOOD = '#E8D2AC';
const BURN = '#3A2415';
// Rough darkness of each fill in the wood preview, since each gets its own process.
const BURN_OPACITY: Partial<Record<ElementId, number>> = {
  buildings: 0.92,
  text: 0.95,
  band: 0.95,
  water: 0.7,
  aeroways: 0.6,
  rocks: 0.5,
  greens: 0.38,
  sand: 0.25,
  decks: 0.3,
};

function groupPaint(group: OutputGroup, result: RenderResult, look: PreviewLook) {
  const laserMaterial = result.mode === 'laser' && look === 'material';
  if (group.id === 'cut') {
    return {
      fill: 'none',
      stroke: laserMaterial ? 'rgba(0,0,0,0.35)' : group.color,
      strokeWidth: laserMaterial ? 0.3 : Math.max(group.strokeWidth, 0.12),
    };
  }
  if (group.kind === 'fill') {
    return laserMaterial ? { fill: BURN, fillOpacity: BURN_OPACITY[group.element] ?? 0.8, stroke: 'none' } : { fill: group.color, stroke: 'none' };
  }
  const width = result.mode === 'laser' ? 0.12 : group.strokeWidth;
  return laserMaterial
    ? { fill: 'none', stroke: BURN, strokeOpacity: 0.85, strokeWidth: width }
    : { fill: 'none', stroke: group.color, strokeWidth: width };
}

const PreviewContent = memo(function PreviewContent(props: { result: RenderResult; look: PreviewLook }) {
  const { result, look } = props;
  const background = result.mode === 'laser' ? (look === 'material' ? WOOD : '#fff') : (result.background ?? '#fff');
  return (
    <g>
      <path d={result.outline} fill={background} />
      {result.groups.map((group) => {
        const paint = groupPaint(group, result, look);
        return (
          <g key={group.id} {...paint} strokeLinecap="round" strokeLinejoin="round">
            {group.paths.map((p, i) => (
              <path key={i} d={p.d} strokeWidth={p.strokeWidth} />
            ))}
          </g>
        );
      })}
    </g>
  );
});

// Centre of the touching pointers and their average distance from it.
function spread(points: Map<number, Point>): [Point, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of points.values()) {
    x += px / points.size;
    y += py / points.size;
  }
  let distance = 0;
  for (const [px, py] of points.values()) distance += Math.hypot(px - x, py - y) / points.size;
  return [[x, y], distance];
}

const clampWidth = (w: number) => Math.min(Math.max(w, 2), 5000);

// Follows the settings while the preview is open, a moment after they stop
// changing. A render that failed or was cancelled waits for the next change.
function useLiveRender() {
  const key = useSvgKey();
  const resultKey = useSvgRender((state) => state.resultKey);
  const triedKey = useSvgRender((state) => state.triedKey);
  const problem = useApp((state) => svgProblem(state.area, state.svg));
  useEffect(() => {
    if (problem || key === resultKey || key === triedKey) return;
    const timer = setTimeout(renderSvgNow, 350);
    return () => clearTimeout(timer);
  }, [key, resultKey, triedKey, problem]);
  return key !== resultKey;
}

function Banner({ stale }: { stale: boolean }) {
  const working = useSvgRender((state) => state.status === 'working');
  const progress = useSvgRender((state) => state.progress);
  const error = useSvgRender((state) => state.error);
  if (working) {
    const counted = progress?.total ? ` ${progress.done ?? 0} of ${progress.total}` : '';
    return (
      <div className="banner floating">
        <span className="spinner" aria-hidden="true" />
        <span>{progress ? `${progress.message}${counted}` : 'Updating'}</span>
        <span className="banner-muted">{Math.round(renderFraction(progress) * 100)}%</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="banner floating banner-error" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        <span>{error}</span>
      </div>
    );
  }
  if (!stale) return null;
  return (
    <div className="banner floating">
      <span>Settings changed since this SVG was made.</span>
    </div>
  );
}

type Card = 'info' | 'warnings' | null;

export function SvgPreview() {
  const result = useSvgRender((state) => state.result);
  const look = useApp((state) => state.ui.previewLook);
  const coarse = useMediaQuery(COARSE_QUERY);
  const stale = useLiveRender();
  const [box, setBox] = useState<Box | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [card, setCard] = useState<Card>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Pointers down on the stage, in stage pixels. Dragging and pinching both
  // work from where the gesture started, so they don't drift.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ box: Box; start: Map<number, Point> } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!result || size.w === 0) return;
    // Leave room for the chips and toolbar above and the hint below.
    const scale = Math.min(size.w / (result.width * 1.12), (size.h - 100) / (result.height * 1.08));
    const w = size.w / scale;
    const h = size.h / scale;
    setBox({ x: result.width / 2 - w / 2, y: result.height / 2 - h / 2, w });
  }, [result, size]);

  // Only refit when the piece or the view changes size, so tweaking a setting keeps the zoom.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const shapeKey = result ? `${result.width}x${result.height}` : '';
  useEffect(() => fitRef.current(), [shapeKey, size.w, size.h]);

  // A new result can bring different warnings.
  useEffect(() => setCard((current) => (current === 'warnings' ? null : current)), [result]);

  // Zooms by factor, keeping the point at (px, py) on the stage still.
  const zoomAt = (px: number, py: number, factor: number) => {
    if (!box || size.w === 0) return;
    const w = clampWidth(box.w * factor);
    const before = box.w / size.w;
    const after = w / size.w;
    setBox({ x: box.x + px * (before - after), y: box.y + py * (before - after), w });
  };

  const stagePoint = (e: React.PointerEvent | React.WheelEvent): Point => {
    const rect = ref.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const restart = () => {
    gesture.current = box && pointers.current.size > 0 ? { box, start: new Map(pointers.current) } : null;
    setDragging(pointers.current.size > 0);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!box) return;
    try {
      // Keeps the drag going outside the stage. Throws if the pointer is already gone.
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    pointers.current.set(e.pointerId, stagePoint(e));
    restart();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId) || size.w === 0) return;
    pointers.current.set(e.pointerId, stagePoint(e));
    const [c0, d0] = spread(g.start);
    const [c1, d1] = spread(pointers.current);
    const w = clampWidth(d0 > 0 && d1 > 0 ? (g.box.w * d0) / d1 : g.box.w);
    // Keep the spot under the fingers' centre under it.
    const k0 = g.box.w / size.w;
    const k1 = w / size.w;
    setBox({ x: g.box.x + c0[0] * k0 - c1[0] * k1, y: g.box.y + c0[1] * k0 - c1[1] * k1, w });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    restart();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!box || size.w === 0) return;
    const step = box.w / 10;
    const pan: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (pan[e.key]) setBox({ ...box, x: box.x + pan[e.key][0], y: box.y + pan[e.key][1] });
    else if (e.key === '+' || e.key === '=') zoomAt(size.w / 2, size.h / 2, 1 / 1.5);
    else if (e.key === '-' || e.key === '_') zoomAt(size.w / 2, size.h / 2, 1.5);
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
  };

  const h = box ? (box.w * size.h) / Math.max(size.w, 1) : 0;
  const paths = result ? result.groups.reduce((n, g) => n + g.subpaths, 0) : 0;
  const km = (m: number) => formatNumber(m / 1000, 2);
  const totalMs = result ? Object.values(result.stats.timings).reduce((sum, value) => sum + value, 0) : 0;
  const plotter = result?.stats.plotter;
  const infoRows: [string, string][] = result
    ? [
        ['Size', `${formatNumber(result.width, 1)} × ${formatNumber(result.height, 1)} mm`],
        ['Scale', `1:${formatInteger(result.meta.scale)}`],
        ['Map area', `${km(result.meta.widthM)} × ${km(result.meta.heightM)} km`],
        ['Paths', formatInteger(paths)],
        ...(result.stats.coverage !== null ? [['Roads kept', `${formatNumber(result.stats.coverage * 100, 1)}%`] as [string, string]] : []),
        ...(plotter
          ? ([
              ['Pens', String(plotter.pens)],
              ['Drawn', `${formatNumber(plotter.penDownMm / 1000, 1)} m`],
              ['Pen-up travel', `${formatNumber(plotter.penUpMm / 1000, 1)} m, ${formatNumber(plotter.penUpUnorderedMm / 1000, 1)} m unordered`],
            ] as [string, string][])
          : []),
        ['Map data', `${result.stats.tiles} ${result.stats.tiles === 1 ? 'tile' : 'tiles'} at zoom ${result.stats.zoom}, ${formatBytes(result.stats.bytes)}`],
        ...(totalMs > 0 ? [['Drawn in', formatSeconds(totalMs / 1000)] as [string, string]] : []),
      ]
    : [];

  return (
    <div className="svg-preview" role="region" aria-label="SVG preview">
      <div
        ref={ref}
        className={`svg-stage${dragging ? ' is-dragging' : ''}`}
        role="img"
        tabIndex={result ? 0 : -1}
        aria-label={
          result
            ? `Preview of the SVG map, ${formatNumber(result.width, 1)} by ${formatNumber(result.height, 1)} mm. Arrow keys move it, plus and minus zoom, 0 fits it.`
            : 'SVG preview'
        }
        onKeyDown={onKeyDown}
        onWheel={(e) => zoomAt(...stagePoint(e), Math.exp(e.deltaY * 0.0015))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={fit}
      >
        {result && box && (
          <svg viewBox={`${box.x} ${box.y} ${box.w} ${h}`} preserveAspectRatio="xMidYMid meet">
            <PreviewContent result={result} look={look} />
          </svg>
        )}
      </div>

      {result && (
        <div className="viewer-overlay viewer-top-left">
          <div className="chip floating" title="Width × height of the piece">
            <span className="chip-strong">
              {formatNumber(result.width, 1)} × {formatNumber(result.height, 1)} mm
            </span>
            <span className="chip-muted">1:{formatInteger(result.meta.scale)}</span>
          </div>
          {result.warnings.length > 0 && (
            <button type="button" className="chip chip-warning floating" aria-expanded={card === 'warnings'} onClick={() => setCard(card === 'warnings' ? null : 'warnings')}>
              <TriangleAlert size={14} aria-hidden="true" />
              {result.warnings.length === 1 ? '1 warning' : `${result.warnings.length} warnings`}
            </button>
          )}
          {card === 'warnings' && (
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
          <div className="toolbar floating" role="toolbar" aria-label="Preview">
            <ToolButton label="Zoom in" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.5)}>
              <Plus size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Zoom out" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.5)}>
              <Minus size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Fit the whole piece" onClick={fit}>
              <Maximize size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="SVG details" pressed={card === 'info'} onClick={() => setCard(card === 'info' ? null : 'info')}>
              <Info size={15} aria-hidden="true" />
            </ToolButton>
          </div>
          {result.mode === 'laser' && (
            <Segmented<PreviewLook>
              label="Preview colours"
              size="sm"
              className="floating preview-look"
              value={look}
              onChange={setPreviewLook}
              options={[
                { value: 'material', label: 'Wood', title: 'Roughly how the fills burn into wood' },
                { value: 'colors', label: 'Colours', title: 'The layer colours in the file' },
              ]}
            />
          )}
          {card === 'info' && (
            <section className="viewer-card floating info-card" aria-label="SVG details">
              <header className="viewer-card-header">
                <h3>SVG details</h3>
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Close details" onClick={() => setCard(null)}>
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

      <div className="viewer-overlay viewer-banner">
        <Banner stale={stale} />
      </div>

      {result && (
        <div className="viewer-hint">{coarse ? 'Drag to move · Pinch to zoom' : 'Drag to move · Scroll to zoom · Double-click to fit'}</div>
      )}
      {!result && (
        <div className="viewer-empty">
          <span className="spinner spinner-lg" aria-hidden="true" />
          <p>Drawing your map</p>
        </div>
      )}
    </div>
  );
}
