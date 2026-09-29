import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BORDER, computeLayout } from '../layout/layout';
import { PRODUCT_PRESETS } from '../presets';
import { type HersheyFile, parseHershey } from './hershey';
import { DEFAULT_LABEL, LabelError, buildLabel, layoutBoxLabel } from './label';
import { parseOutlineFont } from './loadFont';
import { geometryBounds, textGeometry } from './outline';

const hershey = { kind: 'stroke' as const, font: parseHershey(JSON.parse(readFileSync('public/fonts/hershey/futural.json', 'utf8')) as HersheyFile) };
const bytes = readFileSync('public/fonts/Montserrat-SemiBold.ttf');
const montserrat = parseOutlineFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const plaque = computeLayout(PRODUCT_PRESETS[0].product, DEFAULT_BORDER);

const inside = (outer: [number, number, number, number], p: [number, number]) =>
  p[0] >= outer[0] - 1e-9 && p[0] <= outer[0] + outer[2] + 1e-9 && p[1] >= outer[1] - 1e-9 && p[1] <= outer[1] + outer[3] + 1e-9;

describe('text geometry', () => {
  it('outlines a word with an outline font', () => {
    const g = textGeometry(montserrat, 'CHICAGO');
    expect(g.rings.length).toBeGreaterThan(7);
    expect(g.strokes).toHaveLength(0);
  });

  it('draws a word as strokes with a single-line font', () => {
    const g = textGeometry(hershey, 'ROME');
    expect(g.rings).toHaveLength(0);
    expect(g.strokes.length).toBeGreaterThan(4);
  });

  it('spreads letters apart with letter spacing', () => {
    const tight = geometryBounds(textGeometry(montserrat, 'ROME', 1))!;
    const wide = geometryBounds(textGeometry(montserrat, 'ROME', 1.5))!;
    expect(wide[2] - wide[0]).toBeGreaterThan((tight[2] - tight[0]) * 1.2);
  });
});

describe('title layout', () => {
  it('puts the box in the lower right corner, inside the border', () => {
    const artwork = layoutBoxLabel(plaque, DEFAULT_LABEL, textGeometry(montserrat, 'CHICAGO'))!;
    const [x, y, w, h] = artwork.knockout;
    const a = plaque.labelAnchor;
    expect(x + w).toBeCloseTo(a.x + a.w - DEFAULT_LABEL.gap, 9);
    expect(y + h).toBeCloseTo(a.y + a.h - DEFAULT_LABEL.gap, 9);
    for (const ring of artwork.text.rings) for (const p of ring) expect(inside(artwork.knockout, p)).toBe(true);
  });

  it('keeps the reference text height', () => {
    const artwork = layoutBoxLabel(plaque, DEFAULT_LABEL, textGeometry(montserrat, 'CHICAGO'))!;
    const b = geometryBounds(artwork.text)!;
    expect(b[3] - b[1]).toBeCloseTo(DEFAULT_LABEL.textHeight * DEFAULT_LABEL.textScale, 6);
  });

  it('turns the box with the text', () => {
    const upright = layoutBoxLabel(plaque, DEFAULT_LABEL, textGeometry(montserrat, 'CHICAGO'));
    const turned = layoutBoxLabel(plaque, { ...DEFAULT_LABEL, rotation: 90 }, textGeometry(montserrat, 'CHICAGO'));
    expect(turned.knockout[2]).toBeCloseTo(upright.knockout[3], 9);
    expect(turned.knockout[3]).toBeCloseTo(upright.knockout[2], 9);
  });

  it('refuses a title too big for the piece', () => {
    expect(() => layoutBoxLabel(plaque, { ...DEFAULT_LABEL, size: 1000 }, textGeometry(montserrat, 'CHICAGO'))).toThrow(LabelError);
  });

  it('fits a title band with a subtitle at the bottom', () => {
    const s = { ...DEFAULT_LABEL, style: 'band' as const, subtitle: 'ILLINOIS' };
    const { artwork } = buildLabel(plaque, s, montserrat, montserrat);
    const [, y, , h] = artwork!.knockout;
    expect(y + h).toBeCloseTo(plaque.bandAnchor.y + plaque.bandAnchor.h, 9);
    expect(h).toBeCloseTo((plaque.bandAnchor.h * s.bandHeight) / 100, 9);
    expect(artwork!.frame).toHaveLength(1);
  });

  it('reports a problem instead of throwing', () => {
    const { artwork, error } = buildLabel(plaque, { ...DEFAULT_LABEL, size: 1000 }, montserrat, montserrat);
    expect(artwork).toBeNull();
    expect(error).toMatch(/does not fit/);
  });
});
