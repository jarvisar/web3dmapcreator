import { fieldRange } from '../../core/svgmap/limits';
import { ClipboardPaste, Copy, Link, RotateCcw, Scan, TriangleAlert, CircleAlert } from 'lucide-react';
import { useId } from 'react';
import { areaGeoBounds, areaKm2, effectiveScale, parseBoundsText, validateArea, MAX_SIDE_M, MIN_SIDE_M } from '../../core/geo/area';
import { type AreaShape, modelFieldRange } from '../../core/settings';
import { ShapeIcon } from '../components/Icons';
import { LockButton } from '../components/LockButton';
import { NumberField, NumberInput, StackedNumber } from '../components/NumberField';
import { SliderField } from '../components/Fields';
import { Segmented } from '../components/Segmented';
import { SHAPES, SHAPE_LABELS, areaForBounds, constrainSize } from '../lib/area';
import { copyText, readClipboardText } from '../lib/browser';
import { formatMmPair, formatNumber, formatRatio, formatSizePair } from '../lib/format';
import { areaForView } from '../map/mapHandle';
import { printedSize } from '../state/derived';
import { editsForArea, picksForArea } from '../state/linkScope';
import { getEditData } from '../state/model';
import { shareUrl } from '../state/shareLink';
import {
  areaResizable,
  setArea,
  scaleLocked,
  setPrintedSide,
  setScale,
  setScaleLock,
  setSizeUnit,
  toast,
  useApp,
} from '../state/store';
import type { SizeUnit } from '../state/store';
import { pieceProduct } from '../svgmap/piece';
import { writeHashNow } from '../state/sync';
import { PlaceSearch } from './PlaceSearch';
import { PresetsMenu } from './PresetsMenu';
import { Section } from './Section';

const SEARCH_ID = 'place-search-input';
const LARGE_AREA_KM2 = 25;

function areaSummary(placeName: string, shape: AreaShape, widthM: number, heightM: number, scale: string): string {
  const size = formatSizePair(widthM, heightM) + scale;
  return placeName ? `${placeName} · ${size}` : `${SHAPE_LABELS[shape]} · ${size}`;
}

interface SizeInputProps {
  label: string;
  valueM: number;
  unit: SizeUnit;
  mmPerMetre: number;
  /** What the rim adds to this side of the print. */
  rimMm: number;
  onChange: (m: number) => void;
  disabled?: boolean;
}

function SizeInput({ label, valueM, unit, mmPerMetre, rimMm, onChange, disabled }: SizeInputProps) {
  const id = useId();
  const input =
    unit === 'mm'
      ? { value: valueM * mmPerMetre + rimMm, decimals: 1, step: 1, min: MIN_SIDE_M * mmPerMetre + rimMm, max: MAX_SIDE_M * mmPerMetre + rimMm }
      : unit === 'km'
        ? { value: valueM, scale: 0.001, decimals: 2, step: 0.01, min: MIN_SIDE_M / 1000, max: MAX_SIDE_M / 1000 }
        : { value: valueM, decimals: 0, step: 10, min: MIN_SIDE_M, max: MAX_SIDE_M };
  return (
    <div className="size-field">
      <label htmlFor={id} className="size-label">
        {label}
      </label>
      <NumberInput
        id={id}
        {...input}
        disabled={disabled}
        onChange={(value) => onChange(unit === 'mm' ? (value - rimMm) / mmPerMetre : value)}
        unit={unit}
      />
    </div>
  );
}

// Common scales. Each list has its output's default: 1:14,286 is the
// add-on's 0.07 mm per metre exactly, and SVG maps start at 1:20,000.
const RATIOS = { model: [5000, 10000, 14286, 25000, 50000], svg: [5000, 10000, 20000, 25000, 50000] };
const ratioScale = (ratio: number) => (ratio === 14286 ? 0.07 : 1000 / ratio);

// The area on the map, the scale and the printed size go together, with a
// lock on the scale (scaleLocked in the store). Models and SVG maps share
// these controls, an SVG map's size being its piece, set under Size.
function ScaleAndSize() {
  const output = useApp((state) => state.output);
  const area = useApp((state) => state.area);
  const unit = useApp((state) => state.ui.sizeUnit);
  const scale = useApp((state) => state.settings.scale);
  const rim = useApp((state) => state.settings.rim);
  const svgScale = useApp((state) => state.svg.scale);
  const svgLocked = useApp((state) => state.svg.scaleLocked);
  const product = useApp((state) => state.svg.product);
  const svg = output === 'svg';
  const lockState = { output, svg: { scaleLocked: svgLocked }, settings: { scale } };
  const locked = scaleLocked(lockState);
  const resizable = areaResizable(lockState);
  const mmPerMetre = svg ? 1000 / svgScale : effectiveScale(area, scale);
  const shown = unit === 'm' ? 'm' : 'km';
  const round = area.shape === 'circle';
  const ratio = fieldRange('scale');
  const range = svg ? { min: 1000 / ratio.max, max: 1000 / ratio.min } : modelFieldRange('scale', 'mmPerMetre');
  const printed = printedSize(area, { scale, rim });
  const rimX = printed.width - area.widthM * mmPerMetre;
  const rimY = printed.depth - area.heightM * mmPerMetre;
  const piece = pieceProduct(product, area.shape);

  const setSide = (side: 'width' | 'height', metres: number) =>
    setArea(
      (current) => {
        const [w, h] = constrainSize(current.shape, side === 'width' ? metres : current.widthM, side === 'height' ? metres : current.heightM, side);
        return { ...current, widthM: w, heightM: h };
      },
      { focus: 'if-needed' },
    );
  // SizeInput hands back metres at the current scale.
  const setPrinted = (side: 'width' | 'height') => (metres: number) => setPrintedSide(side, metres * mmPerMetre);

  const hint = !locked
    ? `${svg ? 'The piece keeps its size' : 'The printed size stays as it is'}, so resizing the box on the map changes the scale, and a new scale resizes the box.`
    : svg
      ? 'The scale is locked and the piece keeps its size, so the box on the map only moves and turns. Unlock the scale to resize it.'
      : 'The scale is locked, so resizing the box on the map or a new scale changes the printed size. Unlock it to keep the printed size instead.';

  return (
    <div className="field-group">
      <div className="group-label-row">
        <span className="group-label">Size</span>
        <Segmented
          label="Area unit"
          size="sm"
          value={shown}
          onChange={setSizeUnit}
          options={[
            { value: 'km', label: 'km' },
            { value: 'm', label: 'm' },
          ]}
        />
      </div>
      <div className="scale-grid">
        <SizeInput label={round ? 'Diameter' : 'Width'} valueM={area.widthM} unit={shown} mmPerMetre={1} rimMm={0} onChange={(m) => setSide('width', m)} disabled={!resizable} />
        {round ? (
          <span />
        ) : (
          // An SVG map's height follows its piece.
          <SizeInput label="Height" valueM={area.heightM} unit={shown} mmPerMetre={1} rimMm={0} onChange={(m) => setSide('height', m)} disabled={!resizable || svg} />
        )}
        <span />

        <StackedNumber label="Scale" value={mmPerMetre} onChange={setScale} {...range} step={0.005} decimals={4} unit="mm/m" />
        <div className="size-field">
          <span className="size-label">Ratio</span>
          <span className="size-readout">{formatRatio(mmPerMetre)}</span>
        </div>
        <LockButton locked={locked} onChange={setScaleLock} what="the scale" />

        {svg ? (
          <div className="size-field size-span">
            <span className="size-label">Piece</span>
            <span className="size-readout">{formatMmPair(piece.width, piece.height)}</span>
          </div>
        ) : (
          <>
            <SizeInput label={round ? 'Printed diameter' : 'Printed width'} valueM={area.widthM} unit="mm" mmPerMetre={mmPerMetre} rimMm={rimX} onChange={setPrinted('width')} />
            {round ? (
              <span />
            ) : (
              <SizeInput label="Printed height" valueM={area.heightM} unit="mm" mmPerMetre={mmPerMetre} rimMm={rimY} onChange={setPrinted('height')} />
            )}
          </>
        )}
        <span />
      </div>
      <div className="chips" role="group" aria-label="Common scales">
        {RATIOS[output].map((r) => {
          const value = ratioScale(r);
          const selected = Math.abs(mmPerMetre - value) < 1e-6;
          return (
            <button key={r} type="button" className={`chip-btn${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={() => setScale(value)}>
              {formatRatio(value)}
            </button>
          );
        })}
      </div>
      <p className="field-hint">
        {hint}
        {!svg && rim.enabled ? ' Printed sizes include the rim.' : ''}
      </p>
    </div>
  );
}

export function AreaPanel() {
  const output = useApp((state) => state.output);
  const area = useApp((state) => state.area);
  const placeName = useApp((state) => state.placeName);
  const scale = useApp((state) => state.settings.scale);
  const svgScale = useApp((state) => state.svg.scale);
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
    const scoped = editsForArea(state.edits, state.area, model);
    const picked = picksForArea({ routes: state.svg.routes, hiddenLines: state.svg.hiddenLines }, state.area);
    const { url, left } = shareUrl(state.area, state.output, { ...state.svg, ...picked.picks }, scoped.edits);
    if (!(await copyText(url))) {
      toast('Could not copy to the clipboard', 'error');
      return;
    }
    if (left) {
      const what = left === 'edits' ? 'your edits' : 'your picked roads';
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

      <ScaleAndSize />

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
