import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ZipWriter } from './zip';

describe('ZipWriter', () => {
  it('streams text and byte chunks into entries in order', () => {
    const zip = new ZipWriter();
    const model = zip.entry('3D/3dmodel.model');
    const rows: string[] = [];
    // Enough text to pass the 1 MB encoding threshold several times.
    for (let i = 0; i < 60000; i++) {
      const row = `     <vertex x="${i}.000000" y="-${i}.500000" z="0.000000"/>\n`;
      rows.push(row);
      if (i % 3 === 0) model.bytes(new TextEncoder().encode(row));
      else model.text(row);
    }
    model.text('© end\n');
    model.close();
    zip.file('Metadata/a.config', '<config/>\n');
    zip.file('b.bin', new Uint8Array([1, 2, 3]));
    const files = unzipSync(zip.finish());
    expect(Object.keys(files)).toEqual(['3D/3dmodel.model', 'Metadata/a.config', 'b.bin']);
    expect(strFromU8(files['3D/3dmodel.model'])).toBe(rows.join('') + '© end\n');
    expect(strFromU8(files['Metadata/a.config'])).toBe('<config/>\n');
    expect([...files['b.bin']]).toEqual([1, 2, 3]);
  });

  it('copies byte chunks, so a caller can reuse its buffer', () => {
    const zip = new ZipWriter();
    const entry = zip.entry('data.bin');
    const scratch = new Uint8Array(1000);
    for (let round = 0; round < 5; round++) {
      scratch.fill(round);
      entry.bytes(scratch);
    }
    entry.close();
    const data = unzipSync(zip.finish())['data.bin'];
    expect(data.length).toBe(5000);
    for (let round = 0; round < 5; round++) expect(data[round * 1000 + 999]).toBe(round);
  });

  it('writes empty entries and refuses misuse', () => {
    const zip = new ZipWriter();
    zip.file('empty.txt', '');
    const open = zip.entry('open.txt');
    expect(() => zip.entry('other.txt')).toThrow(/still being written/);
    expect(() => zip.finish()).toThrow(/still being written/);
    open.close();
    expect(() => open.text('late')).toThrow(/already closed/);
    expect(() => zip.entry('empty.txt')).toThrow(/Duplicate/);
    const files = unzipSync(zip.finish());
    expect(files['empty.txt'].length).toBe(0);
    expect(files['open.txt'].length).toBe(0);
  });
});
