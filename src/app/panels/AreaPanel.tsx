import { ClipboardPaste, Copy, Link, Lock, LockOpen, RotateCcw, Scan, TriangleAlert, CircleAlert } from 'lucide-react';
import { useId } from 'react';
import { areaGeoBounds, areaKm2, effectiveScale, parseBoundsText, validateArea, MAX_SIDE_M, MIN_SIDE_M } from '../../core/geo/area';
import type { AreaShape } from '../../core/settings';
import { ShapeIcon } from '../components/Icons';
import { NumberField, NumberInput } from '../components/NumberField';
import { SliderField } from '../components/Fields';
import { Segmented } from '../components/Segmented';
import { SHAPES, SHAPE_LABELS, areaForBounds, constrainSize } from '../lib/area';
import { copyText, readClipboardText } from '../lib/browser';
import { formatInteger, formatNumber, formatRatio, formatSizePair } from '../lib/format';
import { areaForView } from '../map/mapHandle';
import { printedSize } from '../state/derived';
import { shareUrl } from '../state/shareLink';
import { patchSettings, setArea, setScaleLocked, setSizeUnit, setSvgScale, toast, useApp } from '../state/store';
import type { SizeUnit } from '../state/store';
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

// An SVG map's size: the width of the map window on the ground, or the 1:n
// scale that gives on the piece. Two ways of setting the same thing.
function SvgSize({ unit, onWidth }: { unit: SizeUnit; onWidth: (metres: number) => void }) {
  const area = useApp((state) => state.area);
  const scale = useApp((state) => state.svg.scale);
  const locked = useApp((state) => state.svg.scaleLocked);
  const scaleId = useId();
  const shown = unit === 'mm' ? 'km' : unit;
  return (
    <div className="field-group">
      <div className="group-label-row">
        <span className="group-label">Size</span>
        <Segmented
          label="Size unit"
          size="sm"
          value={shown}
          onChange={setSizeUnit}
          options={[
            { value: 'km', label: 'km' },
            { value: 'm', label: 'm' },
          ]}
        />
      </div>
      <div className="size-grid">
        <SizeInput
          label={area.shape === 'circle' ? 'Diameter' : 'Width'}
          valueM={area.widthM}
          unit={shown}
          mmPerMetre={1}
          rimMm={0}
          onChange={onWidth}
          disabled={locked}
        />
        <div className="size-field">
          <label htmlFor={scaleId} className="size-label">
            Scale
          </label>
          <div className="scale-input">
            <span className="scale-prefix" aria-hidden="true">
              1:
            </span>
            <NumberInput id={scaleId} value={scale} onChange={setSvgScale} min={100} max={2000000} step={500} decimals={0} ariaLabel="Scale, 1 to" />
            <button
              type="button"
              className={`btn btn-sm lock-btn${locked ? ' is-locked' : ''}`}
              aria-pressed={locked}
              aria-label="Lock the scale"
              title={locked ? 'Unlock the scale' : 'Lock the scale'}
              onClick={() => setScaleLocked(!locked)}
            >
              {locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
      <p className="field-hint">
        {locked
          ? `Locked at 1:${formatInteger(scale)}. The area can move and turn but not resize, and new places and piece sizes keep this scale.`
          : `The map window covers ${formatSizePair(area.widthM, area.heightM)}. Resizing the area changes the scale.`}
      </p>
    </div>
  );
}

export function AreaPanel() {
  const output = useApp((state) => state.output);
  const area = useApp((state) => state.area);
  const placeName = useApp((state) => state.placeName);
  const unit = useApp((state) => state.ui.sizeUnit);
  const scale = useApp((state) => state.settings.scale);
  const rim = useApp((state) => state.settings.rim);
  const svgScale = useApp((state) => state.svg.scale);
  const svg = output === 'svg';
  const problem = validateArea(area);
  const km2 = areaKm2(area);
  const mmPerMetre = effectiveScale(area, scale);
  const printed = printedSize(area, { scale, rim });
  const rimX = printed.width - area.widthM * mmPerMetre;
  const rimY = printed.depth - area.heightM * mmPerMetre;

  function setSize(side: 'width' | 'height', metres: number) {
    setArea(
      (current) => {
        const width = side === 'width' ? metres : current.widthM;
        const height = side === 'height' ? metres : current.heightM;
        const [w, h] = constrainSize(current.shape, width, height, side);
        return { ...current, widthM: w, heightM: h };
      },
      { focus: 'if-needed' },
    );
    // Fit to size would rescale the model to the new area. Keep the scale
    // instead, so the printed size stays what was typed.
    if (!svg && unit === 'mm' && scale.mode === 'fit') {
      const next = useApp.getState().area;
      patchSettings('scale', { fitMm: Math.min(2000, Math.max(20, mmPerMetre * Math.max(next.widthM, next.heightM))) });
    }
  }

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
    toast((await copyText(shareUrl(state.area, state.output, state.svg))) ? 'Share link copied' : 'Could not copy to the clipboard', 'info');
  }

  return (
    <Section
      id="area"
      title="Area"
      summary={areaSummary(placeName, area.shape, area.widthM, area.heightM, svg ? ` · 1:${formatInteger(svgScale)}` : '')}
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

      {svg ? (
        <SvgSize unit={unit} onWidth={(m) => setSize('width', m)} />
      ) : (
        <div className="field-group">
          <div className="group-label-row">
            <span className="group-label">Size</span>
            <Segmented
              label="Size unit"
              size="sm"
              value={unit}
              onChange={setSizeUnit}
              options={[
                { value: 'km', label: 'km' },
                { value: 'm', label: 'm' },
                { value: 'mm', label: 'mm', title: 'Printed size', ariaLabel: 'Printed size in mm' },
              ]}
            />
          </div>
          <div className="size-grid">
            {area.shape === 'circle' ? (
              <SizeInput
                label="Diameter"
                valueM={area.widthM}
                unit={unit}
                mmPerMetre={mmPerMetre}
                rimMm={rimX}
                onChange={(m) => setSize('width', m)}
              />
            ) : (
              <>
                <SizeInput
                  label="Width"
                  valueM={area.widthM}
                  unit={unit}
                  mmPerMetre={mmPerMetre}
                  rimMm={rimX}
                  onChange={(m) => setSize('width', m)}
                />
                <SizeInput
                  label="Height"
                  valueM={area.heightM}
                  unit={unit}
                  mmPerMetre={mmPerMetre}
                  rimMm={rimY}
                  onChange={(m) => setSize('height', m)}
                />
              </>
            )}
          </div>
          {unit === 'mm' && (
            <p className="field-hint">
              Printed size at {formatRatio(mmPerMetre)}
              {rim.enabled ? ', rim included' : ''}. Changing it resizes the area on the map.
            </p>
          )}
        </div>
      )}

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
