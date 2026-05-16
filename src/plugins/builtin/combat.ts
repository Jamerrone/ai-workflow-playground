import {
  Phase,
  type AttackEffectConfig,
  type AttackSelectionCandidate,
  type AttackSelectionStrategyConfig,
  type Plugin,
  type Position,
  type TargetingCandidate,
  type TargetingStrategyConfig,
} from "../../types.js";

declare module "../../types.js" {
  interface GameEvents {
    towerFired: { kind: "towerFired"; tick: number; source: string; target: string; sourcePosition: Position; targetPosition: Position; attackId: string };
    enemyKilled: { kind: "enemyKilled"; tick: number; enemy: string; killReward: number };
    goldChanged: { kind: "goldChanged"; tick: number; delta: number; amount: number };
  }
}
import { matchesFilter } from "./attack-shared.js";

const TOWERS_STATE_ENTITY = "towers/state";
const DEFAULT_TARGETING: TargetingStrategyConfig = { kind: "closest-to-base" };
const DEFAULT_ATTACK_SELECTION: AttackSelectionStrategyConfig = { kind: "declaration-order" };

function dist(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}


export const combatPlugin: Plugin = {
  id: "combat",
  register(api) {
    // combat/fire: select targets and queue Fires for the attack-effects plugin to resolve.
    api.registerSystem({
      id: "combat/fire",
      phase: Phase.Simulation,
      reads: ["tower", "position", "enemy", "health"],
      writes: ["cooldownTimer", "pendingFires"],
      run(ctx) {
        if (!ctx.scenarioId) return;
        const scenario = (ctx.registry.scenarios as Record<string, any>)[ctx.scenarioId];
        const map = (ctx.registry.maps as Record<string, any>)[scenario.map];
        const firstBase = (map.bases as Array<{ position: Position }>)[0]?.position ?? { x: 0, y: 0 };

        const towers = ctx.world.query({ all: ["tower", "position", "cooldownTimer"] });
        const enemies = ctx.world.query({ all: ["enemy", "position", "health"] });

        for (const tower of towers) {
          const towerArche = (tower.components.get("tower") as { archetype: string }).archetype;
          const towerDef = (ctx.registry.towers as Record<string, any>)[towerArche];
          const entityAttacks = tower.components.get("attacks") as Array<any> | undefined;
          const cd = tower.components.get("cooldownTimer") as { remaining: number };
          const newRemaining = Math.max(0, cd.remaining - ctx.dt);
          // Always write the decremented cooldown so `ctx.fireAttack` reads
          // the post-decrement value when it checks readiness.
          ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: newRemaining }));
          if (newRemaining > 0) continue;
          const towerPos = tower.components.get("position") as Position;
          const attacks = entityAttacks ?? ((towerDef.attacks as Array<any>) ?? []);
          if (attacks.length === 0) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: 0 }));
            continue;
          }
          const entityTargeting = tower.components.get("targeting") as
            | TargetingStrategyConfig
            | undefined;
          const targetingConfig: TargetingStrategyConfig =
            entityTargeting ??
            (towerDef.targeting as TargetingStrategyConfig | undefined) ??
            (towerDef.strategy as TargetingStrategyConfig | undefined) ??
            DEFAULT_TARGETING;
          const strategy = ctx.targetingStrategies.get(targetingConfig.kind);
          const selectionConfig: AttackSelectionStrategyConfig =
            (towerDef.attackSelection as AttackSelectionStrategyConfig | undefined) ??
            DEFAULT_ATTACK_SELECTION;
          const selection = ctx.attackSelectionStrategies.get(selectionConfig.kind);

          // For each Attack, pre-compute (eligible enemies, target picked by TargetingStrategy).
          // An Attack is "eligible" for selection if its TargetingStrategy returned a target.
          const perAttackTargets = new Map<string, TargetingCandidate>();
          const eligibleAttacks: AttackSelectionCandidate[] = [];
          for (const attack of attacks) {
            const eligible = enemies.filter((e) => {
              const ep = e.components.get("position") as Position;
              if (dist(ep, towerPos) > attack.stats.range) return false;
              const tags = (e.components.get("enemy") as { tags?: string[] } | undefined)?.tags ?? [];
              return matchesFilter(tags, attack.targetFilter);
            });
            if (eligible.length === 0) continue;
            const picked = strategy
              ? strategy.select({
                  source: { id: tower.id, position: { ...towerPos } },
                  basePosition: { ...firstBase },
                  eligible,
                  config: targetingConfig,
                })
              : undefined;
            if (!picked) continue;
            perAttackTargets.set(attack.id, picked);
            eligibleAttacks.push({
              id: attack.id,
              stats: attack.stats,
              ...(attack.targetFilter !== undefined ? { targetFilter: attack.targetFilter } : {}),
              effects: (attack.effects as ReadonlyArray<AttackEffectConfig> | undefined) ?? [],
            });
          }

          let firedAttack: any = null;
          let firedTarget: TargetingCandidate | undefined;
          if (eligibleAttacks.length > 0 && selection) {
            const picked = selection.select({
              source: { id: tower.id, position: { ...towerPos } },
              eligible: eligibleAttacks,
              config: selectionConfig,
              attackEffects: ctx.attackEffects,
              world: ctx.world,
              resolveTarget(a) {
                const tgt = perAttackTargets.get(a.id);
                if (!tgt) return undefined;
                const tp = tgt.components.get("position") as Position;
                return { id: tgt.id, position: { ...tp } };
              },
            });
            if (picked) {
              firedAttack = attacks.find((a) => a.id === picked.id);
              firedTarget = perAttackTargets.get(picked.id);
            }
          }
          if (!firedAttack || !firedTarget) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: 0 }));
            continue;
          }

          const targetPos = firedTarget.components.get("position") as Position;
          const fired = ctx.fireAttack({
            attacker: tower.id,
            attack: {
              id: firedAttack.id,
              stats: { ...firedAttack.stats },
              effects: (firedAttack.effects as ReadonlyArray<AttackEffectConfig>) ?? [],
              ...(firedAttack.targetFilter !== undefined
                ? { targetFilter: firedAttack.targetFilter }
                : {}),
            },
            primaryTarget: firedTarget.id,
          });
          if (!fired) continue;
          ctx.emit({
            kind: "towerFired",
            tick: ctx.tickIndex,
            source: tower.id,
            target: firedTarget.id,
            sourcePosition: { ...towerPos },
            targetPosition: { ...targetPos },
            attackId: firedAttack.id,
          });
        }
      },
    });

    // Death + reward: enemies with hp ≤ 0 die and award gold-on-kill.
    api.registerSystem({
      id: "combat/death",
      phase: Phase.Reward,
      reads: ["enemy", "health"],
      writes: ["gold"],
      run(ctx) {
        const dead = ctx.world
          .query({ all: ["enemy", "health"] })
          .filter((e) => (e.components.get("health") as { hp: number }).hp <= 0);
        if (dead.length === 0) return;
        const goldEntity = ctx.world.get(TOWERS_STATE_ENTITY);
        const gold = goldEntity?.components.get("gold") as { amount: number } | undefined;
        let amount = gold?.amount ?? 0;
        const startingAmount = amount;
        for (const e of dead) {
          const killReward = (e.components.get("enemy") as { killReward: number }).killReward;
          amount += killReward;
          ctx.emit({
            kind: "enemyKilled",
            tick: ctx.tickIndex,
            enemy: e.id,
            killReward,
          });
          ctx.world.destroy(e.id);
        }
        if (goldEntity) {
          ctx.world.mutate(TOWERS_STATE_ENTITY, "gold", () => ({ amount }));
          ctx.emit({
            kind: "goldChanged",
            tick: ctx.tickIndex,
            delta: amount - startingAmount,
            amount,
          });
        }
      },
    });
  },
};
