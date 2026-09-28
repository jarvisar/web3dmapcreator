import { CircleCheck, Ruler, TriangleAlert } from 'lucide-react';
import { effectiveScale } from '../../core/geo/area';
import { PRINTERS } from '../../core/settings';
import type { Printer } from '../../core/settings';
import { NumberField } from '../components/NumberField';
import { SelectField } from '../components/Fields';
import { Segmented } from '../components/Segmented';
import { formatMmPair, formatNumber, formatRatio } from '../lib/format';
import { bedFit } from '../state/derived';
import type { BedFit } from '../state/derived';
import { patchExport, patchSettings, useApp } from '../state/store';
import { Section } from './Section';

const RATIOS = [5000, 10000, 14286, 25000, 50000];
const MAX_PLATES = 36;

function ratioScale(ratio: number): number {
  // 1:14,286 is the add-on's 0.07 mm per metre exactly.
  return ratio === 14286 ? 0.07 : 1000 / ratio;
}

const VENDORS: Printer['vendor'][] = ['Bambu Lab', 'Prusa', 'Other'];

export function printerOptions() {
  return VENDORS.map((vendor) => (
    <optgroup key={vendor} label={vendor}>
      {PRINTERS.filter((printer) => printer.vendor === vendor).map((printer) => (
        <option key={printer.key} value={printer.key}>
          {printer.model.replace(/^Bambu Lab |^Prusa /, '')} · {printer.width} × {printer.depth} mm
        </option>
      ))}
    </optgroup>
  ));
}

export function fitSummary(fit: BedFit): string {
  if (fit.fits) return `fits the ${fit.printer.model.replace(/^Bambu Lab /, '')}`;
  return `${fit.plates} plates`;
}

export function PrintPanel() {
  const area = useApp((state) => state.area);
  const scale = useApp((state) => state.settings.scale);
  const terrain = useApp((state) => state.settings.terrain);
  const roads = useApp((state) => state.settings.roads);
  const settings = useApp((state) => state.settings);
  const exportSettings = useApp((state) => state.exportSettings);
  const fit = bedFit(area, settings, exportSettings);
  const mmPerMetre = effectiveScale(area, scale);
  const tiny = Math.max(fit.width, fit.depth) < 25;

  const summary = `${formatRatio(mmPerMetre)} · ${formatMmPair(fit.width, fit.depth)} · ${fitSummary(fit)}`;

  return (
    <Section
      id="print"
      title="Print size"
      icon={<Ruler size={16} />}
      summary={summary}
      badge={!fit.fits ? <span className="badge-dot badge-dot-warning" title="Larger than the bed" /> : undefined}
    >
      <Segmented
        label="Scale mode"
        value={scale.mode}
        stretch
        onChange={(mode) => patchSettings('scale', { mode })}
        options={[
          { value: 'fixed', label: 'Fixed scale' },
          { value: 'fit', label: 'Fit to size' },
        ]}
      />

      {scale.mode === 'fixed' ? (
        <>
          <NumberField
            label="Scale"
            value={scale.mmPerMetre}
            onChange={(mmPerMetre) => patchSettings('scale', { mmPerMetre })}
            min={0.001}
            max={2}
            step={0.005}
            decimals={4}
            unit="mm/m"
            help="Printed millimetres per real metre. At 0.07 (1:14,286) a 6.5 m street prints 0.455 mm wide, about the narrowest line a 0.4 mm nozzle prints well. The model is whatever size that makes."
            hint={
              <span>
                {formatRatio(scale.mmPerMetre)} · a {formatNumber(roads.minWidthMm, 2)} mm road is {formatNumber(roads.minWidthMm / scale.mmPerMetre, 1)} m real
              </span>
            }
          />
          <div className="chips" role="group" aria-label="Common scales">
            {RATIOS.map((ratio) => {
              const value = ratioScale(ratio);
              const selected = Math.abs(scale.mmPerMetre - value) < 1e-6;
              return (
                <button
                  key={ratio}
                  type="button"
                  className={`chip-btn${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => patchSettings('scale', { mmPerMetre: value })}
                >
                  {formatRatio(value)}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <NumberField
          label="Longest side"
          value={scale.fitMm}
          onChange={(fitMm) => patchSettings('scale', { fitMm })}
          min={20}
          max={2000}
          step={5}
          decimals={1}
          unit="mm"
          help="Printed length of the longer side of the area. The scale then depends on the area. Large areas at a small scale lose detail: roads stay at the printable minimum width, so footpaths print as wide as main roads."
          hint={
            <span>
              Works out to {formatRatio(mmPerMetre)}.{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => patchSettings('scale', { fitMm: Math.min(fit.printer.width, fit.printer.depth) - 20 })}
              >
                Fit the {fit.printer.model.replace(/^Bambu Lab /, '')} bed
              </button>
            </span>
          }
        />
      )}

      <SelectField
        label="Printer"
        value={exportSettings.printer}
        onChange={(printer) => patchExport({ printer })}
        help="Sets the bed size, how a large model is split into plates, and the starting presets of a Bambu Studio project."
        stacked
      >
        {printerOptions()}
      </SelectField>

      <div className={`fit-card ${fit.fits ? 'is-ok' : 'is-over'}`}>
        <div className="fit-size">
          <span className="fit-label">Model</span>
          <span className="fit-value">{formatMmPair(fit.width, fit.depth)}</span>
          <span className="fit-label">Bed</span>
          <span className="fit-value">
            {fit.printer.width} × {fit.printer.depth} mm
          </span>
        </div>
        {fit.fits ? (
          <p className="fit-status">
            <CircleCheck size={15} aria-hidden="true" />
            {fit.rotated ? 'Fits the bed when turned 90°.' : 'Fits the bed.'}
          </p>
        ) : fit.plates <= MAX_PLATES ? (
          <div className="fit-status">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>
              Larger than the bed. Split it into {fit.plates} plates ({fit.cols} × {fit.rows}) or reduce the scale.
              {!exportSettings.multiPlate && (
                <>
                  {' '}
                  <button type="button" className="link-btn" onClick={() => patchExport({ multiPlate: true })}>
                    Turn on multi-plate export
                  </button>
                </>
              )}
            </span>
          </div>
        ) : (
          <p className="fit-status">
            <TriangleAlert size={15} aria-hidden="true" />
            Too large even for {MAX_PLATES} plates. Reduce the scale or the area.
          </p>
        )}
      </div>
      {tiny && <p className="field-hint">The print would be less than 25 mm across. Details this small may not print.</p>}

      <NumberField
        label="Base thickness"
        value={terrain.baseThicknessMm}
        onChange={(baseThicknessMm) => patchSettings('terrain', { baseThicknessMm })}
        min={0.1}
        max={20}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Solid base below the lowest point of the terrain."
      />
      <NumberField
        label="Terrain exaggeration"
        value={terrain.exaggeration}
        onChange={(exaggeration) => patchSettings('terrain', { exaggeration })}
        min={0}
        max={10}
        step={0.1}
        decimals={2}
        unit="×"
        disabled={!terrain.elevation}
        help="Multiplies real height differences in the terrain. 1 is true to scale. Flat cities often look better at 1.5 to 3."
      />
    </Section>
  );
}
