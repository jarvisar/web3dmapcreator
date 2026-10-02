import { Font, Glyph, Path } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { textGeometry, visualOrder } from './outline';

describe('visualOrder', () => {
  it('leaves text without right-to-left letters alone', () => {
    for (const text of ['Chicago Loop', 'Race Day 2026', 'Ça (va) «bien»', 'مرحبا', '']) expect(visualOrder(text)).toBe(text);
  });

  it('reverses Hebrew, keeping numbers and the words around it in order', () => {
    expect(visualOrder('שלום')).toBe('םולש');
    // Right to left from the first letter, so the number goes on the left.
    expect(visualOrder('שלום 2026')).toBe('2026 םולש');
    expect(visualOrder('Tel Aviv תל אביב')).toBe('Tel Aviv ביבא לת');
    expect(visualOrder('תל אביב Tel Aviv')).toBe('Tel Aviv ביבא לת');
  });

  it('keeps points on their letters and turns brackets round', () => {
    // Shin with qamats and its dot, lamed, vav with holam, final mem.
    expect(visualOrder('שָׁלוֹם')).toBe('םוֹלשָׁ');
    expect(visualOrder('(שלום)')).toBe('(םולש)');
  });
});

describe('textGeometry', () => {
  // Glyphs of different heights, to tell them apart by where they land.
  const glyph = (name: string, unicode: number, height: number) => {
    const path = new Path();
    path.moveTo(10, 0);
    path.lineTo(90, 0);
    path.lineTo(90, height);
    path.lineTo(10, height);
    path.close();
    return new Glyph({ name, unicode, advanceWidth: 100, path });
  };
  const font = new Font({
    familyName: 'Test',
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [new Glyph({ name: '.notdef', advanceWidth: 100, path: new Path() }), glyph('alef', 0x5d0, 100), glyph('bet', 0x5d1, 200), glyph('gimel', 0x5d2, 300), glyph('A', 0x41, 400)],
  });
  // A parsed font has these. One built in memory doesn't.
  Object.assign(font, { kerningPairs: {} });
  // Glyph heights from left to right.
  const heights = (text: string) =>
    textGeometry({ kind: 'outline', font }, text)
      .rings.map((ring) => ({ x: Math.min(...ring.map((p) => p[0])), h: -Math.min(...ring.map((p) => p[1])) }))
      .sort((a, b) => a.x - b.x)
      .map((r) => Math.round(r.h * 1000));

  it('lays Hebrew out right to left', () => {
    expect(heights('אבג')).toEqual([300, 200, 100]);
    expect(heights('Aאב')).toEqual([400, 200, 100]);
    expect(heights('AAא')).toEqual([400, 400, 100]);
  });

  it('draws a letter at a time when the font cannot be shaped', () => {
    // As opentype.js does with Calibri, or Arial on Arabic.
    const arabic = new Font({
      familyName: 'Test',
      styleName: 'Regular',
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      glyphs: [new Glyph({ name: '.notdef', advanceWidth: 100, path: new Path() }), glyph('alef', 0x627, 100), glyph('beh', 0x628, 200), glyph('teh', 0x62a, 300), glyph('A', 0x41, 400)],
    });
    Object.assign(arabic, {
      kerningPairs: {},
      stringToGlyphs: () => {
        throw new Error('lookupType: 7 - substFormat: 1 is not yet supported');
      },
      getKerningValue: () => {
        throw new Error('lookupType: 9 is not yet supported');
      },
    });
    const g = textGeometry({ kind: 'outline', font: arabic }, 'ابت A');
    expect(g.unshaped).toBe(true);
    const order = g.rings
      .map((ring) => ({ x: Math.min(...ring.map((p) => p[0])), h: -Math.min(...ring.map((p) => p[1])) }))
      .sort((a, b) => a.x - b.x)
      .map((r) => Math.round(r.h * 1000));
    // Arabic right to left, since opentype.js didn't reverse it.
    expect(order).toEqual([400, 300, 200, 100]);
    expect(textGeometry({ kind: 'outline', font }, 'AA').unshaped).toBeUndefined();
  });
});
