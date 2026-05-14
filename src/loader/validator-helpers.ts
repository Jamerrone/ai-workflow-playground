// Shared helpers for bucket validators contributed by plugins. Bucket validators
// import these helpers to push structured errors through the per-context
// `addError` accumulator while preserving the Loader's collect-all contract
// (ADR-0013). Helpers operate on entry data; they never throw.

import { isObject } from "./normalize.js";
import type {
  BucketValidatorContext,
  LoaderError,
  LoaderOptions,
} from "./types.js";

// `kind` values known to the built-in plugin bundle. The Loader uses this for
// the UNKNOWN_KIND error so missing-plugin scenarios surface with a useful
// hint. Adding a new `kind` to a built-in plugin requires adding it here too;
// third-party plugins surface theirs via `LoaderOptions.knownKindHints`.
const BUILTIN_KINDS = new Map<string, ReadonlySet<string>>([
  ["placementMode", new Set(["fixed", "free"])],
  ["waveTrigger", new Set(["manual", "auto", "hybrid"])],
  ["targeting", new Set(["closest-to-base", "closest", "lowest-hp", "highest-hp", "tag-priority"])],
  ["strategy", new Set(["closest-to-base", "closest", "lowest-hp", "highest-hp", "tag-priority"])],
  ["attackSelection", new Set(["declaration-order", "highest-damage"])],
  ["attackEffect", new Set(["damage", "splash", "slow", "dot", "pierce", "bounce", "line-pierce", "minimum-range", "target-count", "projectile-count", "heal"])],
  ["upgradeOp", new Set(["stat", "attackMutation", "guardModifier"])],
  ["mapFeature", new Set(["blocked-region"])],
  ["rewardKind", new Set(["gold-on-kill", "sell-value", "wave-clear"])],
]);

/** Validator-internal addError sink — every helper goes through it. */
type Push = (e: LoaderError) => void;

export function requireNumber(
  ctx: BucketValidatorContext,
  raw: Record<string, unknown>,
  field: string,
  parentPath: string,
): void {
  if (typeof raw[field] !== "number") {
    ctx.addError({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${parentPath}.${field}`,
      message: `Field '${field}' is missing or not a number.`,
      expected: "number",
      actual: typeof raw[field],
    });
  }
}

export function requireArray(
  ctx: BucketValidatorContext,
  raw: Record<string, unknown>,
  field: string,
  parentPath: string,
): void {
  if (!Array.isArray(raw[field])) {
    ctx.addError({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${parentPath}.${field}`,
      message: `Field '${field}' is missing or not an array.`,
      expected: "array",
      actual: typeof raw[field],
    });
  }
}

export function requireStringField(
  ctx: BucketValidatorContext,
  obj: Record<string, unknown>,
  parentPath: string,
  ownerLabel: string,
  field: string,
): void {
  if (typeof obj[field] === "string") return;
  ctx.addError({
    severity: "error",
    code: "INVALID_FIELD",
    path: `${parentPath}.${field}`,
    message: `${ownerLabel} is missing '${field}'.`,
    expected: "string",
    actual: typeof obj[field],
  });
}

/**
 * Validates a `{ kind: string }` discriminator object against built-in + hint
 * kinds. Emits UNKNOWN_KIND on miss with a plugin-attribution hint when the
 * loader was given `knownKindHints`.
 */
export function checkKind(
  ctx: BucketValidatorContext,
  registry: string,
  obj: Record<string, unknown>,
  path: string,
): void {
  pushKindError(obj, registry, path, ctx.options, (e) => ctx.addError(e));
}

function pushKindError(
  obj: Record<string, unknown>,
  registry: string,
  path: string,
  options: LoaderOptions,
  push: Push,
): void {
  const kind = obj.kind;
  if (typeof kind !== "string") {
    push({
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
  const hint = options.knownKindHints?.get(kind);
  push({
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

// Required numeric stats per built-in AttackEffect kind. Validators that
// contain Attacks (Tower, Enemy) call validateAttackEffectFields to surface
// missing required stats for shipped kinds. Plugin-contributed kinds carry
// their own validation through `AttackEffectDef.validate`.
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
  ["projectile-count", ["count", "speed", "maxRange"]],
]);

export function validateAttackEffectFields(
  ctx: BucketValidatorContext,
  effect: Record<string, unknown>,
  path: string,
): void {
  const kind = effect.kind;
  if (typeof kind !== "string") return;
  const required = ATTACK_EFFECT_REQUIRED_STATS.get(kind);
  if (!required) return;
  const stats = effect.stats;
  if (!isObject(stats)) {
    ctx.addError({
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
      ctx.addError({
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
      ctx.addError({
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

/**
 * Validates the kind-specific fields for built-in UpgradeOp kinds. Used by the
 * upgrades bucket validator after `checkKind` has confirmed the kind itself is
 * known.
 */
export function validateUpgradeOpFields(
  ctx: BucketValidatorContext,
  op: Record<string, unknown>,
  path: string,
): void {
  const kind = op.kind;
  if (typeof kind !== "string") return;
  if (kind === "stat") {
    requireStringField(ctx, op, path, `Upgrade op '${kind}'`, "attackId");
    requireStringField(ctx, op, path, `Upgrade op '${kind}'`, "field");
    if (typeof op.delta !== "number" && typeof op.factor !== "number") {
      ctx.addError({
        severity: "error",
        code: "INVALID_FIELD",
        path: `${path}.delta`,
        message: `Upgrade op 'stat' must declare either 'delta' or 'factor'.`,
        expected: "number on 'delta' or 'factor'",
        actual: "neither present",
      });
    }
  } else if (kind === "attackMutation") {
    requireStringField(ctx, op, path, `Upgrade op '${kind}'`, "attackId");
    requireStringField(ctx, op, path, `Upgrade op '${kind}'`, "field");
    if (!("set" in op)) {
      ctx.addError({
        severity: "error",
        code: "INVALID_FIELD",
        path: `${path}.set`,
        message: `Upgrade op 'attackMutation' is missing 'set'.`,
        expected: "any (the value to assign)",
        actual: "missing",
      });
    }
  }
}
