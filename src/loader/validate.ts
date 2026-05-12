import { isObject } from "./normalize.js";
import type { LoaderError, LoaderInput, LoaderOptions } from "./types.js";
import { BUCKETS } from "./types.js";

// Field-name suffixes forbidden by ADR-0004 (canonical-units doctrine).
const FORBIDDEN_SUFFIXES = ["Ms", "Sec", "PerSec", "Tiles", "Pixels", "WorldUnits"] as const;

// `kind` values known to the built-in plugin bundle at the time of this slice. Future
// slices add to this list (and Plugin authors contribute their own via knownKindHints).
const BUILTIN_KINDS = new Map<string, ReadonlySet<string>>([
  ["placementMode", new Set(["fixed", "free"])],
  ["waveTrigger", new Set(["manual", "auto", "hybrid"])],
  ["targeting", new Set(["closest-to-base", "lowest-hp", "highest-hp", "tag-priority"])],
  ["strategy", new Set(["closest-to-base", "lowest-hp", "highest-hp", "tag-priority"])],
  ["attackEffect", new Set(["damage", "splash", "slow", "dot", "pierce", "bounce", "line-pierce", "minimum-range", "target-count", "projectile-count", "heal"])],
  ["upgradeOp", new Set(["stat", "attackMutation", "guardModifier"])],
  ["mapFeature", new Set(["blocked-region"])],
  ["rewardKind", new Set(["gold-on-kill", "sell-value", "wave-clear"])],
]);

export interface ValidationContext {
  readonly input: LoaderInput;
  readonly options: LoaderOptions;
  readonly errors: LoaderError[];
  readonly warnings: LoaderError[];
  readonly abstractIds: ReadonlyMap<string, ReadonlySet<string>>;
}

export function validateAll(ctx: ValidationContext): void {
  checkUnitSuffixesEverywhere(ctx);
  for (const bucket of BUCKETS) {
    const entries = ctx.input[bucket];
    if (!entries) continue;
    for (const [id, entry] of Object.entries(entries)) {
      validateEntry(ctx, bucket, id, entry);
    }
  }
}

function checkUnitSuffixesEverywhere(ctx: ValidationContext): void {
  for (const bucket of BUCKETS) {
    const entries = ctx.input[bucket];
    if (!entries) continue;
    for (const [id, entry] of Object.entries(entries)) {
      walkFieldNames(entry, `${bucket}.${id}`, (fieldName, path) => {
        for (const suffix of FORBIDDEN_SUFFIXES) {
          // Suffix match must be at the end and capitalised (e.g. "cooldownMs" not "demos").
          if (
            fieldName.length > suffix.length &&
            fieldName.endsWith(suffix) &&
            // The char before the suffix must be lowercase to avoid false-positive matches
            // against words that happen to end in those letters (e.g. "rangeTiles" ✓; "antiles" ✗).
            isLowerCase(fieldName[fieldName.length - suffix.length - 1]!)
          ) {
            ctx.errors.push({
              severity: "error",
              code: "UNIT_SUFFIX_FORBIDDEN",
              path,
              message: `Field name '${fieldName}' uses a forbidden unit suffix '${suffix}'.`,
              expected: "no unit suffix; canonical units (seconds, tiles, 0-1 ratios)",
              actual: fieldName,
              hint: "Rename the field; all engine quantities use canonical units (see ADR-0004).",
            });
            break;
          }
        }
      });
    }
  }
}

function isLowerCase(c: string): boolean {
  return c >= "a" && c <= "z";
}

function walkFieldNames(
  node: unknown,
  path: string,
  visit: (fieldName: string, path: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkFieldNames(item, `${path}[${i}]`, visit));
    return;
  }
  if (!isObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    visit(k, `${path}.${k}`);
    walkFieldNames(v, `${path}.${k}`, visit);
  }
}

function validateEntry(
  ctx: ValidationContext,
  bucket: string,
  id: string,
  raw: unknown,
): void {
  if (!isObject(raw)) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${bucket}.${id}`,
      message: `Entry '${id}' in ${bucket} is not an object.`,
      expected: "object",
      actual: typeof raw,
    });
    return;
  }
  switch (bucket) {
    case "maps":
      return validateMap(ctx, id, raw);
    case "towers":
      return validateTower(ctx, id, raw);
    case "enemies":
      return validateEnemy(ctx, id, raw);
    case "waves":
      return validateWave(ctx, id, raw);
    case "scenarios":
      return validateScenario(ctx, id, raw);
    case "upgrades":
      return validateUpgrade(ctx, id, raw);
    default:
      return;
  }
}

function validateMap(ctx: ValidationContext, id: string, raw: Record<string, unknown>): void {
  const path = `maps.${id}`;
  requireNumber(ctx, raw, "width", path);
  requireNumber(ctx, raw, "height", path);
  requireArray(ctx, raw, "paths", path);
  requireArray(ctx, raw, "bases", path);
  if (!isObject(raw.placementMode)) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.placementMode`,
      message: `Map '${id}' is missing 'placementMode'.`,
      expected: "{ kind: ... }",
      actual: String(raw.placementMode),
    });
  } else {
    checkKind(ctx, "placementMode", raw.placementMode, `${path}.placementMode`);
  }
  if (Array.isArray(raw.paths)) {
    raw.paths.forEach((p, i) => {
      if (!isObject(p)) return;
      const wps = p.waypoints;
      if (!Array.isArray(wps)) return;
      for (let j = 1; j < wps.length; j++) {
        const a = wps[j - 1];
        const b = wps[j];
        if (!isObject(a) || !isObject(b)) continue;
        const dx = (b.x as number) - (a.x as number);
        const dy = (b.y as number) - (a.y as number);
        if (dx !== 0 && dy !== 0) {
          ctx.errors.push({
            severity: "error",
            code: "INVALID_FIELD",
            path: `${path}.paths[${i}].waypoints[${j}]`,
            message: `Consecutive waypoints must differ on exactly one axis; got diagonal step.`,
            expected: "axis-aligned step (dx==0 XOR dy==0)",
            actual: `(${dx},${dy})`,
            hint: "Break the diagonal into two waypoints.",
          });
        }
      }
    });
  }
}

function validateTower(ctx: ValidationContext, id: string, raw: Record<string, unknown>): void {
  const path = `towers.${id}`;
  requireNumber(ctx, raw, "cost", path);
  requireArray(ctx, raw, "attacks", path);
  if (Array.isArray(raw.attacks)) {
    const seenIds = new Set<string>();
    raw.attacks.forEach((atk, i) => {
      if (!isObject(atk)) return;
      const atkPath = `${path}.attacks[${i}]`;
      if (typeof atk.id !== "string") {
        ctx.errors.push({
          severity: "error",
          code: "INVALID_FIELD",
          path: `${atkPath}.id`,
          message: `Attack missing 'id'.`,
          expected: "string",
          actual: typeof atk.id,
        });
      } else if (seenIds.has(atk.id)) {
        ctx.errors.push({
          severity: "error",
          code: "INVALID_FIELD",
          path: `${atkPath}.id`,
          message: `Duplicate Attack id '${atk.id}' on tower '${id}'.`,
        });
      } else {
        seenIds.add(atk.id);
      }
      if (Array.isArray(atk.effects)) {
        atk.effects.forEach((eff, j) => {
          if (!isObject(eff)) return;
          const effPath = `${atkPath}.effects[${j}]`;
          checkKind(ctx, "attackEffect", eff, effPath);
          validateAttackEffectFields(ctx, eff, effPath);
        });
      }
    });
  }
  if (raw.targeting !== undefined && isObject(raw.targeting)) {
    checkKind(ctx, "targeting", raw.targeting, `${path}.targeting`);
  }
}

function validateEnemy(ctx: ValidationContext, id: string, raw: Record<string, unknown>): void {
  const path = `enemies.${id}`;
  if (!isObject(raw.stats)) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.stats`,
      message: `Enemy '${id}' is missing 'stats'.`,
      expected: "object",
      actual: String(raw.stats),
    });
  }
  if (raw.tags !== undefined && !Array.isArray(raw.tags)) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.tags`,
      message: `Enemy '${id}' field 'tags' must be an array of strings.`,
      expected: "string[]",
      actual: typeof raw.tags,
    });
  }
}

function validateWave(ctx: ValidationContext, id: string, raw: Record<string, unknown>): void {
  const path = `waves.${id}`;
  requireArray(ctx, raw, "groups", path);
  if (Array.isArray(raw.groups)) {
    raw.groups.forEach((g, i) => {
      if (!isObject(g)) return;
      const gPath = `${path}.groups[${i}]`;
      if (typeof g.id !== "string") {
        ctx.errors.push({
          severity: "error",
          code: "INVALID_FIELD",
          path: `${gPath}.id`,
          message: `WaveGroup missing 'id'.`,
        });
      }
      if (typeof g.enemy !== "string") {
        ctx.errors.push({
          severity: "error",
          code: "INVALID_FIELD",
          path: `${gPath}.enemy`,
          message: `WaveGroup missing 'enemy' reference.`,
        });
      }
    });
  }
}

function validateScenario(ctx: ValidationContext, id: string, raw: Record<string, unknown>): void {
  const path = `scenarios.${id}`;
  if (typeof raw.map !== "string") {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.map`,
      message: `Scenario '${id}' is missing 'map'.`,
      expected: "string (map id)",
      actual: typeof raw.map,
    });
  }
  if (!Array.isArray(raw.waves)) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.waves`,
      message: `Scenario '${id}' is missing 'waves'.`,
      expected: "array of { id, pathBindings? }",
      actual: typeof raw.waves,
    });
  }
  if (raw.waveTrigger !== undefined && isObject(raw.waveTrigger)) {
    checkKind(ctx, "waveTrigger", raw.waveTrigger, `${path}.waveTrigger`);
  }
}

function validateUpgrade(ctx: ValidationContext, id: string, raw: Record<string, unknown>): void {
  const path = `upgrades.${id}`;
  if (Array.isArray(raw.ops)) {
    raw.ops.forEach((op, i) => {
      if (!isObject(op)) return;
      checkKind(ctx, "upgradeOp", op, `${path}.ops[${i}]`);
    });
  }
}

// Per-kind required numeric stat fields for the built-in attack-effects plugin.
// Plugins that register their own AttackEffect kinds carry validation in the plugin
// itself; the Loader's role here is to surface missing required stats on built-in kinds.
const ATTACK_EFFECT_REQUIRED_STATS = new Map<string, readonly string[]>([
  ["damage", ["amount"]],
  ["splash", ["radius", "amount"]],
  ["slow", ["factor", "duration"]],
  ["dot", ["damagePerTick", "interval", "duration"]],
  ["pierce", ["amount", "maxTargets"]],
  ["bounce", ["amount", "hops"]],
  ["line-pierce", ["amount", "maxTargets"]],
  ["minimum-range", ["range"]],
  ["target-count", ["count"]],
  ["projectile-count", ["count"]],
]);

function validateAttackEffectFields(
  ctx: ValidationContext,
  effect: Record<string, unknown>,
  path: string,
): void {
  const kind = effect.kind;
  if (typeof kind !== "string") return;
  const required = ATTACK_EFFECT_REQUIRED_STATS.get(kind);
  if (!required) return;
  const stats = effect.stats;
  if (!isObject(stats)) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.stats`,
      message: `AttackEffect '${kind}' is missing 'stats'.`,
      expected: `object with [${required.join(", ")}]`,
      actual: String(stats),
    });
    return;
  }
  for (const f of required) {
    if (typeof stats[f] !== "number") {
      ctx.errors.push({
        severity: "error",
        code: "INVALID_FIELD",
        path: `${path}.stats.${f}`,
        message: `AttackEffect '${kind}' is missing required stat '${f}'.`,
        expected: "number",
        actual: typeof stats[f],
      });
    }
  }
  // Slow factor must be in (0, 1].
  if (kind === "slow" && typeof stats.factor === "number") {
    if (stats.factor <= 0 || stats.factor > 1) {
      ctx.errors.push({
        severity: "error",
        code: "INVALID_FIELD",
        path: `${path}.stats.factor`,
        message: `slow factor must be in (0, 1].`,
        expected: "number in (0, 1]",
        actual: String(stats.factor),
      });
    }
  }
}

function checkKind(
  ctx: ValidationContext,
  registry: string,
  obj: Record<string, unknown>,
  path: string,
): void {
  const kind = obj.kind;
  if (typeof kind !== "string") {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.kind`,
      message: `Missing 'kind' discriminator.`,
      expected: "string",
      actual: typeof kind,
    });
    return;
  }
  const builtins = BUILTIN_KINDS.get(registry);
  if (builtins?.has(kind)) return;
  const hint = ctx.options.knownKindHints?.get(kind);
  ctx.errors.push({
    severity: "error",
    code: "UNKNOWN_KIND",
    path: `${path}.kind`,
    message: `Unknown ${registry} kind '${kind}'.`,
    expected: builtins ? [...builtins].sort().join(" | ") : "registered kind",
    actual: kind,
    hint: hint
      ? `'${kind}' is registered by plugin '${hint}' — is it loaded?`
      : `no plugin known to register this kind.`,
  });
}

function requireNumber(
  ctx: ValidationContext,
  raw: Record<string, unknown>,
  field: string,
  parentPath: string,
): void {
  if (typeof raw[field] !== "number") {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${parentPath}.${field}`,
      message: `Field '${field}' is missing or not a number.`,
      expected: "number",
      actual: typeof raw[field],
    });
  }
}

function requireArray(
  ctx: ValidationContext,
  raw: Record<string, unknown>,
  field: string,
  parentPath: string,
): void {
  if (!Array.isArray(raw[field])) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${parentPath}.${field}`,
      message: `Field '${field}' is missing or not an array.`,
      expected: "array",
      actual: typeof raw[field],
    });
  }
}
