import type { Plugin } from "../../types.js";

export interface EnemyArchetype {
  readonly tags: readonly string[];
  readonly stats: {
    readonly hp: number;
    readonly speed: number;
    readonly baseDamage: number;
  };
  readonly killReward: number;
}

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

// Built-in Enemy plugin. Owns no Systems or Components — the wave/movement
// plugins already own the runtime side — but it exists as the canonical home
// of built-in Enemy archetype data. Scenarios compose archetypes into their
// own ConfigRegistry by referencing the exported constants.
export const enemiesPlugin: Plugin = {
  id: "enemies",
  register() {},
};
