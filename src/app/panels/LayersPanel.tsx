import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { fixedCellLimit, gridCells, gridProblem, LARGEST_FIXED_CELLS, requestedCell } from '../../core/dsm/grid';
import { effectiveScale } from '../../core/geo/area';
import { rankingCell } from '../../core/lidar/query';
import { modelFieldRange, type AreaSpec, type LidarCellMode, type LidarRoofMode, type LidarWaterMode, type ModelSettings, type SurfaceCategory, type SurveyPreference, type TreeStyle, type WaterMode } from '../../core/settings';
import type { SurveyChoice } from '../../core/engine/protocol';
import type { ColourGroup } from '../../core/types';
import { LayerDisclosure } from '../components/LayerDisclosure';
import { CheckField, SelectField } from '../components/Fields';
import { HelpTip } from '../components/HelpTip';
import { NumberField } from '../components/NumberField';
import { Segmented } from '../components/Segmented';
import { formatInteger, formatNumber, keepUnits, listJoin } from '../lib/format';
import { deviceMemoryGb, lidarCellLimit } from '../state/derived';
import { findLidarSurveys } from '../state/actions';
import { patchSettings, resetSettingsSection, setLargeGrids, setModelSource, setSupports, surveySearchKey, toggleLayer, useApp } from '../state/store';
import type { LayerKey, SettingsSection } from '../state/store';
import { Section } from './Section';

interface LayerRowProps {
  layer: LayerKey;
  label: string;
  /** Colour the layer prints in, shown as a dot. */
  group: ColourGroup;
  on: boolean;
  onToggle: (on: boolean) => void;
  checkLabel?: string;
  summary: string;
  help: string;
  children: ReactNode;
  resetKey?: SettingsSection;
}

function LayerRow({ layer, label, group, on, onToggle, checkLabel, summary, help, children, resetKey }: LayerRowProps) {
  const open = useApp((state) => state.ui.layers[layer] ?? false);
  const colour = useApp((state) => state.palette[group].hex);
  return (
    <LayerDisclosure
      label={label}
      colour={colour}
      on={on}
      onToggle={onToggle}
      checkLabel={checkLabel}
      open={open}
      onExpand={() => toggleLayer(layer)}
      summary={summary}
    >
      <p className="layer-help">{keepUnits(help)}</p>
      {children}
      {resetKey && (
        <div className="layer-foot">
          <button type="button" className="link-btn" onClick={() => resetSettingsSection(resetKey)}>
            Reset {/[A-Z].*[A-Z]/.test(label) ? label : label.toLowerCase()} settings
          </button>
        </div>
      )}
    </LayerDisclosure>
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
        {...modelFieldRange('terrain', 'exaggeration')}
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
        {...modelFieldRange('terrain', 'smoothing')}
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
        {...modelFieldRange('terrain', 'resolution')}
        step={16}
        decimals={0}
        unit="cells"
        help="Terrain grid cells across the longer side. Roads and water follow this grid, so more cells follow the ground more closely but take longer to build."
      />
    </>
  );
}

function WaterOptions({ water }: { water: ModelSettings['water'] }) {
  const through = water.mode === 'through';
  return (
    <>
      <SelectField
        label="Large water"
        value={water.mode}
        onChange={(mode) => patchSettings('water', { mode: mode as WaterMode })}
        help="Thin layer puts rivers, lakes and the sea on a floor of terrain, so the water colour is only in the top few layers. Cut through the base runs the water from the print bed up, for printing it as pieces of its own, or for openings through the base with Water off."
      >
        <option value="layer">Thin layer</option>
        <option value="through">Cut through the base</option>
      </SelectField>
      <NumberField
        label="Water thickness"
        value={water.thicknessMm}
        onChange={(thicknessMm) => patchSettings('water', { thicknessMm })}
        {...modelFieldRange('water', 'thicknessMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        help={
          through
            ? 'How thick ponds and small water print. Large water cut through the base runs down to the print bed.'
            : 'How thick the water prints on the terrain floor under it. Its surface sits 0.25 mm below the bank. Each layer with water in it needs a colour change, and 1 mm is five 0.2 mm layers.'
        }
      />
      <NumberField
        label="Large water above"
        value={water.cutMinAreaM2}
        onChange={(cutMinAreaM2) => patchSettings('water', { cutMinAreaM2: Math.round(cutMinAreaM2) })}
        {...modelFieldRange('water', 'cutMinAreaM2')}
        step={500}
        decimals={0}
        unit="m²"
        help={
          through
            ? 'Rivers, lakes and the sea at least this large are cut right through the base. Smaller water is a thin sheet on the terrain, unless it joins large water.'
            : 'Rivers, lakes and the sea at least this large are levelled from their shores and sunk just below them. Smaller water is a thin sheet on the terrain, unless it joins large water.'
        }
      />
      <CheckField
        label="Join small water to large water"
        checked={water.joinSmallWater}
        onChange={(joinSmallWater) => patchSettings('water', { joinSmallWater })}
        help="Small water touching large water, like locks, docks and canals mapped in pieces, is sunk with it at the same level. Off, it's a sheet on the terrain like a stream, about 0.4 mm above the water beside it. Water that climbs away from it by more than 0.5 mm printed stays a sheet."
      />
      <CheckField
        label="Skip ponds, fountains and basins"
        checked={water.skipPonds}
        onChange={(skipPonds) => patchSettings('water', { skipPonds })}
        help="Leave out mapped ponds, fountains, basins and small unnamed water entirely. Otherwise they sit just below their lowest bank, at the water thickness."
      />
      <CheckField
        label="Skip thin ground in water"
        checked={water.skipThinGround}
        onChange={(skipThinGround) => patchSettings('water', { skipThinGround })}
        help="Fill piers, breakwaters and islands narrower than this with water. Ground thinner than a nozzle line doesn't print and leaves a hole in the water. Only ground with water on both sides counts, so a quay along the shore stays."
      />
      <NumberField
        label="Skip narrower than"
        value={water.skipThinMm}
        onChange={(skipThinMm) => patchSettings('water', { skipThinMm })}
        {...modelFieldRange('water', 'skipThinMm')}
        step={0.01}
        decimals={2}
        unit="mm"
        disabled={!water.skipThinGround}
        help="0.42 mm is one line from a 0.4 mm nozzle, about 6 m at the default scale."
      />
      <CheckField
        label="Widen thin ground in water"
        checked={water.widenThinGround}
        onChange={(widenThinGround) => patchSettings('water', { widenThinGround })}
        help="Widen piers, breakwaters and islands narrower than this into the water around them, so they print. With skipping on too, anything under the skip width goes and the rest is widened."
      />
      <NumberField
        label="Widen to"
        value={water.widenThinMm}
        onChange={(widenThinMm) => patchSettings('water', { widenThinMm })}
        {...modelFieldRange('water', 'widenThinMm')}
        step={0.01}
        decimals={2}
        unit="mm"
        disabled={!water.widenThinGround}
        help="0.42 mm is one line from a 0.4 mm nozzle."
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
      <CheckField
        label="Satellite land cover"
        checked={land.satelliteCover}
        onChange={(satelliteCover) => patchSettings('land', { satelliteCover })}
        help="Add forest, shrub and grass seen from satellite (ESA WorldCover) to the mapped parks and woods. It fills in wooded hillsides nobody mapped, but it also counts tree-lined streets and gardens as forest, so whole neighbourhoods can come out green."
      />
      <NumberField
        label="Rise above terrain"
        value={land.riseMm}
        onChange={(riseMm) => patchSettings('land', { riseMm })}
        {...modelFieldRange('land', 'riseMm')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Height of parks, forest floor and plazas above the terrain. 0.4 mm is two 0.2 mm layers, enough to read as a colour of its own."
      />
      <NumberField
        label="Embed into terrain"
        value={land.embedMm}
        onChange={(embedMm) => patchSettings('land', { embedMm })}
        {...modelFieldRange('land', 'embedMm')}
        step={0.01}
        decimals={2}
        unit="mm"
        help="How far land surfaces, roads, buildings, piers and trees reach below the terrain surface, so the parts overlap and join in the slicer. Exported projects list the terrain after them, so slicers print the overlap as terrain."
      />
      <CheckField
        label="Slope beaches into water"
        checked={land.taperBeaches}
        onChange={(taperBeaches) => patchSettings('land', { taperBeaches })}
        help="Slope the ground under mapped sand down to the surface of water cut from the terrain, instead of ending at a bank. The sand keeps its thickness on top. Sand that stops just short of the water is run on to it."
      />
      <NumberField
        label="Beach slope width"
        value={land.beachWidthMm}
        onChange={(beachWidthMm) => patchSettings('land', { beachWidthMm })}
        {...modelFieldRange('land', 'beachWidthMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        disabled={!land.taperBeaches}
        help="Printed distance from the waterline over which the ground under a beach climbs back to its height. 1.5 mm is about 21 m at the default scale."
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
        {...modelFieldRange('roads', 'thicknessMm')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Height of roads above the terrain. 0.6 mm is three 0.2 mm layers."
      />
      <NumberField
        label="Minimum width"
        value={roads.minWidthMm}
        onChange={(minWidthMm) => patchSettings('roads', { minWidthMm })}
        {...modelFieldRange('roads', 'minWidthMm')}
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
        {...modelFieldRange('roads', 'maxWidthMm')}
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
      <CheckField
        label="Include paths and footways"
        checked={roads.includePaths}
        onChange={(includePaths) => patchSettings('roads', { includePaths })}
        help="Pedestrian paths and footways. In a dense city they are most of the roads."
      />
      <CheckField
        label="Skip sidewalks and crossings"
        checked={roads.skipSidewalks}
        disabled={!roads.includePaths}
        onChange={(skipSidewalks) => patchSettings('roads', { skipSidewalks })}
        help="Leave out sidewalks and crossings mapped beside streets. Park paths, trails and footbridges stay. Without this every downtown street prints as three lines."
      />
      <CheckField
        label="Railways"
        checked={roads.includeRail}
        onChange={(includeRail) => patchSettings('roads', { includeRail })}
        help="Railway and tram lines, printed like roads."
      />
      <CheckField
        label="Airports"
        checked={roads.includeAirports}
        onChange={(includeAirports) => patchSettings('roads', { includeAirports })}
        help="Runways, taxiways and aprons, printed with the roads."
      />
      <CheckField
        label="Racetracks"
        checked={roads.includeRaceways}
        onChange={(includeRaceways) => patchSettings('roads', { includeRaceways })}
        help="Race and kart tracks, printed like roads. Overture leaves these out, so they come from the OpenFreeMap tiles the SVG maps use."
      />
      <CheckField
        label="Tidy road network"
        checked={roads.tidy}
        onChange={(tidy) => patchSettings('roads', { tidy })}
        help="Clean up the lines before they're widened into roads. Off prints every mapped line as it comes."
      />
      <div className="nested">
        <CheckField
          label="Remove doubled lines"
          checked={roads.removeDoubled}
          disabled={!roads.tidy}
          onChange={(removeDoubled) => patchSettings('roads', { removeDoubled })}
          help="A path, track or service road running alongside a more important road, closer than the minimum gap, is left out, like footways mapped beside streets and trams running in them."
        />
        <CheckField
          label="Merge divided roads"
          checked={roads.mergeDivided}
          disabled={!roads.tidy}
          onChange={(mergeDivided) => patchSettings('roads', { mergeDivided })}
          help="Where the two carriageways of a divided road are closer than the minimum gap, they print as one road down the middle. Streets meeting it are extended or trimmed along their own line to meet it."
        />
        <CheckField
          label="Join loose ends"
          checked={roads.joinEnds}
          disabled={!roads.tidy}
          onChange={(joinEnds) => patchSettings('roads', { joinEnds })}
          help="A path or street that stops just short of a road, because the sidewalk or crossing it met was left out, is joined to it."
        />
        <CheckField
          label="Remove stubs and specks"
          checked={roads.removeFragments}
          disabled={!roads.tidy}
          onChange={(removeFragments) => patchSettings('roads', { removeFragments })}
          help="Short spurs that lead nowhere and small pieces touching nothing are left out, like the flight of steps between two sidewalks."
        />
        <CheckField
          label="Fill hairline cracks"
          checked={roads.fillGaps}
          disabled={!roads.tidy}
          onChange={(fillGaps) => patchSettings('roads', { fillGaps })}
          help="A crack narrower than half the minimum gap between two roads or paths side by side is filled in, since it closes up in the print anyway, and so is enclosed ground that thin, like the gaps in a plaza criss-crossed by paths. Wider gaps stay, so roads don't print thicker than they're mapped. Rail yards are left as they are."
        />
        <NumberField
          label="Minimum gap"
          value={roads.gapMm}
          onChange={(gapMm) => patchSettings('roads', { gapMm })}
          disabled={!roads.tidy}
          {...modelFieldRange('roads', 'gapMm')}
          step={0.05}
          decimals={2}
          unit="mm"
          help="Narrowest strip of ground left between two roads running side by side. About one nozzle width."
        />
      </div>
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
        {...modelFieldRange('bridges', 'deckThicknessMm')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Thickness of bridge decks. The same as the road thickness makes a bridge continue its road with the same layers."
      />
      <NumberField
        label="Clearance"
        value={bridges.clearanceMm}
        onChange={(clearanceMm) => patchSettings('bridges', { clearanceMm })}
        {...modelFieldRange('bridges', 'clearanceMm')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Printed gap between a deck's underside and whatever it crosses: terrain, a road or a lower deck."
      />
      <NumberField
        label="Maximum grade"
        value={bridges.maxGrade}
        onChange={(maxGrade) => patchSettings('bridges', { maxGrade })}
        {...modelFieldRange('bridges', 'maxGrade', 100)}
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
        {...modelFieldRange('bridges', 'minLiftMm')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="A bridge that would rise less than this above the road is built as an ordinary road instead of a bump."
      />
      <NumberField
        label="Pier spacing"
        value={bridges.pierSpacingM}
        onChange={(pierSpacingM) => patchSettings('bridges', { pierSpacingM })}
        {...modelFieldRange('bridges', 'pierSpacingM')}
        step={1}
        decimals={0}
        unit="m"
        help="Rough real distance between piers."
      />
      <NumberField
        label="Minimum pier size"
        value={bridges.pierMinSizeMm}
        onChange={(pierMinSizeMm) => patchSettings('bridges', { pierMinSizeMm })}
        {...modelFieldRange('bridges', 'pierMinSizeMm')}
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
        {...modelFieldRange('buildings', 'heightScale')}
        step={0.05}
        decimals={2}
        unit="×"
        help="Multiplies every building's height. 1.1 lifts the buildings a little above the 0.6 mm roads. Footprints do not change."
      />
      <NumberField
        label="Minimum height"
        value={buildings.minHeightMm}
        onChange={(minHeightMm) => patchSettings('buildings', { minHeightMm })}
        {...modelFieldRange('buildings', 'minHeightMm')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Shortest a building may print above the ground. Shorter buildings are stretched up to this. 0 turns it off."
      />
      <NumberField
        label="Raise only footprints over"
        value={buildings.minHeightFootprintMm}
        onChange={(minHeightFootprintMm) => patchSettings('buildings', { minHeightFootprintMm })}
        {...modelFieldRange('buildings', 'minHeightFootprintMm')}
        step={0.05}
        decimals={2}
        unit="mm"
        help="Only buildings whose footprint covers at least this square are raised to the minimum height, so sheds, garages and walls stay low instead of becoming needles."
      />
      <NumberField
        label="Default height"
        value={buildings.defaultHeightM}
        onChange={(defaultHeightM) => patchSettings('buildings', { defaultHeightM })}
        {...modelFieldRange('buildings', 'defaultHeightM')}
        step={0.5}
        decimals={1}
        unit="m"
        help="Real height used when the map has no height or floor count for a building."
      />
      <NumberField
        label="Floor height"
        value={buildings.floorHeightM}
        onChange={(floorHeightM) => patchSettings('buildings', { floorHeightM })}
        {...modelFieldRange('buildings', 'floorHeightM')}
        step={0.1}
        decimals={1}
        unit="m"
        help="Real metres per floor, for buildings mapped with a floor count but no height."
      />
      <CheckField
        label="Roof shapes"
        checked={buildings.roofShapes}
        onChange={(roofShapes) => patchSettings('buildings', { roofShapes })}
        help="Build gabled, hipped, skillion, pyramid and dome roofs where they are mapped. Off keeps every roof flat."
      />
      <CheckField
        label="Restore missing main bodies"
        checked={buildings.restoreMainBodies}
        onChange={(restoreMainBodies) => patchSettings('buildings', { restoreMainBodies })}
        help="Add a building's main body when its mapped parts cover less than half of it. The mapped parts are kept."
      />
      <CheckField
        label="Bring raised parts down to the ground"
        checked={buildings.groundRaisedParts}
        onChange={(groundRaisedParts) => patchSettings('buildings', { groundRaisedParts })}
        help="Parts mapped to start above the ground, like arcades, overhangs and skybridges, are built down to meet the terrain, so nothing hangs in the air. Off keeps them raised as mapped, which needs supports in the slicer. Gaps too thin to print are closed either way."
      />
      <NumberField
        label="Minimum width"
        value={buildings.minWidthMm}
        onChange={(minWidthMm) => patchSettings('buildings', { minWidthMm })}
        {...modelFieldRange('buildings', 'minWidthMm')}
        step={0.01}
        decimals={2}
        unit="mm"
        help="Leave out building parts narrower than this. 0 keeps everything."
      />
      <NumberField
        label="Maximum slenderness"
        value={buildings.maxSlenderness}
        onChange={(maxSlenderness) => patchSettings('buildings', { maxSlenderness })}
        {...modelFieldRange('buildings', 'maxSlenderness')}
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
          {...modelFieldRange('buildings', 'slendernessExemptMm')}
          step={0.05}
          decimals={2}
          unit="mm"
          help="Parts at least this wide are never left out for being slender. One nozzle line prints at any height."
        />
      )}
    </>
  );
}

/** Its name with what tells surveys apart: year, returns per m² here, the cells it filled if fewer than asked, how much of the area it covers. */
function surveyText(s: SurveyChoice, cell: number | null): string {
  const parts = [
    s.year ? String(s.year) : '',
    s.densityM2 ? `${formatNumber(s.densityM2, s.densityM2 < 10 ? 1 : 0)} per m²` : '',
    s.fillsM && cell !== null && s.fillsM > cell * 1.001 ? `fills ${formatNumber(s.fillsM, 2)} m cells` : '',
    s.coverage < 0.99 ? `${Math.max(1, Math.round(s.coverage * 100))}% of the area` : '',
    s.staged ? 'whole tiles' : '',
  ].filter(Boolean);
  return parts.length ? `${s.name} (${parts.join(', ')})` : s.name;
}

function surveyCell(area: AreaSpec, settings: ModelSettings): number | null {
  try {
    return rankingCell(area, settings);
  } catch {
    return null;
  }
}

/** A name for a picked survey that isn't in the list, from its URL. */
function surveyName(url: string): string {
  const parts = url.replace(/[?#].*$/, '').split('/').filter((p) => p && !/^ept\.json$/i.test(p));
  try {
    return decodeURIComponent(parts[parts.length - 1] ?? url);
  } catch {
    return url;
  }
}

/**
 * Picking a survey by hand, for LiDAR buildings and LiDAR only models alike.
 * The surveys under the area are listed without asking, a moment after the
 * area or the settings that order them settle, in the order Automatic reads
 * them. A generation's own list replaces it, with what it measured. A pick
 * stays when the area moves, and does nothing where that survey isn't.
 */
function SurveyPicker({ settings, area }: { settings: ModelSettings; area: AreaSpec }) {
  const chosen = settings.lidar.survey;
  const key = surveySearchKey(area, settings);
  const search = useApp((state) => state.generation.surveys);
  const here = search && search.key === key ? search : null;
  // Only catalogs and indexes are read, and they're kept for a day. A failed
  // search waits for Search again rather than repeating itself.
  const unsearched = here === null;
  useEffect(() => {
    if (!unsearched) return;
    const timer = window.setTimeout(() => void findLidarSurveys(), 600);
    return () => window.clearTimeout(timer);
  }, [key, unsearched]);
  const list = here?.status === 'done' ? here.list : [];
  const cell = surveyCell(area, settings);
  const first = list[0];
  const listed = !chosen || list.some((s) => s.url === chosen);
  const unanswered = here?.failures.length ? `, ${here.failures.length} ${here.failures.length === 1 ? "catalog didn't" : "catalogs didn't"} answer` : '';
  const status =
    !here || here.status === 'searching'
      ? 'Looking for surveys here'
      : here.status === 'error'
        ? `Couldn't search: ${here.error}`
        : `${here.list.length ? `${here.list.length} found here` : 'None found here'}${unanswered}`;
  const preference = settings.lidar.surveyPreference;
  return (
    <>
      <SelectField
        label="Survey"
        stacked
        value={chosen}
        onChange={(survey) => patchSettings('lidar', { survey })}
        help="Automatic picks for you, as set under Prefer. A survey picked here is read first, and the others still fill in where it doesn't reach. The list shows each survey's year, its returns per m² around this area and how much of the area it covers. Finding them reads no points. LiDAR buildings and LiDAR only models use the same pick."
        hint={!chosen && first?.note ? first.note : undefined}
      >
        <option value="">{first ? `Automatic: ${first.name}${first.year ? ` (${first.year})` : ''}` : 'Automatic'}</option>
        {!listed && <option value={chosen}>{`${surveyName(chosen)}${here?.status === 'done' ? ', not found here' : ''}`}</option>}
        {list.map((s) => (
          <option key={s.url} value={s.url}>
            {surveyText(s, cell)}
          </option>
        ))}
      </SelectField>
      <div className="survey-find">
        <span role="status">{status}</span>
        {here && here.status !== 'searching' && (
          <button type="button" className="link-btn" onClick={() => void findLidarSurveys()}>
            Search again
          </button>
        )}
      </div>
      {!chosen && (
        <SelectField
          label="Prefer"
          value={preference}
          onChange={(value) => patchSettings('lidar', { surveyPreference: value as SurveyPreference })}
          help="Balanced reads the newest survey unless it's too sparse or patchy for the grid cells, which is measured near the middle of the area when it matters. Then an older survey that fills clearly finer cells goes first, if it's no older than the years below, or twice that for cells half the size. Newest always reads the most recent survey. Most detail reads the survey with the most returns per m², whatever its age, unless the newest has nearly as many."
        >
          <option value="balanced">Balanced</option>
          <option value="newest">Newest survey</option>
          <option value="detail">Most detail</option>
        </SelectField>
      )}
      {!chosen && preference === 'balanced' && (
        <NumberField
          label="Older by up to"
          value={settings.lidar.olderYears}
          onChange={(olderYears) => patchSettings('lidar', { olderYears })}
          {...modelFieldRange('lidar', 'olderYears')}
          step={1}
          decimals={0}
          unit="years"
          help="How much older than the newest survey one may be and still be read first, when it fills the grid cells clearly finer. Buildings built or torn down since won't show. Twice this for cells half the size."
        />
      )}
    </>
  );
}

function LidarOptions({ settings, area, scale }: { settings: ModelSettings; area: AreaSpec; scale: number }) {
  const lidar = settings.lidar;
  const envelope = lidar.roofMode === 'envelope';
  return (
    <>
      <SurveyPicker settings={settings} area={area} />
      <SelectField
        label="Measure"
        value={lidar.roofMode}
        onChange={(roofMode) => patchSettings('lidar', { roofMode: roofMode as LidarRoofMode })}
        help="Whole roofs rebuilds each building from the survey's surface, read and meshed the way a LiDAR only model is and cut to the mapped outline, with its setbacks, towers and roof shape. Heights only keeps the mapped shape and corrects heights that are far off."
      >
        <option value="envelope">Whole roofs</option>
        <option value="heights">Heights only</option>
      </SelectField>
      {envelope && <RoofCellFields settings={settings} area={area} />}
      <NumberField
        label="Smallest footprint"
        value={lidar.minFootprintMm2}
        onChange={(minFootprintMm2) => patchSettings('lidar', { minFootprintMm2 })}
        {...modelFieldRange('lidar', 'minFootprintMm2')}
        step={0.1}
        decimals={2}
        unit="mm²"
        help={
          scale > 0
            ? `Buildings with a smaller printed footprint keep their mapped shape, which saves downloading and measuring them. At this scale ${formatNumber(lidar.minFootprintMm2, 2)} mm² is ${formatInteger(Math.round(lidar.minFootprintMm2 / scale ** 2))} m² on the ground. 0 measures every building.`
            : 'Buildings with a smaller printed footprint keep their mapped shape, which saves downloading and measuring them. 0 measures every building.'
        }
      />
      <CheckField
        label="Prefer LiDAR on conflicts"
        checked={lidar.preferLidar}
        onChange={(preferLidar) => patchSettings('lidar', { preferLidar })}
        help="Use a good scan even where it disagrees with the mapped height, the building's construction date or another survey. Off keeps the mapped building in those cases, which is safer where surveys are old."
      />
      <CheckField
        label="Mapped bare rock"
        checked={lidar.rockSurfaces}
        disabled={!envelope}
        onChange={(rockSurfaces) => patchSettings('lidar', { rockSurfaces })}
        help="Also measure mapped bare rock, such as outcrops and cliffs, and build its surface in the rock colour. Only mapped rock areas are measured."
      />
    </>
  );
}

/** The cell measured roofs are read in: a LiDAR Only model's setting, never grown for a large area. */
function RoofCellFields({ settings, area }: { settings: ModelSettings; area: AreaSpec }) {
  const lidar = settings.lidarModel;
  const scale = effectiveScale(area, settings.scale);
  let cell: number | null = null;
  try {
    cell = requestedCell(lidar, scale, 0, 0);
  } catch {
    cell = null;
  }
  return (
    <>
      <SelectField
        label="Grid cells"
        value={lidar.cellMode}
        onChange={(cellMode) => patchSettings('lidarModel', { cellMode: cellMode as LidarCellMode })}
        help="Roofs are read on the same grid as a LiDAR only model, and this is the same setting. Printed detail keeps the cells one size on the print, so they get larger in metres as the scale gets smaller. Metres reads the survey at the cell size you give, whatever the scale."
      >
        <option value="detail">Printed detail</option>
        <option value="metres">Metres on the ground</option>
      </SelectField>
      {lidar.cellMode === 'metres' ? (
        <NumberField
          label="Cell size"
          value={lidar.cellM}
          onChange={(cellM) => patchSettings('lidarModel', { cellM })}
          {...modelFieldRange('lidarModel', 'cellM')}
          step={0.05}
          decimals={2}
          unit="m"
          help="Size of one grid cell on the ground. Smaller keeps finer detail on the roofs but reads more of the survey and takes longer. 0.25 m is the finest, and only the densest surveys fill it. Cells grow where the survey is too sparse."
          hint={cell !== null && scale > 0 ? `${formatNumber(cell * scale, 3)} mm printed` : undefined}
        />
      ) : (
        <NumberField
          label="Detail"
          value={lidar.detailMm}
          onChange={(detailMm) => patchSettings('lidarModel', { detailMm })}
          {...modelFieldRange('lidarModel', 'detailMm')}
          step={0.01}
          decimals={3}
          unit="mm"
          help="Printed size of one grid cell. Smaller keeps finer detail on the roofs but reads more of the survey and takes longer. Surveys too sparse to fill the cells get larger ones."
          hint={cell !== null ? `${formatNumber(cell, 2)} m cells` : undefined}
        />
      )}
    </>
  );
}

function TreeOptions({ trees }: { trees: ModelSettings['trees'] }) {
  return (
    <>
      <CheckField
        label="Mapped trees"
        checked={trees.mapped}
        onChange={(mapped) => patchSettings('trees', { mapped })}
        help="Individually mapped trees."
      />
      <CheckField
        label="Scatter in forests"
        checked={trees.forestScatter}
        onChange={(forestScatter) => patchSettings('trees', { forestScatter })}
        help="Fill mapped forests and woods with scattered trees."
      />
      <CheckField
        label="Scatter in satellite forest"
        checked={trees.landCoverScatter}
        onChange={(landCoverScatter) => patchSettings('trees', { landCoverScatter })}
        help="Also scatter trees in forest from satellite land cover. That is where wooded hillsides come from when nobody mapped the trees."
      />
      <CheckField
        label="Keep trees off roads"
        checked={trees.avoidRoads}
        onChange={(avoidRoads) => patchSettings('trees', { avoidRoads })}
        help="Skip trees whose crowns would overlap roads or paths."
      />
      <NumberField
        label="Spacing"
        value={trees.spacingM}
        onChange={(spacingM) => patchSettings('trees', { spacingM })}
        {...modelFieldRange('trees', 'spacingM')}
        step={1}
        decimals={0}
        unit="m"
        help="Real distance between scattered trees."
      />
      <NumberField
        label="Minimum height"
        value={trees.minHeightMm}
        onChange={(minHeightMm) => patchSettings('trees', { minHeightMm })}
        {...modelFieldRange('trees', 'minHeightMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Smallest printed tree height, after size variation."
      />
      <NumberField
        label="Minimum width"
        value={trees.minWidthMm}
        onChange={(minWidthMm) => patchSettings('trees', { minWidthMm })}
        {...modelFieldRange('trees', 'minWidthMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Smallest printed crown width, after size variation."
      />
      <NumberField
        label="Size variation"
        value={trees.variation}
        onChange={(variation) => patchSettings('trees', { variation })}
        {...modelFieldRange('trees', 'variation', 100)}
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
        {...modelFieldRange('trees', 'maxTrees')}
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
        {...modelFieldRange('rim', 'heightMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Height of the rim above the highest point of the terrain."
      />
      <NumberField
        label="Width"
        value={rim.widthMm}
        onChange={(widthMm) => patchSettings('rim', { widthMm })}
        {...modelFieldRange('rim', 'widthMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        help="Wall thickness of the rim."
      />
    </>
  );
}

/** The grid cell a LiDAR Only model reads. Worked out from the detail, it grows for large areas. */
function lidarCell(area: AreaSpec, settings: ModelSettings): number | null {
  try {
    return requestedCell(settings.lidarModel, effectiveScale(area, settings.scale), area.widthM, area.heightM);
  } catch {
    return null;
  }
}

function LidarModelOptions({ settings, area }: { settings: ModelSettings; area: AreaSpec }) {
  const lidar = settings.lidarModel;
  const cell = lidarCell(area, settings);
  const scale = effectiveScale(area, settings.scale);
  const grown = lidar.cellMode === 'detail' && cell !== null && scale > 0 && cell > lidar.detailMm / scale + 0.006;
  const cells = cell !== null ? gridCells(area.widthM, area.heightM, cell) : 0;
  const largeGrids = useApp((state) => state.ui.largeGrids);
  const memory = deviceMemoryGb();
  const reported = fixedCellLimit(memory);
  const limit = lidarCellLimit(largeGrids);
  const millions = (count: number) => `${formatNumber(count / 1e6, 1)} million`;
  return (
    <div className="lidar-model">
      <p className="layer-help">
        {keepUnits(
          'Builds the whole model from a public LiDAR survey: the ground, buildings, trees and bridges as the survey saw them, in one piece and one colour, with the water in its own colour if you like. Covers the United States, Canada, France, Switzerland, Luxembourg, Slovenia, Scotland, much of Germany and Spain, Trentino, Helsinki, Tokyo and Yokohama, New Zealand, and more of Europe through Open LiDAR Data. Expect 75 MB to 1 GB of downloads per km² depending on the survey and the cell size, kept in the browser for next time, so start with a small area. Some surveys only come as whole tiles, which are only downloaded once you agree to.',
        )}
      </p>
      <SurveyPicker settings={settings} area={area} />
      <SelectField
        label="Grid cells"
        value={lidar.cellMode}
        onChange={(cellMode) => patchSettings('lidarModel', { cellMode: cellMode as LidarCellMode })}
        help={`Printed detail keeps the cells one size on the print, so they get larger in metres as the scale gets smaller, and large areas get larger cells to stay under 8 million. Metres reads the survey at the cell size you give, whatever the area or scale, up to ${millions(limit)} cells on this computer.`}
      >
        <option value="detail">Printed detail</option>
        <option value="metres">Metres on the ground</option>
      </SelectField>
      {lidar.cellMode === 'metres' ? (
        <NumberField
          label="Cell size"
          value={lidar.cellM}
          onChange={(cellM) => patchSettings('lidarModel', { cellM })}
          {...modelFieldRange('lidarModel', 'cellM')}
          step={0.05}
          decimals={2}
          unit="m"
          help="Size of one grid cell on the ground. Smaller keeps finer detail but reads more of the survey, takes longer and needs more memory. 0.25 m is the finest, and only the densest surveys fill it. Cells still grow where the survey is too sparse."
          hint={
            cell !== null && scale > 0
              ? `${formatNumber(cell * scale, 3)} mm printed · ${cells >= 1e6 ? millions(cells) : formatInteger(cells)} cells${gridProblem(area.widthM, area.heightM, cell, limit) ? `, over the ${millions(limit)} limit` : ''}`
              : undefined
          }
        />
      ) : (
        <NumberField
          label="Detail"
          value={lidar.detailMm}
          onChange={(detailMm) => patchSettings('lidarModel', { detailMm })}
          {...modelFieldRange('lidarModel', 'detailMm')}
          step={0.01}
          decimals={3}
          unit="mm"
          help="Printed size of one grid cell. Smaller keeps finer detail but reads more of the survey and takes longer. Large areas get larger cells, and so do surveys too sparse to fill them."
          hint={cell !== null ? `${formatNumber(cell, 2)} m cells${grown ? ', larger for this area' : ''}` : undefined}
        />
      )}
      {lidar.cellMode === 'metres' && reported < LARGEST_FIXED_CELLS && (
        <CheckField
          label="Allow larger grids"
          checked={largeGrids}
          onChange={setLargeGrids}
          help={`${memory === null ? "This browser doesn't say how much memory the computer has" : `This browser reports about ${memory} GB of memory`}, so grids stop at ${millions(reported)} cells. Turn this on to allow up to ${millions(LARGEST_FIXED_CELLS)} on a computer with 32 GB or more. A grid that size takes about 7 GB in this tab, and the tab closes if the computer runs out. Only kept in this browser.`}
        />
      )}
      <SelectField
        label="Trees"
        value={lidar.trees}
        onChange={(trees) => patchSettings('lidarModel', { trees: trees as TreeStyle })}
        help="Natural keeps each crown as the survey saw it, with the speckle softened. Rounded smooths canopy into masses that print cleanly. Off puts the ground or roof under the trees in their place."
      >
        <option value="natural">Natural</option>
        <option value="rounded">Rounded</option>
        <option value="off">Off</option>
      </SelectField>
      <CheckField
        label="Keep cars and clutter"
        checked={lidar.keepClutter}
        onChange={(keepClutter) => patchSettings('lidarModel', { keepClutter })}
        help="Keeps cars, fences, benches and anything else under 2 m, and boats standing in the water. They're small bumps at most scales. Off flattens them and turns boats, buoys and pilings into water. Poles, crane jibs and wires too thin to print go either way."
      />
      <SelectField
        label="Water"
        value={lidar.waterMode}
        onChange={(waterMode) => patchSettings('lidarModel', { waterMode: waterMode as LidarWaterMode })}
        help="Recessed sinks rivers, lakes and the sea into the model in the terrain colour. Thin layer prints them as a part of their own in the water colour, on a floor of terrain, so the colour only changes in the top few layers. Cut away leaves openings through the base. Water narrower than about 0.4 mm printed, or up on a roof, stays recessed. Beside a layer or a cut, land narrower than 0.2 mm printed, like a thin pier, goes to the water."
      >
        <option value="recess">Recessed</option>
        <option value="layer">Thin layer</option>
        <option value="cut">Cut away</option>
      </SelectField>
      <NumberField
        label="Water depth"
        value={lidar.waterDepthMm}
        onChange={(waterDepthMm) => patchSettings('lidarModel', { waterDepthMm })}
        {...modelFieldRange('lidarModel', 'waterDepthMm')}
        step={0.1}
        decimals={2}
        unit="mm"
        help={
          lidar.waterMode === 'layer'
            ? 'How far water left recessed (narrower than about 0.4 mm printed, or up on a roof) sits below its lowest bank. The layer itself sits 0.25 mm below its bank, like map models.'
            : 'How far rivers, lakes and the sea sit below their lowest bank, so they read as water in one colour.'
        }
      />
      {lidar.waterMode === 'layer' && (
        <NumberField
          label="Water thickness"
          value={settings.water.thicknessMm}
          onChange={(thicknessMm) => patchSettings('water', { thicknessMm })}
          {...modelFieldRange('water', 'thicknessMm')}
          step={0.1}
          decimals={2}
          unit="mm"
          help="How thick the water prints on the terrain floor under it. Each layer with water in it needs a colour change, and 1 mm is five 0.2 mm layers. Shared with map models."
        />
      )}
      {lidar.waterMode === 'cut' && (
        <NumberField
          label="Cut through the base above"
          value={settings.water.cutMinAreaM2}
          onChange={(cutMinAreaM2) => patchSettings('water', { cutMinAreaM2: Math.round(cutMinAreaM2) })}
          {...modelFieldRange('water', 'cutMinAreaM2')}
          step={500}
          decimals={0}
          unit="m²"
          help="Water at least this large is cut away, and smaller water stays recessed. Bridges stay as solid walls. Islands print as separate pieces, and ones under 4 mm² are left out. Shared with map models."
        />
      )}
      <CheckField
        label="Water outlines from map data"
        checked={lidar.mapWater}
        onChange={(mapWater) => patchSettings('lidarModel', { mapWater })}
        help="Uses mapped water from Overture. Thin layers and cuts follow its smooth shorelines where they agree with the survey to within 3 m, sea and lake beaches follow its coastline instead of the tide on the survey day, and water the survey has no returns for is filled in. Anything the survey saw standing in the water, like bridges, piers and boats, stays. Downloads a few MB of map data and adds a map data credit."
      />
      <NumberField
        label="Height scale"
        value={lidar.heightScale}
        onChange={(heightScale) => patchSettings('lidarModel', { heightScale })}
        {...modelFieldRange('lidarModel', 'heightScale')}
        step={0.05}
        decimals={2}
        unit="×"
        help="Multiplies the height of everything standing on the ground: buildings, trees and bridges. 1 is true to scale."
      />
      <NumberField
        label="Terrain exaggeration"
        value={settings.terrain.exaggeration}
        onChange={(exaggeration) => patchSettings('terrain', { exaggeration })}
        {...modelFieldRange('terrain', 'exaggeration')}
        step={0.1}
        decimals={2}
        unit="×"
        help="Multiplies height differences in the ground itself. 1 is true to scale. Shared with map models."
      />
      <div className="layer-foot">
        <button type="button" className="link-btn" onClick={() => resetSettingsSection('lidarModel')}>
          Reset LiDAR only settings
        </button>
      </div>
    </div>
  );
}

function waterSummary(water: ModelSettings['water']): string {
  const through = water.mode === 'through';
  if (!water.enabled) return through ? 'Off, cuts stay open' : 'Off, recesses stay empty';
  const main = through ? `Cut through above ${formatInteger(water.cutMinAreaM2)} m²` : `${mm(water.thicknessMm)} layer`;
  return `${main}${water.skipPonds ? ' · no ponds' : ''}`;
}

function layerSummary(settings: ModelSettings): string {
  const on = [
    settings.terrain.elevation ? 'terrain' : 'flat base',
    settings.water.enabled && 'water',
    settings.land.enabled && 'parks',
    settings.roads.enabled && 'roads',
    settings.bridges.enabled && 'bridges',
    settings.buildings.enabled && 'buildings',
    settings.buildings.enabled && settings.lidar.enabled && 'LiDAR',
    settings.trees.enabled && 'trees',
    settings.rim.enabled && 'rim',
  ].filter((item): item is string => Boolean(item));
  const text = listJoin(on);
  return text[0].toUpperCase() + text.slice(1);
}

export function LayersPanel() {
  const settings = useApp((state) => state.settings);
  const area = useApp((state) => state.area);
  const { terrain, water, land, roads, bridges, buildings, lidar, trees, rim } = settings;
  const scale = settings.scale.mode === 'fixed' ? settings.scale.mmPerMetre : 0;
  const lidarOnly = settings.modelSource === 'lidar';

  const roadExtras = [
    roads.includePaths && 'paths',
    roads.includeRail && 'rail',
    roads.includeAirports && 'airports',
    roads.includeRaceways && 'racetracks',
  ].filter(Boolean);
  const cell = lidarCell(area, settings);
  const lidarWater = { recess: '', layer: ' · water layer', cut: ' · water cut away' }[settings.lidarModel.waterMode];
  const summary = lidarOnly
    ? `LiDAR only${cell !== null ? ` · ${formatNumber(cell, 2)} m cells` : ''}${lidarWater}${rim.enabled ? ' · rim' : ''}`
    : layerSummary(settings);

  const rimRow = (
    <LayerRow
      layer="rim"
      label="Border rim"
      group="rim"
      on={rim.enabled}
      onToggle={(enabled) => patchSettings('rim', { enabled })}
      summary={rim.enabled ? `${mm(rim.heightMm)} high` : 'Off'}
      help="A raised frame around the edge of the model."
      resetKey="rim"
    >
      <RimOptions rim={rim} />
    </LayerRow>
  );

  return (
    <Section id="layers" title="Layers" summary={summary}>
      <Segmented
        label="Build the model from"
        value={settings.modelSource}
        stretch
        onChange={setModelSource}
        options={[
          { value: 'map', label: 'Map data', title: 'Terrain, water, parks, roads and buildings from map data, each in its own colour' },
          { value: 'lidar', label: 'LiDAR only', title: 'Everything a LiDAR survey saw, as one piece in one colour' },
        ]}
      />
      {lidarOnly ? (
        <>
          <LidarModelOptions settings={settings} area={area} />
          <div className="list-box">{rimRow}</div>
        </>
      ) : (
        <>
          <div className="list-box">
            <LayerRow
              layer="terrain"
              label="Terrain"
              checkLabel="Terrain elevation"
              group="terrain"
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
              group="water"
              on={water.enabled}
              onToggle={(enabled) => patchSettings('water', { enabled })}
              summary={waterSummary(water)}
              help="Rivers, lakes, the sea and ponds as their own part, just below their banks. Off leaves the water out: empty recesses, or openings through the base when large water is cut through."
              resetKey="water"
            >
              <WaterOptions water={water} />
            </LayerRow>

            <LayerRow
              layer="land"
              label="Parks and land cover"
              group="green"
              on={land.enabled}
              onToggle={(enabled) => patchSettings('land', { enabled })}
              summary={land.enabled ? `${mm(land.riseMm)} rise${land.satelliteCover ? ' · satellite' : ''}` : 'Off'}
              help="Parks, forest floor, sand, rock and paved plazas as thin slabs on the terrain, each in its own colour."
              resetKey="land"
            >
              <LandOptions land={land} />
            </LayerRow>

            <LayerRow
              layer="roads"
              label="Roads"
              group="roads"
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
              group="roads"
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
              group="buildings"
              on={buildings.enabled}
              onToggle={(enabled) => patchSettings('buildings', { enabled })}
              summary={buildings.enabled ? `Height ×${formatNumber(buildings.heightScale, 2)}${buildings.roofShapes ? ' · roofs' : ''}` : 'Off'}
              help="Buildings from mapped footprints and heights. Buildings without a mapped height use a height for their type, then the default height."
              resetKey="buildings"
            >
              <BuildingOptions buildings={buildings} />
            </LayerRow>

            <LayerRow
              layer="lidar"
              label="LiDAR"
              checkLabel="LiDAR buildings"
              group="buildings"
              on={buildings.enabled && lidar.enabled}
              onToggle={(enabled) => patchSettings('lidar', { enabled })}
              summary={!lidar.enabled ? 'Off' : !buildings.enabled ? 'Needs buildings' : lidar.roofMode === 'envelope' ? 'Whole roofs' : 'Heights only'}
              help="Measures buildings from public LiDAR surveys and rebuilds each one from its scanned roof: setbacks, towers, domes and spires included. Covers the United States, Canada, France, Switzerland, Luxembourg, Slovenia, Scotland, much of Germany and Spain, Trentino, Helsinki, Tokyo and Yokohama, New Zealand, and more of Europe through Open LiDAR Data. Expect 150 MB to 1 GB of downloads per km² depending on the survey, kept in the browser for next time, so start with a small area. Surveys that only come as whole tiles are only downloaded once you agree to. Buildings nothing covers keep their mapped shape."
              resetKey="lidar"
            >
              <LidarOptions settings={settings} area={area} scale={scale} />
            </LayerRow>

            <LayerRow
              layer="trees"
              label="Trees"
              group="trees"
              on={trees.enabled}
              onToggle={(enabled) => patchSettings('trees', { enabled })}
              summary={trees.enabled ? `${trees.spacingM} m spacing` : 'Off'}
              help="Mapped trees and trees scattered through forests, as simple solids sized to print. Trees add a lot of triangles."
              resetKey="trees"
            >
              <TreeOptions trees={trees} />
            </LayerRow>

            {rimRow}
          </div>
          <CheckField
            label="Keep ground under structures in water"
            checked={settings.supports}
            onChange={setSupports}
            help="Roads, buildings and bridge piers standing in water cut from the terrain sit on a strip of ground. Off, they're built down through the water in their own colour instead, to the bottom of it. Either way they still stand if you leave the water out in the slicer. Mapped piers, quays and dams are ground either way."
          />
        </>
      )}
    </Section>
  );
}
