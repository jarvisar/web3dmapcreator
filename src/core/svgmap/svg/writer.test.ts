import { describe, expect, it } from 'vitest';
import type { RenderResult } from '../result';
import { toSvg } from './writer';

const result = (color: string, mode: RenderResult['mode'] = 'laser'): RenderResult => ({
  width: 100,
  height: 50,
  outline: 'M0,0H100V50H0Z',
  mode,
  background: mode === 'print' ? color : null,
  groups: [
    { id: 'roads', element: 'roads', label: 'Roads', kind: 'stroke', color, strokeWidth: 0.05, paths: [{ d: 'M0,0L10,10' }], subpaths: 1, lengthMm: 14, areaMm2: 0 },
  ],
  stats: { zoom: 14, tiles: 1, bytes: 0, cleanup: null, coverage: null, plotter: null, timings: {} },
  warnings: [],
  meta: {
    title: 'Test <map>',
    centre: { lon: 0, lat: 0 },
    bearing: 0,
    widthM: 1000,
    heightM: 500,
    scale: 10000,
    attribution: '© OpenStreetMap contributors',
    generated: '2026-01-01T00:00:00.000Z',
  },
});

describe('svg writer', () => {
  it('escapes text and attribute values', () => {
    const bad = '#000"/><script>alert(1)</script><x a="';
    for (const mode of ['laser', 'plotter', 'print'] as const) {
      const svg = toSvg(result(bad, mode));
      expect(svg).not.toContain('<script');
      expect(svg).toContain('<title>Test &lt;map&gt;</title>');
    }
  });

  it('fills the background in the piece shape', () => {
    const round = { ...result('#FFEEDD', 'print'), outline: 'M0,25A25,25 0 1 1 50,25A25,25 0 1 1 0,25Z' };
    expect(toSvg(round)).toContain('<path id="background" d="M0,25A25,25 0 1 1 50,25A25,25 0 1 1 0,25Z" fill="#FFEEDD"/>');
    expect(toSvg(result('#FFEEDD'))).not.toContain('id="background"');
  });

  it('sizes the file in millimetres', () => {
    expect(toSvg(result('#FF0000'))).toContain('width="100mm" height="50mm" viewBox="0 0 100 50"');
  });
});
