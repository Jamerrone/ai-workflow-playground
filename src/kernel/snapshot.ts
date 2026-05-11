import type { WorldImpl } from "./world.js";

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) =>
        JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`Non-serializable value in snapshot: ${typeof value}`);
}

function formatNumber(n: number): string {
  // Stable representation: collapse -0 → 0, reject NaN/Infinity (forbidden by
  // the determinism contract), preserve int-vs-float distinction via JSON.
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    throw new Error(`Non-finite number forbidden in snapshot: ${n}`);
  }
  if (Object.is(n, -0)) return "0";
  return JSON.stringify(n);
}

export function serializeWorld(world: WorldImpl, tickIndex: number): string {
  const entities = world
    .allEntitiesInOrder()
    .map((e) => ({ id: e.id, components: Object.fromEntries(e.components) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonical({ tick: tickIndex, entities });
}
