import { useEffect, useState } from 'react';
import type { Layout } from '../../core/svgmap/layout/layout';
import { type LabelArtwork, type LabelSettings, buildLabel } from '../../core/svgmap/text/label';
import type { FontLoader } from '../../core/svgmap/text/loadFont';
import { getCustomFont } from './customFont';

let loader: Promise<FontLoader> | null = null;

// opentype.js is loaded on demand so it isn't part of the first page load.
function fontLoader(): Promise<FontLoader> {
  loader ??= import('../../core/svgmap/text/loadFont').then(
    ({ FontLoader }) =>
      new FontLoader(async (path) => {
        const response = await fetch(new URL(path, new URL(import.meta.env.BASE_URL, document.baseURI)));
        if (!response.ok) throw new Error(`Could not load ${path}.`);
        return response.arrayBuffer();
      }),
  );
  return loader;
}

export interface LabelPreview {
  artwork: LabelArtwork | null;
  // Why the title can't be drawn, like not fitting inside the border.
  error: string | null;
}

// Lays out the title on the main thread for the map overlay. Nothing is
// loaded while `active` is false.
export function useLabelArtwork(active: boolean, layout: Layout | null, label: LabelSettings, customFontName: string | null): LabelPreview {
  const [preview, setPreview] = useState<LabelPreview>({ artwork: null, error: null });
  useEffect(() => {
    let live = true;
    if (!active || !layout || !label.enabled || !label.text.trim()) {
      setPreview({ artwork: null, error: null });
      return;
    }
    const custom = getCustomFont();
    const subtitleId = label.subtitleFont || label.font;
    fontLoader()
      .then((fonts) => Promise.all([fonts.load(label.font, custom), fonts.load(subtitleId, custom)]))
      .then(([title, subtitle]) => {
        if (live) setPreview(buildLabel(layout, label, title, subtitle));
      })
      .catch((error: unknown) => {
        if (live) setPreview({ artwork: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [active, layout, label, customFontName]);
  return preview;
}
