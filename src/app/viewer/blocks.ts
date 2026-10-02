// The viewer's road lines cut into the blocks a click selects (edit/blocks.ts):
// at a segment's junctions, its splits and the ends of its edits. They're cut
// again only when a split or an edit's range comes or goes, not on every
// edit.

import { blockAt, blockBounds, carryEdit, editAt, parseRoadKey, roadEditOf, roadEdits, roadSegment } from '../../core/edit/blocks';
import type { RoadLines } from '../../core/edit/lines';
import type { ModelEdits, ObjectEdit } from '../../core/edit/types';
import type { RoadIndex, RoadMark, RoadPick } from './roads';

/** What the blocks depend on in the edits: each segment's splits and edit ranges. */
export function blocksSignature(edits: ModelEdits): string {
  const parts: string[] = [];
  for (const [segment, entry] of roadEdits(edits.objects)) {
    const ends = entry.ranges.filter((range) => range.from > 0 || range.to < 1).map((range) => `${range.from}-${range.to}`);
    if (!ends.length && !entry.splits.length) continue;
    parts.push(`${segment}|${entry.splits.join(',')}|${ends.sort().join(',')}`);
  }
  return parts.sort().join(';');
}

/** A segment's block bounds as the viewer has them. */
export function segmentBounds(lines: RoadLines, edits: ModelEdits, segment: string): number[] {
  return blockBounds(roadEdits(edits.objects).get(segment), lines.junctions?.[segment]);
}

/** The lines cut at every block bound, each piece keyed by its block. */
export function blockLines(base: RoadLines, edits: ModelEdits): RoadLines {
  const measures = base.measures;
  if (!measures) return base;
  const index = roadEdits(edits.objects);
  const keys: string[] = [];
  const names: string[] = [];
  const classes: string[] = [];
  const groups: number[] = [];
  const widths: number[] = [];
  const starts: number[] = [];
  const points: number[] = [];
  const along: number[] = [];
  const partners: string[] = [];
  const carried: number[] = [];
  const partnerMeasures = base.partnerMeasures;
  const bounds = new Map<string, number[]>();
  const boundsOf = (segment: string) => {
    let list = bounds.get(segment);
    if (!list) bounds.set(segment, (list = blockBounds(index.get(segment), base.junctions?.[segment])));
    return list;
  };
  // The other carriageway's range ends, where the export cuts a merged line too (edit/roads.ts).
  const carriedCuts = new Map<string, number[]>();
  const carriedOf = (segment: string) => {
    let list = carriedCuts.get(segment);
    if (!list) carriedCuts.set(segment, (list = (index.get(segment)?.ranges ?? []).flatMap((range) => [range.from, range.to]).filter((v) => v > 0 && v < 1)));
    return list;
  };
  for (let piece = 0; piece < base.keys.length; piece++) {
    const segment = roadSegment(base.keys[piece]);
    const first = base.starts[piece];
    const end = base.starts[piece + 1];
    const cuts = boundsOf(segment);
    const partnerCuts = base.partners?.[piece] && partnerMeasures ? carriedOf(base.partners[piece]) : [];
    const open = () => {
      starts.push(points.length / 3);
      names.push(base.names[piece]);
      classes.push(base.classes[piece]);
      groups.push(base.groups[piece]);
      widths.push(base.widths[piece]);
      keys.push(segment);
      partners.push(base.partners?.[piece] ?? '');
    };
    const push = (x: number, y: number, z: number, m: number, q: number) => {
      points.push(x, y, z);
      along.push(m);
      carried.push(q);
    };
    const partnerAt = (p: number) => (partnerMeasures ? partnerMeasures[p] : NaN);
    // Each run is keyed once it's closed, by the measure at its middle.
    const close = (from: number) => {
      const count = points.length / 3 - starts[starts.length - 1];
      if (count < 2) {
        // Too short to be a line: dropped.
        points.length = starts[starts.length - 1] * 3;
        along.length = starts[starts.length - 1];
        carried.length = starts[starts.length - 1];
        partners.pop();
        starts.pop();
        names.pop();
        classes.pop();
        groups.pop();
        widths.pop();
        keys.pop();
        return;
      }
      const a = along[from];
      const b = along[along.length - 1];
      keys[keys.length - 1] = Number.isNaN(a) || cuts.length <= 2 ? segment : blockAt(segment, cuts, (a + b) / 2);
    };
    open();
    let runStart = along.length;
    push(base.points[first * 3], base.points[first * 3 + 1], base.points[first * 3 + 2], measures[first], partnerAt(first));
    // Where along the span from p - 1 to p a measure crosses each value strictly between its ends.
    const crossings = (a: number, b: number, values: readonly number[]): number[] => {
      if (Number.isNaN(a) || Number.isNaN(b) || a === b) return [];
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return values.filter((v) => v > lo + 1e-7 && v < hi - 1e-7).map((v) => (v - a) / (b - a));
    };
    // A bound on a vertex is cut there, as the export does: the spans either side leave it out.
    const onVertex = (p: number) =>
      (cuts.length > 2 && cuts.some((v) => Math.abs(v - measures[p]) <= 1e-7)) || partnerCuts.some((v) => Math.abs(v - partnerAt(p)) <= 1e-7);
    for (let p = first + 1; p < end; p++) {
      const ma = measures[p - 1];
      const mb = measures[p];
      const qa = partnerAt(p - 1);
      const qb = partnerAt(p);
      const ts = [...(cuts.length > 2 ? crossings(ma, mb, cuts) : []), ...(partnerCuts.length ? crossings(qa, qb, partnerCuts) : [])].sort((a, b) => a - b);
      let last = 0;
      for (const t of ts) {
        if (t - last < 1e-9) continue;
        last = t;
        const x = base.points[(p - 1) * 3] + (base.points[p * 3] - base.points[(p - 1) * 3]) * t;
        const y = base.points[(p - 1) * 3 + 1] + (base.points[p * 3 + 1] - base.points[(p - 1) * 3 + 1]) * t;
        const z = base.points[(p - 1) * 3 + 2] + (base.points[p * 3 + 2] - base.points[(p - 1) * 3 + 2]) * t;
        const m = ma + (mb - ma) * t;
        const q = qa + (qb - qa) * t;
        push(x, y, z, m, q);
        close(runStart);
        open();
        runStart = along.length;
        push(x, y, z, m, q);
      }
      push(base.points[p * 3], base.points[p * 3 + 1], base.points[p * 3 + 2], mb, qb);
      if (p < end - 1 && onVertex(p)) {
        close(runStart);
        open();
        runStart = along.length;
        push(base.points[p * 3], base.points[p * 3 + 1], base.points[p * 3 + 2], mb, qb);
      }
    }
    close(runStart);
  }
  starts.push(points.length / 3);
  return {
    ...base,
    keys,
    names,
    classes,
    groups: Uint8Array.from(groups),
    widths: Float32Array.from(widths),
    starts: Uint32Array.from(starts),
    points: Float32Array.from(points),
    measures: Float32Array.from(along),
    partners,
    partnerMeasures: Float32Array.from(carried),
  };
}

/**
 * Where a road key's block lies along the other carriageway, when it's on a
 * divided road's merged line: that segment and the point at the block's
 * middle. From the lines as generated.
 */
export function carriedAt(lines: RoadLines, key: string): { segment: string; at: number } | null {
  const range = parseRoadKey(key);
  const { measures, partners, partnerMeasures, starts } = lines;
  if (!range || !measures || !partners || !partnerMeasures) return null;
  const middle = (range.from + range.to) / 2;
  for (let piece = 0; piece < lines.keys.length; piece++) {
    if (!partners[piece] || roadSegment(lines.keys[piece]) !== range.segment) continue;
    for (let p = starts[piece] + 1; p < starts[piece + 1]; p++) {
      const a = measures[p - 1];
      const b = measures[p];
      if (!(Math.min(a, b) <= middle && Math.max(a, b) >= middle) || a === b) continue;
      const t = (middle - a) / (b - a);
      return { segment: partners[piece], at: partnerMeasures[p - 1] + (partnerMeasures[p] - partnerMeasures[p - 1]) * t };
    }
  }
  return null;
}

/** A road key's edit as it applies, the other carriageway's filled in on a merged divided road (carryEdit). */
export function appliedRoadEdit(edits: ModelEdits, key: string, lines: RoadLines | null): ObjectEdit | undefined {
  const own = roadEditOf(edits.objects, key);
  const carried = lines ? carriedAt(lines, key) : null;
  return carried ? carryEdit(own, editAt(roadEdits(edits.objects).get(carried.segment), carried.at)) : own;
}

/** How near an existing split or block end a click with the split tool has to be to mean it, in mm. */
export const SPLIT_SNAP_MM = 0.4;

/** What a click with the split tool does where a road was picked. */
export type SplitTarget =
  | { kind: 'split'; segment: string; at: number }
  /** On a split already there: it's taken out. */
  | { kind: 'join'; segment: string; at: number; mark: RoadMark }
  /** On a junction or another block's end, where nothing's to split. */
  | { kind: 'end'; segment: string; mark: RoadMark };

export function splitTarget(roads: RoadIndex, bounds: readonly number[], splits: readonly number[], pick: RoadPick): SplitTarget | null {
  if (!(pick.at === pick.at)) return null;
  const segment = roadSegment(pick.key);
  let nearest: { at: number; mark: RoadMark; distance: number } | null = null;
  for (const at of bounds) {
    const mark = roads.markAt(segment, at);
    if (!mark) continue;
    const distance = Math.hypot(mark.x - pick.x, mark.y - pick.y);
    if (distance < SPLIT_SNAP_MM && (!nearest || distance < nearest.distance)) nearest = { at, mark, distance };
  }
  if (!nearest) return { kind: 'split', segment, at: pick.at };
  const split = splits.find((v) => Math.abs(v - nearest!.at) < 1e-6);
  return split !== undefined ? { kind: 'join', segment, at: split, mark: nearest.mark } : { kind: 'end', segment, mark: nearest.mark };
}

/** Lines joined where one ends at another's end, for a block in several pieces. */
export function chainLines(lines: readonly [number, number][][]): [number, number][][] {
  const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
  const left = lines.filter((line) => line.length >= 2).map((line) => [...line]);
  const out: [number, number][][] = [];
  while (left.length) {
    let line = left.shift()!;
    for (let grown = true; grown; ) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const other = left[i];
        const first = line[0];
        const last = line[line.length - 1];
        let joined: [number, number][] | null = null;
        if (near(last, other[0])) joined = [...line, ...other.slice(1)];
        else if (near(last, other[other.length - 1])) joined = [...line, ...[...other].reverse().slice(1)];
        else if (near(first, other[other.length - 1])) joined = [...other, ...line.slice(1)];
        else if (near(first, other[0])) joined = [...[...other].reverse(), ...line.slice(1)];
        if (!joined) continue;
        line = joined;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(line);
  }
  return out;
}
