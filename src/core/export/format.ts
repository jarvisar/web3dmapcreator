// Text formatting shared by the 3MF writers.
//
// Mesh rows are written as ASCII bytes straight into a reusable buffer rather
// than as JS strings: a big city has tens of millions of coordinates and
// building strings for them costs more than the formatting itself.

// Coordinates at or beyond this take the slow path. Below it, v * 1e6 and the
// integer arithmetic stay exact.
const FAST_LIMIT = 1e9;

function isNegative(v: number): boolean {
  return v < 0 || (v === 0 && 1 / v < 0);
}

/**
 * v with six decimals, like Python's "%.6f": ties round to even, and -0 or a
 * small negative value that rounds to zero keeps its sign. For float32 input
 * v * 1e6 is exact, so ties are detected exactly.
 */
export function fixed6(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`Cannot format ${v}`);
  const sign = isNegative(v) ? '-' : '';
  const a = Math.abs(v);
  if (a >= FAST_LIMIT) return sign + a.toFixed(6);
  const n = roundScaled(a);
  const whole = Math.floor(n / 1e6);
  return `${sign}${whole}.${String(n - whole * 1e6).padStart(6, '0')}`;
}

function roundScaled(a: number): number {
  const scaled = a * 1e6;
  let n = Math.floor(scaled);
  const rest = scaled - n;
  if (rest > 0.5 || (rest === 0.5 && n % 2 === 1)) n += 1;
  return n;
}

/** Python's "%g" for bed sizes: 256 becomes "256", 180.5 stays "180.5". */
export function formatG(v: number): string {
  return String(Number(v.toPrecision(6)));
}

// Control characters other than tab, newline and carriage return cannot appear
// in XML 1.0 at all, even escaped.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** XML character data. */
export function escapeText(value: string): string {
  return value.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;');
}

/** An attribute value with its quotes, as Python's xml.sax.saxutils.quoteattr writes it. */
export function quoteattr(value: string): string {
  const data = escapeText(value).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
  if (data.includes('"')) {
    return data.includes("'") ? `"${data.replace(/"/g, '&quot;')}"` : `'${data}'`;
  }
  return `"${data}"`;
}

/** ASCII only: every character becomes one byte. */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) throw new Error(`Not ASCII: ${text}`);
    out[i] = code;
  }
  return out;
}

/**
 * A fixed buffer of ASCII output handed to `sink` whenever it fills. The sink
 * must consume the chunk before returning: the buffer is reused.
 */
export class AsciiBuffer {
  private readonly buffer: Uint8Array;
  private pos = 0;

  constructor(
    private readonly sink: (chunk: Uint8Array) => void,
    size = 1 << 20,
  ) {
    this.buffer = new Uint8Array(size);
  }

  /** Make room for at least n more bytes. n must not exceed the buffer size. */
  reserve(n: number): void {
    if (this.pos + n > this.buffer.length) this.flush();
  }

  flush(): void {
    if (this.pos > 0) {
      this.sink(this.buffer.subarray(0, this.pos));
      this.pos = 0;
    }
  }

  /** Short constant pieces: callers reserve room first. */
  bytes(data: Uint8Array): void {
    const b = this.buffer;
    let p = this.pos;
    for (let i = 0; i < data.length; i++) b[p++] = data[i];
    this.pos = p;
  }

  /** A non-negative integer below 2^53. */
  int(n: number): void {
    const b = this.buffer;
    const p = this.pos;
    if (n < 10) {
      b[p] = 48 + n;
      this.pos = p + 1;
      return;
    }
    let digits = 1;
    for (let t = n; t >= 10; t = Math.floor(t / 10)) digits++;
    let i = p + digits - 1;
    let rest = n;
    // Integer division with | 0 only holds below 2^31.
    while (rest > 0x7fffffff) {
      const q = Math.floor(rest / 10);
      b[i--] = 48 + (rest - q * 10);
      rest = q;
    }
    while (rest >= 10) {
      const q = (rest / 10) | 0;
      b[i--] = 48 + (rest - q * 10);
      rest = q;
    }
    b[i] = 48 + rest;
    this.pos = p + digits;
  }

  /** Same digits as fixed6(), without building a string. */
  fixed6(v: number): void {
    const b = this.buffer;
    let a = v;
    if (isNegative(a)) {
      b[this.pos++] = 45;
      a = -a;
    }
    if (a >= FAST_LIMIT) {
      const text = a.toFixed(6);
      for (let i = 0; i < text.length; i++) b[this.pos++] = text.charCodeAt(i);
      return;
    }
    const n = roundScaled(a);
    const whole = Math.floor(n / 1e6);
    let frac = n - whole * 1e6;
    this.int(whole);
    const p = this.pos;
    b[p] = 46;
    for (let i = p + 6; i > p; i--) {
      const q = (frac / 10) | 0;
      b[i] = 48 + (frac - q * 10);
      frac = q;
    }
    this.pos = p + 7;
  }
}
