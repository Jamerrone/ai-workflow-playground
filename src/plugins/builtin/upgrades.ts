import { actionFailure } from "../../kernel/action-result.js";
import {
  type ActionContext,
  type ActionResult,
  type Plugin,
  type PurchaseUpgradeAction,
  type UpgradeOpContext,
  type UpgradeOpDef,
  type UpgradeOpValidationResult,
} from "../../types.js";

declare module "../../types.js" {
  interface GameEvents {
    upgradePurchased: { kind: "upgradePurchased"; tick: number; tower: string; upgrade: string; delta: number; amount: number };
  }
}
import {
  checkKind,
  validateUpgradeOpFields,
} from "../../loader/validator-helpers.js";
import type { BucketValidatorContext } from "../../loader/types.js";

const TOWERS_STATE_ENTITY = "towers/state";

interface AttackEffectEntry {
  id?: string;
  kind: string;
  stats?: Record<string, number>;
  [extra: string]: unknown;
}

interface AttackConfig {
  id: string;
  stats: Record<string, number>;
  effects?: AttackEffectEntry[];
  [extra: string]: unknown;
}

interface UpgradeConfig {
  readonly tower?: string;
  readonly cost?: number;
  readonly prerequisites?: readonly string[];
  readonly exclusiveGroup?: string;
  readonly ops?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

interface TowerArchetypeConfig {
  readonly upgradeTree?: readonly string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveTargetStats(
  attacks: AttackConfig[],
  attackId: string,
  effectId: string | undefined,
): Record<string, number> | undefined {
  const atk = attacks.find((a) => a.id === attackId);
  if (!atk) return undefined;
  if (effectId === undefined) return atk.stats;
  const eff = atk.effects?.find((e) => e.id === effectId);
  if (!eff) return undefined;
  if (!eff.stats) eff.stats = {};
  return eff.stats;
}

function validateStatOp(op: unknown): UpgradeOpValidationResult {
  if (!isObject(op)) return { ok: false, reason: "not an object" };
  if (typeof op.attackId !== "string") return { ok: false, reason: "missing 'attackId'" };
  if (typeof op.field !== "string") return { ok: false, reason: "missing 'field'" };
  const hasDelta = typeof op.delta === "number";
  const hasFactor = typeof op.factor === "number";
  if (!hasDelta && !hasFactor) {
    return { ok: false, reason: "must declare either 'delta' or 'factor'" };
  }
  if (op.effectId !== undefined && typeof op.effectId !== "string") {
    return { ok: false, reason: "'effectId' must be a string" };
  }
  return { ok: true };
}

function mutateAttackStats(
  ctx: UpgradeOpContext,
  attackId: string,
  effectId: string | undefined,
  mutator: (stats: Record<string, number>) => void,
): void {
  const current = ctx.tower.components.get("attacks") as AttackConfig[] | undefined;
  if (!current) return;
  const next = structuredClone(current);
  const stats = resolveTargetStats(next, attackId, effectId);
  if (!stats) return;
  mutator(stats);
  ctx.world.mutate(ctx.tower.id, "attacks", () => next);
}

function applyStatOp(ctx: UpgradeOpContext): void {
  const op = ctx.op as {
    attackId: string;
    field: string;
    delta?: number;
    factor?: number;
    effectId?: string;
  };
  mutateAttackStats(ctx, op.attackId, op.effectId, (stats) => {
    const v = typeof stats[op.field] === "number" ? stats[op.field]! : 0;
    stats[op.field] = op.delta !== undefined ? v + op.delta : v * (op.factor ?? 1);
  });
}

function validateAttackMutationOp(op: unknown): UpgradeOpValidationResult {
  if (!isObject(op)) return { ok: false, reason: "not an object" };
  if (typeof op.attackId !== "string") return { ok: false, reason: "missing 'attackId'" };
  if (typeof op.field !== "string") return { ok: false, reason: "missing 'field'" };
  if (!("set" in op)) return { ok: false, reason: "missing 'set' value" };
  if (op.effectId !== undefined && typeof op.effectId !== "string") {
    return { ok: false, reason: "'effectId' must be a string" };
  }
  return { ok: true };
}

function applyAttackMutationOp(ctx: UpgradeOpContext): void {
  const op = ctx.op as {
    attackId: string;
    field: string;
    set: unknown;
    effectId?: string;
  };
  mutateAttackStats(ctx, op.attackId, op.effectId, (stats) => {
    stats[op.field] = op.set as number;
  });
}

const statOp: UpgradeOpDef = {
  kind: "stat",
  validate: validateStatOp,
  apply: applyStatOp,
};

const attackMutationOp: UpgradeOpDef = {
  kind: "attackMutation",
  validate: validateAttackMutationOp,
  apply: applyAttackMutationOp,
};

function purchaseHandler(
  ctx: ActionContext,
  action: PurchaseUpgradeAction,
): ActionResult {
  const upgrades = ctx.registry.upgrades as Record<string, UpgradeConfig | undefined>;
  const towerEntity = ctx.world.get(action.tower);
  if (!towerEntity || !towerEntity.components.has("tower")) {
    return actionFailure("UNKNOWN_TOWER", `Tower entity '${action.tower}' not found.`);
  }
  const archetypeId = (towerEntity.components.get("tower") as { archetype: string }).archetype;
  const archetype = (ctx.registry.towers as Record<string, TowerArchetypeConfig>)[archetypeId];
  const upgradeTree = archetype?.upgradeTree ?? [];
  if (!upgradeTree.includes(action.upgrade)) {
    return actionFailure(
      "UNKNOWN_UPGRADE",
      `Upgrade '${action.upgrade}' is not in tower '${archetypeId}' upgradeTree.`,
    );
  }
  const upgrade = upgrades[action.upgrade];
  if (!upgrade) {
    return actionFailure(
      "UNKNOWN_UPGRADE",
      `Upgrade '${action.upgrade}' not found in registry.`,
    );
  }
  const purchased = (towerEntity.components.get("purchasedUpgrades") as string[] | undefined) ?? [];
  if (purchased.includes(action.upgrade)) {
    return actionFailure(
      "UPGRADE_ALREADY_PURCHASED",
      `Upgrade '${action.upgrade}' is already purchased on this Tower.`,
    );
  }
  const prereqs = upgrade.prerequisites ?? [];
  const missing = prereqs.filter((p) => !purchased.includes(p));
  if (missing.length > 0) {
    return actionFailure(
      "PREREQUISITES_NOT_MET",
      `Upgrade '${action.upgrade}' requires: ${missing.join(", ")}.`,
      `Purchase ${missing.join(", ")} first.`,
    );
  }
  if (typeof upgrade.exclusiveGroup === "string") {
    const sibling = purchased.find(
      (pid) => upgrades[pid]?.exclusiveGroup === upgrade.exclusiveGroup,
    );
    if (sibling !== undefined) {
      return actionFailure(
        "EXCLUSIVE_GROUP_LOCKED",
        `A sibling upgrade '${sibling}' in exclusiveGroup '${upgrade.exclusiveGroup}' is already purchased.`,
      );
    }
  }
  const goldEntity = ctx.world.get(TOWERS_STATE_ENTITY);
  const goldComp = goldEntity?.components.get("gold") as { amount: number } | undefined;
  const cost = upgrade.cost ?? 0;
  if (!goldComp || goldComp.amount < cost) {
    return actionFailure(
      "INSUFFICIENT_GOLD",
      `Upgrade '${action.upgrade}' costs ${cost} but only ${goldComp?.amount ?? 0} gold available.`,
    );
  }

  // Validate every op's kind is registered before any mutation, so an unknown
  // op kind cannot leave the upgrade half-applied.
  const ops = upgrade.ops ?? [];
  for (const op of ops) {
    const kind = (op as { kind?: string }).kind;
    if (typeof kind !== "string" || !ctx.upgradeOps.has(kind)) {
      return actionFailure(
        "UNKNOWN_UPGRADE_OP",
        `Upgrade '${action.upgrade}' references unregistered op kind '${kind}'.`,
      );
    }
  }
  let towerSnapshot = towerEntity;
  for (const op of ops) {
    const def = ctx.upgradeOps.get((op as { kind: string }).kind)!;
    def.apply({
      tickIndex: ctx.tickIndex,
      world: ctx.world,
      registry: ctx.registry,
      tower: towerSnapshot,
      op,
      emit: ctx.emit,
    });
    towerSnapshot = ctx.world.get(action.tower)!;
  }

  ctx.world.mutate(action.tower, "purchasedUpgrades", () => [...purchased, action.upgrade]);
  const newGold = goldComp.amount - cost;
  ctx.world.mutate(TOWERS_STATE_ENTITY, "gold", () => ({ amount: newGold }));

  ctx.emit({
    kind: "upgradePurchased",
    tick: ctx.tickIndex,
    tower: action.tower,
    upgrade: action.upgrade,
    delta: -cost,
    amount: newGold,
  });
  ctx.emit({
    kind: "goldChanged",
    tick: ctx.tickIndex,
    delta: -cost,
    amount: newGold,
  });

  return { ok: true, effect: { tower: action.tower, upgrade: action.upgrade, gold: newGold } };
}

function validateUpgrade(ctx: BucketValidatorContext): void {
  const raw = ctx.entry;
  const path = ctx.path;
  if (Array.isArray(raw.ops)) {
    raw.ops.forEach((op, i) => {
      if (!isObject(op)) return;
      const opPath = `${path}.ops[${i}]`;
      checkKind(ctx, "upgradeOp", op, opPath);
      validateUpgradeOpFields(ctx, op, opPath);
    });
  }
}

export const upgradesPlugin: Plugin = {
  id: "upgrades",
  register(api) {
    // Upgrade JSON bucket validator — kind discriminators on ops and the
    // built-in op-specific required fields.
    api.registerBucketValidator({ bucket: "upgrades", validate: validateUpgrade });

    api.registerUpgradeOp(statOp);
    api.registerUpgradeOp(attackMutationOp);
    api.registerActionHandler({
      kind: "purchaseUpgrade",
      handle(ctx, action) {
        return purchaseHandler(ctx, action as PurchaseUpgradeAction);
      },
    });
  },
};
