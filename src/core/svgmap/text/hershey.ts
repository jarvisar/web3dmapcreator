// Single-line fonts, drawn along the centre of each letter the way a pen writes.
//
// Glyph data is from hersheytext (public domain), converted into
// public/fonts/hershey. The Hershey Fonts were originally created by Dr. A. V.
// Hershey while working at the U.S. National Bureau of Standards. The format of
// the font data was originally created by James Hurt, Cognition, Inc.
export interface StrokeGlyph {
  advance: number;
  // Glyph units, y down, baseline at 0.
  strokes: [number, number][][];
}

export interface StrokeFont {
  name: string;
  // Glyph units per em, so stroke and outline fonts come out about the same size.
  scale: number;
  glyphs: Record<string, StrokeGlyph>;
}

// Hershey glyphs sit on a baseline at y = 22 with capitals about 21 units tall.
const BASELINE = 22;
const UNITS_PER_EM = 30;

export interface HersheyFile {
  name: string;
  notice: string;
  // char to [half the advance width, M/L path data]
  glyphs: Record<string, [number, string]>;
}

function parseStrokes(d: string): [number, number][][] {
  const strokes: [number, number][][] = [];
  let current: [number, number][] | null = null;
  const tokens = d.match(/[ML]|-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? [];
  for (const token of tokens) {
    if (token === 'M') {
      current = [];
      strokes.push(current);
    } else if (token === 'L') {
      continue;
    } else if (current) {
      const [x, y] = token.split(',').map(Number);
      current.push([x, y - BASELINE]);
    }
  }
  return strokes.filter((s) => s.length >= 2);
}

export function parseHershey(file: HersheyFile): StrokeFont {
  const glyphs: Record<string, StrokeGlyph> = {};
  for (const [char, [half, d]] of Object.entries(file.glyphs)) {
    glyphs[char] = { advance: half * 2, strokes: parseStrokes(d) };
  }
  // The data has no space. A Hershey space is about 16 units.
  glyphs[' '] = { advance: 16, strokes: [] };
  return { name: file.name, scale: 1 / UNITS_PER_EM, glyphs };
}
