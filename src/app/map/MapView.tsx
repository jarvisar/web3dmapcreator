import 'maplibre-gl/dist/maplibre-gl.css';
import { Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { IControl } from 'maplibre-gl';
import { CircleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { areaGeoBounds, effectiveScale, modelSizeMm, validateArea } from '../../core/geo/area';
import type { AreaSpec } from '../../core/settings';
import type { LabelSettings } from '../../core/svgmap/text/label';
import { Segmented } from '../components/Segmented';
import { areaHint } from '../lib/area';
import { formatMmPair, formatRatio, formatSizePair } from '../lib/format';
import { areaResizable, dismissMapHint, setArea, setBasemap, setLabel, useApp } from '../state/store';
import type { AppState, BasemapKey } from '../state/store';
import { useLabelArtwork } from '../svgmap/labelArtwork';
import { type TitleDrag, type TitleGrip, dragTitle, droppedLabel, titleHandles } from '../svgmap/labelDrag';
import { pieceOverlay } from '../svgmap/overlay';
import { pieceLayout, pieceProduct } from '../svgmap/piece';
import { AreaEditor, type TitleDragPhase } from './AreaEditor';
import { BASEMAPS, flattenBuildings } from './basemaps';
import { registerMap } from './mapHandle';
import { tracksGeoJson } from '../state/tracks';

const ROUTES = 'routes';
const NO_ROUTES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Imported routes on the map, in the route colour on a white casing, with a
 * filled dot at the start and an open one at the finish. A new base map
 * takes them away with its style, so they're added again whenever the style
 * changes. Returns what it showed, or null while the style is loading.
 */
function showRoutes(map: MlMap, data: GeoJSON.FeatureCollection, colour: string, shown: { data: unknown; colour: string } | null): { data: unknown; colour: string } | null {
  try {
    const source = map.getSource<GeoJSONSource>(ROUTES);
    if (!source) {
      map.addSource(ROUTES, { type: 'geojson', data });
      const layout = { 'line-join': 'round', 'line-cap': 'round' } as const;
      map.addLayer({ id: 'route-casing', type: 'line', source: ROUTES, layout, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.85 } });
      map.addLayer({ id: 'route-line', type: 'line', source: ROUTES, layout, paint: { 'line-color': colour, 'line-width': 3 } });
      map.addLayer({
        id: 'route-ends',
        type: 'circle',
        source: ROUTES,
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 4.5, 'circle-stroke-width': 2, 'circle-color': ['match', ['get', 'end'], 'start', colour, '#ffffff'], 'circle-stroke-color': colour },
      });
      return { data, colour };
    }
    if (shown?.data !== data) void source.setData(data);
    if (shown?.colour !== colour) {
      map.setPaintProperty('route-line', 'line-color', colour);
      map.setPaintProperty('route-ends', 'circle-color', ['match', ['get', 'end'], 'start', colour, '#ffffff']);
      map.setPaintProperty('route-ends', 'circle-stroke-color', colour);
    }
    return { data, colour };
  } catch {
    // The style isn't ready yet. Its styledata event comes back here.
    return null;
  }
}

// MapLibre finds its worker next to its own module, which is gone once Vite
// bundles it. Point it at a worker chunk Vite builds instead.
setWorkerUrl(maplibreWorkerUrl);

function areaLabel(state: AppState): string {
  const { area } = state;
  // The same three things for both: the area, the scale and the size, an SVG
  // map's being its piece.
  if (state.output === 'svg') {
    const piece = pieceProduct(state.svg.product, area.shape);
    return `${formatSizePair(area.widthM, area.heightM)} · ${formatRatio(1000 / state.svg.scale)} · ${formatMmPair(piece.width, piece.height)}`;
  }
  const size = modelSizeMm(area, state.settings.scale);
  return `${formatSizePair(area.widthM, area.heightM)} · ${formatRatio(effectiveScale(area, state.settings.scale))} · ${formatMmPair(size.width, size.depth)}`;
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
  const editorRef = useRef<AreaEditor | null>(null);
  const basemap = useApp((state) => state.ui.basemap);
  const hintDismissed = useApp((state) => state.ui.mapHintDismissed);
  const svg = useApp((state) => state.output === 'svg');
  const shape = useApp((state) => state.area.shape);
  const piece = useApp((state) => state.svg.product);
  const border = useApp((state) => state.svg.border);
  const label = useApp((state) => state.svg.label);
  const resizable = useApp((state) => areaResizable(state));
  const customFontId = useApp((state) => state.customFontId);
  const layout = useMemo(() => (svg ? pieceLayout(piece, shape, border).layout : null), [svg, piece, shape, border]);
  // Routes are only built into 3D models for now, so an SVG map doesn't show them.
  const tracks = useApp((state) => state.tracks);
  const routeColour = useApp((state) => state.palette.route.hex);
  const routeData = useMemo(() => (svg ? NO_ROUTES : tracksGeoJson(tracks)), [svg, tracks]);
  const routes = useRef({ data: routeData, colour: routeColour, shown: null as { data: unknown; colour: string } | null });
  routes.current.data = routeData;
  routes.current.colour = routeColour;
  // The title while it's dragged on the map. It's only stored when let go.
  // Pressing it selects it, which shows its handles.
  const [dragged, setDragged] = useState<LabelSettings | null>(null);
  const [titleSelected, setTitleSelected] = useState(false);
  const shownLabel = dragged ?? label;
  const { artwork, error: labelError, layoutWith } = useLabelArtwork(svg, layout, shownLabel, customFontId);
  const latest = useRef({ layout, label, artwork, layoutWith });
  latest.current = { layout, label, artwork, layoutWith };
  const grab = useRef<{ drag: TitleDrag; to: LabelSettings | null } | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [basemapFailed, setBasemapFailed] = useState(false);
  const tileErrors = useRef(0);
  useEffect(() => {
    if (!artwork) setTitleSelected(false);
  }, [artwork]);

  const onTitleDrag = (phase: TitleDragPhase, dx: number, dy: number, grip: TitleGrip = 'move') => {
    const { layout: at, label: stored, artwork: shown, layoutWith: relayout } = latest.current;
    if (phase === 'start') {
      grab.current = shown ? { drag: { grip, label: stored, artwork: shown }, to: null } : null;
      setTitleSelected(true);
      return;
    }
    const g = grab.current;
    if (phase === 'move') {
      if (!at || !g || !relayout) return;
      g.to = dragTitle(at, g.drag, dx, dy, relayout);
      setDragged(g.to);
      return;
    }
    grab.current = null;
    const placed = phase === 'end' && g?.to && relayout ? relayout(g.to) : null;
    if (g?.to && placed) setLabel(droppedLabel(g.to, placed));
    setDragged(null);
  };
  const titleDrag = useRef(onTitleDrag);
  titleDrag.current = onTitleDrag;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = useApp.getState();
    const bounds = areaGeoBounds(initial.area);
    let map: MlMap;
    try {
      map = new MlMap({
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
    } catch (error) {
      // No WebGL2: graphics acceleration off, or a GPU the browser won't use.
      // Left to the error screen, the whole app went and it offered to reset
      // the settings, which can't help.
      console.warn('The map could not start', error);
      setMapFailed(true);
      return;
    }
    // A tile now and then can fail. The style itself, or a run of tiles with
    // none coming in, means the base map is down.
    map.on('error', (event) => {
      if (!(event as { sourceId?: string }).sourceId || ++tileErrors.current >= 3) setBasemapFailed(true);
    });
    map.on('sourcedata', (event) => {
      if (!event.tile) return;
      tileErrors.current = 0;
      setBasemapFailed(false);
    });
    map.on('styledata', () => {
      const r = routes.current;
      if (map.getSource(ROUTES)) return;
      r.shown = showRoutes(map, r.data, r.colour, null);
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
      onTitleDrag: (phase, dx, dy, grip) => titleDrag.current(phase, dx, dy, grip),
      onTitleBlur: () => setTitleSelected(false),
    });
    editorRef.current = editor;
    editor.setLabel(areaLabel(initial));
    editor.setInvalid(validateArea(initial.area) !== null);

    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.area !== previous.area) {
        editor.setArea(state.area);
        editor.setInvalid(validateArea(state.area) !== null);
      }
      if (state.area !== previous.area || state.settings.scale !== previous.settings.scale || state.output !== previous.output || state.svg !== previous.svg) {
        editor.setLabel(areaLabel(state));
      }
      if (state.ui.mapFocus !== previous.ui.mapFocus) {
        if (state.ui.mapFocus.mode === 'always' || !areaInView(map, state.area)) fitMapToArea(map, state.area, true);
      }
    });

    return () => {
      unsubscribe();
      editorRef.current = null;
      editor.destroy();
      map.remove();
      mapRef.current = null;
      registerMap(null);
    };
  }, []);

  // An SVG map's window keeps the piece's proportions, and the piece is drawn around it.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setAspect(layout ? layout.window.h / layout.window.w : null);
    editor.setResizable(resizable);
    const handles = titleSelected && artwork ? titleHandles(shownLabel, artwork) : [];
    editor.setPiece(layout ? pieceOverlay(layout, artwork, handles, titleSelected) : null);
  }, [svg, layout, artwork, resizable, titleSelected, shownLabel]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const r = routes.current;
    r.shown = showRoutes(map, routeData, routeColour, r.shown) ?? r.shown;
  }, [routeData, routeColour]);

  // The first style is set when the map is created. Later changes swap it.
  const firstStyle = useRef(true);
  useEffect(() => {
    if (firstStyle.current) {
      firstStyle.current = false;
      return;
    }
    tileErrors.current = 0;
    setBasemapFailed(false);
    mapRef.current?.setStyle(BASEMAPS[basemap].style, { transformStyle: flattenBuildings });
  }, [basemap]);

  useEffect(() => {
    if (active) mapRef.current?.resize();
  }, [active]);

  if (mapFailed) {
    return (
      <div className="map-view" aria-hidden={!active} inert={!active}>
        <div className="map-host" />
        <div className="map-failed">
          <div className="notice notice-warning floating" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>
              This browser can't draw the map, because WebGL2 is off or not supported here. Turn on graphics or hardware
              acceleration in the browser's settings and reload, or try another browser. You can still search for a place
              and set the size in the sidebar{svg ? ', and make the SVG map' : ''}.
            </span>
          </div>
        </div>
      </div>
    );
  }

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
      {basemapFailed && (
        <div className="map-notice map-notice-top notice notice-warning floating" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span>The base map didn't load. Try another one with the buttons above, or check your connection. The area and everything else still work.</span>
        </div>
      )}
      {!hintDismissed && (
        <div className="map-hint floating" role="note">
          <span>{areaHint(resizable)}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss tip" onClick={dismissMapHint}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {svg && labelError && (
        <div className="map-notice notice notice-warning floating" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{labelError}</span>
        </div>
      )}
    </div>
  );
}
