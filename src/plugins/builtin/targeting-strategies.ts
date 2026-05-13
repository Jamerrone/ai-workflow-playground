import type {
  Plugin,
  Position,
  TargetingCandidate,
  TargetingStrategyDef,
  TargetingStrategyValidationResult,
} from "../../types.js";

function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function entityPosition(c: TargetingCandidate): Position {
  return c.components.get("position") as Position;
}

function entityHp(c: TargetingCandidate): number {
  return (c.components.get("health") as { hp: number } | undefined)?.hp ?? 0;
}

function entityTags(c: TargetingCandidate): readonly string[] {
  return (c.components.get("enemy") as { tags?: readonly string[] } | undefined)?.tags ?? [];
}

function closestToBaseAmong(
  candidates: ReadonlyArray<TargetingCandidate>,
  base: Position,
): TargetingCandidate | undefined {
  // world.query returns insertion-order, which serves as the deterministic tie-break.
  let best: TargetingCandidate | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = manhattan(entityPosition(c), base);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

const closestToBaseStrategy: TargetingStrategyDef = {
  kind: "closest-to-base",
  validate: () => ({ ok: true }),
  select: (ctx) => closestToBaseAmong(ctx.eligible, ctx.basePosition),
};

function pickByHp(
  candidates: ReadonlyArray<TargetingCandidate>,
  pick: "lowest" | "highest",
): TargetingCandidate | undefined {
  let best: TargetingCandidate | undefined;
  let bestHp = pick === "lowest" ? Infinity : -Infinity;
  for (const c of candidates) {
    const hp = entityHp(c);
    if (pick === "lowest" ? hp < bestHp : hp > bestHp) {
      best = c;
      bestHp = hp;
    }
  }
  return best;
}

const lowestHpStrategy: TargetingStrategyDef = {
  kind: "lowest-hp",
  validate: () => ({ ok: true }),
  select: (ctx) => pickByHp(ctx.eligible, "lowest"),
};

const highestHpStrategy: TargetingStrategyDef = {
  kind: "highest-hp",
  validate: () => ({ ok: true }),
  select: (ctx) => pickByHp(ctx.eligible, "highest"),
};

const tagPriorityStrategy: TargetingStrategyDef = {
  kind: "tag-priority",
  validate(config): TargetingStrategyValidationResult {
    if (typeof config !== "object" || config === null) {
      return { ok: false, reason: "not an object" };
    }
    const priority = (config as { priority?: unknown }).priority;
    if (!Array.isArray(priority) || priority.length === 0) {
      return { ok: false, reason: "priority must be a non-empty string array" };
    }
    if (!priority.every((t) => typeof t === "string")) {
      return { ok: false, reason: "priority must contain only strings" };
    }
    return { ok: true };
  },
  select(ctx) {
    const priority =
      (ctx.config as { priority?: readonly string[] }).priority ?? [];
    for (const tag of priority) {
      const matching = ctx.eligible.filter((c) => entityTags(c).includes(tag));
      if (matching.length === 0) continue;
      return closestToBaseAmong(matching, ctx.basePosition);
    }
    return undefined;
  },
};

export const targetingStrategiesPlugin: Plugin = {
  id: "targeting-strategies",
  register(api) {
    api.registerTargetingStrategy(closestToBaseStrategy);
    api.registerTargetingStrategy(lowestHpStrategy);
    api.registerTargetingStrategy(highestHpStrategy);
    api.registerTargetingStrategy(tagPriorityStrategy);
  },
};
