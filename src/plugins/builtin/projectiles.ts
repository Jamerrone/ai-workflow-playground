import {
  PHASE_ORDER,
  Phase,
  type AttackEffectConfig,
  type AttackEffectContext,
  type AttackEffectFire,
  type Plugin,
  type Position,
} from "../../types.js";
import { validateNumberStats } from "./attack-effects.js";

const PENDING_FIRES_ENTITY = "attack-effects/pending";
const FIRES_COMPONENT = "pendingFires";
const PROJECTILE_COMPONENT = "projectile";

interface ProjectileData {
  readonly sourceId: string;
  readonly sourcePosition: Position;
  readonly targetId: string;
  readonly speed: number;
  readonly distanceTraveled: number;
  readonly maxRange: number;
  readonly attack: {
    readonly id: string;
    readonly stats: Readonly<Record<string, unknown>>;
    readonly targetFilter?: {
      readonly require?: readonly string[];
      readonly exclude?: readonly string[];
    };
  };
  readonly effects: ReadonlyArray<AttackEffectConfig>;
}

export const projectilesPlugin: Plugin = {
  id: "projectiles",
  register(api) {
    api.registerComponent({ name: PROJECTILE_COMPONENT, writableIn: PHASE_ORDER });

    api.registerEntityKind({
      kind: "projectile",
      components: [PROJECTILE_COMPONENT, "position"],
    });

    api.registerAttackEffect({
      kind: "projectile-count",
      validate: (effect) => validateNumberStats(effect, ["count", "speed", "maxRange"]),
      apply(ctx: AttackEffectContext): void {
        const { count, speed, maxRange } = ctx.effect.stats as {
          count: number;
          speed: number;
          maxRange: number;
        };

        const onHitEffects = ctx.fire.effects.filter(
          (e) => e.kind !== "projectile-count",
        );

        for (let i = 0; i < count; i++) {
          const projId = `proj:${ctx.fire.source.id}:${ctx.tickIndex}:${i}`;
          ctx.world.spawn(projId, {
            [PROJECTILE_COMPONENT]: {
              sourceId: ctx.fire.source.id,
              sourcePosition: { ...ctx.fire.source.position },
              targetId: ctx.fire.primaryTarget.id,
              speed,
              distanceTraveled: 0,
              maxRange,
              attack: { ...ctx.fire.attack },
              effects: onHitEffects,
            } satisfies ProjectileData,
            position: { ...ctx.fire.source.position },
          });
        }

        ctx.state.abort = true;

        ctx.emit({
          kind: "projectilesSpawned",
          tick: ctx.tickIndex,
          source: ctx.fire.source.id,
          target: ctx.fire.primaryTarget.id,
          count,
          attackId: ctx.fire.attack.id,
          effectId: ctx.effect.id,
        });
      },
    });

    api.registerSystem({
      id: "projectiles/flight",
      phase: Phase.Simulation,
      after: ["combat/fire", "movement/enemyWalk"],
      reads: ["projectile", "position"],
      writes: ["projectile", "position", "pendingFires"],
      run(ctx) {
        const projectiles = ctx.world.query({
          all: [PROJECTILE_COMPONENT, "position"],
        });

        const hitFires: AttackEffectFire[] = [];
        const toDestroy: string[] = [];

        for (const proj of projectiles) {
          const data = proj.components.get(PROJECTILE_COMPONENT) as ProjectileData;
          const pos = proj.components.get("position") as Position;

          const target = ctx.world.get(data.targetId);
          const targetPos = target?.components.get("position") as
            | Position
            | undefined;

          if (!target || !targetPos) {
            ctx.emit({
              kind: "projectileExpired",
              tick: ctx.tickIndex,
              projectile: proj.id,
              reason: "target-lost",
            });
            toDestroy.push(proj.id);
            continue;
          }

          const dx = targetPos.x - pos.x;
          const dy = targetPos.y - pos.y;
          const distance = Math.abs(dx) + Math.abs(dy);
          const step = data.speed * ctx.dt;

          if (distance <= step) {
            hitFires.push({
              source: {
                id: data.sourceId,
                position: { ...data.sourcePosition },
              },
              primaryTarget: {
                id: data.targetId,
                position: { ...targetPos },
              },
              attack: data.attack,
              effects: data.effects,
            });

            ctx.emit({
              kind: "projectileHit",
              tick: ctx.tickIndex,
              projectile: proj.id,
              source: { ...data.sourcePosition },
              target: { ...targetPos },
            });

            toDestroy.push(proj.id);
          } else {
            const newDistanceTraveled = data.distanceTraveled + step;

            if (newDistanceTraveled >= data.maxRange) {
              ctx.emit({
                kind: "projectileExpired",
                tick: ctx.tickIndex,
                projectile: proj.id,
                reason: "max-range",
              });
              toDestroy.push(proj.id);
            } else {
              const ratio = step / distance;
              const newX = pos.x + dx * ratio;
              const newY = pos.y + dy * ratio;
              ctx.world.mutate(proj.id, "position", () => ({
                x: newX,
                y: newY,
              }));
              ctx.world.mutate(proj.id, PROJECTILE_COMPONENT, () => ({
                ...data,
                distanceTraveled: newDistanceTraveled,
              }));
            }
          }
        }

        if (hitFires.length > 0) {
          const pendingState = ctx.world.get(PENDING_FIRES_ENTITY);
          const queue =
            (
              pendingState?.components.get(FIRES_COMPONENT) as
                | { queue: unknown[] }
                | undefined
            )?.queue ?? [];
          ctx.world.mutate(PENDING_FIRES_ENTITY, FIRES_COMPONENT, () => ({
            queue: [...queue, ...hitFires],
          }));
        }

        for (const id of toDestroy) {
          ctx.world.destroy(id);
        }
      },
    });
  },
};
