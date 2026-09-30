// Shapes added in the editor, as footprints in model mm. What each is built
// down to is worked out in stand.ts.

import { bufferLines, intersection, normalize, unionRings } from '../geometry/polygon';
import type { Projection } from '../geo/projection';
import type { LoadedFont } from '../svgmap/text/outline';
import { geometryBounds, textGeometry } from '../svgmap/text/outline';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import type { AddedShape } from './types';

/** Local axes of a shape in model mm: `right` and `up` unit vectors and its anchor. */
interface Frame {
  at: Vec2;
  right: Vec2;
  up: Vec2;
}

function frameOf(shape: AddedShape, projection: Projection): Frame {
  const at = projection.toModel(shape.at[0], shape.at[1]);
  // The model frame is east/north turned by the area's rotation, so a
  // bearing from north turns the other way by as much.
  const phi = ((shape.rotationDeg - projection.rotationDeg) * Math.PI) / 180;
  return { at, up: [Math.sin(phi), Math.cos(phi)], right: [Math.cos(phi), -Math.sin(phi)] };
}

function place(frame: Frame, u: number, v: number): Vec2 {
  return [frame.at[0] + u * frame.right[0] + v * frame.up[0], frame.at[1] + u * frame.right[1] + v * frame.up[1]];
}

function circle(frame: Frame, cu: number, cv: number, radius: number, reverse = false): Vec2[] {
  const sides = Math.max(24, Math.min(96, Math.ceil((2 * Math.PI * radius) / 0.4)));
  const ring: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((reverse ? -1 : 1) * 2 * Math.PI * i) / sides;
    ring.push(place(frame, cu + radius * Math.cos(a), cv + radius * Math.sin(a)));
  }
  return ring;
}

/**
 * A map pin seen from above: a round head north of the tip, which marks the
 * spot, with a hole through the head.
 */
function pin(frame: Frame, size: number): Polygon {
  const r = size / 2;
  const reach = r * 1.9;
  // Tangents from the tip to the head.
  const gamma = Math.acos(r / reach);
  const down = -Math.PI / 2;
  const outer: Vec2[] = [place(frame, 0, 0)];
  const steps = 48;
  const from = down + gamma;
  const to = down - gamma + 2 * Math.PI;
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    outer.push(place(frame, r * Math.cos(a), reach + r * Math.sin(a)));
  }
  const hole = circle(frame, 0, reach, r * 0.42, true);
  return [outer, hole];
}

function textFootprint(shape: AddedShape, frame: Frame, font: LoadedFont): MultiPolygon {
  const text = shape.text.trim();
  if (!text) return [];
  const geometry = textGeometry(font, text);
  const bounds = geometryBounds(geometry);
  if (!bounds) return [];
  // Size is the height of a capital, so fonts of different proportions come out alike.
  let capHeight = 0.7;
  if (font.kind === 'outline') {
    const os2 = (font.font.tables as { os2?: { sCapHeight?: number } }).os2;
    if (os2?.sCapHeight) capHeight = os2.sCapHeight / font.font.unitsPerEm;
  } else {
    capHeight = Math.max(0.2, -bounds[1]);
  }
  const scale = shape.sizeMm / capHeight;
  const cx = (bounds[0] + bounds[2]) / 2;
  // Glyphs are y down with the baseline at 0: centre on half a capital's height.
  const toModel = ([x, y]: Vec2) => place(frame, (x - cx) * scale, (-y - capHeight / 2) * scale);
  if (font.kind === 'outline') {
    // Contours overlap within a glyph and between neighbours, and counters
    // run the other way round. Flipping y reverses them all alike.
    return unionRings(geometry.rings.map((ring) => ring.map(toModel)));
  }
  const stroke = Math.max(0.4, shape.sizeMm * 0.14);
  return bufferLines(geometry.strokes.map((line) => ({ points: line.map(toModel), width: stroke })), 'round');
}

/** Characters of a text its font has no glyph for, and what prints in their place. */
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

/**
 * A shape's footprint in model mm, cut to the model. Null when it needs a
 * font that isn't loaded.
 */
export function shapeFootprint(shape: AddedShape, projection: Projection, crop: MultiPolygon, font: LoadedFont | null): MultiPolygon | null {
  const frame = frameOf(shape, projection);
  let footprint: MultiPolygon;
  switch (shape.kind) {
    case 'box': {
      const w = shape.sizeMm / 2;
      const d = shape.depthMm / 2;
      footprint = [[[place(frame, -w, -d), place(frame, w, -d), place(frame, w, d), place(frame, -w, d)]]];
      break;
    }
    case 'cylinder':
      footprint = [[circle(frame, 0, 0, shape.sizeMm / 2)]];
      break;
    case 'pin':
      footprint = normalize([pin(frame, shape.sizeMm)]);
      break;
    case 'text':
      if (!font) return null;
      footprint = textFootprint(shape, frame, font);
      break;
    case 'path': {
      const points = shape.points.map(([lon, lat]) => projection.toModel(lon, lat));
      footprint = bufferLines([{ points, width: shape.sizeMm }], 'round');
      break;
    }
    case 'area': {
      const ring = shape.points.map(([lon, lat]) => projection.toModel(lon, lat));
      footprint = ring.length >= 3 ? normalize([[ring]]) : [];
      break;
    }
  }
  return footprint.length ? intersection(footprint, crop) : [];
}
