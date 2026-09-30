// Picking on the GPU. The model can be millions of triangles, and hovering
// has to keep up with the pointer, so each pick renders just the one pixel
// under it twice: once with every object's id as its colour, once with its
// distance from the camera. Hidden objects aren't in the index, so they can't
// be picked, and whatever is in front wins, as it looks.

import {
  Color,
  Mesh,
  NoBlending,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type BufferGeometry,
  type WebGLRenderer,
} from 'three';

const VERTEX = /* glsl */ `
  attribute float pickId;
  varying float vPickId;
  varying float vDepth;
  void main() {
    vPickId = pickId;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vDepth = -view.z;
    gl_Position = projectionMatrix * view;
  }
`;

// Ids go out in RGB and the slot in alpha. Depth is linear between near and
// far, packed into four bytes.
const FRAGMENT = /* glsl */ `
  uniform float slot;
  uniform float mode;
  uniform float near;
  uniform float far;
  varying float vPickId;
  varying float vDepth;
  vec4 packDepth(float v) {
    vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;
    enc = fract(enc);
    enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
    return enc;
  }
  void main() {
    if (mode > 0.5) {
      gl_FragColor = packDepth(clamp((vDepth - near) / (far - near), 0.0, 0.9999));
      return;
    }
    float id = floor(vPickId + 0.5);
    float b = mod(id, 256.0);
    float g = mod(floor(id / 256.0), 256.0);
    float r = mod(floor(id / 65536.0), 256.0);
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, slot / 255.0);
  }
`;

export interface PickHit {
  /** Which pickable mesh, from 1. */
  slot: number;
  /** Entry index + 1 in that mesh, 0 for a triangle of no object. */
  id: number;
  /** Where the ray met it, in model mm, when asked for. */
  point: Vector3 | null;
}

export class Picker {
  readonly scene = new Scene();
  private readonly target = new WebGLRenderTarget(1, 1, { depthBuffer: true });
  private readonly pixel = new Uint8Array(4);
  private readonly twins = new Map<number, Mesh>();
  private readonly uniforms = { mode: { value: 0 }, near: { value: 0.1 }, far: { value: 1000 } };

  constructor() {
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** A mesh to pick from, drawn with the display mesh's geometry and index. */
  add(slot: number, geometry: BufferGeometry, visible: () => boolean): void {
    this.remove(slot);
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { ...this.uniforms, slot: { value: slot } },
      blending: NoBlending,
    });
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.userData.visible = visible;
    this.twins.set(slot, mesh);
    this.scene.add(mesh);
  }

  remove(slot: number): void {
    const mesh = this.twins.get(slot);
    if (!mesh) return;
    this.scene.remove(mesh);
    (mesh.material as ShaderMaterial).dispose();
    this.twins.delete(slot);
  }

  clear(): void {
    for (const slot of [...this.twins.keys()]) this.remove(slot);
  }

  /**
   * The object under a point on the canvas, in CSS pixels. The second pass,
   * for where the ray met it, only runs when `wantPoint` asks for it.
   */
  pick(
    renderer: WebGLRenderer,
    camera: PerspectiveCamera,
    x: number,
    y: number,
    width: number,
    height: number,
    wantPoint: (slot: number, id: number) => boolean = () => true,
  ): PickHit | null {
    if (!this.twins.size || width < 2 || height < 2) return null;
    for (const mesh of this.twins.values()) mesh.visible = (mesh.userData.visible as () => boolean)();
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousColour = renderer.getClearColor(new Color());
    const shadows = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    camera.setViewOffset(width, height, Math.floor(x), Math.floor(y), 1, 1);
    this.uniforms.near.value = camera.near;
    this.uniforms.far.value = camera.far;
    try {
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      this.uniforms.mode.value = 0;
      renderer.clear();
      renderer.render(this.scene, camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.pixel);
      const [r, g, b, a] = this.pixel;
      if (a === 0) return null;
      const slot = a;
      const id = (r << 16) | (g << 8) | b;
      if (!wantPoint(slot, id)) return { slot, id, point: null };
      this.uniforms.mode.value = 1;
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this.scene, camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.pixel);
      const [dr, dg, db, da] = this.pixel;
      const depth = dr / 255 + dg / 255 / 255 + db / 255 / 65025 + da / 255 / 16581375;
      const distance = camera.near + depth * (camera.far - camera.near);
      camera.clearViewOffset();
      // The view distance along the ray through the pixel's centre.
      const ndc = new Vector3(((x + 0.5) / width) * 2 - 1, -((y + 0.5) / height) * 2 + 1, 0.5);
      const direction = ndc.unproject(camera).sub(camera.position).normalize();
      const forward = new Vector3();
      camera.getWorldDirection(forward);
      const along = distance / Math.max(1e-6, direction.dot(forward));
      const point = camera.position.clone().addScaledVector(direction, along);
      return { slot, id, point };
    } finally {
      camera.clearViewOffset();
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousColour, previousAlpha);
      renderer.shadowMap.enabled = shadows;
      this.uniforms.mode.value = 0;
    }
  }

  dispose(): void {
    this.clear();
    this.target.dispose();
  }
}
