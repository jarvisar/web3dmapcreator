// Times the pipeline on a synthetic grid city, without the network.
//   npx tsx scripts/bench-synthetic.ts [size-km]

import { edgeReport } from '../src/core/geometry/validate';
import { Progress } from '../src/core/pipeline/context';
import { generateModel } from '../src/core/pipeline/generate';
import { meshLayers } from '../src/core/pipeline/mesh';
import type { SourceData, SourceFeature } from '../src/core/pipeline/source';
import { cloneSettings, type AreaSpec } from '../src/core/settings';

const sizeKm = Number(process.argv[2] ?? 3);
const LAT = 41.88;
const LON = -87.63;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): [number, number] => [LON + x * M_LON, LAT + y * M_LAT];
const rect = (x0: number, y0: number, x1: number, y1: number) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];

let id = 0;
const f = (geometry: SourceFeature['geometry'], props: Record<string, unknown>): SourceFeature => ({ id: `s${id++}`, geometry, props });

const half = (sizeKm * 1000) / 2;
const block = 100;
const segment: SourceFeature[] = [];
const building: SourceFeature[] = [];
const landUse: SourceFeature[] = [];
for (let v = -half; v <= half; v += block) {
  const cls = Math.abs(v) % 500 === 0 ? 'primary' : 'residential';
  segment.push(f({ type: 'LineString', coordinates: [at(v, -half), at(v, half)] }, { subtype: 'road', class: cls }));
  segment.push(f({ type: 'LineString', coordinates: [at(-half, v), at(half, v)] }, { subtype: 'road', class: cls }));
}
for (let x = -half; x < half; x += block) {
  for (let y = -half; y < half; y += block) {
    if (Math.abs(y) < 150) continue; // river corridor
    if ((Math.floor(x / block) + Math.floor(y / block)) % 7 === 0) {
      landUse.push(f({ type: 'Polygon', coordinates: rect(x + 8, y + 8, x + block - 8, y + block - 8) }, { subtype: 'park', class: 'park' }));
      continue;
    }
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const x0 = x + 12 + i * 20;
        const y0 = y + 12 + j * 20;
        building.push(f({ type: 'Polygon', coordinates: rect(x0, y0, x0 + 16, y0 + 16) }, { height: 8 + ((i * 7 + j * 13 + x) % 60) }));
      }
    }
  }
}
const data: SourceData = {
  release: 'synthetic',
  features: {
    segment,
    building,
    land_use: landUse,
    water: [f({ type: 'Polygon', coordinates: rect(-half - 50, -120, half + 50, 60) }, { subtype: 'river', class: 'river' })],
  },
};
const area: AreaSpec = { center: [LON, LAT], widthM: sizeKm * 1000, heightM: sizeKm * 1000, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const hills = { sample: (lon: number, lat: number) => 180 + 15 * Math.sin((lon - LON) / M_LON / 400) + 8 * Math.cos((lat - LAT) / M_LAT / 300) };

const settings = cloneSettings();
const t0 = performance.now();
let last = t0;
const progress = new Progress((e) => {
  const now = performance.now();
  if (e.label) process.stdout.write(`\r${((now - t0) / 1000).toFixed(1)}s ${e.label.padEnd(40)}`);
  last = now;
});
const spec = await generateModel({ area, settings, data, elevation: hills, progress });
const t1 = performance.now();
const meshed = await meshLayers(spec.layers, { zShift: -spec.baseZ });
const t2 = performance.now();
void last;
console.log(`\n${building.length} buildings, ${segment.length} roads`);
console.log(`generate ${((t1 - t0) / 1000).toFixed(2)} s, mesh ${((t2 - t1) / 1000).toFixed(2)} s`);
let total = 0;
for (const part of meshed.parts) {
  const tris = part.indices.length / 3;
  total += tris;
  const r = edgeReport(part.indices, part.positions.length / 3);
  console.log(`  ${part.name.padEnd(14)} ${String(tris).padStart(9)} tris  open ${r.open}`);
}
console.log(`  total ${total} triangles, failed ${meshed.failed}, fallbacks ${meshed.fallbacks}`);
