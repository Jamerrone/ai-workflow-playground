import {
  Phase,
  type AttackSelectionCandidate,
  type AttackSelectionStrategyConfig,
  type Plugin,
  type Position,
  type SystemContext,
  type TargetingCandidate,
  type TargetingStrategyConfig,
} from "../../types.js";
import {
  type AttackData,
  matchesFilter,
  entityTags,
} from "./attack-shared.js";

export interface EnemyArchetype {
  readonly tags: readonly string[];
  readonly stats: {
    readonly hp: number;
    readonly speed: number;
    readonly baseDamage: number;
  };
  readonly killReward: number;
  readonly attacks?: ReadonlyArray<AttackData>;
  readonly attackSelection?: AttackSelectionStrategyConfig;
  readonly targeting?: TargetingStrategyConfig;
}

const DEFAULT_TARGETING: TargetingStrategyConfig = { kind: "closest" };
const DEFAULT_ATTACK_SELECTION: AttackSelectionStrategyConfig = {
  kind: "declaration-order",
};

// Ground-tagged baseline Enemy. The 'ground' tag matches Paths of kind 'ground'.
export const GROUND_GRUNT: EnemyArchetype = {
  tags: ["ground"],
  stats: { hp: 10, speed: 1, baseDamage: 1 },
  killReward: 5,
};

// Flying Enemy that traverses aerial Paths. Faster and frailer than the ground
// grunt — typical aerial trade-off. The `flying` tag is matched by anti-air
// Attack targetFilters; the `aerial` tag matches the corresponding Path kind.
export const AERIAL_GRUNT: EnemyArchetype = {
  tags: ["aerial", "flying"],
  stats: { hp: 6, speed: 1.5, baseDamage: 1 },
  killReward: 8,
};


// The waves plugin owns the runtime Enemy lifecycle (Components / spawn). The
// enemies plugin contributes:
//   - the `enemy` EntityKind
//   - the `enemies/engagement` System (sticky, enforces `enemyEngagementCap`
//     on a per-Guard basis — i.e. *Enemies-per-Guard*, ADR-0010)
//   - the `enemies/attack` System (fires Enemy Attacks via `ctx.fireAttack`)
export const enemiesPlugin: Plugin = {
  id: "enemies",
  register(api) {
    api.registerEntityKind({
      kind: "enemy",
      components: [
        "enemy",
        "position",
        "health",
        "pathProgress",
        "attacks",
        "cooldownTimer",
        "engagement",
      ],
    });

    // Sticky engagement on the Enemy side. Counts Enemies-per-Guard so the
    // `enemyEngagementCap` GameRule limits how many Enemies engage one Guard.
    // ADR-0010 (rule 1) — engagement is mutual subject to this cap.
    api.registerSystem({
      id: "enemies/engagement",
      phase: Phase.Simulation,
      reads: ["enemy", "position", "engagement", "attacks"],
      writes: ["engagement"],
      run(ctx: SystemContext) {
        const cap = (ctx.gameRules.get("enemyEngagementCap") as number) ?? 3;
        const armedEnemies = ctx.world
          .query({ all: ["enemy", "position", "attacks"] })
          .filter((e) => {
            const a = e.components.get("attacks") as
              | ReadonlyArray<AttackData>
              | undefined;
            return Array.isArray(a) && a.length > 0;
          });

        // Phase 1: validate sticky engagements. Each Enemy keeps its current
        // target as long as the Guard exists and remains in range of at least
        // one of the Enemy's Attacks. Counts feed into the cap check below.
        const engagementsPerGuard = new Map<string, number>();
        const needsSelection: typeof armedEnemies = [];
        for (const e of armedEnemies) {
          const ePos = e.components.get("position") as Position;
          const attacks = e.components.get("attacks") as ReadonlyArray<AttackData>;
          const eng = e.components.get("engagement") as
            | { target?: string }
            | undefined;
          if (eng?.target) {
            const target = ctx.world.get(eng.target);
            const tPos = target?.components.get("position") as Position | undefined;
            if (target && tPos) {
              const dx = tPos.x - ePos.x;
              const dy = tPos.y - ePos.y;
              const distSq = dx * dx + dy * dy;
              const inRange = attacks.some(
                (a) => distSq <= a.stats.range * a.stats.range,
              );
              if (inRange) {
                engagementsPerGuard.set(
                  eng.target,
                  (engagementsPerGuard.get(eng.target) ?? 0) + 1,
                );
                continue;
              }
            }
            ctx.world.mutate(e.id, "engagement", () => ({}));
          }
          needsSelection.push(e);
        }

        // Phase 2: select new engagements respecting the cap.
        const guards = ctx.world.query({ all: ["guard", "position"] });
        for (const e of needsSelection) {
          const ePos = e.components.get("position") as Position;
          const attacks = e.components.get("attacks") as ReadonlyArray<AttackData>;
          const eligible = guards.filter((g) => {
            if ((engagementsPerGuard.get(g.id) ?? 0) >= cap) return false;
            const gPos = g.components.get("position") as Position;
            const dx = gPos.x - ePos.x;
            const dy = gPos.y - ePos.y;
            const distSq = dx * dx + dy * dy;
            const tags = entityTags(g.components);
            return attacks.some((a) => {
              if (distSq > a.stats.range * a.stats.range) return false;
              return matchesFilter(tags, a.targetFilter);
            });
          });
          if (eligible.length === 0) {
            // Ensure an `engagement` component exists for queries even when
            // the Enemy has nothing to engage; movement halt looks for
            // `engagement.target`, not the Component's presence.
            if (!(e.components.get("engagement"))) {
              ctx.world.mutate(e.id, "engagement", () => ({}));
            }
            continue;
          }

          const archetypeId = (e.components.get("enemy") as { archetype: string })
            .archetype;
          const archetype = (ctx.registry.enemies as Record<
            string,
            EnemyArchetype | undefined
          >)[archetypeId];
          const targetingConfig: TargetingStrategyConfig =
            archetype?.targeting ?? DEFAULT_TARGETING;
          const strategyDef = ctx.targetingStrategies.get(targetingConfig.kind);
          if (!strategyDef) continue;

          const picked = strategyDef.select({
            source: { id: e.id, position: { ...ePos } },
            basePosition: { ...ePos },
            eligible: eligible as TargetingCandidate[],
            config: targetingConfig,
          });
          if (picked) {
            ctx.world.mutate(e.id, "engagement", () => ({ target: picked.id }));
            engagementsPerGuard.set(
              picked.id,
              (engagementsPerGuard.get(picked.id) ?? 0) + 1,
            );
          }
        }
      },
    });

    // Enemy firing. Each engaged Enemy decrements cooldown, picks an Attack
    // via its archetype's AttackSelectionStrategy, and queues a fire via
    // `ctx.fireAttack`. Damage / status / etc. flow through `attack-effects`
    // just like Tower and Guard fires.
    api.registerSystem({
      id: "enemies/attack",
      phase: Phase.Simulation,
      reads: ["enemy", "engagement", "position", "attacks", "cooldownTimer"],
      writes: ["cooldownTimer", "pendingFires"],
      after: ["enemies/engagement"],
      run(ctx: SystemContext) {
        for (const e of ctx.world.query({
          all: ["enemy", "engagement", "position", "attacks"],
        })) {
          const eng = e.components.get("engagement") as { target?: string };
          if (!eng.target) continue;
          const guard = ctx.world.get(eng.target);
          if (!guard) continue;
          const cd = e.components.get("cooldownTimer") as
            | { remaining: number }
            | undefined;
          const remaining = cd?.remaining ?? 0;
          const newRemaining = Math.max(0, remaining - ctx.dt);
          ctx.world.mutate(e.id, "cooldownTimer", () => ({ remaining: newRemaining }));
          if (newRemaining > 0) continue;

          const attacks = e.components.get("attacks") as ReadonlyArray<AttackData>;
          const ePos = e.components.get("position") as Position;
          const gPos = guard.components.get("position") as Position;
          const targetTags = entityTags(guard.components);
          const dx = gPos.x - ePos.x;
          const dy = gPos.y - ePos.y;
          const distSq = dx * dx + dy * dy;

          const eligible: AttackSelectionCandidate[] = attacks
            .filter((a) => distSq <= a.stats.range * a.stats.range)
            .filter((a) => matchesFilter(targetTags, a.targetFilter))
            .map((a) => ({
              id: a.id,
              stats: a.stats,
              ...(a.targetFilter !== undefined ? { targetFilter: a.targetFilter } : {}),
              effects: a.effects,
            }));
          if (eligible.length === 0) continue;

          const archetypeId = (e.components.get("enemy") as { archetype: string })
            .archetype;
          const archetype = (ctx.registry.enemies as Record<
            string,
            EnemyArchetype | undefined
          >)[archetypeId];
          const selectionConfig: AttackSelectionStrategyConfig =
            archetype?.attackSelection ?? DEFAULT_ATTACK_SELECTION;
          const selectionDef = ctx.attackSelectionStrategies.get(selectionConfig.kind);
          if (!selectionDef) continue;
          const chosen = selectionDef.select({
            source: { id: e.id, position: { ...ePos } },
            eligible,
            config: selectionConfig,
            attackEffects: ctx.attackEffects,
            world: ctx.world,
            resolveTarget: () => ({ id: guard.id, position: { ...gPos } }),
          });
          if (!chosen) continue;

          const fired = ctx.fireAttack({
            attacker: e.id,
            attack: {
              id: chosen.id,
              stats: chosen.stats,
              effects: chosen.effects,
              ...(chosen.targetFilter !== undefined
                ? { targetFilter: chosen.targetFilter }
                : {}),
            },
            primaryTarget: guard.id,
          });
          if (!fired) continue;

          ctx.emit({
            kind: "enemyAttacked",
            tick: ctx.tickIndex,
            enemy: e.id,
            guard: guard.id,
            attackId: chosen.id,
          });
        }
      },
    });
  },
};
