import { describe, expect, it } from 'vitest';
import { parseWkb } from './wkb';

// Builds WKB by hand. `code` is the full geometry type, flags included.
class Writer {
  private bytes: number[] = [];

  constructor(private readonly little = true) {}

  header(code: number): this {
    this.bytes.push(this.little ? 1 : 0);
    return this.uint(code);
  }

  uint(value: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value, this.little);
    this.bytes.push(...new Uint8Array(view.buffer));
    return this;
  }

  doubles(...values: number[]): this {
    for (const value of values) {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value, this.little);
      this.bytes.push(...new Uint8Array(view.buffer));
    }
    return this;
  }

  raw(other: Writer): this {
    this.bytes.push(...other.done());
    return this;
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

const square = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0];

describe('parseWkb', () => {
  it('reads points and lines', () => {
    expect(parseWkb(new Writer().header(1).doubles(-87.6, 41.9).done())).toEqual({ type: 'Point', coordinates: [-87.6, 41.9] });
    expect(parseWkb(new Writer().header(2).uint(2).doubles(0, 1, 2, 3).done())).toEqual({
      type: 'LineString',
      coordinates: [[0, 1], [2, 3]],
    });
  });

  it('reads polygons with holes, in either byte order', () => {
    for (const little of [true, false]) {
      const wkb = new Writer(little).header(3).uint(2).uint(5).doubles(...square).uint(4).doubles(0.2, 0.2, 0.4, 0.2, 0.2, 0.4, 0.2, 0.2);
      expect(parseWkb(wkb.done())).toEqual({
        type: 'Polygon',
        coordinates: [
          [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
          [[0.2, 0.2], [0.4, 0.2], [0.2, 0.4], [0.2, 0.2]],
        ],
      });
    }
  });

  it('reads multi geometries and collections', () => {
    const polygon = () => new Writer().header(3).uint(1).uint(5).doubles(...square);
    const multi = new Writer().header(6).uint(2).raw(polygon()).raw(polygon()).done();
    const parsed = parseWkb(multi);
    expect(parsed.type).toBe('MultiPolygon');
    expect(parsed.type === 'MultiPolygon' && parsed.coordinates.length).toBe(2);

    const lines = new Writer().header(5).uint(1).raw(new Writer().header(2).uint(2).doubles(0, 0, 1, 1)).done();
    expect(parseWkb(lines)).toEqual({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] });

    const points = new Writer().header(4).uint(2).raw(new Writer().header(1).doubles(1, 2)).raw(new Writer().header(1).doubles(3, 4)).done();
    expect(parseWkb(points)).toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });

    const collection = new Writer().header(7).uint(2).raw(new Writer().header(1).doubles(1, 2)).raw(polygon()).done();
    const read = parseWkb(collection);
    expect(read.type === 'GeometryCollection' && read.geometries.map((g) => g.type)).toEqual(['Point', 'Polygon']);
  });

  it('drops Z and M, ISO or EWKB', () => {
    // ISO LineString Z.
    expect(parseWkb(new Writer().header(1002).uint(2).doubles(0, 1, 50, 2, 3, 60).done())).toEqual({
      type: 'LineString',
      coordinates: [[0, 1], [2, 3]],
    });
    // ISO Point ZM.
    expect(parseWkb(new Writer().header(3001).doubles(5, 6, 7, 8).done())).toEqual({ type: 'Point', coordinates: [5, 6] });
    // EWKB Point Z with an SRID.
    const ewkb = new Writer().header(0xa0000001).uint(4326).doubles(5, 6, 7).done();
    expect(parseWkb(ewkb)).toEqual({ type: 'Point', coordinates: [5, 6] });
  });

  it('rejects truncated or corrupt data', () => {
    const polygon = new Writer().header(3).uint(1).uint(5).doubles(...square).done();
    expect(() => parseWkb(polygon.subarray(0, 30))).toThrow();
    expect(() => parseWkb(new Writer().header(2).uint(1e9).doubles(0, 0).done())).toThrow(/count/);
    expect(() => parseWkb(new Writer().header(9).done())).toThrow(/Unsupported/);
    // A multi polygon holding a line.
    const mixed = new Writer().header(6).uint(1).raw(new Writer().header(2).uint(2).doubles(0, 0, 1, 1)).done();
    expect(() => parseWkb(mixed)).toThrow(/LineString/);
  });

  it('reads a view into a larger buffer', () => {
    const point = new Writer().header(1).doubles(3, 4).done();
    const padded = new Uint8Array(point.length + 7);
    padded.set(point, 3);
    expect(parseWkb(padded.subarray(3, 3 + point.length))).toEqual({ type: 'Point', coordinates: [3, 4] });
  });
});
