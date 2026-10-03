// Editing routes on the map: moving points, going along the roads, cutting
// bits out, trimming the ends and drawing new routes. Not the model editor,
// which edits the generated model in the 3D view.
//
// Edits are worked out in metres around the area and stored as lon/lat like
// an import, each as one step of the settings undo (routes are part of
// Setup). Only the points an edit replaced are new. The rest keep their
// encoded values, so editing one corner never re-simplifies the whole route.
//
// The roads to follow are Overture's, every road and path around the area,
// as LiDAR only models snap routes to them. The worker downloads them
// (`roads` in the engine protocol) and the graph is built here, since a drag
// asks for a way along the roads on every pointer move.

import { create } from 'zustand';
import { areaGeoBounds } from '../../core/geo/area';
import { cutSpan, flatFrame, replaceSpan, reverseLines, trimLines, warpSpan, type FlatFrame } from '../../core/tracks/edit';
import { nearestRoad, RoadGraph, routeBetween } from '../../core/tracks/network';
import { decodePolyline, encodePolyline } from '../../core/tracks/polyline';
import { roadGraph as graphOf } from '../../core/tracks/roads';
import { snapOnGraph } from '../../core/tracks/snap';
import { decodeTrack, distanceM, encodeTrack, MAX_TRACK_POINTS, MAX_TRACKS, newTrackId, trackLengthM, type Track } from '../../core/tracks/track';
import type { GeoBounds, LonLat, Vec2 } from '../../core/types';
import { formatNumber } from '../lib/format';
import { getEngine } from './engine';
import { setDrawerOpen, setTracks, setView, toast, useApp } from './store';
import { asChange, undoChange } from './undo';

export type TrackTool = 'move' | 'draw';

/** A point of a route, by line and index into that line. */
export interface TrackPoint {
  line: number;
  index: number;
}

/** The stretch of one line from point `from` to point `to`, from < to. */
export interface TrackSection {
  line: number;
  from: number;
  to: number;
}

export type RoadsStatus = 'idle' | 'loading' | 'ready' | 'none' | 'failed';

interface TrackEditState {
  editing: boolean;
  trackId: string | null;
  selected: TrackPoint | null;
  section: TrackSection | null;
  /** One end of a section picked without Shift, waiting for the other. */
  sectionFrom: TrackPoint | null;
  tool: TrackTool;
  /** The first click of a new route, which has no line until the second. */
  draft: LonLat | null;
  /** Counts each time the editor is opened on something, so the map can bring it into view. */
  opened: number;
  roads: { status: RoadsStatus; message?: string };
  /** Changes when a new road network comes in. */
  network: number;
  /** What the map's hint line says, for what's going on there. */
  hint: string | null;
  /** Read out by screen readers, since points are picked on the map. */
  announce: string;
}

export const useTrackEdit = create<TrackEditState>()(() => ({
  editing: false,
  trackId: null,
  selected: null,
  section: null,
  sectionFrom: null,
  tool: 'move',
  draft: null,
  opened: 0,
  roads: { status: 'idle' },
  network: 0,
  hint: null,
  announce: '',
}));

const CLEARED = { selected: null, section: null, sectionFrom: null, draft: null } as const;
const TOAST_KEY = 'route-edit';

function say(text: string, action?: { label: string; run: () => void }): void {
  toast(text, 'info', action, TOAST_KEY);
}

export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${formatNumber(metres / 1000, metres < 10_000 ? 2 : 1)} km` : `${Math.round(metres)} m`;
}

// ------------------------------------------------------------ opening

let synced = false;

// Undo can take away the route being edited or the point selected, and
// another tab can replace the routes. The editor only exists for 3D models.
function sync(): void {
  if (synced) return;
  synced = true;
  useApp.subscribe((state, previous) => {
    const edit = useTrackEdit.getState();
    if (!edit.editing) return;
    if (state.output !== 'model') {
      stopEditing();
      return;
    }
    if (state.area !== previous.area) scheduleRoads();
    if (state.tracks === previous.tracks) return;
    const track = state.tracks.find((item) => item.id === edit.trackId);
    if (edit.trackId && !track) {
      useTrackEdit.setState({ trackId: null, tool: 'draw', ...CLEARED });
      return;
    }
    if (!track) return;
    const lines = decodeTrack(track);
    const { selected, section } = edit;
    if (selected && !lines[selected.line]?.[selected.index]) useTrackEdit.setState({ selected: null });
    if (section && (!lines[section.line] || section.to >= lines[section.line].length)) useTrackEdit.setState({ section: null, sectionFrom: null });
  });
}

function open(trackId: string | null, tool: TrackTool): void {
  sync();
  useTrackEdit.setState((s) => ({ editing: true, trackId, tool, ...CLEARED, opened: s.opened + 1 }));
  setView('map');
  // On a phone the drawer would cover the map.
  setDrawerOpen(false);
  loadRoads();
}

/** Opens the editor on a route, or the first shown one. */
export function editTrack(trackId?: string): void {
  const { tracks } = useApp.getState();
  const id = trackId ?? (tracks.find((track) => track.visible) ?? tracks[0])?.id ?? null;
  open(id, id ? 'move' : 'draw');
}

/** Opens the editor to draw a new route. */
export function drawTrack(): void {
  open(null, 'draw');
}

export function stopEditing(): void {
  useTrackEdit.setState({ editing: false, tool: 'move', ...CLEARED });
}

export function setEditedTrack(trackId: string | null): void {
  useTrackEdit.setState({ trackId, tool: trackId ? useTrackEdit.getState().tool : 'draw', ...CLEARED });
}

export function setTrackTool(tool: TrackTool): void {
  useTrackEdit.setState({ tool, draft: null, sectionFrom: null });
}

export function selectPoint(point: TrackPoint | null): void {
  useTrackEdit.setState({ selected: point, section: null, sectionFrom: null });
}

export function selectSection(section: TrackSection | null): void {
  useTrackEdit.setState({ section, selected: null, sectionFrom: null });
}

/** Waits for the other end of a section, for picking one without Shift. */
export function startSection(from: TrackPoint | null): void {
  useTrackEdit.setState({ sectionFrom: from });
}

export function trackById(id: string | null): Track | null {
  return useApp.getState().tracks.find((track) => track.id === id) ?? null;
}

// ------------------------------------------------------------ space and roads

/** Metres east and north of a point, and back, exactly. */
export type EditSpace = FlatFrame;

const spaceAt = flatFrame;

interface Network {
  key: string;
  space: EditSpace;
  graph: RoadGraph;
  bounds: GeoBounds;
}

let network: Network | null = null;
let loading: string | null = null;
let roadsTimer: ReturnType<typeof setTimeout> | undefined;
let lastSpace: EditSpace | null = null;

// Roads are loaded this far past the area, so a route can be edited a little outside it.
const ROAD_MARGIN_M = 300;
// Every road and path in an area this size is about 100 MB to download.
const MAX_ROAD_SIDE_M = 20_000;
// A route further than this from the roads' frame gets a frame of its own,
// since distances stretch further out (and there are no roads there anyway).
const NEAR_ROADS_M = 200_000;
// A frame of its own moves when what's edited is this far from it.
const RECENTRE_M = 20_000;

let anchorOf: { line: string; point: LonLat } | null = null;

// What's edited: the route's start, the first click of a new one, or the area.
function anchor(): LonLat {
  const edit = useTrackEdit.getState();
  const line = trackById(edit.trackId)?.lines[0];
  if (line) {
    if (anchorOf?.line !== line) anchorOf = { line, point: decodePolyline(line)[0] ?? useApp.getState().area.center };
    return anchorOf.point;
  }
  return edit.draft ?? useApp.getState().area.center;
}

/** The space edits are worked out in: the roads', or one around what's edited when it's far from them or they aren't loaded. */
export function editSpace(): EditSpace {
  const at = anchor();
  if (network && distanceM(network.space.center, at) < NEAR_ROADS_M) return network.space;
  if (!lastSpace || distanceM(lastSpace.center, at) > RECENTRE_M) lastSpace = spaceAt(at);
  return lastSpace;
}

/** The roads to follow, in the edit space, or null while there are none. */
export function roadGraph(): RoadGraph | null {
  return network && editSpace() === network.space ? network.graph : null;
}

/** Whether a point is where roads were loaded, for saying why a move went straight. */
export function inRoads([lon, lat]: LonLat): boolean {
  const b = network?.bounds;
  return Boolean(b && lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north);
}

function scheduleRoads(): void {
  clearTimeout(roadsTimer);
  // The area can change a lot in a row while it's typed in.
  roadsTimer = setTimeout(loadRoads, 700);
}

/** Loads the roads around the area, unless they're loaded or on the way. */
export function loadRoads(): void {
  const { area } = useApp.getState();
  if (Math.max(area.widthM, area.heightM) > MAX_ROAD_SIDE_M) {
    loading = null;
    useTrackEdit.setState({ roads: { status: 'failed', message: `Roads are only loaded for areas up to ${MAX_ROAD_SIDE_M / 1000} km across.` } });
    return;
  }
  const bounds = areaGeoBounds(area, ROAD_MARGIN_M);
  const center = area.center;
  const key = JSON.stringify([bounds, center]);
  if (network?.key === key || loading === key) return;
  loading = key;
  useTrackEdit.setState({ roads: { status: 'loading' } });
  getEngine()
    .roads({ bounds, center })
    .then(
      (result) => {
        if (loading !== key) return;
        loading = null;
        const graph = new RoadGraph(result.graph);
        if (!graph.nodes) {
          useTrackEdit.setState({ roads: { status: 'none' } });
          return;
        }
        network = { key, space: spaceAt(center), graph, bounds };
        useTrackEdit.setState((s) => ({ roads: { status: 'ready' }, network: s.network + 1 }));
      },
      (error: Error) => {
        if (loading !== key) return;
        loading = null;
        useTrackEdit.setState({ roads: { status: 'failed', message: error.message } });
      },
    );
}

/** For tests: roads given directly, in metres around `center`. */
export function setRoadsForTest(lines: Vec2[][] | null, center: LonLat = useApp.getState().area.center): void {
  network = lines ? { key: 'test', space: spaceAt(center), graph: graphOf(lines), bounds: { west: -180, south: -90, east: 180, north: 90 } } : null;
  useTrackEdit.setState((s) => ({ roads: { status: lines ? 'ready' : 'idle' }, network: s.network + 1 }));
}

/** Where a point moved onto the roads lands: the nearest road within the snap distance, or null. */
export function roadSpot(p: Vec2): Vec2 | null {
  const graph = roadGraph();
  if (!graph) return null;
  const spot = nearestRoad(graph, p[0], p[1], useApp.getState().ui.routeSnapM);
  return spot ? [spot.x, spot.y] : null;
}

/** Along the roads from a to b, or straight when either is off the roads or they don't join up. */
export function connect(a: Vec2, b: Vec2, graph: RoadGraph | null): Vec2[] {
  if (!graph) return [a, b];
  // The ends are joined along a road when they're within snapping distance of one.
  const reach = useApp.getState().ui.routeSnapM;
  const from = nearestRoad(graph, a[0], a[1], reach);
  const to = nearestRoad(graph, b[0], b[1], reach);
  if (!from || !to) return [a, b];
  const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // A detour much longer than the gap is a wrong turn more often than not,
  // like a point nudged onto the next street over. Straight is the better guess.
  const way = routeBetween(graph, from, to, straight * 3 + 80);
  if (!way) return [a, b];
  const out = [a, ...way, b];
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-6);
}

// ------------------------------------------------------------ edits

/** New points for one line from `from` to `to`, both included, in the edit space. */
export interface SpanEdit {
  line: number;
  from: number;
  to: number;
  points: Vec2[];
  /** Where the selection goes afterwards. */
  focus: Vec2 | null;
}

/** How the stretches either side of a moved point are redrawn: along the roads, straight, or bent along (null). */
export type Rejoin = RoadGraph | 'straight' | null;

/** The point at `index` moved to `to`, with the handles before and after it staying put and the stretches between joined up as `how` says. */
export function moveEdit(path: readonly Vec2[], line: number, before: number, index: number, after: number, to: Vec2, how: Rejoin): SpanEdit {
  if (!how) return { line, from: before, to: after, points: warpSpan(path, before, index, after, to), focus: to };
  const graph = how === 'straight' ? null : how;
  const left = before === index ? [to] : connect(path[before], to, graph);
  const right = after === index ? [] : connect(to, path[after], graph).slice(1);
  return { line, from: before, to: after, points: [...left, ...right], focus: to };
}

/** A new point put on the line at segment + t, then moved to `to`. */
export function insertEdit(path: readonly Vec2[], line: number, segment: number, t: number, before: number, after: number, to: Vec2, how: Rejoin): SpanEdit {
  const a = path[segment];
  const b = path[segment + 1];
  const on: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const longer = [...path.slice(0, segment + 1), on, ...path.slice(segment + 1)];
  const edit = moveEdit(longer, line, before, segment + 1, after + 1, to, how);
  // In terms of the line as it was, before the new point went in.
  return { ...edit, to: after };
}

/** The point at `index` taken out, with the handles either side joined up. */
export function removeEdit(path: readonly Vec2[], line: number, before: number, index: number, after: number, graph: RoadGraph | null): SpanEdit {
  if (before === index) return { line, from: index, to: after, points: [path[after]], focus: path[after] };
  if (after === index) return { line, from: before, to: index, points: [path[before]], focus: path[before] };
  return { line, from: before, to: after, points: connect(path[before], path[after], graph), focus: path[after] };
}

// The route as the editor first saw it this session, for putting it back.
const originals = new Map<string, string[]>();

const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

export function isChanged(track: Track): boolean {
  const original = originals.get(track.id);
  return Boolean(original && !sameLines(original, track.lines));
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Lines as stored: rounded as encoding rounds them, without repeated points,
 * and without lines left too short to draw. Over the point limit the whole
 * route is simplified as an import would be.
 */
export function storedLines(lines: readonly LonLat[][]): string[] {
  const kept: LonLat[][] = [];
  let points = 0;
  for (const line of lines) {
    const out: LonLat[] = [];
    for (const [lon, lat] of line) {
      const p: LonLat = [round(lon), round(lat)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    if (out.length >= 2) {
      kept.push(out);
      points += out.length;
    }
  }
  return points > MAX_TRACK_POINTS ? encodeTrack(kept) : kept.map(encodePolyline);
}

/** The point of a route nearest a lon/lat, for keeping the selection after an edit. */
function pointNear(lines: readonly LonLat[][], target: LonLat): TrackPoint | null {
  let best: TrackPoint | null = null;
  let bestD = Infinity;
  const k = Math.cos((target[1] * Math.PI) / 180);
  lines.forEach((points, line) => {
    points.forEach(([lon, lat], index) => {
      const d = ((lon - target[0]) * k) ** 2 + (lat - target[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { line, index };
      }
    });
  });
  return best;
}

function replaceTrack(id: string, lines: string[]): void {
  setTracks(useApp.getState().tracks.map((track) => (track.id === id ? { ...track, lines } : track)));
}

/**
 * Stores new lines for a route as one undo step and keeps hold of what was
 * selected. A route left with nothing is removed. Without a label, steps
 * like arrow key nudges in a row undo together.
 */
export function commitLines(track: Track, lines: LonLat[][], label: string | null, focus: LonLat | null, done?: string): void {
  if (!originals.has(track.id)) originals.set(track.id, track.lines);
  const stored = storedLines(lines);
  if (!stored.length) {
    const step = asChange(label ?? 'Remove route', () => setTracks(useApp.getState().tracks.filter((item) => item.id !== track.id)));
    useTrackEdit.setState({ trackId: null, tool: 'draw', ...CLEARED });
    say(`Removed ${track.name}, since nothing was left of it.`, step ? { label: 'Undo', run: () => undoChange(step) } : undefined);
    return;
  }
  if (sameLines(stored, track.lines)) return;
  if (label) asChange(label, () => replaceTrack(track.id, stored));
  else replaceTrack(track.id, stored);
  const decoded = decodeTrack({ lines: stored });
  useTrackEdit.setState({ selected: focus ? pointNear(decoded, focus) : null, section: null, sectionFrom: null });
  if (done) say(done);
}

/** Applies a span worked out in the edit space. */
export function applySpan(track: Track, edit: SpanEdit, label: string | null, done?: string, space = editSpace()): void {
  const lines = decodeTrack(track);
  if (!lines[edit.line]) return;
  const next = replaceSpan(lines, edit.line, edit.from, edit.to, edit.points.map(space.toLonLat));
  commitLines(track, next, label, edit.focus ? space.toLonLat(edit.focus) : null, done);
}

/** Moves a section, or the whole route, onto the roads it runs along, the way the model snaps routes. */
export function snapTrack(track: Track, section: TrackSection | null): void {
  const net = network;
  if (!net) return;
  const lines = decodeTrack(track);
  const local = (line: readonly LonLat[]) => line.map(net.space.toLocal);
  const snap = (line: readonly LonLat[]) => snapOnGraph([local(line)], net.graph, { unitsPerMetre: 1 }).lines[0]?.map(net.space.toLonLat) ?? [...line];
  let next: LonLat[][];
  if (section) {
    const part = lines[section.line]?.slice(section.from, section.to + 1);
    if (!part || part.length < 2) return;
    const snapped = snap(part);
    // The section's ends stay where they were, so it still meets the rest.
    next = replaceSpan(lines, section.line, section.from, section.to, [part[0], ...snapped.slice(1, -1), part[part.length - 1]]);
  } else {
    next = lines.map(snap);
  }
  const before = trackLengthM(lines);
  const after = trackLengthM(next);
  if (sameLines(storedLines(next), track.lines)) {
    say('It already runs along the roads, so nothing changed.');
    return;
  }
  commitLines(track, next, section ? 'Snap route section to roads' : 'Snap route to roads', null, `Snapped to the roads. ${formatDistance(before)} is now ${formatDistance(after)}.`);
}

export function straightenSection(track: Track, section: TrackSection): void {
  const lines = decodeTrack(track);
  const points = lines[section.line];
  if (!points) return;
  commitLines(track, replaceSpan(lines, section.line, section.from, section.to, [points[section.from], points[section.to]]), 'Straighten route section', points[section.to], 'Straightened the section.');
}

export function cutSection(track: Track, section: TrackSection): void {
  const lines = decodeTrack(track);
  const points = lines[section.line];
  if (!points) return;
  const atEnd = section.from === 0 || section.to === points.length - 1;
  commitLines(track, cutSpan(lines, section.line, section.from, section.to), 'Cut out route section', null, atEnd ? 'Trimmed the route.' : 'Cut the section out, leaving a gap.');
}

export function trimTrack(track: Track, metres: number, end: 'start' | 'finish'): void {
  const lines = decodeTrack(track);
  const total = trackLengthM(lines);
  if (metres >= total) {
    say(`The route is only ${formatDistance(total)} long.`);
    return;
  }
  commitLines(track, trimLines(lines, metres, end), end === 'start' ? 'Trim route start' : 'Trim route finish', null, `Took ${formatDistance(metres)} off the ${end}.`);
}

export function reverseTrack(track: Track): void {
  commitLines(track, reverseLines(decodeTrack(track)), 'Reverse route', null, 'Reversed. The start and finish swapped.');
}

/** Joins the finish back to the start, along the roads when following them. */
export function backToStart(track: Track, graph: RoadGraph | null): void {
  const space = editSpace();
  const lines = decodeTrack(track);
  if (!lines.length) return;
  const last = lines[lines.length - 1];
  const start = space.toLocal(lines[0][0]);
  const end = space.toLocal(last[last.length - 1]);
  if (Math.hypot(start[0] - end[0], start[1] - end[1]) < 1) {
    say('It already finishes where it starts.');
    return;
  }
  // The start's own point closes the loop exactly, whatever rounding did to the way back.
  const way = [...connect(end, start, graph).slice(0, -1).map(space.toLonLat), lines[0][0]];
  commitLines(track, replaceSpan(lines, lines.length - 1, last.length - 1, last.length - 1, [last[last.length - 1], ...way.slice(1)]), 'Route back to start', null, 'Joined the finish back to the start.');
}

/** Puts the route back the way it was when the editor first saw it. */
export function revertTrack(track: Track): void {
  const original = originals.get(track.id);
  if (!original) return;
  asChange('Undo route edits', () => replaceTrack(track.id, original));
  useTrackEdit.setState({ ...CLEARED });
  say('Put the route back the way it was.');
}

function drawnName(): string {
  const names = new Set(useApp.getState().tracks.map((track) => track.name));
  if (!names.has('Drawn route')) return 'Drawn route';
  let n = 2;
  while (names.has(`Drawn route ${n}`)) n++;
  return `Drawn route ${n}`;
}

/**
 * A click with the draw tool. It carries the route on from its finish, or
 * from its start when the first point is selected. Without a route the
 * first click starts one and the second makes its first stretch.
 */
export function drawTo(to: Vec2, graph: RoadGraph | null, space = editSpace()): void {
  const ui = useTrackEdit.getState();
  const track = trackById(ui.trackId);
  if (!track) {
    if (!ui.draft) {
      useTrackEdit.setState({ draft: space.toLonLat(to) });
      return;
    }
    if (useApp.getState().tracks.length >= MAX_TRACKS) {
      say(`There can be up to ${MAX_TRACKS} routes. Remove some first.`);
      return;
    }
    const points = connect(space.toLocal(ui.draft), to, graph).map(space.toLonLat);
    const lines = storedLines([points]);
    if (!lines.length) return;
    const id = newTrackId();
    const name = drawnName();
    asChange('Draw route', () => setTracks([...useApp.getState().tracks, { id, name, visible: true, lines }]));
    originals.set(id, lines);
    useTrackEdit.setState({ trackId: id, draft: null, selected: pointNear(decodeTrack({ lines }), points[points.length - 1]), section: null });
    return;
  }
  const lines = decodeTrack(track);
  const selected = ui.selected && lines[ui.selected.line] ? ui.selected : null;
  const atStart = selected?.index === 0;
  const line = atStart ? selected!.line : selected && selected.index === lines[selected.line].length - 1 ? selected.line : lines.length - 1;
  const points = lines[line];
  if (!points) return;
  if (atStart) {
    const way = connect(to, space.toLocal(points[0]), graph).map(space.toLonLat);
    commitLines(track, replaceSpan(lines, line, 0, 0, [...way.slice(0, -1), points[0]]), 'Draw route', way[0]);
  } else {
    const end = points.length - 1;
    const way = connect(space.toLocal(points[end]), to, graph).map(space.toLonLat);
    commitLines(track, replaceSpan(lines, line, end, end, [points[end], ...way.slice(1)]), 'Draw route', way[way.length - 1]);
  }
}

/** Where a click with the draw tool carries on from, in the edit space, or null for the first click of a new route. */
export function drawFrom(space = editSpace()): Vec2 | null {
  const ui = useTrackEdit.getState();
  const track = trackById(ui.trackId);
  if (!track) return ui.draft ? space.toLocal(ui.draft) : null;
  const lines = decodeTrack(track);
  const selected = ui.selected && lines[ui.selected.line] ? ui.selected : null;
  if (selected?.index === 0) return space.toLocal(lines[selected.line][0]);
  const line = selected && selected.index === lines[selected.line].length - 1 ? lines[selected.line] : lines[lines.length - 1];
  return line ? space.toLocal(line[line.length - 1]) : null;
}

/** Points in a route's stored lines, for the point limit. */
export function storedPoints(track: Track): number {
  let points = 0;
  for (const line of track.lines) points += decodePolyline(line).length;
  return points;
}
