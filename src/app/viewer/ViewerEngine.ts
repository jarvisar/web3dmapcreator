// Three.js scene for the generated model. Z is up and model coordinates are
// used as they are: X east, Y north, millimetres. Renders only when something
// changes, and the shadow map only when the model or its visibility changes,
// since the light is fixed to the model and orbiting cannot move shadows.

import {
  ACESFilmicToneMapping,
  BufferAttribute,
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
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Palette, Printer } from '../../core/settings';
import { ROLE_GROUP } from '../../core/types';
import type { ColourGroup, MeshPart } from '../../core/types';

type Bounds = [number, number, number, number, number, number];

export interface ViewerCallbacks {
  onContextLost?: (lost: boolean) => void;
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
  bed: '#e4e9f0',
  grid: '#d3dae4',
  gridMajor: '#c2cad6',
  border: '#94a3b8',
  shadow: 0.2,
  background: ['#eef2f7', '#dde3ea'],
};

const DARK_THEME: Theme = {
  bed: '#1f2a3d',
  grid: '#2a374c',
  gridMajor: '#34445c',
  border: '#56657c',
  shadow: 0.35,
  background: ['#1e293b', '#0f172a'],
};

interface Tween {
  fromTarget: Vector3;
  toTarget: Vector3;
  from: { r: number; phi: number; theta: number };
  to: { r: number; phi: number; theta: number };
  start: number;
  duration: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function spherical(offset: Vector3) {
  const r = offset.length();
  return { r, phi: Math.acos(Math.min(1, Math.max(-1, offset.z / (r || 1)))), theta: Math.atan2(offset.y, offset.x) };
}

export class ViewerEngine {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(32, 1, 0.1, 5000);
  private readonly controls: OrbitControls;
  private readonly model = new Group();
  private readonly bed = new Group();
  private readonly hemi: HemisphereLight;
  private readonly sun: DirectionalLight;
  private readonly materials = new Map<ColourGroup, MeshStandardMaterial>();
  private readonly meshes = new Map<string, Mesh>();
  private readonly resizeObserver: ResizeObserver;
  private palette: Palette | null = null;
  private hidden = new Set<string>();
  private bounds: Bounds | null = null;
  private printer: Printer | null = null;
  private showBed = true;
  private theme: Theme = LIGHT_THEME;
  private frame = 0;
  private tween: Tween | null = null;
  private lost = false;
  private disposed = false;
  private width = 0;
  private height = 0;

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
    this.controls = controls;

    this.hemi = new HemisphereLight(0xffffff, 0x8b95a7, 1.25);
    this.hemi.position.set(0, 0, 1);
    this.sun = new DirectionalLight(0xffffff, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 3;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.model, this.bed);

    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  // -------------------------------------------------------------- public

  setModel(parts: MeshPart[], bounds: Bounds): void {
    const previous = this.bounds;
    this.clearModel();
    for (const part of parts) {
      if (!part.positions.length || !part.indices.length) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(part.positions, 3));
      geometry.setIndex(new BufferAttribute(part.indices, 1));
      geometry.computeBoundingSphere();
      // flatShading takes face normals from screen-space derivatives, so no
      // normal attribute is needed: less memory and sharp edges on every box.
      const mesh = new Mesh(geometry, this.material(ROLE_GROUP[part.role]));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = !this.hidden.has(part.id);
      mesh.name = part.id;
      mesh.matrixAutoUpdate = false;
      this.meshes.set(part.id, mesh);
      this.model.add(mesh);
    }
    this.bounds = bounds;
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

  setPalette(palette: Palette): void {
    this.palette = palette;
    for (const [group, material] of this.materials) material.color.set(palette[group].hex);
    this.requestRender();
  }

  setHidden(ids: string[]): void {
    this.hidden = new Set(ids);
    for (const [id, mesh] of this.meshes) mesh.visible = !this.hidden.has(id);
    this.renderer.shadowMap.needsUpdate = true;
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

  /** PNG of the current view on the viewer background. */
  async screenshot(): Promise<Blob | null> {
    if (this.lost) return null;
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const { width, height } = canvas;
    const gradient = context.createRadialGradient(width / 2, height * 0.35, 0, width / 2, height * 0.35, Math.max(width, height) * 0.8);
    gradient.addColorStop(0, this.theme.background[0]);
    gradient.addColorStop(1, this.theme.background[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    // Same task as the render, so the drawing buffer still holds the frame.
    context.drawImage(source, 0, 0);
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
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------- private

  private readonly render = (now: number): void => {
    this.frame = 0;
    if (this.disposed || this.lost || this.width < 2) return;
    let again = false;
    if (this.tween) again = this.stepTween(now);
    if (this.controls.update()) again = true;
    this.renderer.render(this.scene, this.camera);
    this.renderer.shadowMap.needsUpdate = false;
    if (again) this.requestRender();
  };

  private material(group: ColourGroup): MeshStandardMaterial {
    let material = this.materials.get(group);
    if (!material) {
      material = new MeshStandardMaterial({
        color: new Color(this.palette?.[group].hex ?? '#cccccc'),
        roughness: 0.8,
        metalness: 0,
        flatShading: true,
      });
      this.materials.set(group, material);
    }
    return material;
  }

  private clearModel(): void {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      this.model.remove(mesh);
    }
    this.meshes.clear();
  }

  private framing(top = false): { center: Vector3; distance: number } | null {
    const b = this.bounds;
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
    if (!animate) {
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
    const b = this.bounds;
    if (!b) return;
    const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 10);
    this.camera.near = Math.max(0.05, size / 500);
    this.camera.far = size * 40;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = size * 0.08;
    this.controls.maxDistance = size * 6;
  }

  private updateLight(): void {
    const b = this.bounds;
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
