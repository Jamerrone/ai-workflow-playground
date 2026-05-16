import type { AttackEffectConfig, EntityComponents } from "../../types.js";

export interface AttackData {
  readonly id: string;
  readonly stats: { readonly range: number; readonly cooldown: number; readonly [key: string]: number };
  readonly effects: ReadonlyArray<AttackEffectConfig>;
  readonly targetFilter?: {
    readonly require?: readonly string[];
    readonly exclude?: readonly string[];
  };
}

export function matchesFilter(
  tags: readonly string[],
  filter?: { readonly require?: readonly string[]; readonly exclude?: readonly string[] },
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

export function entityTags(components: EntityComponents): readonly string[] {
  const enemy = components.get("enemy");
  if (enemy?.tags) return enemy.tags;
  const guard = components.get("guard");
  if (guard?.tags) return guard.tags;
  return [];
}
