import {
  ArrowDown,
  ArrowUp,
  Bridge,
  Building,
  ChevronDown,
  Droplet,
  Frame,
  Layers,
  Mountain,
  Road,
  ShieldCheck,
  TreeDeciduous,
  Trees,
} from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';
import type { ModelSettings, SurfaceCategory } from '../../core/settings';
import { HelpTip } from '../components/HelpTip';
import { NumberField } from '../components/NumberField';
import { SwitchField } from '../components/Fields';
import { Switch } from '../components/Switch';
import { formatInteger, formatNumber, keepUnits, listJoin } from '../lib/format';
import { patchSettings, resetSettingsSection, setSupports, toggleLayer, useApp } from '../state/store';
import type { LayerKey, SettingsSection } from '../state/store';
import { Section } from './Section';

interface LayerRowProps {
  layer: LayerKey;
  label: string;
  icon: ReactNode;
  on: boolean;
  onToggle: (on: boolean) => void;
  switchLabel?: string;
  summary: string;
  help: string;
  children: ReactNode;
  resetKey?: SettingsSection;
}

function LayerRow({ layer, label, icon, on, onToggle, switchLabel, summary, help, children, resetKey }: LayerRowProps) {
  const open = useApp((state) => state.ui.layers[layer] ?? false);
  const bodyId = useId();
  return (
    <div className={`layer${on ? '' : ' is-off'}${open ? ' is-open' : ''}`}>
      <div className="layer-head">
        <Switch checked={on} onChange={onToggle} label={switchLabel ?? label} />
        <button type="button" className="layer-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => toggleLayer(layer)}>
          <span className="layer-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="layer-name">{label}</span>
          <span className="layer-summary">{summary}</span>
          <ChevronDown className="layer-chevron" size={15} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="layer-body" id={bodyId}>
          <p className="layer-help">{keepUnits(help)}</p>
          {children}
          {resetKey && (
            <div className="layer-foot">
              <button type="button" className="link-btn" onClick={() => resetSettingsSection(resetKey)}>
                Reset {label.toLowerCase()} settings
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const mm = (value: number) => `${formatNumber(value, 2)} mm`;

const SURFACE_LABELS: Record<SurfaceCategory, string> = {
  paved: 'Paved',
  sand: 'Sand',
  rock: 'Rock',
  green: 'Parks',
  forest: 'Forest',
};

function TerrainOptions({ terrain }: { terrain: ModelSettings['terrain'] }) {
  return (
    <>
      <NumberField
        label="Exaggeration"
        value={terrain.exaggeration}
        onChange={(exaggeration) => patchSettings('terrain', { exaggeration })}
        min={0}
        max={10}
        step={0.1}
        decimals={2}
        unit="×"
        disabled={!terrain.elevation}
        help="Multiplies real height differences in the terrain. 1 is true to scale."
      />
      <NumberField
        label="Smoothing"
        value={terrain.smoothing}
        onChange={(smoothing) => patchSettings('terrain', { smoothing: Math.round(smoothing) })}
        min={0}
        max={4}
        step={1}
        decimals={0}
        unit="cells"
        disabled={!terrain.elevation}
        help="Averages terrain heights over this many grid cells, to remove the metre or two of elevation noise that prints as bumps along roads. 0 uses the heights as downloaded."
      />
      <NumberField
        label="Resolution"
        value={terrain.resolution}
        onChange={(resolution) => patchSettings('terrain', { resolution: Math.round(resolution) })}
        min={16}
        max={1024}
        step={16}
        decimals={0}
        unit="cells"
        help="Terrain grid cells across the longer side. Roads and water follow this grid, so more cells follow the ground more closely but take longer to build."
      />
    </>
  );
}

function WaterOptions({ water }: { water: ModelSettings['water'] }) {
  const recessing = water.recessPonds && !water.skipPonds;
  const gap = water.pondDepthMm - water.pondWaterMm;
  return (
    <>
      <NumberField
        label="Cut through the base above"
        value={water.cutMinAreaM2}
        onChange={(cutMinAreaM2) => patchSettings('water', { cutMinAreaM2: Math.round(cutMinAreaM2) })}
        min={0}
        max={1000000}
        step={500}
        decimals={0}
        unit="m²"
        help="Rivers, lakes and the sea at least this large are cut right through the base. Smaller water stays as a thin sheet on the terrain."
      />
      <SwitchField
        label="Skip ponds, fountains and basins"
        checked={water.skipPonds}
        onChange={(skipPonds) => patchSettings('water', { skipPonds })}
        help="Leave out mapped ponds, fountains, basins and small unnamed water entirely. Overrides the recess below."
      />
      <SwitchField
        label="Recess ponds and fountains"
        checked={water.recessPonds}
        disabled={water.skipPonds}
        onChange={(recessPonds) => patchSettings('water', { recessPonds })}
        help="Sink ponds, fountains, basins and small unnamed water into the ground with a solid floor, instead of cutting through the base."
      />
      <NumberField
        label="Recess depth"
        value={water.pondDepthMm}
        onChange={(pondDepthMm) => patchSettings('water', { pondDepthMm })}
        min={0.1}
        max={5}
        step={0.1}
        decimals={2}
        unit="mm"
        disabled={!recessing}
        help="Depth of ponds, fountains and basins below the bank around them."
      />
      <NumberField
        label="Pond water thickness"
        value={water.pondWaterMm}
        onChange={(pondWaterMm) => patchSettings('water', { pondWaterMm })}
        min={0.1}
        max={5}
        step={0.1}
        decimals={2}
        unit="mm"
        disabled={!recessing}
        help="Water thickness from the floor of a recess. It must not be more than the recess depth."
        hint={
          recessing ? (
            gap < -1e-6 ? (
              <span className="text-error">Must not be more than the recess depth.</span>
            ) : (
              `Water surface ${formatNumber(gap, 2)} mm below the bank`
            )
          ) : undefined
        }
      />
    </>
  );
}

function LandOptions({ land }: { land: ModelSettings['land'] }) {
  const palette = useApp((state) => state.palette);
  const move = (index: number, direction: -1 | 1) => {
    const priority = [...land.priority];
    const target = index + direction;
    [priority[index], priority[target]] = [priority[target], priority[index]];
    patchSettings('land', { priority });
  };
  return (
    <>
      <NumberField
        label="Rise above terrain"
        value={land.riseMm}
        onChange={(riseMm) => patchSettings('land', { riseMm })}
        min={0.02}
        max={3}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Height of parks, forest floor and plazas above the terrain. 0.4 mm is two 0.2 mm layers, enough to read as a colour of its own."
      />
      <NumberField
        label="Embed into terrain"
        value={land.embedMm}
        onChange={(embedMm) => patchSettings('land', { embedMm })}
        min={0.02}
        max={1}
        step={0.05}
        decimals={2}
        unit="mm"
        help="How far land surfaces, roads, buildings and piers reach below the terrain surface, so the parts overlap and join in the slicer."
      />
      <SwitchField
        label="Slope beaches into water"
        checked={land.taperBeaches}
        onChange={(taperBeaches) => patchSettings('land', { taperBeaches })}
        help="Slope mapped sand down to the waterline next to water cut from the terrain. Off ends it in a wall like other surfaces."
      />
      <NumberField
        label="Beach slope width"
        value={land.beachWidthMm}
        onChange={(beachWidthMm) => patchSettings('land', { beachWidthMm })}
        min={0.1}
        max={5}
        step={0.1}
        decimals={2}
        unit="mm"
        disabled={!land.taperBeaches}
        help="Printed distance from the waterline over which sand climbs to its full height. 1.5 mm is about 21 m at the default scale."
      />
      <div className="field">
        <div className="field-row">
          <span className="field-label">
            <span className="field-label-text">Surface priority</span>
            <HelpTip label="Surface priority" text="Where two surfaces overlap, the one higher in this list wins. Use the arrows to reorder." />
          </span>
        </div>
        <ol className="priority-list">
          {land.priority.map((category, index) => (
            <li key={category} className="priority-item">
              <span className="priority-rank">{index + 1}</span>
              <span className="dot" style={{ background: palette[category].hex }} aria-hidden="true" />
              <span className="priority-name">{SURFACE_LABELS[category]}</span>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`Move ${SURFACE_LABELS[category]} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`Move ${SURFACE_LABELS[category]} down`}
                disabled={index === land.priority.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

function RoadOptions({ roads, scale }: { roads: ModelSettings['roads']; scale: number }) {
  return (
    <>
      <NumberField
        label="Thickness"
        value={roads.thicknessMm}
        onChange={(thicknessMm) => patchSettings('roads', { thicknessMm })}
        min={0.05}
        max={5}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Height of roads above the terrain. 0.6 mm is three 0.2 mm layers."
      />
      <NumberField
        label="Minimum width"
        value={roads.minWidthMm}
        onChange={(minWidthMm) => patchSettings('roads', { minWidthMm })}
        min={0.05}
        max={5}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Narrowest printed road. Narrower roads are widened to this. 0.45 mm is about the narrowest line a 0.4 mm nozzle prints well."
        hint={scale > 0 ? `${formatNumber(roads.minWidthMm / scale, 1)} m real at this scale` : undefined}
      />
      <NumberField
        label="Maximum width"
        value={roads.maxWidthMm}
        onChange={(maxWidthMm) => patchSettings('roads', { maxWidthMm })}
        min={0.1}
        max={5}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Widest printed road or bridge deck. Wider roads are narrowed to this."
        hint={
          roads.minWidthMm > roads.maxWidthMm ? (
            <span className="text-error">Must be at least the minimum width.</span>
          ) : scale > 0 ? (
            `${formatNumber(roads.maxWidthMm / scale, 1)} m real at this scale`
          ) : undefined
        }
      />
      <SwitchField
        label="Include paths and footways"
        checked={roads.includePaths}
        onChange={(includePaths) => patchSettings('roads', { includePaths })}
        help="Pedestrian paths and footways. In a dense city they are most of the roads."
      />
      <SwitchField
        label="Skip sidewalks and crossings"
        checked={roads.skipSidewalks}
        disabled={!roads.includePaths}
        onChange={(skipSidewalks) => patchSettings('roads', { skipSidewalks })}
        help="Leave out sidewalks and crossings mapped beside streets. Park paths, trails and footbridges stay. Without this every downtown street prints as three lines."
      />
      <SwitchField
        label="Railways"
        checked={roads.includeRail}
        onChange={(includeRail) => patchSettings('roads', { includeRail })}
        help="Railway and tram lines, printed like roads."
      />
      <SwitchField
        label="Airports"
        checked={roads.includeAirports}
        onChange={(includeAirports) => patchSettings('roads', { includeAirports })}
        help="Runways, taxiways and aprons, printed with the roads."
      />
    </>
  );
}

function BridgeOptions({ bridges }: { bridges: ModelSettings['bridges'] }) {
  return (
    <>
      <NumberField
        label="Deck thickness"
        value={bridges.deckThicknessMm}
        onChange={(deckThicknessMm) => patchSettings('bridges', { deckThicknessMm })}
        min={0.05}
        max={10}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Thickness of bridge decks. The same as the road thickness makes a bridge continue its road with the same layers."
      />
      <NumberField
        label="Clearance"
        value={bridges.clearanceMm}
        onChange={(clearanceMm) => patchSettings('bridges', { clearanceMm })}
        min={0}
        max={3}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Printed gap between a deck's underside and whatever it crosses: terrain, a road or a lower deck."
      />
      <NumberField
        label="Maximum grade"
        value={bridges.maxGrade}
        onChange={(maxGrade) => patchSettings('bridges', { maxGrade })}
        min={1}
        max={50}
        step={1}
        decimals={1}
        scale={100}
        unit="%"
        help="Steepest slope a deck may climb or fall. A deck too short to reach its clearance at this slope rises as high as it can."
      />
      <NumberField
        label="Minimum lift"
        value={bridges.minLiftMm}
        onChange={(minLiftMm) => patchSettings('bridges', { minLiftMm })}
        min={0}
        max={2}
        step={0.05}
        decimals={2}
        unit="mm"
        help="A bridge that would rise less than this above the road is built as an ordinary road instead of a bump."
      />
      <NumberField
        label="Pier spacing"
        value={bridges.pierSpacingM}
        onChange={(pierSpacingM) => patchSettings('bridges', { pierSpacingM })}
        min={1}
        max={200}
        step={1}
        decimals={0}
        unit="m"
        help="Rough real distance between piers."
      />
      <NumberField
        label="Minimum pier size"
        value={bridges.pierMinSizeMm}
        onChange={(pierMinSizeMm) => patchSettings('bridges', { pierMinSizeMm })}
        min={0.1}
        max={3}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Smallest printed width of a pier. Piers stand on their own, so they are kept wider than the narrowest road."
      />
    </>
  );
}

function BuildingOptions({ buildings }: { buildings: ModelSettings['buildings'] }) {
  return (
    <>
      <NumberField
        label="Height scale"
        value={buildings.heightScale}
        onChange={(heightScale) => patchSettings('buildings', { heightScale })}
        min={0.1}
        max={3}
        step={0.05}
        decimals={2}
        unit="×"
        help="Multiplies every building's height. 1.1 lifts the buildings a little above the 0.6 mm roads. Footprints do not change."
      />
      <NumberField
        label="Minimum height"
        value={buildings.minHeightMm}
        onChange={(minHeightMm) => patchSettings('buildings', { minHeightMm })}
        min={0}
        max={5}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Shortest a building may print above the ground. Shorter buildings are stretched up to this. 0 turns it off."
      />
      <NumberField
        label="Raise only footprints over"
        value={buildings.minHeightFootprintMm}
        onChange={(minHeightFootprintMm) => patchSettings('buildings', { minHeightFootprintMm })}
        min={0}
        max={10}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Only buildings whose footprint covers at least this square are raised to the minimum height, so sheds, garages and walls stay low instead of becoming needles."
      />
      <NumberField
        label="Default height"
        value={buildings.defaultHeightM}
        onChange={(defaultHeightM) => patchSettings('buildings', { defaultHeightM })}
        min={1}
        max={100}
        step={0.5}
        decimals={1}
        unit="m"
        help="Real height used when the map has no height or floor count for a building."
      />
      <NumberField
        label="Floor height"
        value={buildings.floorHeightM}
        onChange={(floorHeightM) => patchSettings('buildings', { floorHeightM })}
        min={1}
        max={10}
        step={0.1}
        decimals={1}
        unit="m"
        help="Real metres per floor, for buildings mapped with a floor count but no height."
      />
      <SwitchField
        label="Roof shapes"
        checked={buildings.roofShapes}
        onChange={(roofShapes) => patchSettings('buildings', { roofShapes })}
        help="Build gabled, hipped, skillion, pyramid and dome roofs where they are mapped. Off keeps every roof flat."
      />
      <SwitchField
        label="Restore missing main bodies"
        checked={buildings.restoreMainBodies}
        onChange={(restoreMainBodies) => patchSettings('buildings', { restoreMainBodies })}
        help="Add a building's main body when its mapped parts cover less than half of it. The mapped parts are kept."
      />
      <NumberField
        label="Minimum width"
        value={buildings.minWidthMm}
        onChange={(minWidthMm) => patchSettings('buildings', { minWidthMm })}
        min={0}
        max={2}
        step={0.01}
        decimals={2}
        unit="mm"
        help="Leave out building parts narrower than this. 0 keeps everything."
      />
      <NumberField
        label="Maximum slenderness"
        value={buildings.maxSlenderness}
        onChange={(maxSlenderness) => patchSettings('buildings', { maxSlenderness })}
        min={0}
        max={60}
        step={0.5}
        decimals={1}
        unit="×"
        help="Leave out parts taller than this many times their width, which can snap off while printing. 0 turns it off."
      />
      {buildings.maxSlenderness > 0 && (
        <NumberField
          label="Always keep wider than"
          value={buildings.slendernessExemptMm}
          onChange={(slendernessExemptMm) => patchSettings('buildings', { slendernessExemptMm })}
          min={0}
          max={2}
          step={0.05}
          decimals={2}
          unit="mm"
          help="Parts at least this wide are never left out for being slender. One nozzle line prints at any height."
        />
      )}
    </>
  );
}

function TreeOptions({ trees }: { trees: ModelSettings['trees'] }) {
  return (
    <>
      <SwitchField
        label="Mapped trees"
        checked={trees.mapped}
        onChange={(mapped) => patchSettings('trees', { mapped })}
        help="Individually mapped trees."
      />
      <SwitchField
        label="Scatter in forests"
        checked={trees.forestScatter}
        onChange={(forestScatter) => patchSettings('trees', { forestScatter })}
        help="Fill mapped forests and woods with scattered trees."
      />
      <SwitchField
        label="Scatter in satellite forest"
        checked={trees.landCoverScatter}
        onChange={(landCoverScatter) => patchSettings('trees', { landCoverScatter })}
        help="Also scatter trees in forest from satellite land cover. That is where wooded hillsides come from when nobody mapped the trees."
      />
      <SwitchField
        label="Keep trees off roads"
        checked={trees.avoidRoads}
        onChange={(avoidRoads) => patchSettings('trees', { avoidRoads })}
        help="Skip trees whose crowns would overlap roads or paths."
      />
      <NumberField
        label="Spacing"
        value={trees.spacingM}
        onChange={(spacingM) => patchSettings('trees', { spacingM })}
        min={2}
        max={200}
        step={1}
        decimals={0}
        unit="m"
        help="Real distance between scattered trees."
      />
      <NumberField
        label="Minimum height"
        value={trees.minHeightMm}
        onChange={(minHeightMm) => patchSettings('trees', { minHeightMm })}
        min={0.1}
        max={10}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Smallest printed tree height, after size variation."
      />
      <NumberField
        label="Minimum width"
        value={trees.minWidthMm}
        onChange={(minWidthMm) => patchSettings('trees', { minWidthMm })}
        min={0.1}
        max={5}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Smallest printed crown width, after size variation."
      />
      <NumberField
        label="Size variation"
        value={trees.variation}
        onChange={(variation) => patchSettings('trees', { variation })}
        min={0}
        max={80}
        step={1}
        decimals={0}
        scale={100}
        unit="%"
        help="Random size difference between trees. Trees never go below the minimum sizes."
      />
      <NumberField
        label="Maximum trees"
        value={trees.maxTrees}
        onChange={(maxTrees) => patchSettings('trees', { maxTrees: Math.round(maxTrees) })}
        min={0}
        max={500000}
        step={1000}
        decimals={0}
        help="Upper limit on the number of trees. Every tree adds triangles and slicing time."
      />
    </>
  );
}

function RimOptions({ rim }: { rim: ModelSettings['rim'] }) {
  return (
    <>
      <NumberField
        label="Height"
        value={rim.heightMm}
        onChange={(heightMm) => patchSettings('rim', { heightMm })}
        min={0.1}
        max={30}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Height of the rim above the highest point of the terrain."
      />
      <NumberField
        label="Width"
        value={rim.widthMm}
        onChange={(widthMm) => patchSettings('rim', { widthMm })}
        min={0.1}
        max={20}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Wall thickness of the rim."
      />
    </>
  );
}

export function layerSummary(settings: ModelSettings): string {
  const on = [
    settings.terrain.elevation ? 'terrain' : 'flat base',
    settings.water.enabled && 'water',
    settings.land.enabled && 'parks',
    settings.roads.enabled && 'roads',
    settings.bridges.enabled && 'bridges',
    settings.buildings.enabled && 'buildings',
    settings.trees.enabled && 'trees',
    settings.rim.enabled && 'rim',
  ].filter((item): item is string => Boolean(item));
  const text = listJoin(on);
  return text[0].toUpperCase() + text.slice(1);
}

export function LayersPanel() {
  const settings = useApp((state) => state.settings);
  const { terrain, water, land, roads, bridges, buildings, trees, rim } = settings;
  const scale = settings.scale.mode === 'fixed' ? settings.scale.mmPerMetre : 0;

  const roadExtras = [roads.includePaths && 'paths', roads.includeRail && 'rail', roads.includeAirports && 'airports'].filter(Boolean);

  return (
    <Section id="layers" title="Layers" icon={<Layers size={16} />} summary={layerSummary(settings)}>
      <div className="layers">
        <LayerRow
          layer="terrain"
          label="Terrain"
          switchLabel="Terrain elevation"
          icon={<Mountain size={16} />}
          on={terrain.elevation}
          onToggle={(elevation) => patchSettings('terrain', { elevation })}
          summary={terrain.elevation ? `Elevation ×${formatNumber(terrain.exaggeration, 2)} · ${terrain.resolution} cells` : 'Flat base'}
          help="Ground shape from public elevation data. Off builds a flat base and skips the elevation download."
          resetKey="terrain"
        >
          <TerrainOptions terrain={terrain} />
        </LayerRow>

        <LayerRow
          layer="water"
          label="Water"
          icon={<Droplet size={16} />}
          on={water.enabled}
          onToggle={(enabled) => patchSettings('water', { enabled })}
          summary={water.enabled ? `Cut above ${formatInteger(water.cutMinAreaM2)} m²${water.skipPonds ? ' · no ponds' : ''}` : 'Off, cuts stay open'}
          help="Rivers, lakes and the sea as their own part. Large water is cut through the base, small ponds are sunk into the ground. Off leaves the water openings empty."
          resetKey="water"
        >
          <WaterOptions water={water} />
        </LayerRow>

        <LayerRow
          layer="land"
          label="Parks and land cover"
          icon={<Trees size={16} />}
          on={land.enabled}
          onToggle={(enabled) => patchSettings('land', { enabled })}
          summary={land.enabled ? `${mm(land.riseMm)} rise` : 'Off'}
          help="Parks, forest floor, sand, rock and paved plazas as thin slabs on the terrain, each in its own colour."
          resetKey="land"
        >
          <LandOptions land={land} />
        </LayerRow>

        <LayerRow
          layer="roads"
          label="Roads"
          icon={<Road size={16} />}
          on={roads.enabled}
          onToggle={(enabled) => patchSettings('roads', { enabled })}
          summary={roads.enabled ? `${mm(roads.thicknessMm)}${roadExtras.length ? ` · ${roadExtras.join(', ')}` : ''}` : 'Off'}
          help="Roads, paths, railways and airport paving, sized so a 0.4 mm nozzle can print them."
          resetKey="roads"
        >
          <RoadOptions roads={roads} scale={scale} />
        </LayerRow>

        <LayerRow
          layer="bridges"
          label="Bridges"
          icon={<Bridge size={16} />}
          on={bridges.enabled}
          onToggle={(enabled) => patchSettings('bridges', { enabled })}
          summary={bridges.enabled ? `${mm(bridges.clearanceMm)} clearance` : 'Off, built as roads'}
          help="Mapped bridges as decks on piers, lifted clear of what they cross. Off builds them as ordinary roads. Bridges are simple: no towers, arches or trusses."
          resetKey="bridges"
        >
          <BridgeOptions bridges={bridges} />
        </LayerRow>

        <LayerRow
          layer="buildings"
          label="Buildings"
          icon={<Building size={16} />}
          on={buildings.enabled}
          onToggle={(enabled) => patchSettings('buildings', { enabled })}
          summary={buildings.enabled ? `Height ×${formatNumber(buildings.heightScale, 2)}${buildings.roofShapes ? ' · roofs' : ''}` : 'Off'}
          help="Buildings from mapped footprints and heights. Buildings without a mapped height use a height for their type, then the default height."
          resetKey="buildings"
        >
          <BuildingOptions buildings={buildings} />
        </LayerRow>

        <LayerRow
          layer="trees"
          label="Trees"
          icon={<TreeDeciduous size={16} />}
          on={trees.enabled}
          onToggle={(enabled) => patchSettings('trees', { enabled })}
          summary={trees.enabled ? `${trees.spacingM} m spacing` : 'Off'}
          help="Mapped trees and trees scattered through forests, as simple solids sized to print. Trees add a lot of triangles."
          resetKey="trees"
        >
          <TreeOptions trees={trees} />
        </LayerRow>

        <LayerRow
          layer="rim"
          label="Border rim"
          icon={<Frame size={16} />}
          on={rim.enabled}
          onToggle={(enabled) => patchSettings('rim', { enabled })}
          summary={rim.enabled ? `${mm(rim.heightMm)} high` : 'Off'}
          help="A raised frame around the edge of the model."
          resetKey="rim"
        >
          <RimOptions rim={rim} />
        </LayerRow>

        <div className="layer layer-plain">
          <div className="layer-head">
            <Switch checked={settings.supports} onChange={setSupports} label="Keep ground under structures over water" />
            <div className="layer-toggle layer-toggle-static">
              <span className="layer-icon" aria-hidden="true">
                <ShieldCheck size={16} />
              </span>
              <span className="layer-name layer-name-wrap">Keep ground under structures over water</span>
              <HelpTip
                label="Keep ground under structures over water"
                text="Keeps a strip of ground under roads, buildings and bridge piers that stand in water cut from the terrain, so they have something to print on."
              />
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
