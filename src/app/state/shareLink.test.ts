import { deflateSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits, type ModelEdits } from '../../core/edit/types';
import { DEFAULT_AREA } from '../../core/settings';
import { defaultSvgSettings } from '../svgmap/settings';
import { MAX_LINK_EXTRA, MAX_UNPACKED, parseHash, shareUrl, unreadableText } from './shareLink';

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

  it('ignore edits that are not readable, and say so', () => {
    const shared = parseHash('#a=-87.6,41.88,1000,1000,0,rectangle&e=not-deflate');
    expect(shared.area).not.toBeNull();
    expect(shared.edits).toBeNull();
    expect(shared.unreadable).toEqual(['edits']);
    expect(unreadableText(shared)).toMatch(/edits to the model in this link couldn't be read/);
    expect(parseHash('#a=-87.6,41.88,1000,1000,0,rectangle').unreadable).toEqual([]);
  });

  it('still open when pasted with the end of a sentence', () => {
    vi.stubGlobal('location', { href: 'https://citymodel.example/' });
    const edits: ModelEdits = { ...emptyEdits(), objects: { 'b:tower': { heightM: 120 } } };
    const hash = hashOf(shareUrl(DEFAULT_AREA, 'model', defaultSvgSettings(), edits).url);
    const plain = '#a=-87.6,41.88,1000,1000,0,rectangle';
    for (const junk of ['.', ')', ').', '%29', '!"']) {
      expect(parseHash(hash + junk).edits).toEqual(edits);
      expect(parseHash(plain + junk).area?.shape).toBe('rectangle');
    }
    const svg = defaultSvgSettings();
    svg.label.text = 'ROME';
    const svgHash = hashOf(shareUrl(DEFAULT_AREA, 'svg', svg).url);
    expect(parseHash(`${svgHash}.`).svg?.svg.label.text).toBe('ROME');
    // Cut short is another matter.
    expect(parseHash(hash.slice(0, -12)).unreadable).toEqual(['edits']);
  });

  it('refuse edits that inflate past the limit, or a part too long for any link we make', () => {
    // A few kilobytes that inflate to megabytes.
    const bomb = deflateSync(strToU8('{"objects":{"b:1":{"heightM":' + '0'.repeat(MAX_UNPACKED + 10) + '}}}'), { level: 9 });
    const packed = btoa(String.fromCharCode(...bomb)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(packed.length).toBeLessThan(MAX_LINK_EXTRA);
    const t = performance.now();
    expect(parseHash(`#a=-87.6,41.88,1000,1000,0,rectangle&e=${packed}`).edits).toBeNull();
    expect(performance.now() - t).toBeLessThan(1000);
    expect(parseHash(`#a=-87.6,41.88,1000,1000,0,rectangle&p=${'A'.repeat(MAX_LINK_EXTRA * 5)}`).picks).toBeNull();
  });
});
