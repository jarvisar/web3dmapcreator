import type { StyleSpecification, TransformStyleFunction } from 'maplibre-gl';
import type { BasemapKey } from '../state/store';

const SATELLITE: StyleSpecification = {
  version: 8,
  sources: {
    imagery: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics and the GIS User Community',
    },
  },
  layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }],
};

export const BASEMAPS: Record<BasemapKey, { label: string; style: string | StyleSpecification }> = {
  streets: { label: 'Streets', style: 'https://tiles.openfreemap.org/styles/liberty' },
  light: { label: 'Light', style: 'https://tiles.openfreemap.org/styles/positron' },
  satellite: { label: 'Satellite', style: SATELLITE },
};

// Top-down only: 3D building extrusions lean outwards at pitch 0 and clutter
// the selection, so draw the flat footprints at every zoom instead.
export const flattenBuildings: TransformStyleFunction = (_previous, next) => ({
  ...next,
  layers: next.layers
    .filter((layer) => layer.type !== 'fill-extrusion')
    .map((layer) => (layer.type === 'fill' && /building/i.test(layer.id) ? { ...layer, maxzoom: 24 } : layer)),
});
