// CPython 3.11's set of small non-negative ints, far enough to reproduce its
// iteration order: open addressing with linear probes and perturbation,
// dummy slots left by discards, and the same resize policy.
//
// The edge collapse sums face planes in the order the add-on's Python
// iterates `vf[a] | vf[b]`. Float addition is not associative, and the
// rounding decides ties between equally cheap collapses on flat roofs, so
// any other order gives a different (not worse, but different) cap. Keeping
// the order makes the port's caps match the add-on's bit for bit, and the
// add-on's validation on real cities carries over.

const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5;
const MINSIZE = 8;
const EMPTY = -1;
const DUMMY = -2;

export class PySet {
  keys: Int32Array;
  mask: number;
  fill = 0;
  used = 0;

  constructor(size = MINSIZE) {
    this.keys = new Int32Array(size).fill(EMPTY);
    this.mask = size - 1;
  }

  add(key: number): void {
    for (;;) {
      const mask = this.mask;
      const keys = this.keys;
      let i = key & mask;
      let freeslot = -1;
      let perturb = key;
      for (;;) {
        let entry = i;
        let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
        let found = -1;
        do {
          const k = keys[entry];
          if (k === EMPTY) {
            found = entry;
            break;
          }
          if (k === key) return;
          // 3.11 keeps the last dummy it passes, not the first.
          if (k === DUMMY) freeslot = entry;
          entry++;
        } while (probes-- > 0);
        if (found >= 0) {
          if (freeslot >= 0) {
            this.used++;
            keys[freeslot] = key;
            return;
          }
          this.fill++;
          this.used++;
          keys[found] = key;
          if (this.fill * 5 < mask * 3) return;
          this.resize(this.used > 50000 ? this.used * 2 : this.used * 4);
          return;
        }
        perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
        i = (i * 5 + 1 + perturb) & mask;
      }
    }
  }

  delete(key: number): void {
    const mask = this.mask;
    const keys = this.keys;
    let i = key & mask;
    let perturb = key;
    for (;;) {
      let entry = i;
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      do {
        const k = keys[entry];
        if (k === EMPTY) return;
        if (k === key) {
          keys[entry] = DUMMY;
          this.used--;
          return;
        }
        entry++;
      } while (probes-- > 0);
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  has(key: number): boolean {
    const mask = this.mask;
    const keys = this.keys;
    let i = key & mask;
    let perturb = key;
    for (;;) {
      let entry = i;
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      do {
        const k = keys[entry];
        if (k === EMPTY) return false;
        if (k === key) return true;
        entry++;
      } while (probes-- > 0);
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  get size(): number {
    return this.used;
  }

  /** Keys in CPython's iteration order. */
  *[Symbol.iterator](): IterableIterator<number> {
    const keys = this.keys;
    for (let i = 0; i <= this.mask; i++) if (keys[i] >= 0) yield keys[i];
  }

  values(): number[] {
    const out: number[] = [];
    const keys = this.keys;
    for (let i = 0; i <= this.mask; i++) if (keys[i] >= 0) out.push(keys[i]);
    return out;
  }

  clear(): void {
    this.keys = new Int32Array(MINSIZE).fill(EMPTY);
    this.mask = MINSIZE - 1;
    this.fill = 0;
    this.used = 0;
  }

  private insertClean(keys: Int32Array, mask: number, key: number): void {
    let i = key & mask;
    let perturb = key;
    for (;;) {
      if (keys[i] === EMPTY) {
        keys[i] = key;
        return;
      }
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 1; j <= LINEAR_PROBES; j++) {
          if (keys[i + j] === EMPTY) {
            keys[i + j] = key;
            return;
          }
        }
      }
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  resize(minused: number): void {
    let size = MINSIZE;
    while (size <= minused) size *= 2;
    // The small table with no dummies is left exactly as it is.
    if (size === MINSIZE && this.mask === MINSIZE - 1 && this.fill === this.used) return;
    const old = this.keys;
    const keys = new Int32Array(size).fill(EMPTY);
    for (let i = 0; i < old.length; i++) if (old[i] >= 0) this.insertClean(keys, size - 1, old[i]);
    this.keys = keys;
    this.mask = size - 1;
    this.fill = this.used;
  }

  /** set_merge: what `self |= other` and building `self | other` do. */
  merge(other: PySet): void {
    if (other === this || other.used === 0) return;
    if ((this.fill + other.used) * 5 >= this.mask * 3) this.resize((this.used + other.used) * 2);
    if (this.fill === 0 && this.mask === other.mask && other.fill === other.used) {
      this.keys.set(other.keys);
      this.fill = other.fill;
      this.used = other.used;
      return;
    }
    if (this.fill === 0) {
      this.fill = other.used;
      this.used = other.used;
      for (let i = 0; i <= other.mask; i++) if (other.keys[i] >= 0) this.insertClean(this.keys, this.mask, other.keys[i]);
      return;
    }
    for (let i = 0; i <= other.mask; i++) if (other.keys[i] >= 0) this.add(other.keys[i]);
  }

  /** A new set `a | b`, laid out as CPython lays it out. */
  static union(a: PySet, b: PySet): PySet {
    const out = new PySet();
    out.merge(a);
    if (b !== a) out.merge(b);
    return out;
  }
}
