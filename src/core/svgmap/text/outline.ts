// Text as geometry. Laser software doesn't read fonts, so letters always leave
// here as outlines or single-line strokes, never as SVG text.
// Coordinates are y down at a size of one em, baseline at 0.
import type { Font, Glyph, PathCommand } from 'opentype.js';
import type { Path, Point } from '../lines/geometry';
import type { StrokeFont } from './hershey';

export interface TextGeometry {
  // Outline fonts. Contours can overlap, so union them before use.
  rings: Path[];
  // Single-line fonts.
  strokes: Path[];
  // Drawn a character at a time, without the font's ligatures or Arabic joining (see outlineGlyphs).
  unshaped?: boolean;
}

export type LoadedFont = { kind: 'outline'; font: Font } | { kind: 'stroke'; font: StrokeFont };

function flattenCommands(commands: PathCommand[], tolerance: number): Path[] {
  const rings: Path[] = [];
  let ring: Path = [];
  let cx = 0;
  let cy = 0;
  const close = () => {
    if (ring.length >= 3) rings.push(ring);
    ring = [];
  };
  const pushPoint = (x: number, y: number) => {
    const last = ring[ring.length - 1];
    if (!last || last[0] !== x || last[1] !== y) ring.push([x, y]);
  };
  const tolSq = tolerance * tolerance;
  const cubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, depth: number) => {
    // Flat enough when both control points sit within tolerance of the chord.
    const dx = x3 - x0;
    const dy = y3 - y0;
    const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
    const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
    if (depth > 12 || (d1 + d2) * (d1 + d2) <= tolSq * (dx * dx + dy * dy)) {
      pushPoint(x3, y3);
      return;
    }
    const x01 = (x0 + x1) / 2;
    const y01 = (y0 + y1) / 2;
    const x12 = (x1 + x2) / 2;
    const y12 = (y1 + y2) / 2;
    const x23 = (x2 + x3) / 2;
    const y23 = (y2 + y3) / 2;
    const xa = (x01 + x12) / 2;
    const ya = (y01 + y12) / 2;
    const xb = (x12 + x23) / 2;
    const yb = (y12 + y23) / 2;
    const xm = (xa + xb) / 2;
    const ym = (ya + yb) / 2;
    cubic(x0, y0, x01, y01, xa, ya, xm, ym, depth + 1);
    cubic(xm, ym, xb, yb, x23, y23, x3, y3, depth + 1);
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        close();
        pushPoint(c.x, c.y);
        cx = c.x;
        cy = c.y;
        break;
      case 'L':
        pushPoint(c.x, c.y);
        cx = c.x;
        cy = c.y;
        break;
      case 'Q':
        // Turn the quadratic into a cubic so one routine handles both.
        cubic(
          cx,
          cy,
          cx + ((c.x1 - cx) * 2) / 3,
          cy + ((c.y1 - cy) * 2) / 3,
          c.x + ((c.x1 - c.x) * 2) / 3,
          c.y + ((c.y1 - c.y) * 2) / 3,
          c.x,
          c.y,
          0,
        );
        cx = c.x;
        cy = c.y;
        break;
      case 'C':
        cubic(cx, cy, c.x1, c.y1, c.x2, c.y2, c.x, c.y, 0);
        cx = c.x;
        cy = c.y;
        break;
      case 'Z':
        close();
        break;
    }
  }
  close();
  // Some fonts repeat the first point at the end.
  for (const r of rings) {
    const a = r[0];
    const b = r[r.length - 1];
    if (r.length > 3 && a[0] === b[0] && a[1] === b[1]) r.pop();
  }
  return rings;
}

// Hebrew and the other scripts written right to left that opentype.js leaves
// in the order they were typed. It reverses Arabic itself as it shapes it,
// so that's left to it.
const RTL = /[֐-׿܀-ݏހ-࡟יִ-ﭏ]/u;
// The same with Arabic, for text opentype.js couldn't shape (outlineGlyphs).
const RTL_WITH_ARABIC = /[֐-ݏݐ-࡟ࢠ-ࣿיִ-﷿ﹰ-﻿]/u;
const MIRRORED: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«', '‹': '›', '›': '‹' };

/**
 * Text in the order its glyphs go from left to right. A small part of the
 * bidi algorithm, enough for a name or a title: the first letter or digit
 * sets which way the text runs, right-to-left letters and the spaces and
 * punctuation between them are reversed, numbers keep their order, and in
 * right-to-left text the runs go right to left too. Text without these
 * scripts comes back as it is.
 */
export function visualOrder(text: string, arabic = false): string {
  const rtl = arabic ? RTL_WITH_ARABIC : RTL;
  if (!rtl.test(text)) return text;
  // Accents and points stay on their letters.
  const clusters = text.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];
  const strong = (cluster: string): 'l' | 'r' | null => (rtl.test(cluster) ? 'r' : /[\p{L}\p{Nd}]/u.test(cluster) ? 'l' : null);
  const dirs = clusters.map(strong);
  const base = dirs.find((d) => d !== null) ?? 'l';
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i] !== null) continue;
    let j = i;
    while (j < dirs.length && dirs[j] === null) j++;
    const before = i > 0 ? dirs[i - 1] : base;
    const after = j < dirs.length ? dirs[j] : base;
    dirs.fill(before === after ? before : base, i, j);
    i = j - 1;
  }
  const runs: { dir: 'l' | 'r' | null; clusters: string[] }[] = [];
  clusters.forEach((cluster, i) => {
    const last = runs[runs.length - 1];
    if (last?.dir === dirs[i]) last.clusters.push(cluster);
    else runs.push({ dir: dirs[i], clusters: [cluster] });
  });
  const ordered = base === 'r' ? runs.reverse() : runs;
  return ordered.map((run) => (run.dir === 'r' ? run.clusters.reverse().map((c) => MIRRORED[c] ?? c) : run.clusters).join('')).join('');
}

// spacing scales each glyph's advance. 1 is the font's own spacing.
export function textGeometry(loaded: LoadedFont, text: string, spacing = 1, tolerance = 0.0015): TextGeometry {
  if (loaded.kind === 'stroke') return strokeText(loaded.font, visualOrder(text), spacing);
  const font = loaded.font;
  const em = font.unitsPerEm;
  const { glyphs, shaped } = outlineGlyphs(font, text);
  const rings: Path[] = [];
  let x = 0;
  glyphs.forEach((glyph, i) => {
    const path = glyph.getPath(x, 0, 1);
    rings.push(...flattenCommands(path.commands, tolerance));
    const advance = (glyph.advanceWidth ?? 0) / em;
    const kern = i + 1 < glyphs.length ? kerning(font, glyph, glyphs[i + 1]) / em : 0;
    x += advance * spacing + kern;
  });
  return shaped ? { rings, strokes: [] } : { rings, strokes: [], unshaped: true };
}

// opentype.js throws on substitutions it can't apply (extension lookups, in
// Calibri for plain Latin and in most fonts with Arabic). That text gets each
// character's own glyph instead, with Arabic put in order by visualOrder.
function outlineGlyphs(font: Font, text: string): { glyphs: Glyph[]; shaped: boolean } {
  try {
    return { glyphs: font.stringToGlyphs(visualOrder(text)), shaped: true };
  } catch {
    // Latin ligatures are the usual culprit, and nobody misses an fi ligature on a map.
  }
  try {
    // It takes options, though the types don't say so.
    const shape = font.stringToGlyphs as (s: string, options: { features: Record<string, boolean> }) => Glyph[];
    return { glyphs: shape.call(font, visualOrder(text), { features: { liga: false, rlig: false } }), shaped: true };
  } catch {
    // charToGlyph itself can throw on a character the font lacks, so missing ones go to .notdef here.
    return { glyphs: Array.from(visualOrder(text, true), (char) => font.glyphs.get(font.charToGlyphIndex(char) || 0)), shaped: false };
  }
}

function kerning(font: Font, left: Glyph, right: Glyph): number {
  try {
    return font.getKerningValue(left, right);
  } catch {
    return 0;
  }
}

/** Characters of a text its font has no glyph for, and what's drawn in their place. */
export interface MissingGlyphs {
  chars: string[];
  /** An outline font's box, or nothing when that's empty. Single-line fonts draw a question mark. */
  shownAs: 'box' | 'gap' | 'question';
}

export function missingGlyphs(text: string, font: LoadedFont): MissingGlyphs | undefined {
  const chars = new Set<string>();
  for (const char of text.trim()) {
    if (/\s/u.test(char)) continue;
    const found = font.kind === 'outline' ? font.font.charToGlyphIndex(char) > 0 : font.font.glyphs[char] !== undefined;
    if (!found) chars.add(char);
  }
  if (!chars.size) return undefined;
  let shownAs: MissingGlyphs['shownAs'];
  if (font.kind === 'outline') shownAs = font.font.glyphs.get(0).getPath(0, 0, 1).commands.length ? 'box' : 'gap';
  else shownAs = font.font.glyphs['?'] ? 'question' : 'gap';
  return { chars: [...chars], shownAs };
}

function strokeText(font: StrokeFont, text: string, spacing: number): TextGeometry {
  const strokes: Path[] = [];
  let x = 0;
  for (const char of text) {
    const glyph = font.glyphs[char] ?? font.glyphs['?'];
    if (!glyph) continue;
    for (const stroke of glyph.strokes) {
      strokes.push(stroke.map(([gx, gy]): Point => [x + gx * font.scale, gy * font.scale]));
    }
    x += glyph.advance * font.scale * spacing;
  }
  return { rings: [], strokes };
}

export function geometryBounds(g: TextGeometry): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of [...g.rings, ...g.strokes]) {
    for (const [x, y] of path) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX) && maxX > minX && maxY > minY ? [minX, minY, maxX, maxY] : null;
}
