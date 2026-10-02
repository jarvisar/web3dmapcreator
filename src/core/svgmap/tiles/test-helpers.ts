import { PbfWriter } from 'pbf';

/** A one-feature vector tile with a single polygon ring, in tile units (y down). */
export function encodeTile(layer: string, ring: [number, number][]): Uint8Array {
  const zigzag = (n: number) => (n << 1) ^ (n >> 31);
  const geometry: number[] = [];
  let [cx, cy] = [0, 0];
  ring.forEach(([x, y], i) => {
    if (i === 0) geometry.push(1 | (1 << 3));
    if (i === 1) geometry.push(2 | ((ring.length - 1) << 3));
    geometry.push(zigzag(x - cx), zigzag(y - cy));
    [cx, cy] = [x, y];
  });
  geometry.push(7 | (1 << 3));
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_: unknown, l: PbfWriter) => {
    l.writeVarintField(15, 2);
    l.writeStringField(1, layer);
    l.writeMessage(2, (_f: unknown, f: PbfWriter) => {
      f.writeVarintField(3, 3);
      f.writePackedVarint(4, geometry);
    }, null);
    l.writeVarintField(5, 4096);
  }, null);
  return pbf.finish();
}
