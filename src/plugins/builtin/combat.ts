import {
  Phase,
  type Plugin,
  type Position,
  type TargetingCandidate,
  type TargetingStrategyConfig,
} from "../../types.js";

const TOWERS_STATE_ENTITY = "towers/state";
const PENDING_FIRES_ENTITY = "attack-effects/pending";
const FIRES_COMPONENT = "pendingFires";
const DEFAULT_TARGETING: TargetingStrategyConfig = { kind: "closest-to-base" };

interface PendingFire {
  source: { id: string; position: Position };
  primaryTarget: { id: string; position: Position };
  attack: {
    id: string;
    stats: Record<string, unknown>;
    targetFilter?: { require?: string[]; exclude?: string[] };
  };
  effects: ReadonlyArray<{ kind: string; id?: string; stats?: Record<string, unknown> }>;
}

function dist(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function matchesFilter(
  tags: readonly string[],
  filter?: { require?: readonly string[]; exclude?: readonly string[] },
): boolean {
  if (!filter) return true;
  if (filter.require && filter.require.length > 0) {
    if (!filter.require.every((t) => tags.includes(t))) return false;
  }
  if (filter.exclude && filter.exclude.length > 0) {
    if (filter.exclude.some((t) => tags.includes(t))) return false;
  }
  return true;
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

        const pendingState = ctx.world.get(PENDING_FIRES_ENTITY);
        const queue =
          (pendingState?.components.get(FIRES_COMPONENT) as { queue: PendingFire[] } | undefined)
            ?.queue ?? [];
        const newFires: PendingFire[] = [];

        for (const tower of towers) {
          const towerArche = (tower.components.get("tower") as { archetype: string }).archetype;
          const towerDef = (ctx.registry.towers as Record<string, any>)[towerArche];
          const cd = tower.components.get("cooldownTimer") as { remaining: number };
          const newRemaining = Math.max(0, cd.remaining - ctx.dt);
          if (newRemaining > 0) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: newRemaining }));
            continue;
          }
          const towerPos = tower.components.get("position") as Position;
          const attacks = (towerDef.attacks as Array<any>) ?? [];
          if (attacks.length === 0) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: 0 }));
            continue;
          }
          const targetingConfig: TargetingStrategyConfig =
            (towerDef.targeting as TargetingStrategyConfig | undefined) ??
            (towerDef.strategy as TargetingStrategyConfig | undefined) ??
            DEFAULT_TARGETING;
          const strategy = ctx.targetingStrategies.get(targetingConfig.kind);
          // Pick the highest-damage attack with at least one eligible in-range target.
          const sortedAttacks = [...attacks].sort(
            (a, b) => (b.stats.damage ?? 0) - (a.stats.damage ?? 0),
          );
          let firedAttack: any = null;
          let firedTarget: TargetingCandidate | undefined;
          for (const attack of sortedAttacks) {
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
            firedAttack = attack;
            firedTarget = picked;
            break;
          }
          if (!firedAttack || !firedTarget) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: 0 }));
            continue;
          }

          const targetPos = firedTarget.components.get("position") as Position;
          newFires.push({
            source: { id: tower.id, position: { ...towerPos } },
            primaryTarget: { id: firedTarget.id, position: { ...targetPos } },
            attack: {
              id: firedAttack.id,
              stats: { ...firedAttack.stats },
              targetFilter: firedAttack.targetFilter,
            },
            effects: (firedAttack.effects as Array<any>) ?? [],
          });
          ctx.world.mutate(tower.id, "cooldownTimer", () => ({
            remaining: firedAttack.stats.cooldown,
          }));
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

        if (newFires.length > 0 && pendingState) {
          ctx.world.mutate(PENDING_FIRES_ENTITY, FIRES_COMPONENT, () => ({
            queue: [...queue, ...newFires],
          }));
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
