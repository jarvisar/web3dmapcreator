// Generate and download for SVG maps.
import { useMemo } from 'react';
import { validateArea } from '../../core/geo/area';
import type { AreaSpec } from '../../core/settings';
import type { RenderResult } from '../../core/svgmap/result';
import type { RenderSettings } from '../../core/svgmap/settings';
import { toSvg } from '../../core/svgmap/svg/writer';
import { NARROW_QUERY, downloadBlob } from '../lib/browser';
import { formatBytes } from '../lib/format';
import { fileBase } from '../state/derived';
import { setDrawerOpen, setView, toast, useApp } from '../state/store';
import { getCustomFont } from './customFont';
import { pieceLayout } from './piece';
import { requestRender, settingsKey, useSvgRender } from './render';
import { type SvgSettings, toRenderSettings } from './settings';

/** Why the SVG map can't be made from this area and these settings, or null. */
export function svgProblem(area: AreaSpec, svg: SvgSettings): string | null {
  return validateArea(area) ?? pieceLayout(svg.product, area.shape, svg.border).error;
}

function current(): { settings: RenderSettings; key: string } {
  const state = useApp.getState();
  const settings = toRenderSettings(state.area, state.svg, state.placeName);
  const font = state.customFontName ? getCustomFont() : null;
  return { settings, key: settingsKey(settings, font) };
}

/** The render settings and their key, updated as the state changes. */
export function useSvgKey(): string {
  const area = useApp((state) => state.area);
  const svg = useApp((state) => state.svg);
  const placeName = useApp((state) => state.placeName);
  const customFontName = useApp((state) => state.customFontName);
  return useMemo(
    () => settingsKey(toRenderSettings(area, svg, placeName), customFontName ? getCustomFont() : null),
    [area, svg, placeName, customFontName],
  );
}

export function renderSvgNow(): void {
  const { settings } = current();
  requestRender(settings, useApp.getState().customFontName ? getCustomFont() : null);
}

// Renders, then shows the preview when it's done, the way a 3D model opens
// in the 3D view. An up to date SVG just opens.
export function generateSvg(): void {
  const state = useApp.getState();
  if (svgProblem(state.area, state.svg)) return;
  const { key } = current();
  const render = useSvgRender.getState();
  // A map with tiles missing is rendered again, which tries those tiles.
  if (render.resultKey === key && !render.result?.stats.missingTiles) {
    showPreview();
    return;
  }
  renderSvgNow();
  const unsubscribe = useSvgRender.subscribe((next) => {
    if (next.status === 'working') return;
    unsubscribe();
    if (next.status === 'done' && next.resultKey === key && useApp.getState().output === 'svg') showPreview();
  });
}

function showPreview() {
  setView('result');
  if (window.matchMedia(NARROW_QUERY).matches) setDrawerOpen(false);
}

// Named after the title, like chicago-laser.svg, unless a file name was typed.
// The title and mode come from the result, which can be older than the settings.
export function svgFileName(result: RenderResult): string {
  return `${fileBase(result.meta.title, useApp.getState().fileName)}-${result.mode}.svg`;
}

export function downloadSvg(): void {
  const result = useSvgRender.getState().result;
  if (!result) return;
  const name = svgFileName(result);
  const blob = new Blob([toSvg(result)], { type: 'image/svg+xml' });
  downloadBlob(blob, name);
  toast(`Downloaded ${name} (${formatBytes(blob.size)})`, 'success');
}
