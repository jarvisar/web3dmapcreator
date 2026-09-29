import { LASER_PALETTES, type OutputMode, PRINT_THEMES } from '../../core/svgmap/settings';
import { CheckField, ColourField, SelectField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
import { Segmented } from '../components/Segmented';
import { Section } from '../panels/Section';
import { setLaserPalette, setPlotter, setPrintTheme, setSvgMode, setSvgStyle, useApp } from '../state/store';
import type { LaserPalette } from './settings';

const MODE_NAMES: Record<OutputMode, string> = { laser: 'Laser', plotter: 'Plotter', print: 'Print' };

const MODE_HINTS: Record<OutputMode, string> = {
  laser: 'Filled areas engrave, lines score and the outline cuts. Each layer gets its own colour so it can have its own process.',
  plotter: 'Everything is a stroke. Filled areas are hatched and each pen colour is a numbered layer.',
  print: 'Filled areas and road widths styled for printing or the screen.',
};

export function OutputPanel() {
  const mode = useApp((state) => state.svg.mode);
  const style = useApp((state) => state.svg.styles[state.svg.mode]);
  const palette = useApp((state) => state.svg.laserPalette);
  const theme = useApp((state) => state.svg.printTheme);
  const plotter = useApp((state) => state.svg.plotter);

  return (
    <Section id="output" title="Output" summary={MODE_NAMES[mode]}>
      <Segmented<OutputMode>
        label="Output"
        value={mode}
        stretch
        onChange={setSvgMode}
        options={[
          { value: 'laser', label: 'Laser' },
          { value: 'plotter', label: 'Plotter' },
          { value: 'print', label: 'Print' },
        ]}
      />
      <p className="field-hint">{MODE_HINTS[mode]}</p>

      {mode === 'laser' && (
        <SelectField
          label="Colours"
          value={palette}
          onChange={(value) => setLaserPalette(value as LaserPalette)}
          stacked
          help="LightBurn layer palette puts each layer on its own LightBurn layer. Minimal gives three processes: engrave, score and cut."
        >
          {Object.entries(LASER_PALETTES).map(([value, p]) => (
            <option key={value} value={value}>
              {p.name}
            </option>
          ))}
        </SelectField>
      )}

      {mode === 'plotter' && (
        <>
          <NumberField
            label="Pen width"
            value={plotter.penWidth}
            onChange={(penWidth) => setPlotter({ penWidth })}
            min={0.05}
            max={3}
            step={0.05}
            decimals={2}
            unit="mm"
            help="Sets the stroke width in the file, and the line spacing of the cleanup presets."
          />
          <CheckField label="Order strokes to cut pen travel" checked={plotter.optimize} onChange={(optimize) => setPlotter({ optimize })} />
        </>
      )}

      {mode === 'print' && (
        <>
          <SelectField label="Theme" value={theme} onChange={setPrintTheme}>
            {Object.entries(PRINT_THEMES).map(([value, t]) => (
              <option key={value} value={value}>
                {t.name}
              </option>
            ))}
          </SelectField>
          {style.background !== null && (
            <ColourField label="Background" value={style.background} onChange={(background) => setSvgStyle({ background })} />
          )}
          <CheckField
            label="Transparent background"
            checked={style.background === null}
            onChange={(transparent) => setSvgStyle({ background: transparent ? null : '#FFFFFF' })}
          />
          <CheckField label="Wider lines for bigger roads" checked={style.classWidths} onChange={(classWidths) => setSvgStyle({ classWidths })} />
        </>
      )}

      <CheckField label="Cut line around the edge" checked={style.cut} onChange={(cut) => setSvgStyle({ cut })} />
    </Section>
  );
}
