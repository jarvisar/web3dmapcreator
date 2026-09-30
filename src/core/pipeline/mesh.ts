// Layers of solids to printable parts.

import { clipRegion, MeshBuilder, meshSolid, newMeshStats, type CapCache } from '../geometry/mesher';
import type { Layer, Solid } from '../geometry/solid';
import type { MeshPart, MultiPolygon, PartObjects } from '../types';
import type { Progress } from './context';

export interface MeshOptions {
  /** Keep only what lies inside this region (a print section). */
  clip?: MultiPolygon;
  /** Added to every z, so the model's underside can sit at 0. */
  zShift?: number;
  progress?: Progress;
  /** Progress fractions (0 to 1) this call reports within. */
  span?: [number, number];
  /** Record which triangles each keyed solid made (for the viewer). */
  objects?: boolean;
  /** Caps to reuse for polygons meshed before, and keep for next time (the editor's). */
  caps?: CapCache;
}

export interface MeshResult {
  parts: MeshPart[];
  failed: number;
  fallbacks: number;
}

/** Collects runs of triangles and vertices per keyed solid while a part is meshed. */
export class ObjectRuns {
  private readonly entries = new Map<string, number>();
  readonly keys: string[] = [];
  readonly subs: string[] = [];
  private runs: number[] = [];

  add(solid: Solid, triStart: number, triEnd: number, vertStart: number, vertEnd: number): void {
    if (!solid.key || triEnd <= triStart) return;
    const sub = solid.sub ?? '';
    const id = `${solid.key}\n${sub}`;
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = this.keys.length;
      this.entries.set(id, entry);
      this.keys.push(solid.key);
      this.subs.push(sub);
    }
    const runs = this.runs;
    const last = runs.length - 5;
    // Consecutive solids of one object share a run.
    if (last >= 0 && runs[last] === entry && runs[last + 2] === triStart && runs[last + 4] === vertStart) {
      runs[last + 2] = triEnd;
      runs[last + 4] = vertEnd;
      return;
    }
    runs.push(entry, triStart, triEnd, vertStart, vertEnd);
  }

  finish(): PartObjects | undefined {
    if (!this.keys.length) return undefined;
    return { keys: this.keys, subs: this.subs, runs: Uint32Array.from(this.runs) };
  }
}

export async function meshLayers(layers: Layer[], options: MeshOptions = {}): Promise<MeshResult> {
  const parts: MeshPart[] = [];
  const stats = newMeshStats();
  const total = layers.reduce((n, layer) => n + layer.solids.length, 0) || 1;
  const [from, to] = options.span ?? [0, 1];
  const clip = options.clip ? clipRegion(options.clip) : undefined;
  let done = 0;
  for (const layer of layers) {
    const out = new MeshBuilder();
    const runs = options.objects ? new ObjectRuns() : null;
    for (const solid of layer.solids) {
      const triStart = out.indexCount / 3;
      const vertStart = out.vertexCount;
      meshSolid(solid, out, clip, stats, options.caps);
      runs?.add(solid, triStart, out.indexCount / 3, vertStart, out.vertexCount);
      done++;
      if (options.progress && done % 64 === 0) await options.progress.checkpoint(from + ((to - from) * done) / total);
    }
    if (!out.indexCount) continue;
    const { positions, indices } = out.finish();
    const dz = options.zShift ?? 0;
    if (dz) for (let i = 2; i < positions.length; i += 3) positions[i] += dz;
    const part: MeshPart = { id: layer.id, name: layer.name, role: layer.role, positions, indices };
    if (layer.colour) part.colour = layer.colour;
    const objects = runs?.finish();
    if (objects) part.objects = objects;
    parts.push(part);
  }
  return { parts, failed: stats.failed, fallbacks: stats.fallbacks };
}

/** minX, minY, minZ, maxX, maxY, maxZ over all parts. */
export function partsBounds(parts: MeshPart[]): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < b[0]) b[0] = p[i];
      if (p[i + 1] < b[1]) b[1] = p[i + 1];
      if (p[i + 2] < b[2]) b[2] = p[i + 2];
      if (p[i] > b[3]) b[3] = p[i];
      if (p[i + 1] > b[4]) b[4] = p[i + 1];
      if (p[i + 2] > b[5]) b[5] = p[i + 2];
    }
  }
  return b;
}
