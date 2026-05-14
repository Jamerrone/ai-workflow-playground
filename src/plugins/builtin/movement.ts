import { Phase, type Plugin, type Position } from "../../types.js";

interface PathProgress {
  pathId: string;
  wpIndex: number;
  speed: number;
  baseDamage: number;
}

interface SlowEntry {
  kind: "slow";
  factor: number;
  remaining: number;
}

export const movementPlugin: Plugin = {
  id: "movement",
  register(api) {
    api.registerSystem({
      // ADR: any entity carrying `pathProgress` is path-walked. Enemies are no
      // longer the only path-walkers — plugin-authored summons (e.g. a
      // necromancer's skeletons) reuse the same locomotion by spawning with
      // pathProgress. Arrival-at-base behaviour (damage + destroy) remains
      // gated on the `enemy` Component.
      id: "movement/pathWalk",
      phase: Phase.Simulation,
      reads: ["pathProgress", "statusEffects"],
      writes: ["position", "pathProgress"],
      run(ctx) {
        if (!ctx.scenarioId) return;
        const scenario = (ctx.registry.scenarios as Record<string, any>)[ctx.scenarioId];
        const map = (ctx.registry.maps as Record<string, any>)[scenario.map];

        const walkers = ctx.world.query({ all: ["position", "pathProgress"] });
        for (const e of walkers) {
          const pp = e.components.get("pathProgress") as PathProgress;
          const pos = e.components.get("position") as Position;
          const path = (map.paths as Array<any>).find((p) => p.id === pp.pathId);
          // statusEffects 'slow' entries multiply the effective speed.
          const status =
            (e.components.get("statusEffects") as ReadonlyArray<{ kind: string; factor?: number }> | undefined) ?? [];
          const slowMul = status
            .filter((s): s is SlowEntry => s.kind === "slow")
            .reduce((acc, s) => acc * s.factor, 1);
          let remaining = pp.speed * slowMul * ctx.dt;
          let { x, y } = pos;
          let wpIndex = pp.wpIndex;
          while (remaining > 0 && wpIndex + 1 < path.waypoints.length) {
            const next = path.waypoints[wpIndex + 1];
            const dx = next.x - x;
            const dy = next.y - y;
            const dist = Math.abs(dx) + Math.abs(dy); // axis-aligned
            if (dist <= remaining) {
              x = next.x;
              y = next.y;
              remaining -= dist;
              wpIndex += 1;
            } else {
              const stepX = dx === 0 ? 0 : Math.sign(dx) * remaining;
              const stepY = dy === 0 ? 0 : Math.sign(dy) * remaining;
              x += stepX;
              y += stepY;
              remaining = 0;
            }
          }
          ctx.world.mutate(e.id, "position", () => ({ x, y }));
          ctx.world.mutate(e.id, "pathProgress", () => ({ ...pp, wpIndex }));

          if (wpIndex + 1 >= path.waypoints.length && e.components.has("enemy")) {
            const baseId = (map.bases as Array<{ id: string; position: Position }>).find(
              (b) => b.position.x === x && b.position.y === y,
            )?.id;
            if (baseId) {
              ctx.emit({
                kind: "enemyReachedBase",
                tick: ctx.tickIndex,
                enemy: e.id,
                base: baseId,
                damage: pp.baseDamage,
              });
              const stateEntity = ctx.world.get("win-loss/state");
              const bases = stateEntity?.components.get("bases") as
                | { entries: Array<{ id: string; position: Position; hp: number }> }
                | undefined;
              if (bases) {
                const updatedEntries = bases.entries.map((b) =>
                  b.id === baseId ? { ...b, hp: b.hp - pp.baseDamage } : b,
                );
                ctx.world.mutate("win-loss/state", "bases", () => ({
                  entries: updatedEntries,
                }));
                const damagedBase = updatedEntries.find((b) => b.id === baseId)!;
                ctx.emit({
                  kind: "baseDamaged",
                  tick: ctx.tickIndex,
                  base: baseId,
                  damage: pp.baseDamage,
                  remainingHp: damagedBase.hp,
                });
              }
              ctx.world.destroy(e.id);
            }
          }
        }
      },
    });
  },
};
