import 'maplibre-gl/dist/maplibre-gl.css';
import { Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { IControl } from 'maplibre-gl';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { areaGeoBounds, modelSizeMm, validateArea } from '../../core/geo/area';
import type { AreaSpec, ModelSettings } from '../../core/settings';
import { Segmented } from '../components/Segmented';
import { AREA_HINT } from '../lib/area';
import { formatMmPair, formatSizePair } from '../lib/format';
import { dismissMapHint, setArea, setBasemap, useApp } from '../state/store';
import type { BasemapKey } from '../state/store';
import { AreaEditor } from './AreaEditor';
import { BASEMAPS, flattenBuildings } from './basemaps';
import { registerMap } from './mapHandle';

// MapLibre finds its worker next to its own module, which is gone once Vite
// bundles it. Point it at a worker chunk Vite builds instead.
setWorkerUrl(maplibreWorkerUrl);

function areaLabel(area: AreaSpec, settings: ModelSettings): string {
  const size = modelSizeMm(area, settings.scale);
  return `${formatSizePair(area.widthM, area.heightM)} · ${formatMmPair(size.width, size.depth)}`;
}

function padding(container: HTMLElement) {
  const width = container.clientWidth;
  const height = container.clientHeight;
  // Room for the basemap switcher and rotate handle above, the size label below.
  if (Math.min(width, height) < 520) return { top: 96, bottom: 56, left: 24, right: 24 };
  return { top: 100, bottom: 96, left: 64, right: 64 };
}

export function fitMapToArea(map: MlMap, area: AreaSpec, animate: boolean) {
  const b = areaGeoBounds(area);
  map.fitBounds(
    [
      [b.west, b.south],
      [b.east, b.north],
    ],
    { padding: padding(map.getContainer()), duration: animate ? 900 : 0, maxZoom: 17 },
  );
}

function areaInView(map: MlMap, area: AreaSpec): boolean {
  const b = areaGeoBounds(area);
  const view = map.getBounds();
  return b.west >= view.getWest() && b.east <= view.getEast() && b.south >= view.getSouth() && b.north <= view.getNorth();
}

// A button in MapLibre's control stack that frames the area.
class ZoomToAreaControl implements IControl {
  private container: HTMLDivElement | null = null;
  constructor(private readonly onClick: () => void) {}

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zoom-to-area';
    button.title = 'Zoom to area';
    button.setAttribute('aria-label', 'Zoom to area');
    button.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>';
    button.addEventListener('click', this.onClick);
    container.appendChild(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}

const BASEMAP_OPTIONS = (Object.keys(BASEMAPS) as BasemapKey[]).map((key) => ({ value: key, label: BASEMAPS[key].label }));

export function MapView({ active }: { active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const basemap = useApp((state) => state.ui.basemap);
  const hintDismissed = useApp((state) => state.ui.mapHintDismissed);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = useApp.getState();
    const bounds = areaGeoBounds(initial.area);
    const map = new MlMap({
      container: host,
      bounds: [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      fitBoundsOptions: { padding: padding(host), maxZoom: 17 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      renderWorldCopies: false,
      // The OpenFreeMap styles trip a few harmless validation warnings.
      validateStyle: false,
    });
    map.setStyle(BASEMAPS[initial.ui.basemap].style, { transformStyle: flattenBuildings });
    mapRef.current = map;
    registerMap(map);
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ZoomToAreaControl(() => fitMapToArea(map, useApp.getState().area, true)), 'top-right');
    map.addControl(new ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

    const editor = new AreaEditor(map, initial.area, {
      onChange: (area) => setArea(area),
      onDragStart: () => {
        if (!useApp.getState().ui.mapHintDismissed) dismissMapHint();
      },
    });
    editor.setLabel(areaLabel(initial.area, initial.settings));
    editor.setInvalid(validateArea(initial.area) !== null);

    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.area !== previous.area) {
        editor.setArea(state.area);
        editor.setInvalid(validateArea(state.area) !== null);
      }
      if (state.area !== previous.area || state.settings.scale !== previous.settings.scale) {
        editor.setLabel(areaLabel(state.area, state.settings));
      }
      if (state.ui.mapFocus !== previous.ui.mapFocus) {
        if (state.ui.mapFocus.mode === 'always' || !areaInView(map, state.area)) fitMapToArea(map, state.area, true);
      }
    });

    return () => {
      unsubscribe();
      editor.destroy();
      map.remove();
      mapRef.current = null;
      registerMap(null);
    };
  }, []);

  // The first style is set when the map is created. Later changes swap it.
  const firstStyle = useRef(true);
  useEffect(() => {
    if (firstStyle.current) {
      firstStyle.current = false;
      return;
    }
    mapRef.current?.setStyle(BASEMAPS[basemap].style, { transformStyle: flattenBuildings });
  }, [basemap]);

  useEffect(() => {
    if (active) mapRef.current?.resize();
  }, [active]);

  return (
    <div className="map-view" aria-hidden={!active} inert={!active}>
      <div ref={hostRef} className="map-host" role="region" aria-label="Map. Drag the highlighted area to move it." />
      <div className="map-overlay map-overlay-top-left">
        <Segmented
          label="Base map"
          size="sm"
          value={basemap}
          onChange={setBasemap}
          className="floating basemap-switch"
          options={BASEMAP_OPTIONS}
        />
      </div>
      {!hintDismissed && (
        <div className="map-hint floating" role="note">
          <span>{AREA_HINT}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss tip" onClick={dismissMapHint}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
