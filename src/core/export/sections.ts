// Print sections: equal rectangles over the model, one per plate. Models here
// are already square to the area, so the grid has no rotation.

import { formatG } from './format';

export const BAMBU_MAX_PLATES = 36;
// Any more and the scale or section size is almost certainly a mistake.
export const MAX_SECTIONS = 400;
// Bambu PartPlateList: virtual plates are one bed apart plus a fifth of a bed
// (LOGICAL_PART_PLATE_GAP), in columns of ceil(sqrt(count)), rows downward.
const PLATE_STRIDE = 1.2;

export interface Section {
  row: number;
  column: number;
  /** west, south, east, north in model mm. */
  bounds: [number, number, number, number];
  /** "Section R1 C1" */
  name: string;
}

/**
 * Sections needed along one side. The allowance keeps float noise from
 * adding a section: 3 km at 0.07 mm/m is 210.00000000000003 mm, which is one
 * 210 mm section, not two. The UI's plate count uses this too.
 */
export function sectionCount(length: number, max: number): number {
  return Math.max(1, Math.ceil(length / max - 1e-9));
}

/**
 * Equal rectangles, north to south then west to east, with no skinny
 * remainder. Each edge is computed once, so neighbouring cells share exactly
 * the same float at a seam.
 */
export function sectionGrid(
  bounds: [number, number, number, number],
  maxWidth = 210,
  maxHeight = 210,
  bedWidth = 256,
  bedDepth = 256,
): Section[] {
  if (bounds.length !== 4 || !bounds.every(Number.isFinite)) {
    throw new Error('The model must have finite dimensions');
  }
  if (![bedWidth, bedDepth].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error('The printer bed must have positive dimensions');
  }
  if (![maxWidth, maxHeight].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error('Maximum section dimensions must be greater than 0');
  }
  if (maxWidth > bedWidth || maxHeight > bedDepth) {
    throw new Error(`Maximum section dimensions exceed the ${formatG(bedWidth)} x ${formatG(bedDepth)} mm bed`);
  }
  const [west, south, east, north] = bounds;
  if (east <= west || north <= south) throw new Error('The model must have nonzero width and height');
  const columns = sectionCount(east - west, maxWidth);
  const rows = sectionCount(north - south, maxHeight);
  if (rows * columns > MAX_SECTIONS) {
    throw new Error(`The model needs a ${rows} x ${columns} grid of sections. Make the sections larger or reduce the scale`);
  }
  const xs: number[] = [];
  for (let i = 0; i < columns; i++) xs.push(west + ((east - west) * i) / columns);
  xs.push(east);
  const ys: number[] = [];
  for (let i = 0; i < rows; i++) ys.push(north - ((north - south) * i) / rows);
  ys.push(south);
  const cells: Section[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      cells.push({
        row: r + 1,
        column: c + 1,
        bounds: [xs[c], ys[r + 1], xs[c + 1], ys[r]],
        name: `Section R${r + 1} C${c + 1}`,
      });
    }
  }
  return cells;
}

/**
 * Offsets that pull sections `gap` mm apart while each keeps its place in the
 * grid. Columns come from the distinct west edges and rows from the distinct
 * north edges, which sectionGrid cells share exactly.
 */
export function explodedOffsets(bounds: [number, number, number, number][], gap: number): [number, number][] {
  const wests = [...new Set(bounds.map((b) => b[0]))].sort((a, b) => a - b);
  const norths = [...new Set(bounds.map((b) => b[3]))].sort((a, b) => b - a);
  return bounds.map((b) => {
    const row = norths.indexOf(b[3]);
    return [wests.indexOf(b[0]) * gap, row ? -row * gap : 0];
  });
}

const SECTION_GAP_MM = 10;

/** XY translation of each plate: sections pulled apart, then the whole layout centred on the bed. */
export function sideBySide(
  bounds: [number, number, number, number][],
  bedWidth: number,
  bedDepth: number,
  gap = SECTION_GAP_MM,
): [number, number][] {
  const offsets = bounds.length > 1 ? explodedOffsets(bounds, gap) : bounds.map((): [number, number] => [0, 0]);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  bounds.forEach(([w, s, e, n], i) => {
    const [dx, dy] = offsets[i];
    west = Math.min(west, w + dx);
    south = Math.min(south, s + dy);
    east = Math.max(east, e + dx);
    north = Math.max(north, n + dy);
  });
  const cx = bedWidth / 2 - (west + east) / 2;
  const cy = bedDepth / 2 - (south + north) / 2;
  return offsets.map(([dx, dy]) => [dx + cx, dy + cy]);
}

/** Bambu PartPlateList: ceil(sqrt(count)) columns, 20% bed spacing, rows downward. */
export function plateOrigin(index: number, count: number, bedWidth = 256, bedDepth = 256): [number, number] {
  const columns = Math.ceil(Math.sqrt(count));
  const row = Math.floor(index / columns);
  return [((index % columns) * bedWidth) * PLATE_STRIDE, row === 0 ? 0 : (-row * bedDepth) * PLATE_STRIDE];
}
