import { beforeEach, describe, expect, it } from 'vitest';
import { encodePolyline } from '../../core/tracks/polyline';
import { decodeTrack, trackLengthM, type Track } from '../../core/tracks/track';
import type { LonLat, Vec2 } from '../../core/types';
import { setTracks, useApp } from './store';
import {
  applySpan,
  backToStart,
  commitLines,
  connect,
  cutSection,
  drawTo,
  drawTrack,
  editSpace,
  editTrack,
  insertEdit,
  moveEdit,
  removeEdit,
  reverseTrack,
  revertTrack,
  roadGraph,
  selectPoint,
  setRoadsForTest,
  snapTrack,
  stopEditing,
  storedLines,
  straightenSection,
  trimTrack,
  useTrackEdit,
} from './trackEdit';
import { quietly, redoChange, startUndo, undoChange, useUndo } from './undo';

const initial = useApp.getState();
const center = initial.area.center;

let nextId = 0;
const current = () => useApp.getState().tracks[0];

// Points in metres around the area's centre, as lon/lat.
const at = (x: number, y: number): LonLat => editSpace().toLonLat([x, y]);

function seed(points: Vec2[] = [[0, 0], [150, 80], [300, 0], [450, 80], [600, 0]]): Track {
  const track: Track = { id: `t${nextId++}`, name: 'Run', visible: true, lines: [encodePolyline(points.map(([x, y]) => at(x, y)))] };
  quietly(() => setTracks([track]));
  editTrack(track.id);
  return track;
}

const local = (track: Track) => decodeTrack(track).map((line) => line.map(editSpace().toLocal));

// Streets 100 m apart around the centre, with a vertex at every junction.
function grid(blocks = 8, size = 100): Vec2[][] {
  const lines: Vec2[][] = [];
  const o = -(blocks * size) / 2;
  for (let i = 0; i <= blocks; i++) {
    lines.push(Array.from({ length: blocks + 1 }, (_, j): Vec2 => [o + i * size, o + j * size]));
    lines.push(Array.from({ length: blocks + 1 }, (_, j): Vec2 => [o + j * size, o + i * size]));
  }
  return lines;
}

beforeEach(() => {
  useApp.setState(initial, true);
  startUndo();
  useUndo.setState({ past: [], future: [] });
  setRoadsForTest(null);
  stopEditing();
});

describe('editing a route', () => {
  it('moves and inserts points, one undo step each', () => {
    const track = seed();
    const path = local(track)[0];
    applySpan(track, moveEdit(path, 0, 1, 2, 3, [300, -50], null), 'Move route point');
    expect(useUndo.getState().past).toHaveLength(1);
    const moved = current().lines;
    expect(moved).not.toEqual(track.lines);
    expect(undoChange()).toBe(true);
    expect(current().lines).toEqual(track.lines);
    expect(redoChange()).toBe(true);
    expect(current().lines).toEqual(moved);
    applySpan(current(), insertEdit(local(current())[0], 0, 1, 0.5, 1, 2, [230, 100], null), 'Add route point');
    expect(decodeTrack(current())[0]).toHaveLength(6);
    expect(useUndo.getState().past).toHaveLength(2);
  });

  it('only changes the points an edit replaced', () => {
    const track = seed();
    applySpan(track, moveEdit(local(track)[0], 0, 1, 2, 3, [300, -50], 'straight'), 'Move route point');
    const before = decodeTrack(track)[0];
    const after = decodeTrack(current())[0];
    expect(after[0]).toEqual(before[0]);
    expect(after[4]).toEqual(before[4]);
  });

  it('keeps the selection on the moved point', () => {
    const track = seed();
    applySpan(track, moveEdit(local(track)[0], 0, 1, 2, 3, [300, -50], null), 'Move route point');
    expect(useTrackEdit.getState().selected).toEqual({ line: 0, index: 2 });
  });

  it('removes a point and joins its neighbours', () => {
    const track = seed();
    applySpan(track, removeEdit(local(track)[0], 0, 1, 2, 3, null), 'Delete route point');
    expect(decodeTrack(current())[0]).toHaveLength(4);
  });

  it('cuts a section into separate lines, and undo puts it back', () => {
    const track = seed();
    cutSection(track, { line: 0, from: 1, to: 3 });
    expect(decodeTrack(current()).map((line) => line.length)).toEqual([2, 2]);
    expect(undoChange()).toBe(true);
    expect(current().lines).toEqual(track.lines);
  });

  it('straightens a section, reverses and closes the route', () => {
    const track = seed();
    straightenSection(track, { line: 0, from: 0, to: 4 });
    expect(decodeTrack(current())[0]).toHaveLength(2);
    const line = decodeTrack(current())[0];
    reverseTrack(current());
    expect(decodeTrack(current())[0]).toEqual([...line].reverse());
    backToStart(current(), null);
    const closed = decodeTrack(current())[0];
    expect(closed[0]).toEqual(closed[closed.length - 1]);
    revertTrack(current());
    expect(current().lines).toEqual(track.lines);
    undoChange();
    expect(current().lines).not.toEqual(track.lines);
  });

  it('trims the distance asked for, and not more than the route', () => {
    seed();
    const length = trackLengthM(decodeTrack(current()));
    trimTrack(current(), 200, 'start');
    expect(trackLengthM(decodeTrack(current()))).toBeCloseTo(length - 200, 0);
    const trimmed = current();
    trimTrack(trimmed, length, 'finish');
    expect(current().lines).toEqual(trimmed.lines);
  });

  it('removes a route with nothing left, and undo brings it back', () => {
    const track = seed();
    cutSection(track, { line: 0, from: 0, to: 4 });
    expect(useApp.getState().tracks).toHaveLength(0);
    expect(useTrackEdit.getState()).toMatchObject({ trackId: null, tool: 'draw' });
    undoChange();
    expect(current().lines).toEqual(track.lines);
  });

  it('removes lines an edit collapsed onto one spot', () => {
    const track = seed();
    const p = at(0, 0);
    commitLines(track, [[p, p]], 'Move route point', p);
    expect(useApp.getState().tracks).toHaveLength(0);
  });

  it('lets go of the route when undo takes it away', () => {
    drawTrack();
    drawTo([0, 0], null);
    drawTo([100, 0], null);
    expect(useTrackEdit.getState().trackId).toBe(current().id);
    undoChange();
    expect(useApp.getState().tracks).toHaveLength(0);
    expect(useTrackEdit.getState()).toMatchObject({ trackId: null, tool: 'draw' });
  });
});

describe('a route far from the area', () => {
  it('gets a frame of its own, so a moved point lands where it was put', () => {
    setRoadsForTest(grid(), center);
    // In Boston, about 1,400 km from the Loop.
    const boston: LonLat[] = [
      [-71.06, 42.36],
      [-71.05, 42.361],
      [-71.04, 42.36],
    ];
    const track: Track = { id: 'far', name: 'Boston', visible: true, lines: [encodePolyline(boston)] };
    quietly(() => setTracks([track]));
    editTrack(track.id);
    expect(roadGraph()).toBeNull();
    const space = editSpace();
    const to = space.toLocal([-71.05, 42.365]);
    applySpan(track, moveEdit(decodeTrack(track)[0].map(space.toLocal), 0, 0, 1, 2, to, null), 'Move route point');
    const [lon, lat] = decodeTrack(current())[0][1];
    expect(lon).toBeCloseTo(-71.05, 5);
    expect(lat).toBeCloseTo(42.365, 5);
  });
});

describe('drawing', () => {
  it('starts a route on the second click and carries on from the finish', () => {
    drawTrack();
    drawTo([0, 0], null);
    expect(useApp.getState().tracks).toHaveLength(0);
    drawTo([100, 0], null);
    expect(decodeTrack(current())[0]).toHaveLength(2);
    expect(current().name).toBe('Drawn route');
    drawTo([100, 100], null);
    expect(decodeTrack(current())[0]).toHaveLength(3);
    expect(useUndo.getState().past).toHaveLength(2);
  });

  it('adds to the start when the first point is selected', () => {
    drawTrack();
    drawTo([0, 0], null);
    drawTo([100, 0], null);
    selectPoint({ line: 0, index: 0 });
    drawTo([0, 100], null);
    const line = decodeTrack(current())[0];
    expect(line).toHaveLength(3);
    expect(useTrackEdit.getState().selected).toEqual({ line: 0, index: 0 });
    const [x, y] = editSpace().toLocal(line[0]);
    expect(x).toBeCloseTo(0, 1);
    expect(y).toBeCloseTo(100, 1);
  });

  it("doesn't add a route when the second click repeats the first", () => {
    drawTrack();
    drawTo([0, 0], null);
    drawTo([0, 0], null);
    expect(useApp.getState().tracks).toHaveLength(0);
    expect(useTrackEdit.getState().draft).not.toBeNull();
    expect(useUndo.getState().past).toHaveLength(0);
  });

  it('names new routes apart', () => {
    drawTrack();
    drawTo([0, 0], null);
    drawTo([100, 0], null);
    drawTrack();
    drawTo([0, 50], null);
    drawTo([100, 50], null);
    expect(useApp.getState().tracks.map((track) => track.name)).toEqual(['Drawn route', 'Drawn route 2']);
  });
});

describe('following roads', () => {
  it('goes along the streets between points near them', () => {
    setRoadsForTest(grid(), center);
    // From the middle of one block's side to the middle of the next street over.
    const way = connect([-150, 0], [0, 50], roadGraph());
    let length = 0;
    for (let i = 1; i < way.length; i++) length += Math.hypot(way[i][0] - way[i - 1][0], way[i][1] - way[i - 1][1]);
    expect(length).toBeCloseTo(200, 0);
  });

  it('goes straight between points away from the roads', () => {
    setRoadsForTest(grid(2, 100), center);
    expect(connect([1000, 1000], [1100, 1000], roadGraph())).toEqual([
      [1000, 1000],
      [1100, 1000],
    ]);
  });

  it('draws along the roads', () => {
    setRoadsForTest(grid(), center);
    drawTrack();
    drawTo([-200, 0], roadGraph());
    drawTo([0, 100], roadGraph());
    expect(trackLengthM(decodeTrack(current()))).toBeCloseTo(300, 0);
  });

  it('snaps a wobbly route onto the street it ran along', () => {
    setRoadsForTest(grid(), center);
    const wobbly: Vec2[] = Array.from({ length: 31 }, (_, i) => [-300 + i * 20, i % 2 ? 6 : -6]);
    const track = seed(wobbly);
    snapTrack(track, null);
    for (const [, y] of local(current())[0]) expect(Math.abs(y)).toBeLessThan(0.5);
    expect(useUndo.getState().past).toHaveLength(1);
  });
});

describe('storedLines', () => {
  it('drops repeated points and lines too short to draw', () => {
    const a = at(0, 0);
    const b = at(50, 0);
    expect(decodeTrack({ lines: storedLines([[a, a, b], [b, b]]) })).toHaveLength(1);
    expect(decodeTrack({ lines: storedLines([[a, a, b]]) })[0]).toHaveLength(2);
  });
});
