import { CircleAlert, Download, FileDown, Info, LoaderCircle } from 'lucide-react';
import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { printerByKey } from '../../core/settings';
import type { ExportFormat } from '../../core/settings';
import { NumberField } from '../components/NumberField';
import { SwitchField } from '../components/Fields';
import { exportModel } from '../state/actions';
import { autoFileBase, FORMAT_EXTENSIONS } from '../state/derived';
import { patchExport, setFileName, useApp } from '../state/store';
import { Section } from './Section';

interface FormatInfo {
  value: ExportFormat;
  title: string;
  short: string;
  description: string;
  recommended?: boolean;
}

export const FORMATS: FormatInfo[] = [
  {
    value: 'bambu',
    title: 'Bambu Studio project (.3mf)',
    short: 'Bambu Studio project',
    description: 'Plates, part names and a filament per colour, ready to slice.',
    recommended: true,
  },
  {
    value: 'prusa',
    title: 'PrusaSlicer project (.3mf)',
    short: 'PrusaSlicer project',
    description: 'One object with a part per colour, each on its own extruder.',
  },
  {
    value: '3mf',
    title: '3MF with colours (other slicers)',
    short: '3MF with colours',
    description: 'Standard 3MF with the colour stored on each part.',
  },
  {
    value: 'stl-zip',
    title: 'STL, one file per colour (.zip)',
    short: 'STL per colour',
    description: 'Works in any slicer. Load all files together as one object.',
  },
  {
    value: 'stl',
    title: 'Single STL',
    short: 'Single STL',
    description: 'Everything in one file, for single-colour printing.',
  },
];

const NEXT_STEPS: Record<ExportFormat, string[]> = {
  bambu: [
    'Open the file in Bambu Studio with File > Open Project, not Import.',
    'Check that each colour is mapped to the right filament and AMS slot.',
    'Pick your actual filaments, recalculate the flushing volumes, then slice.',
  ],
  prusa: [
    'Open the file in PrusaSlicer, or drag it onto the plate.',
    'Each colour is a part on its own extruder. Set the filament for each extruder.',
    'Slice and check the preview before printing.',
  ],
  '3mf': [
    'Open the file in your slicer. Each colour is a separate part with its colour stored.',
    'If your slicer does not assign filaments by colour, set one per part.',
  ],
  'stl-zip': [
    'Unzip the files. Each file is one colour, and all files share one position.',
    'PrusaSlicer and OrcaSlicer: import all files at once and answer Yes to loading them as one object with several parts. Then set each part’s filament.',
    'Cura: open all files, set each model’s extruder, select all and use Merge Models to keep their positions.',
  ],
  stl: ['Open the file in any slicer. Every part is in one file, so it prints in one colour.'],
};

function FormatCards() {
  const format = useApp((state) => state.exportSettings.format);
  const ref = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = FORMATS.findIndex((item) => item.value === format);
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    const next = FORMATS[(index + step + FORMATS.length) % FORMATS.length];
    patchExport({ format: next.value });
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[FORMATS.indexOf(next)]?.focus();
  }

  return (
    <div ref={ref} className="format-cards" role="radiogroup" aria-label="File format" onKeyDown={onKeyDown}>
      {FORMATS.map((item) => {
        const selected = item.value === format;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`format-card${selected ? ' is-selected' : ''}`}
            onClick={() => patchExport({ format: item.value })}
          >
            <span className="format-radio" aria-hidden="true" />
            <span className="format-text">
              <span className="format-title">
                {item.title}
                {item.recommended && <span className="tag">Recommended</span>}
              </span>
              <span className="format-description">{item.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function DownloadButton({ compact = false, primary = true }: { compact?: boolean; primary?: boolean }) {
  const result = useApp((state) => state.generation.result);
  const generating = useApp((state) => state.generation.status === 'running');
  const exporting = useApp((state) => state.exporting);
  const format = useApp((state) => state.exportSettings.format);
  const hidden = useApp((state) => state.ui.hiddenParts);
  const allHidden = result ? result.parts.every((part) => hidden.includes(part.id)) : false;
  const running = exporting.status === 'running';
  const disabled = !result || generating || running || allHidden || !result.exportable;
  const extension = FORMAT_EXTENSIONS[format];
  const label = running
    ? `Preparing${exporting.progress ? ` ${Math.round(exporting.progress.fraction * 100)}%` : ''}`
    : compact
      ? `Download ${extension}`
      : `Download ${extension} file`;
  return (
    <button
      type="button"
      className={`btn btn-lg ${primary ? 'btn-primary' : 'btn-secondary'}${compact ? '' : ' btn-block'}`}
      disabled={disabled}
      aria-busy={running}
      onClick={() => void exportModel()}
    >
      {running ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
      {label}
    </button>
  );
}

export function ExportPanel() {
  const exportSettings = useApp((state) => state.exportSettings);
  const placeName = useApp((state) => state.placeName);
  const fileName = useApp((state) => state.fileName);
  const result = useApp((state) => state.generation.result);
  const generating = useApp((state) => state.generation.status === 'running');
  const exporting = useApp((state) => state.exporting);
  const hidden = useApp((state) => state.ui.hiddenParts);
  const fileId = useId();
  const printer = printerByKey(exportSettings.printer);
  const format = FORMATS.find((item) => item.value === exportSettings.format)!;
  const extension = FORMAT_EXTENSIONS[exportSettings.format];
  const hiddenNames = result ? result.parts.filter((part) => hidden.includes(part.id)).map((part) => part.name) : [];
  const last = exporting.last;

  return (
    <Section id="export" title="Export" icon={<FileDown size={16} />} summary={`${format.short} · ${printer.model.replace(/^Bambu Lab /, '')}`}>
      <FormatCards />
      {exportSettings.format === 'bambu' && printer.vendor !== 'Bambu Lab' && (
        <p className="field-hint">
          Your printer is not a Bambu Lab printer. The project starts from Bambu P1S settings on your bed size. The {printer.vendor === 'Prusa' ? 'PrusaSlicer project' : 'STL per colour'} format may suit your slicer better.
        </p>
      )}

      <SwitchField
        label="Multi-plate export"
        checked={exportSettings.multiPlate}
        onChange={(multiPlate) => patchExport({ multiPlate })}
        help="Split the model into sections that each fit the bed, one per plate or set of files. No connectors or gaps are added between sections."
      />
      {exportSettings.multiPlate && (
        <div className="nested">
          <NumberField
            label="Section width"
            value={exportSettings.sectionWidthMm}
            onChange={(sectionWidthMm) => patchExport({ sectionWidthMm })}
            min={20}
            max={printer.width}
            step={5}
            decimals={1}
            unit="mm"
            help="Largest section size across the model, at most the bed width. Does not change the scale."
          />
          <NumberField
            label="Section depth"
            value={exportSettings.sectionHeightMm}
            onChange={(sectionHeightMm) => patchExport({ sectionHeightMm })}
            min={20}
            max={printer.depth}
            step={5}
            decimals={1}
            unit="mm"
            help="Largest section size from front to back, at most the bed depth. Does not change the scale."
          />
        </div>
      )}

      <div className="field field-stacked">
        <div className="field-row">
          <label className="field-label" htmlFor={fileId}>
            File name
          </label>
        </div>
        <div className="file-name">
          <input
            id={fileId}
            className="text-input"
            value={fileName ?? ''}
            placeholder={autoFileBase(placeName)}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setFileName(event.target.value || null)}
          />
          <span className="file-extension">{extension}</span>
        </div>
      </div>

      <DownloadButton />
      {!result && <p className="field-hint center">Generate a model first.</p>}
      {result && generating && <p className="field-hint center">Wait for the new model to finish.</p>}
      {result && !result.exportable && (
        <p className="field-hint center">The generator was restarted, so generate the model again before downloading.</p>
      )}
      {hiddenNames.length > 0 && (
        <p className="field-hint">
          Left out because they are hidden in the 3D view: {hiddenNames.join(', ')}.
        </p>
      )}

      {exporting.error && (
        <div className="notice notice-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>Export failed: {exporting.error}</span>
        </div>
      )}

      {last && (
        <div className="next-steps">
          <div className="next-steps-title">
            <Info size={15} aria-hidden="true" />
            Next steps for {last.fileName}
          </div>
          <ol>
            {NEXT_STEPS[last.format].map((step) => (
              <li key={step}>{step}</li>
            ))}
            {last.plates > 1 && <li>The model is split into {last.plates} plates. Print them one by one and fit them together.</li>}
          </ol>
          {last.warnings.length > 0 && (
            <ul className="warning-list">
              {last.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!last && (
        <details className="next-steps-preview">
          <summary>What to do with the file</summary>
          <ol>
            {NEXT_STEPS[exportSettings.format].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
      )}
    </Section>
  );
}
