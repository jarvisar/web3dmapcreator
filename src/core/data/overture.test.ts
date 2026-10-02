import { readFileSync } from 'node:fs';
import { parquetMetadata, parquetSchema, type FileMetaData } from 'hyparquet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, type ByteCache } from './cache';
import type { OvertureProgress } from './overture';
import {
  AreaTooLargeError,
  checkTypes,
  configurePageReading,
  estimateShare,
  fetchOverture,
  getLatestIndex,
  getReleaseIndex,
  latestFromCatalog,
  latestFromListing,
  OvertureUnavailableError,
  parseIndexRows,
  planRead,
  plainMap,
  plainValue,
  pruneStruct,
  selectRowGroups,
} from './overture';
import { configureHttp, setByteCache } from './http';
import { walkPages } from './parquet';
import { mockServer, type MockServer } from './testdata/serve';

// The fixtures come from testdata/make_fixtures.py. The test area is lon 0..1, lat 0..1.
const AREA = { west: 0, south: 0, east: 1, north: 1 };
const S3 = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/test';
const FILES = {
  buildingA: `${S3}/theme=buildings/type=building/building-a.parquet`,
  buildingB: `${S3}/theme=buildings/type=building/building-b.parquet`,
  water: `${S3}/theme=base/type=water/water.parquet`,
  segment: `${S3}/theme=transportation/type=segment/segment.parquet`,
};

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./testdata/${name}`, import.meta.url)));
}

function metadataOf(bytes: Uint8Array): FileMetaData {
  return parquetMetadata(bytes.slice().buffer);
}

// Byte ranges of every geometry chunk in a fixture file.
function geometryRanges(bytes: Uint8Array): [number, number][] {
  return metadataOf(bytes).row_groups.map((group) => {
    const meta = group.columns.find((c) => c.meta_data?.path_in_schema[0] === 'geometry')!.meta_data!;
    const start = Number(meta.dictionary_page_offset || meta.data_page_offset);
    return [start, start + Number(meta.total_compressed_size)];
  });
}

function server(): MockServer {
  return mockServer({
    'https://stac.overturemaps.org/catalog.json': JSON.stringify({ latest: 'test' }),
    'https://stac.overturemaps.org/test/collections.parquet': fixture('index.parquet'),
    [FILES.buildingA]: fixture('building-a.parquet'),
    [FILES.buildingB]: fixture('building-b.parquet'),
    [FILES.water]: fixture('water.parquet'),
    [FILES.segment]: fixture('segment.parquet'),
  });
}

beforeEach(async () => {
  configureHttp({ maxInFlight: 6, retries: 3, retryDelayMs: 1 });
  configurePageReading({ minChunkBytes: 256e3, maxEstimatedShare: 0.75, maxPagedShare: 0.85 });
  setByteCache(null);
  // Forgets the memoized release and index, so every test starts cold.
  await clearCache();
});

// The fixture chunks are tiny, so page reading has to be forced for them.
const ALWAYS_BY_PAGE = { minChunkBytes: 0, maxEstimatedShare: 1, maxPagedShare: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('selectRowGroups', () => {
  const chunk = (path: string, size: number, min?: number, max?: number) => ({
    file_offset: 0n,
    meta_data: {
      path_in_schema: path.split('.'),
      total_compressed_size: BigInt(size),
      statistics: min === undefined ? undefined : { min_value: min, max_value: max },
    },
  });
  const group = (rows: number, box?: [number, number, number, number]) => ({
    num_rows: BigInt(rows),
    columns: [
      chunk('id', 100),
      chunk('geometry', 1000),
      chunk('bbox.xmin', 10, box?.[0], box?.[0]),
      chunk('bbox.xmax', 10, box?.[2], box?.[2]),
      chunk('bbox.ymin', 10, box?.[1], box?.[1]),
      chunk('bbox.ymax', 10, box?.[3], box?.[3]),
      chunk('sources.list.element.dataset', 5000),
    ],
  });
  const metadata = {
    row_groups: [
      group(10, [-5, -5, -4, -4]),
      group(20, [0.5, 0.5, 2, 2]),
      group(30),
      group(0, [0, 0, 1, 1]),
      group(40, [1, 0, 2, 1]),
      group(50, [0.9, -3, 3, 0.1]),
    ],
  } as unknown as FileMetaData;

  it('keeps row groups whose statistics meet the bounds, and those without statistics', () => {
    const spans = selectRowGroups(metadata, AREA, ['id', 'geometry', 'bbox']);
    expect(spans.map((s) => s.index)).toEqual([1, 2, 5]);
    expect(spans[0]).toEqual({ index: 1, rowStart: 10, rowEnd: 30, bytes: 1140 });
    expect(spans[1]).toMatchObject({ rowStart: 30, rowEnd: 60 });
    expect(spans[2]).toMatchObject({ rowStart: 100, rowEnd: 150 });
    // Every column counts when none are named.
    expect(selectRowGroups(metadata, AREA)[0].bytes).toBe(6140);
  });
});

describe('estimateShare', () => {
  it('counts the parts of a chunk that hold wanted rows', () => {
    // 2 MB in 4 parts of 250 rows.
    expect(estimateShare([0, 10, 20], 1000, 2e6)).toBe(0.25);
    expect(estimateShare([0, 300, 600, 999], 1000, 2e6)).toBe(1);
    // Small chunks still count as two parts.
    expect(estimateShare([999], 1000, 100e3)).toBe(0.5);
  });
});

describe('pruneStruct and planRead', () => {
  const building = metadataOf(fixture('building-a.parquet'));

  it('leaves only the kept children of a struct', () => {
    const pruned = pruneStruct(building, 'names', ['primary']);
    const names = parquetSchema(pruned).children.find((c) => c.element.name === 'names');
    expect(names?.children.map((c) => c.element.name)).toEqual(['primary']);
    const leaves = pruned.row_groups[0].columns.map((c) => c.meta_data?.path_in_schema.join('.'));
    expect(leaves.filter((p) => p?.startsWith('names'))).toEqual(['names.primary']);
    expect(pruned.row_groups[0].columns.length).toBe(building.row_groups[0].columns.length - 4);
    // Everything else is untouched.
    expect(parquetSchema(pruned).children.map((c) => c.element.name)).toEqual(parquetSchema(building).children.map((c) => c.element.name));
    expect(building.schema.find((e) => e.name === 'names')?.num_children).toBe(3);
  });

  it('reads the wanted columns a file has, and nothing else', () => {
    const plan = planRead(building, 'building', AREA);
    expect(plan.columns).toEqual([
      'id', 'geometry', 'bbox', 'height', 'min_height', 'num_floors', 'min_floor', 'roof_shape', 'roof_height',
      'roof_direction', 'class', 'subtype', 'is_underground', 'has_parts', 'level', 'facade_color', 'names',
    ]);
    expect(plan.groups.map((g) => g.index)).toEqual([1, 2, 3]);
    expect(plan.bytes).toBe(plan.groups.reduce((sum, g) => sum + g.bytes, 0));
    expect(plan.mapColumns.size).toBe(0);

    const water = planRead(metadataOf(fixture('water.parquet')), 'water', AREA);
    expect([...water.mapColumns]).toEqual(['source_tags']);
    // Only the primary name, for the editor.
    expect(water.columns).toContain('names');
  });

  it('prunes a struct inside a list', () => {
    const sources = parquetSchema(building).children.find((c) => c.element.name === 'sources')!;
    const path = ['sources', sources.children[0].element.name, sources.children[0].children[0].element.name];
    const pruned = pruneStruct(building, path, ['dataset']);
    const leaves = (m: FileMetaData) => m.row_groups[0].columns.map((c) => c.meta_data?.path_in_schema.join('.'));
    expect(leaves(pruned).filter((p) => p?.startsWith('sources'))).toEqual([`${path.join('.')}.dataset`]);
    expect(leaves(building).filter((p) => p?.startsWith('sources'))).toHaveLength(2);
    const element = parquetSchema(pruned).children.find((c) => c.element.name === 'sources')!.children[0].children[0];
    expect(element.children.map((c) => c.element.name)).toEqual(['dataset']);
    // Leaves outside the struct are untouched.
    expect(leaves(pruned).filter((p) => !p?.startsWith('sources'))).toEqual(leaves(building).filter((p) => !p?.startsWith('sources')));
  });

  it('reads the columns asked for in place of the usual ones', () => {
    const plan = planRead(building, 'building', AREA, ['sources', 'is_underground', 'not_a_column']);
    expect(plan.columns).toEqual(['id', 'geometry', 'bbox', 'sources', 'is_underground']);
    // record_id is pruned away, dataset kept.
    const leaves = plan.metadata.row_groups[0].columns.map((c) => c.meta_data!.path_in_schema);
    expect(leaves.filter((p) => p[0] === 'sources').map((p) => p[p.length - 1])).toEqual(['dataset']);
    expect(plan.bytes).toBeLessThan(planRead(building, 'building', AREA).bytes);
  });

  it('refuses a file without geometry', () => {
    const metadata = { ...building, schema: building.schema.map((e) => (e.name === 'geometry' ? { ...e, name: 'shape' } : e)) };
    expect(() => planRead(metadata, 'building', AREA)).toThrow(/no geometry column/);
  });
});

describe('value conversion', () => {
  it('turns BigInt into numbers at any depth', () => {
    expect(plainValue(5n)).toBe(5);
    expect(plainValue([{ value: 3n, between: [0, 1] }])).toEqual([{ value: 3, between: [0, 1] }]);
    expect(plainValue(new BigInt64Array([1n, 2n]))).toEqual([1, 2]);
    const untouched = { a: [1, 'x', null] };
    expect(plainValue(untouched)).toBe(untouched);
  });

  it('turns every MAP shape into a plain object', () => {
    expect(plainMap({ natural: 'water' })).toEqual({ natural: 'water' });
    expect(plainMap([{ key: 'water', value: 'pond' }, { key: 'n', value: 2n }])).toEqual({ water: 'pond', n: 2 });
    expect(plainMap([['amenity', 'fountain']])).toEqual({ amenity: 'fountain' });
    expect(plainMap({ key_value: [{ key: 'a', value: 'b' }] })).toEqual({ a: 'b' });
    expect(plainMap(null)).toBeUndefined();
  });
});

describe('the release index', () => {
  it('finds the latest release', () => {
    expect(latestFromCatalog({ latest: '2026-09-23.1' })).toBe('2026-09-23.1');
    const links = [
      { rel: 'child', href: 'https://stac.overturemaps.org/2026-08-19.0/catalog.json' },
      { rel: 'child', href: 'https://stac.overturemaps.org/2026-09-23.10/catalog.json' },
      { rel: 'child', href: 'https://stac.overturemaps.org/2026-09-23.9/catalog.json' },
      { rel: 'self', href: 'https://stac.overturemaps.org/catalog.json' },
    ];
    expect(latestFromCatalog({ links })).toBe('2026-09-23.10');
    expect(latestFromCatalog({ links: [...links, { ...links[0], latest: true }] })).toBe('2026-08-19.0');
    expect(() => latestFromCatalog({})).toThrow();
  });

  it('reads S3 files and their boxes, ignoring Azure', () => {
    const files = parseIndexRows([
      {
        assets: {
          aws: { href: 'https://bucket.s3.us-west-2.amazonaws.com/release/r/theme=base/type=water/b.parquet', 'file:size': 123n },
          azure: { href: 'https://example.blob.core.windows.net/release/r/theme=base/type=water/b.parquet' },
        },
        bbox: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 },
        num_rows: 10n,
        num_row_groups: 2n,
      },
      {
        assets: { aws: { alternate: { s3: { href: 's3://overturemaps-us-west-2/release/r/theme=buildings/type=building/a.parquet' } } } },
        bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
      { assets: { azure: { href: 'https://example.blob.core.windows.net/release/r/theme=base/type=land/c.parquet' } }, bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } },
      { assets: { aws: { href: 'https://bucket.s3.amazonaws.com/theme=base/type=land/d.parquet' } } },
    ]);
    expect(files).toEqual([
      {
        theme: 'base', type: 'water', href: 'https://bucket.s3.us-west-2.amazonaws.com/release/r/theme=base/type=water/b.parquet',
        size: 123, bbox: [1, 2, 3, 4], rows: 10, rowGroups: 2,
      },
      {
        theme: 'buildings', type: 'building',
        href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/r/theme=buildings/type=building/a.parquet',
        size: 0, bbox: [0, 0, 1, 1], rows: 0, rowGroups: 0,
      },
    ]);
  });
});

describe('finding the latest release', () => {
  const CATALOG = 'https://stac.overturemaps.org/catalog.json';
  const LISTING = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/';
  const LISTING_XML =
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    '<Name>overturemaps-us-west-2</Name><Prefix>release/</Prefix><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated>' +
    '<CommonPrefixes><Prefix>release/2026-08-19.0/</Prefix></CommonPrefixes>' +
    '<CommonPrefixes><Prefix>release/2026-09-23.1/</Prefix></CommonPrefixes>' +
    '<CommonPrefixes><Prefix>release/2026-09-23.0/</Prefix></CommonPrefixes></ListBucketResult>';
  const SAVED = 'overture-latest-release';
  const BUSY = "Overture's servers are busy. Try again in a few minutes.";
  const indexUrl = (release: string) => `https://stac.overturemaps.org/${release}/collections.parquet`;
  let store: Map<string, ArrayBuffer>;

  const save = (release: string, age: number) =>
    store.set(SAVED, new TextEncoder().encode(JSON.stringify({ release, time: Date.now() - age })).buffer);
  const saved = () => {
    const bytes = store.get(SAVED);
    return bytes && (JSON.parse(new TextDecoder().decode(bytes)) as { release: string; time: number });
  };

  beforeEach(async () => {
    await clearCache();
    store = new Map();
    setByteCache({ get: async (key) => store.get(key), put: async (key, value) => void store.set(key, value) });
  });

  it('picks the newest release in the S3 listing', () => {
    expect(latestFromListing(LISTING_XML)).toBe('2026-09-23.1');
    const more = LISTING_XML.replace(
      '</ListBucketResult>',
      '<CommonPrefixes><Prefix>release/2026-09-23.10/</Prefix></CommonPrefixes>' +
        '<CommonPrefixes><Prefix>release/old-test/</Prefix></CommonPrefixes></ListBucketResult>',
    );
    expect(latestFromListing(more)).toBe('2026-09-23.10');
    expect(() => latestFromListing('<ListBucketResult><Prefix>release/</Prefix></ListBucketResult>')).toThrow();
  });

  it('saves the catalog answer once its index is read', async () => {
    const mock = mockServer({ [CATALOG]: JSON.stringify({ latest: '2026-09-23.1' }), [indexUrl('2026-09-23.1')]: fixture('index.parquet') });
    vi.stubGlobal('fetch', mock.fetch);
    const index = await getLatestIndex();
    expect(index.release).toBe('2026-09-23.1');
    expect(index.files.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved()).toMatchObject({ release: '2026-09-23.1' });
  });

  it('falls back to the S3 listing when the catalog is rate limited, without saving its answer', async () => {
    const mock = mockServer({
      [CATALOG]: JSON.stringify({ latest: '2026-01-01.0' }),
      [LISTING]: LISTING_XML,
      [indexUrl('2026-09-23.1')]: fixture('index.parquet'),
    });
    mock.failNext((url) => url === CATALOG, 429, 10);
    vi.stubGlobal('fetch', mock.fetch);
    expect((await getLatestIndex()).release).toBe('2026-09-23.1');
    expect(mock.requests.filter((r) => r.url === CATALOG)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved()).toBeUndefined();
  });

  it('uses a saved release for six hours without asking', async () => {
    save('2026-08-19.0', 60 * 60 * 1000);
    const mock = mockServer({ [indexUrl('2026-08-19.0')]: fixture('index.parquet') });
    vi.stubGlobal('fetch', mock.fetch);
    expect((await getLatestIndex()).release).toBe('2026-08-19.0');
    expect(mock.requests.map((r) => r.url)).toEqual([indexUrl('2026-08-19.0')]);
  });

  it('uses a stale saved release when nothing answers', async () => {
    save('2026-08-19.0', 7 * 60 * 60 * 1000);
    // Its index was cached when it was saved.
    store.set(indexUrl('2026-08-19.0'), fixture('index.parquet').slice().buffer);
    const mock = mockServer({});
    mock.failNext(() => true, 503, 100);
    vi.stubGlobal('fetch', mock.fetch);
    expect((await getLatestIndex()).release).toBe('2026-08-19.0');
    expect(mock.requests.some((r) => r.url === LISTING)).toBe(true);
  });

  it('falls back to the saved release while the new release has no index', async () => {
    save('2026-08-19.0', 7 * 60 * 60 * 1000);
    const mock = mockServer({ [CATALOG]: JSON.stringify({ latest: '2026-09-23.1' }), [indexUrl('2026-08-19.0')]: fixture('index.parquet') });
    vi.stubGlobal('fetch', mock.fetch);
    expect((await getLatestIndex()).release).toBe('2026-08-19.0');
    expect(mock.requests.some((r) => r.url === indexUrl('2026-09-23.1'))).toBe(true);
    // Left as it was, so the next session asks again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved()?.time).toBeLessThan(Date.now() - 6 * 60 * 60 * 1000);
  });

  it('says so when a release has no index and nothing is saved', async () => {
    vi.stubGlobal('fetch', mockServer({ [CATALOG]: JSON.stringify({ latest: '2026-09-23.1' }) }).fetch);
    await expect(getLatestIndex()).rejects.toThrow(
      'Could not find the file index for Overture release 2026-09-23.1. The release may not be published yet, or may be too old.',
    );
  });

  it('says the servers are busy when nothing answers and nothing is saved', async () => {
    const mock = mockServer({});
    mock.failNext((url) => url === CATALOG, 429, 100);
    mock.failNext((url) => url === LISTING, 503, 100);
    vi.stubGlobal('fetch', mock.fetch);
    const error = await getLatestIndex().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OvertureUnavailableError);
    expect((error as Error).message).toBe(BUSY);

    // Being offline is told apart from busy servers.
    await clearCache();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(getLatestIndex()).rejects.toThrow("Could not reach Overture's servers. Check the internet connection and try again.");
  });

  it('gives the same message when the index is rate limited, and keeps the index once read', async () => {
    const mock = server();
    mock.failNext(() => true, 429, 100);
    vi.stubGlobal('fetch', mock.fetch);
    await expect(getReleaseIndex('test')).rejects.toThrow(BUSY);

    await clearCache();
    vi.stubGlobal('fetch', server().fetch);
    await getReleaseIndex('test');
    expect(store.has('https://stac.overturemaps.org/test/collections.parquet')).toBe(true);
  });
});

describe('fetchOverture (offline)', () => {
  it('reads the features that meet the area', async () => {
    const mock = server();
    vi.stubGlobal('fetch', mock.fetch);
    const progress: OvertureProgress[] = [];
    const data = await fetchOverture({ bounds: AREA, types: ['water', 'building', 'segment'], onProgress: (p) => progress.push(p) });

    expect(data.release).toBe('test');
    expect(data.warnings).toEqual([]);
    expect(Object.keys(data.features).sort()).toEqual(
      ['building', 'building_part', 'infrastructure', 'land', 'land_cover', 'land_use', 'segment', 'water'],
    );
    const buildings = data.features.building;
    expect(buildings.map((f) => f.id)).toEqual(['inside', 'straddle', 'tower', 'dup', 'multi', 'second']);
    expect(buildings.every((f) => f.type === 'building')).toBe(true);

    const inside = buildings[0];
    expect(inside.geometry).toEqual({ type: 'Polygon', coordinates: [[[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.3], [0.2, 0.2]]] });
    expect(inside.bbox).toEqual([0.2, 0.2, 0.3, 0.3]);
    expect(inside.props).toEqual({ height: 12 });
    expect(buildings[2].props).toEqual({
      height: 120.5, min_floor: 2, roof_shape: 'flat', has_parts: true, subtype: 'commercial', class: 'office',
      names: { primary: 'Tower' },
    });
    // The first copy of a duplicated id wins.
    expect(buildings[3].props.height).toBe(30);
    expect(buildings[4].geometry.type).toBe('MultiPolygon');
    expect(buildings[5].props).toEqual({ is_underground: false, level: 1 });

    const [pond, stream] = data.features.water;
    expect(data.features.water).toHaveLength(2);
    expect(pond.props).toEqual({ subtype: 'water', class: 'pond', level: 0, is_salt: false, source_tags: { natural: 'water', water: 'pond' } });
    expect(pond.geometry.type === 'Polygon' && pond.geometry.coordinates.length).toBe(2);
    expect(stream.geometry).toEqual({ type: 'LineString', coordinates: [[0.5, 0.5], [0.8, 0.9]] });

    const [bridge, rail] = data.features.segment;
    expect(bridge.props).toMatchObject({
      subtype: 'road', class: 'primary', road_flags: [{ values: ['is_bridge'], between: [0.2, 0.8] }],
      level_rules: [{ value: 1, between: [0.2, 0.8] }], width_rules: [{ value: 12.5 }],
    });
    expect(rail.props.rail_flags).toEqual([{ values: ['is_tunnel'] }]);

    const stats = data.stats.building;
    expect(stats).toMatchObject({ files: 2, rowGroups: 4, rowsRead: 11, rowsKept: 9, features: 6, skipped: 2, cachedBytes: 0 });
    expect(data.stats.land.files).toBe(0);
    expect(data.bytes).toBe(stats.bytes + data.stats.water.bytes + data.stats.segment.bytes);

    // The far file and the first row group of building-a are never read. The
    // footer request takes in the whole of this small file, so only the
    // data requests after it count.
    expect(mock.requests.some((r) => r.url.includes('building-far'))).toBe(false);
    const fileA = fixture('building-a.parquet');
    const groupZero = metadataOf(fileA).row_groups[0].columns.map((c) => {
      const start = Number(c.meta_data!.dictionary_page_offset ?? c.meta_data!.data_page_offset);
      return [start, start + Number(c.meta_data!.total_compressed_size)];
    });
    const dataRequests = mock.requests.filter((r) => r.url === FILES.buildingA && r.range && r.range[1] < fileA.length);
    expect(dataRequests.length).toBeGreaterThan(0);
    for (const request of dataRequests) {
      for (const [start, end] of groupZero) expect(request.range![0] >= end || request.range![1] <= start).toBe(true);
    }

    const last = progress.at(-1)!;
    expect(last).toMatchObject({ message: 'Downloaded 10 features', bytes: data.bytes, bytesTotal: data.bytes, features: 10 });
    expect(progress.some((p) => p.message === 'Reading buildings' && p.type === 'building')).toBe(true);
    expect(progress.some((p) => p.message === 'Downloading buildings' && p.type === 'building')).toBe(true);
    for (let i = 1; i < progress.length; i++) expect(progress[i].bytes).toBeGreaterThanOrEqual(progress[i - 1].bytes);
    // The estimate grows twice, but the fraction never goes back.
    for (let i = 1; i < progress.length; i++) expect(progress[i].fraction).toBeGreaterThanOrEqual(progress[i - 1].fraction);
    expect(last.fraction).toBe(1);
    // The footers only take the first part of the bar.
    expect(progress.find((p) => p.message.startsWith('Reading'))!.fraction).toBeLessThanOrEqual(0.15 + 1e-9);
    const downloading = progress.find((p) => p.message === 'Downloading buildings')!;
    expect(downloading.rows).toMatchObject({ water: expect.any(Number), building: expect.any(Number), segment: expect.any(Number) });
  });

  it('returns nothing for a type with no file near the area', async () => {
    vi.stubGlobal('fetch', server().fetch);
    const data = await fetchOverture({ bounds: AREA, types: ['land_use'], release: 'test' });
    expect(data.features.land_use).toEqual([]);
    expect(data.stats.land_use.files).toBe(0);
  });

  it('leaves out a type the release does not have, with a warning', async () => {
    vi.stubGlobal('fetch', server().fetch);
    const data = await fetchOverture({ bounds: AREA, types: ['water', 'building_part', 'land_cover'], release: 'test' });
    expect(data.features.water).toHaveLength(2);
    expect(data.features.building_part).toEqual([]);
    expect(data.warnings).toEqual([
      'Overture release test has no building parts data, so the model was built without it.',
      'Overture release test has no land cover data, so the model was built without it.',
    ]);
  });

  it('fails when the release has no buildings, roads or water', () => {
    const bbox: [number, number, number, number] = [0, 0, 1, 1];
    const index = { release: 'r', files: [{ theme: 'base', type: 'water', href: 'https://example.com/w.parquet', size: 1, bbox, rows: 1, rowGroups: 1 }] };
    expect(checkTypes(index, ['water', 'land'])).toEqual(['Overture release r has no land data, so the model was built without it.']);
    expect(() => checkTypes(index, ['water', 'segment', 'land'])).toThrow("Overture release r has no roads and paths data, so the model can't be built.");
  });

  it('refuses an area that needs too much data before downloading it', async () => {
    const mock = server();
    vi.stubGlobal('fetch', mock.fetch);
    const error = await fetchOverture({ bounds: AREA, types: ['building'], release: 'test', maxTypeBytes: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AreaTooLargeError);
    expect((error as AreaTooLargeError).type).toBe('building');
    expect(String(error)).toContain('too large to download in the browser');
    // Only the two footers were read.
    expect(mock.requests.filter((r) => r.url.includes('building-'))).toHaveLength(2);
  });

  it('refuses bounds it cannot use', async () => {
    await expect(fetchOverture({ bounds: { west: 170, south: 0, east: -170, north: 1 } })).rejects.toThrow(/antimeridian/);
    await expect(fetchOverture({ bounds: { west: 0, south: 1, east: 1, north: 1 } })).rejects.toThrow(/empty/);
  });

  it('stops when cancelled', async () => {
    vi.stubGlobal('fetch', server().fetch);
    const controller = new AbortController();
    const run = fetchOverture({
      bounds: AREA,
      release: 'test',
      types: ['building', 'water'],
      signal: controller.signal,
      onProgress: (p) => {
        if (p.message.startsWith('Downloading')) controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('drops rows the caller filters out before reading their geometry', async () => {
    configurePageReading(ALWAYS_BY_PAGE);
    const mock = server();
    vi.stubGlobal('fetch', mock.fetch);
    const calls: [string, Record<string, unknown>, number[]][] = [];
    let secondPass = -1;
    const data = await fetchOverture({
      bounds: AREA,
      types: ['building'],
      release: 'test',
      keep: (type, props, bbox) => {
        calls.push([type, props, bbox]);
        return props.num_floors === 3;
      },
      onProgress: (p) => {
        if (p.message.startsWith('Downloading') && secondPass < 0) secondPass = mock.requests.length;
      },
    });
    expect(data.features.building.map((f) => f.id)).toEqual(['straddle']);
    expect(data.features.building[0].geometry).toEqual({
      type: 'Polygon',
      coordinates: [[[0.9, 0.9], [1.5, 0.9], [1.5, 1.5], [0.9, 1.5], [0.9, 0.9]]],
    });
    expect(data.stats.building).toMatchObject({ rowsRead: 11, rowsKept: 1, features: 1, skipped: 0 });
    // Every row in the area with an id is offered, geometry or not.
    expect(calls).toHaveLength(9);
    expect(calls.every(([type]) => type === 'building')).toBe(true);
    expect(calls.find(([, props]) => props.height === 120.5)?.[2]).toEqual([0.4, 0.4, 0.5, 0.5]);

    // The geometry pass reads only the last page of row group 1: not its
    // dictionary, not the pages of the other rows, nothing of other row groups.
    const fileA = fixture('building-a.parquet');
    const pages = (await walkPages(async (start, end) => fileA.slice(start, end).buffer, geometryRanges(fileA)[1], 3))!;
    const last = pages.pages[2];
    const geometryReads = mock.requests.slice(secondPass).filter((r) => r.url === FILES.buildingA);
    expect(geometryReads.map((r) => r.range)).toEqual([[last.offset, last.offset + last.size]]);
  });

  it('reads other columns when asked, and the filter sees them', async () => {
    vi.stubGlobal('fetch', server().fetch);
    const seen: unknown[] = [];
    const data = await fetchOverture({
      bounds: AREA,
      types: ['building'],
      release: 'test',
      columns: { building: ['sources'] },
      keep: (_type, props) => {
        seen.push(props.sources);
        return props.sources === undefined;
      },
    });
    expect(seen).toContainEqual([{ dataset: 'OpenStreetMap' }]);
    // Only "multi" has no sources.
    expect(data.features.building.map((f) => f.id)).toEqual(['multi']);
    expect(data.features.building[0].props).toEqual({});
  });

  it('reads the same features page by page as whole chunks', async () => {
    vi.stubGlobal('fetch', server().fetch);
    const types = ['building', 'segment', 'water'] as const;
    const whole = await fetchOverture({ bounds: AREA, types, release: 'test' });
    configurePageReading(ALWAYS_BY_PAGE);
    const paged = await fetchOverture({ bounds: AREA, types, release: 'test' });
    expect(paged.features).toEqual(whole.features);
    expect(paged.stats.building.skipped).toBe(2);
  });

  it('refuses an area over the overall budget before reading any geometry', async () => {
    vi.stubGlobal('fetch', server().fetch);
    let geometryStart = 0;
    const full = await fetchOverture({
      bounds: AREA,
      types: ['building', 'water'],
      release: 'test',
      onProgress: (p) => {
        if (p.message.startsWith('Downloading') && !geometryStart) geometryStart = p.bytes;
      },
    });
    const geometryBytes = full.bytes - geometryStart;
    expect(geometryBytes).toBeGreaterThan(0);

    vi.stubGlobal('fetch', server().fetch);
    const messages: string[] = [];
    const error = await fetchOverture({
      bounds: AREA,
      types: ['building', 'water'],
      release: 'test',
      maxTotalBytes: geometryStart + geometryBytes / 2,
      onProgress: (p) => messages.push(p.message),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AreaTooLargeError);
    const tooLarge = error as AreaTooLargeError;
    expect(tooLarge.type).toBeUndefined();
    expect(tooLarge.message).toMatch(/too large to download in the browser \((over|about) \d+ MB\)\. Choose a smaller area\./);
    expect(Object.keys(tooLarge.planned).sort()).toEqual(['building', 'water']);
    expect(messages).toContain('Reading buildings');
    expect(messages.some((m) => m.startsWith('Downloading'))).toBe(false);

    // A budget the first pass alone is over stops before that pass too.
    const early = server();
    vi.stubGlobal('fetch', early.fetch);
    const tiny = await fetchOverture({ bounds: AREA, types: ['building'], release: 'test', maxTotalBytes: 10 }).catch((e: unknown) => e);
    expect(String(tiny)).toMatch(/over \d+ MB/);
    expect(early.requests.filter((r) => r.url.includes('building-'))).toHaveLength(2);
  });

  it('downloads again what the cache holds but does not parse', async () => {
    const store = new Map<string, ArrayBuffer>();
    setByteCache({ get: async (key) => store.get(key), put: async (key, value) => void store.set(key, value) });
    const types = ['building', 'water'] as const;
    vi.stubGlobal('fetch', server().fetch);
    const first = await fetchOverture({ bounds: AREA, types, release: 'test' });
    // Footers, attribute chunks and geometry chunks, all the right length and all wrong.
    const damaged = [...store.keys()].filter((key) => key.startsWith(S3));
    expect(damaged.length).toBeGreaterThan(5);
    for (const key of damaged) store.set(key, new ArrayBuffer(store.get(key)!.byteLength));
    const mock = server();
    vi.stubGlobal('fetch', mock.fetch);
    const second = await fetchOverture({ bounds: AREA, types, release: 'test' });
    expect(second.features).toEqual(first.features);
    expect(mock.requests.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(damaged.every((key) => new Uint8Array(store.get(key)!).some((byte) => byte !== 0))).toBe(true);
  });

  it('reads everything from the cache the second time', async () => {
    const store = new Map<string, ArrayBuffer>();
    const cache: ByteCache = { get: async (key) => store.get(key), put: async (key, value) => void store.set(key, value) };
    setByteCache(cache);
    const mock = server();
    vi.stubGlobal('fetch', mock.fetch);
    const first = await fetchOverture({ bounds: AREA, types: ['building', 'water'], release: 'test' });
    const requests = mock.requests.length;
    const second = await fetchOverture({ bounds: AREA, types: ['building', 'water'], release: 'test' });
    expect(mock.requests.length).toBe(requests);
    expect(second.features).toEqual(first.features);
    expect(second.stats.building.cachedBytes).toBe(second.stats.building.bytes);
    expect(second.bytes).toBe(first.bytes);
  });
});
