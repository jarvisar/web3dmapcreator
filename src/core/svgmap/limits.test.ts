import { describe, expect, it } from 'vitest';
import { defaultRenderSettings } from './defaults';
import { clampRenderSettings, limitFor } from './limits';
import { relieveDenseClusters } from './lines/dense';
import { hatch } from './plotter';

describe('setting limits', () => {
  it('bring a hand-edited render into range', () => {
    const settings = defaultRenderSettings('plotter');
    settings.cleanup = { ...settings.cleanup, denseWindow: 1e-320, tangleSegments: 1e9 };
    settings.label = { ...settings.label, rotation: 45 as 0 };
    settings.plotter = { ...settings.plotter, penWidth: Number.NaN };
    const clamped = clampRenderSettings(settings);
    expect(clamped.cleanup.denseWindow).toBe(0.1);
    expect(clamped.cleanup.tangleSegments).toBe(500);
    expect(clamped.label.rotation).toBe(0);
    expect(clamped.plotter.penWidth).toBe(0.05);
    expect(clamped.area).toBe(settings.area);
    // In range, nothing changes.
    expect(clampRenderSettings(defaultRenderSettings('print'))).toEqual(defaultRenderSettings('print'));
  });

  it('read the per-mode styles the app keeps as the engine style', () => {
    expect(limitFor(['styles', 'laser', 'hatch', 'water', 'spacing'])).toEqual(limitFor(['style', 'hatch', 'water', 'spacing']));
    expect(limitFor(['style', 'lineWidths', 'roads'])).toEqual({ min: 0.02, max: 5 });
  });

  it("keep the cleanup and hatching finite whatever they're given", () => {
    // Every line was sampled every sixth of the window, so 1e-320 never finished.
    const lines = Array.from({ length: 40 }, (_, i) => ({ rank: 8, key: 'paths', path: [[0, i * 0.2], [100, i * 0.2]] as [number, number][] }));
    const started = performance.now();
    relieveDenseClusters(lines, 2.7, 1e-320, 0.5);
    const square = [[{ x: 0, y: 0 }, { x: 100_000, y: 0 }, { x: 100_000, y: 100_000 }, { x: 0, y: 100_000 }]];
    expect(hatch(square, 1e-9, 0).length).toBeLessThanOrEqual(100 / 0.02 + 1);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
