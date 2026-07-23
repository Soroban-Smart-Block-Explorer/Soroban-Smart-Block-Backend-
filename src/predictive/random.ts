export interface RandomSource {
  /** Uniform random value in [0, 1). */
  next(): number;
}

export const mathRandomSource: RandomSource = {
  next: () => Math.random(),
};

/** Deterministic PRNG (mulberry32) for reproducible simulations. */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Build a fixed-length synthetic series from a seed (used for training/fallback data). */
export function generateDeterministicSeries(length: number, seed: number): number[] {
  const rng = createSeededRandom(seed);
  return Array.from({ length }, () => 1000 + rng.next() * 500);
}
