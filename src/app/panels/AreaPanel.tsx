import { ClipboardPaste, Copy, Link, RotateCcw, Scan, TriangleAlert, CircleAlert } from 'lucide-react';
import { areaGeoBounds, areaKm2, effectiveScale, parseBoundsText, validateArea } from '../../core/geo/area';
import type { AreaShape } from '../../core/settings';
import { ShapeIcon } from '../components/Icons';
import { NumberField } from '../components/NumberField';
import { SliderField } from '../components/Fields';
import { Segmented } from '../components/Segmented';
import { SHAPES, SHAPE_LABELS, areaForBounds, constrainSize } from '../lib/area';
import { copyText, readClipboardText } from '../lib/browser';
import { formatNumber, formatRatio, formatSizePair } from '../lib/format';
import { areaForView } from '../map/mapHandle';
import { editsForArea, picksForArea, tracksForLink } from '../state/linkScope';
import { getEditData } from '../state/model';
import { shareUrl } from '../state/shareLink';
import { setArea, toast, useApp } from '../state/store';
import { writeHashNow } from '../state/sync';
import { PlaceSearch } from './PlaceSearch';
import { PresetsMenu } from './PresetsMenu';
import { Section } from './Section';

const SEARCH_ID = 'place-search-input';
const LARGE_AREA_KM2 = 25;
// LiDAR downloads per km², in GB, as the Layers help gives them. Past a
// square kilometre that's worth saying before Generate, not after.
const LIDAR_GB_PER_KM2 = { buildings: [0.15, 1.5], model: [0.075, 1.5] } as const;
const LIDAR_AREA_KM2 = 1;

const gigabytes = (gb: number) => (gb >= 1 ? `${formatNumber(gb, 1)} GB` : `${Math.round(gb * 1000)} MB`);

function areaSummary(placeName: string, shape: AreaShape, widthM: number, heightM: number, scale: string): string {
  const size = formatSizePair(widthM, heightM) + scale;
  return placeName ? `${placeName} · ${size}` : `${SHAPE_LABELS[shape]} · ${size}`;
}

export function AreaPanel() {
  const output = useApp((state) => state.output);
  const area = useApp((state) => state.area);
  const placeName = useApp((state) => state.placeName);
  const scale = useApp((state) => state.settings.scale);
  const svgScale = useApp((state) => state.svg.scale);
  const lidar = useApp((state) =>
    state.settings.modelSource === 'lidar' ? 'model' : state.settings.buildings.enabled && state.settings.lidar.enabled ? 'buildings' : null,
  );
  const svg = output === 'svg';
  const problem = validateArea(area);
  const km2 = areaKm2(area);
  const mmPerMetre = svg ? 1000 / svgScale : effectiveScale(area, scale);

  function setShape(shape: AreaShape) {
    setArea((current) => {
      if (current.shape === shape) return current;
      const [w, h] = constrainSize(shape, current.widthM, current.heightM, 'smaller');
      return { ...current, shape, widthM: w, heightM: h };
    });
  }

  async function pasteBounds() {
    const text = await readClipboardText();
    if (text === null) {
      toast('Paste the bounds into the search box instead', 'info');
      document.getElementById(SEARCH_ID)?.focus();
      return;
    }
    try {
      const bounds = parseBoundsText(text);
      setArea((current) => areaForBounds(bounds, current, useApp.getState().output === 'svg'), { focus: 'always', placeName: '', fit: 'cover' });
      toast('Area set from the pasted bounds', 'success');
    } catch (error) {
      toast(error instanceof Error ? `Could not read the bounds: ${error.message}` : 'Could not read the bounds', 'error');
    }
  }

  async function copyBounds() {
    const b = areaGeoBounds(area);
    const text = [b.west, b.south, b.east, b.north].map((value) => value.toFixed(5)).join(',');
    toast((await copyText(text)) ? 'Bounds copied as west, south, east, north' : 'Could not copy to the clipboard', 'info');
  }

  function fitToView() {
    const next = areaForView(area);
    if (next) setArea(next, { fit: 'inside' });
  }

  async function copyLink() {
    writeHashNow();
    const state = useApp.getState();
    // Only what's on this area goes: edits and picks are kept for every area.
    const result = state.generation.result;
    const model = result ? { data: getEditData(), trees: result.parts.some((part) => part.id === 'trees') } : null;
    const scoped = editsForArea(state.edits, state.area, model, effectiveScale(state.area, state.settings.scale));
    const picked = picksForArea({ routes: state.svg.routes, hiddenLines: state.svg.hiddenLines }, state.area);
    const { url, left } = shareUrl(state.area, state.output, { ...state.svg, ...picked.picks }, scoped.edits, tracksForLink(state.tracks, state.area));
    if (!(await copyText(url))) {
      toast('Could not copy to the clipboard', 'error');
      return;
    }
    if (left) {
      const what = left === 'edits' ? 'your edits' : left === 'tracks' ? 'your routes' : 'your picked roads';
      toast(`Share link copied, without ${what}: there are too many for a link. Export options to share them.`, 'info');
    } else if (state.output === 'model' && scoped.unplaced) {
      toast('Share link copied. Changes to buildings, roads and water go in once the model of this area is generated.', 'info');
    } else if (state.output === 'model' && scoped.left) {
      toast('Share link copied, with the edits on this area. Ones made elsewhere stay here.', 'info');
    } else if (state.output === 'svg' && picked.left) {
      toast('Share link copied, with the picked roads on this map. Ones elsewhere stay here.', 'info');
    } else {
      toast('Share link copied', 'info');
    }
  }

  return (
    <Section
      id="area"
      title="Area"
      summary={areaSummary(placeName, area.shape, area.widthM, area.heightM, ` · ${formatRatio(mmPerMetre)}`)}
    >
      <div className="search-row">
        <PlaceSearch inputId={SEARCH_ID} />
        <PresetsMenu />
      </div>

      <div className="field-group">
        <div className="group-label">Shape</div>
        <Segmented
          label="Area shape"
          value={area.shape}
          onChange={setShape}
          stretch
          className="shape-picker"
          options={SHAPES.map((shape) => ({
            value: shape,
            label: (
              <>
                <ShapeIcon shape={shape} />
                <span>{SHAPE_LABELS[shape]}</span>
              </>
            ),
          }))}
        />
      </div>

      <NumberField
        label="Rotation"
        value={area.rotationDeg}
        onChange={(value) => setArea((current) => ({ ...current, rotationDeg: value }))}
        min={-180}
        max={180}
        step={1}
        decimals={1}
        unit="°"
        help={
          svg
            ? 'Turns the area clockwise from north. The map is drawn square to the rotated area, so its top edge points this way. You can also drag the round handle above the area on the map.'
            : 'Turns the area clockwise from north. The model is built square to the rotated area, so its top edge points this way. You can also drag the round handle above the area on the map.'
        }
        hint={
          area.rotationDeg !== 0 ? (
            <button type="button" className="link-btn" onClick={() => setArea((current) => ({ ...current, rotationDeg: 0 }))}>
              <RotateCcw size={12} aria-hidden="true" />
              Point north again
            </button>
          ) : undefined
        }
      />

      {area.shape === 'rounded' && !svg && (
        <SliderField
          label="Corner roundness"
          value={area.cornerRadius}
          onChange={(value) => setArea((current) => ({ ...current, cornerRadius: value }))}
          min={0}
          max={0.5}
          step={0.01}
          format={(value) => `${Math.round(value * 100)}%`}
          help="Corner radius as a share of the shorter side. 50% makes the short ends fully round."
        />
      )}

      <div className="area-facts">
        <span>
          {formatNumber(km2, km2 < 10 ? 2 : 1)} km² real area
        </span>
        <span className="muted">
          {formatNumber(area.center[1], 5)}, {formatNumber(area.center[0], 5)}
        </span>
      </div>

      {problem && (
        <div className="notice notice-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{problem}</span>
        </div>
      )}
      {!problem && !svg && km2 > LARGE_AREA_KM2 && (
        <div className="notice notice-warning">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>This is a large area. Downloading and generating will be slow and use a lot of memory. Try a smaller area first.</span>
        </div>
      )}
      {!problem && !svg && lidar && km2 > LIDAR_AREA_KM2 && (
        <div className="notice notice-warning">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            With LiDAR on, expect {gigabytes(km2 * LIDAR_GB_PER_KM2[lidar][0])} to {gigabytes(km2 * LIDAR_GB_PER_KM2[lidar][1])} of downloads for
            this area, depending on the survey. Try a small area first.
          </span>
        </div>
      )}

      <div className="action-grid">
        <button type="button" className="btn btn-sm" onClick={() => void pasteBounds()}>
          <ClipboardPaste size={15} aria-hidden="true" />
          Paste bounds
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void copyBounds()}>
          <Copy size={15} aria-hidden="true" />
          Copy bounds
        </button>
        <button type="button" className="btn btn-sm" onClick={fitToView}>
          <Scan size={15} aria-hidden="true" />
          Fit to map view
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void copyLink()}>
          <Link size={15} aria-hidden="true" />
          Copy share link
        </button>
      </div>
    </Section>
  );
}
