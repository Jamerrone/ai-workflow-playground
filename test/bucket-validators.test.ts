import { describe, it, expect } from "vitest";
import {
  buildRegistry,
  builtInBundle,
  collectBucketValidators,
} from "../src/index.js";
import type {
  BucketValidatorContext,
  LoaderInput,
  Plugin,
} from "../src/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

// Validator registration plumbing — the asymmetry US #47 closes. Built-in
// buckets register through the same API a third-party plugin would; the
// Loader's per-entry dispatch is driven by data, not a hardcoded switch.

describe("Loader: bucket validator registry", () => {
  it("a third-party plugin can register a custom bucket validator that the Loader invokes per entry", () => {
    const calls: string[] = [];
    const heroesPlugin: Plugin = {
      id: "test/heroes",
      register(api) {
        api.registerBucketValidator({
          bucket: "heroes",
          validate(ctx: BucketValidatorContext) {
            calls.push(ctx.id);
            if (typeof ctx.entry.power !== "number") {
              ctx.addError({
                severity: "error",
                code: "INVALID_FIELD",
                path: `${ctx.path}.power`,
                message: `Hero '${ctx.id}' is missing 'power'.`,
                expected: "number",
                actual: typeof ctx.entry.power,
              });
            }
          },
        });
      },
    };

    const validators = collectBucketValidators([...builtInBundle, heroesPlugin]);

    // The tracer registry stays valid; we layer a `heroes` bucket on top.
    const input = {
      ...buildTracerRegistry(),
      heroes: {
        arthas: { power: 10 },
        jaina: {}, // missing 'power' — triggers the custom validator's error
      },
    } as unknown as LoaderInput;

    const r = buildRegistry(input, { bucketValidators: validators });

    // The custom validator ran for every heroes entry — collect-all (ADR-0013).
    expect(calls.sort()).toEqual(["arthas", "jaina"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.path === "heroes.jaina.power");
      expect(err).toBeDefined();
      expect(err!.code).toBe("INVALID_FIELD");
    }
  });

  it("warnings from a custom bucket validator land in result.warnings (not errors)", () => {
    const heroesPlugin: Plugin = {
      id: "test/heroes-warnings",
      register(api) {
        api.registerBucketValidator({
          bucket: "heroes",
          validate(ctx) {
            ctx.addWarning({
              severity: "warning",
              code: "CUSTOM_HERO_HINT",
              path: ctx.path,
              message: `Hero '${ctx.id}' visited.`,
            });
          },
        });
      },
    };
    const validators = collectBucketValidators([...builtInBundle, heroesPlugin]);
    const input = {
      ...buildTracerRegistry(),
      heroes: { arthas: {} },
    } as unknown as LoaderInput;
    const r = buildRegistry(input, { bucketValidators: validators });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.code === "CUSTOM_HERO_HINT")).toBe(true);
    }
  });

  it("built-in bucket validators are contributed by built-in plugins — collectBucketValidators returns them", () => {
    // Every built-in bucket (Map, Tower, Enemy, Wave, Scenario, Upgrade) is
    // populated by registerBucketValidator on the standard plugin surface.
    const validators = collectBucketValidators(builtInBundle);
    for (const bucket of ["maps", "towers", "enemies", "waves", "scenarios", "upgrades"]) {
      expect(validators.has(bucket)).toBe(true);
    }
  });

  it("tower with meta.symbol string is accepted by the built-in validator", () => {
    const validators = collectBucketValidators(builtInBundle);
    const input = {
      ...buildTracerRegistry(),
      towers: {
        "archer": {
          cost: 50,
          attacks: [{ id: "shot", stats: { range: 3, cooldown: 0.5 }, effects: [{ kind: "damage", stats: { amount: 10 } }] }],
          meta: { name: "Archer Tower", symbol: "A" },
        },
      },
    } as unknown as LoaderInput;
    const r = buildRegistry(input, { bucketValidators: validators });
    expect(r.ok).toBe(true);
  });

  it("enemy with meta.symbol string is accepted by the built-in validator", () => {
    const validators = collectBucketValidators(builtInBundle);
    const input = {
      ...buildTracerRegistry(),
      enemies: {
        grunt: { tags: ["ground"], stats: { hp: 10, speed: 1, baseDamage: 1 }, killReward: 5, meta: { name: "Grunt", symbol: "G" } },
      },
    } as unknown as LoaderInput;
    const r = buildRegistry(input, { bucketValidators: validators });
    expect(r.ok).toBe(true);
  });

  it("tower with non-string meta.symbol triggers INVALID_FIELD error", () => {
    const validators = collectBucketValidators(builtInBundle);
    const input = {
      ...buildTracerRegistry(),
      towers: {
        "archer": {
          cost: 50,
          attacks: [{ id: "shot", stats: { range: 3, cooldown: 0.5 }, effects: [{ kind: "damage", stats: { amount: 10 } }] }],
          meta: { name: "Archer Tower", symbol: 42 },
        },
      },
    } as unknown as LoaderInput;
    const r = buildRegistry(input, { bucketValidators: validators });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.path === "towers.archer.meta.symbol");
      expect(err).toBeDefined();
      expect(err!.code).toBe("INVALID_FIELD");
    }
  });

  it("enemy with non-string meta.symbol triggers INVALID_FIELD error", () => {
    const validators = collectBucketValidators(builtInBundle);
    const input = {
      ...buildTracerRegistry(),
      enemies: {
        grunt: { tags: ["ground"], stats: { hp: 10, speed: 1, baseDamage: 1 }, killReward: 5, meta: { name: "Grunt", symbol: 99 } },
      },
    } as unknown as LoaderInput;
    const r = buildRegistry(input, { bucketValidators: validators });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.path === "enemies.grunt.meta.symbol");
      expect(err).toBeDefined();
      expect(err!.code).toBe("INVALID_FIELD");
    }
  });

  it("a custom bucket's validator can read cross-bucket data via ctx.input", () => {
    // Exercises that the BucketValidatorContext carries the full LoaderInput so
    // custom validators can do their own cross-bucket reference checks.
    const heroesPlugin: Plugin = {
      id: "test/heroes-cross-bucket",
      register(api) {
        api.registerBucketValidator({
          bucket: "heroes",
          validate(ctx) {
            const towerId = (ctx.entry as { tower?: unknown }).tower;
            if (typeof towerId !== "string") return;
            const towers = (ctx.input.towers ?? {}) as Record<string, unknown>;
            if (!(towerId in towers)) {
              ctx.addError({
                severity: "error",
                code: "MISSING_REFERENCE",
                path: `${ctx.path}.tower`,
                message: `Hero '${ctx.id}' references unknown tower '${towerId}'.`,
              });
            }
          },
        });
      },
    };
    const validators = collectBucketValidators([...builtInBundle, heroesPlugin]);
    const input = {
      ...buildTracerRegistry(),
      heroes: { arthas: { tower: "no-such-tower" } },
    } as unknown as LoaderInput;
    const r = buildRegistry(input, { bucketValidators: validators });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find(
        (e) => e.code === "MISSING_REFERENCE" && e.path === "heroes.arthas.tower",
      );
      expect(err).toBeDefined();
    }
  });
});
