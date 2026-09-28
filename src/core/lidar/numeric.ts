// The handful of numpy operations the measurements need, with numpy's
// conventions: linear quantiles, medians of even counts, least squares with
// its rank rule.

/** Median, averaging the two middle values of an even count. NaN when empty. */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (!n) return NaN;
  const sorted = Float64Array.from(values).sort();
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** numpy's default (linear) quantile. */
export function quantile(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values).sort();
  return sortedQuantile(sorted, q);
}

export function sortedQuantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const position = q * (n - 1);
  const lo = Math.floor(position);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

export function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

/** First index with sorted[i] > value (numpy searchsorted, side='right'). */
export function searchRight(sorted: ArrayLike<number>, value: number, from = 0): number {
  let lo = from;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with sorted[i] >= value (side='left'). */
export function searchLeft(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Eigen decomposition of a symmetric 3x3 matrix by Jacobi rotations. */
function eigenSymmetric3(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-300) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

/**
 * Least squares for up to three unknowns, like numpy.linalg.lstsq with its
 * default rcond: singular values under eps * max(rows, cols) times the
 * largest count as zero, and the minimum-norm solution is returned.
 * `design` is row-major, `cols` values per row.
 */
export function lstsq(design: ArrayLike<number>, rhs: ArrayLike<number>, cols: number): { coef: number[]; rank: number } {
  const rows = rhs.length;
  const ata = Array.from({ length: 3 }, () => [0, 0, 0]);
  const atb = [0, 0, 0];
  // Centre nothing: callers already centre their coordinates.
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const a = design[r * cols + i];
      atb[i] += a * rhs[r];
      for (let j = i; j < cols; j++) ata[i][j] += a * design[r * cols + j];
    }
  }
  for (let i = 0; i < cols; i++) for (let j = 0; j < i; j++) ata[i][j] = ata[j][i];
  for (let i = cols; i < 3; i++) ata[i][i] = 0;
  const { values, vectors } = eigenSymmetric3(ata);
  const singular = values.map((l) => Math.sqrt(Math.max(l, 0)));
  const largest = Math.max(...singular.slice(0, 3));
  const cutoff = 2.220446049250313e-16 * Math.max(rows, cols) * largest;
  let rank = 0;
  const coef = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (!(singular[k] > cutoff) || values[k] <= 0) continue;
    rank++;
    // Project A^T b onto the eigenvector and divide by the eigenvalue.
    let dot = 0;
    for (let i = 0; i < 3; i++) dot += vectors[i][k] * atb[i];
    for (let i = 0; i < 3; i++) coef[i] += (vectors[i][k] * dot) / values[k];
  }
  return { coef: coef.slice(0, cols), rank: Math.min(rank, cols) };
}

/** Solve a 3x3 system; null when singular. */
export function solve3(m: number[][], b: number[]): number[] | null {
  const [[a, bb, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (!det || !Number.isFinite(det)) return null;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}
