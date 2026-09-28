// Checks that a triangle mesh is made of closed, consistently wound shells.
// Parts are unions of independent shells that share no vertices, so these
// hold for a whole part as well as for each shell.

export interface EdgeReport {
  triangles: number;
  /** Directed edges with no opposite: holes in a shell. */
  open: number;
  /** Directed edges used more than once in the same direction: inconsistent winding or overlaps. */
  repeated: number;
}

export function edgeReport(indices: ArrayLike<number>, vertexCount: number): EdgeReport {
  // A JS Map holds about 16.7 million entries, less than the directed edges
  // of a multi-million-triangle part, so edges are sharded by their lower vertex.
  const shards = Math.max(1, Math.ceil(indices.length / 8e6));
  const maps = Array.from({ length: shards }, () => new Map<number, number>());
  const shardOf = (a: number, b: number) => maps[Math.min(a, b) % shards];
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k];
      const b = indices[t + ((k + 1) % 3)];
      const key = a * vertexCount + b;
      const map = shardOf(a, b);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  let repeated = 0;
  for (const map of maps) {
    for (const [key, n] of map) {
      if (n > 1) repeated++;
      const a = Math.floor(key / vertexCount);
      const b = key - a * vertexCount;
      if (!map.has(b * vertexCount + a)) open++;
    }
  }
  return { triangles: indices.length / 3, open, repeated };
}

/** Signed volume by the divergence theorem; positive for outward-facing shells. */
export function signedVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t];
    const b = 3 * indices[t + 1];
    const c = 3 * indices[t + 2];
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}