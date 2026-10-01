import { useCallback, useEffect, useMemo, useState } from 'react';
import { download } from '../../core/svgmap/download';
import type { Layout } from '../../core/svgmap/layout/layout';
import { type LabelArtwork, type LabelSettings, buildLabel } from '../../core/svgmap/text/label';
import type { FontLoader } from '../../core/svgmap/text/loadFont';
import type { LoadedFont } from '../../core/svgmap/text/outline';
import { getCustomFont } from './customFont';

let loader: Promise<FontLoader> | null = null;

// opentype.js is loaded on demand so it isn't part of the first page load.
// Same idle limit as the render worker's fonts: a font that never finishes
// would otherwise hold the title overlay, and every later load of it.
function fontLoader(): Promise<FontLoader> {
  loader ??= import('../../core/svgmap/text/loadFont').then(
    ({ FontLoader }) =>
      new FontLoader(async (path) => {
        const url = new URL(path, new URL(import.meta.env.BASE_URL, document.baseURI)).href;
        const { status, bytes } = await download(url, 30_000);
        if (!bytes) throw new Error(`Could not load ${path} (${status}).`);
        return bytes;
      }),
    (error: unknown) => {
      // Try the chunk again next time, it may have been a dropped connection.
      loader = null;
      throw error;
    },
  );
  return loader;
}

export interface LabelPreview {
  artwork: LabelArtwork | null;
  // Why the title can't be drawn, like not fitting inside the border.
  error: string | null;
  // Lays the title out with other settings straight away, for a drag. Null
  // until the fonts are in.
  layoutWith: ((label: LabelSettings) => LabelArtwork | null) | null;
}

interface Fonts {
  key: string;
  title: LoadedFont | null;
  subtitle: LoadedFont | null;
  error: string | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Lays out the title on the main thread, for the map overlay and dragging it
// in the preview. Nothing is loaded while `active` is false.
export function useLabelArtwork(active: boolean, layout: Layout | null, label: LabelSettings, customFontId: string | null): LabelPreview {
  const wanted = active && label.enabled && label.text.trim() !== '';
  const subtitleId = label.subtitleFont || label.font;
  const key = `${label.font}|${subtitleId}|${customFontId ?? ''}`;
  // The last fonts loaded stay in use while others load, so the title doesn't
  // blink out when the font changes.
  const [fonts, setFonts] = useState<Fonts | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const custom = getCustomFont();
    fontLoader()
      .then((loaded) => Promise.all([loaded.load(label.font, custom), loaded.load(subtitleId, custom)]))
      .then(([title, subtitle]) => {
        if (live) setFonts({ key, title, subtitle, error: null });
      })
      .catch((error: unknown) => {
        if (live) setFonts({ key, title: null, subtitle: null, error: message(error) });
      });
    return () => {
      live = false;
    };
    // The key covers both fonts and the loaded file.
  }, [wanted, key]);

  const build = useCallback(
    (l: LabelSettings): { artwork: LabelArtwork | null; error: string | null } => {
      if (!layout || !fonts?.title) return { artwork: null, error: null };
      try {
        return buildLabel(layout, l, fonts.title, fonts.subtitle);
      } catch (error) {
        return { artwork: null, error: message(error) };
      }
    },
    [layout, fonts],
  );
  return useMemo(() => {
    if (!wanted) return { artwork: null, error: null, layoutWith: null };
    if (fonts?.error && fonts.key === key) return { artwork: null, error: fonts.error, layoutWith: null };
    return { ...build(label), layoutWith: fonts?.title && layout ? (l: LabelSettings) => build(l).artwork : null };
  }, [wanted, fonts, key, build, label, layout]);
}
