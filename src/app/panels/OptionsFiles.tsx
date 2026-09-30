import { Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { hasEdits } from '../../core/edit/types';
import { CheckField } from '../components/Fields';
import { CUSTOM_FONT_ID } from '../../core/svgmap/text/fonts';
import { downloadBlob } from '../lib/browser';
import { decodeOptions, encodeOptions, MAX_OPTIONS_BYTES, OPTIONS_TOO_BIG, type Options } from '../state/options';
import { applyOptions, toast, useApp } from '../state/store';

const usesCustomFont = ({ svg }: Options) => svg.label.font === CUSTOM_FONT_ID || svg.label.subtitleFont === CUSTOM_FONT_ID;

export function OptionsFiles() {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [includeArea, setIncludeArea] = useState(true);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      if (file.size > MAX_OPTIONS_BYTES) throw new Error(OPTIONS_TOO_BIG);
      const options = decodeOptions(await file.text());
      applyOptions(options, includeArea);
      const message = options.map && includeArea ? 'Options and map area imported' : 'Options imported';
      toast(usesCustomFont(options) ? `${message}. Custom font files are separate; load the matching font under Title.` : message, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not read the options file.', 'error');
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="options-files">
      <div className="options-file-buttons">
        <button type="button" className="btn" onClick={() => {
          const state = useApp.getState();
          const edits = hasEdits(state.edits) ? { edits: state.edits } : {};
          const map = includeArea ? { area: state.area, placeName: state.placeName, fileName: state.fileName, ...edits } : undefined;
          downloadBlob(new Blob([encodeOptions(state, map)], { type: 'application/json' }), 'city-model-options.json');
          if (usesCustomFont(state)) toast('Options exported. Custom font files need to be copied separately.', 'info');
        }}>
          <Download size={14} aria-hidden="true" /> Export options
        </button>
        <button type="button" className="btn" disabled={reading} onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden="true" /> {reading ? 'Importing…' : 'Import options'}
        </button>
      </div>
      <CheckField label="Include map area" checked={includeArea} onChange={setIncludeArea} />
      <p className="options-file-help">Save or load options as a JSON file. With the map area, edits made in the 3D view go too. Uncheck to keep the current location and shape. SVG area size follows the piece and scale.</p>
      <input ref={input} type="file" accept=".json,application/json" hidden aria-label="Import options file" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        void onImport(file);
      }} />
    </div>
  );
}
