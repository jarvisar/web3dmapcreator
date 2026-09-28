// Normalized LiDAR returns in columns, and a bucket index over them.
//
// Every reader produces the same columns: XY in a local metric frame, Z in
// metres in the survey's own vertical datum (heights are always roof minus
// ground within one survey, never against the terrain DEM), the ASPRS class,
// whether the pulse had a single return, and the capture year with how that
// year is known.

export interface Points {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  cls: Uint8Array;
  /** 1 when the pulse had one return. */
  single: Uint8Array;
  /** Capture year, 0 when unknown. */
  year: Uint16Array;
  /** How the year is known: 1 GPS time declared, 0.75 reported acquisition, 0.5 inferred, 0 unknown. */
  confidence: Float32Array;
}

export function emptyPoints(count = 0): Points {
  return {
    count,
    x: new Float64Array(count),
    y: new Float64Array(count),
    z: new Float64Array(count),
    cls: new Uint8Array(count),
    single: new Uint8Array(count),
    year: new Uint16Array(count),
    confidence: new Float32Array(count),
  };
}

/** The rows at `indices`, in that order. */
export function take(points: Points, indices: ArrayLike<number>): Points {
  const out = emptyPoints(indices.length);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    out.x[k] = points.x[i];
    out.y[k] = points.y[i];
    out.z[k] = points.z[i];
    out.cls[k] = points.cls[i];
    out.single[k] = points.single[i];
    out.year[k] = points.year[i];
    out.confidence[k] = points.confidence[i];
  }
  return out;
}

/** Rows where `keep` returns true. */
export function filter(points: Points, keep: (i: number) => boolean): Points {
  const indices: number[] = [];
  for (let i = 0; i < points.count; i++) if (keep(i)) indices.push(i);
  return take(points, indices);
}

export function concat(parts: Points[]): Points {
  let total = 0;
  for (const p of parts) total += p.count;
  const out = emptyPoints(total);
  let offset = 0;
  for (const p of parts) {
    out.x.set(p.x.subarray(0, p.count), offset);
    out.y.set(p.y.subarray(0, p.count), offset);
    out.z.set(p.z.subarray(0, p.count), offset);
    out.cls.set(p.cls.subarray(0, p.count), offset);
    out.single.set(p.single.subarray(0, p.count), offset);
    out.year.set(p.year.subarray(0, p.count), offset);
    out.confidence.set(p.confidence.subarray(0, p.count), offset);
    offset += p.count;
  }
  return out;
}

/** Plain xyz triplets, the shape the envelope works on. */
export interface Xyz {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

export function xyz(count: number): Xyz {
  return { count, x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count) };
}

export function xyzOf(points: Points | Xyz, indices?: ArrayLike<number>): Xyz {
  if (!indices) return { count: points.count, x: points.x.slice(0, points.count), y: points.y.slice(0, points.count), z: points.z.slice(0, points.count) };
  const out = xyz(indices.length);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    out.x[k] = points.x[i];
    out.y[k] = points.y[i];
    out.z[k] = points.z[i];
  }
  return out;
}

export function concatXyz(parts: Xyz[]): Xyz {
  let total = 0;
  for (const p of parts) total += p.count;
  const out = xyz(total);
  let offset = 0;
  for (const p of parts) {
    out.x.set(p.x.subarray(0, p.count), offset);
    out.y.set(p.y.subarray(0, p.count), offset);
    out.z.set(p.z.subarray(0, p.count), offset);
    offset += p.count;
  }
  return out;
}

/** Points bucketed into square cells, for bounding-box queries. */
export class PointIndex {
  readonly points: Points;
  private readonly cell: number;
  private readonly buckets = new Map<number, Int32Array>();

  constructor(points: Points, cell = 64) {
    this.points = points;
    this.cell = cell;
    const lists = new Map<number, number[]>();
    for (let i = 0; i < points.count; i++) {
      const key = this.key(Math.floor(points.x[i] / cell), Math.floor(points.y[i] / cell));
      let list = lists.get(key);
      if (!list) lists.set(key, (list = []));
      list.push(i);
    }
    for (const [key, list] of lists) this.buckets.set(key, Int32Array.from(list));
  }

  private key(cx: number, cy: number): number {
    return (cx + 1048576) * 2097152 + (cy + 1048576);
  }

  /** Indices of the points in every cell that the box touches, in cell order. */
  queryIndices(x0: number, y0: number, x1: number, y1: number): Int32Array {
    const parts: Int32Array[] = [];
    let total = 0;
    for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
      for (let cy = Math.floor(y0 / this.cell); cy <= Math.floor(y1 / this.cell); cy++) {
        const bucket = this.buckets.get(this.key(cx, cy));
        if (bucket) {
          parts.push(bucket);
          total += bucket.length;
        }
      }
    }
    const out = new Int32Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  query(box: [number, number, number, number]): Points {
    return take(this.points, this.queryIndices(box[0], box[1], box[2], box[3]));
  }
}
