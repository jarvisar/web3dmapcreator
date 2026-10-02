// Imported routes: reading files, showing and hiding them, and framing the
// area around them. Files are read on the main thread, which takes well under
// a second even for a long ride.

import { areaAroundTracks, shareOutside } from '../../core/tracks/frame';
import { MAX_FILE_BYTES, readTrackFile, TOO_BIG, TrackFileError } from '../../core/tracks/parse';
import { decodeTrack, encodeTrack, MAX_TRACK_POINTS, MAX_TRACKS, newTrackId, tidyTrackName, trackEnds, trackPoints, type Track } from '../../core/tracks/track';
import type { LonLat } from '../../core/types';
import { formatMmPair } from '../lib/format';
import { bedFit, bedFitMm } from './derived';
import { patchSettings, setArea, setTracks, toast, useApp, type Toast } from './store';
import { asChange, undoChange, type SetupStep } from './undo';

/** Share of a new route that can be off the area before importing it moves the area. */
const MOVE_WHEN_OUTSIDE = 0.5;

export interface ImportResult {
  added: string[];
  errors: string[];
}

function lines(tracks: readonly Track[]): LonLat[][] {
  return tracks.flatMap((track) => decodeTrack(track));
}

/**
 * What to say after the area moved to the routes, and the toast's button. A
 * long route at a fixed scale can make a model a metre across, so that says
 * so and offers to scale it to the bed instead, keeping the area.
 */
function moved(text: string, step: SetupStep | null): [string, Toast['action'] | undefined] {
  const { area, settings, exportSettings, output } = useApp.getState();
  const fit = bedFit(area, settings, exportSettings);
  const undo = step ? { label: 'Undo', run: () => undoChange(step) } : undefined;
  if (output !== 'model' || fit.fits || settings.scale.mode !== 'fixed') return [text, undo];
  const longest = bedFitMm(area, settings, fit.printer);
  return [
    `${text} At this scale the model is ${formatMmPair(fit.width, fit.depth)}, bigger than the bed.`,
    { label: 'Scale to the bed', run: () => asChange('Scale to the bed', () => patchSettings('scale', { mode: 'fit', fitMm: longest })) },
  ];
}

/**
 * Adds every route in the files, each as its own. When most of the new
 * routes are off the area, the area moves to frame them, in the same undo
 * step. Problems with a file come back in `errors`, worded for a toast.
 */
export async function importTrackFiles(files: Iterable<File>): Promise<ImportResult> {
  const added: Track[] = [];
  const errors: string[] = [];
  const room = () => MAX_TRACKS - useApp.getState().tracks.length - added.length;
  for (const file of files) {
    if (room() <= 0) {
      errors.push(`${file.name}: there can be up to ${MAX_TRACKS} routes. Remove some first.`);
      continue;
    }
    // Checked before reading it all into memory.
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name}: ${TOO_BIG}`);
      continue;
    }
    try {
      const { tracks: parsed, skipped } = readTrackFile(file.name, await file.arrayBuffer());
      const space = room();
      for (const track of parsed.slice(0, space)) {
        const lines = encodeTrack(track.lines);
        // Saved state drops a route over the limit, so it isn't taken now
        // only to be gone after a reload.
        if (trackPoints(lines) > MAX_TRACK_POINTS) {
          errors.push(`${file.name}: ${track.name} is in ${track.lines.length.toLocaleString()} separate pieces, more than a route can hold.`);
          continue;
        }
        added.push({ id: newTrackId(), name: track.name, visible: true, lines });
      }
      for (const text of skipped) errors.push(`${file.name}: ${text}`);
      if (parsed.length > space) errors.push(`${file.name}: there can be up to ${MAX_TRACKS} routes, so some in it were left out.`);
    } catch (error) {
      if (!(error instanceof TrackFileError)) console.error(error);
      errors.push(`${file.name}: ${error instanceof TrackFileError ? error.message : "it couldn't be read."}`);
    }
  }
  if (!added.length) return { added: [], errors };
  const state = useApp.getState();
  const fresh = lines(added);
  const area = shareOutside(fresh, state.area) > MOVE_WHEN_OUTSIDE ? areaAroundTracks(fresh, state.area) : null;
  const step = asChange(added.length === 1 ? 'Add route' : 'Add routes', () => {
    setTracks([...useApp.getState().tracks, ...added]);
    if (area) setArea(area, { focus: 'always', placeName: added.length === 1 ? added[0].name : '' });
  });
  const named = added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} routes`;
  const [text, action] = area ? moved(`${named}. The area moved to fit ${added.length === 1 ? 'it' : 'them'}.`, step) : [`${named}.`, step ? { label: 'Undo', run: () => undoChange(step) } : undefined];
  toast(text, 'success', action);
  return { added: added.map((track) => track.name), errors };
}

export function removeTrack(id: string): void {
  const track = useApp.getState().tracks.find((item) => item.id === id);
  if (!track) return;
  const step = asChange('Remove route', () => setTracks(useApp.getState().tracks.filter((item) => item.id !== id)));
  toast(`Removed ${track.name}.`, 'info', step ? { label: 'Undo', run: () => undoChange(step) } : undefined);
}

export function setTrackVisible(id: string, visible: boolean): void {
  setTracks(useApp.getState().tracks.map((track) => (track.id === id ? { ...track, visible } : track)));
}

export function renameTrack(id: string, name: string): void {
  const clean = tidyTrackName(name);
  if (!clean) return;
  setTracks(useApp.getState().tracks.map((track) => (track.id === id && track.name !== clean ? { ...track, name: clean } : track)));
}

/** Frames the area around the shown routes, turned too with `turn` when that frames them smaller. */
export function fitAreaToTracks(turn: boolean): boolean {
  const state = useApp.getState();
  const shown = lines(state.tracks.filter((track) => track.visible));
  const area = areaAroundTracks(shown, state.area, turn);
  if (!area) return false;
  const step = asChange(turn ? 'Fit and turn area to routes' : 'Fit area to routes', () => setArea(area, { focus: 'always' }));
  const [text, action] = moved('The area fits the routes.', step);
  toast(text, 'info', action);
  return true;
}

/** The shown routes for the map: lines, and start and finish points for the dots. */
export function tracksGeoJson(tracks: readonly Track[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const track of tracks) {
    if (!track.visible) continue;
    const decoded = decodeTrack(track);
    const ends = trackEnds(decoded);
    if (!ends) continue;
    features.push({ type: 'Feature', properties: { id: track.id }, geometry: { type: 'MultiLineString', coordinates: decoded } });
    features.push(
      { type: 'Feature', properties: { end: 'start' }, geometry: { type: 'Point', coordinates: ends.start } },
      { type: 'Feature', properties: { end: 'finish' }, geometry: { type: 'Point', coordinates: ends.finish } },
    );
  }
  return { type: 'FeatureCollection', features };
}
