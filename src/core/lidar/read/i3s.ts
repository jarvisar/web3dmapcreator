// Esri I3S point cloud scene layers (PCSL), for publishers whose LiDAR is only
// served as an ArcGIS SceneServer layer. Like an EPT, each point is in one
// node and every level holds different points, so the nodes under the area
// are all of it. Each node is three requests: its LEPCC positions, its class
// codes and its return numbers. Node pages hold 64 nodes each.
//
// Coarse nodes are snapped to cells of up to a metre, so points from nodes
// whose max error is over 5 cm are left out. That loses about 1% of them.
// Node positions are in the layer's coordinate system, or for a lon/lat layer
// a box centred on lon, lat, height and turned in earth-centred space.

import { gunzipSync } from 'fflate';
import type { GeoBounds } from '../../types';
import { emptyPoints, type Points } from '../points';
import { crsFromEpsg, lonLatTransforms, type CrsInfo } from './crs';
import { BudgetExceeded, type ReadInfo, type ReadOptions } from './ept';
import { ahead, type Fetcher } from './fetcher';
import { decodeLepccXyz } from './lepcc';
import { classTable, PointSink, queryBounds, surfaceClassTable } from './normalize';

const MAX_NODES = 6000;
const MAX_ERROR_M = 0.05;

interface Obb {
  center: [number, number, number];
  halfSize: [number, number, number];
  quaternion: [number, number, number, number];
}

interface Node {
  resourceId?: number;
  obb: Obb;
  firstChild?: number;
  childCount?: number;
  vertexCount?: number;
  pointCount?: number;
}

interface Layer {
  layerType?: string;
  spatialReference?: { wkid?: number; latestWkid?: number };
  store?: { index?: { nodesPerPage?: number; nodePerIndexBlock?: number }; defaultGeometrySchema?: { encoding?: string } };
  attributeStorageInfo?: { key: string; name: string }[];
  elevationInfo?: { unit?: string };
}

const A = 6378137;
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
const RAD = Math.PI / 180;

function toEcef(lon: number, lat: number, h: number): [number, number, number] {
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat * RAD) ** 2);
  return [(n + h) * Math.cos(lat * RAD) * Math.cos(lon * RAD), (n + h) * Math.cos(lat * RAD) * Math.sin(lon * RAD), (n * (1 - E2) + h) * Math.sin(lat * RAD)];
}

function fromEcef(x: number, y: number, z: number): [number, number] {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 5; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + E2 * n * Math.sin(lat), p);
  }
  return [Math.atan2(y, x) / RAD, lat / RAD];
}

function rotate([x, y, z, w]: Obb['quaternion'], [vx, vy, vz]: [number, number, number]): [number, number, number] {
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** A node's box in the layer's grid, or in lon/lat for a lon/lat layer. */
export function obbBox(obb: Obb, geographic: boolean): [number, number, number, number] {
  const corners: [number, number][] = [];
  const centre = geographic ? toEcef(...obb.center) : null;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const d = rotate(obb.quaternion, [sx * obb.halfSize[0], sy * obb.halfSize[1], sz * obb.halfSize[2]]);
        corners.push(centre ? fromEcef(centre[0] + d[0], centre[1] + d[1], centre[2] + d[2]) : [obb.center[0] + d[0], obb.center[1] + d[1]]);
      }
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A node resource, unzipped. ArcGIS answers some missing resources with a JSON error and HTTP 200. */
async function resource(fetcher: Fetcher, url: string): Promise<Uint8Array> {
  let bytes = new Uint8Array(await fetcher.bytes(url));
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  if (bytes[0] === 0x7b) {
    const text = new TextDecoder().decode(bytes.subarray(0, 300));
    throw new Error(`The scene layer answered ${url} with ${/"message"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? 'an error'}`);
  }
  return bytes;
}

const UNITS: Record<string, number> = { meter: 1, meters: 1, metre: 1, m: 1, foot: 0.3048, feet: 0.3048, 'us-foot': 1200 / 3937, 'us-ft': 1200 / 3937, ft: 0.3048 };

interface Opened {
  layer: Layer;
  crs: CrsInfo;
  toLonLat: (x: number, y: number) => [number, number];
  /** The area in the layer's grid, or lon/lat for a lon/lat layer. */
  query: [number, number, number, number];
}

async function open(fetcher: Fetcher, url: string, bbox: GeoBounds): Promise<Opened> {
  const layer = (await fetcher.json(url)) as Layer;
  if (layer.layerType !== 'PointCloud' || layer.store?.defaultGeometrySchema?.encoding !== 'lepcc-xyz') throw new Error(`${url} is not a LEPCC point cloud scene layer`);
  const wkid = layer.spatialReference?.latestWkid ?? layer.spatialReference?.wkid;
  if (!wkid) throw new Error(`${url} has no coordinate system`);
  const crs = crsFromEpsg(wkid === 102100 ? 3857 : wkid);
  const { toLonLat, fromLonLat } = lonLatTransforms(crs);
  const query = crs.geographic ? ([bbox.west, bbox.south, bbox.east, bbox.north] as [number, number, number, number]) : queryBounds(bbox, fromLonLat);
  return { layer, crs, toLonLat, query };
}

/** Nodes meeting the area, from the root down, stopping below any node `enough` accepts. */
async function nodesUnder(fetcher: Fetcher, url: string, { layer, crs, query }: Opened, enough: (box: [number, number, number, number]) => boolean = () => false): Promise<{ node: Node; box: [number, number, number, number] }[]> {
  const perPage = layer.store?.index?.nodesPerPage ?? layer.store?.index?.nodePerIndexBlock ?? 64;
  const meets = (b: [number, number, number, number]) => b[0] <= query[2] && query[0] <= b[2] && b[1] <= query[3] && query[1] <= b[3];
  const pages = new Map<number, Promise<Node[]>>();
  const node = async (index: number): Promise<Node> => {
    const page = Math.floor(index / perPage);
    if (!pages.has(page)) pages.set(page, fetcher.json(`${url}/nodepages/${page}`).then((p) => (p as { nodes: Node[] }).nodes));
    const found = (await pages.get(page)!)[index - page * perPage];
    if (!found) throw new Error(`${url} has no node ${index}`);
    return found;
  };
  const out: { node: Node; box: [number, number, number, number] }[] = [];
  let level = [0];
  while (level.length) {
    const nodes = await Promise.all(level.map(node));
    level = [];
    for (const n of nodes) {
      const box = obbBox(n.obb, crs.geographic);
      if (!meets(box)) continue;
      out.push({ node: n, box });
      if (!enough(box)) for (let c = 0; c < (n.childCount ?? 0); c++) level.push((n.firstChild ?? 0) + c);
    }
    if (out.length + level.length > MAX_NODES) throw new BudgetExceeded('Scene layer node budget reached');
  }
  return out;
}

/**
 * Where a layer has points under the area, as lon/lat boxes of its nodes of
 * about `cellM` or the leaves above that. Nodes only exist where there are
 * points, so a coastal survey's outline follows the coast.
 */
export async function sceneOutline(fetcher: Fetcher, url: string, bbox: GeoBounds, cellM = 250): Promise<[number, number, number, number][]> {
  const opened = await open(fetcher, url, bbox);
  const metres = (box: [number, number, number, number]) => {
    const [w, s] = opened.crs.geographic ? [box[0], box[1]] : opened.toLonLat(box[0], box[1]);
    const [e, n] = opened.crs.geographic ? [box[2], box[3]] : opened.toLonLat(box[2], box[3]);
    return Math.max((e - w) * 111320 * Math.cos(((s + n) / 2) * RAD), (n - s) * 110574);
  };
  const found = await nodesUnder(fetcher, url, opened, (box) => metres(box) <= cellM);
  return found
    .filter(({ node, box }) => metres(box) <= cellM || !node.childCount)
    .map(({ box }) => {
      if (opened.crs.geographic) return box;
      const corners = [opened.toLonLat(box[0], box[1]), opened.toLonLat(box[2], box[1]), opened.toLonLat(box[0], box[3]), opened.toLonLat(box[2], box[3])];
      return [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    });
}

export async function readI3s(fetcher: Fetcher, url: string, bbox: GeoBounds, options: ReadOptions): Promise<{ points: Points; info: ReadInfo }> {
  const opened = await open(fetcher, url, bbox);
  const { layer, crs, toLonLat, query } = opened;
  const zFactor = UNITS[(layer.elevationInfo?.unit ?? options.verticalUnits ?? 'm').toLowerCase()] ?? 1;
  const attribute = (name: string) => layer.attributeStorageInfo?.find((a) => a.name === name)?.key;
  const classKey = attribute('CLASS_CODE');
  if (!classKey) throw new Error(`${url} has no class codes`);
  const returnsKey = attribute('RETURNS');
  const wanted = (await nodesUnder(fetcher, url, opened)).map((n) => n.node).filter((n) => (n.vertexCount ?? n.pointCount ?? 1) > 0);

  const classes = options.surface ? surfaceClassTable(options.classification, options.surfaceCodes) : classTable(options.classification);
  const sink = options.sink ?? new PointSink();
  const maxPoints = options.maxPoints ?? 8e6;
  const { west, south, east, north } = bbox;
  let read = 0;
  for await (const [geometry, codes, returns] of ahead(wanted, 12, (n) => {
    const id = n.resourceId ?? 0;
    return Promise.all([resource(fetcher, `${url}/nodes/${id}/geometries/0`), resource(fetcher, `${url}/nodes/${id}/attributes/${classKey}`), returnsKey ? resource(fetcher, `${url}/nodes/${id}/attributes/${returnsKey}`) : null]);
  })) {
    read++;
    await options.progress?.(`Decoding scene layer node ${read} of ${wanted.length}; ${sink.count.toLocaleString('en-US')} points kept`);
    const decoded = decodeLepccXyz(geometry);
    if (decoded.maxError[2] * zFactor > MAX_ERROR_M) continue;
    if (codes.length !== decoded.count || (returns && returns.length !== decoded.count)) throw new Error(`A node of ${url} has attributes that don't match its points`);
    const { xyz } = decoded;
    for (let i = 0; i < decoded.count; i++) {
      const x = xyz[3 * i];
      const y = xyz[3 * i + 1];
      if (x < query[0] || x > query[2] || y < query[1] || y > query[3]) continue;
      const cls = classes[codes[i]];
      if (!cls) continue;
      const [lon, lat] = toLonLat(x, y);
      if (!(lon >= west && lon <= east && lat >= south && lat <= north)) continue;
      const [lx, ly] = options.frame.toLocal(lon, lat);
      // Returns hold the number of returns in the high nibble.
      sink.push(lx, ly, xyz[3 * i + 2] * zFactor, cls, returns && returns[i] >> 4 === 1 ? 1 : 0, 0, 0);
    }
    if (sink.count > maxPoints) throw new BudgetExceeded('Cropped LiDAR point budget reached');
  }
  const points = sink instanceof PointSink ? sink.finish() : emptyPoints();
  return { points, info: { url, nodes: wanted.length, points: sink.count, horizontalCrs: crs.key, zToMetres: zFactor } };
}
