import { fieldRange } from '../../core/svgmap/limits';
import { useId } from 'react';
import type { ReactNode } from 'react';
import {
  type FillLayerId,
  type FillMode,
  LAYER_NAMES,
  type LayerId,
  type LineLayerId,
  type OutputMode,
} from '../../core/svgmap/settings';
import type { FeatureFilters } from '../../core/svgmap/tiles/schema';
import { Checkbox } from '../components/Checkbox';
import { CheckField, ColourField, SelectField } from '../components/Fields';
import { NumberField } from '../components/NumberField';
import { formatNumber } from '../lib/format';
import { Section } from '../panels/Section';
import { patchSvg, setFilters, setSvgStyle, toggleLayer, useApp } from '../state/store';

const FILL_ORDER: FillLayerId[] = ['buildings', 'water', 'greens', 'sand', 'rocks', 'aeroways', 'decks'];
const LINE_ORDER: LineLayerId[] = ['roads', 'paths', 'railways', 'waterways', 'raceways'];

type FilterToggle = { label: string; get: (f: FeatureFilters) => boolean; set: (f: FeatureFilters, v: boolean) => FeatureFilters };

const toggle = <G extends keyof FeatureFilters>(group: G, key: string, label: string): FilterToggle => ({
  label,
  get: (f) => (f[group] as Record<string, boolean>)[key],
  set: (f, v) => ({ ...f, [group]: { ...(f[group] as object), [key]: v } }),
});

const FILTERS: Partial<Record<LayerId, FilterToggle[]>> = {
  roads: [
    toggle('roads', 'service', 'Service roads'),
    toggle('roads', 'parkingAisles', 'Parking aisles'),
    toggle('roads', 'driveways', 'Driveways'),
    toggle('roads', 'tracks', 'Tracks'),
    toggle('roads', 'pedestrian', 'Pedestrian streets'),
    toggle('roads', 'busways', 'Busways'),
  ],
  paths: [
    toggle('paths', 'footways', 'Footways and paths'),
    toggle('paths', 'cycleways', 'Cycleways'),
    toggle('paths', 'steps', 'Steps'),
    toggle('paths', 'bridleways', 'Bridleways'),
  ],
  railways: [toggle('railways', 'minor', 'Trams, light rail and metro'), toggle('railways', 'yards', 'Yards and sidings')],
  waterways: [toggle('waterways', 'streams', 'Streams and ditches'), toggle('waterways', 'rivers', 'Rivers and canals')],
  water: [toggle('water', 'pools', 'Swimming pools'), toggle('water', 'intermittent', 'Seasonal water')],
  greens: [
    toggle('greens', 'wetlands', 'Wetlands'),
    toggle('greens', 'pitches', 'Sports pitches'),
    toggle('greens', 'cemeteries', 'Cemeteries'),
  ],
  decks: [toggle('decks', 'bridges', 'Bridge decks')],
};

const FILL_MODE_LABELS: Record<FillMode, string> = {
  fill: 'Fill',
  outline: 'Outline',
  hatch: 'Hatch',
  'hatch-outline': 'Hatch and outline',
};

// A plotter draws "fill" as hatching with an outline.
const effectiveFillMode = (mode: FillMode, output: OutputMode): FillMode => (output === 'plotter' && mode === 'fill' ? 'hatch-outline' : mode);

const isHatched = (mode: FillMode) => mode === 'hatch' || mode === 'hatch-outline';

const mm = (value: number) => `${formatNumber(value, 2)} mm`;

interface RowProps {
  layer: LayerId;
  summary: string;
  help?: string;
  children: ReactNode;
}

function LayerRow({ layer, summary, help, children }: RowProps) {
  const key = `svg:${layer}`;
  const open = useApp((state) => state.ui.layers[key] ?? false);
  const on = useApp((state) => state.svg.layers[layer]);
  const colour = useApp((state) => state.svg.styles[state.svg.mode].colors[layer]);
  const bodyId = useId();
  const name = LAYER_NAMES[layer];
  return (
    <div className={`layer${on ? '' : ' is-off'}${open ? ' is-open' : ''}`}>
      <div className="layer-head">
        <Checkbox checked={on} onChange={(checked) => patchSvg((svg) => ({ layers: { ...svg.layers, [layer]: checked } }))} label={name} />
        <button type="button" className="layer-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => toggleLayer(key)}>
          <span className="dot" style={{ background: colour }} aria-hidden="true" />
          <span className="layer-name">{name}</span>
          <span className="layer-summary">{on ? summary : 'Off'}</span>
          <span className="triangle" aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="layer-body" id={bodyId}>
          {help && <p className="layer-help">{help}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

function Colour({ layer }: { layer: LayerId }) {
  const colour = useApp((state) => state.svg.styles[state.svg.mode].colors[layer]);
  const colors = useApp((state) => state.svg.styles[state.svg.mode].colors);
  return <ColourField label="Colour" value={colour} onChange={(hex) => setSvgStyle({ colors: { ...colors, [layer]: hex } })} />;
}

function FillStyle({ layer }: { layer: FillLayerId }) {
  const mode = useApp((state) => state.svg.mode);
  const style = useApp((state) => state.svg.styles[state.svg.mode]);
  const modes: FillMode[] = mode === 'plotter' ? ['outline', 'hatch', 'hatch-outline'] : ['fill', 'outline', 'hatch', 'hatch-outline'];
  const current = effectiveFillMode(style.fillModes[layer], mode);
  const h = style.hatch[layer];
  const update = (patch: Partial<typeof h>) => setSvgStyle({ hatch: { ...style.hatch, [layer]: { ...h, ...patch } } });
  return (
    <>
      <SelectField label="Style" value={current} onChange={(value) => setSvgStyle({ fillModes: { ...style.fillModes, [layer]: value as FillMode } })}>
        {modes.map((m) => (
          <option key={m} value={m}>
            {FILL_MODE_LABELS[m]}
          </option>
        ))}
      </SelectField>
      {isHatched(current) && (
        <>
          <NumberField label="Hatch spacing" value={h.spacing} onChange={(spacing) => update({ spacing })} {...fieldRange('style.hatch.*.spacing')} step={0.05} decimals={2} unit="mm" />
          <NumberField label="Hatch angle" value={h.angle} onChange={(angle) => update({ angle })} {...fieldRange('style.hatch.*.angle')} step={5} decimals={0} unit="°" />
          <CheckField label="Cross-hatch" checked={h.cross} onChange={(cross) => update({ cross })} />
        </>
      )}
    </>
  );
}

function Filters({ layer }: { layer: LayerId }) {
  const filters = useApp((state) => state.svg.filters);
  return (
    <>
      {(FILTERS[layer] ?? []).map((t) => (
        <CheckField key={t.label} label={t.label} checked={t.get(filters)} onChange={(v) => setFilters((f) => t.set(f, v))} />
      ))}
    </>
  );
}

function LineWidth({ layer }: { layer: LineLayerId }) {
  const lineWidths = useApp((state) => state.svg.styles[state.svg.mode].lineWidths);
  return (
    <NumberField
      label={layer === 'roads' ? 'Line width, minor roads' : 'Line width'}
      value={lineWidths[layer]}
      onChange={(w) => setSvgStyle({ lineWidths: { ...lineWidths, [layer]: w } })}
      {...fieldRange('style.lineWidths.*')}
      step={0.02}
      decimals={2}
      unit="mm"
    />
  );
}

function WaterOptions() {
  const water = useApp((state) => state.svg.water);
  return (
    <>
      <NumberField
        label="Gap around buildings"
        value={water.halo}
        onChange={(halo) => patchSvg({ water: { ...water, halo } })}
        {...fieldRange('water.halo')}
        step={0.025}
        decimals={3}
        unit="mm"
        help="Water is cut away around buildings, piers and plazas standing in it, so they don't merge into it. 0 turns it off."
      />
      <NumberField
        label="Gap under bridges"
        value={water.bridgeGap}
        onChange={(bridgeGap) => patchSvg({ water: { ...water, bridgeGap } })}
        {...fieldRange('water.bridgeGap')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Half the width of the gap cut in the water under road and rail bridges. 0 turns it off."
      />
    </>
  );
}

export function LayersPanel() {
  const layers = useApp((state) => state.svg.layers);
  const mode = useApp((state) => state.svg.mode);
  const style = useApp((state) => state.svg.styles[state.svg.mode]);
  const decks = useApp((state) => state.svg.decks);
  const skipTunnels = useApp((state) => state.svg.filters.skipTunnels);
  const count = Object.values(layers).filter(Boolean).length;

  const fillSummary = (layer: FillLayerId) => {
    if (layer === 'decks' && !decks.engrave) return 'Cut out of the water';
    const fill = effectiveFillMode(style.fillModes[layer], mode);
    return isHatched(fill) ? `${FILL_MODE_LABELS[fill]} ${mm(style.hatch[layer].spacing)}` : FILL_MODE_LABELS[fill];
  };
  const lineSummary = (layer: LineLayerId) => (mode === 'print' ? mm(style.lineWidths[layer]) : '');

  return (
    <Section id="svgLayers" title="Layers" summary={`${count} of ${Object.keys(layers).length}`}>
      <div className="field-group">
        <div className="group-label">Areas</div>
        <div className="list-box">
          {FILL_ORDER.map((layer) => (
            <LayerRow
              key={layer}
              layer={layer}
              summary={fillSummary(layer)}
              help={layer === 'decks' ? 'Piers and plazas are cut out of the water so they read as land.' : undefined}
            >
              {layer === 'decks' && (
                <CheckField label="Engrave them too" checked={decks.engrave} onChange={(engrave) => patchSvg({ decks: { ...decks, engrave } })} />
              )}
              {(layer !== 'decks' || decks.engrave) && (
                <>
                  <Colour layer={layer} />
                  <FillStyle layer={layer} />
                </>
              )}
              {layer === 'water' && <WaterOptions />}
              <Filters layer={layer} />
            </LayerRow>
          ))}
        </div>
      </div>
      <div className="field-group">
        <div className="group-label">Lines</div>
        <div className="list-box">
          {LINE_ORDER.map((layer) => (
            <LayerRow
              key={layer}
              layer={layer}
              summary={lineSummary(layer)}
              help={layer === 'raceways' ? 'Drawn exactly as mapped. Line cleanup skips them.' : undefined}
            >
              <Colour layer={layer} />
              {mode === 'print' && <LineWidth layer={layer} />}
              <Filters layer={layer} />
            </LayerRow>
          ))}
        </div>
      </div>
      <CheckField label="Leave out tunnels" checked={skipTunnels} onChange={(skip) => setFilters((f) => ({ ...f, skipTunnels: skip }))} />
    </Section>
  );
}
