// Small seeded RNG so games (and tests) are reproducible from a seed.

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  binomial(n: number, p: number): number;
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    binomial: (n, p) => {
      let x = 0;
      for (let i = 0; i < n; i++) if (next() < p) x++;
      return x;
    },
    weighted: (items, weight) => {
      const total = items.reduce((s, it) => s + weight(it), 0);
      let r = next() * total;
      for (const it of items) {
        r -= weight(it);
        if (r <= 0) return it;
      }
      return items[items.length - 1];
    },
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}
