export interface Rng {
  nextUint32(): number;
  nextFloat(): number;
}

function splitmix32(seed: number): number {
  let z = (seed + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

function hashSystemId(id: string): number {
  // FNV-1a 32-bit. Stable across environments.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function spawnSubStream(masterSeed: number, systemId: string): Rng {
  const mixed = splitmix32((masterSeed ^ hashSystemId(systemId)) >>> 0);
  return mulberry32(mixed);
}

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    nextUint32,
    nextFloat: () => nextUint32() / 0x1_0000_0000,
  };
}
