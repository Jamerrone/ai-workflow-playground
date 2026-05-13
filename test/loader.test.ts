import { describe, it, expect } from "vitest";
import { buildRegistry, formatLoaderErrors } from "../src/index.js";
import type { LoaderInput } from "../src/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

function minimalValid(): LoaderInput {
  return buildTracerRegistry() as unknown as LoaderInput;
}

describe("Loader: tracer-bullet registry remains valid", () => {
  it("buildRegistry on the tracer registry produces ok=true with no errors and no warnings", () => {
    const result = buildRegistry(buildTracerRegistry());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
      // Validated registry contains the same towers (id-level parity).
      expect(Object.keys(result.registry.towers)).toEqual(["archer"]);
      expect(Object.keys(result.registry.maps)).toEqual(["tracer-map"]);
    }
  });
});

describe("Loader: error codes", () => {
  it("UNIT_SUFFIX_FORBIDDEN — field name ending with Ms", () => {
    const input: LoaderInput = {
      ...minimalValid(),
      towers: {
        archer: {
          cost: 50,
          attacks: [
            {
              id: "shot",
              stats: { range: 3, cooldownMs: 500 },
              effects: [{ kind: "damage" }],
            },
          ],
        },
      },
    };
    const result = buildRegistry(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("UNIT_SUFFIX_FORBIDDEN");
      const err = result.errors.find((e) => e.code === "UNIT_SUFFIX_FORBIDDEN")!;
      expect(err.path).toContain("cooldownMs");
    }
  });

  it("UNIT_SUFFIX_FORBIDDEN — every documented forbidden suffix triggers", () => {
    for (const suffix of ["Ms", "Sec", "PerSec", "Tiles", "Pixels"]) {
      const input: LoaderInput = {
        enemies: {
          grunt: {
            tags: ["ground"],
            stats: {
              hp: 10,
              speed: 1,
              baseDamage: 1,
              [`range${suffix}`]: 5,
            },
          },
        },
      };
      const r = buildRegistry(input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.some((e) => e.code === "UNIT_SUFFIX_FORBIDDEN")).toBe(true);
      }
    }
  });

  it("UNKNOWN_KIND — placementMode with unregistered kind", () => {
    const input: LoaderInput = {
      ...minimalValid(),
      maps: {
        "tracer-map": {
          width: 5,
          height: 1,
          paths: [{ id: "p1", kind: "ground", waypoints: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }],
          bases: [{ id: "b1", position: { x: 4, y: 0 } }],
          towerSlots: [{ x: 2, y: 0 }],
          placementMode: { kind: "magnetic" },
        },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((e) => e.code === "UNKNOWN_KIND");
      expect(e).toBeDefined();
      expect(e!.actual).toBe("magnetic");
    }
  });

  it("UNKNOWN_KIND — hint references the registering plugin when knownKindHints is supplied", () => {
    const input: LoaderInput = {
      ...minimalValid(),
      maps: {
        "tracer-map": {
          width: 5,
          height: 1,
          paths: [{ id: "p1", kind: "ground", waypoints: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }],
          bases: [{ id: "b1", position: { x: 4, y: 0 } }],
          towerSlots: [{ x: 2, y: 0 }],
          placementMode: { kind: "magnetic" },
        },
      },
    };
    const result = buildRegistry(input, {
      knownKindHints: new Map([["magnetic", "magnetic-placement-plugin"]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find((e) => e.code === "UNKNOWN_KIND")!;
      expect(e.hint).toContain("magnetic-placement-plugin");
    }
  });

  it("MISSING_REFERENCE — Scenario references unknown Map", () => {
    const reg = buildTracerRegistry();
    (reg.scenarios as any).tracer.map = "no-such-map";
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "MISSING_REFERENCE" && e.path.endsWith(".map"))).toBe(true);
    }
  });

  it("MISSING_REFERENCE — Wave references unknown Enemy", () => {
    const reg = buildTracerRegistry();
    (reg.waves as any).w1.groups[0].enemy = "ghost";
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "MISSING_REFERENCE" && e.path.endsWith(".enemy"))).toBe(true);
    }
  });

  it("MISSING_REFERENCE — Upgrade prerequisite missing", () => {
    const reg = buildTracerRegistry();
    (reg.upgrades as any).u1 = { tower: "archer", cost: 10, prerequisites: ["does-not-exist"] };
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "MISSING_REFERENCE" && e.path.includes("prerequisites"))).toBe(true);
    }
  });

  it("MISSING_REFERENCE — Upgrade effectId missing on Attack", () => {
    const reg = buildTracerRegistry();
    (reg.upgrades as any).u1 = {
      tower: "archer",
      cost: 10,
      ops: [{ kind: "attackMutation", effectId: "phantom-effect" }],
    };
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "MISSING_REFERENCE" && e.path.includes("effectId"))).toBe(true);
    }
  });

  it("MISSING_REFERENCE — Scenario references unknown Wave", () => {
    const reg = buildTracerRegistry();
    (reg.scenarios as any).tracer.waves = [{ id: "phantom-wave", pathBindings: {} }];
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "MISSING_REFERENCE" && e.actual === "phantom-wave")).toBe(true);
    }
  });

  it("MISSING_REFERENCE — Scenario references unknown Difficulty", () => {
    const reg = buildTracerRegistry();
    (reg.scenarios as any).tracer.difficulty = "impossible";
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "MISSING_REFERENCE" && e.path.endsWith(".difficulty"))).toBe(true);
    }
  });

  it("MISSING_REFERENCE — Scenario binds group to a non-existent Path", () => {
    const reg = buildTracerRegistry();
    (reg.scenarios as any).tracer.waves[0].pathBindings = { g1: "phantom-path" };
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "MISSING_REFERENCE" && e.path.includes("pathBindings"))).toBe(true);
    }
  });

  it("INVALID_FIELD — Map missing 'width'", () => {
    const reg = buildTracerRegistry();
    delete (reg.maps as any)["tracer-map"].width;
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "INVALID_FIELD" && e.path.endsWith(".width"))).toBe(true);
    }
  });

  it("INVALID_FIELD — diagonal waypoints rejected", () => {
    const reg = buildTracerRegistry();
    (reg.maps as any)["tracer-map"].paths[0].waypoints = [{ x: 0, y: 0 }, { x: 4, y: 3 }];
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((e) => e.code === "INVALID_FIELD" && e.path.includes("waypoints"));
      expect(e).toBeDefined();
      expect(e!.message.toLowerCase()).toContain("diagonal");
    }
  });

  it("INHERITANCE_CYCLE — two enemies extending each other", () => {
    const input: LoaderInput = {
      enemies: {
        a: { extends: "b", stats: { hp: 1, speed: 1, baseDamage: 1 } },
        b: { extends: "a", stats: { hp: 1, speed: 1, baseDamage: 1 } },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "INHERITANCE_CYCLE")).toBe(true);
    }
  });

  it("CROSS_KIND_INHERITANCE — a tower extends from an enemy template", () => {
    const input: LoaderInput = {
      enemies: { base: { abstract: true, stats: { hp: 1, speed: 1, baseDamage: 1 } } },
      towers: {
        archer: {
          extends: "enemies:base",
          cost: 50,
          attacks: [
            { id: "shot", stats: { range: 3, cooldown: 0.5 }, effects: [{ kind: "damage" }] },
          ],
        },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "CROSS_KIND_INHERITANCE")).toBe(true);
    }
  });

  it("ABSTRACT_REFERENCED — Scenario references an abstract Map", () => {
    const reg = buildTracerRegistry();
    (reg.maps as any)["tracer-map"].abstract = true;
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "ABSTRACT_REFERENCED")).toBe(true);
    }
  });

  it("PATH_BINDING_TAG_MISMATCH — enemy lacks the path's kind tag", () => {
    const reg = buildTracerRegistry();
    (reg.enemies as any).grunt.tags = ["aerial"]; // path is ground
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "PATH_BINDING_TAG_MISMATCH")).toBe(true);
    }
  });

  it("REGISTRY_REPLACEMENT — warning when a plugin replaces a kind another plugin registered", () => {
    const result = buildRegistry(buildTracerRegistry(), {
      pluginManifest: [
        { plugin: "built-in-reward-kinds", registry: "rewardKind", kind: "gold-on-kill" },
        { plugin: "balance-mod", registry: "rewardKind", kind: "gold-on-kill" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const w = result.warnings.find((w) => w.code === "REGISTRY_REPLACEMENT");
      expect(w).toBeDefined();
      expect(w!.message).toContain("balance-mod");
      expect(w!.message).toContain("built-in-reward-kinds");
    }
  });
});

describe("Loader: error collection", () => {
  it("collects ALL errors in one pass — 20 distinct defects produce 20 entries", () => {
    const input: LoaderInput = {
      enemies: {} as Record<string, unknown>,
    };
    for (let i = 0; i < 20; i++) {
      (input.enemies as any)[`e${i}`] = {
        stats: { hp: 1, speed: 1, [`baseDamageMs`]: 1 }, // 20× UNIT_SUFFIX_FORBIDDEN
      };
    }
    const r = buildRegistry(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const units = r.errors.filter((e) => e.code === "UNIT_SUFFIX_FORBIDDEN");
      expect(units.length).toBe(20);
    }
  });

  it("skips errored entries but continues validating subsequent entries", () => {
    const input: LoaderInput = {
      enemies: {
        bad: { stats: { hp: 1, speed: 1, baseDamageMs: 1 } }, // UNIT_SUFFIX_FORBIDDEN
        good: { tags: ["ground"], stats: { hp: 10, speed: 1, baseDamage: 1 } },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Both entries were visited even though 'bad' has an error.
      expect(r.errors.length).toBe(1);
      expect(r.errors[0]!.code).toBe("UNIT_SUFFIX_FORBIDDEN");
    }
  });
});

describe("Loader: strict mode", () => {
  it("strict: true promotes warnings into errors and flips ok to false", () => {
    const result = buildRegistry(buildTracerRegistry(), {
      strict: true,
      pluginManifest: [
        { plugin: "p1", registry: "rewardKind", kind: "gold-on-kill" },
        { plugin: "p2", registry: "rewardKind", kind: "gold-on-kill" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const promoted = result.errors.find((e) => e.code === "REGISTRY_REPLACEMENT");
      expect(promoted).toBeDefined();
      expect(promoted!.severity).toBe("error");
    }
  });

  it("strict: true is a no-op when there are no warnings", () => {
    const result = buildRegistry(buildTracerRegistry(), { strict: true });
    expect(result.ok).toBe(true);
  });
});

describe("Loader: template inheritance", () => {
  it("deep-merge of nested objects", () => {
    const input: LoaderInput = {
      enemies: {
        base: { abstract: true, stats: { hp: 100, speed: 2, baseDamage: 1 }, tags: ["ground"] },
        elite: { extends: "base", stats: { hp: 200 } },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const elite = r.registry.enemies.elite as { stats: { hp: number; speed: number } };
      expect(elite.stats.hp).toBe(200);
      expect(elite.stats.speed).toBe(2);
    }
  });

  it("merge-by-id of keyed arrays", () => {
    const input: LoaderInput = {
      towers: {
        base: {
          abstract: true,
          cost: 50,
          attacks: [
            { id: "shot", stats: { range: 3, cooldown: 1 }, effects: [{ kind: "damage", stats: { amount: 5 } }] },
          ],
        },
        archer: {
          extends: "base",
          attacks: [
            { id: "shot", stats: { cooldown: 0.5 } },
          ],
        },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const archer = r.registry.towers.archer as { attacks: Array<{ id: string; stats: { cooldown: number; range: number } }> };
      expect(archer.attacks).toHaveLength(1);
      expect(archer.attacks[0]!.stats.cooldown).toBe(0.5);
      expect(archer.attacks[0]!.stats.range).toBe(3);
    }
  });

  it("plain arrays replace entirely", () => {
    const input: LoaderInput = {
      enemies: {
        base: { abstract: true, stats: { hp: 1, speed: 1, baseDamage: 1 }, tags: ["ground", "fast"] },
        child: { extends: "base", tags: ["ground"] },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const child = r.registry.enemies.child as { tags: string[] };
      expect(child.tags).toEqual(["ground"]);
    }
  });

  it("multi-parent ordered overlay — later parent overrides earlier", () => {
    const input: LoaderInput = {
      enemies: {
        a: { abstract: true, stats: { hp: 10, speed: 1, baseDamage: 1 }, tags: ["ground"] },
        b: { abstract: true, stats: { hp: 20, speed: 2, baseDamage: 2 }, tags: ["ground"] },
        child: { extends: ["a", "b"] },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const child = r.registry.enemies.child as { stats: { hp: number; speed: number } };
      expect(child.stats.hp).toBe(20);
      expect(child.stats.speed).toBe(2);
    }
  });

  it("abstract templates do not appear in the validated registry", () => {
    const input: LoaderInput = {
      enemies: {
        base: { abstract: true, stats: { hp: 1, speed: 1, baseDamage: 1 } },
        concrete: { extends: "base", tags: ["ground"], stats: { hp: 1, speed: 1, baseDamage: 1 } },
      },
    };
    const r = buildRegistry(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.registry.enemies)).toEqual(["concrete"]);
    }
  });
});

describe("Loader: string-shorthand normalisation", () => {
  it("normalises a string strategy to { kind: ... } before validation", () => {
    const reg = buildTracerRegistry();
    (reg.towers as any).archer.targeting = "closest-to-base"; // string shorthand
    const r = buildRegistry(reg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const archer = r.registry.towers.archer as { targeting: { kind: string } };
      expect(archer.targeting).toEqual({ kind: "closest-to-base" });
    }
  });

  it("normalises a string placementMode to { kind: ... }", () => {
    const reg = buildTracerRegistry();
    (reg.maps as any)["tracer-map"].placementMode = "fixed";
    const r = buildRegistry(reg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const map = r.registry.maps["tracer-map"] as { placementMode: { kind: string } };
      expect(map.placementMode).toEqual({ kind: "fixed" });
    }
  });
});

describe("Loader: default formatter", () => {
  it("formatLoaderErrors renders code, path, message, and hint", () => {
    const r = buildRegistry({
      maps: {
        m1: {
          width: 1,
          height: 1,
          paths: [],
          bases: [],
          placementMode: { kind: "magnetic" },
        },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const out = formatLoaderErrors(r.errors);
      expect(out).toContain("UNKNOWN_KIND");
      expect(out).toContain("maps.m1.placementMode.kind");
      expect(out.toLowerCase()).toContain("magnetic");
    }
  });
});
