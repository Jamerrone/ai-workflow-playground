import { PHASE_ORDER, Phase, type Plugin, type Position } from "../../../types.js";

interface SummonConfig {
  readonly summons: string;
  readonly maxCount: number;
  readonly respawnCooldown: number;
  readonly rallyPointRange: number;
}

interface GuardArchetype {
  readonly stats: Readonly<Record<string, number>>;
  readonly attacks: ReadonlyArray<unknown>;
}

export const guardsPlugin: Plugin = {
  id: "guards",
  register(api) {
    api.registerComponent({ name: "guard", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "summon", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "rallyPoint", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "parentTower", writableIn: PHASE_ORDER });

    api.registerEntityKind({
      kind: "guard",
      components: ["guard", "position", "parentTower"],
    });

    // Simulation-phase System: for every Tower carrying a `summon` Component,
    // ensure the live Guard count up to `maxCount`. Initial fill on placement
    // is immediate (this System runs the same tick as placeTower); the
    // respawnCooldown timer is a later concern.
    // When a Tower carrying a `summon` Component is sold, despawn every Guard
    // whose `parentTower` points at it. Wired through the public RewardKind
    // surface (same mechanism `sell-value` uses to credit gold) so a developer
    // plugin owning a different summoner could despawn in exactly this way.
    api.registerReward({
      kind: "guards/despawnOnSell",
      eventKind: "towerSold",
      apply(ctx, event) {
        const soldTowerId = (event as unknown as { tower: string }).tower;
        const guards = ctx.world.query({ all: ["guard", "parentTower"] });
        for (const g of guards) {
          const parent = (g.components.get("parentTower") as { tower: string }).tower;
          if (parent === soldTowerId) ctx.world.destroy(g.id);
        }
      },
    });

    api.registerSystem({
      id: "guards/spawner",
      phase: Phase.Simulation,
      reads: ["tower", "summon", "position", "parentTower"],
      writes: ["guard", "position", "parentTower"],
      run(ctx) {
        const towers = ctx.world.query({ all: ["tower", "summon", "position"] });
        const guards = ctx.world.query({ all: ["guard", "parentTower"] });
        const liveByTower = new Map<string, number>();
        for (const g of guards) {
          const parent = (g.components.get("parentTower") as { tower: string }).tower;
          liveByTower.set(parent, (liveByTower.get(parent) ?? 0) + 1);
        }
        const guardArchetypes = ctx.registry.guards as Record<string, GuardArchetype | undefined>;
        for (const tower of towers) {
          const summon = tower.components.get("summon") as SummonConfig;
          const position = tower.components.get("position") as Position;
          const live = liveByTower.get(tower.id) ?? 0;
          const archetype = guardArchetypes?.[summon.summons];
          if (!archetype) continue;
          for (let i = live; i < summon.maxCount; i++) {
            const guardId = `guard:${tower.id}:${i}`;
            ctx.world.spawn(guardId, {
              guard: { archetype: summon.summons },
              position: { x: position.x, y: position.y },
              parentTower: { tower: tower.id },
            });
          }
        }
      },
    });
  },
};
