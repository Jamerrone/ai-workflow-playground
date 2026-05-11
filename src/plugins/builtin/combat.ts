import { Phase, type Plugin, type Position } from "../../types.js";

const TOWERS_STATE_ENTITY = "towers/state";

interface PendingDamageEntry {
  source: string;
  target: string;
  amount: number;
  attackId: string;
}

function dist(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function closestToBase(
  enemies: Array<{ id: string; components: ReadonlyMap<string, unknown> }>,
  basePos: Position,
): { id: string; components: ReadonlyMap<string, unknown> } | undefined {
  return [...enemies].sort((a, b) => {
    const pa = a.components.get("position") as Position;
    const pb = b.components.get("position") as Position;
    return dist(pa, basePos) - dist(pb, basePos);
  })[0];
}

export const combatPlugin: Plugin = {
  id: "combat",
  register(api) {
    api.registerComponent({ name: "pendingDamage", writableIn: [Phase.Simulation, Phase.Effect] });

    // Firing: towers pick targets and queue damage effects.
    api.registerSystem({
      id: "combat/fire",
      phase: Phase.Simulation,
      reads: ["tower", "position", "enemy", "health"],
      writes: ["cooldownTimer", "pendingDamage"],
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
          const cd = tower.components.get("cooldownTimer") as { remaining: number };
          const newRemaining = Math.max(0, cd.remaining - ctx.dt);
          if (newRemaining > 0) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: newRemaining }));
            continue;
          }
          const towerPos = tower.components.get("position") as Position;
          const attack = (towerDef.attacks as Array<any>)[0];
          if (!attack) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: 0 }));
            continue;
          }
          const inRange = enemies.filter((e) => {
            const ep = e.components.get("position") as Position;
            return dist(ep, towerPos) <= attack.stats.range;
          });
          if (inRange.length === 0) {
            ctx.world.mutate(tower.id, "cooldownTimer", () => ({ remaining: 0 }));
            continue;
          }
          const target = closestToBase(inRange, firstBase);
          if (!target) continue;
          const damageEffect = (attack.effects as Array<any>).find((e) => e.kind === "damage");
          const amount = damageEffect?.stats?.amount ?? attack.stats.damage;
          const existing =
            (target.components.get("pendingDamage") as PendingDamageEntry[] | undefined) ?? [];
          ctx.world.mutate(target.id, "pendingDamage", () => [
            ...existing,
            { source: tower.id, target: target.id, amount, attackId: attack.id },
          ]);
          ctx.world.mutate(tower.id, "cooldownTimer", () => ({
            remaining: attack.stats.cooldown,
          }));
          ctx.emit({
            kind: "towerFired",
            tick: ctx.tickIndex,
            source: tower.id,
            target: target.id,
            sourcePosition: { ...towerPos },
            targetPosition: { ...(target.components.get("position") as Position) },
          });
        }
      },
    });

    // Effect resolution: apply pending damage to health.
    api.registerSystem({
      id: "kernel/effectResolve",
      phase: Phase.Effect,
      reads: ["pendingDamage", "health"],
      writes: ["health", "pendingDamage"],
      run(ctx) {
        const targets = ctx.world.query({ all: ["pendingDamage", "health"] });
        for (const t of targets) {
          const queue = t.components.get("pendingDamage") as PendingDamageEntry[];
          const hp = (t.components.get("health") as { hp: number }).hp;
          const total = queue.reduce((s, e) => s + e.amount, 0);
          ctx.world.mutate(t.id, "health", () => ({ hp: hp - total }));
          ctx.world.mutate(t.id, "pendingDamage", () => []);
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

