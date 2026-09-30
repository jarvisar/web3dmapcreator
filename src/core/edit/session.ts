// Applies edits to a generated model, in the worker. The viewer keeps the
// generated meshes and gets told what changed: new geometry for an object
// (a building made taller, a shape), or whole road parts once roads are
// edited (see roads.ts). Removed objects and colours it works out from the
// edits itself. Exports mesh the edited model from scratch.

import { boxesOverlap, clipToUnits, difference, multiBounds, pointInMulti, ringBounds, union, type Box } from '../geometry/polygon';
import { interiorPoints } from '../terrain/heightfield';
import type { Layer, PrismSolid, Solid } from '../geometry/solid';
import type { Projection } from '../geo/projection';
import { meshLayers } from '../pipeline/mesh';
import { LAND_NAMES, LAND_ROLES, type EditContext, type ModelSpec } from '../pipeline/generate';
import type { ModelSettings, Palette, SurfaceCategory } from '../settings';
import { bareLand, LandTiles, openFill, type LandFill } from './land';
import type { LoadedFont } from '../svgmap/text/outline';
import type { ColourGroup, MaterialRole, MeshPart, MultiPolygon, PartColour, PartObjects } from '../types';
import { heightFactor, scaleSolid } from './heights';
import { kindOf, objectOf, partKey, shapeKey } from './keys';
import { ROAD_PARTS, RoadTiles, TileGrid, type RoadBucket, type RoadStyle } from './roads';
import { shapeFootprint } from './shapes';
import type { AddedShape, EditLayer, ModelEdits, ObjectEdit } from './types';

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  objects?: PartObjects;
}

/** New geometry for one object, or null to go back to the generated one. */
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
  warnings: string[];
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
}

/** Where added shapes show in the viewer. They export in their layer's part. */
export const SHAPES_PART = 'shapes';

const ROAD_PART_IDS = new Set(Object.values(ROAD_PARTS));

export function layerPartId(layer: string): string {
  return `layer:${layer}`;
}

function waterRank(role: MaterialRole): boolean {
  return role === 'water';
}

/** Role a colour group's own solids have, for a shape of that colour. */
const GROUP_ROLE: Record<ColourGroup, MaterialRole> = {
  terrain: 'terrain',
  buildings: 'building',
  roads: 'road',
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

export class EditSession {
  private readonly ctx: EditContext;
  private readonly zShift: number;
  private readonly crop: MultiPolygon;
  /** Keyed solids by object key, in the layers they were generated in. */
  private readonly objects = new Map<string, Placed[]>();
  private readonly treeAnchors: { key: string; x: number; y: number }[] = [];
  private roads: RoadTiles | null = null;
  /** What each tile holds now, for tiles built from edited roads. */
  private readonly tiles = new Map<number, RoadBucket[]>();
  /** Meshed tiles for the viewer, by tile and then part. */
  private readonly tileMeshes = new Map<number, Map<string, MeshData>>();
  private readonly tileSignatures = new Map<number, Map<string, string>>();
  private tiled = false;
  private roadStyles = new Map<string, string>();
  private readonly sentObjects = new Map<string, string>();
  private readonly sentParts = new Map<string, string>();
  /** Built shape footprints, by the shape's geometry. */
  private readonly footprints = new Map<string, { signature: string; polygons: MultiPolygon }>();
  private readonly grounds: Ground[] = [];
  /** Road edits and land fills are worked out in the same tiles. */
  private readonly grid: TileGrid;
  private landTiles: LandTiles | null = null;
  /** Land fill of each tile before openings, by what the tile had. */
  private readonly tileFills = new Map<number, { signature: string; fills: LandFill[] }>();
  private fillCache: { signature: string; fills: LandFill[] } | null = null;

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
  }

  /** Object facts for the viewer: what it is, what it's called, how tall. */
  describe(): Record<string, ObjectFacts> {
    const out: Record<string, ObjectFacts> = {};
    for (const [key, info] of this.ctx.objects) {
      const entry: ObjectFacts = { kind: info.kind };
      if (info.name) entry.name = info.name;
      if (info.detail) entry.detail = info.detail;
      if (info.heightM !== undefined) entry.heightM = Math.round(info.heightM * 10) / 10;
      if (info.measured) entry.measured = true;
      const placed = this.objects.get(key);
      if (placed && info.base !== undefined) {
        let peak = -Infinity;
        for (const p of placed) for (const s of p.solids) peak = Math.max(peak, peakOfSolid(s));
        if (Number.isFinite(peak)) entry.heightMm = Math.round((peak - info.base) * 100) / 100;
        entry.groundZ = info.base + this.zShift;
      }
      out[key] = entry;
    }
    return out;
  }

  // ------------------------------------------------------------ geometry

  /** Every solid of an object with its height edits applied. */
  private editedSolids(key: string, edits: ModelEdits): { layer: Layer; solid: Solid }[] {
    const placed = this.objects.get(key) ?? [];
    const out: { layer: Layer; solid: Solid }[] = [];
    const base = this.ctx.objects.get(key)?.base;
    const whole = edits.objects[key];
    const all = placed.flatMap((p) => p.solids);
    const wholeFactor = base !== undefined && whole?.heightMm !== undefined ? heightFactor(all, base, whole.heightMm) : 1;
    // A part with a height of its own takes it, whatever the building's.
    const partFactors = new Map<string, number>();
    if (base !== undefined) {
      const subs = new Set(all.map((s) => s.sub ?? ''));
      for (const sub of subs) {
        const edit = sub ? edits.objects[partKey(key, sub)] : undefined;
        if (edit?.heightMm === undefined) continue;
        partFactors.set(sub, heightFactor(all.filter((s) => (s.sub ?? '') === sub), base, edit.heightMm));
      }
    }
    for (const { layer, solids } of placed) {
      for (const solid of solids) {
        const factor = partFactors.get(solid.sub ?? '') ?? wholeFactor;
        out.push({ layer, solid: base !== undefined && factor !== 1 ? scaleSolid(solid, base, factor) : solid });
      }
    }
    return out;
  }

  private async mesh(layerId: string, role: MaterialRole, solids: Solid[]): Promise<MeshData | null> {
    if (!solids.length) return null;
    const { parts } = await meshLayers([{ id: layerId, name: layerId, role, solids }], { zShift: this.zShift, objects: true });
    const part = parts[0];
    return part ? { positions: part.positions, indices: part.indices, objects: part.objects } : { positions: new Float32Array(0), indices: new Uint32Array(0) };
  }

  private async shapeSolids(shape: AddedShape, warnings: string[]): Promise<PrismSolid[]> {
    const polygons = await this.footprint(shape, warnings);
    if (!polygons.length) return [];
    const ctx = this.ctx;
    const hf = ctx.heightfield;
    const lift = shape.liftMm + shape.heightMm;
    const key = shapeKey(shape.id);
    const bottom = this.spec.baseZ;
    if (shape.followGround) {
      const drape = hf ? (hf.flat ? 0 : hf.step) : 1;
      const lattice = hf && !hf.flat ? hf.lattice : undefined;
      return polygons.map((polygon) => ({ kind: 'prism', role: 'building', polygon, top: (x, y) => ctx.heightAt(x, y) + lift, bottom, drape, lattice, key }));
    }
    const top = highestGround(ctx, polygons) + lift;
    return polygons.map((polygon) => ({ kind: 'prism', role: 'building', polygon, top, bottom, drape: 0, key }));
  }

  private async footprint(shape: AddedShape, warnings: string[]): Promise<MultiPolygon> {
    const signature = JSON.stringify([shape.kind, shape.at, shape.points, shape.rotationDeg, shape.sizeMm, shape.depthMm, shape.text, shape.font]);
    const cached = this.footprints.get(shape.id);
    if (cached?.signature === signature) return cached.polygons;
    let font: LoadedFont | null = null;
    if (shape.kind === 'text') {
      try {
        font = this.fonts ? await this.fonts.load(shape.font) : null;
      } catch (error) {
        warnings.push(`The font for “${shape.text}” could not be loaded. ${error instanceof Error ? error.message : ''}`.trim());
      }
    }
    const polygons = shapeFootprint(shape, this.projection, this.crop, font) ?? [];
    if (!(shape.kind === 'text' && !font)) this.footprints.set(shape.id, { signature, polygons });
    return polygons;
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
    this.roads = new RoadTiles(this.ctx.roads, base, this.crop, this.ctx.water, ringBounds(this.spec.crop[0]), this.settings);
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
    return bucket.polygons.map((polygon) => ({ kind: 'prism', role, polygon, top, bottom, drape, lattice }));
  }

  private styles(edits: ModelEdits, roads: RoadTiles): Map<string, RoadStyle> {
    const out = new Map<string, RoadStyle>();
    for (const [key, edit] of Object.entries(edits.objects)) {
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
   * Tiles rebuilt for these edits, and which of them differ from `current`.
   * Tiles no edited road reaches keep the generated polygons.
   */
  private async rebuildTiles(
    edits: ModelEdits,
    current: Map<string, string>,
    tiles: Map<number, RoadBucket[]>,
  ): Promise<{ styles: Map<string, string>; changed: Set<number> }> {
    const changed = new Set<number>();
    const roads = this.roadTiles();
    if (!roads) return { styles: new Map(), changed };
    const styles = this.styles(edits, roads);
    const next = new Map([...styles].map(([key, style]) => [key, JSON.stringify(style)]));
    const touched = new Set<string>();
    for (const [key, value] of next) if (current.get(key) !== value) touched.add(key);
    for (const key of current.keys()) if (!next.has(key)) touched.add(key);
    for (const key of touched) {
      const before = current.get(key);
      for (const tile of roads.tilesOf(key, before ? (JSON.parse(before) as RoadStyle) : undefined)) changed.add(tile);
      for (const tile of roads.tilesOf(key, styles.get(key))) changed.add(tile);
    }
    const reached = new Set<number>();
    for (const [key, style] of styles) for (const tile of roads.tilesOf(key, style)) reached.add(tile);
    for (const tile of changed) {
      if (reached.has(tile)) tiles.set(tile, await roads.tile(tile, (key) => styles.get(key)));
      else tiles.delete(tile);
    }
    return { styles: next, changed };
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

  // ------------------------------------------------------------- update

  async update(edits: ModelEdits, version: number): Promise<EditUpdate> {
    const warnings: string[] = [];
    const objects: ObjectMesh[] = [];
    const parts: PartUpdate[] = [];

    // Objects whose height was edited get new geometry.
    const wanted = new Map<string, string>();
    for (const [key, edit] of Object.entries(edits.objects)) {
      if (edit.heightMm === undefined || kindOf(key) !== 'building') continue;
      const object = objectOf(key);
      if (!this.objects.has(object)) continue;
      wanted.set(object, '');
    }
    for (const object of wanted.keys()) {
      const signature = Object.entries(edits.objects)
        .filter(([key, edit]) => objectOf(key) === object && edit.heightMm !== undefined)
        .map(([key, edit]) => `${key}=${edit.heightMm}`)
        .sort()
        .join(';');
      wanted.set(object, signature);
    }
    for (const [key, signature] of wanted) {
      if (this.sentObjects.get(key) === signature) continue;
      const edited = this.editedSolids(key, edits);
      const partId = edited[0]?.layer.id ?? 'buildings';
      objects.push({ key, part: partId, mesh: await this.mesh(partId, edited[0]?.layer.role ?? 'building', edited.map((e) => e.solid)) });
      this.sentObjects.set(key, signature);
    }

    // Shapes.
    const shapeKeys = new Set<string>();
    const shapeFootprints: MultiPolygon[] = [];
    for (const shape of edits.shapes) {
      const key = shapeKey(shape.id);
      shapeKeys.add(key);
      const signature = JSON.stringify([shape.kind, shape.at, shape.points, shape.rotationDeg, shape.sizeMm, shape.depthMm, shape.heightMm, shape.liftMm, shape.followGround, shape.text, shape.font]);
      const solids = await this.shapeSolids(shape, warnings);
      for (const solid of solids) shapeFootprints.push([solid.polygon]);
      if (this.sentObjects.get(key) === signature) continue;
      objects.push({ key, part: SHAPES_PART, mesh: await this.mesh(SHAPES_PART, 'building', solids) });
      this.sentObjects.set(key, signature);
    }

    // Roads.
    const { styles, changed } = await this.rebuildTiles(edits, this.roadStyles, this.tiles);
    this.roadStyles = styles;
    if (styles.size && this.roads) {
      const first = !this.tiled;
      this.tiled = true;
      const remesh = first ? Array.from({ length: this.roads.count }, (_, i) => i) : [...changed];
      const dirty = new Set<string>();
      for (const tile of remesh) for (const id of await this.meshTile(tile)) dirty.add(id);
      if (first || dirty.size) parts.push(...this.assembleRoadParts(edits, first ? null : dirty));
    } else if (this.tiled) {
      this.tiled = false;
      this.tiles.clear();
      this.tileMeshes.clear();
      this.tileSignatures.clear();
      for (const id of this.sentParts.keys()) parts.push({ id, part: null });
      this.sentParts.clear();
    }

    // Land cover back where a removed road or building was.
    const fillKeys = new Set<string>();
    for (const fill of this.fills(edits, this.tiles)) {
      const key = `${FILL_PREFIX}${fill.category}`;
      fillKeys.add(key);
      const signature = polygonSignature(fill.polygons);
      if (this.sentObjects.get(key) === signature) continue;
      const role = LAND_ROLES[fill.category];
      objects.push({ key, part: `land-${fill.category}`, role, mesh: await this.mesh(`land-${fill.category}`, role, this.landSolids(fill, key)) });
      this.sentObjects.set(key, signature);
    }

    // Anything sent before that's no longer edited goes back.
    for (const key of [...this.sentObjects.keys()]) {
      if (wanted.has(key) || shapeKeys.has(key) || fillKeys.has(key)) continue;
      const part = key.startsWith(FILL_PREFIX)
        ? `land-${key.slice(FILL_PREFIX.length)}`
        : kindOf(key) === 'shape'
          ? SHAPES_PART
          : (this.objects.get(key)?.[0]?.layer.id ?? 'buildings');
      objects.push({ key, part, mesh: null });
      this.sentObjects.delete(key);
    }

    return { model: this.id, version, objects, parts, hidden: this.hiddenTrees(shapeFootprints, this.tiles), warnings };
  }

  // --------------------------------------------------------------- land

  /**
   * Land cover for the ground removed buildings and roads left, by category.
   * Worked out tile by tile, so an edit only looks at what's near it, and
   * each tile is kept until what it had changes.
   */
  private fills(edits: ModelEdits, tiles: Map<number, RoadBucket[]>): LandFill[] {
    const land = this.ctx.land;
    if (!land) return [];
    const removed = (ground: Ground) => Boolean(edits.objects[ground.key]?.removed || (ground.sub && edits.objects[partKey(ground.key, ground.sub)]?.removed));
    const todo = new Map<number, number[]>();
    for (const tile of tiles.keys()) todo.set(tile, []);
    this.grounds.forEach((ground, i) => {
      if (!removed(ground)) return;
      for (const tile of this.grid.tilesTouching(ground.box)) {
        const list = todo.get(tile);
        if (list) list.push(i);
        else todo.set(tile, [i]);
      }
    });
    if (!todo.size) return [];
    const signatures: string[] = [];
    const pieces = new Map<SurfaceCategory, MultiPolygon[]>();
    for (const tile of [...todo.keys()].sort((a, b) => a - b)) {
      const gone = todo.get(tile)!;
      const buckets = tiles.get(tile);
      const signature = `${tile}:${buckets ? buckets.map((b) => polygonSignature(b.polygons)).join('|') : '-'}:${gone.join(',')}`;
      signatures.push(signature);
      let cached = this.tileFills.get(tile);
      if (cached?.signature !== signature) this.tileFills.set(tile, (cached = { signature, fills: this.bareTile(tile, buckets, gone, removed) }));
      for (const fill of cached.fills) {
        const list = pieces.get(fill.category);
        if (list) list.push(fill.polygons);
        else pieces.set(fill.category, [fill.polygons]);
      }
    }
    const signature = signatures.join(';');
    if (this.fillCache?.signature === signature) return this.fillCache.fills;
    // Openings go after the tiles are joined, or every tile edge would round
    // the fill's corners there.
    const fills: LandFill[] = [];
    for (const category of this.settings.land.priority) {
      const lists = pieces.get(category);
      if (!lists) continue;
      const polygons = openFill(lists.length === 1 ? lists[0] : union(...lists));
      if (polygons.length) fills.push({ category, polygons });
    }
    this.fillCache = { signature, fills };
    return fills;
  }

  /** Bare ground in one tile with the land cover it had. */
  private bareTile(tile: number, buckets: RoadBucket[] | undefined, gone: number[], removed: (ground: Ground) => boolean): LandFill[] {
    this.landTiles ??= new LandTiles(this.ctx.land!, this.grid);
    const land = this.landTiles.tile(tile);
    const base = this.roads?.baseTile(tile).flatMap((b) => b.polygons) ?? [];
    const now = buckets ? buckets.flatMap((b) => b.polygons) : base;
    const vacated: MultiPolygon = [];
    if (buckets && base.length) vacated.push(...(now.length ? difference(base, now) : base));
    const rect = this.grid.units(tile);
    for (const i of gone) vacated.push(...clipToUnits(this.grounds[i].pieces, rect));
    if (!vacated.length) return [];
    // What still stands there keeps the land cover off, as in the land stage.
    const box = this.grid.rect(tile);
    const blockers: MultiPolygon = [...now, ...land.water];
    for (const ground of this.grounds) if (!removed(ground) && boxesOverlap(ground.box, box)) blockers.push(...ground.pieces);
    return bareLand(land.regions, this.settings.land.priority, vacated, blockers);
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
   * Trees a shape stands on, or a road now covers that didn't before. Trees
   * are only planted off the generated roads when that option is on, so a
   * road that was already over one leaves it.
   */
  private hiddenTrees(shapes: MultiPolygon[], tiles: Map<number, RoadBucket[]>): string[] {
    if (!this.treeAnchors.length || (!shapes.length && !tiles.size)) return [];
    const roads = this.roads;
    const boxes = shapes.map((polygons) => ringBounds(polygons[0][0]));
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
      if (covered) hidden.push(tree.key);
    }
    return hidden;
  }

  // -------------------------------------------------------------- export

  /** The model with the edits applied, for export. */
  async edited(edits: ModelEdits, palette: Palette): Promise<ModelSpec> {
    const warnings: string[] = [];
    const layerIds = new Set(edits.layers.map((l) => l.id));
    const shapeSolids = new Map<AddedShape, PrismSolid[]>();
    for (const shape of edits.shapes) shapeSolids.set(shape, await this.shapeSolids(shape, warnings));
    const custom = new Map<string, Solid[]>();
    const customWater = new Map<string, Solid[]>();
    const toLayer = (layer: string, solid: Solid) => {
      const target = waterRank(solid.role) ? customWater : custom;
      const list = target.get(layer);
      if (list) list.push(solid);
      else target.set(layer, [solid]);
    };
    const editOf = (key: string, sub?: string): ObjectEdit | undefined => (sub ? edits.objects[partKey(key, sub)] : undefined);
    const removed = (solid: Solid) => {
      const key = solid.key!;
      return edits.objects[key]?.removed || editOf(key, solid.sub)?.removed || hidden.has(key);
    };
    const layerOf = (solid: Solid) => {
      const layer = editOf(solid.key!, solid.sub)?.layer ?? edits.objects[solid.key!]?.layer;
      return layer && layerIds.has(layer) ? layer : undefined;
    };

    // Solids with new heights, by object.
    const scaled = new Map<Solid, Solid>();
    for (const [key, edit] of Object.entries(edits.objects)) {
      if (edit.heightMm === undefined || kindOf(key) !== 'building') continue;
      const object = objectOf(key);
      if (!this.objects.has(object) || scaled.has(this.objects.get(object)![0].solids[0])) continue;
      const originals = this.objects.get(object)!.flatMap((p) => p.solids);
      const edited = this.editedSolids(object, edits).map((e) => e.solid);
      originals.forEach((solid, i) => scaled.set(solid, edited[i]));
    }

    // The viewer's tiles when they're for these edits, or tiles of its own.
    const tiles = new Map(this.tiles);
    const { styles } = await this.rebuildTiles(edits, this.roadStyles, tiles);
    const roadsEdited = styles.size > 0 && this.roads !== null;
    const footprints = [...shapeSolids.values()].flatMap((solids) => solids.map((s): MultiPolygon => [s.polygon]));
    const hidden = new Set(this.hiddenTrees(footprints, roadsEdited ? tiles : new Map()));
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
      const kept: Solid[] = [];
      for (const original of layer.solids) {
        if (!original.key) {
          kept.push(original);
          continue;
        }
        if (removed(original)) continue;
        const solid = scaled.get(original) ?? original;
        const target = layerOf(original);
        if (target) toLayer(target, solid);
        else kept.push(solid);
      }
      if (kept.length) layers.push({ ...layer, solids: kept });
    }
    // Land cover back where a removed road or building was, in its land part.
    for (const fill of this.fills(edits, roadsEdited ? tiles : new Map())) {
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
      const solids = shapeSolids.get(shape)!;
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

/** Highest ground under a footprint, outline and grid nodes both. */
function highestGround(ctx: EditContext, polygons: MultiPolygon): number {
  let high = -Infinity;
  const hf = ctx.heightfield;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % ring.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
        for (let k = 0; k < steps; k++) high = Math.max(high, ctx.heightAt(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps));
      }
    }
    if (hf) for (const node of hf.nodesInside(polygon)) high = Math.max(high, hf.values[node]);
    else if (ctx.grid) for (const [x, y] of interiorPoints(polygon, Math.min(ctx.grid.step, ctx.grid.stepY ?? ctx.grid.step), 200_000)) high = Math.max(high, ctx.heightAt(x, y));
  }
  return Number.isFinite(high) ? high : 0;
}

export function colourOf(layer: EditLayer): PartColour {
  return { hex: layer.hex, line: layer.line, label: layer.name };
}

const GROUP_LABELS: Record<ColourGroup, string> = {
  terrain: 'Terrain',
  buildings: 'Buildings',
  roads: 'Roads',
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

function emptyPart(id: string): MeshPart {
  const role: MaterialRole = id === 'rail' ? 'rail' : id === 'paths' ? 'path' : 'road';
  return { id, name: id, role, positions: new Float32Array(0), indices: new Uint32Array(0) };
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
