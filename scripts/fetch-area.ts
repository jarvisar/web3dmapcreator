// Downloads the Overture layers and the elevation for a bounding box with the
// same code the browser runs, and prints what came back.
//
//   npx tsx scripts/fetch-area.ts --bbox w,s,e,n [--types building,segment] [--out out/area.json]
//
// --release <name>   Overture release, default the latest
// --spacing <m>      elevation spacing, default the longer side / 192
// --no-dem           skip the elevation
// --cache <dir>      keep downloads in a folder so later runs skip the network
//
// --out writes the features as JSON, and the elevation mosaic next to it as
// raw little-endian float32 (<name>.dem.f32, header in the JSON).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ByteCache } from '../src/core/data/cache';
import { fetchDem, type DemMosaic } from '../src/core/data/dem';
import { OVERTURE_TYPES, type OvertureType } from '../src/core/data/features';
import { setByteCache } from '../src/core/data/http';
import { fetchOverture } from '../src/core/data/overture';
import type { GeoBounds } from '../src/core/types';

const EARTH_RADIUS_M = 6_371_008.8;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function fileCache(dir: string): ByteCache {
  const path = (key: string) => join(dir, createHash('sha256').update(key).digest('hex').slice(0, 40));
  return {
    async get(key) {
      try {
        const data = await readFile(path(key));
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      } catch {
        return undefined;
      }
    },
    async put(key, data) {
      await mkdir(dir, { recursive: true });
      await writeFile(path(key), new Uint8Array(data));
    },
  };
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
const count = (n: number) => n.toLocaleString('en-US');

function status(text: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r${text.padEnd(78).slice(0, 78)}`);
}

function endStatus(): void {
  if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(78)}\r`);
}

// node:util parseArgs refuses values that start with a dash, like western longitudes.
function parseArgs(args: string[]): Record<string, string | true> {
  const flags = new Set(['no-dem']);
  const values: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match) fail(`Unexpected argument ${args[i]}`);
    const [, name, inline] = match;
    if (flags.has(name)) values[name] = true;
    else if (inline !== undefined) values[name] = inline;
    else if (i + 1 < args.length) values[name] = args[++i];
    else fail(`--${name} needs a value`);
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const text = (name: string) => (typeof args[name] === 'string' ? (args[name] as string) : undefined);
  const values = {
    bbox: text('bbox'),
    types: text('types'),
    out: text('out'),
    release: text('release'),
    spacing: text('spacing'),
    cache: text('cache'),
    'no-dem': args['no-dem'] === true,
  };
  const parts = (values.bbox ?? '').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) fail('Usage: npx tsx scripts/fetch-area.ts --bbox west,south,east,north');
  const [west, south, east, north] = parts;
  const bounds: GeoBounds = { west, south, east, north };
  const types = (values.types ? values.types.split(',').map((t) => t.trim()) : OVERTURE_TYPES) as OvertureType[];
  for (const type of types) if (!OVERTURE_TYPES.includes(type)) fail(`Unknown type ${type}. Use ${OVERTURE_TYPES.join(', ')}.`);
  if (values.cache) setByteCache(fileCache(values.cache));

  const lat = ((south + north) / 2) * (Math.PI / 180);
  const widthM = EARTH_RADIUS_M * ((east - west) * Math.PI / 180) * Math.cos(lat);
  const heightM = EARTH_RADIUS_M * ((north - south) * Math.PI / 180);
  const spacing = values.spacing ? Number(values.spacing) : Math.max(widthM, heightM) / 192;

  const started = performance.now();
  let shown = 0;
  const data = await fetchOverture({
    bounds,
    types,
    release: values.release,
    onProgress: (p) => {
      const now = performance.now();
      if (now - shown < 250) return;
      shown = now;
      status(`${mb(p.bytes)} / ${mb(p.bytesTotal)} MB  ${count(p.features)} features  ${p.message}`);
    },
  });
  const overtureSeconds = (performance.now() - started) / 1000;
  endStatus();

  let dem: DemMosaic | undefined;
  let demSeconds = 0;
  let demBytes = 0;
  if (!values['no-dem']) {
    const demStarted = performance.now();
    dem = await fetchDem({
      bounds,
      targetSpacingM: spacing,
      onProgress: (p) => {
        demBytes = p.bytes;
        status(`${mb(p.bytes)} MB  ${p.message}`);
      },
    });
    demSeconds = (performance.now() - demStarted) / 1000;
    endStatus();
  }

  console.log(`Overture release ${data.release}, bbox ${[west, south, east, north].join(',')}`);
  console.log(
    'type'.padEnd(16) + 'features'.padStart(10) + 'files'.padStart(7) + 'groups'.padStart(8) + 'rows kept'.padStart(12) +
      'rows read'.padStart(12) + 'MB'.padStart(8) + 'cached'.padStart(8) + 'seconds'.padStart(9),
  );
  for (const type of types) {
    const s = data.stats[type];
    const cached = s.bytes > 0 ? `${Math.round((100 * s.cachedBytes) / s.bytes)}%` : '-';
    console.log(
      type.padEnd(16) + count(s.features).padStart(10) + String(s.files).padStart(7) + String(s.rowGroups).padStart(8) +
        count(s.rowsKept).padStart(12) + count(s.rowsRead).padStart(12) + mb(s.bytes).padStart(8) + cached.padStart(8) +
        s.seconds.toFixed(1).padStart(9) + (s.skipped ? `  (${s.skipped} unreadable)` : ''),
    );
  }
  const total = types.reduce((sum, type) => sum + data.stats[type].features, 0);
  console.log(
    'total'.padEnd(16) + count(total).padStart(10) + ' '.repeat(39) + mb(data.bytes).padStart(8) + ' '.repeat(8) +
      overtureSeconds.toFixed(1).padStart(9),
  );
  if (dem) {
    console.log(
      `Elevation: zoom ${dem.zoom}, ${dem.tilesUsed} tiles (${dem.tilesMissing} missing), ` +
        `${dem.groundResolutionM.toFixed(1)} m pixels for ${spacing.toFixed(1)} m spacing, ` +
        `${dem.min.toFixed(1)} to ${dem.max.toFixed(1)} m, ${mb(demBytes)} MB, ${demSeconds.toFixed(1)} s`,
    );
  }

  if (values.out) {
    const out = values.out;
    await mkdir(dirname(out), { recursive: true });
    const demFile = out.replace(/\.json$/i, '') + '.dem.f32';
    const header = dem && {
      zoom: dem.zoom,
      tileX0: dem.tileX0,
      tileY0: dem.tileY0,
      columns: dem.columns,
      rows: dem.rows,
      groundResolutionM: dem.groundResolutionM,
      tilesUsed: dem.tilesUsed,
      tilesMissing: dem.tilesMissing,
      min: dem.min,
      max: dem.max,
      file: basename(demFile),
    };
    const json = JSON.stringify({ ...data, dem: header ?? null });
    await writeFile(out, json);
    if (dem) await writeFile(demFile, new Uint8Array(dem.values.buffer, dem.values.byteOffset, dem.values.byteLength));
    console.log(`Wrote ${out} (${mb(json.length)} MB)${dem ? ` and ${demFile}` : ''}`);
  }
}

main().catch((error: unknown) => {
  endStatus();
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
