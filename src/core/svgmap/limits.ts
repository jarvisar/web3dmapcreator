// Ranges for every number in the SVG settings, in stored units. The panels
// offer these, saved settings, share links and imported options are clamped
// to them, and the engine clamps what it's given once more. A hand-edited
// value used to reach the line cleanup as is: a dense window of 1e-320 made
// it sample every line forever, and cancelling couldn't stop the worker.
//
// Keys are setting paths. `*` stands for any one key, and the app's per-mode
// styles.<mode> reads as the engine's style. A range also has to hold what
// the app works out itself, not just what a panel offers: the scale of the
// window, a hexagon's height, the line spacing a thick pen gets.
// settings.test.ts drives the store through every preset to check that.

import type { RenderSettings } from './settings';

export type Limit = { min: number; max: number } | { choices: number[] };

export const LIMITS: Record<string, Limit> = {
  // 2 m of piece over 50 m, or 20 mm over 60 km.
  scale: { min: 10, max: 10_000_000 },

  'product.width': { min: 20, max: 2000 },
  // A 20 mm hexagon is 17.32 mm tall.
  'product.height': { min: 17.3, max: 2000 },
  'product.cornerRadius': { min: 0, max: 200 },
  'product.margins.*': { min: 0, max: 200 },

  'border.outerGap': { min: 0, max: 50 },
  'border.thick': { min: 0.05, max: 20 },
  'border.gap': { min: 0, max: 50 },
  'border.thin': { min: 0.01, max: 5 },
  'border.innerGap': { min: 0, max: 50 },

  'style.hatch.*.spacing': { min: 0.1, max: 10 },
  'style.hatch.*.angle': { min: -180, max: 180 },
  'style.lineWidths.*': { min: 0.02, max: 5 },
  'plotter.penWidth': { min: 0.05, max: 3 },
  'water.halo': { min: 0, max: 3 },
  'water.bridgeGap': { min: 0, max: 3 },
  'source.maxZoom': { min: 0, max: 14 },
  'source.maxTiles': { min: 4, max: 2000 },

  // A 3 mm pen gets 5.1, and Strong makes that 7.14.
  'cleanup.lineSpacing': { min: 0, max: 7.5 },
  'cleanup.weldTolerance': { min: 0, max: 1 },
  'cleanup.junctionMaxTurn': { min: 0, max: 90 },
  'cleanup.parallelAngle': { min: 0, max: 90 },
  'cleanup.shadowFraction': { min: 0, max: 1 },
  'cleanup.coverageTolerance': { min: 0, max: 5 },
  'cleanup.snapGap': { min: 0, max: 5 },
  'cleanup.pruneStubs': { min: 0, max: 10 },
  'cleanup.loopRadius': { min: 0, max: 5 },
  'cleanup.pathStubs': { min: 0, max: 10 },
  'cleanup.tangleSpan': { min: 0, max: 50 },
  'cleanup.tangleSegments': { min: 0, max: 500 },
  'cleanup.tangleRatio': { min: 0, max: 20 },
  'cleanup.denseLimit': { min: 0, max: 20 },
  // The patch the density is measured over. Much under the line spacing it
  // measures nothing, and it sets how finely every line is sampled.
  'cleanup.denseWindow': { min: 0.1, max: 20 },
  'cleanup.denseSeparation': { min: 0, max: 5 },
  'cleanup.denseProtectRank': { min: 0, max: 12 },
  'cleanup.denseHotFraction': { min: 0, max: 1 },
  'cleanup.denseShadowFraction': { min: 0, max: 1 },
  'cleanup.denseMeshMax': { min: 0, max: 20 },
  'cleanup.denseMeshDetour': { min: 0, max: 20 },
  'cleanup.denseCoveredScale': { min: 0, max: 1 },

  'label.size': { min: 40, max: 250 },
  'label.rotation': { choices: [0, 90, 180, 270] },
  'label.bandHeight': { min: 5, max: 50 },
  'label.bandMaxWidth': { min: 1, max: 100 },
  'label.bandPaddingX': { min: 0, max: 50 },
  'label.bandPaddingY': { min: 0, max: 50 },
  'label.titleHeight': { min: 0.5, max: 100 },
  'label.titleSpacing': { min: 0.8, max: 2 },
  'label.subtitleHeight': { min: 0.5, max: 50 },
  'label.subtitleGap': { min: 0, max: 50 },
  'label.subtitleSpacing': { min: 0.8, max: 3 },
  'label.dividerWidth': { min: 0.01, max: 3 },
  'label.dividerInset': { min: 0, max: 50 },
  'label.textHeight': { min: 0.5, max: 100 },
  'label.maxWidth': { min: 1, max: 500 },
  'label.paddingX': { min: 0, max: 30 },
  'label.paddingY': { min: 0, max: 30 },
  'label.borderWidth': { min: 0.01, max: 5 },
  'label.gap': { min: 0, max: 50 },
  'label.textScale': { min: 0.1, max: 1 },
  // Shares of the space inside the border, or of the band.
  'label.offsetX': { min: -1, max: 1 },
  'label.offsetY': { min: -1, max: 1 },
  'label.bandOffsetX': { min: -1, max: 1 },
  'label.bandOffsetY': { min: -1, max: 1 },
  // 0 sizes the box to the text.
  'label.boxWidth': { min: 0, max: 2000 },
  'label.boxHeight': { min: 0, max: 2000 },
};

function limitKey(path: readonly string[]): string[] {
  return path[0] === 'styles' ? ['style', ...path.slice(2)] : [...path];
}

/** The limit for a setting path, or undefined for one without a number. */
export function limitFor(path: readonly string[]): Limit | undefined {
  const key = limitKey(path);
  const exact = LIMITS[key.join('.')];
  if (exact) return exact;
  for (const [pattern, limit] of Object.entries(LIMITS)) {
    const parts = pattern.split('.');
    if (parts.length === key.length && parts.every((part, i) => part === '*' || part === key[i])) return limit;
  }
  return undefined;
}

/** Min and max for a panel's field, in the units it shows. */
export function fieldRange(path: string, scale = 1): { min: number; max: number } {
  const limit = limitFor(path.split('.'));
  if (!limit || !('min' in limit)) throw new Error(`No range for ${path}`);
  return { min: limit.min * scale, max: limit.max * scale };
}

/** A number for a setting path brought into range, or undefined when it can't be. */
export function fitNumber(path: readonly string[], value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const limit = limitFor(path);
  if (!limit) return value;
  if ('choices' in limit) return limit.choices.includes(value) ? value : undefined;
  return Math.min(limit.max, Math.max(limit.min, value));
}

/**
 * Every number in the settings brought into range. The app does this already,
 * but the engine can't rely on it.
 */
export function clampRenderSettings(settings: RenderSettings): RenderSettings {
  const walk = (value: unknown, path: string[]): unknown => {
    if (typeof value === 'number') {
      const fitted = fitNumber(path, value);
      if (fitted !== undefined) return fitted;
      const limit = limitFor(path);
      return !limit ? 0 : 'choices' in limit ? limit.choices[0] : limit.min;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = walk(child, [...path, key]);
    return out;
  };
  // The area is the place itself and is checked where it's planned.
  const { area, ...rest } = settings;
  return { area, ...(walk(rest, []) as Omit<RenderSettings, 'area'>) };
}
