import { ArrowLeftRight, CircleAlert, Eye, Magnet, MousePointer2, Repeat2, Scissors, SlidersHorizontal, Spline, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { spanLengthM } from '../../core/tracks/edit';
import { decodeTrack, MAX_TRACKS, trackLengthM, type Track } from '../../core/tracks/track';
import type { LonLat } from '../../core/types';
import { CheckField, SliderField } from '../components/Fields';
import { NumberInput } from '../components/NumberField';
import { ToolButton } from '../components/ToolButton';
import { PHONE_QUERY, UNDO_KEYS, useMediaQuery } from '../lib/browser';
import { ROUTE_SNAP_M, setRouteFollow, setRouteSnap, toast, useApp } from '../state/store';
import { restoreObjects } from '../state/editActions';
import { setTrackVisible } from '../state/tracks';
import {
  backToStart,
  cutSection,
  formatDistance,
  isChanged,
  loadRoads,
  reverseTrack,
  revertTrack,
  roadGraph,
  selectPoint,
  setEditedTrack,
  setTrackTool,
  snapTrack,
  startSection,
  stopEditing,
  straightenSection,
  trimTrack,
  useTrackEdit,
  type TrackPoint,
  type TrackSection,
} from '../state/trackEdit';
import { COARSE, trackEditor } from './TrackEditor';

const NEW_ROUTE = '__new';

/** Distance along the route to a point, counting the lines before its own. */
function distanceTo(lines: readonly LonLat[][], point: TrackPoint): number {
  let total = 0;
  for (let i = 0; i < point.line; i++) total += spanLengthM(lines[i]);
  return total + spanLengthM(lines[point.line] ?? [], 0, point.index);
}

function pointLabel(lines: readonly LonLat[][], point: TrackPoint): string {
  const last = lines[lines.length - 1];
  if (point.line === 0 && point.index === 0) return 'The start';
  if (point.line === lines.length - 1 && point.index === last.length - 1) return 'The finish';
  return `Point ${formatDistance(distanceTo(lines, point))} along`;
}

// The editor's tools down the left of the map, like the model editor's.
export function TrackEditTools() {
  const tool = useTrackEdit((state) => state.tool);
  const hasTrack = useTrackEdit((state) => state.trackId !== null);
  return (
    <div className="edit-tools track-edit-tools" role="toolbar" aria-label="Route tools" aria-orientation="vertical">
      <div className="toolbar toolbar-vertical floating">
        <ToolButton label="Move points (V)" pressed={tool === 'move'} disabled={!hasTrack} onClick={() => setTrackTool('move')} placement="right">
          <MousePointer2 size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Draw (D)" pressed={tool === 'draw'} onClick={() => setTrackTool('draw')} placement="right">
          <Spline size={15} aria-hidden="true" />
        </ToolButton>
      </div>
    </div>
  );
}

export function TrackEditHint() {
  const hint = useTrackEdit((state) => state.hint);
  const announce = useTrackEdit((state) => state.announce);
  return (
    <>
      {hint && <div className="map-edit-hint floating">{hint}</div>}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </>
  );
}

export function TrackEditCard() {
  const trackId = useTrackEdit((state) => state.trackId);
  const tracks = useApp((state) => state.tracks);
  const track = tracks.find((item) => item.id === trackId) ?? null;
  const tool = useTrackEdit((state) => state.tool);
  const opened = useTrackEdit((state) => state.opened);
  // Removed in the 3D editor, it stays out of the model however it's edited here.
  const removed = useApp((state) => Boolean(track && state.edits.objects[`rt:${track.id}`]?.removed));
  const ref = useRef<HTMLElement>(null);
  // On a phone the card would cover most of the map, so its options fold away.
  const phone = useMediaQuery(PHONE_QUERY);
  const [options, setOptions] = useState(false);
  const showOptions = !phone || options;
  // Opened from the sidebar, the focus would stay there, where the editor's keys don't reach.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
    });
    return () => clearTimeout(timer);
  }, [opened]);
  return (
    <section ref={ref} tabIndex={-1} className="viewer-card floating inspector track-edit-card" aria-label="Edit routes">
      <header className="viewer-card-header inspector-header">
        <div className="inspector-title">
          <h3>{track ? 'Edit route' : 'Draw a route'}</h3>
        </div>
        <span className="inspector-header-actions">
          {phone && (
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Route options" aria-expanded={options} title="Options" onClick={() => setOptions(!options)}>
              <SlidersHorizontal size={14} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Stop editing routes (Esc)" title="Done (Esc)" onClick={stopEditing}>
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      </header>
      <div className="inspector-body">
        <TrackPicker tracks={tracks} track={track} />
        {track && !track.visible && (
          <p className="inspector-note track-edit-hidden">
            This route is hidden, so it isn't built into the model.{' '}
            <button type="button" className="link-btn" onClick={() => setTrackVisible(track.id, true)}>
              <Eye size={12} aria-hidden="true" /> Show it
            </button>
          </p>
        )}
        {track && track.visible && removed && (
          <p className="inspector-note track-edit-hidden">
            It's removed from the model in the 3D editor.{' '}
            <button type="button" className="link-btn" onClick={() => restoreObjects([`rt:${track.id}`])}>
              <Undo2 size={12} aria-hidden="true" /> Put it back
            </button>
          </p>
        )}
        {showOptions ? <FollowRoads /> : <RoadStatus />}
        <div className={showOptions ? 'track-edit-part' : 'track-edit-now'}>{tool === 'draw' || !track ? <DrawPart track={track} /> : <SelectionPart track={track} />}</div>
        {track && showOptions && <WholeRoute track={track} />}
      </div>
      {!COARSE && (
        <footer className="viewer-card-footer inspector-footer">
          <span>Comma and period step through the points, with Shift to pick a section. Arrow keys move a point, S snaps it to a road, Delete removes it. F turns Follow roads on and off. {UNDO_KEYS} undoes.</span>
        </footer>
      )}
    </section>
  );
}

function TrackPicker({ tracks, track }: { tracks: Track[]; track: Track | null }) {
  const length = useMemo(() => (track ? trackLengthM(decodeTrack(track)) : 0), [track]);
  if (!tracks.length) return null;
  return (
    <div className="track-edit-picker">
      <select
        className="select"
        aria-label="Route to edit"
        value={track?.id ?? NEW_ROUTE}
        onChange={(event) => {
          const value = event.target.value;
          if (value === NEW_ROUTE) {
            setEditedTrack(null);
            setTrackTool('draw');
          } else {
            setEditedTrack(value);
            setTrackTool('move');
          }
        }}
      >
        {tracks.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
        <option value={NEW_ROUTE} disabled={tracks.length >= MAX_TRACKS}>
          New route…
        </option>
      </select>
      {track && <span className="track-edit-length">{formatDistance(length)}</span>}
    </div>
  );
}

function FollowRoads() {
  const follow = useApp((state) => state.ui.routeFollow);
  const snapM = useApp((state) => state.ui.routeSnapM);
  return (
    <>
      <CheckField
        label="Follow roads"
        checked={follow}
        onChange={setRouteFollow}
        help="Points you move or draw go onto the nearest road or path, and the route goes along the roads between them. The roads are the ones the model is built from, in and just around the area. Hold Alt to put a point anywhere. (F)"
      />
      <RoadStatus />
      {follow && (
        <SliderField
          label="Snap distance"
          value={snapM}
          min={ROUTE_SNAP_M.min}
          max={ROUTE_SNAP_M.max}
          step={5}
          onChange={setRouteSnap}
          format={(value) => `${value} m`}
          help="How far from a road a point can be and still go onto it. Raise it for a wobbly recording. Lower it where a path runs right beside a road, so points don't jump to the wrong one."
        />
      )}
    </>
  );
}

/** Whether the roads to follow are loading, or why there are none. */
function RoadStatus() {
  const follow = useApp((state) => state.ui.routeFollow);
  const roads = useTrackEdit((state) => state.roads);
  // The graph can still be there from before the area moved while new roads load.
  useTrackEdit((state) => state.network);
  const ready = roadGraph() !== null;
  return (
    <>
      {follow && roads.status === 'loading' && (
        <p className="inspector-note track-edit-status">
          <span className="spinner" aria-hidden="true" /> {ready ? 'Loading the roads for the new area…' : 'Loading the roads around the area…'}
        </p>
      )}
      {follow && roads.status === 'failed' && (
        <p className="inspector-note track-edit-status is-warning" role="status">
          <CircleAlert size={13} aria-hidden="true" />
          <span>
            {ready ? "The roads for the new area didn't load." : "The roads didn't load, so points go where you put them."} {roads.message}{' '}
            <button type="button" className="link-btn" onClick={loadRoads}>
              Try again
            </button>
          </span>
        </p>
      )}
      {follow && roads.status === 'none' && <p className="inspector-note track-edit-status">There are no mapped roads or paths around the area.</p>}
    </>
  );
}

function DrawPart({ track }: { track: Track | null }) {
  const draft = useTrackEdit((state) => state.draft !== null);
  const startSelected = useTrackEdit((state) => state.selected?.line === 0 && state.selected.index === 0);
  const tap = COARSE ? 'Tap' : 'Click';
  let text: string;
  if (!track) text = draft ? `${tap} again to draw the first stretch.` : `${tap} the map where the route starts, then ${tap.toLowerCase()} along it.`;
  else text = startSelected ? `${tap} the map to add to the start of the route.` : `${tap} the map to carry the route on from its finish. Select the start to add to that end instead.`;
  return (
    <>
      <p className="inspector-intro">{text}</p>
      {track && (
        <div className="inspector-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setTrackTool('move')} title="Enter">
            Finish
          </button>
        </div>
      )}
    </>
  );
}

function SelectionPart({ track }: { track: Track }) {
  const selected = useTrackEdit((state) => state.selected);
  const section = useTrackEdit((state) => state.section);
  const sectionFrom = useTrackEdit((state) => state.sectionFrom);
  useTrackEdit((state) => state.network);
  const lines = useMemo(() => decodeTrack(track), [track]);
  const roads = roadGraph() !== null;
  const tap = COARSE ? 'Tap' : 'Click';

  if (section) return <SectionPart track={track} lines={lines} section={section} roads={roads} />;
  if (!selected) {
    return (
      <p className="inspector-intro">
        {COARSE
          ? 'Drag a point to move it, or drag the line to add one. Tap a point to select it.'
          : 'Drag a point to move it, or drag the line to add one. Click a point to select it, and double-click it to delete it.'}
      </p>
    );
  }
  return (
    <>
      <p className="inspector-intro">{pointLabel(lines, selected)}</p>
      <div className="inspector-actions">
        {roads && (
          <button type="button" className="btn btn-sm" title="Move it onto the nearest road or path (S)" onClick={() => trackEditor()?.snapPoint(selected) || noRoadNear()}>
            <Magnet size={14} aria-hidden="true" />
            Snap to road
          </button>
        )}
        <button type="button" className="btn btn-sm" title="Delete" onClick={() => trackEditor()?.remove(selected)}>
          <Trash2 size={14} aria-hidden="true" />
          Delete point
        </button>
      </div>
      {sectionFrom ? (
        <div className="inspector-actions track-edit-wait">
          <span>{tap} the other end of the section.</span>
          <button type="button" className="link-btn" onClick={() => startSection(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="inspector-actions">
          <button type="button" className="btn btn-sm" title="Then pick the other end, to snap, straighten or cut out what's between" onClick={() => startSection(selected)}>
            Pick a section
          </button>
          {!COARSE && <span className="inspector-hint">or Shift-click the other end</span>}
        </div>
      )}
    </>
  );
}

function noRoadNear(): void {
  toast(`No road or path within ${useApp.getState().ui.routeSnapM} m of the point. A bigger snap distance reaches further.`, 'info', undefined, 'route-edit');
}

function SectionPart({ track, lines, section, roads }: { track: Track; lines: LonLat[][]; section: TrackSection; roads: boolean }) {
  const length = lines[section.line] ? spanLengthM(lines[section.line], section.from, section.to) : 0;
  return (
    <>
      <div className="inspector-intro track-edit-section-head">
        <span>Section of {formatDistance(length)}</span>
        <button type="button" className="link-btn" onClick={() => selectPoint(null)}>
          Clear
        </button>
      </div>
      <div className="inspector-actions">
        {roads && (
          <button type="button" className="btn btn-sm" title="Move this section onto the roads it runs along" onClick={() => snapTrack(track, section)}>
            <Magnet size={14} aria-hidden="true" />
            Snap to roads
          </button>
        )}
        <button type="button" className="btn btn-sm" title="A straight line from one end to the other" onClick={() => straightenSection(track, section)}>
          Straighten
        </button>
        <button type="button" className="btn btn-sm" title="Take it out. In the middle this leaves a gap, at an end it trims the route. (Delete)" onClick={() => cutSection(track, section)}>
          <Scissors size={14} aria-hidden="true" />
          Cut out
        </button>
      </div>
    </>
  );
}

function WholeRoute({ track }: { track: Track }) {
  const [trim, setTrim] = useState(200);
  useTrackEdit((state) => state.network);
  const roads = roadGraph();
  const follow = useApp((state) => state.ui.routeFollow);
  const changed = isChanged(track);
  return (
    <div className="track-edit-part">
      <div className="inspector-section-head">
        <span>Whole route</span>
        {changed && (
          <button type="button" className="link-btn" onClick={() => revertTrack(track)} title="Put it back the way it was when you first edited it">
            <Undo2 size={12} aria-hidden="true" /> Undo all changes
          </button>
        )}
      </div>
      <div className="inspector-actions">
        {roads && (
          <button
            type="button"
            className="btn btn-sm"
            title="Move the whole route onto the roads it runs along, the way the model snaps routes. Stretches away from any road stay as they are."
            onClick={() => snapTrack(track, null)}
          >
            <Magnet size={14} aria-hidden="true" />
            Snap to roads
          </button>
        )}
        <button type="button" className="btn btn-sm" title="Swap the start and the finish" onClick={() => reverseTrack(track)}>
          <ArrowLeftRight size={14} aria-hidden="true" />
          Reverse
        </button>
        <button type="button" className="btn btn-sm" title="Join the finish back to the start, along the roads when following them" onClick={() => backToStart(track, follow ? roads : null)}>
          <Repeat2 size={14} aria-hidden="true" />
          Back to start
        </button>
      </div>
      <div className="inspector-actions track-edit-trim">
        <NumberInput value={trim} onChange={setTrim} min={10} max={5000} step={10} decimals={0} unit="m" ariaLabel="Distance to trim" width={78} />
        <button type="button" className="btn btn-sm" title="Hide where the route starts, like your front door" onClick={() => trimTrack(track, trim, 'start')}>
          Trim start
        </button>
        <button type="button" className="btn btn-sm" title="Hide where the route finishes" onClick={() => trimTrack(track, trim, 'finish')}>
          Trim finish
        </button>
      </div>
    </div>
  );
}
