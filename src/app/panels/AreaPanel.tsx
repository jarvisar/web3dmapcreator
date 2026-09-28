import { ClipboardPaste, Copy, Link, RotateCcw, Scan, TriangleAlert, CircleAlert } from 'lucide-react';
import { useId } from 'react';
import { areaGeoBounds, areaKm2, parseBoundsText, validateArea, MAX_SIDE_M, MIN_SIDE_M } from '../../core/geo/area';
import type { AreaShape } from '../../core/settings';
import { ShapeIcon } from '../components/Icons';
import { NumberField, NumberInput } from '../components/NumberField';
import { SliderField } from '../components/Fields';
import { Segmented } from '../components/Segmented';
import { SHAPES, SHAPE_LABELS, areaForBounds, constrainSize } from '../lib/area';
import { copyText, readClipboardText } from '../lib/browser';
import { formatNumber, formatSizePair } from '../lib/format';
import { areaForView } from '../map/mapHandle';
import { shareUrl } from '../state/shareLink';
import { setArea, setSizeUnit, toast, useApp } from '../state/store';
import type { SizeUnit } from '../state/store';
import { writeHashNow } from '../state/sync';
import { PlaceSearch } from './PlaceSearch';
import { PresetsMenu } from './PresetsMenu';
import { Section } from './Section';

const SEARCH_ID = 'place-search-input';
const LARGE_AREA_KM2 = 25;

function areaSummary(placeName: string, shape: AreaShape, widthM: number, heightM: number): string {
  const size = formatSizePair(widthM, heightM);
  return placeName ? `${placeName} · ${size}` : `${SHAPE_LABELS[shape]} · ${size}`;
}

function SizeInput({ label, valueM, unit, onChange }: { label: string; valueM: number; unit: SizeUnit; onChange: (m: number) => void }) {
  const id = useId();
  const km = unit === 'km';
  return (
    <div className="size-field">
      <label htmlFor={id} className="size-label">
        {label}
      </label>
      <NumberInput
        id={id}
        value={valueM}
        onChange={onChange}
        scale={km ? 0.001 : 1}
        decimals={km ? 2 : 0}
        step={km ? 0.01 : 10}
        min={km ? MIN_SIDE_M / 1000 : MIN_SIDE_M}
        max={km ? MAX_SIDE_M / 1000 : MAX_SIDE_M}
        unit={unit}
      />
    </div>
  );
}

export function AreaPanel() {
  const area = useApp((state) => state.area);
  const placeName = useApp((state) => state.placeName);
  const unit = useApp((state) => state.ui.sizeUnit);
  const problem = validateArea(area);
  const km2 = areaKm2(area);

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
      setArea((current) => areaForBounds(bounds, current), { focus: 'always', placeName: '' });
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
    if (next) setArea(next);
  }

  async function copyLink() {
    writeHashNow();
    toast((await copyText(shareUrl(area))) ? 'Share link copied' : 'Could not copy to the clipboard', 'info');
  }

  return (
    <Section id="area" title="Area" summary={areaSummary(placeName, area.shape, area.widthM, area.heightM)}>
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
            ]}
          />
        </div>
        <div className="size-grid">
          {area.shape === 'circle' ? (
            <SizeInput label="Diameter" valueM={area.widthM} unit={unit} onChange={(m) => setSize('width', m)} />
          ) : (
            <>
              <SizeInput label="Width" valueM={area.widthM} unit={unit} onChange={(m) => setSize('width', m)} />
              <SizeInput label="Height" valueM={area.heightM} unit={unit} onChange={(m) => setSize('height', m)} />
            </>
          )}
        </div>
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
        help="Turns the area clockwise from north. The model is built square to the rotated area, so its top edge points this way. You can also drag the round handle above the area on the map."
        hint={
          area.rotationDeg !== 0 ? (
            <button type="button" className="link-btn" onClick={() => setArea((current) => ({ ...current, rotationDeg: 0 }))}>
              <RotateCcw size={12} aria-hidden="true" />
              Point north again
            </button>
          ) : undefined
        }
      />

      {area.shape === 'rounded' && (
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
      {!problem && km2 > LARGE_AREA_KM2 && (
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
