// Maps OpenMapTiles classes to the app's layers. Classification keeps everything
// any setting could want, with flags, and acceptLine/acceptPolygon apply the
// filters at render time. That way a filter change doesn't need a new download.
import type { Props } from './decode';

export type FillLayerId = 'buildings' | 'water' | 'greens' | 'sand' | 'rocks' | 'aeroways' | 'decks';
export type LineLayerId = 'roads' | 'paths' | 'railways' | 'waterways' | 'raceways';

export const FLAG = {
  tunnel: 1,
  bridge: 2,
  parkingAisle: 4,
  driveway: 8,
  alley: 16,
  railYard: 32,
  pool: 64,
  intermittent: 128,
  bridgeArea: 256,
  wetland: 512,
  pitch: 1024,
  cemetery: 2048,
  minorRail: 4096,
  ramp: 8192,
} as const;

export interface LineClass {
  layer: LineLayerId;
  cls: string;
  rank: number;
  flags: number;
}

export interface FillClass {
  layer: FillLayerId;
  cls: string;
  flags: number;
}

// Lower is more important. Same table as the original pipeline, except that
// OpenMapTiles merges residential and unclassified into "minor".
export const ROAD_RANK: Record<string, number> = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  unclassified: 5,
  minor: 6,
  pedestrian: 7,
  service: 8,
  busway: 8,
  track: 9,
  raceway: 7,
  cycleway: 10,
  rail: 10,
  bridleway: 11,
  footway: 11,
  path: 11,
  steps: 11,
  waterway: 12,
};

const STR = (v: unknown) => (typeof v === 'string' ? v : '');

export function classifyLine(layer: string, props: Props): LineClass | null {
  const cls = STR(props.class);
  const subclass = STR(props.subclass);
  let flags = 0;
  if (props.brunnel === 'tunnel') flags |= FLAG.tunnel;
  if (props.brunnel === 'bridge') flags |= FLAG.bridge;
  if (props.intermittent === 1 || props.intermittent === true) flags |= FLAG.intermittent;

  if (layer === 'waterway') {
    if (!['stream', 'river', 'canal', 'drain', 'ditch'].includes(cls)) return null;
    return { layer: 'waterways', cls, rank: ROAD_RANK.waterway, flags };
  }
  if (layer === 'aeroway') return null; // runway centrelines become fills in `aerowayLine`.
  if (layer !== 'transportation') return null;
  if (props.indoor === 1 || props.indoor === true) return null;
  if (cls.endsWith('_construction') || cls === 'ferry') return null;

  const service = STR(props.service);
  if (service === 'parking_aisle') flags |= FLAG.parkingAisle;
  if (service === 'driveway') flags |= FLAG.driveway;
  if (service === 'alley') flags |= FLAG.alley;
  if (['yard', 'siding', 'spur', 'crossover'].includes(service)) flags |= FLAG.railYard;
  if (props.ramp === 1 || props.ramp === true) flags |= FLAG.ramp;

  switch (cls) {
    case 'motorway':
    case 'trunk':
    case 'primary':
    case 'secondary':
    case 'tertiary':
    case 'minor':
    case 'service':
    case 'track':
      return { layer: 'roads', cls, rank: ROAD_RANK[cls], flags };
    case 'busway':
    case 'bus_guideway':
      return { layer: 'roads', cls: 'busway', rank: ROAD_RANK.busway, flags };
    case 'raceway':
      return { layer: 'raceways', cls, rank: ROAD_RANK.raceway, flags };
    case 'path':
      switch (subclass) {
        case 'pedestrian':
          return { layer: 'roads', cls: 'pedestrian', rank: ROAD_RANK.pedestrian, flags };
        case 'cycleway':
          return { layer: 'paths', cls: 'cycleway', rank: ROAD_RANK.cycleway, flags };
        case 'bridleway':
          return { layer: 'paths', cls: 'bridleway', rank: ROAD_RANK.bridleway, flags };
        case 'steps':
          return { layer: 'paths', cls: 'steps', rank: ROAD_RANK.steps, flags };
        case 'footway':
        case 'path':
        case '':
          return { layer: 'paths', cls: 'footway', rank: ROAD_RANK.footway, flags };
        default:
          return null; // corridor (indoor), platform (edges of a platform area)
      }
    case 'rail':
    case 'transit': {
      if (!subclass) return null;
      const minor = ['light_rail', 'tram', 'monorail', 'funicular', 'subway', 'narrow_gauge', 'preserved'];
      if (minor.includes(subclass)) flags |= FLAG.minorRail;
      return { layer: 'railways', cls: subclass, rank: ROAD_RANK.rail, flags };
    }
    default:
      return null;
  }
}

export function classifyPolygon(layer: string, props: Props): FillClass | null {
  const cls = STR(props.class);
  const subclass = STR(props.subclass);
  let flags = 0;
  if (props.brunnel === 'tunnel') flags |= FLAG.tunnel;
  if (props.intermittent === 1 || props.intermittent === true) flags |= FLAG.intermittent;

  switch (layer) {
    case 'building':
      return { layer: 'buildings', cls: 'building', flags };
    case 'water':
      if (flags & FLAG.tunnel) return null; // culverted: not visible water
      if (cls === 'swimming_pool') return { layer: 'water', cls: 'pool', flags: flags | FLAG.pool };
      return { layer: 'water', cls: cls || 'water', flags };
    case 'landcover':
      switch (cls) {
        case 'wood':
        case 'grass':
          return { layer: 'greens', cls: subclass || cls, flags };
        case 'wetland':
          return { layer: 'greens', cls: subclass || cls, flags: flags | FLAG.wetland };
        case 'rock':
          return { layer: 'rocks', cls: subclass || cls, flags };
        case 'sand':
          return { layer: 'sand', cls: subclass || cls, flags };
        default:
          return null; // farmland, ice
      }
    case 'landuse':
      if (cls === 'pitch') return { layer: 'greens', cls, flags: flags | FLAG.pitch };
      if (cls === 'cemetery') return { layer: 'greens', cls, flags: flags | FLAG.cemetery };
      return null;
    case 'aeroway':
      if (['runway', 'taxiway', 'apron', 'helipad'].includes(cls)) return { layer: 'aeroways', cls, flags };
      return null;
    case 'transportation':
      // Surfaces rather than routes. By default they are only cut out of the water.
      if (cls === 'pier') return { layer: 'decks', cls: 'pier', flags };
      if (cls === 'path' && (subclass === 'pedestrian' || subclass === 'footway' || subclass === 'path')) {
        return { layer: 'decks', cls: subclass, flags };
      }
      if (cls === 'bridge') return { layer: 'decks', cls: 'bridge', flags: flags | FLAG.bridgeArea };
      return null;
    default:
      return null;
  }
}

// Runways mapped as lines become fills of a typical width, in metres.
export function aerowayLineWidth(props: Props): number | null {
  const cls = STR(props.class);
  if (cls === 'runway') return 45;
  if (cls === 'taxiway') return 20;
  return null;
}

export interface FeatureFilters {
  skipTunnels: boolean;
  roads: { service: boolean; parkingAisles: boolean; driveways: boolean; tracks: boolean; pedestrian: boolean; busways: boolean };
  paths: { footways: boolean; cycleways: boolean; steps: boolean; bridleways: boolean };
  railways: { minor: boolean; yards: boolean };
  waterways: { streams: boolean; rivers: boolean };
  water: { pools: boolean; intermittent: boolean };
  greens: { wetlands: boolean; pitches: boolean; cemeteries: boolean };
  decks: { bridges: boolean };
}

export function acceptLine(c: LineClass, f: FeatureFilters): boolean {
  if (f.skipTunnels && c.flags & FLAG.tunnel) return false;
  switch (c.layer) {
    case 'roads':
      if (c.cls === 'service') {
        if (!f.roads.service) return false;
        if (c.flags & FLAG.parkingAisle && !f.roads.parkingAisles) return false;
        if (c.flags & FLAG.driveway && !f.roads.driveways) return false;
      }
      if (c.cls === 'track' && !f.roads.tracks) return false;
      if (c.cls === 'pedestrian' && !f.roads.pedestrian) return false;
      if (c.cls === 'busway' && !f.roads.busways) return false;
      return true;
    case 'paths':
      if (c.cls === 'cycleway') return f.paths.cycleways;
      if (c.cls === 'steps') return f.paths.steps;
      if (c.cls === 'bridleway') return f.paths.bridleways;
      return f.paths.footways;
    case 'railways':
      if (c.flags & FLAG.minorRail && !f.railways.minor) return false;
      if (c.flags & FLAG.railYard && !f.railways.yards) return false;
      return true;
    case 'waterways':
      return c.cls === 'river' || c.cls === 'canal' ? f.waterways.rivers : f.waterways.streams;
    case 'raceways':
      return true;
  }
}

export function acceptPolygon(c: FillClass, f: FeatureFilters): boolean {
  if (c.flags & FLAG.pool && !f.water.pools) return false;
  if (c.flags & FLAG.intermittent && c.layer === 'water' && !f.water.intermittent) return false;
  if (c.flags & FLAG.wetland && !f.greens.wetlands) return false;
  if (c.flags & FLAG.pitch && !f.greens.pitches) return false;
  if (c.flags & FLAG.cemetery && !f.greens.cemeteries) return false;
  if (c.flags & FLAG.bridgeArea && !f.decks.bridges) return false;
  return true;
}
