import { CircleAlert, MapPin } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FillMode } from '../../core/svgmap/settings';
import { CUSTOM_FONT_ID, FONTS, fontInfo } from '../../core/svgmap/text/fonts';
import type { LabelPosition, LabelSettings } from '../../core/svgmap/text/label';
import { CheckField, Disclosure, SelectField, SliderField, TextField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
import { Segmented } from '../components/Segmented';
import { Section } from '../panels/Section';
import { setCustomFontName, setLabel, setSvgStyle, useApp } from '../state/store';
import { checkFont, storeFont } from './customFont';

const POSITIONS: { value: LabelPosition; label: string }[] = [
  { value: 'lower_right', label: 'Bottom right' },
  { value: 'lower_left', label: 'Bottom left' },
  { value: 'lower_center', label: 'Bottom centre' },
  { value: 'upper_right', label: 'Top right' },
  { value: 'upper_left', label: 'Top left' },
  { value: 'upper_center', label: 'Top centre' },
];

const LETTERING: Record<FillMode, string> = {
  fill: 'Filled',
  outline: 'Outline',
  hatch: 'Hatched',
  'hatch-outline': 'Hatched with outline',
};

const LOAD_FONT = '__load';

function FontOptions({ customName }: { customName: string | null }) {
  return (
    <>
      <optgroup label="Outline fonts">
        {FONTS.filter((f) => f.kind === 'outline').map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} ({f.note.toLowerCase()})
          </option>
        ))}
      </optgroup>
      <optgroup label="Single-line fonts">
        {FONTS.filter((f) => f.kind === 'stroke').map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} ({f.note.toLowerCase()})
          </option>
        ))}
      </optgroup>
      <optgroup label="Your font">
        {customName && <option value={CUSTOM_FONT_ID}>{customName}</option>}
        <option value={LOAD_FONT}>Load a font file…</option>
      </optgroup>
    </>
  );
}

function coordinates(lat: number, lon: number) {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}

const percent = (value: number) => `${Math.round(value)}%`;

export function TitlePanel() {
  const label = useApp((state) => state.svg.label);
  const mode = useApp((state) => state.svg.mode);
  const fillModes = useApp((state) => state.svg.styles[state.svg.mode].fillModes);
  const customFontName = useApp((state) => state.customFontName);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingField = useRef<'font' | 'subtitleFont'>('font');
  const [fontError, setFontError] = useState('');

  const set = (patch: Partial<LabelSettings>) => setLabel(patch);
  const chooseFont = (field: 'font' | 'subtitleFont', id: string) => {
    if (id === LOAD_FONT) {
      pendingField.current = field;
      fileInput.current?.click();
      return;
    }
    setFontError('');
    set({ [field]: id });
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const data = await file.arrayBuffer();
    const problem = await checkFont(data);
    setFontError(problem ?? '');
    if (problem) return;
    const name = file.name.replace(/\.(ttf|otf|woff)$/i, '');
    await storeFont({ name, data });
    setCustomFontName(name);
    set({ [pendingField.current]: CUSTOM_FONT_ID });
  };

  const band = label.style === 'band';
  const modes: FillMode[] = mode === 'plotter' ? ['outline', 'hatch', 'hatch-outline'] : ['fill', 'outline', 'hatch', 'hatch-outline'];
  const lettering = mode === 'plotter' && fillModes.text === 'fill' ? 'hatch-outline' : fillModes.text;
  const singleLine = fontInfo(label.font)?.kind === 'stroke';

  return (
    <Section id="title" title="Title" summary={label.enabled && label.text.trim() ? label.text : 'Off'}>
      <CheckField label="Show a title" checked={label.enabled} onChange={(enabled) => set({ enabled })} />
      {label.enabled && (
        <>
          <TextField label="Text" value={label.text} onChange={(text) => set({ text })} help="Searching for a place or picking a preset fills this in." />
          <div className="field-group">
            <div className="group-label">Style</div>
            <Segmented<'box' | 'band'>
              label="Title style"
              value={label.style}
              stretch
              onChange={(style) => set({ style })}
              options={[
                { value: 'box', label: 'Box', title: 'One line in a box in a corner or at the top or bottom' },
                { value: 'band', label: 'Band', title: 'A strip across the piece, with an optional subtitle' },
              ]}
            />
          </div>
          {band ? (
            <>
              <TextField label="Subtitle" value={label.subtitle} placeholder="Optional" onChange={(subtitle) => set({ subtitle })} />
              <button
                type="button"
                className="btn btn-sm align-start"
                onClick={() => {
                  const [lon, lat] = useApp.getState().area.center;
                  set({ subtitle: coordinates(lat, lon) });
                }}
              >
                <MapPin size={14} aria-hidden="true" />
                Use the coordinates
              </button>
              <div className="field-group">
                <div className="group-label">Position</div>
                <Segmented<'top' | 'bottom'>
                  label="Band position"
                  value={label.bandPosition}
                  stretch
                  onChange={(bandPosition) => set({ bandPosition })}
                  options={[
                    { value: 'top', label: 'Top' },
                    { value: 'bottom', label: 'Bottom' },
                  ]}
                />
              </div>
            </>
          ) : (
            <SelectField label="Position" value={label.position} onChange={(position) => set({ position: position as LabelPosition })}>
              {POSITIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </SelectField>
          )}
          <SelectField label="Font" value={label.font} onChange={(id) => chooseFont('font', id)} stacked help="Single-line fonts draw each letter as one stroke, the way a pen writes. You can also load a TTF, OTF or WOFF file.">
            <FontOptions customName={customFontName} />
          </SelectField>
          {fontError && (
            <div className="notice notice-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{fontError}</span>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".ttf,.otf,.woff"
            hidden
            onChange={(event) => {
              void onFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <SliderField label="Size" value={label.size} onChange={(size) => set({ size })} min={40} max={250} step={5} format={percent} />
          <SelectField label="Lettering" value={lettering} onChange={(m) => setSvgStyle({ fillModes: { ...fillModes, text: m as FillMode } })}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {LETTERING[m]}
              </option>
            ))}
          </SelectField>
          {singleLine && <p className="field-hint">Single-line fonts are always drawn as strokes.</p>}

          {band ? (
            <>
              <SliderField label="Band height" value={label.bandHeight} onChange={(bandHeight) => set({ bandHeight })} min={5} max={50} step={1} format={percent} />
              <div className="field-group">
                <div className="group-label">Alignment</div>
                <Segmented<'left' | 'center' | 'right'>
                  label="Alignment"
                  value={label.bandAlign}
                  stretch
                  onChange={(bandAlign) => set({ bandAlign })}
                  options={[
                    { value: 'left', label: 'Left' },
                    { value: 'center', label: 'Centre' },
                    { value: 'right', label: 'Right' },
                  ]}
                />
              </div>
              <SliderField
                label="Letter spacing"
                value={label.titleSpacing * 100}
                onChange={(value) => set({ titleSpacing: value / 100 })}
                min={80}
                max={200}
                step={5}
                format={percent}
              />
              <CheckField label="Divider line" checked={label.divider} onChange={(divider) => set({ divider })} />
            </>
          ) : (
            <>
              <div className="field-group">
                <div className="group-label">Rotation</div>
                <Segmented<'0' | '90' | '180' | '270'>
                  label="Title rotation"
                  value={String(label.rotation) as '0' | '90' | '180' | '270'}
                  stretch
                  onChange={(r) => set({ rotation: Number(r) as LabelSettings['rotation'] })}
                  options={[
                    { value: '0', label: '0°' },
                    { value: '90', label: '90°' },
                    { value: '180', label: '180°' },
                    { value: '270', label: '270°' },
                  ]}
                />
              </div>
              <CheckField label="Box outline" checked={label.boxBorder} onChange={(boxBorder) => set({ boxBorder })} />
            </>
          )}

          <Disclosure label="Measurements">
            {band ? (
              <>
                <NumberField label="Title height" value={label.titleHeight} onChange={(titleHeight) => set({ titleHeight })} min={0.5} max={100} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Max width" value={label.bandMaxWidth} onChange={(bandMaxWidth) => set({ bandMaxWidth })} min={1} max={100} step={1} decimals={0} unit="%" />
                <NumberField label="Subtitle height" value={label.subtitleHeight} onChange={(subtitleHeight) => set({ subtitleHeight })} min={0.5} max={50} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Subtitle gap" value={label.subtitleGap} onChange={(subtitleGap) => set({ subtitleGap })} min={0} max={50} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Padding, sides" value={label.bandPaddingX} onChange={(bandPaddingX) => set({ bandPaddingX })} min={0} max={50} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Padding, top and bottom" value={label.bandPaddingY} onChange={(bandPaddingY) => set({ bandPaddingY })} min={0} max={50} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Subtitle spacing" value={label.subtitleSpacing} onChange={(subtitleSpacing) => set({ subtitleSpacing })} min={80} max={300} step={5} decimals={0} scale={100} unit="%" />
                <NumberField label="Divider width" value={label.dividerWidth} onChange={(dividerWidth) => set({ dividerWidth })} min={0.01} max={3} step={0.05} decimals={2} unit="mm" />
                <SelectField label="Subtitle font" value={label.subtitleFont || ''} onChange={(id) => chooseFont('subtitleFont', id)} stacked>
                  <option value="">Same as the title</option>
                  <FontOptions customName={customFontName} />
                </SelectField>
              </>
            ) : (
              <>
                <NumberField label="Text height" value={label.textHeight} onChange={(textHeight) => set({ textHeight })} min={0.5} max={100} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Max width" value={label.maxWidth} onChange={(maxWidth) => set({ maxWidth })} min={1} max={500} step={1} decimals={1} unit="mm" />
                <NumberField label="Padding, sides" value={label.paddingX} onChange={(paddingX) => set({ paddingX })} min={0} max={30} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Padding, top and bottom" value={label.paddingY} onChange={(paddingY) => set({ paddingY })} min={0} max={30} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Outline width" value={label.borderWidth} onChange={(borderWidth) => set({ borderWidth })} min={0.01} max={5} step={0.05} decimals={2} unit="mm" />
                <NumberField label="Gap from border" value={label.gap} onChange={(gap) => set({ gap })} min={0} max={50} step={0.1} decimals={2} unit="mm" />
                <NumberField label="Text size in box" value={label.textScale} onChange={(textScale) => set({ textScale })} min={10} max={100} step={1} decimals={0} scale={100} unit="%" />
              </>
            )}
          </Disclosure>
        </>
      )}
    </Section>
  );
}
