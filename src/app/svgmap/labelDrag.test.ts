import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BORDER, computeLayout } from '../../core/svgmap/layout/layout';
import { PRODUCT_PRESETS } from '../../core/svgmap/presets';
import { DEFAULT_LABEL, type LabelSettings, buildLabel } from '../../core/svgmap/text/label';
import { parseOutlineFont } from '../../core/svgmap/text/loadFont';
import { type TitleGrip, dragTitle, droppedLabel, handleAt, resizeCursor, spacedHandles, titleHandles } from './labelDrag';

const bytes = readFileSync('public/fonts/Montserrat-SemiBold.ttf');
const font = parseOutlineFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const plaque = computeLayout(PRODUCT_PRESETS[0].product, DEFAULT_BORDER);
const lay = (label: LabelSettings) => buildLabel(plaque, label, font, font).artwork;

function drag(label: LabelSettings, grip: TitleGrip, dx: number, dy: number) {
  const artwork = lay(label)!;
  const next = dragTitle(plaque, { grip, label, artwork }, dx, dy, lay);
  const after = lay(next)!;
  return { before: artwork.knockout, after: after.knockout, next, stored: droppedLabel(next, after) };
}

describe('resizing the title by its handles', () => {
  it('widens a box from its left side and keeps the right side put', () => {
    const { before, after, next } = drag(DEFAULT_LABEL, 'w', -10, 0);
    expect(after[2]).toBeCloseTo(before[2] + 10, 1);
    expect(after[0] + after[2]).toBeCloseTo(before[0] + before[2], 1);
    expect(next.boxWidth).toBeGreaterThan(0);
    expect(next.boxHeight).toBe(0);
  });

  it('makes a box taller from its top and keeps the bottom put', () => {
    const { before, after } = drag(DEFAULT_LABEL, 'n', 0, -6);
    expect(after[3]).toBeCloseTo(before[3] + 6, 1);
    expect(after[1] + after[3]).toBeCloseTo(before[1] + before[3], 6);
  });

  it('keeps a moved box where it was while it grows', () => {
    const moved = { ...DEFAULT_LABEL, offsetX: -0.3, offsetY: -0.3 };
    const { before, after, stored } = drag(moved, 'e', 12, 0);
    expect(after[0]).toBeCloseTo(before[0], 1);
    expect(after[2]).toBeCloseTo(before[2] + 12, 1);
    // What's stored lays out the same.
    expect(lay(stored)!.knockout[0]).toBeCloseTo(after[0], 1);
  });

  it('keeps a box flush with the bottom when a side squeezes its text', () => {
    const { before, after, next } = drag(DEFAULT_LABEL, 'w', 30, 0);
    expect(after[3]).toBeLessThan(before[3]);
    expect(after[1] + after[3]).toBeCloseTo(before[1] + before[3], 9);
    expect(next.offsetY).toBe(0);
  });

  it('scales the whole title from a corner', () => {
    const { before, after, next } = drag(DEFAULT_LABEL, 'nw', -20, -4);
    expect(next.size).toBeGreaterThan(DEFAULT_LABEL.size);
    expect(after[2] / before[2]).toBeCloseTo(next.size / DEFAULT_LABEL.size, 2);
    // The opposite corner stays in the lower right.
    expect(after[0] + after[2]).toBeCloseTo(before[0] + before[2], 6);
    expect(after[1] + after[3]).toBeCloseTo(before[1] + before[3], 6);
  });

  it('swaps the sides of a turned box', () => {
    const { next } = drag({ ...DEFAULT_LABEL, rotation: 90 }, 'n', 0, -10);
    expect(next.boxWidth).toBeGreaterThan(0);
    expect(next.boxHeight).toBe(0);
  });

  it('stops a box shrinking past its padding', () => {
    const { next } = drag(DEFAULT_LABEL, 'w', 500, 0);
    expect(lay(next)).not.toBeNull();
  });

  it('resizes a band from its edge', () => {
    const band = { ...DEFAULT_LABEL, style: 'band' as const };
    const { before, after, next } = drag(band, 'band', 0, -8);
    expect(after[3]).toBeCloseTo(before[3] + 8, 0);
    expect(next.bandHeight).toBeGreaterThan(band.bandHeight);
    const top = drag({ ...band, bandPosition: 'top' }, 'band', 0, -8);
    expect(top.next.bandHeight).toBeLessThan(band.bandHeight);
  });

  it('scales band text from its corners, unless autofit fills the band', () => {
    const band = { ...DEFAULT_LABEL, style: 'band' as const };
    expect(drag(band, 'text-se', -10, -2).next.size).toBeLessThan(band.size);
    expect(titleHandles({ ...band, autofit: true }, lay({ ...band, autofit: true })!).map((h) => h.id)).toEqual(['band']);
  });

  it('finds the handle under the pointer', () => {
    const handles = titleHandles(DEFAULT_LABEL, lay(DEFAULT_LABEL)!);
    const se = handles.find((h) => h.id === 'se')!;
    expect(handleAt(handles, se.x + 0.5, se.y - 0.5, 1)).toBe('se');
    expect(handleAt(handles, se.x + 5, se.y, 1)).toBeNull();
  });

  it('leaves out side handles crowding the corners of a small title', () => {
    const handles = titleHandles(DEFAULT_LABEL, lay(DEFAULT_LABEL)!);
    expect(spacedHandles(handles, (x, y) => [x * 10, y * 10], 18)).toHaveLength(8);
    // About 3 px a millimetre: the box is 34 px tall, so its side handles go.
    const few = spacedHandles(handles, (x, y) => [x * 3, y * 3], 18).map((h) => h.id);
    expect(few).toEqual(['nw', 'ne', 'se', 'sw', 'n', 's']);
  });

  it('picks resize cursors by direction', () => {
    expect(resizeCursor(1, 0)).toBe('ew-resize');
    expect(resizeCursor(0, -1)).toBe('ns-resize');
    expect(resizeCursor(1, 1)).toBe('nwse-resize');
    expect(resizeCursor(-1, 1)).toBe('nesw-resize');
  });
});
