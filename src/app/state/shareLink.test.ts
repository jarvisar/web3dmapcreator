import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits, type ModelEdits } from '../../core/edit/types';
import { DEFAULT_AREA } from '../../core/settings';
import { defaultSvgSettings } from '../svgmap/settings';
import { MAX_LINK_EXTRA, parseHash, shareUrl } from './shareLink';

afterEach(() => vi.unstubAllGlobals());

function hashOf(url: string): string {
  return new URL(url).hash;
}

describe('share links', () => {
  it('carry a model with its edits', () => {
    vi.stubGlobal('location', { href: 'https://citymodel.example/#a=1' });
    const edits: ModelEdits = {
      ...emptyEdits(),
      layers: [{ id: 'L', name: 'Race', hex: '#FF0000', line: 'PLA Basic' }],
      objects: { 'b:tower': { heightM: 120 }, 'r:main': { layer: 'L', widthMm: 1.5 } },
    };
    const { url, left } = shareUrl(DEFAULT_AREA, 'model', defaultSvgSettings(), edits);
    expect(left).toBeNull();
    const shared = parseHash(hashOf(url));
    expect(shared.output).toBe('model');
    expect(shared.edits).toEqual(edits);
    expect(shared.picks).toBeNull();
  });

  it('carry an SVG map with its picked roads, and not the model edits', () => {
    vi.stubGlobal('location', { href: 'https://citymodel.example/' });
    const svg = defaultSvgSettings();
    svg.routes = [{ id: 'r', name: 'Home', color: '#E4002B', width: 0.6, lines: [[[-87.63, 41.88], [-87.62, 41.88]]] }];
    svg.hiddenLines = [[[-87.64, 41.87], [-87.64, 41.88]]];
    const { url, left } = shareUrl(DEFAULT_AREA, 'svg', svg, { ...emptyEdits(), objects: { 'b:1': { removed: true } } });
    expect(left).toBeNull();
    const shared = parseHash(hashOf(url));
    expect(shared.edits).toBeNull();
    expect(shared.picks).toEqual({ routes: svg.routes, hiddenLines: svg.hiddenLines });
    // The settings part still leaves them out.
    expect(shared.svg?.svg.routes).toEqual([]);
  });

  it('leave out what would make them too long', () => {
    vi.stubGlobal('location', { href: 'https://citymodel.example/' });
    const objects: ModelEdits['objects'] = {};
    // Random ids don't deflate much.
    for (let i = 0; i < 3000; i++) objects[`b:${Math.random().toString(36).slice(2)}${i}`] = { removed: true };
    const { url, left } = shareUrl(DEFAULT_AREA, 'model', defaultSvgSettings(), { ...emptyEdits(), objects });
    expect(left).toBe('edits');
    expect(url.length).toBeLessThan(MAX_LINK_EXTRA);
    expect(parseHash(hashOf(url)).edits).toBeNull();
  });

  it('ignore edits that are not readable', () => {
    const shared = parseHash('#a=-87.6,41.88,1000,1000,0,rectangle&e=not-deflate');
    expect(shared.area).not.toBeNull();
    expect(shared.edits).toBeNull();
  });
});
