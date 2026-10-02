// Roads edited a block at a time. An Overture segment often runs through
// several junctions, and keyed by segment a colour meant for one block went
// on down the street. So an edit can cover a range of its segment, by the
// fraction of the segment's length from its start, the way Overture scopes
// its own rules (`between`):
//
//   r:<segment id>            the whole segment, as before
//   r:<segment id>@0.25-0.5   a quarter of it
//
// A click selects a block: the stretch between two junctions where another
// printed road meets it, a split the user made, or the end of an edit. Edits
// apply by range, never by block, so one made on a block still lands on the
// same stretch when the junctions differ (another scale merges close ones,
// another release moves them). Where ranges overlap, the narrowest wins, one
// field at a time.
//
// Setting a field on a block clears it from smaller ranges inside it, and
// clearing one carves the block out of any wider edit that sets it, so a
// block of a street in a custom layer can be put back on its own. Splits are
// kept on the segment's own edit (`splits`).

import type { ModelEdits, ObjectEdit } from './types';

/** Places kept after the point in a range key. 1e-5 of a 10 km segment is 10 cm. */
const DIGITS = 5;
const EPSILON = 0.5 * 10 ** -DIGITS;
/** Splits one segment may have. */
export const MAX_SPLITS = 200;
/** The fields an edit of a road range can hold. */
const ROAD_FIELDS = ['removed', 'layer', 'heightMm', 'widthMm'] as const;
type RoadField = (typeof ROAD_FIELDS)[number];

export interface RoadRange {
  /** The segment's key, `r:<id>`. */
  segment: string;
  from: number;
  to: number;
}

/** A position along a segment as it's written in keys. */
export function roundAt(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10 ** DIGITS) / 10 ** DIGITS));
}

function formatAt(value: number): string {
  return String(roundAt(value));
}

/** The key for a range of a segment: the segment's own key when it's all of it. */
export function roadKey(segment: string, from: number, to: number): string {
  const a = roundAt(from);
  const b = roundAt(to);
  return a <= 0 && b >= 1 ? segment : `${segment}@${formatAt(a)}-${formatAt(b)}`;
}

/** A road key's segment and range, or null for anything else (a bridge is `br:`). */
export function parseRoadKey(key: string): RoadRange | null {
  if (!key.startsWith('r:')) return null;
  const at = key.indexOf('@');
  if (at < 0) return { segment: key, from: 0, to: 1 };
  const match = /^(\d*\.?\d+)-(\d*\.?\d+)$/.exec(key.slice(at + 1));
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!(from >= 0 && to <= 1 && to - from > EPSILON)) return null;
  return { segment: key.slice(0, at), from, to };
}

/** The segment key of a road key, or the key itself for anything else. */
export function roadSegment(key: string): string {
  if (!key.startsWith('r:')) return key;
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/** A road key put the way roadKey writes it, or null when it isn't one. */
export function normalRoadKey(key: string): string | null {
  const range = parseRoadKey(key);
  return range ? roadKey(range.segment, range.from, range.to) : null;
}

export interface RangeEdit {
  key: string;
  from: number;
  to: number;
  edit: ObjectEdit;
}

/** One segment's edits: every range, the whole segment's included, and its splits. */
export interface SegmentEdits {
  ranges: RangeEdit[];
  splits: number[];
}

const indexes = new WeakMap<ModelEdits['objects'], Map<string, SegmentEdits>>();

/** The road edits by segment, worked out once per edits object. */
export function roadEdits(objects: ModelEdits['objects']): Map<string, SegmentEdits> {
  let index = indexes.get(objects);
  if (index) return index;
  index = new Map();
  for (const [key, edit] of Object.entries(objects)) {
    const range = parseRoadKey(key);
    if (!range) continue;
    let entry = index.get(range.segment);
    if (!entry) index.set(range.segment, (entry = { ranges: [], splits: [] }));
    entry.ranges.push({ key, from: range.from, to: range.to, edit });
    if (edit.splits && range.from <= 0 && range.to >= 1) entry.splits = edit.splits;
  }
  // Widest first, so a merge in order lets the narrowest win.
  for (const entry of index.values()) entry.ranges.sort(byWidth);
  indexes.set(objects, index);
  return index;
}

function byWidth(a: { from: number; to: number }, b: { from: number; to: number }): number {
  return b.to - b.from - (a.to - a.from) || a.from - b.from;
}

function fieldsOf(edit: ObjectEdit): Partial<Pick<ObjectEdit, RoadField>> {
  const out: Partial<Pick<ObjectEdit, RoadField>> = {};
  for (const field of ROAD_FIELDS) if (edit[field] !== undefined) (out as Record<string, unknown>)[field] = edit[field];
  return out;
}

/** The edit that applies over [from, to], from every range holding all of it. Undefined for none. */
export function editOver(entry: SegmentEdits | undefined, from: number, to: number): ObjectEdit | undefined {
  if (!entry) return undefined;
  let out: ObjectEdit | undefined;
  for (const range of entry.ranges) {
    if (range.from > from + EPSILON || range.to < to - EPSILON) continue;
    const fields = fieldsOf(range.edit);
    if (Object.keys(fields).length) out = { ...out, ...fields };
  }
  return out;
}

/** The edit that applies at a point of a segment. */
export function editAt(entry: SegmentEdits | undefined, at: number): ObjectEdit | undefined {
  if (!entry) return undefined;
  let out: ObjectEdit | undefined;
  for (const range of entry.ranges) {
    if (at < range.from - EPSILON || at > range.to + EPSILON) continue;
    const fields = fieldsOf(range.edit);
    if (Object.keys(fields).length) out = { ...out, ...fields };
  }
  return out;
}

/** The edit as it applies to a road key, whole segment or block, from every range holding it. */
export function roadEditOf(objects: ModelEdits['objects'], key: string): ObjectEdit | undefined {
  const range = parseRoadKey(key);
  if (!range) return objects[key];
  return editOver(roadEdits(objects).get(range.segment), range.from, range.to);
}

/**
 * Where a segment's blocks start and end: its ends, the junctions given, its
 * splits, and the ends of its edits' ranges, sorted. A block is the stretch
 * between two neighbours.
 */
export function blockBounds(entry: SegmentEdits | undefined, junctions: readonly number[] = []): number[] {
  const all = [0, 1, ...junctions];
  if (entry) {
    all.push(...entry.splits);
    for (const range of entry.ranges) all.push(range.from, range.to);
  }
  const sorted = all.map(roundAt).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (!out.length || v - out[out.length - 1] > EPSILON) out.push(v);
  return out;
}

/** The block of a segment that holds a point, as a key. */
export function blockAt(segment: string, bounds: readonly number[], at: number): string {
  for (let i = 1; i < bounds.length; i++) if (at <= bounds[i] + EPSILON || i === bounds.length - 1) return roadKey(segment, bounds[i - 1], bounds[i]);
  return segment;
}


/**
 * A copy of the edits being written, with each segment's road keys kept up
 * to date as it goes, and every key it wrote.
 */
class RoadWriter {
  readonly objects: ModelEdits['objects'];
  readonly touched = new Set<string>();
  private readonly bySegment = new Map<string, Set<string>>();

  constructor(objects: ModelEdits['objects']) {
    this.objects = { ...objects };
    for (const key of Object.keys(objects)) this.index(key);
  }

  private index(key: string): void {
    if (!key.startsWith('r:')) return;
    const segment = roadSegment(key);
    let keys = this.bySegment.get(segment);
    if (!keys) this.bySegment.set(segment, (keys = new Set()));
    keys.add(key);
  }

  put(key: string, edit: ObjectEdit): void {
    this.touched.add(key);
    if (Object.keys(edit).length) {
      this.objects[key] = edit;
      this.index(key);
    } else {
      delete this.objects[key];
      this.bySegment.get(roadSegment(key))?.delete(key);
    }
  }

  /** A segment's ranges as they are now, widest first. */
  entry(segment: string): SegmentEdits {
    const ranges: RangeEdit[] = [];
    let splits: number[] = [];
    for (const key of this.bySegment.get(segment) ?? []) {
      const range = parseRoadKey(key);
      const edit = this.objects[key];
      if (!range || !edit) continue;
      ranges.push({ key, from: range.from, to: range.to, edit });
      if (key === segment && edit.splits) splits = edit.splits;
    }
    return { ranges: ranges.sort(byWidth), splits };
  }

  /** A patch on one range: set fields cleared from ranges inside it, cleared ones carved out of ranges around it. */
  write(key: string, patch: Partial<ObjectEdit>): void {
    const range = parseRoadKey(key);
    if (!range) return;
    const { segment, from, to } = range;
    const own = roadKey(segment, from, to);
    for (const field of ROAD_FIELDS) {
      if (!(field in patch)) continue;
      const value = patch[field];
      // Narrowest first.
      const ranges = this.entry(segment).ranges.reverse();
      for (const other of ranges) {
        const inside = other.from >= from - EPSILON && other.to <= to + EPSILON;
        if (other.key !== own && inside && other.edit[field] !== undefined) this.put(other.key, without(other.edit, field));
      }
      if (value !== undefined) {
        this.put(own, { ...this.objects[own], [field]: value });
        continue;
      }
      if (this.objects[own]?.[field] !== undefined) this.put(own, without(this.objects[own], field));
      // Carved out of every wider range that sets it, narrowest first: the
      // pieces either side keep its value unless something narrower set one
      // there already.
      for (const other of ranges) {
        const holds = other.key !== own && other.from <= from + EPSILON && other.to >= to - EPSILON;
        const current = this.objects[other.key];
        if (!holds || current?.[field] === undefined) continue;
        const kept = current[field];
        this.put(other.key, without(current, field));
        const sides: [number, number][] = [
          [other.from, from],
          [to, other.to],
        ];
        for (const [a, b] of sides) {
          if (b - a <= EPSILON) continue;
          const side = roadKey(segment, a, b);
          if (this.objects[side]?.[field] === undefined) this.put(side, { ...this.objects[side], [field]: kept });
        }
      }
    }
  }

  /**
   * A segment's edits doing the same with less: fields that only repeat what
   * a wider range sets go, and neighbouring ranges that say the same join
   * where nothing else ends between them and there's no split.
   */
  tidy(segment: string): void {
    for (let changed = true; changed; ) {
      changed = false;
      const entry = this.entry(segment);
      for (const range of entry.ranges) {
        let inherited: ObjectEdit = {};
        for (const other of entry.ranges) {
          const wider = other !== range && other.from <= range.from + EPSILON && other.to >= range.to - EPSILON && other.to - other.from > range.to - range.from + EPSILON;
          if (wider) inherited = { ...inherited, ...fieldsOf(other.edit) };
        }
        let edit = range.edit;
        for (const field of ROAD_FIELDS) if (edit[field] !== undefined && edit[field] === inherited[field]) edit = without(edit, field);
        if (edit !== range.edit) {
          this.put(range.key, edit);
          changed = true;
        }
      }
      if (changed) continue;
      const ends = new Map<number, number>();
      for (const range of entry.ranges) for (const v of [range.from, range.to]) ends.set(roundAt(v), (ends.get(roundAt(v)) ?? 0) + 1);
      const parts = entry.ranges.filter((range) => range.from > EPSILON || range.to < 1 - EPSILON);
      for (const a of parts) {
        const b = parts.find((other) => other !== a && Math.abs(a.to - other.from) <= EPSILON);
        if (!b || ends.get(roundAt(a.to)) !== 2) continue;
        if (entry.splits.some((split) => Math.abs(split - a.to) <= EPSILON)) continue;
        if (JSON.stringify(fieldsOf(a.edit)) !== JSON.stringify(fieldsOf(b.edit))) continue;
        const joined = roadKey(segment, a.from, b.to);
        if (this.objects[joined]) continue;
        this.put(a.key, {});
        this.put(b.key, {});
        this.put(joined, fieldsOf(a.edit));
        changed = true;
        break;
      }
    }
  }
}

/**
 * The edits with a patch written to road keys, whole segments or blocks. A
 * field set on a range is cleared from smaller ranges inside it, and a field
 * cleared (undefined) is carved out of wider ranges that set it. Returns the
 * edits and every key written, for undo.
 */
export function writeRoads(objects: ModelEdits['objects'], keys: readonly string[], patch: Partial<ObjectEdit>): { objects: ModelEdits['objects']; touched: string[] } {
  const writer = new RoadWriter(objects);
  const segments = new Set<string>();
  for (const key of keys) {
    if (!parseRoadKey(key)) continue;
    writer.write(key, patch);
    segments.add(roadSegment(key));
  }
  for (const segment of segments) writer.tidy(segment);
  return { objects: writer.objects, touched: [...writer.touched] };
}

function without(edit: ObjectEdit, field: keyof ObjectEdit): ObjectEdit {
  const { [field]: _gone, ...rest } = edit;
  return rest;
}

/** The edits with a split added to a segment. Null when there's one there already, or it has as many as it may. */
export function addSplit(objects: ModelEdits['objects'], segment: string, at: number): ModelEdits['objects'] | null {
  const value = roundAt(at);
  if (value <= EPSILON || value >= 1 - EPSILON) return null;
  const edit = objects[segment] ?? {};
  const splits = edit.splits ?? [];
  if (splits.length >= MAX_SPLITS || splits.some((split) => Math.abs(split - value) <= EPSILON)) return null;
  return { ...objects, [segment]: { ...edit, splits: [...splits, value].sort((a, b) => a - b) } };
}

/**
 * The edits with a split taken out. The blocks either side become one, with
 * the edits of the longer of the two where they differed, so nothing is left
 * cut there. `bounds` are the segment's block bounds as the viewer has them.
 */
export function removeSplit(
  objects: ModelEdits['objects'],
  segment: string,
  at: number,
  bounds: readonly number[],
): { objects: ModelEdits['objects']; touched: string[]; differed: boolean } | null {
  const splits = objects[segment]?.splits ?? [];
  const index = splits.findIndex((split) => Math.abs(split - at) <= EPSILON);
  if (index < 0) return null;
  const point = splits[index];
  const left = [...bounds].reverse().find((v) => v < point - EPSILON) ?? 0;
  const right = bounds.find((v) => v > point + EPSILON) ?? 1;
  const entry = roadEdits(objects).get(segment);
  const before = editOver(entry, left, point) ?? {};
  const after = editOver(entry, point, right) ?? {};
  const writer = new RoadWriter(objects);
  const { splits: _old, ...plain } = writer.objects[segment];
  const rest = splits.filter((_, i) => i !== index);
  writer.put(segment, rest.length ? { ...plain, splits: rest } : plain);
  const winner = point - left >= right - point ? before : after;
  const patch: Partial<ObjectEdit> = {};
  for (const field of ROAD_FIELDS) if (before[field] !== after[field]) (patch as Record<string, unknown>)[field] = winner[field];
  if (Object.keys(patch).length) writer.write(roadKey(segment, left, right), patch);
  writer.tidy(segment);
  return { objects: writer.objects, touched: [...writer.touched], differed: Object.keys(patch).length > 0 };
}

/** Every key of a segment's edits, the whole segment's included. */
export function segmentKeys(objects: ModelEdits['objects'], segment: string): string[] {
  return (roadEdits(objects).get(segment)?.ranges ?? []).map((range) => range.key);
}
