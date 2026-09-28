// Layers of solids to printable parts.

import { clipRegion, MeshBuilder, meshSolid, newMeshStats } from '../geometry/mesher';
import type { Layer } from '../geometry/solid';
import type { MeshPart, MultiPolygon } from '../types';
import type { Progress } from './context';

export interface MeshOptions {
  /** Keep only what lies inside this region (a print section). */
  clip?: MultiPolygon;
  /** Added to every z, so the model's underside can sit at 0. */
  zShift?: number;
  progress?: Progress;
  /** Progress fractions (0 to 1) this call reports within. */
  span?: [number, number];
}

export interface MeshResult {
  parts: MeshPart[];
  failed: number;
  fallbacks: number;
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
    for (const solid of layer.solids) {
      meshSolid(solid, out, clip, stats);
      done++;
      if (options.progress && done % 64 === 0) await options.progress.checkpoint(from + ((to - from) * done) / total);
    }
    if (!out.indexCount) continue;
    const { positions, indices } = out.finish();
    const dz = options.zShift ?? 0;
    if (dz) for (let i = 2; i < positions.length; i += 3) positions[i] += dz;
    parts.push({ id: layer.id, name: layer.name, role: layer.role, positions, indices });
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
