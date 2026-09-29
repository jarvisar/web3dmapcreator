// Rejoins lines cut at tile edges. Each tile rounds its own geometry, so the two
// halves of a road can meet the edge a fraction of a unit apart. Both end exactly
// on the edge, so ends are matched per edge (same key, opposite sides, nearest
// within tolerance) and moved to their midpoint. The welder joins them after.
import type { Point } from '../lines/geometry';
import { TILE_EXTENT } from '../geo/mercator';

export interface StitchLine {
  key: string;
  path: Point[];
}

interface SeamEnd {
  line: number;
  atStart: boolean;
  along: number;
  side: number;
}

export function stitchSeams(lines: StitchLine[], tolerance = 2): number {
  const seams = new Map<string, SeamEnd[]>();
  const add = (seam: string, end: SeamEnd) => {
    const list = seams.get(seam);
    if (list) list.push(end);
    else seams.set(seam, [end]);
  };
  lines.forEach((line, index) => {
    const path = line.path;
    if (path.length < 2) return;
    for (const atStart of [true, false]) {
      const p = atStart ? path[0] : path[path.length - 1];
      const q = atStart ? path[1] : path[path.length - 2];
      if (p[0] % TILE_EXTENT === 0 && q[0] !== p[0]) {
        add(`x${p[0]}`, { line: index, atStart, along: p[1], side: Math.sign(q[0] - p[0]) });
      }
      if (p[1] % TILE_EXTENT === 0 && q[1] !== p[1]) {
        add(`y${p[1]}`, { line: index, atStart, along: p[0], side: Math.sign(q[1] - p[1]) });
      }
    }
  });

  let joined = 0;
  const matched = new Set<string>();
  const id = (e: SeamEnd) => `${e.line}:${e.atStart ? 's' : 'e'}`;
  for (const [seam, ends] of seams) {
    const vertical = seam[0] === 'x';
    const coordinate = Number(seam.slice(1));
    ends.sort((a, b) => a.along - b.along);
    for (let i = 0; i < ends.length; i++) {
      const a = ends[i];
      if (matched.has(id(a))) continue;
      let best = -1;
      let bestGap = tolerance;
      for (let j = i + 1; j < ends.length && ends[j].along - a.along <= tolerance; j++) {
        const b = ends[j];
        if (matched.has(id(b)) || b.side === a.side || lines[b.line].key !== lines[a.line].key) continue;
        const gap = b.along - a.along;
        if (gap <= bestGap) {
          bestGap = gap;
          best = j;
        }
      }
      if (best < 0) continue;
      const b = ends[best];
      matched.add(id(a));
      matched.add(id(b));
      const along = (a.along + b.along) / 2;
      const point: Point = vertical ? [coordinate, along] : [along, coordinate];
      for (const e of [a, b]) {
        const path = lines[e.line].path;
        path[e.atStart ? 0 : path.length - 1] = point;
      }
      joined++;
    }
  }
  return joined;
}
