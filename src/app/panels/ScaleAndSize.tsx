import { useId } from 'react';
import { MAX_SIDE_M, MIN_SIDE_M, effectiveScale } from '../../core/geo/area';
import { modelFieldRange } from '../../core/settings';
import { fieldRange } from '../../core/svgmap/limits';
import { LockButton } from '../components/LockButton';
import { NumberInput, StackedNumber } from '../components/NumberField';
import { Segmented } from '../components/Segmented';
import { constrainSize } from '../lib/area';
import { formatRatio } from '../lib/format';
import { printedSize } from '../state/derived';
import { areaResizable, scaleLocked, setArea, setPrintedSide, setScale, setScaleLock, setSizeUnit, useApp } from '../state/store';
import type { SizeUnit } from '../state/store';
import { pieceLayout } from '../svgmap/piece';

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

// The printed size, the scale and the area on the map go together, with a
// lock on the scale (scaleLocked in the store). Both outputs' Size sections
// show this. An SVG map's printed size is its piece, set just above it.
export function ScaleAndSize() {
  const output = useApp((state) => state.output);
  const area = useApp((state) => state.area);
  const unit = useApp((state) => state.ui.sizeUnit);
  const scale = useApp((state) => state.settings.scale);
  const rim = useApp((state) => state.settings.rim);
  const svgScale = useApp((state) => state.svg.scale);
  const svgLocked = useApp((state) => state.svg.scaleLocked);
  const product = useApp((state) => state.svg.product);
  const border = useApp((state) => state.svg.border);
  const svg = output === 'svg';
  const lockState = { output, svg: { scaleLocked: svgLocked }, settings: { scale } };
  const locked = scaleLocked(lockState);
  const resizable = areaResizable(lockState);
  const mmPerMetre = svg ? 1000 / svgScale : effectiveScale(area, scale);
  // The printed size has its own row now, so the area is in km or m.
  const shown: SizeUnit = unit === 'm' ? 'm' : 'km';
  const round = area.shape === 'circle';
  const ratio = fieldRange('scale');
  const range = svg ? { min: 1000 / ratio.max, max: 1000 / ratio.min } : modelFieldRange('scale', 'mmPerMetre');
  const printed = printedSize(area, { scale, rim });
  const rimX = printed.width - area.widthM * mmPerMetre;
  const rimY = printed.depth - area.heightM * mmPerMetre;

  const setSide = (side: 'width' | 'height', metres: number) =>
    setArea(
      (current) => {
        const [w, h] = constrainSize(current.shape, side === 'width' ? metres : current.widthM, side === 'height' ? metres : current.heightM, side);
        return { ...current, widthM: w, heightM: h };
      },
      { focus: 'if-needed' },
    );
  // An SVG map's box has the piece's proportions, so a typed height sets the
  // width that gives it. The store keeps the width and fits the height.
  const mapWindow = svg ? pieceLayout(product, area.shape, border).layout?.window : null;
  const setHeight = (metres: number) => (mapWindow ? setSide('width', (metres * mapWindow.w) / mapWindow.h) : setSide('height', metres));
  // SizeInput hands back metres at the current scale.
  const setPrinted = (side: 'width' | 'height') => (metres: number) => setPrintedSide(side, metres * mmPerMetre);

  const hint = !locked
    ? `${svg ? 'The piece keeps its size' : 'The printed size stays as it is'}, so resizing the area changes the scale, and a new scale resizes the area.`
    : svg
      ? 'The scale is locked and the piece keeps its size, so the area on the map only moves and turns. Unlock the scale to resize it.'
      : 'The scale is locked, so resizing the area or a new scale changes the printed size. Unlock it to keep the printed size instead.';

  return (
    <div className="field-group">
      <div className="scale-grid">
        {!svg && (
          <>
            <SizeInput label={round ? 'Diameter' : 'Width'} valueM={area.widthM} unit="mm" mmPerMetre={mmPerMetre} rimMm={rimX} onChange={setPrinted('width')} />
            {round ? (
              <span />
            ) : (
              <SizeInput label="Height" valueM={area.heightM} unit="mm" mmPerMetre={mmPerMetre} rimMm={rimY} onChange={setPrinted('height')} />
            )}
            <span />
          </>
        )}
        <StackedNumber label="Scale" value={mmPerMetre} onChange={setScale} {...range} step={0.005} decimals={4} unit="mm/m" />
        <div className="size-field">
          <span className="size-label">Ratio</span>
          <span className="size-readout">{formatRatio(mmPerMetre)}</span>
        </div>
        <LockButton locked={locked} onChange={setScaleLock} what="the scale" />
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

      <div className="group-label-row">
        <span className="group-label">Area on the map</span>
        <Segmented
          label="Area unit"
          size="sm"
          value={shown}
          onChange={setSizeUnit}
          options={[
            { value: 'km' as const, label: 'km' },
            { value: 'm' as const, label: 'm' },
          ]}
        />
      </div>
      <div className="scale-grid">
        <SizeInput label={round ? 'Area diameter' : 'Area width'} valueM={area.widthM} unit={shown} mmPerMetre={1} rimMm={0} onChange={(m) => setSide('width', m)} disabled={!resizable} />
        {round ? (
          <span />
        ) : (
          <SizeInput label="Area height" valueM={area.heightM} unit={shown} mmPerMetre={1} rimMm={0} onChange={setHeight} disabled={!resizable} />
        )}
        <span />
      </div>
      <p className="field-hint">
        {!svg && rim.enabled ? 'The printed size includes the rim. ' : ''}
        {hint}
      </p>
    </div>
  );
}
