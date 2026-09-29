// The only module that imports opentype.js at runtime, so the main thread can
// load it on demand.
import { parse } from 'opentype.js';
import { CUSTOM_FONT_ID, fontFingerprint, fontInfo } from './fonts';
import { type HersheyFile, parseHershey } from './hershey';
import type { LoadedFont } from './outline';

export interface CustomFont {
  name: string;
  data: ArrayBuffer;
}

export function parseOutlineFont(buffer: ArrayBuffer): LoadedFont {
  return { kind: 'outline', font: parse(buffer) };
}

export class FontLoader {
  private readonly cache = new Map<string, Promise<LoadedFont>>();
  private readonly loadAsset: (path: string) => Promise<ArrayBuffer>;

  constructor(loadAsset: (path: string) => Promise<ArrayBuffer>) {
    this.loadAsset = loadAsset;
  }

  load(id: string, custom: CustomFont | null | undefined): Promise<LoadedFont> {
    if (id === CUSTOM_FONT_ID) {
      if (!custom) return Promise.reject(new Error('Load a font file to use a custom font.'));
      return this.cached(`custom:${fontFingerprint(custom.data)}`, async () => parseOutlineFont(custom.data.slice(0)));
    }
    const info = fontInfo(id) ?? fontInfo('montserrat')!;
    return this.cached(info.id, async () => {
      const buffer = await this.loadAsset(info.file);
      if (info.kind === 'outline') return parseOutlineFont(buffer);
      return { kind: 'stroke', font: parseHershey(JSON.parse(new TextDecoder().decode(buffer)) as HersheyFile) };
    });
  }

  // A failed load is forgotten so the next render can try again.
  private cached(key: string, load: () => Promise<LoadedFont>): Promise<LoadedFont> {
    let pending = this.cache.get(key);
    if (!pending) {
      pending = load();
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
    }
    return pending;
  }
}
