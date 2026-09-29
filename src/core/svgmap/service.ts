// Runs a render. Keeps raw tiles, the current area's prepared geometry, layer
// unions and fonts between renders, so changing a setting doesn't download or
// decode anything again. Runs in a web worker in the app and directly in tests.
import type { Paths64 } from 'clipper2-ts';
import { compose } from './compose';
import { computeLayout } from './layout/layout';
import { type Prepared, planTiles, prepareArea } from './prepare';
import type { RenderResult } from './result';
import type { RenderSettings } from './settings';
import { type CustomFont, FontLoader } from './text/loadFont';
import type { LoadedFont } from './text/outline';
import { TileCache, TileSource } from './tiles/source';

export type { CustomFont };

export interface RenderRequest {
  settings: RenderSettings;
  customFont?: CustomFont | null;
}

export type RenderStage = 'tiles' | 'geometry' | 'compose';

export interface RenderProgress {
  stage: RenderStage;
  message: string;
  done?: number;
  total?: number;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

// Yield so a newer request can cancel this one.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class RenderService {
  private readonly tiles = new TileCache();
  private readonly sources = new Map<string, TileSource>();
  private prepared: { key: string; value: Prepared; memo: Map<string, Paths64> } | null = null;
  private readonly fonts: FontLoader;

  constructor(loadAsset: (path: string) => Promise<ArrayBuffer>) {
    this.fonts = new FontLoader(loadAsset);
  }

  private source(url: string): TileSource {
    let source = this.sources.get(url);
    if (!source) {
      source = new TileSource(url);
      this.sources.set(url, source);
    }
    return source;
  }

  async render(
    request: RenderRequest,
    onProgress: (progress: RenderProgress) => void = () => {},
    isCancelled: () => boolean = () => false,
  ): Promise<RenderResult> {
    const settings = request.settings;
    const layout = computeLayout(settings.product, settings.border);
    const plan = planTiles(settings.area, layout, settings.source);
    const key = JSON.stringify([settings.area, layout.window, plan.zoom, settings.source.tiles]);

    let entry = this.prepared?.key === key ? this.prepared : null;
    if (!entry) {
      onProgress({ stage: 'tiles', message: 'Downloading map data', done: 0, total: plan.tiles.length });
      const data = await this.tiles.fetchAll(
        this.source(settings.source.tiles),
        settings.source.tiles,
        plan.tiles,
        (done, total) => onProgress({ stage: 'tiles', message: 'Downloading map data', done, total }),
        isCancelled,
      );
      if (isCancelled()) throw new CancelledError();
      onProgress({ stage: 'geometry', message: 'Building geometry' });
      await tick();
      if (isCancelled()) throw new CancelledError();
      entry = { key, value: prepareArea(plan, layout, data), memo: new Map() };
      this.prepared = entry;
    }

    const label = settings.label;
    let title: LoadedFont | null = null;
    let subtitle: LoadedFont | null = null;
    if (label.enabled && label.text.trim()) {
      title = await this.fonts.load(label.font, request.customFont);
      const subtitleId = label.subtitleFont || label.font;
      subtitle = subtitleId === label.font ? title : await this.fonts.load(subtitleId, request.customFont);
    }

    onProgress({ stage: 'compose', message: 'Cleaning up lines' });
    await tick();
    if (isCancelled()) throw new CancelledError();
    return compose(settings, layout, entry.value, { title, subtitle }, entry.memo);
  }
}
