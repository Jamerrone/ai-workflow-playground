import type { SystemDef } from "../types.js";

export function resolveSystemOrder(systems: readonly SystemDef[]): SystemDef[] {
  if (systems.length === 0) return [];

  const byId = new Map<string, SystemDef>();
  for (const s of systems) byId.set(s.id, s);

  // Build dependency edges: predecessor → successor.
  const preds = new Map<string, Set<string>>(); // id → set of ids that must run first
  for (const s of systems) preds.set(s.id, new Set());

  for (const s of systems) {
    for (const a of s.after ?? []) {
      if (byId.has(a)) preds.get(s.id)!.add(a);
    }
    for (const b of s.before ?? []) {
      if (byId.has(b)) preds.get(b)!.add(s.id);
    }
  }

  // Kahn's algorithm with stable-id tie-break: always pick the lexicographically
  // smallest id among ready nodes.
  const remaining = new Set(byId.keys());
  const result: SystemDef[] = [];
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if (preds.get(id)!.size === 0) ready.push(id);
    }
    if (ready.length === 0) {
      throw new Error(
        `System ordering cycle detected among: ${[...remaining].sort().join(", ")}`,
      );
    }
    ready.sort();
    const pick = ready[0]!;
    result.push(byId.get(pick)!);
    remaining.delete(pick);
    for (const id of remaining) preds.get(id)!.delete(pick);
  }
  return result;
}
