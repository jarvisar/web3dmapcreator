// The live map, for panels that need the current view (Fit to map view).

import type { Map as MlMap } from 'maplibre-gl';
import { Projection } from '../../core/geo/projection';
import type { AreaSpec } from '../../core/settings';
import { constrainSize } from '../lib/area';

let current: MlMap | null = null;

export function registerMap(map: MlMap | null): void {
  current = map;
}

export function getMap(): MlMap | null {
  return current;
}

/**
 * The area resized to fill most of the visible map, centred on it. Keeps the
 * shape and rotation. Unrotated rectangles take the view's proportions, other
 * areas keep their own and are scaled to fit.
 */
export function areaForView(area: AreaSpec, share = 0.8): AreaSpec | null {
  const map = current;
  if (!map) return null;
  const container = map.getContainer();
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w < 10 || h < 10) return null;
  const center = map.getCenter();
  const projection = new Projection([center.lng, center.lat], 0, 1);
  const left = map.unproject([0, h / 2]);
  const right = map.unproject([w, h / 2]);
  const top = map.unproject([w / 2, 0]);
  const bottom = map.unproject([w / 2, h]);
  const viewW = Math.abs(projection.toLocal(right.lng, right.lat)[0] - projection.toLocal(left.lng, left.lat)[0]) * share;
  const viewH = Math.abs(projection.toLocal(top.lng, top.lat)[1] - projection.toLocal(bottom.lng, bottom.lat)[1]) * share;
  let width: number;
  let height: number;
  if (area.rotationDeg === 0 && (area.shape === 'rectangle' || area.shape === 'rounded')) {
    width = viewW;
    height = viewH;
  } else {
    const angle = (area.rotationDeg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const scale = Math.min(viewW / (area.widthM * cos + area.heightM * sin), viewH / (area.widthM * sin + area.heightM * cos));
    width = area.widthM * scale;
    height = area.heightM * scale;
  }
  [width, height] = constrainSize(area.shape, width, height, 'smaller');
  return { ...area, center: [center.lng, center.lat], widthM: width, heightM: height };
}
