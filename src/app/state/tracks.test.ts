import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits } from '../../core/edit/types';
import { DEFAULT_AREA, DEFAULT_EXPORT, DEFAULT_PALETTE, cloneSettings } from '../../core/settings';
import { encodePolyline } from '../../core/tracks/polyline';
import { decodeTrack, type Track } from '../../core/tracks/track';
import type { LonLat } from '../../core/types';
import { defaultSvgSettings } from '../svgmap/settings';
import { bedFit } from './derived';
import { tracksForArea } from './linkScope';
import { decodeOptions, encodeOptions } from './options';
import { clearSavedState, loadSaved, readBackup, saveState, TRACKS_KEY } from './persist';
import { MAX_LINK_EXTRA, packTracks, parseHash, shareUrl } from './shareLink';
import { bringIn, modelKey, setTracks, useApp, type ResultMeta } from './store';
import { fitAreaToTracks, importTrackFiles, removeTrack, renameTrack, setTrackVisible } from './tracks';
import { startUndo, undoChange } from './undo';

const initial = useApp.getState();

beforeEach(() => {
  useApp.setState(initial, true);
  startUndo();
});
afterEach(() => vi.unstubAllGlobals());

const [lon0, lat0] = DEFAULT_AREA.center;
const M = 1 / 111_320;

function gpx(name: string, points: LonLat[]): File {
  const body = points.map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join('');
  return new File([`<gpx><trk><name>${name}</name><trkseg>${body}</trkseg></trk></gpx>`], `${name}.gpx`);
}

/** A run of `km` going east from a point. */
function eastward(from: LonLat, km: number): LonLat[] {
  const step = 50 * M;
  return Array.from({ length: Math.round((km * 1000) / 50) + 1 }, (_, i): LonLat => [from[0] + (i * step) / Math.cos((from[1] * Math.PI) / 180), from[1] + (i % 2) * 2 * M]);
}

const track = (id: string, points: LonLat[], visible = true): Track => ({ id, name: id, visible, lines: [encodePolyline(points)] });

describe('importing routes', () => {
  it('adds one per file, and leaves the area alone when they are on it', async () => {
    const result = await importTrackFiles([gpx('Lunch Run', eastward([lon0 - 0.005, lat0], 0.6)), gpx('Ride', eastward([lon0, lat0 + 0.003], 0.4))]);
    expect(result).toEqual({ added: ['Lunch Run', 'Ride'], errors: [] });
    const { tracks, area } = useApp.getState();
    expect(tracks.map((t) => t.name)).toEqual(['Lunch Run', 'Ride']);
    expect(tracks.every((t) => t.visible && t.id)).toBe(true);
    expect(area).toBe(initial.area);
  });

  it('moves the area to a route somewhere else, and undoes both together', async () => {
    const far: LonLat = [lon0 + 0.5, lat0 + 0.3];
    await importTrackFiles([gpx('Elsewhere', eastward(far, 3))]);
    const { area, placeName } = useApp.getState();
    expect(area).not.toBe(initial.area);
    expect(area.widthM).toBeGreaterThan(3000);
    expect(placeName).toBe('Elsewhere');
    expect(undoChange()).toBe(true);
    expect(useApp.getState().tracks).toEqual([]);
    expect(useApp.getState().area).toEqual(initial.area);
  });

  it('offers to scale a long route to the bed instead of printing it a metre across', async () => {
    // A 20 km ride at the default fixed scale would be 1.4 m long.
    await importTrackFiles([gpx('Century', eastward([lon0 + 1, lat0], 20))]);
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.text).toMatch(/bigger than the bed/);
    expect(toast.action?.label).toBe('Scale to the bed');
    const area = useApp.getState().area;
    toast.action!.run();
    const state = useApp.getState();
    expect(state.settings.scale.mode).toBe('fit');
    expect(state.area).toBe(area);
    expect(bedFit(state.area, state.settings, state.exportSettings).fits).toBe(true);
  });

  it('explains files it cannot read and keeps the ones it can', async () => {
    const bad = new File(['just some notes'], 'notes.txt');
    const result = await importTrackFiles([bad, gpx('Good', eastward([lon0, lat0], 0.2))]);
    expect(result.added).toEqual(['Good']);
    expect(result.errors).toEqual([expect.stringMatching(/^notes\.txt: This doesn't look like/)]);
  });

  it('shows, hides, renames and removes them', async () => {
    await importTrackFiles([gpx('Run', eastward([lon0, lat0], 0.3))]);
    const id = useApp.getState().tracks[0].id;
    setTrackVisible(id, false);
    expect(useApp.getState().tracks[0].visible).toBe(false);
    renameTrack(id, '  Sunday   long run.gpx ');
    expect(useApp.getState().tracks[0].name).toBe('Sunday long run');
    renameTrack(id, '   ');
    expect(useApp.getState().tracks[0].name).toBe('Sunday long run');
    removeTrack(id);
    expect(useApp.getState().tracks).toEqual([]);
  });

  it('frames the area around the shown routes', () => {
    setTracks([track('a', eastward([lon0 + 0.2, lat0], 4)), track('hidden', eastward([lon0 - 0.5, lat0], 1), false)]);
    expect(fitAreaToTracks(false)).toBe(true);
    const { area } = useApp.getState();
    expect(area.center[0]).toBeGreaterThan(lon0 + 0.2);
    expect(area.widthM).toBeGreaterThan(4000);
    expect(area.widthM).toBeLessThan(5000);
  });
});

describe('routes and the model', () => {
  it('make a model stale when the shown ones change, while the layer is on', () => {
    const tracks = [track('a', eastward([lon0, lat0], 0.5))];
    setTracks(tracks);
    const state = useApp.getState();
    const result = { key: modelKey(state.area, state.settings, state.tracks) } as ResultMeta;
    useApp.setState({ generation: { ...state.generation, result, stale: false } });
    setTrackVisible('a', false);
    expect(useApp.getState().generation.stale).toBe(true);
    setTrackVisible('a', true);
    expect(useApp.getState().generation.stale).toBe(false);
    const off = cloneSettings(state.settings);
    off.tracks.enabled = false;
    // With routes off, which ones are shown doesn't matter.
    expect(modelKey(state.area, off, [])).toBe(modelKey(state.area, off, tracks));
  });
});

describe('routes in links, files and storage', () => {
  it('go in a share link with the model, scoped to the area', () => {
    vi.stubGlobal('location', { href: 'https://citymodel.example/' });
    const here = track('here', eastward([lon0, lat0], 0.5));
    const away = track('away', eastward([lon0 + 2, lat0], 0.5));
    const { tracks: scoped, left } = tracksForArea([here, away], DEFAULT_AREA);
    expect(scoped).toEqual([here]);
    expect(left).toBe(1);
    const { url } = shareUrl(DEFAULT_AREA, 'model', defaultSvgSettings(), emptyEdits(), scoped);
    const shared = parseHash(new URL(url).hash);
    expect(shared.tracks).toEqual([here]);
  });

  it('count as on the area when a line crosses it with no point on it', () => {
    // Two points 20 km either side of the area, the straight line between them through its middle.
    const across = track('across', [
      [lon0 - 0.25, lat0],
      [lon0 + 0.25, lat0 + 0.001],
    ]);
    const past = track('past', [
      [lon0 - 0.25, lat0 + 0.2],
      [lon0 + 0.25, lat0 + 0.2],
    ]);
    const { tracks: scoped, left } = tracksForArea([across, past], DEFAULT_AREA);
    expect(scoped).toEqual([across]);
    expect(left).toBe(1);
  });

  it('come back from our own link without a copy, simplified or not', () => {
    vi.stubGlobal('location', { href: 'https://citymodel.example/' });
    let seed = 5;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    // About 18 km recorded every 3 m, which the link has to simplify.
    const noisy = Array.from({ length: 6000 }, (_, i): LonLat => [lon0 - 0.004 + i * 3 * M * 1.35 + random() * 3 * M, lat0 + Math.sin(i / 80) * 200 * M + random() * 3 * M]);
    const ours = [track('run', noisy)];
    const shared = parseHash(new URL(shareUrl(DEFAULT_AREA, 'model', defaultSvgSettings(), emptyEdits(), ours).url).hash);
    expect(shared.tracks).toHaveLength(1);
    expect(shared.tracks![0].lines).not.toEqual(ours[0].lines);
    expect(bringIn(emptyEdits(), { routes: [], hiddenLines: [] }, { tracks: shared.tracks! }, ours)).toBeNull();
  });

  it('are simplified to fit a link, or left out when they cannot be', () => {
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    // About 6 km recorded every 3 m with a little noise.
    const noisy = Array.from({ length: 2000 }, (_, i): LonLat => [lon0 + i * 3 * M * 1.35 + random() * 1.5 * M, lat0 + Math.sin(i / 80) * 200 * M + random() * 1.5 * M]);
    const packed = packTracks([track('n', noisy)]);
    expect(packed).not.toBeNull();
    expect(packed!.length).toBeLessThanOrEqual(MAX_LINK_EXTRA);
    // Points scattered kilometres apart don't simplify or compress.
    const many = Array.from({ length: 20 }, (_, i) => track(`t${i}`, Array.from({ length: 1500 }, (): LonLat => [lon0 + random() * 0.05, lat0 + random() * 0.05])));
    expect(packTracks(many)).toBeNull();
  });

  it('are added from a link, never in place of ours', () => {
    const ours = [track('mine', eastward([lon0, lat0], 0.5))];
    const theirs = [track('mine', eastward([lon0, lat0 + 0.002], 0.5)), track('new', eastward([lon0, lat0 + 0.004], 0.5))];
    const brought = bringIn(emptyEdits(), { routes: [], hiddenLines: [] }, { tracks: theirs }, ours)!;
    expect(brought.tracks).toBe(2);
    expect(brought.after.tracks).toHaveLength(3);
    expect(brought.after.tracks[0]).toBe(ours[0]);
    expect(bringIn(emptyEdits(), { routes: [], hiddenLines: [] }, { tracks: ours }, ours)).toBeNull();
  });

  it('go in an options file with its area, and come back out of it', () => {
    const state = useApp.getState();
    const tracks = [track('a', eastward([lon0, lat0], 0.5))];
    const text = encodeOptions(state, { area: state.area, placeName: 'Here', fileName: null, tracks });
    const options = decodeOptions(text);
    expect(options.map?.tracks).toEqual(tracks);
    expect(decodeTrack(options.map!.tracks![0])[0]).toHaveLength(11);
  });

  it('are saved under a key of their own, and kept aside by a reset', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    const tracks = [track('a', eastward([lon0, lat0], 0.5))];
    const sample = {
      output: 'model' as const,
      area: DEFAULT_AREA,
      settings: cloneSettings(),
      palette: DEFAULT_PALETTE,
      exportSettings: DEFAULT_EXPORT,
      edits: emptyEdits(),
      tracks,
      svg: defaultSvgSettings(),
      placeName: '',
      fileName: null,
      ui: { sections: {}, basemap: 'light', showBed: false, sizeUnit: 'mm', mapHintDismissed: false, previewLook: 'material' },
    };
    expect(saveState(sample, '#a')).toBe(true);
    expect(JSON.parse(stored.get(TRACKS_KEY)!)).toEqual(tracks);
    expect(loadSaved().tracks).toEqual(tracks);
    clearSavedState();
    expect(stored.has(TRACKS_KEY)).toBe(false);
    expect(readBackup()?.tracks).toEqual(tracks);
  });
});
