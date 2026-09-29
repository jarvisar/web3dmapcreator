import { describe, expect, it } from 'vitest';
import type { AreaSpec } from '../../core/settings';
import { defaultRenderSettings } from '../../core/svgmap/defaults';
import { computeLayout } from '../../core/svgmap/layout/layout';
import { formatAreaHash, parseHash } from '../state/shareLink';
import { fitAreaToPiece, pieceProduct } from './piece';
import { defaultSvgSettings, mergeSettings, toRenderSettings } from './settings';
import { decodeSvgSettings, encodeSvgSettings } from './share';

const engine = defaultRenderSettings('laser');
const engineArea: AreaSpec = {
  center: [engine.area.lon, engine.area.lat],
  widthM: engine.area.widthM,
  heightM: 2000,
  rotationDeg: 0,
  shape: 'rectangle',
  cornerRadius: 0.1,
};

describe('SVG settings', () => {
  it('starts from the same defaults as the engine', () => {
    const { title: _title, ...app } = toRenderSettings(engineArea, defaultSvgSettings());
    const { title: _engineTitle, ...rest } = engine;
    expect(app).toEqual(rest);
  });

  it('fills in fields that older saved settings are missing', () => {
    const merged = mergeSettings(defaultSvgSettings(), { label: { text: 'ROME' } });
    expect(merged.label.text).toBe('ROME');
    expect(merged.label.font).toBe(defaultSvgSettings().label.font);
    expect(merged.cleanup).toEqual(defaultSvgSettings().cleanup);
  });

  it('drops values of the wrong type and keys it does not know', () => {
    const merged = mergeSettings(defaultSvgSettings(), {
      product: { width: 'wide', height: 200 },
      label: { text: null, enabled: 'yes' },
      scale: Number.NaN,
      extra: { anything: 1 },
    });
    const defaults = defaultSvgSettings();
    expect(merged.product.width).toBe(defaults.product.width);
    expect(merged.product.height).toBe(200);
    expect(merged.label.text).toBe(defaults.label.text);
    expect(merged.label.enabled).toBe(true);
    expect(merged.scale).toBe(defaults.scale);
    expect('extra' in merged).toBe(false);
  });

  it('only accepts #RRGGBB colours and known output modes', () => {
    const merged = mergeSettings(defaultSvgSettings(), {
      mode: 'engrave',
      styles: {
        laser: { colors: { water: '#00FF00', roads: 'red"/><script>alert(1)</script>' } },
        print: { background: 'url(x)' },
      },
    });
    const defaults = defaultSvgSettings();
    expect(merged.mode).toBe('laser');
    expect(merged.styles.laser.colors.water).toBe('#00FF00');
    expect(merged.styles.laser.colors.roads).toBe(defaults.styles.laser.colors.roads);
    expect(merged.styles.print.background).toBe(defaults.styles.print.background);
  });

  it('drops numbers that would break the render', () => {
    const merged = mergeSettings(defaultSvgSettings(), { scale: -5, plotter: { penWidth: 0 }, label: { size: 0 } });
    const defaults = defaultSvgSettings();
    expect(merged.scale).toBe(defaults.scale);
    expect(merged.plotter.penWidth).toBe(defaults.plotter.penWidth);
    expect(merged.label.size).toBe(defaults.label.size);
  });

  it('keeps a transparent background', () => {
    const merged = mergeSettings(defaultSvgSettings(), { styles: { print: { background: null } } });
    expect(merged.styles.print.background).toBeNull();
  });
});

describe('the area as a map window', () => {
  const svg = defaultSvgSettings();
  const window = computeLayout(pieceProduct(svg.product, 'rectangle'), svg.border).window;

  it('keeps the width and takes the height from the piece', () => {
    const { area, scale } = fitAreaToPiece({ ...engineArea, widthM: 3208, heightM: 5000 }, svg);
    expect(area.widthM).toBe(3208);
    expect(area.heightM).toBeCloseTo((3208 * window.h) / window.w, 2);
    expect(scale).toBeCloseTo(20000, 6);
  });

  it('covers the whole area for presets, or fits inside it for the visible map', () => {
    const tall = { ...engineArea, widthM: 1000, heightM: 3000 };
    expect(fitAreaToPiece(tall, svg, 'cover').area.heightM).toBeGreaterThanOrEqual(2999.99);
    expect(fitAreaToPiece(tall, svg, 'inside').area.widthM).toBe(1000);
    const wide = { ...engineArea, widthM: 9000, heightM: 1000 };
    expect(fitAreaToPiece(wide, svg, 'inside').area.heightM).toBeLessThanOrEqual(1000.01);
  });

  it('sets the width from a locked scale', () => {
    const locked = { ...svg, scale: 5000, scaleLocked: true };
    const { area, scale } = fitAreaToPiece({ ...engineArea, widthM: 9000 }, locked, 'cover');
    expect(area.widthM).toBeCloseTo((5000 * window.w) / 1000, 2);
    expect(scale).toBe(5000);
  });

  it('keeps the window proportions when the area limits stop a locked scale', () => {
    // 1:100 would make the window about 16 m wide, under the 50 m minimum.
    const locked = { ...svg, scale: 100, scaleLocked: true };
    const { area, scale } = fitAreaToPiece(engineArea, locked);
    expect(Math.min(area.widthM, area.heightM)).toBeGreaterThanOrEqual(50);
    expect(area.heightM / area.widthM).toBeCloseTo(window.h / window.w, 3);
    // The scale says what the map really is.
    expect(scale).toBeCloseTo((area.widthM / window.w) * 1000, 6);
    expect(scale).toBeGreaterThan(100);
    // Same for a small area without a locked scale.
    const small = fitAreaToPiece({ ...engineArea, widthM: 50, heightM: 50 }, svg).area;
    expect(small.heightM / small.widthM).toBeCloseTo(window.h / window.w, 3);
  });

  it('keeps a typed scale exact on a small piece', () => {
    const coaster = { ...svg, product: { ...svg.product, width: 100, height: 100 }, border: { ...svg.border, style: 'single' as const } };
    const round = computeLayout(pieceProduct(coaster.product, 'circle'), coaster.border).window;
    const { scale } = fitAreaToPiece({ ...engineArea, shape: 'circle', widthM: (5000 * round.w) / 1000 }, coaster);
    expect(Math.round(scale)).toBe(5000);
  });

  it('gives circles and hexagons their own proportions and rounded pieces their corners', () => {
    const circle = fitAreaToPiece({ ...engineArea, shape: 'circle' }, svg).area;
    expect(circle.heightM).toBe(circle.widthM);
    const hexagon = fitAreaToPiece({ ...engineArea, shape: 'hexagon' }, svg).area;
    expect(hexagon.heightM / hexagon.widthM).toBeCloseTo(Math.sqrt(3) / 2, 3);
    const rounded = fitAreaToPiece({ ...engineArea, shape: 'rounded' }, { ...svg, product: { ...svg.product, cornerRadius: 12 } }).area;
    const layout = computeLayout(pieceProduct({ ...svg.product, cornerRadius: 12 }, 'rounded'), svg.border).window;
    expect(rounded.cornerRadius).toBeCloseTo(layout.r / Math.min(layout.w, layout.h), 6);
  });
});

describe('share links', () => {
  it('round-trip the SVG settings', () => {
    const settings = defaultSvgSettings();
    settings.mode = 'plotter';
    settings.label.text = 'SÃO PAULO';
    settings.styles.print.background = null;
    settings.scaleLocked = true;
    expect(decodeSvgSettings(encodeSvgSettings(settings))!.svg).toEqual(settings);
  });

  it('only hold what changed', () => {
    const settings = defaultSvgSettings();
    settings.label.text = 'ROME';
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encodeSvgSettings(settings)), (c) => c.charCodeAt(0))));
    expect(json).toEqual({ label: { text: 'ROME' } });
  });

  it('ignore text that is not a share link', () => {
    expect(decodeSvgSettings('not base64 json')).toBeNull();
  });

  it('open links from the old SVGmap site', () => {
    const old = { area: { lon: -0.11, lat: 51.508, bearing: 15, widthM: 5000 }, mode: 'print', product: { shape: 'circle', width: 100, height: 100 } };
    const encoded = btoa(JSON.stringify(old)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const shared = parseHash(`#s=${encoded}`);
    expect(shared.output).toBe('svg');
    expect(shared.svg!.area).toEqual({ center: [-0.11, 51.508], rotationDeg: 15, widthM: 5000 });
    expect(shared.svg!.shape).toBe('circle');
    expect(shared.svg!.svg.mode).toBe('print');
  });

  it('say which output the area is for', () => {
    const area = { ...engineArea, widthM: 3207.35 };
    const hash = formatAreaHash(area, 'svg');
    expect(hash.endsWith('&o=svg')).toBe(true);
    const shared = parseHash(hash);
    expect(shared.output).toBe('svg');
    expect(shared.area!.widthM).toBe(3207.35);
    // Model links have no o=, and must not open in the recipient's SVG mode.
    expect(parseHash(formatAreaHash(area)).output).toBe('model');
    expect(parseHash('').output).toBeNull();
  });
});
