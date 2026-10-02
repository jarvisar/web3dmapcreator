// Runs a render. Keeps raw tiles, the current area's prepared geometry, layer
// unions and fonts between renders, so changing a setting doesn't download or
// decode anything again. Runs in a web worker in the app and directly in tests.
import type { Paths64 } from 'clipper2-ts';
import { compose } from './compose';
import type { MapTransform } from './geo/transform';
import { type Layout, computeLayout } from './layout/layout';
import { clampRenderSettings } from './limits';
import { BUILDING_COLUMNS, isMissingFromOsm, missingBuildings, projectFootprints, windowBounds } from './overture';
import { type Prepared, type TileData, type TilePlan, planTiles, prepareArea, tileKey, windowClipRect } from './prepare';
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

export type RenderStage = 'tiles' | 'geometry' | 'buildings' | 'compose';

export interface RenderProgress {
  stage: RenderStage;
  message: string;
  done?: number;
  total?: number;
  /** How far along the stage is, 0 to 1, for one that isn't counted in tiles. */
  fraction?: number;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

interface PreparedEntry {
  key: string;
  value: Prepared;
  memo: Map<string, Paths64>;
}

// Overture's footprints for one map window, or why there are none.
interface FootprintEntry {
  key: string;
  footprints: Paths64[];
  warning?: string;
  // A failed download is tried again after this, not on every settings change.
  retryAt?: number;
}

// The prepared tiles with Overture's buildings added, and its own unions.
interface BuildingsEntry {
  base: PreparedEntry;
  footprints: FootprintEntry;
  entry: PreparedEntry;
}

// Yield so a newer request can cancel this one.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The tiles' buildings are only complete at zoom 14, so footprints added to
// fewer would stand out.
const BUILDINGS_ZOOM = 14;
// Less than the 3D models' 250 MB, since this holds up a preview.
const BUILDINGS_MAX_BYTES = 150e6;
const BUILDINGS_RETRY_MS = 60_000;

export class RenderService {
  private readonly tiles = new TileCache();
  private readonly sources = new Map<string, TileSource>();
  private prepared: PreparedEntry | null = null;
  private footprints: FootprintEntry | null = null;
  private buildings: BuildingsEntry | null = null;
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
    const settings = clampRenderSettings(request.settings);
    const layout = computeLayout(settings.product, settings.border);
    const plan = planTiles(settings.area, layout, settings.source);
    const key = JSON.stringify([settings.area, layout.window, plan.zoom, settings.source.tiles]);

    let entry = this.prepared?.key === key ? this.prepared : null;
    if (!entry || entry.value.missing) entry = await this.prepare(key, plan, layout, settings.source.tiles, entry, onProgress, isCancelled);
    if (settings.source.overtureBuildings && settings.layers.buildings) {
      entry = await this.addBuildings(entry, layout, onProgress, isCancelled);
    }

    const label = settings.label;
    let title: LoadedFont | null = null;
    let subtitle: LoadedFont | null = null;
    if (label.enabled && label.text.trim()) {
      title = await this.fonts.load(label.font, request.customFont);
      const subtitleId = label.subtitleFont || label.font;
      // Only a band shows a subtitle. A custom subtitle font left set with no text failed every render once the file was gone.
      const shown = label.style === 'band' && label.subtitle.trim() !== '';
      subtitle = !shown || subtitleId === label.font ? title : await this.fonts.load(subtitleId, request.customFont);
    }

    onProgress({ stage: 'compose', message: 'Cleaning up lines' });
    await tick();
    if (isCancelled()) throw new CancelledError();
    return compose(settings, layout, entry.value, { title, subtitle }, entry.memo);
  }

  // The tiles' geometry with Overture's missing buildings added. Kept apart
  // from the tiles' own entry, so turning it off goes back to that entry's
  // unions and nothing is downloaded again either way.
  private async addBuildings(
    base: PreparedEntry,
    layout: Layout,
    onProgress: (progress: RenderProgress) => void,
    isCancelled: () => boolean,
  ): Promise<PreparedEntry> {
    const { transform } = base.value;
    const key = JSON.stringify([base.key, 'buildings']);
    let footprints = this.footprints?.key === key ? this.footprints : null;
    if (!footprints || (footprints.retryAt !== undefined && Date.now() >= footprints.retryAt)) {
      footprints = await this.fetchFootprints(key, transform, layout, onProgress, isCancelled);
      this.footprints = footprints;
    }
    if (this.buildings?.base === base && this.buildings.footprints === footprints) return this.buildings.entry;
    const tileBuildings = base.value.polygons.filter((p) => p.layer === 'buildings');
    const added = missingBuildings(footprints.footprints, tileBuildings);
    const value: Prepared = {
      ...base.value,
      polygons: [...base.value.polygons, ...added],
      warnings: footprints.warning ? [...base.value.warnings, footprints.warning] : base.value.warnings,
      overtureBuildings: added.length,
    };
    const entry = { key, value, memo: new Map() };
    this.buildings = { base, footprints, entry };
    return entry;
  }

  private async fetchFootprints(
    key: string,
    transform: MapTransform,
    layout: Layout,
    onProgress: (progress: RenderProgress) => void,
    isCancelled: () => boolean,
  ): Promise<FootprintEntry> {
    const none = (warning: string, retry = false): FootprintEntry => ({
      key,
      footprints: [],
      warning,
      ...(retry ? { retryAt: Date.now() + BUILDINGS_RETRY_MS } : {}),
    });
    if (transform.zoom < BUILDINGS_ZOOM) {
      return none(`Buildings from Overture are only added at full detail (zoom ${BUILDINGS_ZOOM}), and this map uses zoom ${transform.zoom} tiles.`);
    }
    const bounds = windowBounds(transform, layout);
    if (!bounds) return none("Buildings from Overture can't be added to a map that crosses the 180th meridian.");
    const message = 'Downloading buildings from Overture';
    onProgress({ stage: 'buildings', message, fraction: 0 });
    const controller = new AbortController();
    const watch = setInterval(() => {
      if (isCancelled()) controller.abort(new CancelledError());
    }, 100);
    // Loaded only when it's turned on: the Parquet reader is about 100 KB of the worker.
    let tooLarge: (new (...args: never[]) => Error & { bytes: number }) | undefined;
    try {
      const { fetchOverture, AreaTooLargeError } = await import('../data/overture');
      tooLarge = AreaTooLargeError;
      const data = await fetchOverture({
        bounds,
        types: ['building'],
        columns: { building: BUILDING_COLUMNS },
        keep: (_type, props) => isMissingFromOsm(props),
        signal: controller.signal,
        maxTypeBytes: BUILDINGS_MAX_BYTES,
        maxTotalBytes: BUILDINGS_MAX_BYTES,
        onProgress: (progress) => onProgress({ stage: 'buildings', message, fraction: progress.fraction }),
      });
      if (isCancelled()) throw new CancelledError();
      return { key, footprints: projectFootprints(data.features.building, transform, windowClipRect(layout)) };
    } catch (error) {
      if (isCancelled() || error instanceof CancelledError) throw new CancelledError();
      if (tooLarge && error instanceof tooLarge) {
        return none(`Buildings from Overture were left out: this map would need ${Math.round(error.bytes / 1e6)} MB of building data, over the ${BUILDINGS_MAX_BYTES / 1e6} MB limit. Try a smaller map.`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      return none(`Buildings from Overture couldn't be downloaded, so the map has the tiles' buildings only. ${reason}`, true);
    } finally {
      clearInterval(watch);
    }
  }

  // Geometry with tiles missing is kept, but each render after it tries those
  // tiles once more. The ones that came through are in the tile cache.
  private async prepare(
    key: string,
    plan: TilePlan,
    layout: Layout,
    tiles: string,
    previous: PreparedEntry | null,
    onProgress: (progress: RenderProgress) => void,
    isCancelled: () => boolean,
  ): Promise<PreparedEntry> {
    onProgress({ stage: 'tiles', message: 'Downloading map data', done: 0, total: plan.tiles.length });
    let data: TileData;
    try {
      data = await this.tiles.fetchAll(
        this.source(tiles),
        tiles,
        plan.tiles,
        (done, total) => onProgress({ stage: 'tiles', message: 'Downloading map data', done, total }),
        isCancelled,
        6,
        previous ? 1 : 3,
      );
    } catch (error) {
      if (previous && !isCancelled()) return previous;
      throw error;
    }
    if (isCancelled()) throw new CancelledError();
    const missing = plan.tiles.filter((tile) => !data.has(tileKey(tile))).length;
    // Only rebuild when the retry got something the last geometry lacked.
    if (previous && missing >= previous.value.missing) return previous;
    onProgress({ stage: 'geometry', message: 'Building geometry' });
    await tick();
    if (isCancelled()) throw new CancelledError();
    const entry = { key, value: prepareArea(plan, layout, data), memo: new Map() };
    this.prepared = entry;
    return entry;
  }
}
