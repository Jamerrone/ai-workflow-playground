import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDemo } from "../demos/cli/main.js";

const DATA_DIR = resolve(__dirname, "..", "demos", "shared-data");

describe("Slice 16: Node CLI reference demo", () => {
  let snapshotDir: string;
  beforeAll(() => {
    snapshotDir = mkdtempSync(join(tmpdir(), "demo-cli-snapshots-"));
  });
  afterAll(() => {
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  it("plays the shared scenario to a win and writes one snapshot per tick", () => {
    const outcome = runDemo({ dataDir: DATA_DIR, snapshotDir });
    expect(outcome.won).toBe(true);
    expect(outcome.lost).toBe(false);
    expect(outcome.tickIndex).toBeGreaterThan(0);
    expect(outcome.snapshotCount).toBe(outcome.tickIndex);

    const files = readdirSync(snapshotDir).filter((f) => f.startsWith("tick-"));
    expect(files.length).toBe(outcome.snapshotCount);
    // Snapshots sort lexicographically in tick order thanks to 4-digit padding.
    const sorted = [...files].sort();
    expect(sorted[0]).toBe("tick-0000.json");
  });
});

describe("Slice 16: shared-data set", () => {
  it("contains the expected file layout", () => {
    for (const path of [
      "maps/twin-pass.json",
      "towers/archer.json",
      "towers/mortar.json",
      "towers/anti-air.json",
      "towers/barracks.json",
      "enemies/grunt.json",
      "enemies/bat.json",
      "summons/guard-footman.json",
      "waves/wave-1.json",
      "waves/wave-2.json",
      "waves/wave-3.json",
      "scenarios/defend-the-pass.json",
      "upgrades/archer-power.json",
      "difficulties/standard.json",
      "transcript.json",
    ]) {
      expect(existsSync(join(DATA_DIR, path))).toBe(true);
    }
  });

  it("covers the slice-3/6/7/8/9/10/11/12/13 surfaces in the scenario", () => {
    const scenario = JSON.parse(
      readFileSync(join(DATA_DIR, "scenarios", "defend-the-pass.json"), "utf8"),
    ) as Record<string, unknown>;
    const map = JSON.parse(
      readFileSync(join(DATA_DIR, "maps", "twin-pass.json"), "utf8"),
    ) as Record<string, unknown>;
    const transcript = JSON.parse(
      readFileSync(join(DATA_DIR, "transcript.json"), "utf8"),
    ) as { actions: Array<[number, { kind: string }]> };
    const mortar = JSON.parse(
      readFileSync(join(DATA_DIR, "towers", "mortar.json"), "utf8"),
    ) as { attacks: Array<{ effects: Array<{ kind: string }> }> };
    const bat = JSON.parse(
      readFileSync(join(DATA_DIR, "enemies", "bat.json"), "utf8"),
    ) as { tags: string[] };

    // Slice 3: mortar mounts multiple effect kinds on a single attack.
    const mortarEffectKinds = mortar.attacks[0]!.effects.map((e) => e.kind);
    expect(mortarEffectKinds).toEqual(
      expect.arrayContaining(["damage", "splash", "slow"]),
    );

    // Slice 6 (upgrades), 7 (sellTower), 11 (overrideTargeting), 13 (moveRallyPoint)
    // — each demonstrated by an action kind in the transcript.
    const actionKinds = new Set(transcript.actions.map(([, a]) => a.kind));
    for (const kind of [
      "placeTower",
      "purchaseUpgrade",
      "sellTower",
      "overrideTargeting",
      "moveRallyPoint",
    ]) {
      expect(actionKinds.has(kind)).toBe(true);
    }

    // Slice 8: multiple waves with auto trigger (slice 9).
    expect((scenario.waves as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect((scenario.waveTrigger as { kind: string }).kind).toBe("auto");

    // Slice 10: free placement + blocked regions.
    expect((map.placementMode as { kind: string }).kind).toBe("free");
    expect((map.blockedRegions as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Slice 11: multi-path map.
    expect((map.paths as unknown[]).length).toBeGreaterThanOrEqual(2);

    // Slice 12: aerial enemy archetype carrying the flying tag.
    expect(bat.tags).toContain("flying");
  });

  it("grunt enemy carries an attacks array (regression: enemy with attacks broke the CLI demo)", () => {
    const grunt = JSON.parse(
      readFileSync(join(DATA_DIR, "enemies", "grunt.json"), "utf8"),
    ) as { attacks?: unknown[] };
    expect(Array.isArray(grunt.attacks)).toBe(true);
    expect(grunt.attacks!.length).toBeGreaterThan(0);
  });
});
