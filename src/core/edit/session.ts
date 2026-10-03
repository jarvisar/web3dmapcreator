// Applies edits to a generated model, in the worker. The viewer keeps the
// generated meshes and gets told what changed: new geometry for an object
// (a building made taller, a shape, a wider bridge), or whole parts: roads
// once they're edited (see roads.ts), and the terrain and water once water
// is left out or what stands in it changes (see earth.ts). Removed objects
// and colours it works out from the edits itself. Exports mesh the edited
// model from scratch.

import {
  boxesOverlap,
  bufferLines,
  ClipSet,
  clipToBox,
  clipToUnits,
  difference,
  differenceSet,
  dropSmall,
  intersection,
  multiArea,
  multiBounds,
  offsetPolygons,
  pointInMulti,
  pointInPolygon,
  rectangle,
  ringBounds,
  union,
  type Box,
} from '../geometry/polygon';
import { interiorPoints } from '../terrain/heightfield';
import type { HeightFn, Layer, PrismSolid, Solid } from '../geometry/solid';
import type { Projection } from '../geo/projection';
import type { DeckPiece } from '../pipeline/bridges';
import { capCache } from '../geometry/mesher';
import { meshLayers } from '../pipeline/mesh';
import { LAND_NAMES, LAND_ROLES, type EditContext, type ModelSpec } from '../pipeline/generate';
import type { ModelSettings, Palette, SurfaceCategory } from '../settings';
import { Wading } from '../pipeline/wading';
import { bareGround, drawnRoad, type DrawnRoad } from './drawn';
import { EarthModel, isRecessed, type Earth } from './earth';
import { cutCover, FILL_REACH_MM, LandCover, LandSlabs, type LandFill } from './land';
import type { LoadedFont } from '../svgmap/text/outline';
import type { ColourGroup, MaterialRole, MeshPart, MultiPolygon, PartColour, PartObjects, Polygon } from '../types';
import { heightFactor, lowestBottom, lowestTop, scaleSolid, solidPeak } from './heights';
import { editOf, isPartKey, kindOf, objectOf, partKey, shapeKey } from './keys';
import { ROAD_PARTS, RoadStyles, RoadTiles, TileGrid, type RoadBucket, type RoadStyle } from './roads';
import { SurfaceCut } from './surfaceCut';
import { missingGlyphs, shapeFootprint, type MissingGlyphs } from './shapes';
import { buriedIn, heldAt, heldPieces, holdersOf, levelOver, outlinePoints, pieceSolids, restPieces, standPieces, wetKey, wetUnder, type Held, type Holder, type StandPiece } from './stand';
import { EDIT_LIMITS, followsGround, type AddedShape, type EditLayer, type ModelEdits, type ObjectEdit, type ShapeKind } from './types';

const CUT_FAILED = "The trees over a drawn road couldn't be cleared from the surface, so parts of the road may be hidden under them.";

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  objects?: PartObjects;
}

/**
 * New geometry for one object in one part, or null to go back to the
 * generated one. A bridge has its deck and its piers in two parts.
 */
export interface ObjectMesh {
  key: string;
  part: string;
  mesh: MeshData | null;
  /** The part's role, for a part the generated model didn't have. */
  role?: MaterialRole;
}

/** Keys of land cover given back to ground a removed road or building left. */
export const FILL_PREFIX = 'lf:';

/** A whole part replaced or added, or null to go back to the generated one (or drop it). */
export interface PartUpdate {
  id: string;
  part: MeshPart | null;
}

export interface EditUpdate {
  /** The model it's for, so a late one for an older model is dropped. */
  model: number;
  /** The edits version this reflects. */
  version: number;
  objects: ObjectMesh[];
  parts: PartUpdate[];
  /** Objects other edits hide, like trees under a shape or a widened road. */
  hidden: string[];
  /** Things worth knowing about an added shape, by key: too thin to print, outside the model. */
  notes: Record<string, string>;
  warnings: string[];
  /**
   * Everything the viewer has from earlier updates of this model goes first:
   * this update sends it all again. After an update failed part way, what
   * the viewer had and what the session thought it had can differ.
   */
  reset?: boolean;
}

export interface FontSource {
  load(id: string): Promise<LoadedFont>;
}

/** What the viewer shows about an object. */
export interface ObjectFacts {
  kind: string;
  name?: string;
  /** Class or type, e.g. "office". */
  detail?: string;
  /** As mapped or measured, in metres. */
  heightM?: number;
  /** Printed, from its ground to its highest point. */
  heightMm?: number;
  /** Its ground level in the viewer's coordinates, which heights count from. */
  groundZ?: number;
  measured?: boolean;
  /** A building's parts, tallest first, when it has more than one. */
  parts?: { sub: string; heightMm: number }[];
  /** A bridge's deck width, as generated. */
  widthMm?: number;
  /** Water in a recess of its own, which is filled or kept once the water's left out. */
  recessed?: boolean;
  /** A bridge's middle along its road's segment, so it takes the edit of the block it's in (keys.ts editOf). */
  at?: number;
}

// A raised part clearing what's under it by less than a 0.2 mm layer rests on
// it, as buildings.ts has it.
const CLEARANCE_MM = 0.2;
// Features thinner than a 0.4 mm nozzle prints are what a shape's note warns
// about. The probe is a little narrower, so a single-line font's 0.4 mm
// strokes pass.
const NOZZLE_MM = 0.4;
const PROBE_MM = 0.36;
// Drawn roads and outlines, boxes and cylinders stand in water like the
// roads and buildings they stand for: on ground kept for them, or built down
// through it with supports off. Text and pins always go down through it.
const SUPPORTED: ReadonlySet<ShapeKind> = new Set(['path', 'area', 'box', 'cylinder']);
// In a LiDAR only model a shape reaches this far into the surface, which is
// the terrain part and wins the overlap, rather than following every roof edge.
const SURFACE_DEPTH_MM = 0.3;
// A shape this much inside something taller gets a note that it won't show.
const BURIED_SHARE = 0.9;
// Points on a shape's outline looked at before all of it, and the share of
// them that has to be inside something for the rest to be looked at.
const BURIED_PROBES = 16;
const PROBES_INSIDE = 0.75;
// A roof this little over a raised shape's base still counts as what it was
// raised onto. The lift is rounded to 0.1 mm when it's placed, and over
// water it counts from the water, 0.25 mm under the bank it was measured from.
const SUPPORT_TOLERANCE_MM = 0.5;
const SUPPORT_MIN_MM2 = 1e-3;
const SLIVER_MM = 0.001;
// A shape's ground this close to a tile counts as in it, since land cover cut
// beside the tile's edge is opened across it.
const GROUND_REACH_MM = 0.01;

/** Where added shapes show in the viewer. They export in their layer's part. */
export const SHAPES_PART = 'shapes';

const ROAD_PART_IDS = new Set(Object.values(ROAD_PARTS));

export function layerPartId(layer: string): string {
  return `layer:${layer}`;
}

/**
 * Part ids an export leaves out, from the ones hidden in the viewer. A custom
 * layer takes its water part with it, and hidden added shapes take every
 * colour's.
 */
export function excludedParts(spec: ModelSpec, hidden: readonly string[] = []): string[] {
  const out = new Set(hidden);
  for (const layer of spec.layers) {
    if (layer.id.endsWith(':water') && out.has(layer.id.slice(0, -':water'.length))) out.add(layer.id);
    if (layer.id.startsWith('added-') && out.has(SHAPES_PART)) out.add(layer.id);
  }
  return [...out];
}

function waterRank(role: MaterialRole): boolean {
  return role === 'water';
}

/** Role a colour group's own solids have, for a shape of that colour. */
const GROUP_ROLE: Record<ColourGroup, MaterialRole> = {
  terrain: 'terrain',
  buildings: 'building',
  roads: 'road',
  route: 'route',
  paved: 'paved',
  water: 'water',
  green: 'green',
  forest: 'forest',
  trees: 'tree',
  sand: 'sand',
  rock: 'rock',
  rim: 'rim',
};

interface Placed {
  layer: Layer;
  solids: Solid[];
}

/** Where a building (or one part of it) stands, which keeps land cover off. */
interface Ground {
  key: string;
  sub: string;
  box: Box;
  pieces: MultiPolygon;
}

/** Water bodies the edits leave out, by index into the context's bodies. */
interface WaterState {
  removed: Set<number>;
  /** Filled with ground at the level of their banks. */
  filled: Set<number>;
  /** Kept as a recess. */
  hollow: Set<number>;
  /** Filled bodies and removed sheets, whose ground gets its land cover back. */
  vacated: Set<number>;
  signature: string;
}

/** What an update or export works from, worked out once. */
interface Pass {
  edits: ModelEdits;
  reshaped: Map<string, [string, ObjectEdit][]>;
  /** Objects' solids with their height edits, as they're asked for. */
  solids: Map<string, { layer: Layer; solid: Solid }[]>;
  water: WaterState;
}

/** A drawn road's footprint, which the roads, railways and paths under it give way to. */
interface RoadCut {
  signature: string;
  polygons: MultiPolygon;
  /** The road tiles it reaches, worked out once. */
  tiles?: number[];
}

/** What the road tiles were rebuilt for: styles by key as JSON, and drawn roads by shape key. */
interface RoadState {
  styles: Map<string, string>;
  cuts: Map<string, RoadCut>;
}

/** Where shapes stand on the ground, which land cover gives way to. */
interface GroundCut {
  set: ClipSet;
  /** What's in each tile it reaches, to tell which tiles changed. */
  tiles: Map<number, string>;
}

/** A bridge's deck and piers at an edited width. */
interface Deck {
  width: number;
  decks: PrismSolid[];
  /** Piers cut to a narrower deck, or null when they stand as they were. */
  piers: PrismSolid[] | null;
  ribbon: MultiPolygon;
}



/** A shape's footprint and where it stands, before what's under it is known. */
interface ShapeTop {
  polygons: MultiPolygon;
  /** Underside of a flat shape if it floated, or null for one that follows the ground. */
  base: number | null;
  top: number | null;
}

interface Standing {
  signature: string;
  solids: PrismSolid[];
  /** What it's hidden inside, for a note. */
  buried: string | null;
  /** The parts of its footprint something holds up, which don't stand in the water or on the ground under it. */
  held: MultiPolygon;
  /** The rest, on the ground or in the water. */
  ground: MultiPolygon;
  /** Its footprint less what's held, whatever the water under it does. */
  unheld: MultiPolygon;
  /** A road drawn on a LiDAR only model: where the trees over it are cleared from the surface. */
  cleared?: MultiPolygon;
}

/** What held a shape up, and the rest of its footprint, for a footprint that may stay the same. */
interface HeldGuess {
  footprint: MultiPolygon;
  held: MultiPolygon;
  unheld: MultiPolygon;
}

/** A text shape's font, as far as its note goes. */
interface TextState {
  /** The font failed to load. */
  unloaded?: boolean;
  /** Characters it has no glyph for, and how they print. */
  missing?: MissingGlyphs;
}

export class EditSession {
  private readonly ctx: EditContext;
  private readonly zShift: number;
  private readonly crop: MultiPolygon;
  /** Keyed solids by object key, in the layers they were generated in. */
  private readonly objects = new Map<string, Placed[]>();
  private readonly treeAnchors: { key: string; x: number; y: number }[] = [];
  private roads: RoadTiles | null = null;
  /** What each tile holds now, for tiles built from edited roads. */
  private tiles = new Map<number, RoadBucket[]>();
  /** Meshed tiles for the viewer, by tile and then part. */
  private readonly tileMeshes = new Map<number, Map<string, MeshData>>();
  private readonly tileSignatures = new Map<number, Map<string, string>>();
  private tiled = false;
  private roadState: RoadState = { styles: new Map(), cuts: new Map() };
  /** The last update failed part way, so the next sends everything again. */
  private resend = false;
  /** What the viewer has from this session, by part and key. */
  private readonly sentObjects = new Map<string, { key: string; part: string; signature: string }>();
  private readonly sentParts = new Map<string, string>();
  private sentTerrain: PrismSolid[] | null = null;
  private sentWater: PrismSolid[] | null = null;
  /** Built shape footprints, by the shape's geometry. */
  private readonly footprints = new Map<string, { signature: string; polygons: MultiPolygon; missing?: MissingGlyphs }>();
  /** Fonts that failed to load and were warned about, until they load. */
  private readonly fontFailures = new Set<string>();
  private readonly notes = new Map<string, { signature: string; note: string | null }>();
  private readonly grounds: Ground[] = [];
  /** Road edits and land fills are worked out in the same tiles. */
  private readonly grid: TileGrid;
  private landCover: LandCover | null = null;
  /** Where each tile's land fill can reach, by what the tile had. */
  private readonly tileReach = new Map<number, { signature: string; reach: MultiPolygon }>();
  /** Land fill of each tile, by what it and the tiles around it had. */
  private readonly tileFills = new Map<number, { signature: string; fills: LandFill[] }>();
  private airport: ClipSet | null = null;
  /** Building grounds by the tiles they reach, for what keeps land cover off. */
  private groundTiles: Map<number, number[]> | null = null;
  private fillCache: { signature: string; fills: LandFill[] } | null = null;
  /** Water that still keeps land cover off, once some is left out. */
  private landWater: { signature: string; set: ClipSet } | null = null;
  private landSlabs: LandSlabs | null = null;
  /** The view's land cover meshed a tile at a time, by category and tile, with what was cut from each. */
  private readonly landTiles = new Map<SurfaceCategory, Map<number, { signature: string; mesh: MeshData | null }>>();
  /** Land parts the view has from this session, by what they were made of. */
  private readonly sentLand = new Map<SurfaceCategory, string>();
  /** A shape's ground and the tiles it reaches, by the ground pieces, which stay the same object while the shape does. */
  private readonly groundInfo = new WeakMap<MultiPolygon, { signature: string; tiles: number[] }>();
  private readonly earthModel: EarthModel | null;
  /** Water bodies by key. A feature the model edge cuts in two is two bodies. */
  private readonly bodiesByKey = new Map<string, number[]>();
  /** Cut water and basins, where ground is only kept under structures. */
  private readonly noGround: ClipSet | null;
  private readonly noGroundBox: Box | null;
  private readonly wetTiles = new Map<number, MultiPolygon>();
  private wetGrounds: { ground: Ground; pieces: MultiPolygon }[] | null = null;
  private wetPiers: { key: string; pieces: MultiPolygon }[] | null = null;
  private inWaterCache: { signature: string; kept: MultiPolygon | null; standing: MultiPolygon | null } | null = null;
  /** With supports off, roads, buildings and piers standing in water go down through it. */
  private readonly wading: Wading | null;
  private readonly decks = new Map<string, DeckPiece[]>();
  private readonly deckCache = new Map<string, Deck>();
  /** Routes some deck carries: their solids on decks, by the deck's key. */
  private readonly routesOnDecks = new Map<string, Map<Solid, string>>();
  /** Buildings and bridges by the tiles they reach, for what a shape stands on. */
  private holderIndex: Map<number, string[]> | null = null;
  private readonly holderBoxes = new Map<string, Box>();
  /** Raised parts built down to the ground once what held them up went. */
  private readonly groundedSolids = new WeakSet<Solid>();
  private readonly tops = new Map<string, { signature: string; top: ShapeTop }>();
  private readonly standing = new Map<string, Standing>();
  /** A flat shape's pieces: what holds it up, kept while that stays, and over the water and ground. */
  private readonly pieces = new Map<string, { held: string; value: Held; wet: string; rest: StandPiece[] }>();
  /** Caps of what was meshed for the viewer, for meshing it again at other heights. */
  private readonly caps = capCache();
  /** What held each shape up last time, for the next pass's first try (standAll). */
  private heldGuess = new Map<string, HeldGuess>();
  /** Holders from each object's solids as generated, for what raised shapes stood on. */
  private readonly generatedHolders = new Map<string, Holder[][]>();
  /** A LiDAR only model's water. */
  private readonly surfaceWater: { polygons: MultiPolygon; box: Box; floor: number | null }[];
  /** Clears a LiDAR only model's surface over drawn roads, made the first time one clears anything. */
  private cutter: SurfaceCut | null | undefined;
  /** What was cleared in the surface the viewer has, '' for none. */
  private sentCut = '';

  constructor(
    private readonly spec: ModelSpec,
    private readonly settings: ModelSettings,
    private readonly projection: Projection,
    private readonly fonts?: FontSource,
    /** The generation this model came from. */
    readonly id = 0,
  ) {
    if (!spec.edit) throw new Error('This model cannot be edited');
    this.ctx = spec.edit;
    this.zShift = -spec.baseZ;
    this.crop = [spec.crop];
    this.grid = new TileGrid(ringBounds(spec.crop[0]));
    for (const layer of spec.layers) {
      for (const solid of layer.solids) {
        if (!solid.key) continue;
        let placed = this.objects.get(solid.key);
        if (!placed) this.objects.set(solid.key, (placed = []));
        let entry = placed.find((p) => p.layer === layer);
        if (!entry) placed.push((entry = { layer, solids: [] }));
        entry.solids.push(solid);
        if (solid.kind === 'mesh' && solid.key.startsWith('t:')) this.treeAnchors.push({ key: solid.key, x: solid.anchor[0], y: solid.anchor[1] });
      }
    }
    for (const [key, info] of this.ctx.objects) {
      for (const [sub, pieces] of info.ground ?? []) {
        if (pieces.length) this.grounds.push({ key, sub, box: multiBounds(pieces), pieces });
      }
    }
    const hasWater = spec.layers.some((layer) => layer.id === 'water');
    // With the water turned off there's no water to edit, only its empty
    // recesses, and the inspector lists water edits as for things the model
    // lacks. They filled the recesses all the same.
    this.ctx.bodies.forEach((body, i) => {
      if (!body.key || !hasWater) return;
      const list = this.bodiesByKey.get(body.key);
      if (list) list.push(i);
      else this.bodiesByKey.set(body.key, [i]);
    });
    for (const deck of this.ctx.decks) {
      const list = this.decks.get(deck.key);
      if (list) list.push(deck);
      else this.decks.set(deck.key, [deck]);
    }
    for (const [solid, deck] of this.ctx.routeDecks ?? []) {
      let carried = this.routesOnDecks.get(solid.key!);
      if (!carried) this.routesOnDecks.set(solid.key!, (carried = new Map()));
      carried.set(solid, deck);
    }
    const noGround = this.ctx.noGround;
    this.noGround = noGround.length ? new ClipSet([noGround]) : null;
    this.noGroundBox = noGround.length ? multiBounds(noGround) : null;
    this.earthModel = this.ctx.terrain && this.ctx.heightfield ? new EarthModel(this.ctx, settings, spec.baseZ, this.crop, hasWater) : null;
    this.surfaceWater = (this.ctx.surfaceWater ?? []).filter((w) => w.polygons.length).map((w) => ({ ...w, box: multiBounds(w.polygons) }));
    const embed = settings.land.embedMm;
    this.wading =
      settings.supports || !this.noGround
        ? null
        : new Wading(this.ctx.bodies.flatMap((body) => (isRecessed(body) ? [{ polygons: body.floors, footing: body.floor !== null ? body.floor - embed : spec.baseZ }] : [])));
  }

  /** An object's edit as it applies, a bridge's with its road's at the deck (keys.ts). */
  private editOf(edits: ModelEdits, key: string): ObjectEdit | undefined {
    return editOf(edits, key, key.startsWith('br:') ? this.decks.get(key)?.[0]?.at : undefined);
  }

  /**
   * A route's solids on removed decks. They go with the deck, the way the
   * road on it does: kept, the route stood in the air over the river.
   */
  private offDecks(edits: ModelEdits, key: string): Set<Solid> | null {
    const carried = this.routesOnDecks.get(key);
    if (!carried) return null;
    const gone = new Set<Solid>();
    const removed = new Map<string, boolean>();
    for (const [solid, deck] of carried) {
      let off = removed.get(deck);
      if (off === undefined) removed.set(deck, (off = Boolean(this.editOf(edits, deck)?.removed)));
      if (off) gone.add(solid);
    }
    return gone.size ? gone : null;
  }

  /** Object facts for the viewer: what it is, what it's called, how tall. */
  describe(): Record<string, ObjectFacts> {
    const out: Record<string, ObjectFacts> = {};
    const round = (mm: number) => Math.round(mm * 100) / 100;
    for (const [key, info] of this.ctx.objects) {
      const entry: ObjectFacts = { kind: info.kind };
      if (info.name) entry.name = info.name;
      if (info.detail) entry.detail = info.detail;
      if (info.heightM !== undefined) entry.heightM = Math.round(info.heightM * 10) / 10;
      if (info.measured) entry.measured = true;
      const placed = this.objects.get(key);
      if (placed && info.base !== undefined) {
        const peaks = new Map<string, number>();
        for (const p of placed) for (const s of p.solids) peaks.set(s.sub ?? '', Math.max(peaks.get(s.sub ?? '') ?? -Infinity, peakOfSolid(s)));
        const peak = Math.max(...peaks.values());
        if (Number.isFinite(peak)) entry.heightMm = round(peak - info.base);
        entry.groundZ = info.base + this.zShift;
        if (info.kind === 'building' && peaks.size > 1) {
          entry.parts = [...peaks].map(([sub, top]) => ({ sub, heightMm: round(top - info.base!) })).sort((a, b) => b.heightMm - a.heightMm);
        }
      }
      const decks = this.decks.get(key);
      if (info.kind === 'bridge' && decks?.length) entry.widthMm = round(Math.max(...decks.map((d) => d.widthMm)));
      if (info.kind === 'bridge' && decks?.[0]?.at !== undefined) entry.at = decks[0].at;
      if (info.kind === 'water' && this.bodiesByKey.get(key)?.some((i) => isRecessed(this.ctx.bodies[i]))) entry.recessed = true;
      out[key] = entry;
    }
    return out;
  }

  /** Printed mm per real metre of a building's height, as this model was generated. */
  get buildingScale(): number {
    const scale = this.settings.buildings.heightScale;
    return this.projection.mm(1) * (scale > 0 && Number.isFinite(scale) ? scale : 1);
  }

  // ------------------------------------------------------------ geometry

  /** A building edit's height as printed, from its real one. */
  private printedHeight(edit: ObjectEdit | undefined): number | undefined {
    if (edit?.heightM === undefined) return undefined;
    const [low, high] = EDIT_LIMITS.buildingHeightMm;
    return Math.min(high, Math.max(low, edit.heightM * this.buildingScale));
  }

  private pass(edits: ModelEdits): Pass {
    return { edits, reshaped: this.reshaped(edits), solids: new Map(), water: this.waterState(edits) };
  }

  /**
   * Buildings whose geometry the edits change, with the edits that do: a
   * height of their own or of a part, or a part removed. Grouped once, since
   * a box around a whole city can give every building a height.
   */
  private reshaped(edits: ModelEdits): Map<string, [string, ObjectEdit][]> {
    const out = new Map<string, [string, ObjectEdit][]>();
    for (const [key, edit] of Object.entries(edits.objects)) {
      if (kindOf(key) !== 'building') continue;
      if (edit.heightM === undefined && !(isPartKey(key) && edit.removed)) continue;
      const object = objectOf(key);
      if (!this.objects.has(object)) continue;
      const list = out.get(object);
      if (list) list.push([key, edit]);
      else out.set(object, [[key, edit]]);
    }
    return out;
  }

  private waterState(edits: ModelEdits): WaterState {
    const out: WaterState = { removed: new Set(), filled: new Set(), hollow: new Set(), vacated: new Set(), signature: '' };
    const keys: string[] = [];
    for (const [key, indices] of this.bodiesByKey) {
      const edit = edits.objects[key];
      if (!edit?.removed) continue;
      keys.push(edit.hollow ? `${key}:hollow` : key);
      for (const i of indices) {
        out.removed.add(i);
        if (!isRecessed(this.ctx.bodies[i])) out.vacated.add(i);
        else if (edit.hollow) out.hollow.add(i);
        else {
          out.filled.add(i);
          out.vacated.add(i);
        }
      }
    }
    out.signature = keys.sort().join(';');
    return out;
  }

  /** An object's solids with its height edits, in the order the model has them. */
  private solidsOf(pass: Pass, key: string): { layer: Layer; solid: Solid }[] {
    let list = pass.solids.get(key);
    if (list) return list;
    const own = pass.reshaped.get(key);
    list = own ? this.editedSolids(key, pass.edits, own) : (this.objects.get(key) ?? []).flatMap((p) => p.solids.map((solid) => ({ layer: p.layer, solid })));
    pass.solids.set(key, list);
    return list;
  }

  /**
   * Every solid of an object with its height edits applied, in the order the
   * model has them. A solid the edits leave alone is the same object.
   */
  private editedSolids(key: string, edits: ModelEdits, own: [string, ObjectEdit][]): { layer: Layer; solid: Solid }[] {
    const placed = this.objects.get(key) ?? [];
    const out: { layer: Layer; solid: Solid }[] = [];
    const base = this.ctx.objects.get(key)?.base;
    const all = placed.flatMap((p) => p.solids);
    const wholeHeight = this.printedHeight(edits.objects[key]);
    // The building's height is what's left of it, or taking out its tallest part left it short.
    const standing = all.filter((s) => !(s.sub && edits.objects[partKey(key, s.sub)]?.removed));
    const wholeFactor = base !== undefined && wholeHeight !== undefined ? heightFactor(standing.length ? standing : all, base, wholeHeight) : 1;
    // A part with a height of its own takes it, whatever the building's.
    const partFactors = new Map<string, number>();
    if (base !== undefined) {
      const subs = new Set(all.map((s) => s.sub ?? ''));
      for (const sub of subs) {
        const height = sub ? this.printedHeight(edits.objects[partKey(key, sub)]) : undefined;
        if (height === undefined) continue;
        partFactors.set(sub, heightFactor(all.filter((s) => (s.sub ?? '') === sub), base, height));
      }
    }
    for (const { layer, solids } of placed) {
      for (const solid of solids) {
        const factor = partFactors.get(solid.sub ?? '') ?? wholeFactor;
        out.push({ layer, solid: base !== undefined && factor !== 1 ? scaleSolid(solid, base, factor) : solid });
      }
    }
    return own.some(([k]) => isPartKey(k)) ? this.settle(key, out, edits) : out;
  }

  /**
   * A raised part (an arcade's upper floors, a tower on a podium) left on air
   * once what held it up is removed or lowered is built down to the ground,
   * the way raised parts are built by default. A whole building's height
   * scales every part alike, so only part edits can do this.
   */
  private settle(key: string, list: { layer: Layer; solid: Solid }[], edits: ModelEdits): { layer: Layer; solid: Solid }[] {
    const removed = (solid: Solid) => Boolean(solid.sub && edits.objects[partKey(key, solid.sub)]?.removed);
    const standing = list.filter(({ solid }) => solid.kind === 'prism' && !removed(solid)).map(({ solid }) => solid as PrismSolid);
    const boxes = new Map(standing.map((s) => [s, ringBounds(s.polygon[0])]));
    return list.map((entry) => {
      const solid = entry.solid;
      if (solid.kind !== 'prism' || typeof solid.bottom !== 'number' || removed(solid)) return entry;
      const bottom = solid.bottom;
      if (bottom - highestGround(this.ctx, [solid.polygon]) < CLEARANCE_MM) return entry;
      const box = boxes.get(solid)!;
      const held = standing.some((other) => {
        if (other === solid || solidPeak(other) < bottom - CLEARANCE_MM || lowestBottom(other) >= bottom) return false;
        if (!boxesOverlap(box, boxes.get(other)!)) return false;
        return multiArea(intersection([solid.polygon], [other.polygon])) >= 0.01;
      });
      if (held) return entry;
      const grounded = this.grounded(solid);
      this.groundedSolids.add(grounded);
      return { layer: entry.layer, solid: grounded };
    });
  }

  private grounded(solid: PrismSolid): PrismSolid {
    const hf = this.ctx.heightfield;
    const embed = this.settings.land.embedMm;
    // Where the hill rises over the part's top, the underside stays under it.
    const ceiling = lowestTop(solid) - 0.05;
    // In water with supports off it goes down through it, all of it: what's
    // over land is in the terrain, which wins the overlap.
    const box = ringBounds(solid.polygon[0]);
    const footings = this.wading?.bodies.filter((b) => boxesOverlap(b.box, box) && intersection([solid.polygon], b.polygons).length) ?? [];
    if (footings.length) return { ...solid, bottom: Math.min(ceiling, ...footings.map((b) => b.footing)), drape: 0, lattice: undefined };
    const bottom = (x: number, y: number) => Math.min(this.ctx.heightAt(x, y) - embed, ceiling);
    const draped = hf !== undefined && !hf.flat;
    return { ...solid, bottom, drape: draped ? hf.step : 0, lattice: draped ? hf.lattice : undefined };
  }

  private async mesh(layerId: string, role: MaterialRole, solids: Solid[]): Promise<MeshData | null> {
    if (!solids.length) return null;
    const { parts } = await meshLayers([{ id: layerId, name: layerId, role, solids }], { zShift: this.zShift, objects: true, caps: this.caps });
    const part = parts[0];
    return part ? { positions: part.positions, indices: part.indices, objects: part.objects } : { positions: new Float32Array(0), indices: new Uint32Array(0) };
  }

  private async meshPart(layer: Layer): Promise<MeshPart> {
    const { parts } = await meshLayers([layer], { zShift: this.zShift, objects: true });
    return parts[0] ?? { id: layer.id, name: layer.name, role: layer.role, positions: new Float32Array(0), indices: new Uint32Array(0) };
  }

  /**
   * A shape's footprint, and for text what its note needs to know about the
   * font. A font that didn't load is tried again next time, and with
   * `warnOnce` only said once until it loads, not on every edit.
   */
  private async footprint(shape: AddedShape, warnings: string[], warnOnce: boolean): Promise<{ polygons: MultiPolygon; text?: TextState }> {
    const signature = JSON.stringify([shape.kind, shape.at, shape.points, shape.rotationDeg, shape.sizeMm, shape.depthMm, shape.text, shape.font]);
    const cached = this.footprints.get(shape.id);
    if (cached?.signature === signature) return { polygons: cached.polygons, text: cached.missing ? { missing: cached.missing } : undefined };
    let font: LoadedFont | null = null;
    if (shape.kind === 'text') {
      try {
        if (!this.fonts) throw new Error('');
        font = await this.fonts.load(shape.font);
        this.fontFailures.delete(shape.font);
      } catch (error) {
        if (!warnOnce || !this.fontFailures.has(shape.font)) {
          warnings.push(`The font for “${shape.text}” could not be loaded. ${error instanceof Error ? error.message : ''}`.trim());
        }
        this.fontFailures.add(shape.font);
        return { polygons: [], text: { unloaded: true } };
      }
    }
    const polygons = shapeFootprint(shape, this.projection, this.crop, font) ?? [];
    const missing = font ? missingGlyphs(shape.text, font) : undefined;
    this.footprints.set(shape.id, { signature, polygons, missing });
    return { polygons, text: missing ? { missing } : undefined };
  }

  private async shapeFootprints(edits: ModelEdits, warnings: string[], warnOnce = false): Promise<{ polygons: Map<string, MultiPolygon>; text: Map<string, TextState> }> {
    const polygons = new Map<string, MultiPolygon>();
    const text = new Map<string, TextState>();
    for (const shape of edits.shapes) {
      const built = await this.footprint(shape, warnings, warnOnce);
      polygons.set(shape.id, built.polygons);
      if (built.text) text.set(shape.id, built.text);
    }
    for (const id of [...this.footprints.keys()]) if (!polygons.has(id)) this.footprints.delete(id);
    return { polygons, text };
  }

  // ------------------------------------------------------------- shapes

  /** Where a shape's top goes, from the ground and water under it and what it was raised onto. */
  private shapeTop(shape: AddedShape, polygons: MultiPolygon, earth: Earth | null, pass: Pass, decks: Map<string, Deck>): ShapeTop {
    if (!polygons.length || followsGround(shape)) return { polygons, base: null, top: null };
    const box = multiBounds(polygons);
    const supports = shape.liftMm > 0 && this.ctx.heightfield ? this.holderKeys(box) : [];
    const signature = JSON.stringify([polygonSignature(polygons), shape.liftMm, shape.heightMm, wetKey(earth?.wet ?? [], box), supports.map((k) => this.holderState(k, pass, decks))]);
    const cached = this.tops.get(shape.id);
    if (cached?.signature === signature) return cached.top;
    let surface = -Infinity;
    if (earth?.wet.length) {
      const { dry, levels } = wetUnder(polygons, earth.wet);
      if (dry.length) surface = highestGround(this.ctx, dry);
      for (const level of levels) surface = Math.max(surface, level);
    }
    if (!Number.isFinite(surface)) surface = highestGround(this.ctx, polygons);
    const raised = surface + shape.liftMm;
    const base = raised + (supports.length ? this.supportShift(polygons, box, raised, surface, supports, pass) : 0);
    const top = { polygons, base, top: base + shape.heightMm };
    this.tops.set(shape.id, { signature, top });
    return top;
  }

  /**
   * How far a raised shape moves with what it was raised onto: whatever it
   * stood on or over as generated. A roof made taller takes it up, and once
   * the building is removed it comes down to what's under that, the same
   * height over it. At a fixed height a pin on a roof was buried by a taller
   * building and left as a column when it was removed.
   */
  private supportShift(polygons: MultiPolygon, box: Box, base: number, surface: number, keys: string[], pass: Pass): number {
    const near = new ClipSet([polygons]);
    let before = surface;
    let after = surface;
    for (const key of keys) {
      const now = this.holdersNow(key, pass);
      this.holdersAsGenerated(key).forEach((holders, i) => {
        holders.forEach((holder, j) => {
          if (holder.bottom >= base || !boxesOverlap(holder.box, box)) return;
          const local = near.polygonsWithin(holder.box);
          if (!local.length) return;
          const region = intersection(local, [holder.polygon]);
          if (multiArea(region) < SUPPORT_MIN_MM2) return;
          const top = levelOver(holder, region);
          if (!(top <= base + SUPPORT_TOLERANCE_MM)) return;
          before = Math.max(before, top);
          const current = now?.[i]?.[j];
          if (current) after = Math.max(after, levelOver(current, region));
        });
      });
    }
    return after - before;
  }

  /** What each of an object's solids held up as generated, per solid. */
  private holdersAsGenerated(key: string): Holder[][] {
    let list = this.generatedHolders.get(key);
    if (!list) {
      const bridge = key.startsWith('br:');
      const solids = (this.objects.get(key) ?? []).flatMap((p) => p.solids).filter((s) => !bridge || s.sub === 'deck');
      this.generatedHolders.set(key, (list = solids.map((solid) => holdersOf(solid, bridge ? 'bridge' : 'building'))));
    }
    return list;
  }

  /**
   * The same with the edits, null for an object removed and per solid for a
   * part removed. Only a building's height changes: a bridge made wider or
   * narrower keeps its heights.
   */
  private holdersNow(key: string, pass: Pass): (Holder[] | null)[] | null {
    if (this.editOf(pass.edits, key)?.removed) return null;
    if (kindOf(key) !== 'building') return this.holdersAsGenerated(key);
    return this.solidsOf(pass, key).map(({ solid }) => (solid.sub && pass.edits.objects[partKey(key, solid.sub)]?.removed ? null : holdersOf(solid, 'building')));
  }

  /** Every shape as it stands, by id. */
  private standShapes(pass: Pass, decks: Map<string, Deck>, earth: Earth | null, footprints: Map<string, MultiPolygon>): Map<string, Standing> {
    const tops = new Map<string, ShapeTop>();
    for (const shape of pass.edits.shapes) tops.set(shape.id, this.shapeTop(shape, footprints.get(shape.id) ?? [], earth, pass, decks));
    const out = new Map<string, Standing>();
    for (const shape of pass.edits.shapes) out.set(shape.id, this.stand(shape, tops, pass, decks, earth));
    for (const id of [...this.standing.keys()]) if (!tops.has(id)) this.standing.delete(id);
    for (const id of [...this.tops.keys()]) if (!tops.has(id)) this.tops.delete(id);
    for (const id of [...this.pieces.keys()]) if (!tops.has(id)) this.pieces.delete(id);
    return out;
  }

  /**
   * A shape built down to what it stands on (stand.ts): the roof or deck it
   * was raised onto, another shape, the water, or the ground.
   */
  private stand(shape: AddedShape, tops: Map<string, ShapeTop>, pass: Pass, decks: Map<string, Deck>, earth: Earth | null): Standing {
    const top = tops.get(shape.id)!;
    if (!top.polygons.length) return { signature: '', solids: [], buried: null, held: [], ground: [], unheld: [] };
    const ctx = this.ctx;
    const hf = ctx.heightfield;
    const key = shapeKey(shape.id);
    const box = multiBounds(top.polygons);
    const flat = top.base !== null && top.top !== null;
    const holderKeys = flat && hf ? this.holderKeys(box) : [];
    const others = flat
      ? pass.edits.shapes.filter((other) => {
          const t = tops.get(other.id);
          return other.id !== shape.id && t?.base != null && t.polygons.length > 0 && boxesOverlap(multiBounds(t.polygons), box);
        })
      : [];
    const footprint = polygonSignature(top.polygons);
    const wetState = wetKey(earth?.wet ?? [], box);
    const holderStates = holderKeys.map((k) => this.holderState(k, pass, decks));
    const otherStates = others.map((other) => {
      const t = tops.get(other.id)!;
      return [other.id, t.base, t.top, polygonSignature(t.polygons)];
    });
    const signature = JSON.stringify([footprint, shape.heightMm, shape.liftMm, shape.followGround, top.base, wetState, holderStates, otherStates]);
    const cached = this.standing.get(shape.id);
    if (cached?.signature === signature) return flat || !hf ? cached : { ...cached, buried: this.buriedOnGround(shape, top.polygons, pass, decks) };

    const embed = this.settings.land.embedMm;
    const rise = shape.liftMm + shape.heightMm;
    let solids: PrismSolid[];
    let buried: string | null = null;
    const held: MultiPolygon = [];
    let ground: MultiPolygon = top.polygons;
    let unheld: MultiPolygon = top.polygons;
    let cleared: MultiPolygon | undefined;
    if (!hf) {
      // A LiDAR only model's surface holds everything, roofs and all. Over
      // its water a shape goes down to the floor, or through a cut to the base.
      // A drawn road rests on the ground under it instead (drawn.ts).
      const cap = flat ? top.top! - 0.05 : Infinity;
      const road = !flat && shape.kind === 'path' ? this.drawnRoad(shape, embed) : null;
      cleared = road?.cleared;
      if (road && road.hidden >= BURIED_SHARE) buried = 'surface';
      const shapeTop: HeightFn | number = flat ? top.top! : road ? (x, y) => road.restsOn(x, y) + rise : (x, y) => ctx.heightAt(x, y) + rise;
      const drape = flat ? 0 : (road?.drape ?? 1);
      const prism = (polygon: Polygon, bottom: HeightFn | number): PrismSolid => ({ kind: 'prism', role: 'building', polygon, top: shapeTop, bottom, drape, key });
      let land = top.polygons;
      let cut = false;
      solids = [];
      for (const water of this.surfaceWater) {
        if (!land.length) break;
        if (!boxesOverlap(water.box, box)) continue;
        const piece = openSlivers(intersection(land, water.polygons));
        if (multiArea(piece) < SUPPORT_MIN_MM2) continue;
        land = difference(land, water.polygons);
        cut = true;
        const footing = water.floor !== null ? water.floor - embed : this.spec.baseZ;
        for (const polygon of piece) solids.push(prism(polygon, Math.min(footing, cap)));
      }
      if (cut) land = openSlivers(land);
      if (land.length) {
        const floor = this.spec.baseZ + 0.05;
        const bottom: HeightFn | number = road
          ? (x, y) => Math.max(floor, Math.min(road.restsOn(x, y), road.surfaceAt(x, y)) - road.sink)
          : Math.min(lowestGround(ctx, land) - SURFACE_DEPTH_MM, cap);
        for (const polygon of land) solids.push(prism(polygon, bottom));
      }
    } else {
      const surface = { heightAt: ctx.heightAt, drape: hf.flat ? 0 : hf.step, lattice: hf.flat ? undefined : hf.lattice };
      const wet = earth?.wet ?? [];
      if (!flat) {
        const pieces = standPieces(top.polygons, null, null, [], wet, embed);
        solids = pieces.flatMap((piece) => pieceSolids(piece, piece.level !== undefined ? piece.level + rise : (x, y) => ctx.heightAt(x, y) + rise, surface, embed, key));
        buried = this.buriedOnGround(shape, top.polygons, pass, decks);
      } else {
        // A taller or shorter shape, or the water changing, leaves what holds it up as it was.
        const heldState = JSON.stringify([footprint, top.base, holderStates, otherStates]);
        const known = this.pieces.get(shape.id);
        let value = known?.held === heldState ? known.value : null;
        if (!value) {
          const holders = this.holders(holderKeys, box, pass, decks);
          for (const other of others) {
            const t = tops.get(other.id)!;
            for (const polygon of t.polygons) holders.push({ kind: 'shape', polygon, box: ringBounds(polygon[0]), topAt: () => t.top!, flat: t.top!, bottom: t.base! });
          }
          value = heldPieces(top.polygons, top.base!, holders, embed);
        }
        const rest = known && known.value === value && known.wet === wetState ? known.rest : restPieces(value.remaining, wet);
        this.pieces.set(shape.id, { held: heldState, value, wet: wetState, rest });
        unheld = value.remaining;
        const pieces = [...heldAt(value, top.top!), ...rest];
        solids = pieces.flatMap((piece) => pieceSolids(piece, top.top!, surface, embed, key));
        ground = [];
        for (const piece of pieces) (piece.held ? held : ground).push(...piece.polygons);
        let hidden = 0;
        for (const piece of pieces) {
          if (!piece.buried) continue;
          hidden += multiArea(piece.polygons);
          buried = piece.buried;
        }
        if (hidden < multiArea(top.polygons) * BURIED_SHARE) buried = null;
      }
    }
    const standing = { signature, solids, buried, held, ground, unheld, cleared };
    this.standing.set(shape.id, standing);
    return standing;
  }

  /** A path drawn on a LiDAR only model, when it follows the ground (raised ones are flat on what they're over). */
  private drawnRoad(shape: AddedShape, embed: number): DrawnRoad | null {
    const grids = this.ctx.profile;
    if (!grids || shape.points.length < 2) return null;
    const line = shape.points.map(([lon, lat]) => this.projection.toModel(lon, lat));
    return drawnRoad(line, shape.sizeMm, shape.heightMm, grids, embed);
  }

  /**
   * What drawn roads clear from a LiDAR only surface (drawn.ts), which is
   * cut out of it and filled with the bare ground in the city part. Null
   * with nothing cleared. Shapes in `hidden` parts are left out of an
   * export (excludedParts), so what they clear is too.
   */
  private cleared(standing: Map<string, Standing>, edits: ModelEdits, hidden?: ReadonlySet<string>): { cut: SurfaceCut; hole: MultiPolygon; signature: string } | null {
    const shown = this.shownShape(edits, hidden);
    const pieces = edits.shapes.flatMap((shape) => (shown(shape) ? (standing.get(shape.id)?.cleared ?? []) : []));
    if (!pieces.length) return null;
    if (this.cutter === undefined) {
      const grids = this.ctx.profile;
      const city = this.spec.layers.find((layer) => layer.id === 'city');
      const cell = grids ? Math.min(grids.ground.step, grids.ground.stepY ?? grids.ground.step) : 0;
      this.cutter =
        grids && city?.solids.some((solid) => solid.kind === 'cap')
          ? new SurfaceCut(city, this.crop, this.surfaceWater.flatMap((w) => w.polygons), bareGround(grids), Math.max(2 * cell, 0.1))
          : null;
    }
    if (!this.cutter) return null;
    const signature = polygonSignature(pieces);
    const hole = this.cutter.hole(pieces, signature);
    return hole.length ? { cut: this.cutter, hole, signature } : null;
  }

  /**
   * Whether a shape is in the model. Shapes in `hidden` parts are left out
   * of an export, and hidden in the view, so what they cut from the rest
   * (roads, land cover, trees) is left out of both.
   */
  private shownShape(edits: ModelEdits, hidden?: ReadonlySet<string>): (shape: AddedShape) => boolean {
    if (!hidden?.size) return () => true;
    const layerIds = new Set(edits.layers.map((layer) => layer.id));
    return (shape) => !hidden.has(layerIds.has(shape.layer) ? layerPartId(shape.layer) : SHAPES_PART);
  }

  /** What the shown shapes stand on the ground with, for the trees there. */
  private shownGrounds(standing: Map<string, Standing>, edits: ModelEdits, hidden?: ReadonlySet<string>): MultiPolygon[] {
    const shown = this.shownShape(edits, hidden);
    return edits.shapes.flatMap((shape) => {
      const ground = standing.get(shape.id)?.ground;
      return ground?.length && shown(shape) ? [ground] : [];
    });
  }

  /**
   * Drawn roads on the ground, which the roads, railways and paths under
   * them give way to, as they do to a route. Without that a drawn road in a
   * colour of its own only won where a slicer gave it the overlap. A raised
   * one stands on a roof or a deck and leaves what's under it alone.
   */
  private roadCuts(edits: ModelEdits, footprints: Map<string, MultiPolygon>, hidden?: ReadonlySet<string>): Map<string, RoadCut> {
    const out = new Map<string, RoadCut>();
    if (!this.ctx.heightfield || !this.ctx.roads.length) return out;
    const shown = this.shownShape(edits, hidden);
    for (const shape of edits.shapes) {
      if (shape.kind !== 'path' || shape.liftMm > 0 || !shown(shape)) continue;
      const polygons = footprints.get(shape.id);
      if (!polygons?.length) continue;
      const key = shapeKey(shape.id);
      const signature = polygonSignature(polygons);
      const known = this.roadState.cuts.get(key);
      out.set(key, known?.signature === signature ? known : { signature, polygons });
    }
    return out;
  }

  /**
   * Where shapes stand on the ground, which land cover gives way to the way
   * it does to buildings and roads. Not what a roof or deck holds up. Null on
   * a model without land cover or with nothing on the ground.
   */
  private groundCut(standing: Map<string, Standing>, edits: ModelEdits, hidden?: ReadonlySet<string>): GroundCut | null {
    if (!this.ctx.land) return null;
    const shown = this.shownShape(edits, hidden);
    const pieces: MultiPolygon[] = [];
    const byTile = new Map<number, string[]>();
    for (const shape of edits.shapes) {
      const ground = standing.get(shape.id)?.ground;
      if (!ground?.length || !shown(shape)) continue;
      let info = this.groundInfo.get(ground);
      if (!info) this.groundInfo.set(ground, (info = { signature: polygonSignature(ground), tiles: this.grid.tilesReached(ground, GROUND_REACH_MM) }));
      pieces.push(ground);
      for (const tile of info.tiles) {
        const list = byTile.get(tile);
        const entry = `${shape.id}=${info.signature}`;
        if (list) list.push(entry);
        else byTile.set(tile, [entry]);
      }
    }
    if (!pieces.length) return null;
    return { set: new ClipSet(pieces), tiles: new Map([...byTile].map(([tile, list]) => [tile, list.join(',')])) };
  }

  /**
   * What a shape on the ground was dragged into, for the note a flat one
   * gets. It's worked out on every pass rather than kept in the shape's
   * signature: with the buildings around it in there, a path across the Loop
   * was re-meshed on every building edit (60 ms). Points on the outline go
   * first, and only a shape nearly all inside something gets the full check,
   * or the same path went through it against every building (45 ms).
   */
  private buriedOnGround(shape: AddedShape, polygons: MultiPolygon, pass: Pass, decks: Map<string, Deck>): string | null {
    const rise = shape.liftMm + shape.heightMm;
    const points = outlinePoints(polygons, BURIED_PROBES);
    let inside = 0;
    for (const [x, y] of points) {
      const box: Box = [x, y, x, y];
      const top = this.ctx.heightAt(x, y) + rise;
      const keys = this.holderKeys(box).filter((key) => boxesOverlap(this.holderBoxes.get(key)!, box));
      if (this.holders(keys, box, pass, decks).some((h) => h.bottom < top && pointInPolygon(x, y, h.polygon) && h.topAt(x, y) >= top)) inside++;
    }
    if (!points.length || inside < points.length * PROBES_INSIDE) return null;
    const box = multiBounds(polygons);
    return buriedIn(polygons, this.holders(this.holderKeys(box), box, pass, decks), highestGround(this.ctx, polygons) + rise, BURIED_SHARE);
  }

  /** Buildings and bridges that could be under a box, by key. */
  private holderKeys(box: Box): string[] {
    if (!this.holderIndex) {
      const index = new Map<number, string[]>();
      // A deck can be made this much wider than it was.
      const reach = EDIT_LIMITS.widthMm[1] / 2;
      for (const [key, placed] of this.objects) {
        const kind = kindOf(key);
        if (kind !== 'building' && kind !== 'rock' && kind !== 'bridge') continue;
        let bounds: Box | null = null;
        for (const { solids } of placed) {
          for (const solid of solids) {
            if (solid.kind === 'mesh' || solid.sub === 'pier') continue;
            const b = solidBox(solid);
            bounds = bounds ? [Math.min(bounds[0], b[0]), Math.min(bounds[1], b[1]), Math.max(bounds[2], b[2]), Math.max(bounds[3], b[3])] : b;
          }
        }
        if (!bounds) continue;
        const margin = kind === 'bridge' ? reach : 0;
        const reached: Box = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
        this.holderBoxes.set(key, reached);
        for (const tile of this.grid.tilesTouching(reached)) {
          const list = index.get(tile);
          if (list) list.push(key);
          else index.set(tile, [key]);
        }
      }
      this.holderIndex = index;
    }
    const out = new Set<string>();
    for (const tile of this.grid.tilesTouching(box)) for (const key of this.holderIndex.get(tile) ?? []) out.add(key);
    return [...out].sort();
  }

  /** What a holder's shape depends on in the edits. */
  private holderState(key: string, pass: Pass, decks: Map<string, Deck>): string {
    if (this.editOf(pass.edits, key)?.removed) return `${key}:gone`;
    if (key.startsWith('br:')) return `${key}:${decks.get(key)?.width ?? ''}`;
    const own = pass.reshaped.get(key);
    return own ? `${key}:${own.map(([k, e]) => `${k}=${e.heightM ?? ''}${e.removed ? ':gone' : ''}`).sort().join(',')}` : key;
  }

  private holders(keys: string[], box: Box, pass: Pass, decks: Map<string, Deck>): Holder[] {
    const out: Holder[] = [];
    for (const key of keys) {
      if (this.editOf(pass.edits, key)?.removed) continue;
      const bridge = key.startsWith('br:');
      let solids: Solid[];
      if (bridge) {
        solids = decks.get(key)?.decks ?? this.solidsOf(pass, key).flatMap(({ solid }) => (solid.sub === 'deck' ? [solid] : []));
      } else {
        solids = this.solidsOf(pass, key).flatMap(({ solid }) => (solid.sub && pass.edits.objects[partKey(key, solid.sub)]?.removed ? [] : [solid]));
      }
      for (const solid of solids) {
        for (const holder of holdersOf(solid, bridge ? 'bridge' : 'building')) if (boxesOverlap(holder.box, box)) out.push(holder);
      }
    }
    return out;
  }

  // -------------------------------------------------------------- roads

  private roadTiles(): RoadTiles | null {
    if (this.roads) return this.roads;
    if (!this.ctx.roads.length) return null;
    const base = new Map<string, MultiPolygon>();
    for (const layer of this.spec.layers) {
      if (!ROAD_PART_IDS.has(layer.id)) continue;
      base.set(layer.id, layer.solids.flatMap((s) => (s.kind === 'prism' ? [s.polygon] : [])));
    }
    const mapped = this.ctx.mapped ? { ...this.ctx.mapped, decks: this.ctx.decks } : undefined;
    this.roads = new RoadTiles(this.ctx.roads, base, this.crop, ringBounds(this.spec.crop[0]), this.settings, this.ctx.tracks, mapped);
    return this.roads;
  }

  private roadSolids(bucket: RoadBucket): PrismSolid[] {
    const hf = this.ctx.heightfield;
    const embed = this.settings.land.embedMm;
    const thickness = bucket.thickness;
    const drape = hf && !hf.flat ? hf.step : 0;
    const lattice = hf && !hf.flat ? hf.lattice : undefined;
    const top = (x: number, y: number) => this.ctx.heightAt(x, y) + thickness;
    const bottom = (x: number, y: number) => this.ctx.heightAt(x, y) - embed;
    const role: MaterialRole = bucket.part === 'rail' ? 'rail' : bucket.part === 'paths' ? 'path' : 'road';
    return bucket.polygons.flatMap((polygon) => {
      const solid: PrismSolid = { kind: 'prism', role, polygon, top, bottom, drape, lattice };
      return this.wading ? this.wading.wade(solid) : [solid];
    });
  }

  private styles(edits: ModelEdits, roads: RoadTiles): Map<string, RoadStyle> {
    const out = new Map<string, RoadStyle>();
    for (const [key, edit] of Object.entries(edits.objects)) {
      // A route taken out gives the roads it cut back.
      if (key.startsWith('rt:') && edit.removed && roads.hasCut(key)) out.set(key, { removed: true });
      if (!key.startsWith('r:') || !roads.has(key)) continue;
      const layer = edit.layer && edits.layers.some((l) => l.id === edit.layer) ? edit.layer : undefined;
      const style: RoadStyle = {};
      if (edit.removed) style.removed = true;
      if (layer) style.layer = layer;
      if (edit.heightMm !== undefined) style.heightMm = edit.heightMm;
      if (edit.widthMm !== undefined) style.widthMm = edit.widthMm;
      if (Object.keys(style).length) out.set(key, style);
    }
    return out;
  }

  /**
   * Tiles rebuilt for these edits and drawn roads, and which of them differ
   * from `current`. Tiles no edited or drawn road reaches keep the generated
   * polygons.
   */
  private async rebuildTiles(
    edits: ModelEdits,
    current: RoadState,
    tiles: Map<number, RoadBucket[]>,
    cuts: Map<string, RoadCut>,
  ): Promise<{ state: RoadState; changed: Set<number> }> {
    const changed = new Set<number>();
    const roads = this.roadTiles();
    if (!roads) return { state: { styles: new Map(), cuts: new Map() }, changed };
    const styles = this.styles(edits, roads);
    const next = new Map([...styles].map(([key, style]) => [key, JSON.stringify(style)]));
    for (const [key, cut] of cuts) next.set(key, `cut:${cut.signature}`);
    const cutTiles = (cut: RoadCut) => (cut.tiles ??= roads.tilesReached(cut.polygons));
    const touched = new Set<string>();
    for (const [key, value] of next) if (current.styles.get(key) !== value) touched.add(key);
    for (const key of current.styles.keys()) if (!next.has(key)) touched.add(key);
    for (const key of touched) {
      const was = current.cuts.get(key);
      const now = cuts.get(key);
      if (was || now) {
        for (const tile of was ? cutTiles(was) : []) changed.add(tile);
        for (const tile of now ? cutTiles(now) : []) changed.add(tile);
        continue;
      }
      const before = current.styles.get(key);
      for (const tile of roads.tilesOf(key, before ? (JSON.parse(before) as RoadStyle) : undefined)) changed.add(tile);
      for (const tile of roads.tilesOf(key, styles.get(key))) changed.add(tile);
    }
    const reached = new Set<number>();
    for (const [key, style] of styles) for (const tile of roads.tilesOf(key, style)) reached.add(tile);
    for (const cut of cuts.values()) for (const tile of cutTiles(cut)) reached.add(tile);
    const ranged = new RoadStyles(styles, new Map([...cuts].map(([key, cut]) => [key, cut.polygons])));
    for (const tile of changed) {
      if (reached.has(tile)) tiles.set(tile, await roads.tile(tile, ranged));
      else tiles.delete(tile);
    }
    return { state: { styles: next, cuts }, changed };
  }

  private tileContent(tile: number, tiles: Map<number, RoadBucket[]> = this.tiles): RoadBucket[] {
    return tiles.get(tile) ?? this.roads!.baseTile(tile);
  }

  /**
   * Meshes a tile for the viewer. Returns the parts whose share of it changed:
   * an edit reaches every road near it, but most keep their polygons.
   */
  private async meshTile(tile: number): Promise<string[]> {
    const before = this.tileMeshes.get(tile);
    const signatures = this.tileSignatures.get(tile);
    const byPart = new Map<string, RoadBucket[]>();
    for (const bucket of this.tileContent(tile)) {
      const list = byPart.get(bucket.part);
      if (list) list.push(bucket);
      else byPart.set(bucket.part, [bucket]);
    }
    const out = new Map<string, MeshData>();
    const nextSignatures = new Map<string, string>();
    const dirty: string[] = [];
    for (const [part, buckets] of byPart) {
      const signature = buckets.map((b) => `${b.thickness}:${polygonSignature(b.polygons)}`).join('|');
      nextSignatures.set(part, signature);
      const kept = before?.get(part);
      if (kept && signatures?.get(part) === signature) {
        out.set(part, kept);
        continue;
      }
      dirty.push(part);
      const meshes: MeshData[] = [];
      for (const bucket of buckets) {
        const mesh = await this.mesh(part, 'road', this.roadSolids(bucket));
        if (mesh?.indices.length) meshes.push(mesh);
      }
      if (meshes.length) out.set(part, meshes.length === 1 ? meshes[0] : concat(meshes));
    }
    for (const part of before?.keys() ?? []) if (!byPart.has(part)) dirty.push(part);
    if (out.size) this.tileMeshes.set(tile, out);
    else this.tileMeshes.delete(tile);
    this.tileSignatures.set(tile, nextSignatures);
    return dirty;
  }

  // ------------------------------------------------------------ bridges

  /** Bridges whose decks the edits widen or narrow, rebuilt at their width. */
  private rebuiltDecks(edits: ModelEdits): Map<string, Deck> {
    const out = new Map<string, Deck>();
    for (const [key, pieces] of this.decks) {
      if (!this.objects.has(key)) continue;
      const width = this.editOf(edits, key)?.widthMm;
      if (width === undefined) continue;
      let deck = this.deckCache.get(key);
      if (deck?.width !== width) this.deckCache.set(key, (deck = this.buildDeck(key, pieces, width)));
      out.set(key, deck);
    }
    return out;
  }

  private buildDeck(key: string, pieces: DeckPiece[], width: number): Deck {
    const decks: PrismSolid[] = [];
    const ribbons: MultiPolygon[] = [];
    for (const piece of pieces) {
      const ribbon = dropSmall(intersection(bufferLines([{ points: piece.points, width }], 'round'), this.crop), 0.01);
      ribbons.push(ribbon);
      for (const polygon of ribbon) decks.push({ kind: 'prism', role: 'bridge', polygon, top: piece.top, bottom: piece.bottom, drape: piece.drape, key, sub: 'deck' });
    }
    const ribbon = union(...ribbons);
    // Piers are sized to the deck. A wider deck overhangs them, and a
    // narrower one has them cut to it rather than sticking out.
    let piers: PrismSolid[] | null = null;
    if (width < Math.max(...pieces.map((p) => p.widthMm)) - 1e-9) {
      piers = [];
      for (const { solids } of this.objects.get(key) ?? []) {
        for (const solid of solids) {
          if (solid.kind !== 'prism' || solid.sub !== 'pier') continue;
          for (const polygon of dropSmall(intersection([solid.polygon], ribbon), 0.01)) piers.push({ ...solid, polygon });
        }
      }
    }
    return { width, decks, piers, ribbon };
  }

  // -------------------------------------------------------------- earth

  /** Cut water and basins in a tile. */
  private wetTile(tile: number): MultiPolygon {
    let local = this.wetTiles.get(tile);
    if (!local) this.wetTiles.set(tile, (local = this.noGround ? this.noGround.polygonsWithinRect(this.grid.units(tile)) : []));
    return local;
  }

  /** Building footprints in water, and the ground kept under them. */
  private wetGroundList(): { ground: Ground; pieces: MultiPolygon }[] {
    if (this.wetGrounds) return this.wetGrounds;
    const out: { ground: Ground; pieces: MultiPolygon }[] = [];
    if (this.noGround && this.noGroundBox && this.ctx.kept.buildings.length) {
      for (const ground of this.grounds) {
        if (kindOf(ground.key) !== 'building' || !boxesOverlap(ground.box, this.noGroundBox)) continue;
        const local = this.noGround.polygonsWithin(ground.box);
        if (!local.length) continue;
        const pieces = intersection(ground.pieces, local);
        if (pieces.length) out.push({ ground, pieces });
      }
    }
    return (this.wetGrounds = out);
  }

  /** Piers standing in water, and the ground kept under them. */
  private wetPierList(): { key: string; pieces: MultiPolygon }[] {
    if (this.wetPiers) return this.wetPiers;
    const out: { key: string; pieces: MultiPolygon }[] = [];
    const kept = this.ctx.kept.piers;
    if (kept.length) {
      const set = new ClipSet([kept]);
      for (const [key, placed] of this.objects) {
        if (!key.startsWith('br:')) continue;
        for (const { solids } of placed) {
          for (const solid of solids) {
            if (solid.kind !== 'prism' || solid.sub !== 'pier') continue;
            const local = set.polygonsWithin(ringBounds(solid.polygon[0]));
            if (!local.length) continue;
            const pieces = intersection([solid.polygon], local);
            if (pieces.length) out.push({ key, pieces });
          }
        }
      }
    }
    return (this.wetPiers = out);
  }

  private groundRemoved(ground: Ground, edits: ModelEdits): boolean {
    return Boolean(edits.objects[ground.key]?.removed || (ground.sub && edits.objects[partKey(ground.key, ground.sub)]?.removed));
  }

  /**
   * What stands in the water now, and the ground kept under it, each null
   * while it's as generated. Both only ever cover cut water and basins, so
   * land is never taken away: what a removed structure leaves goes back to
   * being water, and what's new in the water gets ground under it with
   * supports on, or is built down through it with them off.
   */
  private inWater(
    pass: Pass,
    tiles: Map<number, RoadBucket[]>,
    decks: Map<string, Deck>,
    footprints: Map<string, MultiPolygon>,
  ): { kept: MultiPolygon | null; standing: MultiPolygon | null; signature: string } {
    const noGround = this.noGround;
    const noGroundBox = this.noGroundBox;
    const model = this.earthModel;
    if (!noGround || !noGroundBox || !model) return { kept: null, standing: null, signature: '' };
    const supportsOn = this.settings.supports;
    const kept = this.ctx.kept;
    const edits = pass.edits;
    const parts: string[] = [];

    const wetTiles = [...tiles.keys()].filter((tile) => this.wetTile(tile).length > 0).sort((a, b) => a - b);
    for (const tile of wetTiles) parts.push(`t${tile}=${tiles.get(tile)!.map((b) => polygonSignature(b.polygons)).join(',')}`);
    const grounds = this.wetGroundList();
    const gone = new Set(grounds.filter(({ ground }) => this.groundRemoved(ground, edits)));
    for (const { ground } of gone) parts.push(`g${ground.key}/${ground.sub}`);
    // Raised parts built down to the ground over water need ground too.
    const settled: PrismSolid[] = [];
    for (const [object, own] of pass.reshaped) {
      if (!own.some(([k]) => isPartKey(k))) continue;
      for (const { solid } of this.solidsOf(pass, object)) {
        if (solid.kind !== 'prism' || !this.groundedSolids.has(solid) || !boxesOverlap(ringBounds(solid.polygon[0]), noGroundBox)) continue;
        settled.push(solid);
        parts.push(`p${object}/${solid.sub ?? ''}`);
      }
    }
    const piers = this.wetPierList();
    const piersChanged = piers.some((p) => this.editOf(edits, p.key)?.removed || decks.get(p.key)?.piers);
    if (piersChanged) for (const p of piers) parts.push(`b${p.key}=${this.editOf(edits, p.key)?.removed ? 'gone' : (decks.get(p.key)?.width ?? '')}`);
    // A route taken out takes the ground kept under it with it.
    const routesGone = kept.tracks.filter((track) => this.editOf(edits, track.key)?.removed);
    for (const track of routesGone) parts.push(`r${track.key}`);
    const routes = routesGone.length ? kept.tracks.filter((track) => !routesGone.includes(track)).map((track) => track.pieces) : kept.tracks.map((track) => track.pieces);
    const structural = parts.length > 0;
    // Shapes kept on ground of their own, and the rest, which stand in the water on their own.
    const onGround: MultiPolygon[] = [];
    const wading: MultiPolygon[] = [];
    for (const shape of edits.shapes) {
      const polygons = footprints.get(shape.id);
      if (!polygons?.length || !boxesOverlap(multiBounds(polygons), noGroundBox)) continue;
      const grounded = supportsOn && SUPPORTED.has(shape.kind);
      (grounded ? onGround : wading).push(polygons);
      parts.push(`${grounded ? 'k' : 's'}${shape.id}=${polygonSignature(polygons)}`);
    }
    const signature = parts.join(';');
    if (!signature) return { kept: null, standing: null, signature };
    if (this.inWaterCache?.signature === signature) return { ...this.inWaterCache, signature };

    let roads = kept.roads;
    if (wetTiles.length) {
      const region = union(...wetTiles.map((tile) => rectangle(...this.grid.rect(tile))));
      const fresh: MultiPolygon[] = [];
      for (const tile of wetTiles) {
        const polygons = tiles.get(tile)!.flatMap((b) => b.polygons);
        if (polygons.length) fresh.push(intersection(polygons, this.wetTile(tile)));
      }
      roads = union(difference(kept.roads, region), ...fresh, kept.airport.length ? intersection(kept.airport, region) : []);
    }
    let buildings = kept.buildings;
    if (gone.size || settled.length) {
      const standing = grounds.filter((g) => !gone.has(g)).map((g) => g.pieces);
      const raised = settled.map((solid) => intersection([solid.polygon], noGround.polygonsWithin(ringBounds(solid.polygon[0]))));
      buildings = union(...standing, ...raised);
    }
    let pierGround = kept.piers;
    if (piersChanged) {
      pierGround = union(
        ...piers.flatMap((p) => {
          if (this.editOf(edits, p.key)?.removed) return [];
          const deck = decks.get(p.key);
          return [deck?.piers ? intersection(p.pieces, deck.ribbon) : p.pieces];
        }),
      );
    }
    const wet = (list: MultiPolygon[]) => list.map((polygons) => intersection(polygons, noGround.polygonsWithin(multiBounds(polygons))));
    let result: { kept: MultiPolygon | null; standing: MultiPolygon | null };
    if (supportsOn) {
      const ground = structural || onGround.length ? union(roads, pierGround, kept.decks, buildings, ...routes, ...wet(onGround)) : null;
      result = { kept: ground, standing: wading.length ? union(ground ?? model.kept, ...wet(wading)) : ground };
    } else {
      result = { kept: null, standing: union(roads, pierGround, kept.decks, buildings, ...routes, ...wet(wading)) };
    }
    this.inWaterCache = { signature, ...result };
    return { ...result, signature };
  }

  /**
   * The terrain and water, and every shape standing in them. Only the parts
   * of a shape nothing holds up stand in the water: one raised onto a deck
   * cut the water under the bridge, or left an island there with supports
   * on. What holds a shape up depends on where it stands, which depends on
   * the water, so the parts held last time go in first. When they turn out
   * different the earth is worked out once more with the new ones.
   */
  private standAll(
    pass: Pass,
    tiles: Map<number, RoadBucket[]>,
    decks: Map<string, Deck>,
    footprints: Map<string, MultiPolygon>,
  ): { earth: Earth | null; standing: Map<string, Standing> } {
    const wetBox = this.noGroundBox;
    const wetShapes = wetBox && this.earthModel ? new Set(pass.edits.shapes.filter((s) => boxesOverlap(multiBounds(footprints.get(s.id) ?? []), wetBox)).map((s) => s.id)) : new Set<string>();
    let guess = this.heldGuess;
    for (let round = 0; ; round++) {
      const inWater = new Map(footprints);
      for (const [id, known] of guess) {
        const polygons = footprints.get(id);
        if (!polygons?.length || !wetShapes.has(id)) continue;
        // While the footprint is the same one, what wasn't held is already worked out.
        inWater.set(id, known.footprint === polygons ? known.unheld : difference(polygons, known.held));
      }
      const { earth } = this.earthFor(pass, tiles, decks, inWater);
      const standing = this.standShapes(pass, decks, earth, footprints);
      const held = new Map<string, HeldGuess>();
      for (const id of wetShapes) {
        const stood = standing.get(id);
        if (stood?.held.length) held.set(id, { footprint: footprints.get(id)!, held: stood.held, unheld: stood.unheld });
      }
      if (round > 0 || sameHeld(held, guess)) {
        this.heldGuess = held;
        return { earth, standing };
      }
      guess = held;
    }
  }

  private earthFor(pass: Pass, tiles: Map<number, RoadBucket[]>, decks: Map<string, Deck>, footprints: Map<string, MultiPolygon>): { earth: Earth | null; key: string } {
    if (!this.earthModel) return { earth: null, key: '' };
    const { kept, standing, signature } = this.inWater(pass, tiles, decks, footprints);
    const water = pass.water;
    const key = `${signature}|${water.signature}`;
    const earth = this.earthModel.earth({ kept, standing, filled: water.filled, hollow: water.hollow }, water.removed, key);
    return { earth, key };
  }

  // ------------------------------------------------------------- update

  /** `hidden` is the parts hidden in the view: what their shapes cut is left out, as a download leaves it out. */
  async update(edits: ModelEdits, version: number, hidden: readonly string[] = []): Promise<EditUpdate> {
    const reset = this.resend;
    this.resend = false;
    try {
      const update = await this.apply(edits, version, new Set(hidden));
      if (reset) update.reset = true;
      return update;
    } catch (error) {
      this.forget();
      throw error;
    }
  }

  /**
   * After an update failed part way, what's recorded as sent may be ahead of
   * what the viewer got, and a half rebuilt tile set out of step with its
   * styles. So all of it goes, and the next update sends everything again
   * for the viewer to take in place of what it has.
   */
  private forget(): void {
    this.sentObjects.clear();
    this.sentParts.clear();
    this.sentTerrain = null;
    this.sentWater = null;
    this.sentCut = '';
    this.tiled = false;
    this.tiles = new Map();
    this.tileMeshes.clear();
    this.tileSignatures.clear();
    this.roadState = { styles: new Map(), cuts: new Map() };
    this.sentLand.clear();
    this.resend = true;
  }

  private async apply(edits: ModelEdits, version: number, hidden: ReadonlySet<string>): Promise<EditUpdate> {
    const warnings: string[] = [];
    const objects: ObjectMesh[] = [];
    const parts: PartUpdate[] = [];
    const wanted = new Set<string>();
    const pass = this.pass(edits);
    const offer = async (key: string, part: string, role: MaterialRole, signature: string, solids: () => Solid[], newPart = false) => {
      const id = `${part}|${key}`;
      wanted.add(id);
      if (this.sentObjects.get(id)?.signature === signature) return;
      objects.push({ key, part, role: newPart ? role : undefined, mesh: await this.mesh(part, role, solids()) });
      this.sentObjects.set(id, { key, part, signature });
    };

    // Buildings the edits reshape get new geometry. A removed part alone
    // needs none, the viewer hides it, unless it left another part on air.
    for (const [object, own] of pass.reshaped) {
      const placed = this.objects.get(object)!;
      const part = placed[0]?.layer.id ?? 'buildings';
      const signature = own
        .map(([key, edit]) => `${key}=${edit.heightM ?? ''}${edit.removed ? ':removed' : ''}`)
        .sort()
        .join(';');
      if (this.sentObjects.get(`${part}|${object}`)?.signature === signature) {
        wanted.add(`${part}|${object}`);
        continue;
      }
      const originals = placed.flatMap((p) => p.solids);
      const edited = this.solidsOf(pass, object);
      if (edited.every(({ solid }, i) => solid === originals[i])) continue;
      await offer(object, part, placed[0]?.layer.role ?? 'building', signature, () => edited.map((e) => e.solid));
    }

    // Roads, with the drawn roads on the ground they give way to. The tiles
    // are rebuilt in a copy and swapped in with their styles, or an export
    // running meanwhile could read tiles for these edits with the styles of
    // the last ones and skip rebuilding them.
    const { polygons: footprints, text } = await this.shapeFootprints(edits, warnings, true);
    const tiles = new Map(this.tiles);
    const { state, changed } = await this.rebuildTiles(edits, this.roadState, tiles, this.roadCuts(edits, footprints, hidden));
    this.tiles = tiles;
    this.roadState = state;
    if (state.styles.size && this.roads) {
      const first = !this.tiled;
      this.tiled = true;
      const remesh = first ? Array.from({ length: this.roads.count }, (_, i) => i) : [...changed];
      const dirty = new Set<string>();
      for (const tile of remesh) for (const id of await this.meshTile(tile)) dirty.add(id);
      if (first || dirty.size) parts.push(...this.assembleRoadParts(edits, first ? null : dirty));
    } else if (this.tiled) {
      this.tiled = false;
      this.tiles = new Map();
      this.tileMeshes.clear();
      this.tileSignatures.clear();
      for (const id of this.sentParts.keys()) parts.push({ id, part: null });
      this.sentParts.clear();
    }

    // Bridge decks at their width.
    const decks = this.rebuiltDecks(edits);
    for (const [key, deck] of decks) {
      await offer(key, 'bridges', 'bridge', `${deck.width}`, () => deck.decks);
      if (deck.piers) await offer(key, 'piers', 'pier', `${deck.width}`, () => deck.piers!);
    }

    // Routes without what removed decks carried. One that was all on them is hidden.
    const routesOff: string[] = [];
    for (const [key, carried] of this.routesOnDecks) {
      const gone = this.offDecks(edits, key);
      if (!gone) continue;
      const placed = this.objects.get(key) ?? [];
      const solids = placed.flatMap((p) => p.solids).filter((solid) => !gone.has(solid));
      const signature = [...carried.keys()].map((solid) => (gone.has(solid) ? 1 : 0)).join('');
      if (!solids.length) routesOff.push(key);
      else await offer(key, placed[0]?.layer.id ?? 'routes', 'route', signature, () => solids);
    }

    // Terrain and water, once water is left out or what stands in it changes.
    const { earth, standing } = this.standAll(pass, this.tiles, decks, footprints);
    const terrain = earth?.terrain ?? null;
    if (terrain !== this.sentTerrain) {
      parts.push({ id: 'terrain', part: terrain ? await this.meshPart({ id: 'terrain', name: 'Terrain', role: 'terrain', solids: terrain }) : null });
      this.sentTerrain = terrain;
    }
    const water = earth?.water ?? null;
    if (water !== this.sentWater) {
      const layer = this.spec.layers.find((l) => l.id === 'water');
      parts.push({ id: 'water', part: water && layer ? await this.meshPart({ ...layer, solids: water }) : null });
      this.sentWater = water;
    }

    // Shapes.
    const notes: Record<string, string> = {};
    for (const shape of edits.shapes) {
      const key = shapeKey(shape.id);
      const stood = standing.get(shape.id)!;
      const note = this.noteFor(shape, footprints.get(shape.id) ?? [], stood.solids, stood.buried, text.get(shape.id));
      if (note) notes[key] = note;
      await offer(key, SHAPES_PART, 'building', stood.signature, () => stood.solids);
    }
    const cleared = this.cleared(standing, edits, hidden);
    if ((cleared?.signature ?? '') !== this.sentCut) {
      let part: MeshPart | null = null;
      try {
        if (cleared) part = await cleared.cut.view(cleared.hole, (layer) => this.meshPart(layer));
      } catch {
        warnings.push(CUT_FAILED);
      }
      parts.push({ id: 'city', part });
      this.sentCut = cleared?.signature ?? '';
    }

    // Land cover cut where shapes stand on it, and back where a removed
    // road, building or body of water was.
    const ground = this.groundCut(standing, edits, hidden);
    parts.push(...(await this.landParts(ground)));
    for (const fill of this.fills(pass, this.tiles, ground)) {
      const key = `${FILL_PREFIX}${fill.category}`;
      const role = LAND_ROLES[fill.category];
      await offer(key, `land-${fill.category}`, role, polygonSignature(fill.polygons), () => this.landSolids(fill, key), true);
    }

    // Anything sent before that's no longer edited goes back.
    for (const [id, sent] of [...this.sentObjects]) {
      if (wanted.has(id)) continue;
      objects.push({ key: sent.key, part: sent.part, mesh: null });
      this.sentObjects.delete(id);
    }

    // Trees under what a shape stands on the ground with. A shape on a deck leaves those under the bridge.
    const treesUnder = this.shownGrounds(standing, edits, hidden);
    return { model: this.id, version, objects, parts, hidden: [...this.hiddenTrees(treesUnder, this.tiles, earth), ...routesOff], notes, warnings };
  }

  /** What's worth knowing about a shape as built: nothing to print, hidden, or bits too thin to print. */
  private noteFor(shape: AddedShape, footprint: MultiPolygon, solids: PrismSolid[], buried: string | null, text?: TextState): string | null {
    if (shape.kind === 'text' && !shape.text.trim()) return 'Type the text it should show.';
    if (text?.unloaded) return "Its font couldn't be loaded, so it won't print. It's tried again with your next change.";
    if (!solids.length) return "It's outside the model, so it won't print.";
    if (buried) return BURIED_NOTES[buried] ?? BURIED_NOTES.building;
    if (text?.missing) return glyphNote(text.missing);
    const signature = JSON.stringify([shape.kind, shape.at, shape.points, shape.rotationDeg, shape.sizeMm, shape.depthMm, shape.text, shape.font]);
    const cached = this.notes.get(shape.id);
    if (cached?.signature === signature) return cached.note;
    let note: string | null = null;
    if (shape.kind === 'path' && shape.sizeMm < NOZZLE_MM) {
      note = `It's narrower than a ${NOZZLE_MM} mm nozzle prints well.`;
    } else {
      // Pieces standing on different things meet inside the shape, so the
      // probe looks at the footprint as a whole. Not the pieces unioned back
      // together: a box over downtown stands on thousands.
      const area = multiArea(footprint);
      const opened = offsetPolygons(offsetPolygons(footprint, -PROBE_MM / 2, 'round'), PROBE_MM / 2, 'round');
      if (area > 0 && multiArea(opened) < area * 0.9) {
        note =
          shape.kind === 'text'
            ? `Some strokes are thinner than a ${NOZZLE_MM} mm nozzle prints well. Make the letters bigger or pick a bolder font.`
            : `Parts of it are thinner than a ${NOZZLE_MM} mm nozzle prints well.`;
      }
    }
    this.notes.set(shape.id, { signature, note });
    return note;
  }

  // --------------------------------------------------------------- land

  /**
   * Land cover for the ground removed buildings, roads and water left, by
   * category (see land.ts). Worked out tile by tile, so an edit only looks at
   * what's near it, and each tile is kept until what it or the tiles around
   * it had changes.
   */
  private fills(pass: Pass, tiles: Map<number, RoadBucket[]>, ground: GroundCut | null): LandFill[] {
    const land = this.ctx.land;
    if (!land) return [];
    const edits = pass.edits;
    const removed = (ground: Ground) => this.groundRemoved(ground, edits);
    const todo = new Map<number, { gone: number[]; bodies: number[] }>();
    const at = (tile: number) => {
      let entry = todo.get(tile);
      if (!entry) todo.set(tile, (entry = { gone: [], bodies: [] }));
      return entry;
    };
    // A fill reaches a little past what was vacated, into the next tile too.
    const grow = (b: Box): Box => [b[0] - FILL_REACH_MM, b[1] - FILL_REACH_MM, b[2] + FILL_REACH_MM, b[3] + FILL_REACH_MM];
    for (const tile of tiles.keys()) at(tile);
    this.grounds.forEach((ground, i) => {
      if (!removed(ground)) return;
      for (const tile of this.grid.tilesTouching(grow(ground.box))) at(tile).gone.push(i);
    });
    for (const i of [...pass.water.vacated].sort((a, b) => a - b)) {
      for (const tile of this.grid.tilesTouching(grow(ringBounds(this.ctx.bodies[i].polygon[0])))) at(tile).bodies.push(i);
    }
    if (!todo.size) return [];
    const cover = (this.landCover ??= new LandCover(land, this.generatedLand(), this.settings.land.priority));
    const water = this.landWaterSet(pass.water) ?? cover.water;
    // What each tile vacated, and how far land cover can come back around it.
    const own = new Map<number, { signature: string; reach: MultiPolygon }>();
    for (const [tile, { gone, bodies }] of todo) {
      const buckets = tiles.get(tile);
      const standing = ground?.tiles.get(tile) ?? '';
      const signature = `${tile}:${buckets ? buckets.map((b) => polygonSignature(b.polygons)).join('|') : '-'}:${gone.join(',')}:${bodies.join(',')}:${standing}`;
      let cached = this.tileReach.get(tile);
      if (cached?.signature !== signature) {
        this.tileReach.set(tile, (cached = { signature, reach: LandCover.reach(this.vacatedIn(tile, buckets, gone, bodies, standing ? ground : null)) }));
      }
      own.set(tile, cached);
    }
    const signatures: string[] = [];
    const pieces = new Map<SurfaceCategory, MultiPolygon[]>();
    const reaches: MultiPolygon[] = [];
    for (const tile of [...todo.keys()].sort((a, b) => a - b)) {
      const around = this.grid.around(tile).filter((t) => own.has(t));
      const signature = around.map((t) => own.get(t)!.signature).join('/');
      signatures.push(signature);
      reaches.push(own.get(tile)!.reach);
      let cached = this.tileFills.get(tile);
      if (cached?.signature !== signature) {
        const reach = around.flatMap((t) => own.get(t)!.reach);
        const fills = cover.tile(this.grid.units(tile), reach, (box) => this.landBlockers(box, tiles, water, removed, ground));
        this.tileFills.set(tile, (cached = { signature, fills }));
      }
      for (const fill of cached.fills) {
        const list = pieces.get(fill.category);
        if (list) list.push(fill.polygons);
        else pieces.set(fill.category, [fill.polygons]);
      }
    }
    const signature = signatures.join(';');
    if (this.fillCache?.signature === signature) return this.fillCache.fills;
    const reach = new ClipSet(reaches);
    const fills: LandFill[] = [];
    for (const category of this.settings.land.priority) {
      const lists = pieces.get(category);
      if (!lists) continue;
      const polygons = LandCover.settle(lists.length === 1 ? lists[0] : union(...lists), reach);
      if (polygons.length) fills.push({ category, polygons });
    }
    this.fillCache = { signature, fills };
    return fills;
  }

  /** Each category's land cover as generated. */
  private generatedLand(): Partial<Record<SurfaceCategory, MultiPolygon>> {
    const out: Partial<Record<SurfaceCategory, MultiPolygon>> = {};
    for (const category of this.settings.land.priority) {
      const layer = this.spec.layers.find((l) => l.id === `land-${category}`);
      if (layer) out[category] = layer.solids.flatMap((s) => (s.kind === 'prism' ? [s.polygon] : []));
    }
    return out;
  }

  /** What keeps land cover off near a box now, as in the land stage: water, roads, airport paving and buildings, and shapes on the ground. */
  private landBlockers(box: Box, tiles: Map<number, RoadBucket[]>, water: ClipSet, removed: (ground: Ground) => boolean, standing: GroundCut | null): MultiPolygon {
    const out: MultiPolygon = [...water.polygonsWithin(box)];
    if (standing) out.push(...standing.set.polygonsWithin(box));
    const roads = this.roadTiles();
    if (roads) {
      for (const tile of this.grid.tilesTouching(box)) {
        for (const bucket of tiles.get(tile) ?? roads.baseTile(tile)) out.push(...clipToBox(bucket.polygons, box, 0));
      }
    }
    this.airport ??= new ClipSet([this.spec.layers.find((l) => l.id === 'airport')?.solids.flatMap((s) => (s.kind === 'prism' ? [s.polygon] : [])) ?? []]);
    out.push(...this.airport.polygonsWithin(box));
    if (!this.groundTiles) {
      // Every building part in San Francisco, looked at for every tile, took 260 ms.
      this.groundTiles = new Map();
      this.grounds.forEach((ground, i) => {
        for (const tile of this.grid.tilesTouching(ground.box)) {
          const list = this.groundTiles!.get(tile);
          if (list) list.push(i);
          else this.groundTiles!.set(tile, [i]);
        }
      });
    }
    const seen = new Set<number>();
    for (const tile of this.grid.tilesTouching(box)) {
      for (const i of this.groundTiles.get(tile) ?? []) {
        const ground = this.grounds[i];
        if (seen.has(i) || !boxesOverlap(ground.box, box)) continue;
        seen.add(i);
        if (!removed(ground)) out.push(...ground.pieces);
      }
    }
    return out;
  }

  /** Water that still keeps land cover off once some is left out, or null for the generated. */
  private landWaterSet(water: WaterState): ClipSet | null {
    if (!water.vacated.size) return null;
    const signature = [...water.vacated].sort((a, b) => a - b).join(',');
    if (this.landWater?.signature !== signature) {
      this.landWater = { signature, set: new ClipSet([this.ctx.bodies.flatMap((body, i) => (water.vacated.has(i) ? [] : [body.polygon]))]) };
    }
    return this.landWater.set;
  }

  /**
   * Ground in one tile that roads, buildings or water no longer keep land
   * cover off. What a shape stands on now isn't: a road a drawn road took
   * the place of is under it still.
   */
  private vacatedIn(tile: number, buckets: RoadBucket[] | undefined, gone: number[], bodies: number[], standing: GroundCut | null): MultiPolygon {
    const vacated: MultiPolygon = [];
    const base = buckets ? (this.roads?.baseTile(tile).flatMap((b) => b.polygons) ?? []) : [];
    if (base.length) {
      const now = buckets!.flatMap((b) => b.polygons);
      vacated.push(...(now.length ? difference(base, now) : base));
    }
    const rect = this.grid.units(tile);
    for (const i of gone) vacated.push(...clipToUnits(this.grounds[i].pieces, rect));
    for (const i of bodies) vacated.push(...clipToUnits([this.ctx.bodies[i].polygon], rect));
    return standing && vacated.length ? differenceSet(vacated, standing.set) : vacated;
  }

  /**
   * The view's land parts with what shapes stand on cut out (land.ts), a
   * tile at a time, so moving a shape only cuts and meshes the tiles it was
   * and is in. The first cut in a category meshes all its tiles, about
   * 0.2 s for the green in Boston. A part goes back to the generated one
   * once nothing is cut from it.
   */
  private async landParts(ground: GroundCut | null): Promise<PartUpdate[]> {
    const out: PartUpdate[] = [];
    if (!this.ctx.land) return out;
    for (const layer of this.spec.layers) {
      if (!layer.id.startsWith('land-')) continue;
      const category = layer.id.slice('land-'.length) as SurfaceCategory;
      const slabs = (this.landSlabs ??= new LandSlabs(this.grid, this.generatedLand()));
      const tiles = slabs.tiles(category);
      const sample = layer.solids.find((solid): solid is PrismSolid => solid.kind === 'prism');
      if (!sample || !ground || ![...tiles.keys()].some((tile) => ground.tiles.has(tile))) {
        if (this.sentLand.delete(category)) out.push({ id: layer.id, part: null });
        continue;
      }
      let meshes = this.landTiles.get(category);
      if (!meshes) this.landTiles.set(category, (meshes = new Map()));
      const made: string[] = [];
      const list: MeshData[] = [];
      for (const tile of [...tiles.keys()].sort((a, b) => a - b)) {
        const signature = ground.tiles.get(tile) ?? '';
        let entry = meshes.get(tile);
        if (entry?.signature !== signature) {
          const polygons = signature ? slabs.cut(category, tile, ground.set) : tiles.get(tile)!;
          const part = polygons.length ? await this.meshPart({ ...layer, solids: polygons.map((polygon) => ({ ...sample, polygon })) }) : null;
          meshes.set(tile, (entry = { signature, mesh: part?.indices.length ? { positions: part.positions, indices: part.indices } : null }));
        }
        made.push(`${tile}=${signature}`);
        if (entry.mesh) list.push(entry.mesh);
      }
      const signature = made.join(';');
      if (this.sentLand.get(category) === signature) continue;
      const mesh = list.length ? concat(list) : { positions: new Float32Array(0), indices: new Uint32Array(0) };
      out.push({ id: layer.id, part: { id: layer.id, name: layer.name, role: layer.role, positions: mesh.positions, indices: mesh.indices } });
      this.sentLand.set(category, signature);
    }
    return out;
  }

  private landSolids(fill: LandFill, key: string): PrismSolid[] {
    const hf = this.ctx.heightfield;
    const { riseMm, embedMm } = this.settings.land;
    const drape = hf && !hf.flat ? hf.step : 0;
    const lattice = hf && !hf.flat ? hf.lattice : undefined;
    const role = LAND_ROLES[fill.category];
    const top = (x: number, y: number) => this.ctx.heightAt(x, y) + riseMm;
    const bottom = (x: number, y: number) => this.ctx.heightAt(x, y) - embedMm;
    return fill.polygons.map((polygon) => ({ kind: 'prism', role, polygon, top, bottom, drape, lattice, key }));
  }

  /** Road parts from the tile meshes: every one, or those in `dirty`. */
  private assembleRoadParts(edits: ModelEdits, dirty: Set<string> | null): PartUpdate[] {
    const byPart = new Map<string, MeshData[]>();
    for (const meshes of this.tileMeshes.values()) {
      for (const [id, mesh] of meshes) {
        if (dirty && !dirty.has(id)) continue;
        const list = byPart.get(id);
        if (list) list.push(mesh);
        else byPart.set(id, [mesh]);
      }
    }
    const out: PartUpdate[] = [];
    const names: Record<string, [string, MaterialRole]> = { roads: ['Roads', 'road'], rail: ['Railways', 'rail'], paths: ['Paths', 'path'] };
    for (const [id, meshes] of byPart) {
      const mesh = concat(meshes);
      const layer = id.startsWith('layer:') ? edits.layers.find((l) => layerPartId(l.id) === id) : undefined;
      const [name, role] = names[id] ?? [layer?.name ?? id, 'road' as MaterialRole];
      const part: MeshPart = { id, name, role, positions: mesh.positions, indices: mesh.indices };
      if (layer) part.colour = colourOf(layer);
      out.push({ id, part });
      this.sentParts.set(id, 'tiled');
    }
    // Generated road parts left without a tile show nothing now. A custom
    // layer's roads that went back to normal go away.
    const gone = dirty ? [...dirty] : [...ROAD_PART_IDS];
    for (const id of gone) {
      if (byPart.has(id)) continue;
      if (ROAD_PART_IDS.has(id)) {
        if (this.spec.layers.some((l) => l.id === id) || this.sentParts.has(id)) {
          out.push({ id, part: emptyPart(id) });
          this.sentParts.set(id, 'tiled');
        }
      } else if (this.sentParts.has(id)) {
        out.push({ id, part: null });
        this.sentParts.delete(id);
      }
    }
    return out;
  }

  /**
   * Trees a shape stands on, a road now covers that didn't before, or that
   * stood on ground kept in the water for something that's gone. Trees are
   * only planted off the generated roads when that option is on, so a road
   * that was already over one leaves it.
   */
  private hiddenTrees(shapes: MultiPolygon[], tiles: Map<number, RoadBucket[]>, earth: Earth | null): string[] {
    const dropped = earth?.dropped.length ? earth.dropped : null;
    if (!this.treeAnchors.length || (!shapes.length && !tiles.size && !dropped)) return [];
    const roads = this.roads;
    const boxes = shapes.map((polygons) => multiBounds(polygons));
    const droppedBox = dropped ? multiBounds(dropped) : null;
    const inside = (box: Box, x: number, y: number) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
    const generated = new Map<number, MultiPolygon[]>();
    const hidden: string[] = [];
    for (const tree of this.treeAnchors) {
      const { x, y } = tree;
      let covered = shapes.some((polygons, i) => inside(boxes[i], x, y) && pointInMulti(x, y, polygons));
      if (!covered && roads && tiles.size) {
        for (const [tile, buckets] of tiles) {
          if (!inside(roads.rect(tile), x, y)) continue;
          if (!buckets.some((b) => pointInMulti(x, y, b.polygons))) break;
          let before = generated.get(tile);
          if (!before) generated.set(tile, (before = roads.baseTile(tile).map((b) => b.polygons)));
          covered = !before.some((polygons) => pointInMulti(x, y, polygons));
          break;
        }
      }
      if (!covered && dropped && inside(droppedBox!, x, y) && pointInMulti(x, y, dropped)) {
        covered = earth!.wet.some((body) => inside(body.box, x, y) && pointInMulti(x, y, body.polygons));
      }
      if (covered) hidden.push(tree.key);
    }
    return hidden;
  }

  // -------------------------------------------------------------- export

  /** The model with the edits applied, for export, which leaves out the `excluded` parts (excludedParts). */
  async edited(edits: ModelEdits, palette: Palette, excluded: readonly string[] = []): Promise<ModelSpec> {
    const warnings: string[] = [];
    const pass = this.pass(edits);
    const layerIds = new Set(edits.layers.map((l) => l.id));
    const custom = new Map<string, Solid[]>();
    const customWater = new Map<string, Solid[]>();
    const toLayer = (layer: string, solid: Solid) => {
      const target = waterRank(solid.role) ? customWater : custom;
      const list = target.get(layer);
      if (list) list.push(solid);
      else target.set(layer, [solid]);
    };
    const partEdit = (key: string, sub?: string): ObjectEdit | undefined => (sub ? edits.objects[partKey(key, sub)] : undefined);
    const offDecks = new Map([...this.routesOnDecks.keys()].map((key) => [key, this.offDecks(edits, key)]));
    const removed = (solid: Solid) => {
      const key = solid.key!;
      return this.editOf(edits, key)?.removed || partEdit(key, solid.sub)?.removed || hidden.has(key) || offDecks.get(key)?.has(solid);
    };
    const layerOf = (solid: Solid) => {
      const layer = partEdit(solid.key!, solid.sub)?.layer ?? this.editOf(edits, solid.key!)?.layer;
      return layer && layerIds.has(layer) ? layer : undefined;
    };

    // The viewer's tiles when they're for these edits, or tiles of its own.
    const excludedSet = new Set(excluded);
    const { polygons: footprints } = await this.shapeFootprints(edits, warnings);
    const tiles = new Map(this.tiles);
    const { state } = await this.rebuildTiles(edits, this.roadState, tiles, this.roadCuts(edits, footprints, excludedSet));
    const roadsEdited = state.styles.size > 0 && this.roads !== null;
    const roadTiles = roadsEdited ? tiles : new Map<number, RoadBucket[]>();
    const decks = this.rebuiltDecks(edits);
    const { earth, standing } = this.standAll(pass, roadTiles, decks, footprints);
    const hidden = new Set(this.hiddenTrees(this.shownGrounds(standing, edits, excludedSet), roadTiles, earth));
    const cleared = this.cleared(standing, edits, excludedSet);
    const ground = this.groundCut(standing, edits, excludedSet);
    let city: Layer | null = null;
    try {
      if (cleared) city = cleared.cut.layer(cleared.hole);
    } catch {
      warnings.push(CUT_FAILED);
    }

    // Solids an edit replaces: each by its new self, or a group of them by
    // what's there now, which goes where the first of them was.
    const swaps = new Map<Solid, Solid[]>();
    const left = new Set<Solid>();
    const swap = (originals: Solid[], replacements: Solid[]) => {
      if (!originals.length) return;
      swaps.set(originals[0], replacements);
      for (const solid of originals.slice(1)) left.add(solid);
    };
    for (const [object] of pass.reshaped) {
      const originals = this.objects.get(object)!.flatMap((p) => p.solids);
      const edited = this.solidsOf(pass, object).map((e) => e.solid);
      originals.forEach((solid, i) => edited[i] !== solid && swaps.set(solid, [edited[i]]));
    }
    for (const [key, deck] of decks) {
      const placed = this.objects.get(key) ?? [];
      swap(
        placed.flatMap((p) => p.solids.filter((s) => s.sub === 'deck')),
        deck.decks,
      );
      if (deck.piers) {
        swap(
          placed.flatMap((p) => p.solids.filter((s) => s.sub === 'pier')),
          deck.piers,
        );
      }
    }

    const roadBuckets = new Map<string, Map<number, MultiPolygon[]>>();
    if (roadsEdited) {
      for (let tile = 0; tile < this.roads!.count; tile++) {
        for (const bucket of this.tileContent(tile, tiles)) {
          let byThickness = roadBuckets.get(bucket.part);
          if (!byThickness) roadBuckets.set(bucket.part, (byThickness = new Map()));
          const list = byThickness.get(bucket.thickness);
          if (list) list.push(bucket.polygons);
          else byThickness.set(bucket.thickness, [bucket.polygons]);
        }
      }
    }
    const mergedRoads = (part: string): PrismSolid[] => {
      const byThickness = roadBuckets.get(part);
      if (!byThickness) return [];
      const out: PrismSolid[] = [];
      for (const [thickness, lists] of byThickness) {
        const polygons = union(...lists);
        out.push(...this.roadSolids({ part, thickness, polygons }));
      }
      return out;
    };

    const layers: Layer[] = [];
    for (const layer of this.spec.layers) {
      if (roadsEdited && ROAD_PART_IDS.has(layer.id)) {
        const solids = mergedRoads(layer.id);
        if (solids.length) layers.push({ ...layer, solids });
        continue;
      }
      const source =
        layer.id === 'terrain' && earth?.terrain
          ? earth.terrain
          : layer.id === 'water' && earth?.water
            ? earth.water
            : layer.id === 'city' && city
              ? city.solids
              : ground && layer.id.startsWith('land-')
                ? cutSlabs(layer.solids, ground.set)
                : layer.solids;
      const kept: Solid[] = [];
      for (const original of source) {
        if (left.has(original)) continue;
        for (const solid of swaps.get(original) ?? [original]) {
          if (!solid.key) {
            kept.push(solid);
            continue;
          }
          if (removed(solid)) continue;
          const target = layerOf(solid);
          if (target) toLayer(target, solid);
          else kept.push(solid);
        }
      }
      if (kept.length) layers.push({ ...layer, solids: kept });
    }
    // Land cover back where a removed road, building or body of water was, in its land part.
    for (const fill of this.fills(pass, roadTiles, ground)) {
      const id = `land-${fill.category}`;
      const solids = this.landSolids(fill, `${FILL_PREFIX}${fill.category}`);
      const existing = layers.find((l) => l.id === id);
      if (existing) existing.solids = [...existing.solids, ...solids];
      else layers.push({ id, name: LAND_NAMES[fill.category as SurfaceCategory], role: LAND_ROLES[fill.category], solids });
    }
    // Road parts the generated model didn't have, like paths only an edit brought in.
    for (const part of roadBuckets.keys()) {
      if (part.startsWith('layer:')) {
        const id = part.slice('layer:'.length);
        for (const solid of mergedRoads(part)) toLayer(id, solid);
      } else if (!layers.some((l) => l.id === part)) {
        const solids = mergedRoads(part);
        const role: MaterialRole = part === 'rail' ? 'rail' : part === 'paths' ? 'path' : 'road';
        if (solids.length) layers.push({ id: part, name: part === 'rail' ? 'Railways' : part === 'paths' ? 'Paths' : 'Roads', role, solids });
      }
    }

    // Shapes go with their layer, or into a part of their colour group's own.
    const byGroup = new Map<ColourGroup, Solid[]>();
    for (const shape of edits.shapes) {
      const solids = standing.get(shape.id)!.solids;
      if (layerIds.has(shape.layer)) {
        for (const solid of solids) toLayer(shape.layer, solid);
        continue;
      }
      const group = (shape.layer in GROUP_ROLE ? shape.layer : 'buildings') as ColourGroup;
      const list = byGroup.get(group);
      if (list) list.push(...solids);
      else byGroup.set(group, [...solids]);
    }
    for (const [group, solids] of byGroup) {
      if (!solids.length) continue;
      const entry = palette[group];
      // Their own part, but in their group's colour, and never outranking
      // the terrain or water the way a water or terrain part would.
      layers.push({ id: `added-${group}`, name: `Added (${groupLabel(group)})`, role: 'building', solids, colour: { ...entry, label: groupLabel(group) } });
    }
    for (const layer of edits.layers) {
      const solids = custom.get(layer.id);
      if (solids?.length) layers.push({ id: layerPartId(layer.id), name: layer.name, role: 'building', solids, colour: colourOf(layer) });
      const water = customWater.get(layer.id);
      if (water?.length) layers.push({ id: `${layerPartId(layer.id)}:water`, name: `${layer.name} (water)`, role: 'water', solids: water, colour: colourOf(layer) });
    }
    return { ...this.spec, layers, warnings: [...this.spec.warnings, ...warnings] };
  }
}

/** What a note says about characters a font can't draw. */
function glyphNote({ chars, shownAs }: MissingGlyphs): string {
  const quoted = chars.map((c) => `“${c}”`);
  const list =
    quoted.length > 5 ? `${quoted.slice(0, 5).join(', ')} and ${quoted.length - 5} more` : quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}` : quoted[0];
  const one = chars.length === 1;
  const result =
    shownAs === 'box'
      ? `${one ? 'it prints as a box' : 'they print as boxes'}`
      : shownAs === 'question'
        ? `${one ? 'it prints as a question mark' : 'they print as question marks'}`
        : `${one ? "it's" : "they're"} left out`;
  return `This font has no ${list}, so ${result}.`;
}

const BURIED_NOTES: Record<string, string> = {
  building: "It's inside a building, so it won't show. Raise it to stand on the roof.",
  bridge: "It's inside a bridge, so it won't show. Raise it to stand on the deck.",
  shape: "It's inside another shape, so it won't show. Raise it to stand on top.",
  surface: "It runs under buildings or overpasses, so it won't show. Raise it to stand on top.",
};

function peakOfSolid(solid: Solid): number {
  if (solid.kind === 'prism') {
    if (typeof solid.top === 'number') return solid.top;
    let peak = -Infinity;
    for (const ring of solid.polygon) for (const [x, y] of ring) peak = Math.max(peak, solid.top(x, y));
    return peak;
  }
  const values = solid.kind === 'cap' ? solid.vertices : solid.positions;
  let peak = -Infinity;
  for (let i = 2; i < values.length; i += 3) peak = Math.max(peak, values[i]);
  return peak;
}

function solidBox(solid: Solid): Box {
  if (solid.kind === 'prism') return ringBounds(solid.polygon[0]);
  const values = solid.kind === 'cap' ? solid.vertices : solid.positions;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < values.length; i += 3) {
    minX = Math.min(minX, values[i]);
    minY = Math.min(minY, values[i + 1]);
    maxX = Math.max(maxX, values[i]);
    maxY = Math.max(maxY, values[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

/** Ground under a footprint sampled along its outline and inside it: the highest or the lowest. */
function groundExtreme(ctx: EditContext, polygons: MultiPolygon, high: boolean): number {
  let value = high ? -Infinity : Infinity;
  const take = (z: number) => {
    value = high ? Math.max(value, z) : Math.min(value, z);
  };
  const hf = ctx.heightfield;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % ring.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
        for (let k = 0; k < steps; k++) take(ctx.heightAt(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps));
      }
    }
    if (hf) for (const node of hf.nodesInside(polygon)) take(hf.values[node]);
    else if (ctx.grid) for (const [x, y] of interiorPoints(polygon, Math.min(ctx.grid.step, ctx.grid.stepY ?? ctx.grid.step), 200_000)) take(ctx.heightAt(x, y));
  }
  return Number.isFinite(value) ? value : 0;
}

/** Highest ground under a footprint, outline and grid nodes both. */
function highestGround(ctx: EditContext, polygons: MultiPolygon): number {
  return groundExtreme(ctx, polygons, true);
}

function lowestGround(ctx: EditContext, polygons: MultiPolygon): number {
  return groundExtreme(ctx, polygons, false);
}

export function colourOf(layer: EditLayer): PartColour {
  return { hex: layer.hex, line: layer.line, label: layer.name };
}

const GROUP_LABELS: Record<ColourGroup, string> = {
  terrain: 'Terrain',
  buildings: 'Buildings',
  roads: 'Roads',
  route: 'Routes',
  paved: 'Paved',
  water: 'Water',
  green: 'Parks',
  forest: 'Forest',
  trees: 'Trees',
  sand: 'Sand',
  rock: 'Rock',
  rim: 'Rim',
};

function groupLabel(group: ColourGroup): string {
  return GROUP_LABELS[group];
}

/** Land cover slabs with what shapes stand on taken out, the rest as they were. */
function cutSlabs(solids: Solid[], cut: ClipSet): Solid[] {
  return solids.flatMap((solid) => {
    if (solid.kind !== 'prism' || !cut.within(ringBounds(solid.polygon[0])).length) return [solid];
    return cutCover([solid.polygon], cut).map((polygon) => ({ ...solid, polygon }));
  });
}

function emptyPart(id: string): MeshPart {
  const role: MaterialRole = id === 'rail' ? 'rail' : id === 'paths' ? 'path' : 'road';
  return { id, name: id, role, positions: new Float32Array(0), indices: new Uint32Array(0) };
}

/**
 * A shape cut along a LiDAR only model's water has slivers where the two
 * outlines nearly meet, and its draped top's triangulation gave up on them.
 * Opening it by a micron takes them out.
 */
function openSlivers(polygons: MultiPolygon): MultiPolygon {
  return dropSmall(offsetPolygons(offsetPolygons(polygons, -SLIVER_MM, 'miter'), SLIVER_MM, 'miter'), SUPPORT_MIN_MM2);
}

function sameHeld(a: Map<string, HeldGuess>, b: Map<string, HeldGuess>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, known] of a) {
    const other = b.get(id);
    if (!other || polygonSignature(other.held) !== polygonSignature(known.held)) return false;
  }
  return true;
}

/** A cheap fingerprint of polygon coordinates, to tell a tile's roads didn't change. */
function polygonSignature(polygons: MultiPolygon): string {
  let hash = 2166136261;
  let count = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        hash = Math.imul(hash ^ Math.round(x * 1e4), 16777619);
        hash = Math.imul(hash ^ Math.round(y * 1e4), 16777619);
        count++;
      }
      hash = Math.imul(hash ^ 0x9e3779b9, 16777619);
    }
  }
  return `${count}:${(hash >>> 0).toString(36)}`;
}

/** One mesh of several, always a new one: tile meshes are kept, and what's sent is transferred. */
function concat(meshes: MeshData[]): MeshData {
  let vertices = 0;
  let indices = 0;
  for (const m of meshes) {
    vertices += m.positions.length;
    indices += m.indices.length;
  }
  const positions = new Float32Array(vertices);
  const out = new Uint32Array(indices);
  let v = 0;
  let i = 0;
  for (const m of meshes) {
    positions.set(m.positions, v);
    const offset = v / 3;
    for (let k = 0; k < m.indices.length; k++) out[i + k] = m.indices[k] + offset;
    v += m.positions.length;
    i += m.indices.length;
  }
  return { positions, indices: out };
}
