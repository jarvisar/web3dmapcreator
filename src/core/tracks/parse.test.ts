import { gzipSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { LonLat } from '../types';
import { readFit } from './fitfile';
import { parseTrackFile, TrackFileError } from './parse';
import { decodePolyline, encodePolyline } from './polyline';
import { decodeTrack, encodeTrack, MAX_TRACK_POINTS, mergeTracks, sanitizeTracks, simplifyLine, simplifyTrack, trackLengthM, type Track } from './track';

const bytes = (text: string) => strToU8(text).buffer as ArrayBuffer;
const parse = (name: string, text: string) => parseTrackFile(name, bytes(text))[0];

// Metres to degrees near the equator, close enough for test tracks.
const M = 1 / 111_320;

/** A FIT file with record messages, written to the spec. `null` is a record without a position. */
function fitFile(points: (LonLat | null)[], options: { bigEndian?: boolean; course?: string; compressed?: boolean } = {}): ArrayBuffer {
  const body: number[] = [];
  const little = !options.bigEndian;
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const i32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, little);
    return [...b];
  };
  // file_id with a type field, so the file isn't only records.
  body.push(0x40, 0, little ? 0 : 1, ...u16(0), 1, 0, 1, 0x00);
  body.push(0x00, 4);
  if (options.course) {
    const name = [...strToU8(options.course), 0];
    body.push(0x42, 0, little ? 0 : 1, ...u16(31), 1, 5, name.length, 0x07);
    body.push(0x02, ...name);
  }
  // record: timestamp, position_lat, position_long, heart rate, plus a developer field.
  body.push(0x41 | 0x20, 0, little ? 0 : 1, ...u16(20), 4, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 3, 1, 0x02, 1, 0, 2, 0);
  const semis = (degrees: number) => Math.round(degrees / (180 / 2 ** 31));
  points.forEach((point, i) => {
    const lat = point ? semis(point[1]) : 0x7fffffff;
    const lon = point ? semis(point[0]) : 0x7fffffff;
    const header = options.compressed && i % 2 ? 0x80 | (1 << 5) | (i & 0x1f) : 0x01;
    body.push(header, ...i32(1000 + i), ...i32(lat), ...i32(lon), 140, 7, 7);
  });
  const header = new Uint8Array(14);
  const view = new DataView(header.buffer);
  header[0] = 14;
  header[1] = 0x20;
  view.setUint16(2, 2132, true);
  view.setUint32(4, body.length, true);
  header.set(strToU8('.FIT'), 8);
  const out = new Uint8Array(14 + body.length + 2);
  out.set(header);
  out.set(body, 14);
  return out.buffer;
}

describe('encoded polylines', () => {
  it('round-trip to six decimals', () => {
    const points: LonLat[] = [
      [-87.623177, 41.881832],
      [-87.6, 41.9],
      [179.999999, -85],
      [-180, 89.999999],
    ];
    const decoded = decodePolyline(encodePolyline(points));
    expect(decoded).toHaveLength(points.length);
    decoded.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(points[i][0], 6);
      expect(p[1]).toBeCloseTo(points[i][1], 6);
    });
  });

  it('only use characters that are safe in JSON and links', () => {
    expect(encodePolyline([[-122.4, 37.8], [-122.41, 37.79]])).toMatch(/^[?-~]+$/);
  });

  it('stop at text that is not a polyline instead of throwing', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline('not a polyline at all')).toEqual(expect.any(Array));
    expect(decodePolyline('~~~~~~~~~~~~~~~~~')).toEqual([]);
  });
});

describe('simplifying tracks', () => {
  it('drops points within a metre of the line and keeps corners', () => {
    const wobbly: LonLat[] = Array.from({ length: 1000 }, (_, i) => [i * 2 * M, (i % 2 ? 0.3 : -0.3) * M]);
    const [line] = simplifyTrack([wobbly]);
    expect(line.length).toBeLessThan(5);
    expect(line[0]).toEqual(wobbly[0]);
    expect(line[line.length - 1]).toEqual(wobbly[wobbly.length - 1]);
    const zigzag: LonLat[] = Array.from({ length: 21 }, (_, i) => [i * 50 * M, (i % 2) * 20 * M]);
    expect(simplifyTrack([zigzag])[0]).toHaveLength(21);
  });

  it('gets coarser until a long noisy track fits', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const noisy: LonLat[] = Array.from({ length: 40_000 }, (_, i) => [i * 3 * M + random() * 4 * M, Math.sin(i / 500) * 2000 * M + random() * 4 * M]);
    const total = simplifyTrack([noisy]).reduce((n, l) => n + l.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TRACK_POINTS);
    expect(total).toBeGreaterThan(100);
  });

  it('keep what Douglas-Peucker keeps at the tolerance they end up at', () => {
    let seed = 9;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    // Near the equator, so degrees are metres times one factor. Points 2 m apart or more.
    const noisy: LonLat[] = Array.from({ length: 5000 }, (_, i) => [i * 3 * M + random() * 0.5 * M, Math.sin(i / 200) * 500 * M + random() * 0.5 * M]);
    const perDegree = (Math.PI / 180) * 6371008.8;
    for (const tolerance of [1, 2.5, 7]) expect(simplifyTrack([noisy], tolerance, Infinity)[0]).toEqual(simplifyLine(noisy, tolerance / perDegree));
    // Coarser by half again until it fits.
    const fitted = simplifyTrack([noisy], 1, 300)[0];
    let tolerance = 1;
    while (simplifyLine(noisy, tolerance / perDegree).length > 300) tolerance *= 1.5;
    expect(fitted).toEqual(simplifyLine(noisy, tolerance / perDegree));
  });

  it('thin points logged closer than the tolerance first', () => {
    // A straight walk logged every 2 cm, then a corner.
    const dense: LonLat[] = Array.from({ length: 5001 }, (_, i): LonLat => [i * 0.02 * M, 0]);
    dense.push([100 * M, 50 * M]);
    const [line] = simplifyTrack([dense]);
    expect(line).toHaveLength(3);
    expect(line[0]).toEqual(dense[0]);
    expect(line[2]).toEqual(dense[5001]);
    // The corner can move back by the thinning's 0.2 m at most.
    expect(Math.abs(line[1][0] - dense[5000][0]) / M).toBeLessThanOrEqual(0.2 + 1e-6);
  });

  it('measure and decode what they encode', () => {
    const encoded = encodeTrack([
      [
        [0, 0],
        [1000 * M, 0],
      ],
    ]);
    expect(trackLengthM(decodeTrack({ lines: encoded }))).toBeCloseTo(1000, -1);
    // Anything off the globe is dropped, the rest is kept.
    expect(decodeTrack({ lines: [encodePolyline([[0, 95], [0, 96]]), ...encoded] })).toHaveLength(1);
  });
});

describe('reading route files', () => {
  it('reads GPX tracks and joins the segments a pause splits', () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
      <!-- exported -->
      <gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
        <metadata><name>Fish &amp; Chips Loop</name></metadata>
        <wpt lat="0" lon="0"><name>Aid station</name></wpt>
        <trk><name>Morning Run</name>
          <trkseg><trkpt lat="0" lon="1"/><trkpt lat="0" lon="${1 + 100 * M}"><ele>4</ele></trkpt></trkseg>
          <trkseg><trkpt lat="0" lon="${1 + 200 * M}"></trkpt><trkpt lat="0" lon="${1 + 300 * M}"/></trkseg>
        </trk>
        <trk><trkseg><trkpt lat="${5000 * M}" lon="1"/><trkpt lat="${5100 * M}" lon="1"/></trkseg></trk>
      </gpx>`;
    const track = parse('run.gpx', gpx);
    expect(track.name).toBe('Fish & Chips Loop');
    // The pause is joined, the second track 5 km away isn't.
    expect(track.lines.map((l) => l.length)).toEqual([4, 2]);
  });

  it('reads GPX routes and falls back to the track name, then the file name', () => {
    expect(parse('x.gpx', `<gpx><rte><name><![CDATA[Ride <north>]]></name><rtept lat="1" lon="2"/><rtept lat="1.01" lon="2"/></rte></gpx>`)).toEqual({
      name: 'Ride <north>',
      lines: [
        [
          [2, 1],
          [2, 1.01],
        ],
      ],
    });
    const unnamed = parse('C:\\Users\\me\\Downloads\\Evening Ride.gpx', `<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.01" lon="2"/></trkseg></trk></gpx>`);
    expect(unnamed.name).toBe('Evening Ride');
  });

  it('ignores markup in XML comments before the root', () => {
    const gpx = '<!-- Exported from <planner> --><gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.01" lon="2"/></trkseg></trk></gpx>';
    expect(parse('comment.gpx', gpx).lines[0]).toHaveLength(2);
  });

  it('keeps a valid route when the accompanying track has no usable line', () => {
    const gpx = '<gpx><rte><rtept lat="1" lon="2"/><rtept lat="1.01" lon="2"/></rte><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="91" lon="2"/></trkseg></trk></gpx>';
    expect(parse('route.gpx', gpx).lines[0]).toEqual([[2, 1], [2, 1.01]]);
  });

  it('reads KML lines, shapes and Google Earth tracks', () => {
    const kml = `<?xml version="1.0"?>
      <kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
        <Document><name>Course.kml</name>
          <Placemark><name>Start</name><Point><coordinates>1,1</coordinates></Point></Placemark>
          <Placemark><name>Course</name><LineString><coordinates>
            1,1,0 1.01,1,0
            1.02, 1.01
          </coordinates></LineString></Placemark>
          <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>3,3 3.01,3 3.01,3.01 3,3</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
          <Placemark><gx:Track><when>2024</when><gx:coord>5 5 10</gx:coord><gx:coord>5.01 5 10</gx:coord></gx:Track></Placemark>
        </Document>
      </kml>`;
    const track = parse('course.kml', kml);
    expect(track.name).toBe('Course');
    expect(track.lines).toEqual([
      [
        [1, 1],
        [1.01, 1],
        [1.02, 1.01],
      ],
      [
        [3, 3],
        [3.01, 3],
        [3.01, 3.01],
        [3, 3],
      ],
      [
        [5, 5],
        [5.01, 5],
      ],
    ]);
  });

  it('reads the KML inside a KMZ, stored or deflated', () => {
    const kml = strToU8('<kml><Placemark><name>Zipped</name><LineString><coordinates>1,1 1.01,1</coordinates></LineString></Placemark></kml>');
    for (const level of [0, 9] as const) {
      const kmz = zipSync({ 'files/overlay.kml': strToU8('<kml/>'), 'doc.kml': kml }, { level });
      expect(parseTrackFile('map.kmz', kmz.buffer as ArrayBuffer)).toEqual([
        {
          name: 'Zipped',
          lines: [
            [
              [1, 1],
              [1.01, 1],
            ],
          ],
        },
      ]);
    }
    expect(() => parseTrackFile('empty.kmz', zipSync({ 'image.png': kml }).buffer as ArrayBuffer)).toThrow('no KML');
  });

  it('reads every route file in a zip, and gzipped files', () => {
    const gpx = (lat: number) => strToU8(`<gpx><trk><trkseg><trkpt lat="${lat}" lon="2"/><trkpt lat="${lat + 0.01}" lon="2"/></trkseg></trk></gpx>`);
    const zip = zipSync({ 'a.gpx': gpx(1), 'b.gpx.gz': gzipSync(gpx(3)), 'notes.txt': strToU8('hi') });
    const tracks = parseTrackFile('export.zip', zip.buffer as ArrayBuffer);
    expect(tracks.map((t) => t.name)).toEqual(['a', 'b']);
    const gz = parseTrackFile('Lunch Run.gpx.gz', gzipSync(gpx(5)).buffer as ArrayBuffer);
    expect(gz[0].name).toBe('Lunch Run');
    expect(gz[0].lines[0][0]).toEqual([2, 5]);
  });

  it('reads TCX activities and skips points without a position', () => {
    const tcx = `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
      <Activities><Activity Sport="Running"><Id>2024-10-13</Id><Lap><Track>
        <Trackpoint><Position><LatitudeDegrees>41.88</LatitudeDegrees><LongitudeDegrees>-87.62</LongitudeDegrees></Position></Trackpoint>
        <Trackpoint><HeartRateBpm><Value>150</Value></HeartRateBpm></Trackpoint>
        <Trackpoint><Position><LatitudeDegrees>41.89</LatitudeDegrees><LongitudeDegrees>-87.62</LongitudeDegrees></Position></Trackpoint>
      </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    expect(parse('chicago.tcx', tcx)).toEqual({
      name: 'chicago',
      lines: [
        [
          [-87.62, 41.88],
          [-87.62, 41.89],
        ],
      ],
    });
  });

  it('reads GeoJSON lines and polygons, and joins converted GPS tracks', () => {
    const geojson = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
        { type: 'Feature', properties: { name: 'Canal path' }, geometry: { type: 'LineString', coordinates: [[0.5, 0], [0.51, 0, 12]] } },
        { type: 'Feature', properties: null, geometry: { type: 'MultiLineString', coordinates: [[[1, 1], [1.01, 1]], [[2, 2], [2.01, 2]]] } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[3, 3], [3.01, 3], [3, 3.01], [3, 3]]] } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[null, 1], ['4', 4]] } },
      ],
    };
    const track = parse('paths.geojson', '\uFEFF' + JSON.stringify(geojson));
    expect(track.name).toBe('Canal path');
    expect(track.lines).toHaveLength(4);
    const converted = {
      type: 'Feature',
      properties: { coordTimes: [] },
      geometry: { type: 'MultiLineString', coordinates: [[[1, 0], [1 + 100 * M, 0]], [[1 + 150 * M, 0], [1 + 250 * M, 0]]] },
    };
    expect(parse('t.json', JSON.stringify(converted)).lines).toHaveLength(1);
  });

  it('leaves out turn points written beside the full line', () => {
    const gpx = `<gpx><rte><rtept lat="1" lon="2"/><rtept lat="1.01" lon="2.01"/></rte>
      <trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.005" lon="2"/><trkpt lat="1.01" lon="2.01"/></trkseg></trk></gpx>`;
    expect(parse('planned.gpx', gpx).lines).toEqual([
      [
        [2, 1],
        [2, 1.005],
        [2.01, 1.01],
      ],
    ]);
  });

  it('drops points without a fix written as 0,0', () => {
    const track = parse('run.gpx', `<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="0" lon="0"/><trkpt lat="1.001" lon="2"/></trkseg></trk></gpx>`);
    expect(track.lines).toEqual([
      [
        [2, 1],
        [2, 1.001],
      ],
    ]);
  });

  it('reads UTF-16 files', () => {
    const text = `<?xml version="1.0" encoding="UTF-16"?><gpx><trk><name>Ünder</name><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2"/></trkseg></trk></gpx>`;
    for (const little of [true, false]) {
      const data = new Uint8Array(2 + text.length * 2);
      const view = new DataView(data.buffer);
      view.setUint16(0, 0xfeff, little);
      for (let i = 0; i < text.length; i++) view.setUint16(2 + 2 * i, text.charCodeAt(i), little);
      const [track] = parseTrackFile('ride.gpx', data.buffer);
      expect(track.name).toBe('Ünder');
      expect(track.lines[0]).toHaveLength(2);
    }
  });

  it('splits a line where it crosses the 180th meridian', () => {
    const track = parse('ferry.gpx', `<gpx><trk><trkseg><trkpt lat="0" lon="179.9"/><trkpt lat="0" lon="179.99"/><trkpt lat="0" lon="-179.99"/><trkpt lat="0" lon="-179.9"/></trkseg></trk></gpx>`);
    expect(track.lines).toHaveLength(2);
  });

  it('reads FIT activities and courses, either byte order', () => {
    const points: (LonLat | null)[] = [[-87.62, 41.88], [-87.621, 41.881], null, [-87.622, 41.882], [-87.623, 41.883]];
    for (const options of [{}, { bigEndian: true }, { compressed: true }]) {
      const { lines } = readFit(fitFile(points, options));
      expect(lines.map((line) => line.length)).toEqual([2, 2]);
      expect(lines[0][0][0]).toBeCloseTo(-87.62, 6);
      expect(lines[1][1][1]).toBeCloseTo(41.883, 6);
    }
    // The gap is about 160 m, so the pieces are one route.
    const [track] = parseTrackFile('2024-10-13.fit', fitFile(points, { course: 'Chicago Marathon' }));
    expect(track.name).toBe('Chicago Marathon');
    expect(track.lines).toHaveLength(1);
    expect(parseTrackFile('Morning Ride.fit', fitFile(points))[0].name).toBe('Morning Ride');
  });

  it('explains files it cannot use', () => {
    const broken = new Uint8Array(16);
    broken[0] = 14;
    broken.set(strToU8('.FIT'), 8);
    expect(() => parseTrackFile('ride.fit', broken.buffer)).toThrow(/no tracks/);
    expect(() => parse('notes.txt', 'just some text')).toThrow(TrackFileError);
    expect(() => parse('page.html', '<html><body></body></html>')).toThrow(/doesn't look like/);
    expect(() => parse('bad.geojson', '{"type": ')).toThrow(/couldn't be read/);
    expect(() => parse('poi.gpx', '<gpx><wpt lat="1" lon="1"/></gpx>')).toThrow(/only has points/);
    expect(() => parse('empty.gpx', '<gpx></gpx>')).toThrow(/no tracks/);
    expect(() => parseTrackFile('bad.zip', strToU8('PK\x03\x04 nonsense').buffer as ArrayBuffer)).toThrow(/couldn't be opened/);
  });
});

describe('saved tracks', () => {
  const track = (id: string, lat: number): Track => ({ id, name: id, visible: true, lines: [encodePolyline([[0, lat], [0.01, lat]])] });

  it('drop anything malformed', () => {
    const clean = sanitizeTracks([
      track('a', 1),
      { ...track('a', 2) },
      { id: 'b', name: 'x'.repeat(500), lines: ['not<polyline>'] },
      { id: 'empty', lines: ['?'] },
      { id: 'offglobe', lines: [encodePolyline([[0, 95], [0, 96]])] },
      { id: 'c', name: '  Spaced   name.gpx ', visible: false, lines: [encodePolyline([[0, 1], [0, 2]])] },
      'nonsense',
    ]);
    expect(clean.map((t) => t.id)).toEqual(['a', 'c']);
    expect(clean[1]).toMatchObject({ name: 'Spaced name', visible: false });
  });

  it('merge without taking ours out or adding the same one twice', () => {
    const ours = [track('a', 1), track('b', 2)];
    const merged = mergeTracks(ours, [track('a', 1), track('b', 3), track('c', 4)]);
    expect(merged.added).toBe(2);
    expect(merged.tracks).toHaveLength(4);
    // Their b is another route, so it gets an id of its own.
    expect(new Set(merged.tracks.map((t) => t.id)).size).toBe(4);
    expect(mergeTracks(ours, [track('z', 1)]).tracks).toBe(ours);
  });

  it('know their own route back from a link that simplified it', () => {
    let seed = 2;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const points: LonLat[] = Array.from({ length: 3000 }, (_, i) => [i * 3 * M + random() * 2 * M, Math.sin(i / 100) * 300 * M + random() * 2 * M]);
    const run: Track = { id: 'run1', name: 'Run', visible: true, lines: encodeTrack([points]) };
    const linked = { ...run, lines: encodeTrack(decodeTrack(run), 12) };
    expect(linked.lines).not.toEqual(run.lines);
    expect(mergeTracks([run], [linked]).added).toBe(0);
    // Passed on, it got a new id but kept its name.
    expect(mergeTracks([run], [{ ...linked, id: 'other' }]).added).toBe(0);
    // Another run of the same course under another name is its own.
    expect(mergeTracks([run], [{ ...linked, id: 'other', name: 'Run again' }]).added).toBe(1);
    // The same name somewhere else is too.
    const moved = { ...run, lines: encodeTrack([points.map(([lon, lat]): LonLat => [lon, lat + 40 * M])]) };
    expect(mergeTracks([run], [moved]).added).toBe(1);
  });
});
