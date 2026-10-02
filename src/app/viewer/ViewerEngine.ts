// Three.js scene for the generated model. Z is up and model coordinates are
// used as they are: X east, Y north, millimetres. Renders only when something
// changes, and the shadow map only when the model or its visibility changes,
// since the light is fixed to the model and orbiting cannot move shadows.
//
// Each part is drawn from its generated mesh, with the objects in it shown,
// hidden or recoloured by the edits (composed.ts). Geometry the worker sends
// for an edit (a taller building, a shape) is drawn as a second mesh per
// part, and hides the object's generated triangles. Whole parts it rebuilds
// (roads, once they're edited) replace the generated ones.

import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { groundAt } from '../../core/edit/ground';
import { isPartKey, kindOf, objectOf, twinOf } from '../../core/edit/keys';
import { FILL_PREFIX, type ObjectMesh } from '../../core/edit/session';
import { emptyEdits, type ModelEdits } from '../../core/edit/types';
import type { EditUpdate } from '../../core/engine/protocol';
import type { Palette, Printer } from '../../core/settings';
import { OVERLAP_RANK, ROLE_GROUP } from '../../core/types';
import type { ColourGroup, MaterialRole, MeshPart, PartObjects } from '../../core/types';
import type { EditData } from '../state/model';
import { ComposedMesh, type ComposedSource, type Entry } from './composed';
import { extractTriangles, overlayMaterial, setOverlay, type Soup } from './highlight';
import { Picker } from './picker';
import { RoadIndex, type RoadPick } from './roads';
import { blockLines, blocksSignature, segmentBounds } from './blocks';
import { carryEdit, editAt, parseRoadKey, roadEditOf, roadEdits as roadEditsOf } from '../../core/edit/blocks';
import type { ObjectEdit } from '../../core/edit/types';
import { entryColour, SHAPES_PART } from './shown';

export { SHAPES_PART };

export type Bounds = [number, number, number, number, number, number];

export interface ViewerCallbacks {
  onContextLost?: (lost: boolean) => void;
  /** The box around what's shown changed: edits, or parts hidden. Null with nothing shown. */
  onBounds?: (bounds: Bounds | null) => void;
}

/** What's under a point of the canvas. */
export interface PickTarget {
  /** Object or road key, or null for the ground and parts with no objects. */
  key: string | null;
  sub: string;
  part: string;
  point: Vector3;
  /** Height of the ground under the point, when known. */
  ground: number | null;
}

/** The same, from a hover, which may not know where the ray met it. */
export interface HoverTarget extends Omit<PickTarget, 'point'> {
  point: Vector3 | null;
}

interface Theme {
  bed: string;
  grid: string;
  gridMajor: string;
  border: string;
  shadow: number;
  background: [string, string];
}

const LIGHT_THEME: Theme = {
  bed: '#e3e4e6',
  grid: '#d0d2d5',
  gridMajor: '#bbbec2',
  border: '#8e9197',
  shadow: 0.2,
  background: ['#f4f5f7', '#c9ced5'],
};

const DARK_THEME: Theme = {
  bed: '#2f3034',
  grid: '#3b3c41',
  gridMajor: '#47494f',
  border: '#6c6e74',
  shadow: 0.35,
  background: ['#45474c', '#1e1f22'],
};

const SELECT_COLOUR = '#2f7cf6';
const ROAD_PARTS: Record<string, number> = { roads: 0, rail: 1, paths: 2 };
const ROAD_PART_IDS = ['roads', 'rail', 'paths'];

interface Tween {
  fromTarget: Vector3;
  toTarget: Vector3;
  from: { r: number; phi: number; theta: number };
  to: { r: number; phi: number; theta: number };
  start: number;
  duration: number;
}

interface PartView {
  id: string;
  role: MaterialRole;
  /** Set for a custom layer's own part. */
  layer: string | null;
  base: ComposedMesh;
  baseSlot: number;
  override: ComposedMesh | null;
  overrideSlot: number;
  overrideKeys: Set<string>;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function spherical(offset: Vector3) {
  const r = offset.length();
  return { r, phi: Math.acos(Math.min(1, Math.max(-1, offset.z / (r || 1)))), theta: Math.atan2(offset.y, offset.x) };
}

const EMPTY_SOURCE: ComposedSource = { positions: new Float32Array(0), indices: new Uint32Array(0) };

/** Several meshes as one, with their object runs moved along. */
function combine(meshes: ObjectMesh[]): ComposedSource {
  let vertices = 0;
  let indices = 0;
  for (const m of meshes) {
    vertices += m.mesh!.positions.length;
    indices += m.mesh!.indices.length;
  }
  const positions = new Float32Array(vertices);
  const out = new Uint32Array(indices);
  const keys: string[] = [];
  const subs: string[] = [];
  const runs: number[] = [];
  let v = 0;
  let i = 0;
  for (const { key, mesh } of meshes) {
    const m = mesh!;
    positions.set(m.positions, v);
    const vertexOffset = v / 3;
    const triangleOffset = i / 3;
    for (let k = 0; k < m.indices.length; k++) out[i + k] = m.indices[k] + vertexOffset;
    const objects = m.objects;
    if (objects) {
      const base = keys.length;
      keys.push(...objects.keys);
      subs.push(...objects.subs);
      for (let r = 0; r < objects.runs.length; r += 5) {
        runs.push(
          objects.runs[r] + base,
          objects.runs[r + 1] + triangleOffset,
          objects.runs[r + 2] + triangleOffset,
          objects.runs[r + 3] + vertexOffset,
          objects.runs[r + 4] + vertexOffset,
        );
      }
    } else if (m.indices.length) {
      keys.push(key);
      subs.push('');
      runs.push(keys.length - 1, triangleOffset, triangleOffset + m.indices.length / 3, vertexOffset, vertexOffset + m.positions.length / 3);
    }
    v += m.positions.length;
    i += m.indices.length;
  }
  const objects: PartObjects = { keys, subs, runs: Uint32Array.from(runs) };
  return { positions, indices: out, objects };
}

export class ViewerEngine {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(32, 1, 0.1, 5000);
  readonly controls: OrbitControls;
  private readonly model = new Group();
  private readonly bed = new Group();
  private readonly hoverGroup = new Group();
  private readonly selectionGroup = new Group();
  /** Drawn over everything: gizmos and drawing guides. */
  readonly overlay = new Scene();
  private readonly hemi: HemisphereLight;
  private readonly sun: DirectionalLight;
  private readonly materials = new Map<string, MeshStandardMaterial>();
  private readonly resizeObserver: ResizeObserver;
  private readonly picker = new Picker();
  private readonly hoverMaterial = overlayMaterial(SELECT_COLOUR, 0.25);
  private readonly selectMaterial = overlayMaterial(SELECT_COLOUR, 0.42);
  private readonly hoverLineMaterial = overlayMaterial(SELECT_COLOUR, 0.55);
  private readonly selectLineMaterial = overlayMaterial(SELECT_COLOUR, 0.95);
  private palette: Palette | null = null;
  private hiddenParts = new Set<string>();
  /** As generated. The bed stays put under these whatever the edits do. */
  private bounds: Bounds | null = null;
  /** What's shown now, edits included, for framing, clipping and the light. */
  private shown: Bounds | null = null;
  private printer: Printer | null = null;
  private showBed = true;
  private theme: Theme = LIGHT_THEME;
  private frame = 0;
  private tween: Tween | null = null;
  private lost = false;
  private disposed = false;
  private width = 0;
  private height = 0;

  // The model and its edits.
  private generated = new Map<string, MeshPart>();
  private readonly views = new Map<string, PartView>();
  private readonly slots: ({ view: PartView; composed: ComposedMesh } | null)[] = [null];
  /** Object geometry the worker sent, by part and key. */
  private objectMeshes = new Map<string, ObjectMesh>();
  private replaced = new Map<string, MeshPart>();
  private implicitHidden = new Set<string>();
  private edits: ModelEdits = emptyEdits();
  private data: EditData = { editable: false, roads: null, objects: {}, ground: null, frame: null };
  roads: RoadIndex | null = null;
  /** What the blocks the roads are cut into depend on, so they're cut again only when it changes. */
  private blocksKey = '';
  /** Each road piece's edit as it applies, for these edits. */
  private roadEdits = new Map<number, ObjectEdit | undefined>();
  private selection: string[] = [];
  private hovered: string | null = null;
  private centres = new Map<ComposedMesh, Float32Array>();
  /** Called when what's shown changed shape, for handles placed on it. */
  readonly geometryListeners = new Set<() => void>();

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ViewerCallbacks = {},
  ) {
    const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.domElement.className = 'viewer-canvas';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -300, 250);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.addEventListener('change', this.requestRender);
    controls.addEventListener('start', this.stopTween);
    // Connecting sets an inline `cursor: auto`, which beats the editor's cursors.
    renderer.domElement.style.cursor = '';
    this.controls = controls;

    this.hemi = new HemisphereLight(0xffffff, 0x8b95a7, 1.25);
    this.hemi.position.set(0, 0, 1);
    this.sun = new DirectionalLight(0xffffff, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 3;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.model, this.bed, this.hoverGroup, this.selectionGroup);

    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // -------------------------------------------------------------- public

  /** A new model, with the geometry its edits had so far, so the first view frames them too. */
  setModel(parts: MeshPart[], bounds: Bounds, data?: EditData, edits?: EditUpdate): void {
    const previous = this.bounds;
    this.clearModel();
    this.generated = new Map(parts.map((part) => [part.id, part]));
    this.data = data ?? { editable: false, roads: null, objects: {}, ground: null, frame: null };
    this.blocksKey = blocksSignature(this.edits);
    this.roads = this.data.roads ? new RoadIndex(blockLines(this.data.roads, this.edits)) : null;
    // Keyed by piece index, which means another piece in a new model.
    this.roadEdits.clear();
    for (const part of parts) this.buildView(part.id);
    this.bounds = bounds;
    if (edits) this.applyEditUpdate(edits);
    else this.restyle();
    this.updateLight();
    this.updateBed();
    this.updateClipping();
    // Keep the camera when a regenerated model is about the same size.
    const similar =
      previous !== null &&
      Math.abs(previous[3] - previous[0] - (bounds[3] - bounds[0])) < 0.1 * (bounds[3] - bounds[0]) &&
      Math.abs(previous[4] - previous[1] - (bounds[4] - bounds[1])) < 0.1 * (bounds[4] - bounds[1]);
    if (!similar) this.resetView(false);
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  /** Geometry the worker sent for edits: applied on top of what came before. */
  applyEditUpdate(update: EditUpdate): void {
    const touched = new Set<string>();
    const rebuilt = new Set<string>();
    if (update.reset) {
      for (const object of this.objectMeshes.values()) touched.add(object.part);
      for (const id of this.replaced.keys()) rebuilt.add(id);
      this.objectMeshes.clear();
      this.replaced.clear();
    }
    for (const object of update.objects) {
      const id = `${object.part}|${object.key}`;
      if (object.mesh) this.objectMeshes.set(id, object);
      else this.objectMeshes.delete(id);
      touched.add(object.part);
    }
    for (const { id, part } of update.parts) {
      if (part) this.replaced.set(id, part);
      else this.replaced.delete(id);
      rebuilt.add(id);
    }
    for (const id of rebuilt) this.buildView(id);
    for (const id of touched) if (!rebuilt.has(id)) this.buildOverrides(id);
    this.implicitHidden = new Set(update.hidden);
    this.restyle();
    this.refreshHighlights();
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
    for (const listener of this.geometryListeners) listener();
  }

  setEdits(edits: ModelEdits): void {
    this.edits = edits;
    this.roadEdits.clear();
    // A split, or an edit to a new stretch of a road, ends blocks somewhere new.
    const blocks = blocksSignature(edits);
    if (blocks !== this.blocksKey) {
      this.blocksKey = blocks;
      if (this.data.roads) this.roads = new RoadIndex(blockLines(this.data.roads, edits));
      for (const listener of this.geometryListeners) listener();
    }
    for (const material of this.materials.values()) material.color.set(this.colourOf(material.userData.colour as string));
    this.restyle();
    this.refreshHighlights();
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
    for (const material of this.materials.values()) material.color.set(this.colourOf(material.userData.colour as string));
    this.requestRender();
  }

  setHidden(ids: string[]): void {
    this.hiddenParts = new Set(ids);
    this.restyle();
    this.refreshHighlights();
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
    // Handles on something now hidden go with it.
    for (const listener of this.geometryListeners) listener();
  }

  setSelection(keys: string[]): void {
    this.selection = keys;
    setOverlay(this.selectionGroup, this.overlayFor(keys, false));
    this.requestRender();
  }

  setHover(key: string | null): void {
    if (key === this.hovered) return;
    this.hovered = key;
    setOverlay(this.hoverGroup, key && !this.selection.includes(key) ? this.overlayFor([key], true) : []);
    this.requestRender();
  }

  setBed(printer: Printer, visible: boolean): void {
    const changed = this.printer?.key !== printer.key;
    this.printer = printer;
    this.showBed = visible;
    if (changed) this.updateBed();
    this.bed.visible = visible;
    this.requestRender();
  }

  setTheme(dark: boolean): void {
    this.theme = dark ? DARK_THEME : LIGHT_THEME;
    this.updateBed();
    this.requestRender();
  }

  resetView(animate = true): void {
    const frame = this.framing();
    if (!frame) return;
    const { center, distance } = frame;
    const elevation = (38 * Math.PI) / 180;
    const azimuth = (-28 * Math.PI) / 180;
    const position = new Vector3(
      center.x + distance * Math.sin(azimuth) * Math.cos(elevation),
      center.y - distance * Math.cos(azimuth) * Math.cos(elevation),
      center.z + distance * Math.sin(elevation),
    );
    this.moveCamera(position, center, animate);
  }

  topView(animate = true): void {
    const frame = this.framing(true);
    if (!frame) return;
    const { center, distance } = frame;
    // Straight down is a degenerate orbit. A hair to the south keeps north up.
    this.moveCamera(new Vector3(center.x, center.y - distance * 0.002, center.z + distance), center, animate);
  }

  /** Turns to look at a point from where the camera is, a little closer if far away. */
  focusOn(point: Vector3, radius: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = Math.min(offset.length(), Math.max(radius * 6, 40));
    this.moveCamera(point.clone().add(offset.setLength(distance)), point, true);
  }

  /** PNG of the current view on the viewer background. */
  async screenshot(): Promise<Blob | null> {
    if (this.lost) return null;
    // Without the selection and gizmos.
    const hover = this.hoverGroup.visible;
    const selection = this.selectionGroup.visible;
    this.hoverGroup.visible = false;
    this.selectionGroup.visible = false;
    this.draw(false);
    this.hoverGroup.visible = hover;
    this.selectionGroup.visible = selection;
    const source = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const { width, height } = canvas;
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, this.theme.background[0]);
    gradient.addColorStop(1, this.theme.background[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    // Same task as the render, so the drawing buffer still holds the frame.
    context.drawImage(source, 0, 0);
    this.requestRender();
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width < 2 || height < 2) return;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  readonly requestRender = (): void => {
    if (this.frame || this.disposed || this.lost) return;
    this.frame = requestAnimationFrame(this.render);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.clearBed();
    for (const material of [this.hoverMaterial, this.selectMaterial, this.hoverLineMaterial, this.selectLineMaterial]) material.dispose();
    this.picker.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.sun.shadow.dispose();
    this.renderer.dispose();
    // Free the context now rather than at garbage collection. Browsers keep
    // about 16, and past that they drop the oldest, which is the map's.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // ----------------------------------------------------------- picking

  /** What's under a point of the page, or null for nothing (the bed, the sky). */
  pickAt(clientX: number, clientY: number): PickTarget | null {
    const hit = this.pick(clientX, clientY, () => true);
    return hit?.point ? (hit as PickTarget) : null;
  }

  /**
   * The same for hovering, which only finds where the ray met the model when
   * it needs it to tell which road is under the pointer: it saves a render.
   */
  hoverAt(clientX: number, clientY: number): HoverTarget | null {
    return this.pick(clientX, clientY, (slot, id) => id === 0 && this.isRoadPart(this.slots[slot]?.view));
  }

  private pick(clientX: number, clientY: number, wantPoint: (slot: number, id: number) => boolean): HoverTarget | null {
    if (this.lost) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.picker.pick(this.renderer, this.camera, clientX - rect.left, clientY - rect.top, rect.width, rect.height, wantPoint);
    this.requestRender();
    if (!hit) return null;
    const info = this.slots[hit.slot];
    if (!info) return null;
    const { view, composed } = info;
    const ground = hit.point ? this.groundAt(hit.point.x, hit.point.y) : null;
    const entry = hit.id > 0 ? composed.entries[hit.id - 1] : null;
    // Land given back to a removed road's ground is part of the land, not a thing to pick.
    if (entry && !entry.key.startsWith(FILL_PREFIX)) {
      return { key: entry.key, sub: entry.sub, part: view.id, point: hit.point, ground };
    }
    const road = hit.point ? this.roadAt(view, hit.point.x, hit.point.y) : null;
    return { key: road, sub: '', part: view.id, point: hit.point, ground };
  }

  private isRoadPart(view: PartView | undefined): boolean {
    return Boolean(view && (ROAD_PARTS[view.id] !== undefined || view.layer));
  }

  /** The ground's height, in the viewer's coordinates, when the model has a grid. */
  groundAt(x: number, y: number): number | null {
    return this.data.ground ? groundAt(this.data.ground, x, y) : null;
  }

  /** Where a ray through a point of the page meets the plane z = `z`. */
  pointOnPlane(clientX: number, clientY: number, z: number): Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const origin = this.camera.position.clone();
    const direction = new Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(origin).normalize();
    if (Math.abs(direction.z) < 1e-6) return null;
    const t = (z - origin.z) / direction.z;
    return t > 0 ? origin.addScaledVector(direction, t) : null;
  }

  /** The point on a vertical line through `anchor` nearest a ray through a point of the page. */
  pointOnVertical(clientX: number, clientY: number, anchor: Vector3): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const origin = this.camera.position.clone();
    const direction = new Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(origin).normalize();
    // Closest points between the ray and the line (anchor, +z).
    const w = origin.clone().sub(anchor);
    const b = direction.z;
    const d = direction.dot(w);
    const e = w.z;
    const denominator = 1 - b * b;
    // A ray within about 6 degrees of the line: a pixel moves it by metres.
    if (denominator < 0.01) return null;
    const s = (e - b * d) / denominator;
    return anchor.z + s;
  }

  /** Canvas pixel of a model point. */
  project(point: Vector3): { x: number; y: number; behind: boolean } {
    const p = point.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height, behind: p.z > 1 };
  }

  /** Objects whose middle is inside a box of the canvas, in CSS pixels. */
  keysInBox(x0: number, y0: number, x1: number, y1: number): string[] {
    const found = new Set<string>();
    const inside = (x: number, y: number, z: number) => {
      const p = this.project(new Vector3(x, y, z));
      return !p.behind && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    };
    for (const view of this.views.values()) {
      for (const composed of [view.base, view.override]) {
        if (!composed || !composed.entries.length) continue;
        let centres = this.centres.get(composed);
        if (!centres) this.centres.set(composed, (centres = composed.entryCentres()));
        composed.entries.forEach((entry, i) => {
          if (found.has(entry.key) || entry.key.startsWith(FILL_PREFIX) || !this.entryVisible(view, composed, entry)) return;
          if (inside(centres![i * 3], centres![i * 3 + 1], centres![i * 3 + 2])) found.add(entry.key);
        });
      }
    }
    const roads = this.roads;
    if (roads) {
      for (let piece = 0; piece < roads.count; piece++) {
        const key = roads.lines.keys[piece];
        if (found.has(key) || !this.roadShown(piece)) continue;
        const [x, y, z] = roads.midpoint(piece);
        if (inside(x, y, z)) found.add(key);
      }
    }
    return [...found];
  }

  /**
   * Keys among these that only hidden parts hold: something of them would
   * show with every part shown, and nothing does now. Removed things aren't
   * among them.
   */
  hiddenByParts(keys: string[]): string[] {
    if (!this.hiddenParts.size || !keys.length) return [];
    const now = new Set<string>();
    const unhidden = new Set<string>();
    const wanted = new Set(keys.map(objectOf));
    const context = { edits: this.edits, hiddenParts: this.hiddenParts, implicitHidden: this.implicitHidden, deckAt: this.deckAt };
    const allShown = { ...context, hiddenParts: new Set<string>() };
    for (const view of this.views.values()) {
      for (const composed of [view.base, view.override]) {
        if (!composed) continue;
        for (const entry of composed.entries) {
          if (!wanted.has(entry.key)) continue;
          const overridden = composed === view.base && view.overrideKeys.has(entry.key);
          const ids = entry.sub ? [entry.key, `${entry.key}/${entry.sub}`] : [entry.key];
          if (entryColour(entry, context, overridden, view.id) !== null) for (const id of ids) now.add(id);
          if (entryColour(entry, allShown, overridden, view.id) !== null) for (const id of ids) unhidden.add(id);
        }
      }
    }
    const roads = this.roads;
    return keys.filter((key) => {
      if (kindOf(key) === 'road') {
        if (!roads || roadEditOf(this.edits.objects, key)?.removed) return false;
        const pieces = roads.piecesOf(key);
        return pieces.length > 0 && !pieces.some((piece) => this.roadShown(piece));
      }
      return unhidden.has(key) && !now.has(key);
    });
  }

  /** Bounding box of an object as shown, for gizmos. */
  boundsOf(key: string): { min: Vector3; max: Vector3 } | null {
    const { fills, lines } = this.soupsFor([key]);
    const soups = [...fills, ...lines];
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const soup of soups) {
      for (let i = 0; i < soup.length; i += 3) {
        min.x = Math.min(min.x, soup[i]);
        min.y = Math.min(min.y, soup[i + 1]);
        min.z = Math.min(min.z, soup[i + 2]);
        max.x = Math.max(max.x, soup[i]);
        max.y = Math.max(max.y, soup[i + 1]);
        max.z = Math.max(max.z, soup[i + 2]);
      }
    }
    return Number.isFinite(min.x) ? { min, max } : null;
  }

  // ------------------------------------------------------------- private

  private readonly render = (now: number): void => {
    this.frame = 0;
    if (this.disposed || this.lost || this.width < 2) return;
    let again = false;
    if (this.tween) again = this.stepTween(now);
    if (this.controls.update()) again = true;
    this.draw(true);
    this.renderer.shadowMap.needsUpdate = false;
    if (again) this.requestRender();
  };

  private draw(overlay: boolean): void {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (overlay && this.overlay.children.length) {
      this.renderer.clearDepth();
      this.renderer.render(this.overlay, this.camera);
    }
  }

  /** A colour's material, and with a rank its walls, pulled towards the camera to win ties (OVERLAP_RANK). */
  private material(colour: string, rank = 0): MeshStandardMaterial {
    const key = `${colour} ${rank}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new MeshStandardMaterial({
        color: new Color(this.colourOf(colour)),
        roughness: 0.8,
        metalness: 0,
        flatShading: true,
        polygonOffset: rank > 0,
        polygonOffsetFactor: -rank,
        polygonOffsetUnits: -rank,
      });
      material.userData.colour = colour;
      this.materials.set(key, material);
    }
    return material;
  }

  /** A colour key's hex: a colour group, or a custom layer's `layer:<id>`. */
  private colourOf(colour: string): string {
    if (colour.startsWith('layer:')) return this.edits.layers.find((l) => `layer:${l.id}` === colour)?.hex ?? '#888888';
    return this.palette?.[colour as ColourGroup]?.hex ?? '#cccccc';
  }

  private defaultColour(view: PartView): string {
    if (view.layer) return `layer:${view.layer}`;
    return ROLE_GROUP[view.role];
  }

  private materialsFor(view: () => PartView): (colour: string, wall: boolean) => MeshStandardMaterial {
    return (colour, wall) => {
      const v = view();
      const key = colour === '' ? this.defaultColour(v) : colour.startsWith('group:') ? colour.slice(6) : colour;
      return this.material(key, wall ? (OVERLAP_RANK[v.role] ?? 0) : 0);
    };
  }

  /**
   * (Re)builds a part from its generated or replacement mesh. A part only
   * the worker's object geometry has (shapes, land given back where the
   * model had none) starts empty.
   */
  private buildView(id: string): void {
    const source = this.replaced.get(id) ?? this.generated.get(id) ?? (this.hasOverridesIn(id) ? null : undefined);
    const existing = this.views.get(id);
    if (existing) this.dropView(existing);
    if (source === undefined) return;
    const role: MaterialRole = source?.role ?? this.overrideRole(id) ?? 'building';
    const view = {
      id,
      role,
      layer: id.startsWith('layer:') ? id.slice('layer:'.length) : null,
    } as PartView;
    const ranked = (OVERLAP_RANK[role] ?? 0) > 0;
    view.base = new ComposedMesh(source ?? EMPTY_SOURCE, ranked, this.materialsFor(() => view));
    view.baseSlot = this.addSlot(view, view.base);
    view.override = null;
    view.overrideSlot = 0;
    view.overrideKeys = new Set();
    this.views.set(id, view);
    this.model.add(view.base.mesh);
    this.buildOverrides(id);
  }

  private hasOverridesIn(part: string): boolean {
    for (const object of this.objectMeshes.values()) if (object.part === part) return true;
    return false;
  }

  private overrideRole(part: string): MaterialRole | undefined {
    for (const object of this.objectMeshes.values()) if (object.part === part && object.role) return object.role;
    return undefined;
  }

  /** The part's second mesh, from the object geometry the worker sent for it. */
  private buildOverrides(id: string): void {
    const view = this.views.get(id);
    if (!view) {
      // A part only object geometry makes comes and goes with it.
      if (this.hasOverridesIn(id)) this.buildView(id);
      return;
    }
    if (view.override) {
      this.model.remove(view.override.mesh);
      this.freeSlot(view.overrideSlot);
      this.centres.delete(view.override);
      view.override.dispose();
      view.override = null;
      view.overrideSlot = 0;
    }
    const meshes = [...this.objectMeshes.values()].filter((object) => object.part === id && object.mesh);
    view.overrideKeys = new Set(meshes.map((m) => m.key));
    if (meshes.length) {
      const override = new ComposedMesh(combine(meshes), view.base.ranked, this.materialsFor(() => view));
      view.override = override;
      view.overrideSlot = this.addSlot(view, override);
      this.model.add(override.mesh);
    } else if (!this.generated.has(id) && !this.replaced.has(id)) {
      this.dropView(view);
    }
  }

  private addSlot(view: PartView, composed: ComposedMesh): number {
    let slot = this.slots.indexOf(null, 1);
    if (slot < 0) {
      slot = this.slots.length;
      this.slots.push(null);
    }
    if (slot > 255) return 0;
    this.slots[slot] = { view, composed };
    this.picker.add(slot, composed.geometry, () => composed.mesh.visible);
    return slot;
  }

  private freeSlot(slot: number): void {
    if (!slot) return;
    this.slots[slot] = null;
    this.picker.remove(slot);
  }

  private dropView(view: PartView): void {
    this.model.remove(view.base.mesh);
    this.freeSlot(view.baseSlot);
    this.centres.delete(view.base);
    view.base.dispose();
    if (view.override) {
      this.model.remove(view.override.mesh);
      this.freeSlot(view.overrideSlot);
      this.centres.delete(view.override);
      view.override.dispose();
    }
    this.views.delete(view.id);
  }

  private entryVisible(view: PartView, composed: ComposedMesh, entry: Entry): boolean {
    return this.entryStyle(view, composed, entry) !== null;
  }

  private entryStyle(view: PartView, composed: ComposedMesh, entry: Entry): string | null {
    const context = { edits: this.edits, hiddenParts: this.hiddenParts, implicitHidden: this.implicitHidden, deckAt: this.deckAt };
    return entryColour(entry, context, composed === view.base && view.overrideKeys.has(entry.key), view.id);
  }

  // A hidden part is hidden entry by entry rather than as a mesh, since what
  // was moved from it into a custom layer still shows, and exports, with that.
  private restyle(): void {
    for (const view of this.views.values()) {
      const unkeyed = this.hiddenParts.has(view.id) ? null : '';
      for (const composed of [view.base, view.override]) {
        if (!composed) continue;
        composed.update((entry) => this.entryStyle(view, composed, entry), unkeyed);
      }
    }
    this.updateShown();
  }

  /** The box around what's shown, after the edits or hidden parts changed it. */
  private updateShown(): void {
    let box: Bounds | null = null;
    for (const view of this.views.values()) {
      for (const composed of [view.base, view.override]) {
        const b = composed?.shownBounds();
        if (!b) continue;
        box = box ? (box.map((v, i) => (i < 3 ? Math.min(v, b[i]) : Math.max(v, b[i]))) as Bounds) : (b as Bounds);
      }
    }
    const previous = this.shown;
    if (box === previous || (box && previous && box.every((v, i) => Math.abs(v - previous[i]) < 1e-4))) return;
    this.shown = box;
    this.updateLight();
    this.updateClipping();
    this.callbacks.onBounds?.(box);
  }

  /** The generated model and whatever edits added, which may stand taller or reach further. */
  private extent(): Bounds | null {
    const b = this.bounds;
    const s = this.shown;
    if (!b || !s) return b;
    return b.map((v, i) => (i < 3 ? Math.min(v, s[i]) : Math.max(v, s[i]))) as Bounds;
  }

  /** A bridge's middle along its road's segment. */
  private readonly deckAt = (key: string): number | undefined => this.data.objects[key]?.at;

  /** A road piece's edit as it applies: its block's, from every range of its segment holding it. */
  pieceEdit(piece: number): ObjectEdit | undefined {
    if (this.roadEdits.has(piece)) return this.roadEdits.get(piece);
    const lines = this.roads!.lines;
    let edit = roadEditOf(this.edits.objects, lines.keys[piece]);
    // A divided road's merged line carries the other carriageway's edits too, where its own leave them.
    const partner = lines.partners?.[piece];
    if (partner && lines.partnerMeasures) {
      const at = (lines.partnerMeasures[lines.starts[piece]] + lines.partnerMeasures[lines.starts[piece + 1] - 1]) / 2;
      edit = carryEdit(edit, editAt(roadEditsOf(this.edits.objects).get(partner), at));
    }
    this.roadEdits.set(piece, edit);
    return edit;
  }

  /** The part a road piece is drawn in now: its custom layer's, or its group's. */
  private roadPart(piece: number): string {
    const lines = this.roads!.lines;
    const layer = this.pieceEdit(piece)?.layer;
    if (layer && this.edits.layers.some((l) => l.id === layer)) return `layer:${layer}`;
    return ROAD_PART_IDS[lines.groups[piece]];
  }

  roadShown(piece: number): boolean {
    return !this.pieceEdit(piece)?.removed && !this.hiddenParts.has(this.roadPart(piece));
  }

  /** Road pieces a part holds now, given the edits. */
  private roadAt(view: PartView, x: number, y: number): string | null {
    return this.roadPick(view, x, y)?.key ?? null;
  }

  /** The road under a point of the page, with where along it the point is, as the split tool needs. */
  roadPickAt(clientX: number, clientY: number): RoadPick | null {
    if (this.lost) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.picker.pick(this.renderer, this.camera, clientX - rect.left, clientY - rect.top, rect.width, rect.height, (slot, id) => id === 0 && this.isRoadPart(this.slots[slot]?.view));
    this.requestRender();
    const view = hit ? this.slots[hit.slot]?.view : undefined;
    if (!hit?.point || !view || hit.id > 0) return null;
    return this.roadPick(view, hit.point.x, hit.point.y);
  }

  /** A segment's block bounds as the view has them (blocks.ts). */
  blockBoundsOf(segment: string): number[] {
    return this.data.roads ? segmentBounds(this.data.roads, this.edits, segment) : [0, 1];
  }

  private roadPick(view: PartView, x: number, y: number): RoadPick | null {
    const roads = this.roads;
    if (!roads) return null;
    const group = ROAD_PARTS[view.id];
    const layer = view.layer;
    if (group === undefined && !layer) return null;
    const lines = roads.lines;
    const accept = (piece: number) => {
      const edit = this.pieceEdit(piece);
      if (edit?.removed) return false;
      const pieceLayer = edit?.layer && this.edits.layers.some((l) => l.id === edit.layer) ? edit.layer : null;
      if (layer) return pieceLayer === layer;
      return !pieceLayer && lines.groups[piece] === group;
    };
    return roads.nearest(x, y, accept, (piece) => this.roadWidth(piece));
  }

  roadWidth(piece: number): number {
    return this.pieceEdit(piece)?.widthMm ?? this.roads!.lines.widths[piece];
  }

  roadHeight(piece: number): number {
    return this.pieceEdit(piece)?.heightMm ?? this.roads!.lines.thicknessMm;
  }

  /** The overlay for keys: object triangles tinted, roads outlined. */
  private overlayFor(keys: string[], hover: boolean): Soup[] {
    const { fills, lines } = this.soupsFor(keys);
    const fill = hover ? this.hoverMaterial : this.selectMaterial;
    const line = hover ? this.hoverLineMaterial : this.selectLineMaterial;
    return [...fills.map((positions) => ({ positions, material: fill })), ...lines.map((positions) => ({ positions, material: line }))];
  }

  /** Triangle soups of the keys as shown: an object's (or one part's) triangles, or a road's edges. */
  private soupsFor(keys: string[]): { fills: Float32Array[]; lines: Float32Array[] } {
    const fills: Float32Array[] = [];
    const lines: Float32Array[] = [];
    const roadPieces: number[] = [];
    const objects = new Map<string, Set<string> | null>();
    for (const key of keys) {
      if (kindOf(key) === 'road') {
        if (this.roads) roadPieces.push(...this.roads.piecesOf(key).filter((piece) => this.roadShown(piece)));
        // A bridge in the block goes with its edits, so it lights up too.
        const bridge = this.data.objects[twinOf(key)!];
        const range = parseRoadKey(key);
        const at = bridge?.at;
        if (bridge && range && (at === undefined ? range.from <= 0 && range.to >= 1 : at >= range.from && at <= range.to)) objects.set(twinOf(key)!, null);
        continue;
      }
      const object = objectOf(key);
      if (isPartKey(key)) {
        const subs = objects.get(object);
        if (subs === null) continue;
        objects.set(object, (subs ?? new Set()).add(key.slice(object.length + 1)));
      } else {
        objects.set(object, null);
      }
    }
    if (roadPieces.length && this.roads) {
      // Edges only, so a road's own colour shows between them.
      lines.push(this.roads.ribbon(roadPieces, (p) => this.roadWidth(p) + 0.3, (p) => this.roadHeight(p), 0.03, 0.18));
    }
    if (objects.size) {
      for (const view of this.views.values()) {
        for (const composed of [view.base, view.override]) {
          if (!composed || !composed.entries.length) continue;
          const match = (entry: Entry) => {
            if (!objects.has(entry.key)) return false;
            const subs = objects.get(entry.key);
            if (subs && !subs.has(entry.sub)) return false;
            return this.entryStyle(view, composed, entry) !== null;
          };
          const triangles = composed.trianglesOf(match);
          if (triangles.length) fills.push(extractTriangles(composed.positions, triangles));
        }
      }
    }
    return { fills, lines };
  }

  private refreshHighlights(): void {
    setOverlay(this.selectionGroup, this.overlayFor(this.selection, false));
    const hovered = this.hovered;
    setOverlay(this.hoverGroup, hovered && !this.selection.includes(hovered) ? this.overlayFor([hovered], true) : []);
  }

  private clearModel(): void {
    for (const view of [...this.views.values()]) this.dropView(view);
    this.views.clear();
    this.picker.clear();
    this.slots.length = 1;
    this.objectMeshes.clear();
    this.replaced.clear();
    this.implicitHidden.clear();
    this.centres.clear();
    this.shown = null;
    setOverlay(this.hoverGroup, []);
    setOverlay(this.selectionGroup, []);
  }

  private framing(top = false): { center: Vector3; distance: number } | null {
    const b = this.extent();
    if (!b) return null;
    const center = new Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    let distance: number;
    if (top) {
      const w = b[3] - b[0];
      const d = b[4] - b[1];
      distance = Math.max(d / 2 / Math.tan(vFov / 2), w / 2 / Math.tan(hFov / 2)) * 1.12 + (b[5] - b[2]);
    } else {
      const radius = 0.5 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
      distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.98;
    }
    return { center, distance };
  }

  private moveCamera(position: Vector3, target: Vector3, animate: boolean): void {
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.tween = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      this.requestRender();
      return;
    }
    const from = spherical(this.camera.position.clone().sub(this.controls.target));
    const to = spherical(position.clone().sub(target));
    // Turn the short way round.
    let delta = to.theta - from.theta;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    to.theta = from.theta + delta;
    this.tween = {
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      from,
      to,
      start: performance.now(),
      duration: 650,
    };
    this.requestRender();
  }

  private stepTween(now: number): boolean {
    const tween = this.tween;
    if (!tween) return false;
    const t = Math.min(1, (now - tween.start) / tween.duration);
    const e = ease(t);
    const r = tween.from.r + (tween.to.r - tween.from.r) * e;
    const phi = tween.from.phi + (tween.to.phi - tween.from.phi) * e;
    const theta = tween.from.theta + (tween.to.theta - tween.from.theta) * e;
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    this.camera.position.set(
      this.controls.target.x + r * Math.sin(phi) * Math.cos(theta),
      this.controls.target.y + r * Math.sin(phi) * Math.sin(theta),
      this.controls.target.z + r * Math.cos(phi),
    );
    this.camera.lookAt(this.controls.target);
    if (t >= 1) this.tween = null;
    return this.tween !== null;
  }

  private readonly stopTween = (): void => {
    this.tween = null;
  };

  private updateClipping(): void {
    const b = this.extent();
    if (!b) return;
    const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 10);
    this.camera.near = Math.max(0.05, size / 500);
    this.camera.far = size * 40;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = size * 0.08;
    this.controls.maxDistance = size * 6;
  }

  private updateLight(): void {
    const b = this.extent();
    if (!b) return;
    const center = new Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    const bedSize = this.printer ? Math.hypot(this.printer.width, this.printer.depth) / 2 : 0;
    const radius = Math.max(0.5 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]), bedSize, 20);
    // From the west-north-west and fairly high, so shadows fall towards the
    // default camera in the south-west and stay short.
    const direction = new Vector3(-0.75, 0.3, 1.05).normalize();
    this.sun.position.copy(center).addScaledVector(direction, radius * 2);
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();
    const camera = this.sun.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.near = radius * 0.2;
    camera.far = radius * 4;
    camera.updateProjectionMatrix();
    const size = this.renderer.capabilities.maxTextureSize >= 16384 ? 4096 : 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  private clearBed(): void {
    for (const child of [...this.bed.children]) {
      const object = child as Mesh | LineSegments;
      object.geometry.dispose();
      (object.material as { dispose(): void }).dispose();
      this.bed.remove(child);
    }
  }

  private updateBed(): void {
    this.clearBed();
    const printer = this.printer;
    const b = this.bounds;
    if (!printer || !b) return;
    const cx = (b[0] + b[3]) / 2;
    const cy = (b[1] + b[4]) / 2;
    const z = b[2];
    const w = printer.width;
    const d = printer.depth;
    const theme = this.theme;

    // The plate and grid are drawn first without writing depth, so they never
    // z-fight with each other or with the model's underside.
    const plate = new Mesh(new PlaneGeometry(w, d), new MeshBasicMaterial({ color: theme.bed, toneMapped: false, depthWrite: false }));
    plate.position.set(cx, cy, z - 0.05);
    plate.renderOrder = -3;
    this.bed.add(plate);

    const shadow = new Mesh(new PlaneGeometry(w * 3, d * 3), new ShadowMaterial({ opacity: theme.shadow, depthWrite: false }));
    shadow.position.set(cx, cy, z - 0.01);
    shadow.receiveShadow = true;
    this.bed.add(shadow);

    const minor: number[] = [];
    const major: number[] = [];
    const x0 = cx - w / 2;
    const y0 = cy - d / 2;
    const gz = z - 0.05;
    for (let x = 10; x < w; x += 10) (x % 50 === 0 ? major : minor).push(x0 + x, y0, gz, x0 + x, y0 + d, gz);
    for (let y = 10; y < d; y += 10) (y % 50 === 0 ? major : minor).push(x0, y0 + y, gz, x0 + w, y0 + y, gz);
    const border = [
      x0, y0, gz, x0 + w, y0, gz,
      x0 + w, y0, gz, x0 + w, y0 + d, gz,
      x0 + w, y0 + d, gz, x0, y0 + d, gz,
      x0, y0 + d, gz, x0, y0, gz,
    ];
    for (const [points, color] of [
      [minor, theme.grid],
      [major, theme.gridMajor],
      [border, theme.border],
    ] as const) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      const lines = new LineSegments(geometry, new LineBasicMaterial({ color, toneMapped: false, depthWrite: false }));
      lines.renderOrder = -2;
      this.bed.add(lines);
    }
    this.bed.visible = this.showBed;
    this.updateLight();
    this.renderer.shadowMap.needsUpdate = true;
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.callbacks.onContextLost?.(true);
  };

  private readonly onContextRestored = (): void => {
    this.lost = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.callbacks.onContextLost?.(false);
    this.requestRender();
  };
}
