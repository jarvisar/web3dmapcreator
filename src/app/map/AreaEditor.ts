// Draws the selected area over the map and lets the user move, resize and
// rotate it. Everything is DOM (an SVG outline plus handle buttons), updated
// on every map move, so the outline never lags behind the handles the way a
// GeoJSON layer does while the worker re-tiles it.
//
// Handles sit outside MapLibre's canvas container, so the map never sees
// their pointer events and cannot pan while one is dragged. Dragging inside
// the area is caught from the map's own mousedown/touchstart events, whose
// preventDefault() stops the pan but leaves wheel and pinch zoom working.

import type { MapMouseEvent, MapTouchEvent, Map as MlMap } from 'maplibre-gl';
import { areaGeoRing } from '../../core/geo/area';
import { Projection } from '../../core/geo/projection';
import type { AreaSpec } from '../../core/settings';
import type { LonLat } from '../../core/types';
import { LATITUDE_LIMIT, constrainSize, normalizeRotation, snapRotation, wrapLongitude } from '../lib/area';
import type { PieceOverlay } from '../svgmap/overlay';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROTATE_OFFSET = 30;
const LABEL_GAP = 12;
const EDGE = 8;

type DragKind = 'move' | 'resize' | 'rotate';

interface Corner {
  sx: 1 | -1;
  sy: 1 | -1;
  el: HTMLButtonElement;
}

interface Drag {
  kind: DragKind;
  pointerId: number;
  start: AreaSpec;
  projection: Projection;
  rect: DOMRect;
  corner?: Corner;
  grab?: LonLat;
  grabAngle?: number;
  handle?: HTMLElement;
}

export interface AreaEditorOptions {
  onChange: (area: AreaSpec) => void;
  onDragStart?: () => void;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  el.setAttribute('class', className);
  return el;
}

export class AreaEditor {
  readonly element: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly fill: SVGPathElement;
  private readonly casing: SVGPathElement;
  private readonly outline: SVGPathElement;
  private readonly box: SVGPathElement;
  private readonly stem: SVGLineElement;
  private readonly corners: Corner[];
  private readonly rotateHandle: HTMLButtonElement;
  private readonly label: HTMLDivElement;
  private readonly pieceGroup: SVGGElement;
  private labelSize = { width: 0, height: 0 };

  private area: AreaSpec;
  private ring: LonLat[] = [];
  private cornerGeo: LonLat[] = [];
  private topGeo: LonLat = [0, 0];
  // Half a width along the area's own x and y axes, to place the piece overlay.
  private axisGeo: [LonLat, LonLat] = [
    [0, 0],
    [0, 0],
  ];
  /** Height over width that resizing keeps, for an SVG map's window. */
  private aspect: number | null = null;
  private resizable = true;
  private piece: PieceOverlay | null = null;
  private screen: number[] = [];
  private drag: Drag | null = null;
  private lastDown: { id: number; type: string } | null = null;
  private hovering = false;
  private destroyed = false;

  constructor(
    private readonly map: MlMap,
    area: AreaSpec,
    private readonly options: AreaEditorOptions,
  ) {
    this.area = area;
    const element = document.createElement('div');
    element.className = 'area-editor';
    this.element = element;

    this.svg = svg('svg', 'area-svg');
    this.svg.setAttribute('aria-hidden', 'true');
    this.fill = svg('path', 'area-fill');
    this.box = svg('path', 'area-box');
    this.casing = svg('path', 'area-casing');
    this.outline = svg('path', 'area-outline');
    this.stem = svg('line', 'area-stem');
    this.pieceGroup = svg('g', 'area-piece');
    this.svg.append(this.fill, this.pieceGroup, this.box, this.casing, this.outline, this.stem);
    element.appendChild(this.svg);

    this.label = document.createElement('div');
    this.label.className = 'area-label';
    this.label.setAttribute('aria-hidden', 'true');
    element.appendChild(this.label);

    const cornerNames: [1 | -1, 1 | -1, string][] = [
      [-1, -1, 'bottom left'],
      [1, -1, 'bottom right'],
      [1, 1, 'top right'],
      [-1, 1, 'top left'],
    ];
    this.corners = cornerNames.map(([sx, sy, name]) => {
      const corner: Corner = { sx, sy, el: this.makeHandle('area-handle-corner', `Resize the area from its ${name} corner`) };
      corner.el.addEventListener('pointerdown', (event) => this.onHandleDown(event, 'resize', corner));
      corner.el.addEventListener('keydown', (event) => this.onCornerKey(event));
      return corner;
    });
    this.rotateHandle = this.makeHandle('area-handle-rotate', 'Rotate the area');
    this.rotateHandle.addEventListener('pointerdown', (event) => this.onHandleDown(event, 'rotate'));
    this.rotateHandle.addEventListener('keydown', (event) => this.onRotateKey(event));

    // Above the canvas, below MapLibre's controls.
    const container = map.getContainer();
    container.insertBefore(element, container.querySelector('.maplibregl-control-container'));

    map.on('move', this.layout);
    map.on('resize', this.layout);
    map.on('mousedown', this.onMapMouseDown);
    map.on('touchstart', this.onMapTouchStart);
    map.on('mousemove', this.onMapHover);
    container.addEventListener('pointerdown', this.recordPointer, true);

    this.setArea(area);
  }

  setArea(area: AreaSpec): void {
    this.area = area;
    this.ring = areaGeoRing(area);
    const projection = new Projection(area.center, area.rotationDeg, 1);
    const w = area.widthM / 2;
    const h = area.heightM / 2;
    this.cornerGeo = this.corners.map(({ sx, sy }) => projection.localToGeo(sx * w, sy * h));
    this.topGeo = projection.localToGeo(0, h);
    this.axisGeo = [projection.localToGeo(w, 0), projection.localToGeo(0, w)];
    this.element.dataset.shape = area.shape;
    this.layout();
  }

  setAspect(aspect: number | null): void {
    this.aspect = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : null;
  }

  /** Off hides the corner handles, for an SVG map with its scale locked. */
  setResizable(resizable: boolean): void {
    this.resizable = resizable;
    this.element.classList.toggle('is-fixed-size', !resizable);
  }

  /** The piece around an SVG map's window, drawn over the map. null removes it. */
  setPiece(piece: PieceOverlay | null): void {
    if (piece?.markup === this.piece?.markup && piece?.window.join() === this.piece?.window.join()) {
      this.piece = piece;
      return;
    }
    this.piece = piece;
    this.pieceGroup.innerHTML = piece ? piece.markup : '';
    this.layout();
  }

  setLabel(text: string): void {
    if (this.label.textContent === text) return;
    this.label.textContent = text;
    this.labelSize = { width: this.label.offsetWidth, height: this.label.offsetHeight };
    this.layout();
  }

  setInvalid(invalid: boolean): void {
    this.element.classList.toggle('is-invalid', invalid);
  }

  destroy(): void {
    this.destroyed = true;
    this.endDrag();
    const map = this.map;
    map.off('move', this.layout);
    map.off('resize', this.layout);
    map.off('mousedown', this.onMapMouseDown);
    map.off('touchstart', this.onMapTouchStart);
    map.off('mousemove', this.onMapHover);
    map.getContainer().removeEventListener('pointerdown', this.recordPointer, true);
    this.element.remove();
  }

  // ---------------------------------------------------------------- drawing

  private makeHandle(className: string, label: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `area-handle ${className}`;
    el.setAttribute('aria-label', label);
    el.innerHTML = '<span class="area-handle-dot" aria-hidden="true"></span>';
    this.element.appendChild(el);
    return el;
  }

  private readonly layout = (): void => {
    if (this.destroyed) return;
    const map = this.map;
    const points = this.screen;
    points.length = 0;
    let path = '';
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    // The ring is closed: skip the repeated last point.
    for (let i = 0; i < this.ring.length - 1; i++) {
      const p = map.project(this.ring[i]);
      points.push(p.x, p.y);
      path += `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    path += 'Z';
    this.fill.setAttribute('d', path);
    this.casing.setAttribute('d', path);
    this.outline.setAttribute('d', path);

    const center = map.project(this.area.center);
    let box = '';
    this.corners.forEach((corner, i) => {
      const p = map.project(this.cornerGeo[i]);
      corner.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      box += `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      // Resize cursor along the diagonal as drawn, whatever the rotation.
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      corner.el.style.cursor = dx * dy < 0 ? 'nesw-resize' : 'nwse-resize';
    });
    this.box.setAttribute('d', this.area.shape === 'rectangle' ? '' : `${box}Z`);

    const top = map.project(this.topGeo);
    let dx = top.x - center.x;
    let dy = top.y - center.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      dx = 0;
      dy = -1;
    } else {
      dx /= length;
      dy /= length;
    }
    const hx = top.x + dx * ROTATE_OFFSET;
    const hy = top.y + dy * ROTATE_OFFSET;
    this.rotateHandle.style.transform = `translate(${hx}px, ${hy}px)`;
    this.stem.setAttribute('x1', top.x.toFixed(1));
    this.stem.setAttribute('y1', top.y.toFixed(1));
    this.stem.setAttribute('x2', hx.toFixed(1));
    this.stem.setAttribute('y2', hy.toFixed(1));

    if (this.piece) {
      // Piece millimetres (y down) to screen pixels, from where the area's own
      // axes land half a width out. The map is seen from straight above, so
      // over one area this is as good as projecting every point.
      const [wx, wy, ww, wh] = this.piece.window;
      const ax = map.project(this.axisGeo[0]);
      const ay = map.project(this.axisGeo[1]);
      const k = 2 / ww;
      const a = (ax.x - center.x) * k;
      const b = (ax.y - center.y) * k;
      const c = -(ay.x - center.x) * k;
      const d = -(ay.y - center.y) * k;
      const cx = wx + ww / 2;
      const cy = wy + wh / 2;
      const e = center.x - a * cx - c * cy;
      const f = center.y - b * cx - d * cy;
      this.pieceGroup.setAttribute('transform', `matrix(${a} ${b} ${c} ${d} ${e} ${f})`);
      // The margin and border reach past the window, so keep the label clear of them.
      const [x0, y0, w0, h0] = this.piece.canvas;
      for (const [u, v] of [
        [x0, y0],
        [x0 + w0, y0],
        [x0, y0 + h0],
        [x0 + w0, y0 + h0],
      ]) {
        const sx = a * u + c * v + e;
        const sy = b * u + d * v + f;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      }
    }

    // Handles crowd each other on a tiny outline: hide them until zoomed in.
    const span = Math.max(maxX - minX, maxY - minY);
    this.element.classList.toggle('is-tiny', span < 36);

    const view = map.getContainer();
    const { width, height } = this.labelSize;
    let lx = center.x - width / 2;
    let ly = maxY + LABEL_GAP;
    lx = Math.min(Math.max(EDGE, lx), view.clientWidth - width - EDGE);
    ly = Math.min(Math.max(EDGE, ly), view.clientHeight - height - EDGE - 28);
    this.label.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
  };

  private contains(x: number, y: number): boolean {
    const p = this.screen;
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i];
      const yi = p[i + 1];
      const xj = p[j];
      const yj = p[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------------------------------------------------------------- input

  private readonly recordPointer = (event: PointerEvent): void => {
    this.lastDown = { id: event.pointerId, type: event.pointerType };
  };

  private readonly onMapHover = (event: MapMouseEvent): void => {
    if (this.drag) return;
    const inside = this.contains(event.point.x, event.point.y);
    if (inside === this.hovering) return;
    this.hovering = inside;
    this.map.getCanvas().style.cursor = inside ? 'move' : '';
  };

  private readonly onMapMouseDown = (event: MapMouseEvent): void => {
    if (this.drag || event.originalEvent.button !== 0) return;
    if (!this.contains(event.point.x, event.point.y)) return;
    event.preventDefault();
    const id = this.lastDown?.type === 'mouse' ? this.lastDown.id : 1;
    this.beginDrag('move', id, event.originalEvent.clientX, event.originalEvent.clientY);
  };

  private readonly onMapTouchStart = (event: MapTouchEvent): void => {
    if (event.points.length !== 1) {
      // A second finger: hand the gesture back to the map for pinch zoom.
      if (this.drag?.kind === 'move') this.endDrag();
      return;
    }
    if (this.drag || !this.contains(event.point.x, event.point.y)) return;
    event.preventDefault();
    const touch = event.originalEvent.touches[0];
    const id = this.lastDown && this.lastDown.type !== 'mouse' ? this.lastDown.id : -1;
    this.beginDrag('move', id, touch.clientX, touch.clientY);
  };

  private onHandleDown(event: PointerEvent, kind: 'resize' | 'rotate', corner?: Corner): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (kind === 'resize' && !this.resizable) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best effort. Window listeners still track the drag.
    }
    this.beginDrag(kind, event.pointerId, event.clientX, event.clientY, corner, handle);
  }

  private beginDrag(kind: DragKind, pointerId: number, clientX: number, clientY: number, corner?: Corner, handle?: HTMLElement): void {
    const rect = this.map.getCanvasContainer().getBoundingClientRect();
    const start: AreaSpec = { ...this.area, center: [this.area.center[0], this.area.center[1]] };
    const drag: Drag = {
      kind,
      pointerId,
      start,
      projection: new Projection(start.center, start.rotationDeg, 1),
      rect,
      corner,
      handle,
    };
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (kind === 'move') {
      const at = this.map.unproject([x, y]);
      drag.grab = [at.lng, at.lat];
    } else if (kind === 'rotate') {
      drag.grabAngle = this.bearingFromCenter(start, x, y);
    }
    this.drag = drag;
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragEnd);
    window.addEventListener('keydown', this.onDragKey, true);
    this.element.classList.add('is-dragging', `is-${kind}`);
    document.documentElement.classList.add('is-area-dragging');
    if (kind === 'move') this.map.getCanvas().style.cursor = 'grabbing';
    this.options.onDragStart?.();
  }

  private readonly onDragMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    // A touch drag started from a MapLibre touch event may not know its pointer id.
    if (drag.pointerId === -1 && event.pointerType !== 'mouse') drag.pointerId = event.pointerId;
    if (event.pointerId !== drag.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      this.endDrag();
      return;
    }
    const x = event.clientX - drag.rect.left;
    const y = event.clientY - drag.rect.top;
    let next: AreaSpec;
    if (drag.kind === 'move') next = this.moved(drag, x, y);
    else if (drag.kind === 'resize') next = this.resized(drag, x, y, event.altKey);
    else next = this.rotated(drag, x, y, event.shiftKey);
    this.options.onChange(next);
  };

  private readonly onDragEnd = (event: PointerEvent): void => {
    if (this.drag && (event.pointerId === this.drag.pointerId || this.drag.pointerId === -1)) this.endDrag();
  };

  private readonly onDragKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    const start = this.drag.start;
    this.endDrag();
    this.options.onChange(start);
  };

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragEnd);
    window.removeEventListener('keydown', this.onDragKey, true);
    try {
      if (drag.handle?.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released.
    }
    this.element.classList.remove('is-dragging', 'is-move', 'is-resize', 'is-rotate');
    document.documentElement.classList.remove('is-area-dragging');
    this.hovering = false;
    this.map.getCanvas().style.cursor = '';
  }

  // ----------------------------------------------------------------- maths

  private moved(drag: Drag, x: number, y: number): AreaSpec {
    const at = this.map.unproject([x, y]);
    const grab = drag.grab!;
    const lon = wrapLongitude(drag.start.center[0] + (at.lng - grab[0]));
    const lat = Math.max(-LATITUDE_LIMIT, Math.min(LATITUDE_LIMIT, drag.start.center[1] + (at.lat - grab[1])));
    return { ...drag.start, center: [lon, lat] };
  }

  // The opposite corner stays put. Alt resizes around the centre instead.
  private resized(drag: Drag, x: number, y: number, fromCenter: boolean): AreaSpec {
    const at = this.map.unproject([x, y]);
    const [px, py] = drag.projection.toLocal(at.lng, at.lat);
    const { sx, sy } = drag.corner!;
    const start = drag.start;
    const fx = fromCenter ? 0 : (-sx * start.widthM) / 2;
    const fy = fromCenter ? 0 : (-sy * start.heightM) / 2;
    const scale = fromCenter ? 2 : 1;
    let [width, height] = constrainSize(start.shape, scale * sx * (px - fx), scale * sy * (py - fy), 'larger');
    if (this.aspect) {
      width = Math.max(width, height / this.aspect);
      height = width * this.aspect;
    }
    const cx = fromCenter ? 0 : fx + (sx * width) / 2;
    const cy = fromCenter ? 0 : fy + (sy * height) / 2;
    const center = drag.projection.localToGeo(cx, cy);
    return { ...start, center, widthM: width, heightM: height };
  }

  private rotated(drag: Drag, x: number, y: number, coarse: boolean): AreaSpec {
    const angle = this.bearingFromCenter(drag.start, x, y);
    const rotation = snapRotation(drag.start.rotationDeg + (angle - (drag.grabAngle ?? angle)), coarse);
    return { ...drag.start, rotationDeg: rotation };
  }

  /** Bearing of a screen point seen from the area centre, clockwise from north. */
  private bearingFromCenter(area: AreaSpec, x: number, y: number): number {
    const c = this.map.project(area.center);
    return (Math.atan2(x - c.x, -(y - c.y)) * 180) / Math.PI + this.map.getBearing();
  }

  // -------------------------------------------------------------- keyboard

  private onCornerKey(event: KeyboardEvent): void {
    const grow = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!grow || !this.resizable) return;
    event.preventDefault();
    const factor = 1 + grow * (event.shiftKey ? 0.1 : 0.02);
    const area = this.area;
    const [width, height] = constrainSize(area.shape, area.widthM * factor, area.heightM * factor, 'width');
    this.options.onChange({ ...area, widthM: width, heightM: area.shape === 'rectangle' || area.shape === 'rounded' ? Math.round(area.heightM * factor) : height });
  }

  private onRotateKey(event: KeyboardEvent): void {
    const turn = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!turn) return;
    event.preventDefault();
    const step = event.shiftKey ? 15 : 1;
    const rotation = event.shiftKey ? Math.round(this.area.rotationDeg / 15) * 15 + turn * step : this.area.rotationDeg + turn * step;
    this.options.onChange({ ...this.area, rotationDeg: event.shiftKey ? snapRotation(rotation, true) : normalizeRotation(rotation) });
  }
}
