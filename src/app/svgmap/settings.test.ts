import { describe, expect, it } from 'vitest';
import type { AreaSpec } from '../../core/settings';
import { defaultRenderSettings } from '../../core/svgmap/defaults';
import { computeLayout } from '../../core/svgmap/layout/layout';
import { clampRenderSettings, limitFor } from '../../core/svgmap/limits';
import { PRODUCT_PRESETS } from '../../core/svgmap/presets';
import { MAX_SIDE_M, MIN_SIDE_M } from '../../core/geo/area';
import {
  applyPiecePreset,
  setArea,
  setCleanupPreset,
  setOutput,
  setPieceSize,
  setPlotter,
  setScaleLocked,
  setSvgMode,
  setSvgScale,
  useApp,
} from '../state/store';
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

  it('titles the render with the place when the map has no title', () => {
    const svg = defaultSvgSettings();
    expect(toRenderSettings(engineArea, { ...svg, label: { ...svg.label, text: 'ROME' } }, 'Rome').title).toBe('ROME');
    // The download is named from this, so an old result keeps its place's name.
    expect(toRenderSettings(engineArea, { ...svg, label: { ...svg.label, text: ' ' } }, 'Chicago Loop').title).toBe('Chicago Loop');
  });

  it('has a range for every number, holding its default', () => {
    const walk = (value: unknown, path: string[]) => {
      if (typeof value === 'number') {
        const limit = limitFor(path);
        expect(limit, path.join('.')).toBeDefined();
        if (limit && 'min' in limit) {
          expect(value, path.join('.')).toBeGreaterThanOrEqual(limit.min);
          expect(value, path.join('.')).toBeLessThanOrEqual(limit.max);
        } else if (limit) expect(limit.choices).toContain(value);
      } else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    };
    walk(defaultSvgSettings(), []);
  });

  it('has room in every range for what the app works out itself', () => {
    const outside: string[] = [];
    const check = (value: unknown, path: string[], label: string) => {
      if (typeof value === 'number') {
        const limit = limitFor(path);
        const fits = !limit || ('choices' in limit ? limit.choices.includes(value) : value >= limit.min && value <= limit.max);
        if (!fits) outside.push(`${path.join('.')} = ${value} (${label})`);
      } else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) check(child, [...path, key], label);
    };
    const audit = (label: string) => {
      const state = useApp.getState();
      check(state.svg, [], label);
      const render = toRenderSettings(state.area, state.svg, state.placeName);
      const { area: _area, ...rest } = render;
      check(rest, [], label);
      // The engine clamps again, and must find nothing to change.
      if (JSON.stringify(clampRenderSettings(render)) !== JSON.stringify(render)) outside.push(`render clamped (${label})`);
    };
    setOutput('svg');
    for (const preset of PRODUCT_PRESETS) {
      applyPiecePreset(preset.id);
      for (const shape of ['rectangle', 'rounded', 'circle', 'hexagon'] as const) {
        setArea((area) => ({ ...area, shape }));
        for (const mode of ['laser', 'plotter', 'print'] as const) {
          setSvgMode(mode);
          for (const penWidth of [0.05, 1, 3]) {
            setPlotter({ penWidth });
            for (const cleanup of ['off', 'light', 'standard', 'strong'] as const) {
              setCleanupPreset(cleanup);
              audit(`${preset.id} ${shape} ${mode} ${penWidth} mm pen ${cleanup}`);
            }
          }
        }
      }
    }
    // The smallest and largest pieces over the smallest and largest areas,
    // and at the smallest and largest fixed scales.
    const scales = limitFor(['scale']) as { min: number; max: number };
    for (const shape of ['rectangle', 'hexagon', 'circle'] as const) {
      setArea((area) => ({ ...area, shape }));
      for (const width of [20, 2000]) {
        for (const height of [20, 2000]) {
          setPieceSize({ width, height });
          setScaleLocked(false);
          for (const side of [MIN_SIDE_M, MAX_SIDE_M]) {
            setArea((area) => ({ ...area, widthM: side, heightM: side }));
            audit(`${shape} ${width} x ${height} mm over ${side} m`);
          }
          setScaleLocked(true);
          for (const scale of [scales.min, scales.max]) {
            setSvgScale(scale);
            audit(`${shape} ${width} x ${height} mm at 1:${scale}`);
          }
        }
      }
    }
    expect(outside.slice(0, 5)).toEqual([]);
  });

  it('keeps only numbers from saved settings and links that the panels would allow', () => {
    // A dense window this small made the line cleanup sample forever.
    const merged = mergeSettings(defaultSvgSettings(), { cleanup: { denseWindow: 1e-320, snapGap: 0.4 }, label: { rotation: 90, size: 1e6 } });
    const defaults = defaultSvgSettings();
    expect(merged.cleanup.denseWindow).toBe(defaults.cleanup.denseWindow);
    expect(merged.cleanup.snapGap).toBe(0.4);
    expect(merged.label.size).toBe(defaults.label.size);
    expect(merged.label.rotation).toBe(90);
    expect(mergeSettings(defaults, { label: { rotation: 45 } }).label.rotation).toBe(defaults.label.rotation);
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
  const fixed = defaultSvgSettings();
  // Fit the area, where the area sets the scale.
  const svg = { ...fixed, scaleLocked: false };
  const window = computeLayout(pieceProduct(svg.product, 'rectangle'), svg.border).window;

  it('starts at a fixed 0.05 mm per metre', () => {
    expect(fixed.scaleLocked).toBe(true);
    expect(1000 / fixed.scale).toBe(0.05);
    const { area, scale } = fitAreaToPiece({ ...engineArea, widthM: 9000 }, fixed, 'cover');
    expect(area.widthM).toBeCloseTo(window.w / 0.05, 2);
    expect(scale).toBe(20000);
  });

  it('sizes the area from the piece and a scale typed in mm per metre', () => {
    useApp.setState({ svg: defaultSvgSettings() });
    setOutput('svg');
    setArea((area) => ({ ...area, shape: 'rectangle' }));
    setPieceSize({ width: 300, height: 200 });
    const window = () => {
      const { area, svg } = useApp.getState();
      return computeLayout(pieceProduct(svg.product, area.shape), svg.border).window;
    };
    expect(useApp.getState().svg.scale).toBe(20000);
    expect(useApp.getState().area.widthM).toBeCloseTo(window().w / 0.05, 1);
    // What the Scale field sends for 0.07 mm/m.
    setSvgScale(1000 / 0.07);
    expect(useApp.getState().area.widthM).toBeCloseTo(window().w / 0.07, 1);
    // A new piece keeps the scale and resizes the area instead.
    setPieceSize({ width: 150, height: 150 });
    expect(1000 / useApp.getState().svg.scale).toBeCloseTo(0.07, 9);
    expect(useApp.getState().area.widthM).toBeCloseTo(window().w / 0.07, 1);
    // Fit the area keeps the area and changes the scale.
    setScaleLocked(false);
    const before = useApp.getState().area.widthM;
    setPieceSize({ width: 300, height: 300 });
    expect(useApp.getState().area.widthM).toBe(before);
    expect(useApp.getState().svg.scale).toBeCloseTo((before / window().w) * 1000, 6);
  });

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
    settings.scaleLocked = false;
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
    // Its width sets the map, not the default scale.
    expect(shared.svg!.svg.scaleLocked).toBe(false);
    const area = fitAreaToPiece({ ...engineArea, ...shared.svg!.area, shape: 'circle', heightM: 5000 }, shared.svg!.svg).area;
    expect(area.widthM).toBeCloseTo(5000, 0);
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
