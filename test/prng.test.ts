import { describe, it, expect } from "vitest";
import { mulberry32, spawnSubStream } from "../src/kernel/prng.js";

describe("mulberry32", () => {
  it("produces byte-identical uint32 sequence for the same seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const aSeq = Array.from({ length: 10 }, () => a.nextUint32());
    const bSeq = Array.from({ length: 10 }, () => b.nextUint32());
    expect(aSeq).toEqual(bSeq);
  });

  it("produces a different sequence for a different seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(54321);
    expect(a.nextUint32()).not.toEqual(b.nextUint32());
  });

  it("spawns deterministic sub-streams keyed on (master, systemId)", () => {
    const a = spawnSubStream(42, "combat/fire");
    const b = spawnSubStream(42, "combat/fire");
    const c = spawnSubStream(42, "movement/enemyWalk");
    const aSeq = Array.from({ length: 5 }, () => a.nextUint32());
    const bSeq = Array.from({ length: 5 }, () => b.nextUint32());
    const cSeq = Array.from({ length: 5 }, () => c.nextUint32());
    expect(aSeq).toEqual(bSeq);
    expect(aSeq).not.toEqual(cSeq);
  });

  it("sub-streams from different master seeds diverge even for the same systemId", () => {
    const a = spawnSubStream(1, "combat/fire");
    const b = spawnSubStream(2, "combat/fire");
    expect(a.nextUint32()).not.toEqual(b.nextUint32());
  });

  it("pins the canonical mulberry32 sequence for seed 1", () => {
    // Pinned to detect accidental algorithm drift. These values are the
    // engine's determinism contract — changing them breaks every saved
    // transcript ever recorded.
    const expected = [2693262067, 11749833, 2265367787, 4213581821];
    const rng = mulberry32(1);
    const actual = Array.from({ length: 4 }, () => rng.nextUint32());
    expect(actual).toEqual(expected);
  });
});
