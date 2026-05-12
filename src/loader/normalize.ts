import type { LoaderInput } from "./types.js";

// Field paths within an entry where a string is the shorthand form of `{ kind: <string> }`.
// Per ADR-0015, the Loader normalises strings to object form before any validator runs.
const SHORTHAND_FIELDS_BY_BUCKET: Record<string, readonly string[]> = {
  towers: ["targeting", "strategy"],
  maps: ["placementMode"],
  scenarios: ["waveTrigger"],
};

export function normalizeShorthand(input: LoaderInput): LoaderInput {
  const out: Record<string, Record<string, unknown>> = {};
  for (const bucket of Object.keys(input) as Array<keyof LoaderInput>) {
    const entries = input[bucket];
    if (!entries) continue;
    const fields = SHORTHAND_FIELDS_BY_BUCKET[bucket] ?? [];
    const outBucket: Record<string, unknown> = {};
    for (const [id, raw] of Object.entries(entries)) {
      outBucket[id] = normalizeEntry(raw, fields, bucket);
    }
    out[bucket] = outBucket;
  }
  return out as LoaderInput;
}

function normalizeEntry(
  entry: unknown,
  fields: readonly string[],
  bucket: string,
): unknown {
  if (!isObject(entry)) return entry;
  const clone: Record<string, unknown> = { ...entry };
  for (const field of fields) {
    if (typeof clone[field] === "string") {
      clone[field] = { kind: clone[field] };
    }
  }
  // Normalise nested AttackEffect / op kind shorthand. Towers carry attacks[].effects;
  // upgrades carry ops[]. Each item in such arrays accepts a string shorthand.
  if (bucket === "towers" && Array.isArray(clone.attacks)) {
    clone.attacks = (clone.attacks as unknown[]).map((atk) =>
      isObject(atk) && Array.isArray(atk.effects)
        ? { ...atk, effects: atk.effects.map(stringToKind) }
        : atk,
    );
  }
  if (bucket === "upgrades" && Array.isArray(clone.ops)) {
    clone.ops = (clone.ops as unknown[]).map(stringToKind);
  }
  return clone;
}

function stringToKind(item: unknown): unknown {
  return typeof item === "string" ? { kind: item } : item;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
