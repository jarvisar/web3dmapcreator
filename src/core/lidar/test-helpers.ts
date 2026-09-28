// numpy.random.default_rng for tests ported from the add-on, so their random
// clouds are the same numbers the thresholds were tuned on: SeedSequence
// into PCG64 (XSL-RR), and random() as numpy draws it.

const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const MULTIPLIER = (2549297995355413924n << 64n) + 4865540595714422341n;

const INIT_A = 0x43b0d7e5;
const MULT_A = 0x931e8875;
const INIT_B = 0x8b51f9dd;
const MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd;
const MIX_MULT_R = 0x4973f715;

const mul32 = (a: number, b: number) => Math.imul(a, b) >>> 0;

function seedPool(seed: number): number[] {
  let hashConst = INIT_A;
  const hashmix = (value: number) => {
    value = (value ^ hashConst) >>> 0;
    hashConst = mul32(hashConst, MULT_A);
    value = mul32(value, hashConst);
    return (value ^ (value >>> 16)) >>> 0;
  };
  const mix = (x: number, y: number) => {
    const r = (mul32(MIX_MULT_L, x) - mul32(MIX_MULT_R, y)) >>> 0;
    return (r ^ (r >>> 16)) >>> 0;
  };
  const entropy = [seed >>> 0];
  const pool = [0, 0, 0, 0].map((_, i) => hashmix(i < entropy.length ? entropy[i] : 0));
  for (let src = 0; src < 4; src++) {
    for (let dst = 0; dst < 4; dst++) if (src !== dst) pool[dst] = mix(pool[dst], hashmix(pool[src]));
  }
  return pool;
}

function generateState(pool: number[], words64: number): bigint[] {
  let hashConst = INIT_B;
  const words: number[] = [];
  for (let i = 0; i < words64 * 2; i++) {
    let value = (pool[i % pool.length] ^ hashConst) >>> 0;
    hashConst = mul32(hashConst, MULT_B);
    value = mul32(value, hashConst);
    words.push((value ^ (value >>> 16)) >>> 0);
  }
  const out: bigint[] = [];
  for (let i = 0; i < words64; i++) out.push((BigInt(words[2 * i + 1]) << 32n) | BigInt(words[2 * i]));
  return out;
}

export class NumpyRandom {
  private state: bigint;
  private readonly inc: bigint;

  constructor(seed: number) {
    const [s0, s1, i0, i1] = generateState(seedPool(seed), 4);
    this.inc = ((((i0 << 64n) | i1) << 1n) | 1n) & MASK128;
    this.state = 0n;
    this.step();
    this.state = (this.state + ((s0 << 64n) | s1)) & MASK128;
    this.step();
  }

  private step(): void {
    this.state = (this.state * MULTIPLIER + this.inc) & MASK128;
  }

  nextUint64(): bigint {
    this.step();
    const value = ((this.state >> 64n) ^ this.state) & MASK64;
    const rot = Number(this.state >> 122n);
    return ((value >> BigInt(rot)) | (value << BigInt((64 - rot) & 63))) & MASK64;
  }

  random(): number {
    return Number(this.nextUint64() >> 11n) * (1 / 9007199254740992);
  }

  /** numpy's uniform(low, high, size), in C order. */
  uniform(low: number, high: number, size = 1): number[] {
    const out: number[] = [];
    for (let i = 0; i < size; i++) out.push(low + (high - low) * this.random());
    return out;
  }
}

/**
 * numpy.arange for floats: not a running sum, and not start + k * step
 * either. numpy fills start + k * delta with delta = (start + step) - start,
 * which can differ from step in the last bit.
 */
export function arange(start: number, stop: number, step: number): number[] {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  const second = start + step;
  const delta = second - start;
  return Array.from({ length: n }, (_, k) => (k === 0 ? start : k === 1 ? second : start + k * delta));
}
