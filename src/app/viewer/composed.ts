// One part's triangles on screen, with each object in it shown, hidden or
// coloured on its own. The positions stay put, and the index is rebuilt from
// the object runs whenever what's shown changes, grouped by material so a
// part with objects in three colours is still one draw call per colour.

import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh, type Material } from 'three';
import type { PartObjects } from '../../core/types';

export interface Entry {
  key: string;
  sub: string;
}

/** How to show one entry: hidden (null) or with which colour. '' is the part's own. */
export type EntryStyle = (entry: Entry) => string | null;

export interface ComposedSource {
  positions: Float32Array;
  indices: Uint32Array;
  objects?: PartObjects;
}

/**
 * Where two parts are cut by the same line (the model edge, a shore) and one
 * reaches into the other, their walls lie in one plane and z-fight. Ranked
 * parts draw their walls with a depth offset (see ViewerEngine).
 */
function wallFlags(positions: Float32Array, indices: Uint32Array): Uint8Array {
  const flags = new Uint8Array(indices.length / 3);
  for (let t = 0; t < flags.length; t++) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    // Prism walls share x and y top and bottom, so their normal has no z at all.
    const nz =
      (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) -
      (positions[b + 1] - positions[a + 1]) * (positions[c] - positions[a]);
    if (Math.abs(nz) < 1e-9) flags[t] = 1;
  }
  return flags;
}

export class ComposedMesh {
  readonly geometry = new BufferGeometry();
  readonly mesh: Mesh;
  readonly entries: Entry[];
  /** Per run: entry, first triangle, end triangle. Unkeyed triangles are one run with entry -1. */
  private readonly runs: Int32Array;
  private readonly walls: Uint8Array | null;
  readonly triangleCount: number;
  /** Material keys in the order of the geometry's groups, caps then walls when ranked. */
  groupKeys: { colour: string; wall: boolean }[] = [];
  private lastSignature = '';

  constructor(
    readonly source: ComposedSource,
    readonly ranked: boolean,
    private readonly materialFor: (colour: string, wall: boolean) => Material,
  ) {
    const { positions, indices, objects } = source;
    this.triangleCount = indices.length / 3;
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.entries = objects ? objects.keys.map((key, i) => ({ key, sub: objects.subs[i] })) : [];
    this.runs = buildRuns(this.triangleCount, objects);
    this.walls = ranked ? wallFlags(positions, indices) : null;
    // Entry index + 1 per vertex, 0 for unkeyed, for picking.
    const ids = new Float32Array(positions.length / 3);
    if (objects) {
      for (let r = 0; r < objects.runs.length; r += 5) ids.fill(objects.runs[r] + 1, objects.runs[r + 3], objects.runs[r + 4]);
    }
    this.geometry.setAttribute('pickId', new Float32BufferAttribute(ids, 1));
    this.mesh = new Mesh(this.geometry, [materialFor('', false)]);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  get positions(): Float32Array {
    return this.source.positions;
  }

  /** Rebuilds the index for what's shown. Returns false when nothing changed. */
  update(style: EntryStyle): boolean {
    const styles = this.entries.map(style);
    // join() writes null as '', the part's own colour, so hidden needs a mark of its own.
    const signature = styles.map((s) => s ?? '\u0002').join('\u0001');
    if (signature === this.lastSignature && this.geometry.index) return false;
    this.lastSignature = signature;
    const indices = this.source.indices;
    const buckets = new Map<string, number[]>();
    const push = (colour: string, from: number, to: number) => {
      let list = buckets.get(colour);
      if (!list) buckets.set(colour, (list = []));
      list.push(from, to);
    };
    for (let r = 0; r < this.runs.length; r += 3) {
      const entry = this.runs[r];
      const colour = entry < 0 ? '' : styles[entry];
      if (colour === null) continue;
      push(colour, this.runs[r + 1], this.runs[r + 2]);
    }
    let total = 0;
    for (const ranges of buckets.values()) for (let i = 0; i < ranges.length; i += 2) total += ranges[i + 1] - ranges[i];
    const out = new Uint32Array(total * 3);
    const groups: { start: number; count: number; colour: string; wall: boolean }[] = [];
    let at = 0;
    const colours = [...buckets.keys()].sort();
    for (const colour of colours) {
      const ranges = buckets.get(colour)!;
      for (const wall of this.walls ? [false, true] : [false]) {
        const start = at;
        for (let i = 0; i < ranges.length; i += 2) {
          for (let t = ranges[i]; t < ranges[i + 1]; t++) {
            if (this.walls && (this.walls[t] === 1) !== wall) continue;
            out[at++] = indices[t * 3];
            out[at++] = indices[t * 3 + 1];
            out[at++] = indices[t * 3 + 2];
          }
        }
        if (at > start) groups.push({ start, count: at - start, colour, wall });
      }
    }
    this.geometry.setIndex(new BufferAttribute(out, 1));
    this.geometry.clearGroups();
    groups.forEach((g, i) => this.geometry.addGroup(g.start, g.count, i));
    this.groupKeys = groups.map((g) => ({ colour: g.colour, wall: g.wall }));
    this.mesh.material = this.groupKeys.length ? this.groupKeys.map((g) => this.materialFor(g.colour, g.wall)) : [this.materialFor('', false)];
    this.geometry.computeBoundingSphere();
    return true;
  }

  /** Materials again, after a colour of this part's changed its material. */
  refreshMaterials(): void {
    this.mesh.material = this.groupKeys.length ? this.groupKeys.map((g) => this.materialFor(g.colour, g.wall)) : [this.materialFor('', false)];
  }

  /** Triangles of the entries `pick` accepts, as indices into this mesh's positions. */
  trianglesOf(pick: (entry: Entry) => boolean): Uint32Array {
    const indices = this.source.indices;
    const ranges: number[] = [];
    let total = 0;
    for (let r = 0; r < this.runs.length; r += 3) {
      const entry = this.runs[r];
      if (entry < 0 || !pick(this.entries[entry])) continue;
      ranges.push(this.runs[r + 1], this.runs[r + 2]);
      total += this.runs[r + 2] - this.runs[r + 1];
    }
    const out = new Uint32Array(total * 3);
    let at = 0;
    for (let i = 0; i < ranges.length; i += 2) {
      out.set(indices.subarray(ranges[i] * 3, ranges[i + 1] * 3), at);
      at += (ranges[i + 1] - ranges[i]) * 3;
    }
    return out;
  }

  /** Centre of each entry's bounding box, for box selection. */
  entryCentres(): Float32Array {
    const out = new Float32Array(this.entries.length * 3);
    const min = new Float32Array(this.entries.length * 3).fill(Infinity);
    const max = new Float32Array(this.entries.length * 3).fill(-Infinity);
    const objects = this.source.objects;
    if (!objects) return out;
    const p = this.source.positions;
    for (let r = 0; r < objects.runs.length; r += 5) {
      const e = objects.runs[r] * 3;
      for (let v = objects.runs[r + 3]; v < objects.runs[r + 4]; v++) {
        for (let k = 0; k < 3; k++) {
          const value = p[v * 3 + k];
          if (value < min[e + k]) min[e + k] = value;
          if (value > max[e + k]) max[e + k] = value;
        }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = (min[i] + max[i]) / 2;
    return out;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** Runs covering every triangle: the object runs, and the triangles between them as unkeyed. */
function buildRuns(triangles: number, objects?: PartObjects): Int32Array {
  if (!objects || !objects.runs.length) return Int32Array.of(-1, 0, triangles);
  const sorted: [number, number, number][] = [];
  for (let r = 0; r < objects.runs.length; r += 5) sorted.push([objects.runs[r], objects.runs[r + 1], objects.runs[r + 2]]);
  sorted.sort((a, b) => a[1] - b[1]);
  const out: number[] = [];
  let at = 0;
  for (const [entry, from, to] of sorted) {
    if (from > at) out.push(-1, at, from);
    out.push(entry, from, to);
    at = to;
  }
  if (at < triangles) out.push(-1, at, triangles);
  return Int32Array.from(out);
}
