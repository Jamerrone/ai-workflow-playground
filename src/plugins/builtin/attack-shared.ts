import type { AttackEffectConfig } from "../../types.js";

export interface AttackData {
  readonly id: string;
  readonly stats: { readonly range: number; readonly cooldown: number };
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

export function entityTags(components: ReadonlyMap<string, unknown>): readonly string[] {
  for (const name of ["enemy", "guard"]) {
    const c = components.get(name) as { tags?: readonly string[] } | undefined;
    if (c?.tags) return c.tags;
  }
  return [];
}
