// The generated SVG map. While it's on screen it renders again whenever the
// settings change, the way SVGmap's preview did.
import { Info, Maximize, Minus, Plus, Route, TriangleAlert, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OutputGroup, RenderResult } from '../../core/svgmap/result';
import type { ElementId } from '../../core/svgmap/settings';
import { fmt, polylineD } from '../../core/svgmap/svg/format';
import { shapePathD } from '../../core/svgmap/layout/shapes';
import type { LabelArtwork, LabelSettings } from '../../core/svgmap/text/label';
import { geometryBounds } from '../../core/svgmap/text/outline';
import { CheckField } from '../components/Fields';
import { Segmented } from '../components/Segmented';
import { ToolButton } from '../components/ToolButton';
import { COARSE_QUERY, useMediaQuery } from '../lib/browser';
import { formatBytes, formatInteger, formatNumber, formatSeconds } from '../lib/format';
import { type PreviewLook, setLabel, setPreviewLook, useApp } from '../state/store';
import { renderSvgNow, svgProblem, useSvgKey } from './actions';
import { useLabelArtwork } from './labelArtwork';
import {
  type HandleSpot,
  AUTOFIT_HELP,
  RESET_OFFSET,
  type TitleDrag,
  type TitleGrip,
  boxResized,
  dragTitle,
  droppedLabel,
  handleAt,
  labelMoved,
  resizeCursor,
  spacedHandles,
  titleAt,
  titleHandles,
} from './labelDrag';
import { pieceLayout } from './piece';
import { renderFraction, useSvgRender } from './render';
import { PickIndex, PickOverlay, RouteCard } from './RoutePicker';

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

const backgroundOf = (result: RenderResult, look: PreviewLook) =>
  result.mode === 'laser' ? (look === 'material' ? WOOD : '#fff') : (result.background ?? '#fff');

const isTitle = (group: OutputGroup) => group.element === 'text' || group.element === 'frame';

// hideTitle leaves the title out while a moved one is drawn over the result.
const PreviewContent = memo(function PreviewContent(props: { result: RenderResult; look: PreviewLook; hideTitle: boolean }) {
  const { result, look, hideTitle } = props;
  return (
    <g>
      <path d={result.outline} fill={backgroundOf(result, look)} />
      {result.groups.map((group) => {
        if (hideTitle && isTitle(group)) return null;
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

// The title laid out on the main thread, drawn while it's dragged and until
// the render with it in its new place comes back. Fills are drawn solid even
// when the file hatches them. A band covers the map only inside the window,
// or it painted over the border at its ends.
function TitleGhost(props: { artwork: LabelArtwork; style: LabelSettings['style']; result: RenderResult; look: PreviewLook; windowD: string | null }) {
  const { artwork, style, result, look, windowD } = props;
  const material = result.mode === 'laser' && look === 'material';
  const ink = (element: ElementId) => (material ? BURN : (result.groups.find((g) => g.element === element)?.color ?? '#222'));
  const [x, y, w, h] = artwork.knockout;
  const rings = artwork.text.rings.map((ring) => polylineD(ring, true)).join('');
  const strokes = artwork.text.strokes.map((stroke) => polylineD(stroke)).join('');
  const band = style === 'band' && windowD;
  return (
    <g pointerEvents="none">
      {band && (
        <clipPath id="preview-title-window">
          <path d={windowD} />
        </clipPath>
      )}
      {(style === 'box' || band) && (
        <rect x={fmt(x)} y={fmt(y)} width={fmt(w)} height={fmt(h)} fill={backgroundOf(result, look)} clipPath={band ? 'url(#preview-title-window)' : undefined} />
      )}
      {artwork.frame.map((segment, i) => (
        <path key={i} d={polylineD(segment)} fill="none" stroke={ink('frame')} strokeWidth={Math.max(artwork.frameWidth, 0.1)} />
      ))}
      {rings && <path d={rings} fill={ink('text')} />}
      {strokes && <path d={strokes} fill="none" stroke={ink('text')} strokeWidth={0.3} strokeLinecap="round" strokeLinejoin="round" />}
    </g>
  );
}

// Handles in screen pixels, and how far from one a press still takes it.
// Fingers get further.
const HANDLE_SIZE = 9;
const HANDLE_GAP = 18;
const HANDLE_REACH = 9;
const HANDLE_REACH_TOUCH = 16;

// The outline of the title under the pointer or selected, with its handles
// when selected. unit is millimetres per screen pixel.
function TitleFrame(props: { artwork: LabelArtwork; label: LabelSettings; handles: HandleSpot[]; selected: boolean; unit: number }) {
  const { artwork, label, handles, selected, unit } = props;
  const [x, y, w, h] = artwork.knockout;
  const text = label.style === 'band' && handles.length > 1 ? geometryBounds(artwork.text) : null;
  const s = HANDLE_SIZE * unit;
  return (
    <g pointerEvents="none">
      <rect className={selected ? 'title-frame' : 'title-grab'} x={fmt(x)} y={fmt(y)} width={fmt(w)} height={fmt(h)} />
      {text && <rect className="title-grab" x={fmt(text[0])} y={fmt(text[1])} width={fmt(text[2] - text[0])} height={fmt(text[3] - text[1])} />}
      {handles.map((handle) => (
        <rect key={handle.id} className="title-handle" data-handle={handle.id} x={fmt(handle.x - s / 2)} y={fmt(handle.y - s / 2)} width={fmt(s)} height={fmt(s)} />
      ))}
    </g>
  );
}

function TitleCard({ label, onClose }: { label: LabelSettings; onClose: () => void }) {
  const box = label.style === 'box';
  const resized = boxResized(label);
  const moved = labelMoved(label);
  return (
    <section className="viewer-card floating inspector" aria-label="Title">
      <header className="viewer-card-header">
        <h3>Title</h3>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Let go of the title" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="inspector-body">
        <p className="inspector-intro">
          {box
            ? 'Drag the title to move it, a corner to resize it, or a side to resize the box.'
            : label.autofit
              ? 'Drag the text to move it, or the edge to resize the band.'
              : 'Drag the text to move it, its corners to resize it, or the edge to resize the band.'}
        </p>
        <CheckField label="Autofit text" checked={label.autofit} onChange={(autofit) => setLabel({ autofit })} help={AUTOFIT_HELP[label.style]} />
        {(resized || moved) && (
          <div className="inspector-actions">
            {resized && (
              <button type="button" className="btn btn-sm" onClick={() => setLabel({ boxWidth: 0, boxHeight: 0 })}>
                Fit the box to the text
              </button>
            )}
            {moved && (
              <button type="button" className="btn btn-sm" onClick={() => setLabel(RESET_OFFSET)}>
                Reset the position
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

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
  // Picking roads: a press that barely moves is a click, anything more still pans.
  const [picking, setPicking] = useState(false);
  const routes = useApp((state) => state.svg.routes);
  const [selected, setSelected] = useState<number[]>([]);
  const [hoverLine, setHoverLine] = useState(-1);
  const pressed = useRef<{ point: Point; moved: boolean } | null>(null);
  const index = useMemo(() => (result?.pick ? new PickIndex(result.pick) : null), [result]);

  // Moving and resizing the title. Pressing it selects it and shows its
  // handles. It's laid out here as it's dragged and only stored when let go,
  // and drawn over the result until the render catches up (`placing`).
  const shape = useApp((state) => state.area.shape);
  const product = useApp((state) => state.svg.product);
  const border = useApp((state) => state.svg.border);
  const label = useApp((state) => state.svg.label);
  const customFontId = useApp((state) => state.customFontId);
  const layout = useMemo(() => pieceLayout(product, shape, border).layout, [product, shape, border]);
  const [dragged, setDragged] = useState<LabelSettings | null>(null);
  const shown = dragged ?? label;
  const title = useLabelArtwork(Boolean(result), layout, shown, customFontId);
  const titleGrab = useRef<{ pointerId: number; start: Point; drag: TitleDrag; to: LabelSettings | null; cursor: string } | null>(null);
  const [titleSelected, setTitleSelected] = useState(false);
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  useEffect(() => {
    if (!stale) setPlacing(false);
  }, [stale, result, placing]);
  const ghost = (dragged !== null || placing) && title.artwork !== null;
  const unit = box && size.w > 0 ? box.w / size.w : 1;
  const handles = useMemo(() => {
    if (!titleSelected || picking || !title.artwork) return [];
    return spacedHandles(titleHandles(shown, title.artwork), (x, y) => [x / unit, y / unit], HANDLE_GAP);
  }, [titleSelected, picking, title.artwork, shown, unit]);
  useEffect(() => {
    if (!title.artwork) setTitleSelected(false);
  }, [title.artwork]);
  // Line numbers belong to one render.
  useEffect(() => {
    setSelected([]);
    setHoverLine(-1);
  }, [index]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!result || size.w === 0 || size.h === 0) return;
    // Leave room for the chips and toolbar above and the hint below. A short
    // stage (an error panel open on a small screen) still keeps half its
    // height, or the scale and the view box went negative.
    const scale = Math.min(size.w / (result.width * 1.12), Math.max(size.h - 100, size.h / 2) / (result.height * 1.08));
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
  // Where a stage point is on the piece, in mm, and a few pixels' reach there.
  const pieceAt = ([px, py]: Point): { x: number; y: number; reach: number } | null => {
    if (!box || size.w === 0) return null;
    const k = box.w / size.w;
    return { x: box.x + px * k, y: box.y + py * k, reach: 8 * k };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!box) return;
    try {
      // Keeps the drag going outside the stage. Throws if the pointer is already gone.
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    const point = stagePoint(e);
    pointers.current.set(e.pointerId, point);
    pressed.current = pointers.current.size === 1 ? { point, moved: false } : null;
    if (titleGrab.current) {
      // A second finger puts the title back and pinches instead.
      cancelTitleDrag();
    } else if (pointers.current.size === 1 && !picking && e.button === 0 && title.artwork) {
      const grip = gripAt(point);
      if (grip) {
        titleGrab.current = { pointerId: e.pointerId, start: point, drag: { grip, label, artwork: title.artwork }, to: null, cursor: cursorFor(grip) };
        setTitleSelected(true);
        return;
      }
    }
    restart();
  };
  // A handle of the selected title, or the title itself, under a stage point.
  const gripAt = (point: Point): TitleGrip | null => {
    const at = pieceAt(point);
    if (!at || !title.artwork) return null;
    const handle = handleAt(handles, at.x, at.y, (at.reach * (coarse ? HANDLE_REACH_TOUCH : HANDLE_REACH)) / 8);
    if (handle) return handle;
    return titleAt(title.artwork, at.x, at.y) ? 'move' : null;
  };
  const cursorFor = (grip: TitleGrip) => {
    const spot = handles.find((h) => h.id === grip);
    return spot ? resizeCursor(spot.dx, spot.dy) : 'move';
  };
  const cancelTitleDrag = () => {
    titleGrab.current = null;
    setDragged(null);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const grab = titleGrab.current;
    if (grab && grab.pointerId === e.pointerId) {
      const point = stagePoint(e);
      pointers.current.set(e.pointerId, point);
      if (!layout || !box || size.w === 0 || !title.layoutWith) return;
      const k = box.w / size.w;
      grab.to = dragTitle(layout, grab.drag, (point[0] - grab.start[0]) * k, (point[1] - grab.start[1]) * k, title.layoutWith);
      setDragged(grab.to);
      return;
    }
    if (!picking && !pointers.current.size) {
      const grip = gripAt(stagePoint(e));
      setHoverCursor(grip ? cursorFor(grip) : null);
    }
    if (picking && index && !pointers.current.size) {
      const at = pieceAt(stagePoint(e));
      if (at) setHoverLine(index.nearest(at.x, at.y, at.reach));
    }
    const press = pressed.current;
    if (press && Math.hypot(stagePoint(e)[0] - press.point[0], stagePoint(e)[1] - press.point[1]) > 4) press.moved = true;
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
    const grab = titleGrab.current;
    if (grab && grab.pointerId === e.pointerId) {
      titleGrab.current = null;
      pressed.current = null;
      const placed = e.type !== 'pointercancel' && grab.to && title.layoutWith ? title.layoutWith(grab.to) : null;
      if (grab.to && placed) {
        setLabel(droppedLabel(grab.to, placed));
        setPlacing(true);
      }
      setDragged(null);
      restart();
      return;
    }
    restart();
    const press = pressed.current;
    pressed.current = null;
    // A click off the title lets go of it.
    if (!picking && press && !press.moved && e.type !== 'pointercancel') setTitleSelected(false);
    if (!picking || !index || !press || press.moved || e.type === 'pointercancel') return;
    const at = pieceAt(press.point);
    if (!at) return;
    // Picking is for several roads at once, so a click adds a road or drops it
    // again, and a click beside the roads doesn't lose the others.
    const line = index.nearest(at.x, at.y, at.reach);
    if (line < 0) return;
    setSelected((current) => (current.includes(line) ? current.filter((l) => l !== line) : [...current, line]));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((titleGrab.current || titleSelected) && e.key === 'Escape') {
      if (titleGrab.current) cancelTitleDrag();
      else setTitleSelected(false);
      e.preventDefault();
      return;
    }
    if (picking && e.key === 'Escape' && selected.length) {
      setSelected([]);
      e.preventDefault();
      return;
    }
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
        ...(result.stats.overtureBuildings !== undefined
          ? [['Overture buildings', `${formatInteger(result.stats.overtureBuildings)} added`] as [string, string]]
          : []),
        ...(totalMs > 0 ? [['Drawn in', formatSeconds(totalMs / 1000)] as [string, string]] : []),
      ]
    : [];

  return (
    <div className="svg-preview" role="region" aria-label="SVG preview">
      <div
        ref={ref}
        className={`svg-stage${dragging ? ' is-dragging' : ''}`}
        style={{ cursor: titleGrab.current?.cursor ?? (picking ? undefined : (hoverCursor ?? undefined)) }}
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
        onPointerLeave={() => setHoverCursor(null)}
        onDoubleClick={fit}
      >
        {result && box && (
          <svg viewBox={`${box.x} ${box.y} ${box.w} ${h}`} preserveAspectRatio="xMidYMid meet">
            <PreviewContent result={result} look={look} hideTitle={ghost} />
            {ghost && title.artwork && (
              <TitleGhost artwork={title.artwork} style={shown.style} result={result} look={look} windowD={layout ? shapePathD(layout.window) : null} />
            )}
            {!picking && title.artwork && (titleSelected || hoverCursor) && (
              <TitleFrame artwork={title.artwork} label={shown} handles={handles} selected={titleSelected} unit={box.w / Math.max(size.w, 1)} />
            )}
            {picking && index && <PickOverlay index={index} selected={selected} hover={hoverLine} unit={box.w / Math.max(size.w, 1)} routes={routes} />}
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
            <ToolButton
              label={picking ? 'Stop picking roads' : 'Pick roads for routes'}
              pressed={picking}
              onClick={() => {
                setPicking(!picking);
                setSelected([]);
                setCard(null);
              }}
            >
              <Route size={15} aria-hidden="true" />
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
          {picking && card === null && <RouteCard index={index} selected={selected} onSelect={setSelected} onClose={() => setPicking(false)} />}
          {!picking && card === null && titleSelected && title.artwork && <TitleCard label={label} onClose={() => setTitleSelected(false)} />}
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
        <div className="viewer-hint">
          {picking
            ? coarse
              ? 'Tap roads to pick them · Tap again to drop one'
              : 'Click roads to pick them · Click again to drop one · Esc clears · Drag to move'
            : titleSelected
              ? `Drag the handles to resize the title · ${coarse ? 'Tap the map' : 'Click the map or press Esc'} to let go`
              : coarse
                ? `Drag to move · Pinch to zoom${title.artwork ? ' · Tap the title to move or resize it' : ''}`
                : `Drag to move · Scroll to zoom · Double-click to fit${title.artwork ? ' · Click the title to move or resize it' : ''}`}
        </div>
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
