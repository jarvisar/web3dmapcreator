// Pointer handling while the model is edited. Dragging still orbits, so a
// click is a press and release that barely moved. Handles take the drag
// instead: the arrow on top of a selected building or shape sets its height,
// a selected shape moves with the pointer, and a path's or area's points
// move one by one (the dots between them add a point). Tapping a point picks
// it, to delete it. Shift and drag selects everything in a box, and so does a
// plain drag with the Select several tool, where a click adds or drops one
// thing. On a touch screen a drag there still turns the view.

import {
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type { Projection } from '../../core/geo/projection';
import { kindOf } from '../../core/edit/keys';
import type { ObjectFacts } from '../../core/edit/session';
import { emptyEdits, followsGround, MAX_SHAPE_POINTS, type AddedShape, type ModelEdits } from '../../core/edit/types';
import type { EditTool } from '../state/store';
import type { HoverTarget, PickTarget, ViewerEngine } from './ViewerEngine';

const CLICK_PX = 5;
const HANDLE_PX = 14;
const HOVER_MS = 45;
const ACCENT = '#2f7cf6';

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
  /** How far the tool's drawing has got, for the hint. */
  drawing(points: number): void;
  dragHeight(key: string, heightMm: number, done: boolean): void;
  moveShape(id: string, dx: number, dy: number, done: boolean): void;
  moveVertex(id: string, index: number, point: Vector3, insert: boolean, done: boolean): void;
}

interface Handle {
  kind: 'height' | 'vertex' | 'insert';
  key: string;
  index: number;
  position: Vector3;
}

type Drag =
  | { kind: 'height'; key: string; anchor: Vector3; from: number; height: number; moved: boolean }
  | { kind: 'shape'; id: string; z: number; start: Vector3; moved: boolean; x: number; y: number; target: PickTarget }
  | { kind: 'vertex'; id: string; index: number; insert: boolean; z: number; moved: boolean; x: number; y: number; position: Vector3 }
  /** `click`: a press that doesn't move is a click, with Select several. */
  | { kind: 'box'; x: number; y: number; additive: boolean; click: boolean }
  /** A press already handled, kept from the orbit controls until release. */
  | { kind: 'consumed' };

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
  private down: { x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean; id: number } | null = null;
  private drag: Drag | null = null;
  private handles: Handle[] = [];
  private readonly gizmo = new Group();
  private readonly guide = new Group();
  private drawingPoints: Vector3[] = [];
  private cursor: Vector3 | null = null;
  private hoverTimer = 0;
  private lastHover = 0;
  private pending: { x: number; y: number } | null = null;
  private readonly box: HTMLDivElement;
  private readonly handleMaterial = new MeshBasicMaterial({ color: ACCENT, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly insertMaterial = new MeshBasicMaterial({ color: '#ffffff', depthTest: false, depthWrite: false, toneMapped: false });
  private readonly activeMaterial = new MeshBasicMaterial({ color: '#f76707', depthTest: false, depthWrite: false, toneMapped: false });
  private readonly lineMaterial = new LineBasicMaterial({ color: ACCENT, depthTest: false, toneMapped: false });

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
    engine.overlay.add(this.gizmo, this.guide);
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
      this.engine.setHover(null);
      this.handlers.hover(null, 0, 0);
    }
    this.host.classList.toggle('is-placing', state.enabled && state.tool !== 'select');
    // A drag in progress keeps its handles where they are.
    if (!this.drag) this.rebuild();
  }

  /** Finishes a path or area being drawn, as a double-click or Enter does. */
  finishDrawing(): boolean {
    const tool = this.state.tool;
    if ((tool !== 'path' && tool !== 'area') || !this.drawingPoints.length) return false;
    const needed = tool === 'path' ? 2 : 3;
    if (this.drawingPoints.length >= needed) this.handlers.draw(tool, this.drawingPoints);
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
    this.engine.overlay.remove(this.gizmo, this.guide);
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
  };

  private readonly onDown = (event: PointerEvent): void => {
    if (!this.state.enabled || event.button !== 0 || !this.isCanvas(event)) return;
    this.down = { x: event.clientX, y: event.clientY, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, id: event.pointerId };
    if (this.state.tool === 'several') {
      if (event.pointerType === 'touch') return;
      this.takeOver(event);
      this.drag = { kind: 'box', x: event.clientX, y: event.clientY, additive: true, click: true };
      return;
    }
    if (this.state.tool !== 'select') return;
    const handle = this.handleAt(event.clientX, event.clientY);
    if (handle?.kind === 'vertex' && event.altKey) {
      this.takeOver(event);
      this.drag = { kind: 'consumed' };
      this.handlers.deleteVertex(handle.key.slice(2), handle.index);
      return;
    }
    if (handle) {
      this.startHandle(handle, event);
      return;
    }
    if (event.shiftKey && event.pointerType === 'mouse') {
      this.takeOver(event);
      this.drag = { kind: 'box', x: event.clientX, y: event.clientY, additive: true, click: false };
      return;
    }
    // Pressing on a selected shape moves it.
    const target = this.engine.pickAt(event.clientX, event.clientY);
    if (target?.key && kindOf(target.key) === 'shape' && this.state.selection.includes(target.key)) {
      this.takeOver(event);
      this.drag = { kind: 'shape', id: target.key.slice(2), z: target.point.z, start: target.point.clone(), moved: false, x: event.clientX, y: event.clientY, target };
    }
  };

  private readonly onMove = (event: PointerEvent): void => {
    if (!this.state.enabled) return;
    const drag = this.drag;
    if (drag) {
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
    const down = this.down;
    this.down = null;
    const drag = this.drag;
    if (drag) {
      this.drag = null;
      this.engine.controls.enabled = true;
      if (drag.kind === 'shape' && !drag.moved) {
        this.handlers.select(drag.target, { additive: Boolean(down?.shift || down?.ctrl), part: Boolean(down?.alt) });
      } else if (drag.kind === 'vertex' && !drag.moved) {
        // A tap on a point picks it. One on a dot between points adds a point there.
        if (drag.insert) {
          this.handlers.moveVertex(drag.id, drag.index, drag.position, true, true);
          this.handlers.activatePoint(drag.id, drag.index + 1);
        } else {
          this.handlers.activatePoint(drag.id, drag.index);
        }
      } else if (drag.kind === 'box' && drag.click && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= CLICK_PX) {
        this.box.hidden = true;
        this.click(event.clientX, event.clientY, { additive: true, part: Boolean(down?.alt) });
      } else {
        this.dragTo(drag, event.clientX, event.clientY, true);
      }
      this.rebuild();
      return;
    }
    if (!down || !this.state.enabled || down.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_PX) return;
    this.click(event.clientX, event.clientY, { additive: down.shift || down.ctrl, part: down.alt });
  };

  private readonly onCancel = (): void => {
    if (this.drag) this.engine.controls.enabled = true;
    this.drag = null;
    this.down = null;
    this.box.hidden = true;
  };

  private readonly onLeave = (): void => {
    this.pending = null;
    this.cursor = null;
    this.updateGuide();
    this.engine.setHover(null);
    this.handlers.hover(null, 0, 0);
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (!this.state.enabled || !this.isCanvas(event)) return;
    if (this.finishDrawing()) event.preventDefault();
  };

  private isCanvas(event: Event): boolean {
    return event.target === this.engine.canvas;
  }

  /** Takes the drag away from the orbit controls, which see this press next. */
  private takeOver(event: PointerEvent): void {
    this.engine.controls.enabled = false;
    event.preventDefault();
  }

  private click(x: number, y: number, modifiers: { additive: boolean; part: boolean }): void {
    const tool = this.state.tool;
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
    const selecting = tool === 'select' || tool === 'several';
    const target = selecting ? this.engine.hoverAt(at.x, at.y) : this.engine.pickAt(at.x, at.y);
    if (selecting) {
      this.engine.setHover(target?.key ?? null);
      this.handlers.hover(target, at.x, at.y);
      this.host.classList.toggle('is-over-handle', this.handleAt(at.x, at.y) !== null);
    } else {
      this.engine.setHover(null);
      this.handlers.hover(null, at.x, at.y);
      this.cursor = target?.point ? target.point.clone() : null;
      this.updateGuide();
    }
  }

  /** Where a click lands for drawing: on the ground, or on top of what's there. */
  private surfacePoint(target: PickTarget): Vector3 {
    return target.point.clone();
  }

  // -------------------------------------------------------------- handles

  private handleAt(x: number, y: number): Handle | null {
    let best: Handle | null = null;
    let bestDistance = HANDLE_PX;
    for (const handle of this.handles) {
      const p = this.engine.project(handle.position);
      if (p.behind) continue;
      const d = Math.hypot(p.x - (x - this.hostRect().left), p.y - (y - this.hostRect().top));
      // Points win over the arrow where they meet.
      const bias = handle.kind === 'height' ? 2 : 0;
      if (d + bias < bestDistance) {
        best = handle;
        bestDistance = d + bias;
      }
    }
    return best;
  }

  private hostRect(): DOMRect {
    return this.engine.canvas.getBoundingClientRect();
  }

  private startHandle(handle: Handle, event: PointerEvent): void {
    this.takeOver(event);
    if (handle.kind === 'height') {
      const height = this.heightOf(handle.key, handle.position.z);
      const from = this.engine.pointOnVertical(event.clientX, event.clientY, handle.position) ?? handle.position.z;
      this.drag = { kind: 'height', key: handle.key, anchor: handle.position.clone(), from, height, moved: false };
      return;
    }
    this.drag = {
      kind: 'vertex',
      id: handle.key.slice(2),
      index: handle.index,
      insert: handle.kind === 'insert',
      z: handle.position.z,
      moved: false,
      x: event.clientX,
      y: event.clientY,
      position: handle.position.clone(),
    };
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
        this.handlers.dragHeight(drag.key, Math.round(height * 100) / 100, done);
        return;
      }
      case 'shape': {
        const point = this.engine.pointOnPlane(x, y, drag.z);
        if (!point) return;
        drag.moved ||= Math.hypot(x - drag.x, y - drag.y) > CLICK_PX;
        if (!drag.moved) return;
        this.handlers.moveShape(drag.id, point.x - drag.start.x, point.y - drag.start.y, done);
        return;
      }
      case 'vertex': {
        if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) <= CLICK_PX) return;
        const point = this.engine.pointOnPlane(x, y, drag.z);
        if (!point) return;
        drag.moved = true;
        this.handlers.moveVertex(drag.id, drag.index, point, drag.insert, done);
        // An inserted point is an ordinary one once it's in.
        if (drag.insert && !done) {
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
      const base = new Mesh(new RingGeometry(0.14, 0.24, 20), this.handleMaterial);
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
      child.scale.setScalar(distance * 0.03);
    }
    const guide = this.guide.children;
    for (const child of guide) if (child.userData.scaled) child.scale.setScalar(camera.position.distanceTo(child.position) * 0.02);
    this.engine.requestRender();
  };

  private updateGuide(): void {
    this.clearGroup(this.guide);
    const points = [...this.drawingPoints];
    const tool = this.state.tool;
    if (this.state.enabled && tool !== 'select' && this.cursor) {
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

  private clearGroup(group: Group): void {
    for (const child of [...group.children]) {
      child.traverse((object) => {
        const mesh = object as Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      group.remove(child);
    }
  }
}
