import type { ConfigRegistry, Plugin, RegistrationApi } from "../types.js";
import { builtInBundle } from "../plugins/builtin/index.js";
import { resolveInheritance } from "./inheritance.js";
import { normalizeShorthand, isObject } from "./normalize.js";
import { checkReferences } from "./references.js";
import {
  BUCKETS,
  type BucketValidatorDef,
  type LoaderError,
  type LoaderInput,
  type LoaderOptions,
  type LoaderResult,
} from "./types.js";
import { validateAll } from "./validate.js";

// Default bucket validators — the set contributed by the built-in plugin bundle.
// Callers that pass their own `options.bucketValidators` bypass this. Built-in
// plugins are imported through the plugin surface (registerBucketValidator);
// the Loader contains no hardcoded bucket-validator list of its own.
let defaultValidators: ReadonlyMap<string, BucketValidatorDef> | null = null;
function getDefaultValidators(): ReadonlyMap<string, BucketValidatorDef> {
  if (defaultValidators === null) {
    defaultValidators = collectBucketValidators(builtInBundle);
  }
  return defaultValidators;
}

export type {
  BucketValidatorContext,
  BucketValidatorDef,
  LoaderError,
  LoaderErrorSource,
  LoaderInput,
  LoaderOptions,
  LoaderResult,
  PluginManifestEntry,
} from "./types.js";

/**
 * Run each Plugin through a minimal RegistrationApi that captures only bucket
 * validators. Returned map keys the validator by its `bucket` field. Used by
 * the wrapping `buildRegistry` in `src/index.ts` to default the Loader to the
 * built-in bundle, and exported so third-party hosts can assemble their own
 * Plugin sets.
 */
export function collectBucketValidators(
  plugins: readonly Plugin[],
): ReadonlyMap<string, BucketValidatorDef> {
  const validators = new Map<string, BucketValidatorDef>();
  const noop = (): void => {};
  const api: RegistrationApi = {
    registerComponent: noop,
    registerEntityKind: noop,
    registerSystem: noop,
    registerActionHandler: noop,
    registerPlacementMode: noop,
    registerMapFeature: noop,
    registerAttackEffect: noop,
    registerReward: noop,
    registerTargetingStrategy: noop,
    registerAttackSelectionStrategy: noop,
    registerUpgradeOp: noop,
    registerGameRule: noop,
    registerBucketValidator(def) {
      validators.set(def.bucket, def);
    },
    onScenarioLoad: noop,
  };
  for (const plugin of plugins) plugin.register(api);
  return validators;
}

export function buildRegistry(
  rawInput: LoaderInput,
  options: LoaderOptions = {},
): LoaderResult {
  // Default bucketValidators to the built-in plugin bundle's contributions
  // when the caller didn't supply their own. The wrapped Loader still has no
  // hardcoded bucket dispatch — validators arrive via the plugin surface.
  const effectiveOptions: LoaderOptions =
    options.bucketValidators !== undefined
      ? options
      : { ...options, bucketValidators: getDefaultValidators() };
  const errors: LoaderError[] = [];
  const warnings: LoaderError[] = [];

  // Pass 1: shorthand normalisation.
  const normalised = normalizeShorthand(rawInput);

  // Pass 2: template inheritance.
  const { input: resolved, errors: inheritanceErrors, abstractIds } =
    resolveInheritance(normalised);
  errors.push(...inheritanceErrors);

  // Pass 3: per-entry validation (units, kinds, required fields).
  validateAll({
    input: resolved,
    options: effectiveOptions,
    errors,
    warnings,
    abstractIds,
  });

  // Pass 4: build the set of valid ids (entries that passed validation), and run
  // referential integrity over that subset.
  const errorsByEntry = groupErrorsByEntry(errors);
  const validIds: Record<string, Set<string>> = {};
  for (const bucket of BUCKETS) {
    const entries = resolved[bucket] ?? {};
    const ids = new Set<string>();
    for (const id of Object.keys(entries)) {
      // An entry "passes validation" if no error is rooted at its own path.
      if (!errorsByEntry.has(`${bucket}.${id}`)) ids.add(id);
    }
    validIds[bucket] = ids;
  }
  checkReferences(resolved, validIds, abstractIds, errors);

  // Pass 5: REGISTRY_REPLACEMENT warnings from the plugin manifest.
  if (options.pluginManifest) {
    const seen = new Map<string, string>();
    for (const entry of options.pluginManifest) {
      const key = `${entry.registry}:${entry.kind}`;
      const prev = seen.get(key);
      if (prev !== undefined && prev !== entry.plugin) {
        warnings.push({
          severity: "warning",
          code: "REGISTRY_REPLACEMENT",
          path: `${entry.registry}:${entry.kind}`,
          message: `Plugin '${entry.plugin}' replaced '${entry.registry}:${entry.kind}' previously registered by '${prev}'.`,
          hint: "If this replacement is intentional, suppress this warning by filtering REGISTRY_REPLACEMENT in your loader.",
        });
      }
      seen.set(key, entry.plugin);
    }
  }

  // Pass 6: strict mode promotes warnings to errors.
  if (options.strict && warnings.length > 0) {
    const promoted = warnings.map((w): LoaderError => ({ ...w, severity: "error" }));
    return { ok: false, errors: [...errors, ...promoted], warnings };
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Build the validated ConfigRegistry by stripping inheritance scaffolding (abstract
  // templates excluded; `extends` already removed by the inheritance pass).
  const registry = buildValidatedRegistry(resolved, abstractIds);
  return { ok: true, registry, warnings };
}

function groupErrorsByEntry(errors: readonly LoaderError[]): Set<string> {
  const set = new Set<string>();
  for (const e of errors) {
    // Entry root path is the first two segments (e.g. "towers.archer").
    const parts = e.path.split(/[.[]/);
    if (parts.length >= 2) set.add(`${parts[0]}.${parts[1]}`);
  }
  return set;
}

function buildValidatedRegistry(
  resolved: LoaderInput,
  abstractIds: ReadonlyMap<string, ReadonlySet<string>>,
): ConfigRegistry {
  const out: Record<string, Record<string, unknown>> = Object.fromEntries(
    BUCKETS.map((b) => [b, {} as Record<string, unknown>]),
  );
  for (const bucket of BUCKETS) {
    const entries = resolved[bucket] ?? {};
    const absSet = abstractIds.get(bucket) ?? new Set<string>();
    for (const [id, entry] of Object.entries(entries)) {
      if (absSet.has(id)) continue; // exclude abstract templates from runtime registry
      out[bucket]![id] = isObject(entry) ? stripAbstract(entry) : entry;
    }
  }
  return out as unknown as ConfigRegistry;
}

function stripAbstract(entry: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...entry };
  delete clone.abstract;
  return clone;
}

export function formatLoaderErrors(errors: readonly LoaderError[]): string {
  return errors.map(formatOne).join("\n\n");
}

function formatOne(e: LoaderError): string {
  const head = `${e.severity.toUpperCase().padEnd(7)} ${e.code}`;
  const lines = [head + formatSource(e.source), `  ${e.path}`, `  ${e.message}`];
  if (e.expected !== undefined) lines.push(`  expected: ${e.expected}`);
  if (e.actual !== undefined) lines.push(`  actual:   ${e.actual}`);
  if (e.hint !== undefined) lines.push(`  hint:     ${e.hint}`);
  return lines.join("\n");
}

function formatSource(source: LoaderError["source"]): string {
  if (!source) return "";
  const line = source.line !== undefined ? `:${source.line}` : "";
  const col = source.col !== undefined ? `:${source.col}` : "";
  return `  ${source.file}${line}${col}`;
}
