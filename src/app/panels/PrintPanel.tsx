import { CircleCheck, TriangleAlert } from 'lucide-react';
import { BAMBU_MAX_PLATES, MAX_SECTIONS } from '../../core/export/sections';
import { effectiveScale } from '../../core/geo/area';
import { modelFieldRange, PRINTERS } from '../../core/settings';
import type { Printer } from '../../core/settings';
import { NumberField } from '../components/NumberField';
import { SelectField } from '../components/Fields';
import { formatMmPair, formatNumber, formatRatio } from '../lib/format';
import { bedFit } from '../state/derived';
import type { BedFit } from '../state/derived';
import { patchExport, patchSettings, setPrintedSide, useApp } from '../state/store';
import { ScaleAndSize } from './ScaleAndSize';
import { Section } from './Section';

const VENDORS: Printer['vendor'][] = ['Bambu Lab', 'Prusa', 'Other'];

function printerOptions() {
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

function fitSummary(fit: BedFit): string {
  if (fit.fits) return `fits the ${fit.printer.model.replace(/^Bambu Lab /, '')}`;
  return `${fit.plates} plates`;
}

export function PrintPanel() {
  const area = useApp((state) => state.area);
  const scale = useApp((state) => state.settings.scale);
  const baseThicknessMm = useApp((state) => state.settings.terrain.baseThicknessMm);
  const roads = useApp((state) => state.settings.roads);
  const settings = useApp((state) => state.settings);
  const exportSettings = useApp((state) => state.exportSettings);
  const fit = bedFit(area, settings, exportSettings);
  const mmPerMetre = effectiveScale(area, scale);
  const tiny = Math.max(fit.width, fit.depth) < 25;
  const bambu = exportSettings.format === 'bambu';
  const maxPlates = bambu ? BAMBU_MAX_PLATES : MAX_SECTIONS;

  const summary = `${formatRatio(mmPerMetre)} · ${formatMmPair(fit.width, fit.depth)} · ${fitSummary(fit)}`;
  // The longer side, without the rim, as Fit to size always took it.
  const fitBed = () => {
    const longest = Math.min(fit.printer.width, fit.printer.depth) - 20;
    // Unlocked, the area stays and the scale follows, as Fit to size always did.
    if (scale.mode === 'fit') patchSettings('scale', { fitMm: longest });
    else setPrintedSide(area.widthM >= area.heightM ? 'width' : 'height', longest);
  };

  return (
    <Section
      id="print"
      title="Size"
      summary={summary}
      badge={!fit.fits ? <span className="badge-dot badge-dot-warning" title="Larger than the bed" /> : undefined}
    >
      <ScaleAndSize />
      <p className="field-hint">
        At {formatRatio(mmPerMetre)} a {formatNumber(roads.minWidthMm, 2)} mm road is {formatNumber(roads.minWidthMm / mmPerMetre, 1)} m real. Large
        areas at a small scale lose detail: roads stay at the printable minimum width, so footpaths print as wide as main roads.
      </p>

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
        ) : fit.plates <= maxPlates ? (
          <div className="fit-status">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>
              Larger than the bed. Split it into {fit.plates} plates ({fit.cols} × {fit.rows} grid) or reduce the scale.
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
            {bambu
              ? `Too large even for ${BAMBU_MAX_PLATES} plates, the most a Bambu Studio project holds. Reduce the scale or the area.`
              : `Too large even for ${MAX_SECTIONS} sections. Reduce the scale or the area.`}
          </p>
        )}
      </div>
      <p className="field-hint">
        <button type="button" className="link-btn" onClick={fitBed}>
          Fit the {fit.printer.model.replace(/^Bambu Lab /, '')} bed
        </button>
        , leaving 10 mm around it. {scale.mode === 'fixed' ? 'The area grows or shrinks to match.' : 'The scale follows.'}
      </p>
      {tiny && <p className="field-hint">The print would be less than 25 mm across. Details this small may not print.</p>}

      <NumberField
        label="Base thickness"
        value={baseThicknessMm}
        onChange={(baseThicknessMm) => patchSettings('terrain', { baseThicknessMm })}
        {...modelFieldRange('terrain', 'baseThicknessMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Solid base below the lowest point of the terrain, including the floor under water."
      />
    </Section>
  );
}
