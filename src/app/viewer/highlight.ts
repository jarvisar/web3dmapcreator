// Overlays for what the pointer is over and what's selected: the object's own
// triangles again in a see-through accent colour, pulled towards the camera
// so they win against the object under them.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, type Group } from 'three';

export function overlayMaterial(colour: string, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
    side: DoubleSide,
  });
}

/** Triangles picked out of a mesh as their own soup, so the overlay can be disposed on its own. */
export function extractTriangles(positions: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    out[i * 3] = positions[v];
    out[i * 3 + 1] = positions[v + 1];
    out[i * 3 + 2] = positions[v + 2];
  }
  return out;
}

export interface Soup {
  positions: Float32Array;
  material: MeshBasicMaterial;
}

/** Replaces the overlay's meshes with these triangle soups. */
export function setOverlay(group: Group, soups: Soup[]): void {
  for (const child of [...group.children]) {
    (child as Mesh).geometry.dispose();
    group.remove(child);
  }
  for (const { positions, material } of soups) {
    if (!positions.length) continue;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 5;
    group.add(mesh);
  }
}
