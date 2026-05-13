import type {
  AttackEffectDef,
  AttackSelectionCandidate,
  AttackSelectionContext,
  AttackSelectionStrategyDef,
  Plugin,
} from "../../types.js";

function previewAttackDamage(
  attack: AttackSelectionCandidate,
  attackEffects: AttackSelectionContext["attackEffects"],
  fireContext: Parameters<NonNullable<AttackEffectDef["damagePreview"]>>[1],
): number {
  let total = 0;
  for (const effect of attack.effects) {
    const def = attackEffects.get(effect.kind);
    if (!def?.damagePreview) continue;
    const stats = effect.stats ?? {};
    total += def.damagePreview(stats, fireContext);
  }
  return total;
}

const declarationOrderStrategy: AttackSelectionStrategyDef = {
  kind: "declaration-order",
  validate: () => ({ ok: true }),
  select(ctx) {
    return ctx.eligible[0];
  },
};

const highestDamageStrategy: AttackSelectionStrategyDef = {
  kind: "highest-damage",
  validate: () => ({ ok: true }),
  select(ctx) {
    let best: AttackSelectionCandidate | undefined;
    let bestScore = -Infinity;
    for (const attack of ctx.eligible) {
      const target = ctx.resolveTarget(attack);
      if (!target) continue;
      const score = previewAttackDamage(attack, ctx.attackEffects, {
        world: ctx.world,
        source: ctx.source,
        primaryTarget: target,
        attack: {
          id: attack.id,
          stats: attack.stats,
          ...(attack.targetFilter !== undefined ? { targetFilter: attack.targetFilter } : {}),
        },
      });
      if (score > bestScore) {
        best = attack;
        bestScore = score;
      }
    }
    return best;
  },
};

export const attackSelectionStrategiesPlugin: Plugin = {
  id: "attack-selection-strategies",
  register(api) {
    api.registerAttackSelectionStrategy(declarationOrderStrategy);
    api.registerAttackSelectionStrategy(highestDamageStrategy);
  },
};
