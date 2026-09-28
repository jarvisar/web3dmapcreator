import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { MIN_SECTION_MM, printerByKey } from '../../core/settings';
import type { ExportFormat } from '../../core/settings';
import { CheckField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
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

const FORMATS: FormatInfo[] = [
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
    <div ref={ref} className="list-box" role="radiogroup" aria-label="File format" onKeyDown={onKeyDown}>
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

export function ExportPanel() {
  const exportSettings = useApp((state) => state.exportSettings);
  const placeName = useApp((state) => state.placeName);
  const fileName = useApp((state) => state.fileName);
  const last = useApp((state) => state.exporting.last);
  const fileId = useId();
  const printer = printerByKey(exportSettings.printer);
  const format = FORMATS.find((item) => item.value === exportSettings.format)!;
  const extension = FORMAT_EXTENSIONS[exportSettings.format];
  const done = last?.format === exportSettings.format ? last : null;

  return (
    <Section id="export" title="Export" summary={`${format.short} · ${printer.model.replace(/^Bambu Lab /, '')}`}>
      <FormatCards />
      {exportSettings.format === 'bambu' && printer.vendor !== 'Bambu Lab' && (
        <p className="field-hint">
          Your printer is not a Bambu Lab printer. The project starts from Bambu P1S settings on your bed size. The {printer.vendor === 'Prusa' ? 'PrusaSlicer project' : 'STL per colour'} format may suit your slicer better.
        </p>
      )}

      <CheckField
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
            min={MIN_SECTION_MM}
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
            min={MIN_SECTION_MM}
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

      <div className={`next-steps${done ? ' is-done' : ''}`}>
        <div className="next-steps-title">{done ? `Downloaded ${done.fileName}. Next:` : 'After downloading'}</div>
        <ol>
          {NEXT_STEPS[exportSettings.format].map((step) => (
            <li key={step}>{step}</li>
          ))}
          {done && done.plates > 1 && <li>The model is split into {done.plates} plates. Print them one by one and fit them together.</li>}
        </ol>
        {done && done.warnings.length > 0 && (
          <ul className="warning-list">
            {done.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
