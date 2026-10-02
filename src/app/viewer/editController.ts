// Pointer handling while the model is edited. Dragging still orbits, so a
// click is a press and release that barely moved. Handles take the drag
// instead: the arrow on top of a selected building or shape sets its height,
// a selected shape moves with the pointer, and a path's or area's points
// move one by one (the dots between them add a point). Tapping a point picks
// it, to delete it. Shift and click adds to the selection, and Shift and drag
// selects everything in a box. So does a plain drag with the Select several
// tool, where a click adds or drops one thing. On a touch screen a drag there
// still turns the view.
//
// A drag follows the pointer that started it. A second finger during one
// puts it back and hands both fingers to the view, for a pinch.
//
// With Split a road a click on a road splits it there into two blocks, and a
// click on a split takes it out again (viewer/blocks.ts). Splits show as
// orange bars across the road while editing, and the bar a click would make
// follows the pointer.

import {
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type { Projection } from '../../core/geo/projection';
import { roadEdits, roadSegment } from '../../core/edit/blocks';
import { kindOf } from '../../core/edit/keys';
import { splitTarget, type SplitTarget } from './blocks';
import type { RoadMark, RoadPick } from './roads';
import type { ObjectFacts } from '../../core/edit/session';
import { emptyEdits, followsGround, MAX_SHAPE_POINTS, type AddedShape, type ModelEdits } from '../../core/edit/types';
import type { EditTool } from '../state/store';
import type { HoverTarget, PickTarget, ViewerEngine } from './ViewerEngine';

const CLICK_PX = 5;
const HANDLE_PX = 14;
const HOVER_MS = 45;
const ACCENT = '#2f7cf6';
/** Handles are drawn this many times their distance from the camera, so they keep their size on screen. */
const HANDLE_SCALE = 0.03;
/** The arrow's head ends this far up, in handle units. */
const ARROW_TIP = 1.425;
/** Below this the arrow is its foot, over the middle of the top it's on, which a press there means to move. */
const ARROW_GRAB_FROM = 0.45;
/** The arrow is put away seen from within about 17 degrees of straight down. */
const ARROW_MIN_SIN = 0.3;
/** The ring round the arrow's foot, in handle units. */
const RING_RADIUS = 0.24;
/** A split's bar along the road, as a share of its distance from the camera, so it stays visible zoomed out. */
const BAR_SCALE = 0.004;
/** How far a split's bar reaches past the road's edges, in mm. */
const BAR_REACH_MM = 0.25;

export interface EditHandlers {
  /** `part` picks one part of a building rather than the whole of it. */
  select(target: PickTarget | null, modifiers: { additive: boolean; part: boolean }): void;
  deleteVertex(id: string, index: number): void;
  /** A point of a path or area was tapped. */
  activatePoint(id: string, index: number): void;
  boxSelect(keys: string[], additive: boolean): void;
  hover(target: HoverTarget | null, clientX: number, clientY: number): void;
  place(tool: EditTool, target: PickTarget): void;
  draw(tool: 'path' | 'area', points: Vector3[]): void;
  /** A click with Split a road: split there, join a split, or nothing at a junction. */
  split(target: SplitTarget): void;
  /** How far the tool's drawing has got, for the hint. */
  drawing(points: number): void;
  /** Finishing was asked for with fewer points than the shape needs. The drawing goes on. */
  tooFewPoints(tool: 'path' | 'area', needed: number): void;
  /** A drag of an arrow, a shape or a point starts. Its changes undo as one. */
  dragStart(): void;
  /** It ended, or was called off (`cancelled`) and what it changed goes back. */
  dragEnd(cancelled: boolean): void;
  dragHeight(key: string, heightMm: number): void;
  moveShape(id: string, dx: number, dy: number): void;
  moveVertex(id: string, index: number, point: Vector3, insert: boolean): void;
}

interface Handle {
  kind: 'height' | 'vertex' | 'insert';
  key: string;
  index: number;
  position: Vector3;
}

type DragKind =
  | { kind: 'height'; key: string; anchor: Vector3; from: number; height: number; moved: boolean }
  | { kind: 'shape'; id: string; z: number; start: Vector3; moved: boolean; x: number; y: number; target: PickTarget }
  | { kind: 'vertex'; id: string; index: number; insert: boolean; z: number; moved: boolean; x: number; y: number; position: Vector3 }
  /** `click`: a press that doesn't move is a click, with Select several or Shift. */
  | { kind: 'box'; x: number; y: number; additive: boolean; click: boolean }
  /** A press already handled, kept from the orbit controls until release. */
  | { kind: 'consumed' };

/** A drag and the pointer it follows. */
type Drag = DragKind & { pointer: number; touch: boolean; lastX: number; lastY: number };

export interface EditState {
  enabled: boolean;
  tool: EditTool;
  selection: string[];
  edits: ModelEdits;
  facts: Record<string, ObjectFacts>;
  projection: Projection | null;
  activePoint: { shape: string; index: number } | null;
}

export class EditController {
  private state: EditState = { enabled: false, tool: 'select', selection: [], edits: emptyEdits(), facts: {}, projection: null, activePoint: null };
  /** The press a click would come from. `multi`: another finger joined it, so it's a pinch. */
  private down: { x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean; id: number; multi: boolean } | null = null;
  /** Pointers down on the canvas. */
  private readonly pressed = new Set<number>();
  private drag: Drag | null = null;
  private handingOver = false;
  private handles: Handle[] = [];
  private readonly gizmo = new Group();
  private readonly guide = new Group();
  /** The splits of every road, as bars across them. */
  private readonly marks = new Group();
  private marksKey = '';
  private drawingPoints: Vector3[] = [];
  private cursor: Vector3 | null = null;
  /** Where the split tool's click would land, and what it would do. */
  private splitPreview: { target: SplitTarget; mark: RoadMark } | null = null;
  private hoverTimer = 0;
  private lastHover = 0;
  private pending: { x: number; y: number } | null = null;
  private readonly box: HTMLDivElement;
  private readonly handleMaterial = new MeshBasicMaterial({ color: ACCENT, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly insertMaterial = new MeshBasicMaterial({ color: '#ffffff', depthTest: false, depthWrite: false, toneMapped: false });
  private readonly activeMaterial = new MeshBasicMaterial({ color: '#f76707', depthTest: false, depthWrite: false, toneMapped: false });
  private readonly lineMaterial = new LineBasicMaterial({ color: ACCENT, depthTest: false, toneMapped: false });
  private readonly splitMaterial = new MeshBasicMaterial({ color: '#f76707', depthTest: false, depthWrite: false, toneMapped: false, side: DoubleSide });
  private readonly joinMaterial = new MeshBasicMaterial({ color: '#ffffff', depthTest: false, depthWrite: false, toneMapped: false, side: DoubleSide });
  private readonly barGeometry = new PlaneGeometry(1, 1);

  constructor(
    private readonly engine: ViewerEngine,
    private readonly host: HTMLElement,
    private readonly handlers: EditHandlers,
  ) {
    host.addEventListener('pointerdown', this.onDown, { capture: true });
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerleave', this.onLeave);
    host.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
    engine.controls.addEventListener('change', this.layout);
    engine.geometryListeners.add(this.onGeometry);
    engine.overlay.add(this.gizmo, this.guide, this.marks);
    this.box = document.createElement('div');
    this.box.className = 'viewer-box-select';
    this.box.hidden = true;
    host.appendChild(this.box);
  }

  setState(state: EditState): void {
    const toolChanged = state.tool !== this.state.tool || state.enabled !== this.state.enabled;
    this.state = state;
    if (toolChanged) this.cancelDrawing();
    if (!state.enabled) {
      if (this.drag) this.endDrag(false);
      this.engine.setHover(null);
      this.handlers.hover(null, 0, 0);
    }
    this.host.classList.toggle('is-placing', state.enabled && state.tool !== 'select');
    if (!state.enabled || state.tool !== 'select') this.setCursor(null);
    // A drag in progress keeps its handles where they are.
    if (!this.drag) this.rebuild();
    this.rebuildMarks();
  }

  /** Finishes a path or area being drawn, as a double-click or Enter does. */
  finishDrawing(): boolean {
    const tool = this.state.tool;
    if ((tool !== 'path' && tool !== 'area') || !this.drawingPoints.length) return false;
    const needed = tool === 'path' ? 2 : 3;
    if (this.drawingPoints.length < needed) {
      this.handlers.tooFewPoints(tool, needed);
      return true;
    }
    this.handlers.draw(tool, this.drawingPoints);
    this.cancelDrawing();
    return true;
  }

  /** Drops the last point drawn. */
  undoPoint(): boolean {
    if (!this.drawingPoints.length) return false;
    this.drawingPoints.pop();
    this.handlers.drawing(this.drawingPoints.length);
    this.updateGuide();
    return true;
  }

  cancelDrawing(): boolean {
    const had = this.drawingPoints.length > 0;
    this.drawingPoints = [];
    this.handlers.drawing(0);
    this.updateGuide();
    return had;
  }

  /** Calls off a drag in progress, putting back what it changed. */
  cancelDrag(): boolean {
    if (!this.drag) return false;
    this.endDrag(true);
    // No click when the button comes up.
    this.down = null;
    return true;
  }

  dispose(): void {
    this.host.removeEventListener('pointerdown', this.onDown, { capture: true });
    this.host.removeEventListener('pointermove', this.onMove);
    this.host.removeEventListener('pointerleave', this.onLeave);
    this.host.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    this.engine.controls.removeEventListener('change', this.layout);
    this.engine.geometryListeners.delete(this.onGeometry);
    clearTimeout(this.hoverTimer);
    this.clearGroup(this.gizmo);
    this.clearGroup(this.guide);
    this.clearGroup(this.marks, true);
    this.engine.overlay.remove(this.gizmo, this.guide, this.marks);
    this.splitMaterial.dispose();
    this.joinMaterial.dispose();
    this.barGeometry.dispose();
    this.handleMaterial.dispose();
    this.insertMaterial.dispose();
    this.activeMaterial.dispose();
    this.lineMaterial.dispose();
    this.box.remove();
  }

  // --------------------------------------------------------------- events

  /** New geometry from the worker: the arrow goes on the new top. A drag keeps its own. */
  private readonly onGeometry = (): void => {
    if (!this.drag) this.rebuild();
    this.marksKey = '';
    this.rebuildMarks();
  };

  private readonly onDown = (event: PointerEvent): void => {
    if (this.handingOver || !this.state.enabled || !this.isCanvas(event)) return;
    // A first pointer means no others are down, whatever release went missing.
    if (event.isPrimary) {
      this.pressed.clear();
      if (this.drag) this.endDrag(false);
    }
    this.pressed.add(event.pointerId);
    if (this.drag) {
      if (this.drag.touch && event.pointerType === 'touch') this.pinchInstead();
      return;
    }
    if (this.pressed.size > 1) {
      // A second finger: a pinch or a pan, never a click.
      if (this.down) this.down.multi = true;
      return;
    }
    if (event.button !== 0) return;
    this.down = { x: event.clientX, y: event.clientY, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, id: event.pointerId, multi: false };
    if (this.state.tool === 'several') {
      if (event.pointerType === 'touch') return;
      this.begin(event, { kind: 'box', x: event.clientX, y: event.clientY, additive: true, click: true });
      return;
    }
    if (this.state.tool !== 'select') return;
    const handle = this.handleAt(event.clientX, event.clientY);
    if (handle?.kind === 'vertex' && event.altKey) {
      this.begin(event, { kind: 'consumed' });
      this.handlers.deleteVertex(handle.key.slice(2), handle.index);
      return;
    }
    if (handle) {
      this.startHandle(handle, event);
      return;
    }
    if (event.shiftKey && event.pointerType === 'mouse') {
      this.begin(event, { kind: 'box', x: event.clientX, y: event.clientY, additive: true, click: true });
      return;
    }
    // Pressing on a selected shape moves it, and so does pressing on its
    // arrow's foot, which is drawn over whatever is behind.
    const target = this.engine.pickAt(event.clientX, event.clientY);
    if (target?.key && kindOf(target.key) === 'shape' && this.state.selection.includes(target.key)) {
      this.begin(event, { kind: 'shape', id: target.key.slice(2), z: target.point.z, start: target.point.clone(), moved: false, x: event.clientX, y: event.clientY, target });
      return;
    }
    const foot = this.footAt(event.clientX, event.clientY);
    if (foot) {
      const z = foot.position.z;
      const start = this.engine.pointOnPlane(event.clientX, event.clientY, z) ?? foot.position.clone();
      const own = { key: foot.key, sub: '', part: '', point: foot.position.clone(), ground: null };
      this.begin(event, { kind: 'shape', id: foot.key.slice(2), z, start, moved: false, x: event.clientX, y: event.clientY, target: own });
    }
  };

  private readonly onMove = (event: PointerEvent): void => {
    if (!this.state.enabled) return;
    const drag = this.drag;
    if (drag) {
      // Only the pointer that started it moves it.
      if (event.pointerId !== drag.pointer) return;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      this.dragTo(drag, event.clientX, event.clientY, false);
      return;
    }
    if (event.buttons) return;
    this.pending = { x: event.clientX, y: event.clientY };
    const wait = HOVER_MS - (performance.now() - this.lastHover);
    if (wait <= 0) this.hoverNow();
    else if (!this.hoverTimer) this.hoverTimer = window.setTimeout(() => this.hoverNow(), wait);
  };

  private readonly onUp = (event: PointerEvent): void => {
    this.pressed.delete(event.pointerId);
    const drag = this.drag;
    if (drag) {
      if (event.pointerId !== drag.pointer) return;
      const down = this.down;
      this.down = null;
      if (drag.kind === 'shape' && !drag.moved) {
        this.handlers.select(drag.target, { additive: Boolean(down?.shift || down?.ctrl), part: Boolean(down?.alt) });
      } else if (drag.kind === 'vertex' && !drag.moved) {
        // A tap on a point picks it. One on a dot between points adds a point there.
        if (drag.insert) {
          this.handlers.moveVertex(drag.id, drag.index, drag.position, true);
          this.handlers.activatePoint(drag.id, drag.index + 1);
        } else {
          this.handlers.activatePoint(drag.id, drag.index);
        }
      } else if (drag.kind === 'box' && drag.click && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= CLICK_PX) {
        this.click(event.clientX, event.clientY, { additive: true, part: Boolean(down?.alt) });
      } else {
        this.dragTo(drag, event.clientX, event.clientY, true);
      }
      this.endDrag(false);
      return;
    }
    const down = this.down;
    if (!down || down.id !== event.pointerId) return;
    this.down = null;
    if (down.multi || !this.state.enabled) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_PX) return;
    this.click(event.clientX, event.clientY, { additive: down.shift || down.ctrl, part: down.alt });
  };

  // The browser took the pointer, so the drag is called off rather than left half done.
  private readonly onCancel = (event: PointerEvent): void => {
    this.pressed.delete(event.pointerId);
    if (this.down?.id === event.pointerId) this.down = null;
    if (this.drag?.pointer === event.pointerId) this.endDrag(true);
  };

  private readonly onLeave = (): void => {
    this.pending = null;
    this.cursor = null;
    this.splitPreview = null;
    this.updateGuide();
    this.engine.setHover(null);
    this.handlers.hover(null, 0, 0);
    this.setCursor(null);
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (!this.state.enabled || !this.isCanvas(event)) return;
    if (this.finishDrawing()) event.preventDefault();
  };

  private isCanvas(event: Event): boolean {
    return event.target === this.engine.canvas;
  }

  /** Takes the drag away from the orbit controls, which see this press next. */
  private begin(event: PointerEvent, drag: DragKind): void {
    this.engine.controls.enabled = false;
    event.preventDefault();
    // So the drag goes on over the panels on top of the view.
    try {
      this.engine.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Not a pointer the browser knows as down.
    }
    this.drag = { ...drag, pointer: event.pointerId, touch: event.pointerType === 'touch', lastX: event.clientX, lastY: event.clientY };
    if (drag.kind === 'height' || drag.kind === 'shape' || drag.kind === 'vertex') this.handlers.dragStart();
  }

  private endDrag(cancelled: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.engine.controls.enabled = true;
    this.box.hidden = true;
    const canvas = this.engine.canvas;
    if (canvas.hasPointerCapture(drag.pointer)) canvas.releasePointerCapture(drag.pointer);
    if (drag.kind === 'height' || drag.kind === 'shape' || drag.kind === 'vertex') this.handlers.dragEnd(cancelled);
    this.rebuild();
  }

  /** A second finger on a touch drag: the drag is put back and the view gets both fingers. */
  private pinchInstead(): void {
    const drag = this.drag!;
    this.endDrag(true);
    if (this.down) this.down.multi = true;
    // The controls never saw the first finger go down. They're told now,
    // before this finger's press reaches them, so they see two.
    this.handingOver = true;
    try {
      this.engine.canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: drag.pointer,
          pointerType: 'touch',
          isPrimary: true,
          clientX: drag.lastX,
          clientY: drag.lastY,
          button: 0,
          buttons: 1,
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    } finally {
      this.handingOver = false;
    }
  }

  /** What the split tool would do at a point of the page, or null off the roads. */
  private splitAt(x: number, y: number): { target: SplitTarget; pick: RoadPick } | null {
    const roads = this.engine.roads;
    const pick = this.engine.roadPickAt(x, y);
    if (!roads || !pick) return null;
    const segment = roadSegment(pick.key);
    const splits = roadEdits(this.state.edits.objects).get(segment)?.splits ?? [];
    const target = splitTarget(roads, this.engine.blockBoundsOf(segment), splits, pick);
    return target ? { target, pick } : null;
  }

  private click(x: number, y: number, modifiers: { additive: boolean; part: boolean }): void {
    const tool = this.state.tool;
    if (tool === 'split') {
      const target = this.splitAt(x, y)?.target;
      if (target) this.handlers.split(target);
      this.splitPreview = null;
      this.updateGuide();
      return;
    }
    const target = this.engine.pickAt(x, y);
    if (tool === 'select' || tool === 'several') {
      // With Select several a click beside everything keeps what's selected.
      if (tool === 'several' && !target?.key) return;
      this.handlers.select(target, tool === 'several' ? { ...modifiers, additive: true } : modifiers);
      return;
    }
    if (!target) return;
    if (tool === 'path' || tool === 'area') {
      const point = this.surfacePoint(target);
      const previous = this.drawingPoints[this.drawingPoints.length - 1];
      if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.05) return;
      // Saved edits keep no more points than this.
      if (this.drawingPoints.length >= MAX_SHAPE_POINTS) return;
      this.drawingPoints.push(point);
      this.handlers.drawing(this.drawingPoints.length);
      this.updateGuide();
      return;
    }
    this.handlers.place(tool, target);
  }

  private hoverNow(): void {
    this.hoverTimer = 0;
    this.lastHover = performance.now();
    const at = this.pending;
    if (!at || this.drag) return;
    const tool = this.state.tool;
    if (tool === 'split') {
      const { target, pick } = this.splitAt(at.x, at.y) ?? { target: null, pick: null };
      this.engine.setHover(target?.kind === 'split' && pick ? pick.key : null);
      this.handlers.hover(null, at.x, at.y);
      this.splitPreview = target && pick ? { target, mark: target.kind === 'split' ? { piece: pick.piece, x: pick.x, y: pick.y, z: pick.z, dx: pick.dx, dy: pick.dy } : target.mark } : null;
      this.updateGuide();
      return;
    }
    const selecting = tool === 'select' || tool === 'several';
    const target = selecting ? this.engine.hoverAt(at.x, at.y) : this.engine.pickAt(at.x, at.y);
    if (selecting) {
      this.engine.setHover(target?.key ?? null);
      this.handlers.hover(target, at.x, at.y);
      // Handles are only there with Select, and only then does pressing on a selected shape move it.
      const handle = this.handleAt(at.x, at.y);
      const onShape =
        tool === 'select' && (Boolean(target?.key && kindOf(target.key) === 'shape' && this.state.selection.includes(target.key)) || this.footAt(at.x, at.y) !== null);
      this.setCursor(handle?.kind === 'height' ? 'height' : handle || onShape ? 'move' : null);
    } else {
      this.engine.setHover(null);
      this.handlers.hover(null, at.x, at.y);
      this.cursor = target?.point ? target.point.clone() : null;
      this.updateGuide();
    }
  }

  private setCursor(cursor: 'height' | 'move' | null): void {
    this.host.classList.toggle('is-over-height', cursor === 'height');
    this.host.classList.toggle('is-over-move', cursor === 'move');
  }

  /** Where a click lands for drawing: on the ground, or on top of what's there. */
  private surfacePoint(target: PickTarget): Vector3 {
    return target.point.clone();
  }

  // -------------------------------------------------------------- handles

  private handleAt(x: number, y: number): Handle | null {
    const rect = this.hostRect();
    const px = x - rect.left;
    const py = y - rect.top;
    let best: Handle | null = null;
    let bestDistance = HANDLE_PX;
    for (const handle of this.handles) {
      let d: number;
      if (handle.kind === 'height') {
        const arrow = this.arrowOnScreen(handle.position);
        if (!arrow) continue;
        // Points win over the arrow where they meet.
        d = arrowDistance(px, py, arrow) + 2;
      } else {
        const p = this.engine.project(handle.position);
        if (p.behind) continue;
        d = Math.hypot(p.x - px, p.y - py);
      }
      if (d < bestDistance) {
        best = handle;
        bestDistance = d;
      }
    }
    return best;
  }

  /**
   * Seen from nearly straight down the arrow is end on, over the middle of
   * what it's on, and dragging along it would jump by metres a pixel. It's
   * put away then, so a press there moves the shape.
   */
  private arrowShown(foot: Vector3): boolean {
    const view = foot.clone().sub(this.engine.controls.object.position);
    return Math.hypot(view.x, view.y) >= ARROW_MIN_SIN * view.length();
  }

  /** A selected shape's arrow when the point is on the ring at its foot. */
  private footAt(x: number, y: number): Handle | null {
    const handle = this.handles.find((h) => h.kind === 'height');
    if (!handle || kindOf(handle.key) !== 'shape' || !this.arrowShown(handle.position)) return null;
    const foot = handle.position;
    const view = foot.clone().sub(this.engine.controls.object.position);
    // Across the view, where the ring looks widest.
    const across = new Vector3(-view.y, view.x, 0).setLength(view.length() * HANDLE_SCALE * RING_RADIUS);
    const centre = this.engine.project(foot);
    const edge = this.engine.project(foot.clone().add(across));
    if (centre.behind) return null;
    const rect = this.hostRect();
    const reach = Math.hypot(edge.x - centre.x, edge.y - centre.y);
    return Math.hypot(x - rect.left - centre.x, y - rect.top - centre.y) <= reach ? handle : null;
  }

  /** The shaft and head of the arrow on the canvas, which take a drag, or null when it's put away. */
  private arrowOnScreen(foot: Vector3): { x0: number; y0: number; x1: number; y1: number } | null {
    if (!this.arrowShown(foot)) return null;
    const size = this.engine.controls.object.position.distanceTo(foot) * HANDLE_SCALE;
    const a = this.engine.project(new Vector3(foot.x, foot.y, foot.z + size * ARROW_GRAB_FROM));
    const b = this.engine.project(new Vector3(foot.x, foot.y, foot.z + size * ARROW_TIP));
    if (a.behind || b.behind) return null;
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }

  private hostRect(): DOMRect {
    return this.engine.canvas.getBoundingClientRect();
  }

  private startHandle(handle: Handle, event: PointerEvent): void {
    if (handle.kind === 'height') {
      const height = this.heightOf(handle.key, handle.position.z);
      const from = this.engine.pointOnVertical(event.clientX, event.clientY, handle.position) ?? handle.position.z;
      this.begin(event, { kind: 'height', key: handle.key, anchor: handle.position.clone(), from, height, moved: false });
      return;
    }
    this.begin(event, {
      kind: 'vertex',
      id: handle.key.slice(2),
      index: handle.index,
      insert: handle.kind === 'insert',
      z: handle.position.z,
      moved: false,
      x: event.clientX,
      y: event.clientY,
      position: handle.position.clone(),
    });
  }

  private dragTo(drag: Drag, x: number, y: number, done: boolean): void {
    switch (drag.kind) {
      case 'consumed':
        return;
      case 'box': {
        const rect = this.hostRect();
        const x0 = Math.min(drag.x, x) - rect.left;
        const y0 = Math.min(drag.y, y) - rect.top;
        const x1 = Math.max(drag.x, x) - rect.left;
        const y1 = Math.max(drag.y, y) - rect.top;
        if (done) {
          this.box.hidden = true;
          if (x1 - x0 > CLICK_PX || y1 - y0 > CLICK_PX) this.handlers.boxSelect(this.engine.keysInBox(x0, y0, x1, y1), drag.additive);
          return;
        }
        Object.assign(this.box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
        this.box.hidden = false;
        return;
      }
      case 'height': {
        const z = this.engine.pointOnVertical(x, y, drag.anchor);
        if (z === null) return;
        drag.moved ||= Math.abs(z - drag.from) > 1e-3;
        if (!drag.moved) return;
        const height = Math.max(0.1, drag.height + (z - drag.from));
        this.handlers.dragHeight(drag.key, Math.round(height * 100) / 100);
        return;
      }
      case 'shape': {
        const point = this.engine.pointOnPlane(x, y, drag.z);
        if (!point) return;
        drag.moved ||= Math.hypot(x - drag.x, y - drag.y) > CLICK_PX;
        if (!drag.moved) return;
        this.handlers.moveShape(drag.id, point.x - drag.start.x, point.y - drag.start.y);
        return;
      }
      case 'vertex': {
        if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) <= CLICK_PX) return;
        const point = this.engine.pointOnPlane(x, y, drag.z);
        if (!point) return;
        drag.moved = true;
        this.handlers.moveVertex(drag.id, drag.index, point, drag.insert);
        // An inserted point is an ordinary one once it's in.
        if (drag.insert) {
          drag.insert = false;
          drag.index += 1;
        }
        return;
      }
    }
  }

  /** Height a drag starts from: a shape's own, or how far a building's top stands over its ground. */
  private heightOf(key: string, top: number): number {
    if (kindOf(key) === 'shape') return this.shape(key)?.heightMm ?? 1;
    const ground = this.state.facts[key.split('/')[0]]?.groundZ;
    return ground !== undefined ? top - ground : (this.state.facts[key]?.heightMm ?? 1);
  }

  private shape(key: string): AddedShape | undefined {
    return this.state.edits.shapes.find((s) => `s:${s.id}` === key);
  }

  /** Handles for a lone selection: a height arrow, and a path's or area's points. */
  private rebuild(): void {
    this.clearGroup(this.gizmo);
    this.handles = [];
    const { enabled, tool, selection } = this.state;
    if (!enabled || tool !== 'select' || selection.length !== 1) {
      this.engine.requestRender();
      return;
    }
    const key = selection[0];
    const kind = kindOf(key);
    if (kind !== 'building' && kind !== 'shape') {
      this.engine.requestRender();
      return;
    }
    // Null for something hidden or removed, which gets no handles.
    const bounds = this.engine.boundsOf(key);
    if (!bounds) {
      this.engine.requestRender();
      return;
    }
    const top = new Vector3((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, bounds.max.z);
    this.handles.push({ kind: 'height', key, index: 0, position: top });
    const shape = kind === 'shape' ? this.shape(key) : undefined;
    const projection = this.state.projection;
    if (shape && projection && (shape.kind === 'path' || shape.kind === 'area')) {
      // A flat shape's top is where it stands now, which moves with the roof it's on.
      const flat = !followsGround(shape);
      const points = shape.points.map(([lon, lat]) => {
        const [x, y] = projection.toModel(lon, lat);
        return new Vector3(x, y, flat ? bounds.max.z : (this.engine.groundAt(x, y) ?? bounds.max.z) + shape.heightMm);
      });
      points.forEach((position, index) => this.handles.push({ kind: 'vertex', key, index, position }));
      const count = shape.points.length >= MAX_SHAPE_POINTS ? 0 : shape.kind === 'area' ? points.length : points.length - 1;
      for (let i = 0; i < count; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        this.handles.push({ kind: 'insert', key, index: i, position: a.clone().add(b).multiplyScalar(0.5) });
      }
    }
    for (const handle of this.handles) this.gizmo.add(this.handleObject(handle));
    this.layout();
  }

  private handleObject(handle: Handle): Object3D {
    if (handle.kind === 'height') {
      const group = new Group();
      const shaft = new Mesh(new CylinderGeometry(0.06, 0.06, 1, 8), this.handleMaterial);
      shaft.rotation.x = Math.PI / 2;
      shaft.position.z = 0.5;
      const cone = new Mesh(new ConeGeometry(0.22, 0.45, 16), this.handleMaterial);
      cone.rotation.x = Math.PI / 2;
      cone.position.z = 1.2;
      const base = new Mesh(new RingGeometry(0.14, RING_RADIUS, 20), this.handleMaterial);
      group.add(shaft, cone, base);
      group.position.copy(handle.position);
      group.userData.handle = handle;
      group.renderOrder = 10;
      return group;
    }
    const active = this.state.activePoint;
    const picked = handle.kind === 'vertex' && active !== null && handle.key === `s:${active.shape}` && handle.index === active.index;
    const material = picked ? this.activeMaterial : handle.kind === 'vertex' ? this.handleMaterial : this.insertMaterial;
    const sphere = new Mesh(new SphereGeometry(picked ? 0.22 : handle.kind === 'vertex' ? 0.16 : 0.11, 12, 8), material);
    sphere.position.copy(handle.position);
    sphere.userData.handle = handle;
    sphere.renderOrder = 10;
    return sphere;
  }

  /** Keeps handles the same size on screen as the camera moves. */
  private readonly layout = (): void => {
    const camera = this.engine.controls.object;
    for (const child of this.gizmo.children) {
      const distance = camera.position.distanceTo(child.position);
      child.scale.setScalar(distance * HANDLE_SCALE);
      const handle = child.userData.handle as Handle;
      if (handle.kind === 'height') child.visible = this.arrowShown(handle.position);
    }
    const guide = this.guide.children;
    for (const child of guide) if (child.userData.scaled) child.scale.setScalar(camera.position.distanceTo(child.position) * 0.02);
    for (const child of [...this.marks.children, ...guide]) if (child.userData.bar) child.scale.x = Math.max(0.08, camera.position.distanceTo(child.position) * BAR_SCALE);
    this.engine.requestRender();
  };

  /** A bar across a road at a mark: orange for a split, white for one a click takes out. */
  private bar(mark: RoadMark, material: MeshBasicMaterial): Mesh {
    const across = this.engine.roadWidth(mark.piece) + 2 * BAR_REACH_MM;
    const mesh = new Mesh(this.barGeometry, material);
    mesh.position.set(mark.x, mark.y, mark.z + this.engine.roadHeight(mark.piece) + 0.05);
    mesh.rotation.z = Math.atan2(mark.dy, mark.dx);
    mesh.scale.set(0.1, across, 1);
    mesh.userData.bar = true;
    mesh.renderOrder = 11;
    return mesh;
  }

  /** Bars across the roads at every split, while editing. */
  private rebuildMarks(): void {
    const roads = this.engine.roads;
    const { enabled, edits } = this.state;
    const marks: RoadMark[] = [];
    if (enabled && roads) {
      // On a shown piece where there's one: a split's mark is also the end of
      // the block before it, which may be removed while the next one shows.
      const shown = (piece: number) => this.engine.roadShown(piece);
      for (const [segment, entry] of roadEdits(edits.objects)) {
        for (const at of entry.splits) {
          const mark = roads.markAt(segment, at, shown);
          if (mark && shown(mark.piece)) marks.push(mark);
        }
      }
    }
    // The bars follow the width and height of the road they cross.
    const key = JSON.stringify(marks.map((m) => [m.piece, m.x, m.y, this.engine.roadWidth(m.piece), this.engine.roadHeight(m.piece)]));
    if (key === this.marksKey) return;
    this.marksKey = key;
    this.clearGroup(this.marks, true);
    for (const mark of marks) this.marks.add(this.bar(mark, this.splitMaterial));
    this.layout();
  }

  private updateGuide(): void {
    this.clearGroup(this.guide, true);
    const points = [...this.drawingPoints];
    const tool = this.state.tool;
    const preview = this.splitPreview;
    if (this.state.enabled && tool === 'split' && preview && preview.target.kind !== 'end') {
      this.guide.add(this.bar(preview.mark, preview.target.kind === 'join' ? this.joinMaterial : this.handleMaterial));
    }
    if (this.state.enabled && tool !== 'select' && tool !== 'split' && this.cursor) {
      if (tool === 'path' || tool === 'area') points.push(this.cursor);
      else {
        const ring = new Mesh(new RingGeometry(0.5, 0.75, 32), this.handleMaterial);
        ring.position.copy(this.cursor);
        ring.position.z += 0.05;
        ring.userData.scaled = true;
        this.guide.add(ring);
      }
    }
    if (points.length >= 2) {
      const coords = points.flatMap((p) => [p.x, p.y, p.z + 0.1]);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(coords, 3));
      const line = tool === 'area' && points.length >= 3 ? new LineLoop(geometry, this.lineMaterial) : new Line(geometry, this.lineMaterial);
      line.renderOrder = 10;
      this.guide.add(line);
    }
    for (const point of this.drawingPoints) {
      const dot = new Mesh(new SphereGeometry(0.16, 12, 8), this.handleMaterial);
      dot.position.copy(point);
      dot.userData.scaled = true;
      dot.renderOrder = 10;
      this.guide.add(dot);
    }
    this.layout();
  }

  /** Empties a group, disposing its geometry except the bars' shared plane. */
  private clearGroup(group: Group, bars = false): void {
    for (const child of [...group.children]) {
      child.traverse((object) => {
        const mesh = object as Mesh;
        if (mesh.geometry && !(bars && mesh.geometry === this.barGeometry)) mesh.geometry.dispose();
      });
      group.remove(child);
    }
  }
}

/**
 * Pixels from a point on the canvas to the arrow's shaft and head. Nothing
 * below where the shaft starts counts, however close: that's the foot.
 */
function arrowDistance(x: number, y: number, s: { x0: number; y0: number; x1: number; y1: number }): number {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const length = dx * dx + dy * dy;
  if (length < 1) return Infinity;
  const t = ((x - s.x0) * dx + (y - s.y0) * dy) / length;
  if (t < 0) return Infinity;
  const along = Math.min(1, t);
  return Math.hypot(x - (s.x0 + along * dx), y - (s.y0 + along * dy));
}
