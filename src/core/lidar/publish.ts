// Records as cached and handed to generation: every coordinate in lon/lat,
// heights in metres above the survey's ground. Generation projects them with
// the model's own projection, so a record does not depend on where the area
// is centred or how it is rotated.

import type { Projection } from '../geo/projection';
import type { MultiPolygon } from '../types';
import type { LidarRecord } from './records';

export interface PublishedRecord extends Omit<LidarRecord, 'cap' | 'tiers' | 'infillGeometry' | 'surfaceGeometry' | 'groundAnchor' | 'roofSurfaces'> {
  /** lon, lat, z per vertex; triangles counter-clockwise in plan. */
  cap?: { vertices: number[]; triangles: number[] };
  tiers: { bottomM: number; topM: number; geometry: MultiPolygon }[];
  infillGeometry?: MultiPolygon;
  surfaceGeometry?: MultiPolygon;
  groundAnchor?: [number, number, number];
  roofSurfaces?: { rings: [number, number, number][][]; bottomM: number }[];
}

function shapeToGeo(shape: MultiPolygon, frame: Projection): MultiPolygon {
  return shape.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => frame.localToGeo(x, y))));
}

export function publish(record: LidarRecord, frame: Projection): PublishedRecord {
  const { cap, tiers, infillGeometry, surfaceGeometry, groundAnchor, roofSurfaces, ...rest } = record;
  const out: PublishedRecord = { ...rest, tiers: tiers.map((t) => ({ ...t, geometry: shapeToGeo(t.geometry, frame) })) };
  if (cap) {
    const vertices: number[] = [];
    for (let k = 0; k < cap.vertices.length; k += 3) {
      const [lon, lat] = frame.localToGeo(cap.vertices[k], cap.vertices[k + 1]);
      vertices.push(lon, lat, cap.vertices[k + 2]);
    }
    out.cap = { vertices, triangles: Array.from(cap.triangles) };
  }
  if (infillGeometry) out.infillGeometry = shapeToGeo(infillGeometry, frame);
  if (surfaceGeometry) out.surfaceGeometry = shapeToGeo(surfaceGeometry, frame);
  if (groundAnchor) {
    const [lon, lat] = frame.localToGeo(groundAnchor[0], groundAnchor[1]);
    out.groundAnchor = [lon, lat, groundAnchor[2]];
  }
  if (roofSurfaces) {
    out.roofSurfaces = roofSurfaces.map((s) => ({
      bottomM: s.bottomM,
      rings: s.rings.map((ring) => ring.map(([x, y, z]) => [...frame.localToGeo(x, y), z] as [number, number, number])),
    }));
  }
  return out;
}

/** Highest point of a published record above its ground. */
export function publishedTop(record: PublishedRecord): number {
  let top = record.heightM;
  for (const tier of record.tiers) top = Math.max(top, tier.topM);
  for (const h of Object.values(record.partHeights ?? {})) top = Math.max(top, h);
  if (record.cap) for (let k = 2; k < record.cap.vertices.length; k += 3) top = Math.max(top, record.cap.vertices[k]);
  for (const s of record.roofSurfaces ?? []) for (const ring of s.rings) for (const v of ring) top = Math.max(top, v[2]);
  return top;
}
