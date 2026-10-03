// The route editor on the map: the route drawn with handles over the map,
// dragging points and the line, clicks with the draw tool, and the keys.
// Like the area editor it's DOM (one SVG) updated on every map move, and it
// takes presses from the map's own mousedown and touchstart, whose
// preventDefault() stops the pan. A press that misses the route pans the map
// as usual. The edits themselves are in state/trackEdit.ts.

import type { MapMouseEvent, MapTouchEvent, Map as MlMap } from 'maplibre-gl';
import { handleIndexes, nearestOnLines, type LineHit } from '../../core/tracks/edit';
import { decodeTrack, type Track } from '../../core/tracks/track';
import type { LonLat, Vec2 } from '../../core/types';
import { PHONE_QUERY } from '../lib/browser';
import { setRouteFollow, useApp } from '../state/store';
import {
  applySpan,
  connect,
  cutSection,
  drawFrom,
  drawTo,
  editSpace,
  inRoads,
  insertEdit,
  moveEdit,
  removeEdit,
  roadGraph,
  roadSpot,
  selectPoint,
  selectSection,
  setEditedTrack,
  setTrackTool,
  startSection,
  stopEditing,
  useTrackEdit,
  type EditSpace,
  type SpanEdit,
  type TrackPoint,
} from '../state/trackEdit';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

// In screen pixels. Handles are kept far enough apart to grab, and fingers get more room.
const HANDLE_GAP = COARSE ? 34 : 22;
const HANDLE_TOLERANCE = 3;
const HANDLE_REACH = COARSE ? 18 : 10;
const HANDLE_R = COARSE ? 6.5 : 4.5;
const LINE_REACH = COARSE ? 14 : 7;
const DRAG_START = 4;
// A click this close to where drawing carries on from adds nothing, like the second click of a double-click.
const DRAW_REPEAT = 6;
// Arrow keys move a point this far on screen, so zooming in moves it less. Shift for further.
const NUDGE = 3;
const NUDGE_FAR = 15;
// MapLibre's world is 512 pixels across at zoom 0.
const WORLD = 512;
const EARTH_M = 40_075_016.686;
const DEG = Math.PI / 180;

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

function mercator(points: readonly LonLat[]): Float64Array {
  const out = new Float64Array(points.length * 2);
  points.forEach(([lon, lat], i) => {
    out[i * 2] = mercX(lon);
    out[i * 2 + 1] = mercY(lat);
  });
  return out;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  el.setAttribute('class', className);
  return el;
}

const fmt = (n: number) => n.toFixed(1);

const EDIT_KEYS = ['editing', 'trackId', 'selected', 'section', 'sectionFrom', 'tool', 'draft', 'opened', 'network'] as const;

interface Grab {
  pointerId: number;
  kind: 'point' | 'insert';
  line: number;
  index: number;
  segment: number;
  t: number;
  before: number;
  after: number;
  from: [number, number];
  moved: boolean;
}

type Hover = { kind: 'point'; line: number; index: number } | { kind: 'line'; hit: LineHit } | { kind: 'other' } | null;

interface Spot {
  line: number;
  index: number;
  x: number;
  y: number;
}

// Keys only count on the map or the editor's own buttons, not while typing
// or in the sidebar, where arrows move sliders and radio buttons.
function ownsKey(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return true;
  if (el.closest('#sidebar, dialog, .popover, input, select, textarea, [contenteditable="true"], [role="radio"], [role="slider"]')) return false;
  return true;
}

export class TrackEditor {
  readonly element: SVGSVGElement;
  private readonly halo: SVGPathElement;
  private readonly casing: SVGPathElement;
  private readonly line: SVGPathElement;
  private readonly sectionPath: SVGPathElement;
  private readonly drawPath: SVGPathElement;
  private readonly marks: SVGGElement;

  private active = false;
  private track: Track | null = null;
  private space: EditSpace | null = null;
  private lonLat: LonLat[][] = [];
  private local: Vec2[][] = [];
  private merc: Float64Array[] = [];
  private seenTracks: readonly Track[] | null = null;
  private seenId: string | null = null;
  private others: { track: Track; local: Vec2[][] }[] = [];
  private handles: number[][] = [];
  private handlesKey = '';
  private handlesOf: Vec2[][] | null = null;
  /** Handles in route order, for stepping through them from the keyboard. */
  private flat: TrackPoint[] = [];
  private spots: Spot[] = [];
  private metresPerPixel = 1;
  private toScreen: (mx: number, my: number) => [number, number] = (x, y) => [x, y];

  private grab: Grab | null = null;
  private preview: { edit: SpanEdit; merc: Float64Array; snapped: boolean; space: EditSpace } | null = null;
  private hover: Hover = null;
  private drawing: Float64Array | null = null;
  private suppressClick = false;
  private lastDown: { id: number; type: string } | null = null;
  private lastPointer: { x: number; y: number; alt: boolean } | null = null;
  private opened = 0;
  private readonly unsubscribe: (() => void)[] = [];
  private destroyed = false;

  constructor(private readonly map: MlMap) {
    this.element = svg('svg', 'track-editor');
    this.element.setAttribute('aria-hidden', 'true');
    this.halo = svg('path', 'track-edit-halo');
    this.casing = svg('path', 'track-edit-casing');
    this.line = svg('path', 'track-edit-line');
    this.sectionPath = svg('path', 'track-edit-section');
    this.drawPath = svg('path', 'track-edit-draw');
    this.marks = svg('g', 'track-edit-marks');
    this.element.append(this.halo, this.casing, this.line, this.sectionPath, this.drawPath, this.marks);
    const container = map.getContainer();
    container.insertBefore(this.element, container.querySelector('.maplibregl-control-container'));

    map.on('move', this.layout);
    map.on('resize', this.layout);
    map.on('mousedown', this.onMouseDown);
    map.on('touchstart', this.onTouchStart);
    map.on('mousemove', this.onHover);
    map.on('mouseout', this.onLeave);
    map.on('click', this.onClick);
    map.on('dblclick', this.onDoubleClick);
    container.addEventListener('pointerdown', this.recordPointer, true);
    // Capture, so arrow keys nudge a point rather than pan the map under it.
    window.addEventListener('keydown', this.onKey, true);
    this.unsubscribe.push(
      useTrackEdit.subscribe((state, previous) => {
        // Not for the hint and announcements, which this sets itself.
        if (EDIT_KEYS.some((key) => state[key] !== previous[key])) this.refresh();
      }),
    );
    this.unsubscribe.push(
      useApp.subscribe((state, previous) => {
        if (state.tracks !== previous.tracks || state.output !== previous.output || state.palette.route !== previous.palette.route || state.ui.view !== previous.ui.view) this.refresh();
        else if (state.ui.routeFollow !== previous.ui.routeFollow) this.updateHint();
      }),
    );
    this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelDrag();
    for (const off of this.unsubscribe) off();
    const map = this.map;
    map.off('move', this.layout);
    map.off('resize', this.layout);
    map.off('mousedown', this.onMouseDown);
    map.off('touchstart', this.onTouchStart);
    map.off('mousemove', this.onHover);
    map.off('mouseout', this.onLeave);
    map.off('click', this.onClick);
    map.off('dblclick', this.onDoubleClick);
    map.getContainer().removeEventListener('pointerdown', this.recordPointer, true);
    window.removeEventListener('keydown', this.onKey, true);
    this.element.remove();
    if (current === this) current = null;
  }

  // ------------------------------------------------------------- state

  private refresh(): void {
    if (this.destroyed) return;
    const edit = useTrackEdit.getState();
    const app = useApp.getState();
    const active = edit.editing && app.output === 'model';
    if (active !== this.active) {
      this.active = active;
      this.element.classList.toggle('is-active', active);
      if (!active) {
        this.cancelDrag();
        this.hover = null;
        this.drawing = null;
        this.setCursor('');
        this.updateHint();
      }
    }
    if (!active) return;
    this.element.style.setProperty('--route', app.palette.route.hex);
    const space = editSpace();
    const track = app.tracks.find((item) => item.id === edit.trackId) ?? null;
    if (track !== this.track || space !== this.space) {
      this.track = track;
      this.lonLat = track ? decodeTrack(track) : [];
      this.local = this.lonLat.map((line) => line.map(space.toLocal));
      this.merc = this.lonLat.map(mercator);
      this.preview = null;
    }
    if (app.tracks !== this.seenTracks || edit.trackId !== this.seenId || space !== this.space) {
      this.seenTracks = app.tracks;
      this.seenId = edit.trackId;
      this.others = app.tracks.filter((item) => item.visible && item.id !== edit.trackId).map((item) => ({ track: item, local: decodeTrack(item).map((line) => line.map(space.toLocal)) }));
    }
    this.space = space;
    if (edit.tool !== 'draw') this.drawing = null;
    if (edit.opened !== this.opened) {
      this.opened = edit.opened;
      this.bringIntoView();
    }
    this.layout();
    this.updateCursor();
    this.updateHint();
  }

  /** Moves the map to the route when hardly any of it is in view. */
  private bringIntoView(): void {
    if (!this.lonLat.length) return;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const line of this.lonLat) {
      for (const [lon, lat] of line) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
    const view = this.map.getBounds();
    const overlapW = Math.min(east, view.getEast()) - Math.max(west, view.getWest());
    const overlapH = Math.min(north, view.getNorth()) - Math.max(south, view.getSouth());
    const shown = overlapW > 0 && overlapH > 0 ? (overlapW * overlapH) / Math.max((east - west) * (north - south), 1e-12) : 0;
    // On a phone the card covers the bottom of the map, so the route always goes above it.
    const phone = matchMedia(PHONE_QUERY).matches;
    if (shown > 0.5 && !phone) return;
    const { clientHeight } = this.map.getContainer();
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: phone ? { top: 100, bottom: Math.round(clientHeight * 0.45), left: 30, right: 50 } : { top: 80, bottom: 80, left: 80, right: 340 }, duration: 800, maxZoom: 17 },
    );
  }

  // ------------------------------------------------------------- drawing

  private readonly layout = (): void => {
    if (!this.active || this.destroyed) return;
    const map = this.map;
    const zoom = map.getZoom();
    const center = map.getCenter();
    const p0 = map.project(center);
    const scale = WORLD * 2 ** zoom;
    const cx = mercX(center.lng);
    const cy = mercY(center.lat);
    // Seen from straight above and never turned, so mercator to screen is a scale and a shift.
    this.toScreen = (mx, my) => [(mx - cx) * scale + p0.x, (my - cy) * scale + p0.y];
    const lat = this.space?.center[1] ?? center.lat;
    this.metresPerPixel = (EARTH_M * Math.cos(lat * DEG)) / scale;

    const edit = useTrackEdit.getState();
    // Handles follow the zoom in quarter steps, so zooming doesn't redo them every frame.
    const step = 2 ** (Math.round(Math.log2(Math.max(this.metresPerPixel, 1e-6)) * 4) / 4);
    const key = `${step}|${edit.selected?.line},${edit.selected?.index}|${edit.section?.line},${edit.section?.from},${edit.section?.to}`;
    if (key !== this.handlesKey || this.handlesOf !== this.local) {
      this.handlesKey = key;
      this.handlesOf = this.local;
      this.handles = this.local.map((path, line) => {
        const keep: number[] = [];
        if (edit.selected?.line === line) keep.push(edit.selected.index);
        if (edit.section?.line === line) keep.push(edit.section.from, edit.section.to);
        return handleIndexes(path, HANDLE_TOLERANCE * step, HANDLE_GAP * step, keep);
      });
      this.flat = this.handles.flatMap((list, line) => list.map((index) => ({ line, index })));
    }

    const preview = this.preview;
    let d = '';
    this.merc.forEach((merc, line) => {
      if (preview && preview.edit.line === line) {
        const head = this.pathOf(merc, 0, preview.edit.from);
        const middle = this.pathOf(preview.merc, 0, preview.merc.length / 2, head !== '');
        d += head + middle + this.pathOf(merc, preview.edit.to + 1, merc.length / 2, head !== '' || middle !== '');
      } else d += this.pathOf(merc, 0, merc.length / 2);
    });
    // Each line starts with M, so a line split by the preview reads as one.
    this.halo.setAttribute('d', d);
    this.casing.setAttribute('d', d);
    this.line.setAttribute('d', d);
    // An undo can leave the section past the end of its line for a moment, until trackEdit lets go of it.
    const section = edit.section;
    const sectionLine = section ? this.merc[section.line] : undefined;
    this.sectionPath.setAttribute('d', section && sectionLine && section.to < sectionLine.length / 2 ? this.pathOf(sectionLine, section.from, section.to + 1) : '');
    this.drawPath.setAttribute('d', this.drawing ? this.pathOf(this.drawing, 0, this.drawing.length / 2) : '');
    this.drawMarks(edit);
  };

  // Points from..to (to not included) of a mercator line as path data,
  // carrying on the path before it when `on`.
  private pathOf(merc: Float64Array, from: number, to: number, on = false): string {
    let d = '';
    for (let i = from; i < to; i++) {
      const [x, y] = this.toScreen(merc[i * 2], merc[i * 2 + 1]);
      d += `${i === from && !on ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`;
    }
    return d;
  }

  private drawMarks(edit: ReturnType<typeof useTrackEdit.getState>): void {
    const held = this.grab;
    const r = HANDLE_R;
    let out = '';
    this.spots = [];
    const lastLine = this.merc.length - 1;
    this.handles.forEach((list, line) => {
      const merc = this.merc[line];
      for (const index of list) {
        const [x, y] = this.toScreen(merc[index * 2], merc[index * 2 + 1]);
        this.spots.push({ line, index, x, y });
        if (held?.moved && held.kind === 'point' && held.line === line && held.index === index) continue;
        const start = line === 0 && index === 0;
        const finish = line === lastLine && index === merc.length / 2 - 1;
        const selected = (edit.selected?.line === line && edit.selected.index === index) || (edit.section?.line === line && (edit.section.from === index || edit.section.to === index));
        const anchor = edit.sectionFrom?.line === line && edit.sectionFrom.index === index;
        const hovered = this.hover?.kind === 'point' && this.hover.line === line && this.hover.index === index;
        const cls = `track-handle${start ? ' is-start' : ''}${finish && !start ? ' is-finish' : ''}${selected || anchor ? ' is-selected' : ''}${hovered ? ' is-hover' : ''}`;
        const size = (start || finish ? r * 1.3 : r) * (hovered ? 1.2 : 1);
        out +=
          finish && !start
            ? `<rect class="${cls}" x="${fmt(x - size)}" y="${fmt(y - size)}" width="${fmt(size * 2)}" height="${fmt(size * 2)}" rx="1.5"/>`
            : `<circle class="${cls}" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(size)}"/>`;
      }
    });
    // The first click of a new route, before it has a line.
    if (edit.draft && !this.track) {
      const [x, y] = this.toScreen(mercX(edit.draft[0]), mercY(edit.draft[1]));
      out += `<circle class="track-handle is-start" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r * 1.3)}"/>`;
    }
    if (this.hover?.kind === 'line' && !held && this.space) {
      const [lon, lat] = this.space.toLonLat(this.hover.hit.point);
      const [x, y] = this.toScreen(mercX(lon), mercY(lat));
      const k = r * 0.55;
      out += `<g class="track-ghost"><circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}"/><path d="M${fmt(x - k)} ${fmt(y)}h${fmt(k * 2)}M${fmt(x)} ${fmt(y - k)}v${fmt(k * 2)}"/></g>`;
    }
    const focus = this.preview?.edit.focus;
    if (focus && this.space) {
      const [lon, lat] = this.space.toLonLat(focus);
      const [x, y] = this.toScreen(mercX(lon), mercY(lat));
      out += `<circle class="track-handle is-dragged${this.preview!.snapped ? ' is-snapped' : ''}" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r * 1.25)}"/>`;
    }
    this.marks.innerHTML = out;
  }

  private setCursor(cursor: string): void {
    const canvas = this.map.getCanvas();
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  private updateCursor(): void {
    if (!this.active) return;
    const tool = useTrackEdit.getState().tool;
    const hover = this.hover?.kind;
    this.setCursor(this.grab?.moved ? 'grabbing' : hover === 'point' ? 'grab' : hover === 'line' ? 'copy' : hover === 'other' ? 'pointer' : tool === 'draw' ? 'crosshair' : '');
  }

  /** What the hint under the map says for what's happening now. */
  private updateHint(): void {
    const edit = useTrackEdit.getState();
    const { ui } = useApp.getState();
    const tap = COARSE ? 'Tap' : 'Click';
    const held = this.grab;
    let hint: string | null = null;
    if (!this.active) hint = null;
    else if (held?.moved) {
      const snapped = this.preview?.snapped;
      const at = this.preview?.edit.focus && this.space ? this.space.toLonLat(this.preview.edit.focus) : null;
      if (snapped) hint = COARSE ? 'On a road.' : 'On a road. Hold Alt to put it anywhere.';
      else if (ui.routeFollow && roadGraph()) hint = at && !inRoads(at) ? 'No roads are loaded out here, so it goes straight.' : 'Not near a road, so it goes straight.';
      else hint = 'Let go to put it there.';
    } else if (edit.tool === 'draw') {
      hint = this.track || edit.draft ? `${tap} to carry the route on. ${COARSE ? 'Tap Finish when done.' : 'Double-click, Enter or Esc to finish.'}` : `${tap} the map where the route starts.`;
    } else if (edit.sectionFrom) hint = `${tap} the other end of the section.`;
    else if (edit.section) hint = 'Snap it to the roads, straighten it or cut it out in the panel.';
    else if (edit.selected) hint = COARSE ? 'Drag it to move it, or use the panel.' : 'Drag it to move it. Delete removes it. Shift-click another point to pick the section between.';
    else if (this.track) hint = COARSE ? 'Drag a point to move it, or drag the line to add one.' : 'Drag a point to move it, or drag the line to add one. Double-click a point to delete it.';
    else hint = 'Pick a route in the panel, or draw a new one.';
    if (useTrackEdit.getState().hint !== hint) useTrackEdit.setState({ hint });
  }

  // ------------------------------------------------------------- hit testing

  private handleAt(x: number, y: number): TrackPoint | null {
    let best: TrackPoint | null = null;
    let bestD = HANDLE_REACH;
    for (const spot of this.spots) {
      const d = Math.hypot(spot.x - x, spot.y - y);
      if (d <= bestD) {
        bestD = d;
        best = { line: spot.line, index: spot.index };
      }
    }
    return best;
  }

  private localAt(x: number, y: number): Vec2 | null {
    if (!this.space) return null;
    const at = this.map.unproject([x, y]);
    return this.space.toLocal([at.lng, at.lat]);
  }

  private lineAt(at: Vec2): LineHit | null {
    return nearestOnLines(this.local, at, LINE_REACH * this.metresPerPixel);
  }

  /** The handles either side of a point, or the point itself at an end. */
  private neighbours(line: number, index: number): [number, number] {
    let before = index;
    let after = index;
    for (const h of this.handles[line] ?? []) {
      if (h < index) before = h;
      else if (h > index) {
        after = h;
        break;
      }
    }
    return [before, after];
  }

  /** Where a point put at `at` goes: onto the nearest road when following them, unless `free`. */
  private target(at: Vec2, free: boolean): { to: Vec2; snapped: boolean } {
    if (!free && useApp.getState().ui.routeFollow) {
      const spot = roadSpot(at);
      if (spot) return { to: spot, snapped: true };
    }
    return { to: at, snapped: false };
  }

  private follow() {
    return useApp.getState().ui.routeFollow ? roadGraph() : null;
  }

  // ------------------------------------------------------------- input

  private readonly recordPointer = (event: PointerEvent): void => {
    this.lastDown = { id: event.pointerId, type: event.pointerType };
  };

  private readonly onMouseDown = (event: MapMouseEvent): void => {
    this.suppressClick = false;
    if (!this.active || this.grab || event.originalEvent.button !== 0) return;
    const id = this.lastDown?.type === 'mouse' ? this.lastDown.id : 1;
    if (this.press(event.point.x, event.point.y, id)) event.preventDefault();
  };

  private readonly onTouchStart = (event: MapTouchEvent): void => {
    if (!this.active) return;
    if (event.points.length !== 1) {
      // A second finger: put the drag back and let the map pinch.
      this.cancelDrag();
      return;
    }
    if (this.grab) return;
    this.suppressClick = false;
    const id = this.lastDown && this.lastDown.type !== 'mouse' ? this.lastDown.id : -1;
    if (this.press(event.point.x, event.point.y, id)) event.preventDefault();
  };

  /** A press on the map. True when it took hold of a point or the line. */
  private press(x: number, y: number, pointerId: number): boolean {
    const track = this.track;
    if (!track) return false;
    const edit = useTrackEdit.getState();
    const hit = this.handleAt(x, y);
    const base = { pointerId, segment: 0, t: 0, from: [x, y] as [number, number], moved: false };
    if (hit) {
      const [before, after] = this.neighbours(hit.line, hit.index);
      this.grab = { ...base, kind: 'point', line: hit.line, index: hit.index, before, after };
    } else {
      if (edit.tool === 'draw') return false;
      const at = this.localAt(x, y);
      const line = at && this.lineAt(at);
      if (!line) return false;
      const list = this.handles[line.line] ?? [];
      const before = [...list].reverse().find((h) => h <= line.segment) ?? 0;
      const after = list.find((h) => h >= line.segment + 1) ?? this.local[line.line].length - 1;
      this.grab = { ...base, kind: 'insert', line: line.line, index: -1, segment: line.segment, t: line.t, before, after };
    }
    this.suppressClick = true;
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragEnd);
    document.documentElement.classList.add('is-area-dragging');
    return true;
  }

  private readonly onDragMove = (event: PointerEvent): void => {
    const held = this.grab;
    if (!held) return;
    if (held.pointerId === -1 && event.pointerType !== 'mouse') held.pointerId = event.pointerId;
    if (event.pointerId !== held.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      this.endDrag(false, event.shiftKey);
      return;
    }
    const rect = this.map.getCanvasContainer().getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!held.moved && Math.hypot(x - held.from[0], y - held.from[1]) < DRAG_START) return;
    held.moved = true;
    const at = this.localAt(x, y);
    const path = this.local[held.line];
    if (!at || !path || !this.space) return;
    const { to, snapped } = this.target(at, event.altKey);
    const graph = this.follow();
    // Following the roads, a point that isn't on one joins its neighbours straight.
    const via = graph ? (snapped ? graph : 'straight') : null;
    const edit =
      held.kind === 'point'
        ? moveEdit(path, held.line, held.before, held.index, held.after, to, via)
        : insertEdit(path, held.line, held.segment, held.t, held.before, held.after, to, via);
    const space = this.space;
    this.preview = { edit, merc: mercator(edit.points.map(space.toLonLat)), snapped, space };
    this.hover = null;
    this.layout();
    this.updateCursor();
    this.updateHint();
  };

  private readonly onDragEnd = (event: PointerEvent): void => {
    const held = this.grab;
    if (!held || (event.pointerId !== held.pointerId && held.pointerId !== -1)) return;
    this.endDrag(event.type === 'pointercancel', event.shiftKey);
  };

  private endDrag(cancelled: boolean, shift: boolean): void {
    const held = this.grab;
    if (!held) return;
    const done = this.preview;
    this.grab = null;
    this.preview = null;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragEnd);
    document.documentElement.classList.remove('is-area-dragging');
    const track = this.track;
    if (!cancelled && track) {
      if (!held.moved) {
        if (held.kind === 'point') this.pick({ line: held.line, index: held.index }, shift);
      } else if (done) {
        applySpan(track, done.edit, held.kind === 'point' ? 'Move route point' : 'Add route point', undefined, done.space);
      }
    }
    this.layout();
    this.updateCursor();
    this.updateHint();
  }

  private cancelDrag(): void {
    if (!this.grab) return;
    this.endDrag(true, false);
  }

  /** A point clicked: selected, or the other end of a section. */
  private pick(point: TrackPoint, shift: boolean): void {
    const { sectionFrom, section, selected } = useTrackEdit.getState();
    const anchor = sectionFrom ?? (shift ? (section ? { line: section.line, index: section.from } : selected) : null);
    if (sectionFrom && sectionFrom.line !== point.line) {
      this.announce('Pick a point on the same piece of the route. A gap splits it in two.');
      return;
    }
    if (anchor && anchor.line === point.line && anchor.index !== point.index) {
      selectSection({ line: point.line, from: Math.min(anchor.index, point.index), to: Math.max(anchor.index, point.index) });
      this.announce('Section picked');
      return;
    }
    selectPoint(point);
    this.announce(this.pointName(point));
  }

  private readonly onHover = (event: MapMouseEvent): void => {
    if (!this.active || this.grab) return;
    const { x, y } = event.point;
    this.lastPointer = { x, y, alt: event.originalEvent.altKey };
    this.hoverAt(x, y, event.originalEvent.altKey);
  };

  private hoverAt(x: number, y: number, alt: boolean): void {
    const edit = useTrackEdit.getState();
    const hit = this.track ? this.handleAt(x, y) : null;
    let hover: Hover = null;
    if (hit) hover = { kind: 'point', ...hit };
    else if (edit.tool !== 'draw') {
      const at = this.localAt(x, y);
      const line = at && this.track ? this.lineAt(at) : null;
      if (line) hover = { kind: 'line', hit: line };
      // Another route, which a click switches to.
      else if (at && this.others.some((o) => nearestOnLines(o.local, at, LINE_REACH * this.metresPerPixel))) hover = { kind: 'other' };
    }
    this.hover = hover;
    this.drawing = null;
    if (edit.tool === 'draw' && !hit && this.space) {
      const at = this.localAt(x, y);
      const from = drawFrom(this.space);
      if (at && from) {
        const { to, snapped } = this.target(at, alt);
        const space = this.space;
        this.drawing = mercator(connect(from, to, snapped ? this.follow() : null).map(space.toLonLat));
      }
    }
    this.layout();
    this.updateCursor();
  }

  private readonly onLeave = (): void => {
    this.lastPointer = null;
    if (!this.active || this.grab || (!this.hover && !this.drawing)) return;
    this.hover = null;
    this.drawing = null;
    this.layout();
    this.updateCursor();
  };

  private readonly onClick = (event: MapMouseEvent): void => {
    if (!this.active) return;
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (event.originalEvent.button !== 0) return;
    const edit = useTrackEdit.getState();
    const { x, y } = event.point;
    const at = this.localAt(x, y);
    if (!at || !this.space) return;
    if (edit.tool === 'draw') {
      const from = drawFrom(this.space);
      if (from) {
        const [lon, lat] = this.space.toLonLat(from);
        const [fx, fy] = this.toScreen(mercX(lon), mercY(lat));
        if (Math.hypot(fx - x, fy - y) < DRAW_REPEAT) return;
      }
      const { to, snapped } = this.target(at, event.originalEvent.altKey);
      const hadTrack = Boolean(this.track);
      drawTo(to, snapped ? this.follow() : null, this.space);
      this.drawing = null;
      if (!hadTrack && useTrackEdit.getState().trackId) this.announce('Started a route. Click to carry it on.');
      return;
    }
    const other = this.others.find((o) => nearestOnLines(o.local, at, LINE_REACH * this.metresPerPixel));
    if (other) {
      setEditedTrack(other.track.id);
      this.announce(`Editing ${other.track.name}`);
      return;
    }
    if (edit.selected || edit.section || edit.sectionFrom) {
      selectPoint(null);
      this.announce('Nothing selected');
    }
  };

  private readonly onDoubleClick = (event: MapMouseEvent): void => {
    if (!this.active) return;
    const edit = useTrackEdit.getState();
    if (edit.tool === 'draw') {
      // Finishes drawing, rather than zooming in.
      if (this.track || edit.draft) {
        event.preventDefault();
        setTrackTool('move');
      }
      return;
    }
    const hit = this.handleAt(event.point.x, event.point.y);
    if (!hit) return;
    event.preventDefault();
    this.remove(hit);
  };

  // ------------------------------------------------------------- actions

  private announce(text: string): void {
    useTrackEdit.setState({ announce: text });
  }

  /** The point's place along the route, for reading out. */
  pointName(point: TrackPoint): string {
    const n = this.flat.findIndex((h) => h.line === point.line && h.index === point.index);
    const start = point.line === 0 && point.index === 0;
    const finish = point.line === this.lonLat.length - 1 && point.index === (this.lonLat[point.line]?.length ?? 0) - 1;
    const end = start ? ', the start' : finish ? ', the finish' : '';
    return n >= 0 ? `Point ${n + 1} of ${this.flat.length}${end}` : `Point${end}`;
  }

  /** Takes out a point, joining the handles either side. */
  remove(point: TrackPoint): void {
    const track = this.track;
    const path = this.local[point.line];
    if (!track || !path) return;
    const [before, after] = this.neighbours(point.line, point.index);
    applySpan(track, removeEdit(path, point.line, before, point.index, after, this.follow()), 'Delete route point', undefined, this.space ?? undefined);
    this.announce('Deleted the point');
  }

  /** Moves a point onto the nearest road. False when there's none within the snap distance. */
  snapPoint(point: TrackPoint): boolean {
    const track = this.track;
    const path = this.local[point.line];
    if (!track || !path) return false;
    const spot = roadSpot(path[point.index]);
    if (!spot) return false;
    const [before, after] = this.neighbours(point.line, point.index);
    applySpan(track, moveEdit(path, point.line, before, point.index, after, spot, this.follow()), 'Snap route point to road', undefined, this.space ?? undefined);
    return true;
  }

  // A nudge is for fine placing, so it bends the stretches either side and
  // never reroutes them. S snaps to a road.
  private nudge(point: TrackPoint, dx: number, dy: number): void {
    const track = this.track;
    const path = this.local[point.line];
    if (!track || !path) return;
    const [before, after] = this.neighbours(point.line, point.index);
    const p = path[point.index];
    const k = this.metresPerPixel;
    applySpan(track, moveEdit(path, point.line, before, point.index, after, [p[0] + dx * k, p[1] - dy * k], null), null, undefined, this.space ?? undefined);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.active || event.defaultPrevented || useApp.getState().ui.view !== 'map') return;
    if (!ownsKey(event.target) || document.querySelector('dialog[open]')) return;
    if (event.ctrlKey || event.metaKey) return;
    const edit = useTrackEdit.getState();
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (this.grab) {
      if (event.key === 'Escape') {
        this.cancelDrag();
        handled();
      }
      return;
    }
    if (event.key === 'Escape') {
      if (edit.draft) useTrackEdit.setState({ draft: null });
      else if (edit.sectionFrom) startSection(null);
      else if (edit.tool === 'draw' && this.track) setTrackTool('move');
      else if (edit.selected || edit.section) selectPoint(null);
      else stopEditing();
      handled();
      return;
    }
    if (event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'f') {
      const follow = !useApp.getState().ui.routeFollow;
      setRouteFollow(follow);
      this.announce(follow ? 'Follow roads on' : 'Follow roads off');
      handled();
      return;
    }
    if (key === 'd') {
      setTrackTool('draw');
      handled();
      return;
    }
    if (key === 'v' || (event.key === 'Enter' && edit.tool === 'draw')) {
      if (this.track) setTrackTool('move');
      handled();
      return;
    }
    const track = this.track;
    if (!track) return;
    // Comma and period, or < and > with Shift, step through the handles. The
    // key's place too, since Shift makes other characters on some layouts.
    const forward = event.key === '.' || event.key === '>' || event.code === 'Period' || event.key === 'End';
    const back = event.key === ',' || event.key === '<' || event.code === 'Comma' || event.key === 'Home';
    if ((forward || back) && this.flat.length) {
      const { section, selected } = edit;
      const now = section ? { line: section.line, index: forward ? section.to : section.from } : selected;
      let i = now ? this.flat.findIndex((h) => h.line === now.line && h.index === now.index) : -1;
      if (event.key === 'Home') i = 0;
      else if (event.key === 'End') i = this.flat.length - 1;
      else if (i < 0) i = forward ? 0 : this.flat.length - 1;
      else i = Math.max(0, Math.min(this.flat.length - 1, i + (forward ? 1 : -1)));
      const next = this.flat[i];
      const anchor = section ? { line: section.line, index: forward ? section.from : section.to } : selected;
      if (event.shiftKey && anchor && anchor.line === next.line && anchor.index !== next.index) {
        selectSection({ line: next.line, from: Math.min(anchor.index, next.index), to: Math.max(anchor.index, next.index) });
        this.announce('Section picked');
      } else {
        selectPoint(next);
        this.announce(this.pointName(next));
      }
      this.reveal(next);
      handled();
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (edit.selected && arrows[event.key]) {
      const step = event.shiftKey ? NUDGE_FAR : NUDGE;
      this.nudge(edit.selected, arrows[event.key][0] * step, arrows[event.key][1] * step);
      handled();
      return;
    }
    if (edit.selected && key === 's') {
      if (!this.snapPoint(edit.selected)) this.announce(`No road or path within ${useApp.getState().ui.routeSnapM} m of this point.`);
      handled();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (edit.section) cutSection(track, edit.section);
      else if (edit.selected) this.remove(edit.selected);
      else return;
      handled();
    }
  };

  /** Pans the map to a point stepped to from the keyboard when it's off screen. */
  private reveal(point: TrackPoint): void {
    const p = this.lonLat[point.line]?.[point.index];
    if (!p) return;
    const [x, y] = this.toScreen(mercX(p[0]), mercY(p[1]));
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    if (x < 40 || y < 40 || x > w - 40 || y > h - 40) this.map.easeTo({ center: p, duration: 300 });
  }

  /** Draw-tool preview again after something changed under a still pointer. */
  rehover(): void {
    const p = this.lastPointer;
    if (p && this.active && !this.grab) this.hoverAt(p.x, p.y, p.alt);
  }
}

let current: TrackEditor | null = null;

export function registerTrackEditor(editor: TrackEditor | null): void {
  current = editor;
}

/** The editor on the map, for the panel's buttons that act on what's selected. */
export function trackEditor(): TrackEditor | null {
  return current;
}
