// Stage 2: prepared geometry and settings to styled output groups. Runs on every
// settings change, so layer unions are cached in memo between renders.
import type { Paths64 } from 'clipper2-ts';
import { clipPolylineOutside } from './geo/clip';
import {
  areaMm2,
  bufferLines,
  intersectWith,
  linesOutside,
  makeFillTester,
  pathsD,
  resolveSurfaces,
  subtract,
  toPath64,
  unionAll,
} from './fills';
import type { Layout } from './layout/layout';
import { bandPathD, distanceToEdge, insetShape, shapePathD, shapePolygon } from './layout/shapes';
import { cleanupLines } from './lines/cleanup';
import { lineCoverage } from './lines/coverage';
import { type LineItem, type Path, pathLength } from './lines/geometry';
import { weldPaths } from './lines/weld';
import { hatchWith, orderForPlotting, outlines } from './plotter';
import type { Prepared, PreparedLine, PreparedPolygon } from './prepare';
import type { OutputGroup, OutputPath, PlotterStats, RenderResult } from './result';
import {
  type ElementId,
  FILL_LAYERS,
  type FillLayerId,
  type FillMode,
  LAYER_NAMES,
  LINE_LAYERS,
  type LineLayerId,
  ROAD_WIDTH_SCALE,
  type RenderSettings,
} from './settings';
import { polylineD } from './svg/format';
import { type LabelArtwork, buildLabel } from './text/label';
import type { LoadedFont } from './text/outline';
import { FLAG, acceptLine, acceptPolygon } from './tiles/schema';

export interface ComposeFonts {
  title: LoadedFont | null;
  subtitle: LoadedFont | null;
}

interface LineKey {
  layer: LineLayerId;
  cls: string;
}

// A group before it becomes path data, so the plotter can still reorder it.
interface Draft {
  id: string;
  element: ElementId;
  label: string;
  kind: 'fill' | 'stroke';
  strokeWidth: number;
  fill?: Paths64;
  // Split by class when print mode gives each road class its own width.
  lines?: { cls?: string; width?: number; paths: Path[] }[];
  // Exact path data with arcs, for the border and the cut.
  d?: string;
  // The same outline as polylines, used by the plotter instead of d.
  plotLines?: Path[];
}

const ATTRIBUTION = '© OpenStreetMap contributors';

function filterSignature(s: RenderSettings, layer: FillLayerId): string {
  const f = s.filters;
  switch (layer) {
    case 'water':
      return `${f.water.pools}${f.water.intermittent}`;
    case 'greens':
      return `${f.greens.wetlands}${f.greens.pitches}${f.greens.cemeteries}`;
    case 'decks':
      return `${f.decks.bridges}`;
    default:
      return '';
  }
}

export function compose(
  settings: RenderSettings,
  layout: Layout,
  prepared: Prepared,
  fonts: ComposeFonts,
  memo: Map<string, Paths64>,
): RenderResult {
  const timings: Record<string, number> = {};
  let clock = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - clock);
    clock = now;
  };
  const s = settings;
  const style = s.style;
  const warnings = [...prepared.warnings];
  const window = layout.window;
  const windowPoly = shapePolygon(window);
  const plotter = s.mode === 'plotter';
  // Same floor as the UI. A zero pen width would never finish the band passes below.
  const pen = Math.max(s.plotter.penWidth, 0.05);
  const hairline = plotter ? pen : s.mode === 'laser' ? 0.05 : 0.1;

  // Title
  const built = buildLabel(layout, s.label, fonts.title, fonts.subtitle);
  if (built.error) warnings.push(built.error);
  const label: LabelArtwork | null = built.artwork;
  const knockoutPoly: Path | null = label
    ? [
        [label.knockout[0], label.knockout[1]],
        [label.knockout[0] + label.knockout[2], label.knockout[1]],
        [label.knockout[0] + label.knockout[2], label.knockout[1] + label.knockout[3]],
        [label.knockout[0], label.knockout[1] + label.knockout[3]],
      ]
    : null;
  const knockout = knockoutPoly ? [toPath64(knockoutPoly)] : [];
  lap('label');

  // Fills
  const layerOn = s.layers;
  const unionOf = (layer: FillLayerId): Paths64 => {
    if (!layerOn[layer]) return [];
    const key = `${layer}|${filterSignature(s, layer)}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const rings: Paths64 = [];
    for (const p of prepared.polygons as PreparedPolygon[]) {
      if (p.layer === layer && acceptPolygon(p, s.filters)) for (const r of p.rings) rings.push(r);
    }
    const merged = unionAll(rings);
    memo.set(key, merged);
    return merged;
  };

  const acceptedLines = prepared.lines.filter((l) => layerOn[l.layer] && acceptLine(l, s.filters));
  let waterGaps: Paths64 = [];
  if (s.water.bridgeGap > 0 && layerOn.water) {
    const bridges = acceptedLines
      .filter((l) => l.flags & FLAG.bridge && (l.layer === 'roads' || l.layer === 'railways'))
      .map((l) => l.path);
    waterGaps = bufferLines(bridges, s.water.bridgeGap, false);
  }
  const surfaces = resolveSurfaces(
    {
      buildings: unionOf('buildings'),
      decks: unionOf('decks'),
      water: unionOf('water'),
      aeroways: unionOf('aeroways'),
      rocks: unionOf('rocks'),
      sand: unionOf('sand'),
      greens: unionOf('greens'),
      waterGaps,
    },
    { waterHalo: s.water.halo },
  );
  const finalFill = (paths: Paths64): Paths64 => {
    let out = window.kind === 'rect' ? paths : intersectWith(paths, [toPath64(windowPoly)]);
    if (knockout.length) out = subtract(out, knockout);
    return out;
  };
  const fills: Record<FillLayerId, Paths64> = {
    water: finalFill(surfaces.water),
    greens: finalFill(surfaces.greens),
    sand: finalFill(surfaces.sand),
    rocks: finalFill(surfaces.rocks),
    aeroways: finalFill(surfaces.aeroways),
    decks: s.decks.engrave ? finalFill(surfaces.decks) : [],
    buildings: finalFill(surfaces.buildings),
  };
  lap('fills');

  // Lines
  const groupOf =
    s.mode === 'print' && style.classWidths
      ? (k: LineKey) => `${k.layer}|${k.cls}`
      : (k: LineKey) => k.layer;
  const toItem = (l: PreparedLine): LineItem<LineKey> => ({
    rank: l.rank,
    key: { layer: l.layer, cls: l.cls },
    path: l.path,
  });
  const cleanupInput = acceptedLines.filter((l) => l.layer !== 'raceways').map(toItem);
  const edgeTolerance = Math.max(s.cleanup.weldTolerance, 0.001);
  const cleaned = cleanupLines(cleanupInput, s.cleanup, {
    groupOf,
    isPathGroup: (k) => k.layer === 'paths',
    onBoundary: (p) => distanceToEdge(window, p) <= edgeTolerance,
    coveredFn: makeFillTester([fills.buildings, fills.water]),
  });
  // Coverage only counts roads. Sidewalks and parallel tracks are supposed to be
  // thinned out, streets are not.
  const roadsBefore = cleanupInput.filter((i) => i.key.layer === 'roads').map((i) => i.path);
  // The tolerance scales with line spacing (0.2 mm at 0.3 mm) so roads merged
  // on purpose don't count as lost.
  const coverage =
    s.cleanup.enabled && s.cleanup.cull && roadsBefore.length > 0
      ? lineCoverage(
          roadsBefore,
          cleaned.items.filter((i) => i.key.layer === 'roads').map((i) => i.path),
          Math.max(s.cleanup.coverageTolerance, (s.cleanup.lineSpacing * 2) / 3),
        )
      : null;
  if (coverage !== null && coverage < 0.97) {
    warnings.push(
      `Cleanup kept ${(coverage * 100).toFixed(1)}% of the roads. Below 97% means streets were removed, not just doubled lines. Lower the line spacing or stub pruning.`,
    );
  }
  // Racetracks skip cleanup and are drawn as mapped. Welding only rejoins tile seams.
  const raceways = weldPaths(
    acceptedLines.filter((l) => l.layer === 'raceways').map(toItem),
    Math.max(s.cleanup.weldTolerance, 0.01),
    { groupFn: groupOf },
  ).items;
  lap('lines');

  const byLayer = new Map<LineLayerId, LineItem<LineKey>[]>();
  for (const item of [...cleaned.items, ...raceways]) {
    const list = byLayer.get(item.key.layer);
    if (list) list.push(item);
    else byLayer.set(item.key.layer, [item]);
  }
  const clipLabel = (paths: Path[]): Path[] =>
    knockoutPoly ? paths.flatMap((p) => clipPolylineOutside(p, knockoutPoly)) : paths;

  // Groups
  const drafts: Draft[] = [];
  const fillDraft = (id: string, element: ElementId, name: string, paths: Paths64, mode: FillMode, hatchKey: FillLayerId | 'text') => {
    if (paths.length === 0) return;
    const effective: FillMode = plotter && mode === 'fill' ? 'hatch-outline' : mode;
    if (effective === 'fill') {
      drafts.push({ id, element, label: name, kind: 'fill', strokeWidth: 0, fill: paths });
      return;
    }
    // concat, not push(...), since fine hatching of a big area is more lines than a call can take.
    let lines: Path[] = [];
    if (effective === 'hatch' || effective === 'hatch-outline') {
      const h = style.hatch[hatchKey];
      lines = lines.concat(hatchWith(paths, { ...h, spacing: Math.max(h.spacing, 0.05) }));
    }
    if (effective === 'outline' || effective === 'hatch-outline') lines = lines.concat(outlines(paths));
    drafts.push({ id, element, label: name, kind: 'stroke', strokeWidth: hairline, lines: [{ paths: lines }] });
  };

  for (const layer of FILL_LAYERS) {
    fillDraft(layer, layer, LAYER_NAMES[layer], fills[layer], style.fillModes[layer], layer);
  }

  for (const layer of LINE_LAYERS) {
    let items = byLayer.get(layer) ?? [];
    if (items.length === 0) continue;
    if (layer === 'waterways' && fills.water.length) {
      // Don't draw a stream over its own river fill.
      items = items.flatMap((i) => linesOutside([i.path], fills.water).map((path) => ({ ...i, path })));
    }
    const width = plotter ? pen : s.mode === 'laser' ? hairline : style.lineWidths[layer];
    if (s.mode === 'print' && style.classWidths && layer === 'roads') {
      const classes = new Map<string, Path[]>();
      for (const i of items) {
        const list = classes.get(i.key.cls);
        if (list) list.push(i.path);
        else classes.set(i.key.cls, [i.path]);
      }
      // Minor roads first so major roads draw over them at junctions.
      const ordered = [...classes.entries()].sort(
        (a, b) => (ROAD_WIDTH_SCALE[a[0]] ?? 1) - (ROAD_WIDTH_SCALE[b[0]] ?? 1),
      );
      drafts.push({
        id: layer,
        element: layer,
        label: LAYER_NAMES[layer],
        kind: 'stroke',
        strokeWidth: width,
        lines: ordered.map(([cls, paths]) => ({
          cls,
          width: width * (ROAD_WIDTH_SCALE[cls] ?? 1),
          paths: clipLabel(paths),
        })),
      });
    } else {
      drafts.push({
        id: layer,
        element: layer,
        label: LAYER_NAMES[layer],
        kind: 'stroke',
        strokeWidth: width,
        lines: [{ paths: clipLabel(items.map((i) => i.path)) }],
      });
    }
  }

  if (label) {
    const rings = label.text.rings;
    if (rings.length > 0) {
      const letters = unionAll(rings.map(toPath64));
      fillDraft('text', 'text', 'Title', letters, style.fillModes.text, 'text');
    }
    if (label.text.strokes.length > 0) {
      // A band can mix an outline title with a single-line subtitle, and group ids have to stay unique.
      const mixed = rings.length > 0;
      drafts.push({
        id: mixed ? 'text-lines' : 'text',
        element: 'text',
        label: mixed ? 'Title (single-line)' : 'Title',
        kind: 'stroke',
        strokeWidth: plotter ? pen : s.mode === 'laser' ? hairline : 0.3,
        lines: [{ paths: label.text.strokes }],
      });
    }
    if (label.frame.length > 0) {
      drafts.push({
        id: 'frame',
        element: 'frame',
        label: s.label.style === 'band' ? 'Title divider' : 'Title box',
        kind: 'stroke',
        strokeWidth: plotter ? pen : Math.max(label.frameWidth, 0.05),
        lines: [{ paths: label.frame }],
      });
    }
  }

  if (layout.thickBand) {
    const { outer, inner } = layout.thickBand;
    // Not inner.x - outer.x: a hexagon's corners move in further than its sides.
    const thickness = s.border.thick;
    if (plotter) {
      // Plotters draw the band as concentric passes of the pen.
      const passes = Math.max(1, Math.round(thickness / pen));
      const loops: Path[] = [];
      for (let i = 0; i < passes; i++) {
        const ring = shapePolygon(insetShape(outer, (thickness * (i + 0.5)) / passes), 0.01);
        loops.push([...ring, ring[0]]);
      }
      drafts.push({ id: 'band', element: 'band', label: 'Border band', kind: 'stroke', strokeWidth: pen, lines: [{ paths: loops }] });
    } else {
      drafts.push({ id: 'band', element: 'band', label: 'Border band', kind: 'fill', strokeWidth: 0, d: bandPathD(outer, inner) });
    }
  }
  if (layout.thinLine) {
    const ring = shapePolygon(layout.thinLine, 0.01);
    drafts.push({
      id: 'border',
      element: 'border',
      label: 'Border line',
      kind: 'stroke',
      strokeWidth: plotter ? pen : layout.thinWidth,
      d: shapePathD(layout.thinLine),
      plotLines: [[...ring, ring[0]]],
    });
  }
  if (style.cut) {
    const ring = shapePolygon(layout.canvas, 0.01);
    drafts.push({
      id: 'cut',
      element: 'cut',
      label: 'Cut line',
      kind: 'stroke',
      strokeWidth: hairline,
      d: shapePathD(layout.canvas),
      plotLines: [[...ring, ring[0]]],
    });
  }
  lap('style');

  // Plotter order
  let plotterStats: PlotterStats | null = null;
  if (plotter) {
    let penDown = 0;
    let penUp = 0;
    let penUpUnordered = 0;
    let here: [number, number] = [0, 0];
    let hereUnordered: [number, number] = [0, 0];
    for (const draft of drafts) {
      if (draft.plotLines) {
        draft.lines = [{ paths: draft.plotLines }];
        draft.d = undefined;
      }
      for (const set of draft.lines ?? []) {
        for (const p of set.paths) {
          penUpUnordered += Math.hypot(p[0][0] - hereUnordered[0], p[0][1] - hereUnordered[1]);
          hereUnordered = p[p.length - 1];
          penDown += pathLength(p);
        }
        if (s.plotter.optimize) {
          const ordered = orderForPlotting(set.paths, here);
          set.paths = ordered.paths;
          penUp += ordered.travel;
        } else {
          for (const p of set.paths) {
            penUp += Math.hypot(p[0][0] - here[0], p[0][1] - here[1]);
            here = p[p.length - 1];
          }
        }
        const last = set.paths[set.paths.length - 1];
        if (last) here = last[last.length - 1];
      }
    }
    const pens = new Set(drafts.map((d) => style.colors[d.element])).size;
    plotterStats = { penDownMm: penDown, penUpMm: penUp, penUpUnorderedMm: penUpUnordered, pens };
  }

  // Path data
  const groups: OutputGroup[] = [];
  for (const draft of drafts) {
    const paths: OutputPath[] = [];
    let subpaths = 0;
    let lengthMm = 0;
    let area = 0;
    if (draft.fill) {
      const d = pathsD(draft.fill);
      if (d) paths.push({ d });
      subpaths = draft.fill.length;
      area = Math.abs(areaMm2(draft.fill));
    } else if (draft.d) {
      paths.push({ d: draft.d });
      subpaths = 1;
    } else {
      for (const set of draft.lines ?? []) {
        const usable = set.paths.filter((p) => p.length >= 2);
        if (usable.length === 0) continue;
        paths.push({ d: usable.map((p) => polylineD(p)).join(''), strokeWidth: set.width, cls: set.cls });
        subpaths += usable.length;
        for (const p of usable) lengthMm += pathLength(p);
      }
    }
    if (paths.length === 0) continue;
    groups.push({
      id: draft.id,
      element: draft.element,
      label: draft.label,
      kind: draft.kind,
      color: style.colors[draft.element],
      strokeWidth: draft.strokeWidth,
      paths,
      subpaths,
      lengthMm,
      areaMm2: area,
    });
  }
  lap('output');

  const centre = { lon: s.area.lon, lat: s.area.lat };
  return {
    width: layout.canvas.w,
    height: layout.canvas.h,
    outline: shapePathD(layout.canvas),
    mode: s.mode,
    background: s.mode === 'print' ? style.background : null,
    groups,
    stats: {
      zoom: prepared.zoom,
      tiles: prepared.tiles,
      bytes: prepared.bytes,
      cleanup: s.cleanup.enabled ? cleaned.stats : null,
      coverage,
      plotter: plotterStats,
      timings,
    },
    warnings,
    meta: {
      title: s.title,
      centre,
      bearing: s.area.bearing,
      widthM: prepared.widthM,
      heightM: prepared.heightM,
      scale: Math.round(prepared.transform.metresPerMm * 1000),
      attribution: ATTRIBUTION,
      generated: new Date().toISOString(),
    },
  };
}
