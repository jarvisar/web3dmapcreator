import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { AsciiBuffer, fixed6, formatG, quoteattr } from './format';

function bufferText(write: (out: AsciiBuffer) => void, size = 64): string {
  const chunks: string[] = [];
  const out = new AsciiBuffer((chunk) => chunks.push(strFromU8(chunk)), size);
  write(out);
  out.flush();
  return chunks.join('');
}

describe('fixed6', () => {
  it('matches Python %.6f, ties to even and signed zero included', () => {
    expect(fixed6(0)).toBe('0.000000');
    expect(fixed6(-0)).toBe('-0.000000');
    expect(fixed6(-1e-7)).toBe('-0.000000');
    expect(fixed6(1e-7)).toBe('0.000000');
    expect(fixed6(-100)).toBe('-100.000000');
    expect(fixed6(307.2 + 128 - 50)).toBe('385.200000');
    // Exact ties in binary: 1/128 and 3/128.
    expect(fixed6(0.0078125)).toBe('0.007812');
    expect(fixed6(0.0234375)).toBe('0.023438');
    expect(fixed6(-0.0078125)).toBe('-0.007812');
    expect(fixed6(1234567.5)).toBe('1234567.500000');
    expect(fixed6(2e9)).toBe('2000000000.000000');
  });

  it('agrees with toFixed on float32 values that are not ties', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 20000; i++) {
      const v = Math.fround((random() - 0.5) * 10 ** Math.floor(random() * 7));
      const scaled = Math.abs(v) * 1e6;
      if (scaled - Math.floor(scaled) === 0.5) continue;
      const expected = v.toFixed(6);
      expect(fixed6(v), String(v)).toBe(Object.is(v, -0) ? '-0.000000' : expected);
    }
  });

  it('writes the same digits as bytes', () => {
    const values = [0, -0, 1.5, -2.25, 0.0078125, 123.456789, -99999.999999, 1e-7, Math.fround(12.3456789), 3e9];
    const text = bufferText((out) => {
      for (const v of values) {
        out.reserve(40);
        out.fixed6(v);
        out.bytes(new Uint8Array([32]));
      }
    });
    expect(text).toBe(values.map((v) => fixed6(v) + ' ').join(''));
  });
});

describe('AsciiBuffer', () => {
  it('writes integers across the 32-bit boundary and flushes when full', () => {
    const values = [0, 7, 10, 99, 100, 65535, 2147483647, 2147483648, 4294967295, 9007199254740991];
    const text = bufferText((out) => {
      for (const v of values) {
        out.reserve(20);
        out.int(v);
        out.bytes(new Uint8Array([44]));
      }
    }, 24);
    expect(text).toBe(values.map((v) => `${v},`).join(''));
  });
});

describe('XML helpers', () => {
  it('quotes attributes like Python quoteattr', () => {
    expect(quoteattr('Roads')).toBe('"Roads"');
    expect(quoteattr('A & B <c>')).toBe('"A &amp; B &lt;c&gt;"');
    expect(quoteattr('say "hi"')).toBe(`'say "hi"'`);
    expect(quoteattr(`it's "x"`)).toBe('"it\'s &quot;x&quot;"');
    expect(quoteattr('a\nb\tc\rd')).toBe('"a&#10;b&#9;c&#13;d"');
    expect(quoteattr('bell\u0007')).toBe('"bell"');
    expect(quoteattr('café')).toBe('"café"');
  });

  it('formats bed sizes like %g', () => {
    expect(formatG(256)).toBe('256');
    expect(formatG(180.5)).toBe('180.5');
    expect(formatG(0.1 + 0.2)).toBe('0.3');
  });
});
