import { isObject } from "./normalize.js";
import type { LoaderError, LoaderInput } from "./types.js";
import { BUCKETS } from "./types.js";

interface InheritanceResult {
  readonly input: LoaderInput;
  readonly errors: readonly LoaderError[];
  // Set of entry references that resolved through abstract templates; used so a Scenario
  // referencing an `abstract: true` entry can be flagged as ABSTRACT_REFERENCED.
  readonly abstractIds: ReadonlyMap<string, ReadonlySet<string>>;
}

export function resolveInheritance(input: LoaderInput): InheritanceResult {
  const errors: LoaderError[] = [];
  const abstractIds = new Map<string, Set<string>>();
  for (const bucket of BUCKETS) abstractIds.set(bucket, new Set());

  const inputRecord = input as Record<string, Record<string, unknown> | undefined>;
  const presentBuckets = Object.keys(inputRecord);

  // Pass 1: identify abstract templates so references to them can be flagged later.
  for (const bucket of presentBuckets) {
    const entries = inputRecord[bucket];
    if (!entries) continue;
    if (!abstractIds.has(bucket)) abstractIds.set(bucket, new Set());
    for (const [id, entry] of Object.entries(entries)) {
      if (isObject(entry) && entry.abstract === true) {
        abstractIds.get(bucket)!.add(id);
      }
    }
  }

  // Pass 2: resolve `extends` per entry with cycle detection and cross-kind
  // rejection. Iterates over every bucket present in the input — including
  // plugin-contributed custom buckets, so they receive the same inheritance
  // semantics as built-in buckets.
  const resolved: Record<string, Record<string, unknown>> = {};
  for (const bucket of presentBuckets) {
    const entries = inputRecord[bucket];
    if (!entries) continue;
    const memo = new Map<string, Record<string, unknown> | null>();
    const outBucket: Record<string, unknown> = {};
    for (const id of Object.keys(entries)) {
      const merged = resolveOne(bucket, id, entries, memo, new Set(), errors);
      if (merged !== null) outBucket[id] = merged;
    }
    resolved[bucket] = outBucket;
  }

  return { input: resolved as LoaderInput, errors, abstractIds };
}

function resolveOne(
  bucket: string,
  id: string,
  entries: Record<string, unknown>,
  memo: Map<string, Record<string, unknown> | null>,
  stack: Set<string>,
  errors: LoaderError[],
): Record<string, unknown> | null {
  if (memo.has(id)) return memo.get(id)!;
  if (stack.has(id)) {
    errors.push({
      severity: "error",
      code: "INHERITANCE_CYCLE",
      path: `${bucket}.${id}`,
      message: `Inheritance cycle detected: ${[...stack, id].join(" -> ")}`,
      hint: "Break the cycle by removing one of the 'extends' links.",
    });
    memo.set(id, null);
    return null;
  }
  const raw = entries[id];
  if (!isObject(raw)) {
    const passThrough = (raw ?? null) as Record<string, unknown> | null;
    memo.set(id, passThrough);
    return passThrough;
  }
  const parents = extractParents(raw, bucket);
  if (parents.length === 0) {
    const cloned = { ...raw };
    delete cloned.extends;
    memo.set(id, cloned);
    return cloned;
  }
  stack.add(id);
  let merged: Record<string, unknown> = {};
  for (const parentRef of parents) {
    if (parentRef.bucket !== bucket) {
      errors.push({
        severity: "error",
        code: "CROSS_KIND_INHERITANCE",
        path: `${bucket}.${id}.extends`,
        message: `'${id}' (${bucket}) cannot extend '${parentRef.id}' (${parentRef.bucket}). Templates must share the same kind bucket.`,
        expected: bucket,
        actual: parentRef.bucket,
      });
      continue;
    }
    if (!(parentRef.id in entries)) {
      errors.push({
        severity: "error",
        code: "MISSING_REFERENCE",
        path: `${bucket}.${id}.extends`,
        message: `Template '${parentRef.id}' referenced by 'extends' does not exist in ${bucket}.`,
        expected: `id in ${bucket}`,
        actual: parentRef.id,
      });
      continue;
    }
    const parent = resolveOne(bucket, parentRef.id, entries, memo, stack, errors);
    if (parent === null) continue;
    merged = deepMerge(merged, parent);
  }
  stack.delete(id);
  const childOwn: Record<string, unknown> = { ...raw };
  delete childOwn.extends;
  const final = deepMerge(merged, childOwn);
  memo.set(id, final);
  return final;
}

interface ParentRef {
  readonly bucket: string;
  readonly id: string;
}

function extractParents(raw: Record<string, unknown>, childBucket: string): readonly ParentRef[] {
  const ext = raw.extends;
  if (typeof ext === "string") return [parseRef(ext, childBucket)];
  if (Array.isArray(ext)) {
    return ext
      .filter((v): v is string => typeof v === "string")
      .map((s) => parseRef(s, childBucket));
  }
  return [];
}

function parseRef(ext: string, childBucket: string): ParentRef {
  const idx = ext.indexOf(":");
  return idx >= 0
    ? { bucket: ext.slice(0, idx), id: ext.slice(idx + 1) }
    : { bucket: childBucket, id: ext };
}

export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    if (isObject(existing) && isObject(value)) {
      out[key] = deepMerge(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      out[key] = mergeArrays(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeArrays(base: unknown[], overlay: unknown[]): unknown[] {
  // Per ADR-0012: merge by `id` (or by `kind` if every item has a unique kind) when keys
  // are stable; replace entirely otherwise.
  const baseKeyed = arrayKey(base);
  const overlayKeyed = arrayKey(overlay);
  if (baseKeyed === null || overlayKeyed === null || baseKeyed !== overlayKeyed) {
    return overlay.slice();
  }
  const key = baseKeyed;
  const merged: unknown[] = [];
  const indexById = new Map<string, number>();
  for (const item of base) {
    if (isObject(item)) {
      const k = item[key];
      if (typeof k === "string") indexById.set(k, merged.length);
      merged.push({ ...item });
    } else {
      merged.push(item);
    }
  }
  for (const item of overlay) {
    if (!isObject(item)) {
      merged.push(item);
      continue;
    }
    const k = item[key];
    if (typeof k === "string" && indexById.has(k)) {
      const idx = indexById.get(k)!;
      const existing = merged[idx];
      if (isObject(existing)) {
        merged[idx] = deepMerge(existing, item);
      } else {
        merged[idx] = item;
      }
    } else {
      if (typeof k === "string") indexById.set(k, merged.length);
      merged.push(item);
    }
  }
  return merged;
}

function arrayKey(arr: readonly unknown[]): "id" | "kind" | null {
  if (arr.length === 0) return null;
  const allObjects = arr.every(isObject);
  if (!allObjects) return null;
  const ids = arr.map((o) => (o as Record<string, unknown>).id);
  if (ids.every((v) => typeof v === "string")) {
    if (new Set(ids).size === ids.length) return "id";
  }
  const kinds = arr.map((o) => (o as Record<string, unknown>).kind);
  if (kinds.every((v) => typeof v === "string")) {
    if (new Set(kinds).size === kinds.length) return "kind";
  }
  return null;
}
