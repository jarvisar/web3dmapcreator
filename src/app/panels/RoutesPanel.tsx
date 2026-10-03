import { CircleAlert, Maximize, Pencil, RotateCw, Spline, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { modelFieldRange } from '../../core/settings';
import { effectiveScale } from '../../core/geo/area';
import { shareOutside } from '../../core/tracks/frame';
import { TRACK_ACCEPT } from '../../core/tracks/parse';
import { decodeTrack, MAX_TRACKS, tidyTrackName, trackLengthM, type Track } from '../../core/tracks/track';
import { BackupNote } from '../components/BackupNote';
import { Checkbox } from '../components/Checkbox';
import { CheckField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
import { formatNumber } from '../lib/format';
import { patchSettings, resetSettingsSection, useApp } from '../state/store';
import { drawTrack, editTrack, stopEditing, useTrackEdit } from '../state/trackEdit';
import { fitAreaToTracks, importSampleTrack, importTrackFiles, removeTrack, renameTrack, SAMPLE_TRACKS, setTrackVisible, type ImportResult } from '../state/tracks';
import { Section } from './Section';

const FILE_HINT = 'GPX, KML, KMZ, TCX, FIT or GeoJSON, like an activity or route from Strava, Garmin, Komoot or Google My Maps. You can also drop files on the page.';

function formatKm(metres: number): string {
  return `${formatNumber(metres / 1000, metres < 10_000 ? 2 : 1)} km`;
}

function TrackRow({ track }: { track: Track }) {
  const [name, setName] = useState(track.name);
  useEffect(() => setName(track.name), [track.name]);
  const length = useMemo(() => trackLengthM(decodeTrack(track)), [track]);
  const editing = useTrackEdit((state) => state.editing && state.trackId === track.id);
  const removed = useApp((state) => Boolean(state.edits.objects[`rt:${track.id}`]?.removed));
  return (
    <li className={`route-row${editing ? ' is-editing' : ''}${removed ? ' is-removed' : ''}`} title={removed ? 'Removed from the model in the 3D editor' : undefined}>
      <Checkbox checked={track.visible} onChange={(visible) => setTrackVisible(track.id, visible)} label={`Show ${track.name}`} />
      <input
        className="route-name"
        value={name}
        aria-label="Route name"
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          const clean = tidyTrackName(name);
          if (clean) renameTrack(track.id, clean);
          setName(clean || track.name);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setName(track.name);
        }}
      />
      <span className="route-length">{formatKm(length)}</span>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={`Edit ${track.name} on the map`}
        aria-pressed={editing}
        title={editing ? 'Stop editing' : 'Edit on the map'}
        onClick={() => (editing ? stopEditing() : editTrack(track.id))}
      >
        <Pencil size={13} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${track.name}`} title="Remove" onClick={() => removeTrack(track.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

function RouteOptions() {
  const settings = useApp((state) => state.settings);
  const area = useApp((state) => state.area);
  const s = settings.tracks;
  const scale = effectiveScale(area, settings.scale);
  const lidarOnly = settings.modelSource === 'lidar';
  return (
    <>
      <CheckField
        label="Add routes to the model"
        checked={s.enabled}
        onChange={(enabled) => patchSettings('tracks', { enabled })}
        help="Routes are a part of their own in the route colour. Turn this off to keep them on the map without building them."
      />
      {s.enabled && (
        <>
          <NumberField
            label="Width"
            value={s.widthMm}
            onChange={(widthMm) => patchSettings('tracks', { widthMm })}
            {...modelFieldRange('tracks', 'widthMm')}
            step={0.05}
            decimals={2}
            unit="mm"
            help="Printed width of the route. 0.6 mm is a little wider than most printed roads."
            hint={scale > 0 ? `${formatNumber(s.widthMm / scale, 1)} m real at this scale` : undefined}
          />
          <NumberField
            label="Height"
            value={s.heightMm}
            onChange={(heightMm) => patchSettings('tracks', { heightMm })}
            {...modelFieldRange('tracks', 'heightMm')}
            step={0.05}
            decimals={2}
            unit="mm"
            help={
              lidarOnly
                ? 'Height of the route above the ground it rests on.'
                : 'Height of the route above the ground. More than the roads, so a route along a road stands a layer proud of it.'
            }
            hint={!lidarOnly && settings.roads.enabled && s.heightMm <= settings.roads.thicknessMm ? 'No taller than the roads, so it sits flush with them.' : undefined}
          />
          <CheckField
            label="Start and finish markers"
            checked={s.markers}
            onChange={(markers) => patchSettings('tracks', { markers })}
            help="A dot at the start and a bar across the finish, three times the route's width. A loop only gets the dot."
          />
          <CheckField
            label="Snap to roads"
            checked={s.snap}
            onChange={(snap) => patchSettings('tracks', { snap })}
            help={
              lidarOnly
                ? "Move a recorded route onto the roads it followed, from map data downloaded for it. GPS wanders 5 to 10 m off a street, which prints as a wobbly line beside it. Stretches away from any road, like a trail, stay as recorded."
                : "Move a recorded route onto the roads it followed. GPS wanders 5 to 10 m off a street, which prints as a wobbly line beside it. The road tidy leaves the roads it follows as mapped, so it stays on them. Stretches away from any road, like a trail, stay as recorded."
            }
          />
          {s.snap && !lidarOnly && !settings.roads.enabled && <p className="layer-help">Routes snap to the roads, so they're as recorded while Roads is off.</p>}
          <button type="button" className="link-btn" onClick={() => resetSettingsSection('tracks', ['enabled'])}>
            Reset route settings
          </button>
        </>
      )}
    </>
  );
}

export function RoutesPanel() {
  const tracks = useApp((state) => state.tracks);
  const area = useApp((state) => state.area);
  const input = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => tracks.filter((track) => track.visible).flatMap((track) => decodeTrack(track)), [tracks]);
  const outside = useMemo(() => (shown.length ? shareOutside(shown, area) : 0), [shown, area]);

  const run = async (task: () => Promise<ImportResult>) => {
    setBusy(true);
    try {
      setErrors((await task()).errors);
    } finally {
      setBusy(false);
    }
  };
  const onFiles = (files: File[]) => (files.length ? run(() => importTrackFiles(files)) : undefined);

  const count = tracks.length;
  const summary = count === 0 ? 'None' : count === 1 ? tracks[0].name : `${count} routes`;
  return (
    <Section id="routes" title="Routes" summary={summary}>
      <div className="action-grid routes-import">
        <button type="button" className="btn btn-sm" disabled={busy || count >= MAX_TRACKS} onClick={() => input.current?.click()}>
          <Upload size={15} aria-hidden="true" />
          {busy ? 'Reading…' : 'Import route'}
        </button>
        <button type="button" className="btn btn-sm" disabled={count >= MAX_TRACKS} title="Click along the route on the map. It can follow the roads between clicks." onClick={drawTrack}>
          <Spline size={15} aria-hidden="true" />
          Draw a route
        </button>
        <input
          ref={input}
          type="file"
          accept={TRACK_ACCEPT}
          multiple
          hidden
          aria-label="Import route files"
          onChange={(event) => {
            // Copied first, since clearing the input empties the list.
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void onFiles(files);
          }}
        />
      </div>
      <p className="layer-help">{FILE_HINT}</p>
      <select
        className="select routes-sample"
        aria-label="Add a sample route"
        value=""
        disabled={busy || count >= MAX_TRACKS}
        onChange={(event) => {
          const file = event.target.value;
          if (file) void run(() => importSampleTrack(file));
        }}
      >
        <option value="">Try a sample route…</option>
        {SAMPLE_TRACKS.map((sample) => (
          <option key={sample.file} value={sample.file}>
            {sample.name}
          </option>
        ))}
      </select>
      {errors.map((error, i) => (
        // Two files of one name can fail the same way.
        <div key={i} className="notice notice-warning">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ))}
      <BackupNote of="tracks" />
      {count > 0 && (
        <>
          <ul className="list-box route-list">
            {tracks.map((track) => (
              <TrackRow key={track.id} track={track} />
            ))}
          </ul>
          <div className="action-grid">
            <button type="button" className="btn btn-sm" disabled={!shown.length} onClick={() => fitAreaToTracks(false)}>
              <Maximize size={15} aria-hidden="true" />
              Fit area to routes
            </button>
            <button type="button" className="btn btn-sm" disabled={!shown.length} onClick={() => fitAreaToTracks(true)}>
              <RotateCw size={15} aria-hidden="true" />
              Fit and turn
            </button>
          </div>
          {outside > 0.005 && (
            <p className="layer-help">
              {outside > 0.995 ? 'The routes are outside the area.' : `About ${Math.max(1, Math.round(outside * 100))}% of the routes are outside the area.`}
            </p>
          )}
          <RouteOptions />
        </>
      )}
    </Section>
  );
}
