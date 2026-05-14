import type { ConfigRegistry } from "../types.js";

/**
 * Per-entry context handed to a bucket validator. Validators read fields off
 * `entry`, push structured errors via `addError`/`addWarning`, and may consult
 * `input` for cross-bucket references (e.g. Scenario looking up its Map). The
 * shared error accumulator preserves the Loader's collect-all-errors contract
 * (ADR-0013) — validators must never throw.
 */
export interface BucketValidatorContext {
  readonly bucket: string;
  readonly id: string;
  readonly entry: Record<string, unknown>;
  readonly path: string;
  readonly input: LoaderInput;
  readonly options: LoaderOptions;
  readonly abstractIds: ReadonlyMap<string, ReadonlySet<string>>;
  addError(error: LoaderError): void;
  addWarning(warning: LoaderError): void;
}

/**
 * Plugin-contributed validator for a Loader bucket. Built-in plugins register
 * one per bucket they own (Maps, Towers, Enemies, Waves, Scenarios, Upgrades);
 * third-party plugins can contribute validators for entirely new buckets.
 */
export interface BucketValidatorDef {
  readonly bucket: string;
  validate(ctx: BucketValidatorContext): void;
}

export interface LoaderErrorSource {
  readonly file: string;
  readonly line?: number;
  readonly col?: number;
}

export interface LoaderError {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly source?: LoaderErrorSource;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly hint?: string;
}

export type LoaderResult =
  | { readonly ok: true; readonly registry: ConfigRegistry; readonly warnings: readonly LoaderError[] }
  | { readonly ok: false; readonly errors: readonly LoaderError[]; readonly warnings: readonly LoaderError[] };

export interface LoaderInput {
  readonly components?: Record<string, unknown>;
  readonly entityKinds?: Record<string, unknown>;
  readonly maps?: Record<string, unknown>;
  readonly towers?: Record<string, unknown>;
  readonly enemies?: Record<string, unknown>;
  readonly summons?: Record<string, unknown>;
  readonly waves?: Record<string, unknown>;
  readonly scenarios?: Record<string, unknown>;
  readonly upgrades?: Record<string, unknown>;
  readonly difficulties?: Record<string, unknown>;
  readonly gameRules?: Record<string, unknown>;
  // Custom plugin-contributed buckets (e.g. a `heroes` bucket from a third-party
  // plugin) may live alongside the built-ins. The Loader iterates entries with
  // `Object.entries`, so callers can attach extra string-keyed buckets that the
  // registered validators will see; the typed surface stays focused on the
  // built-in bucket names.
}

export interface PluginManifestEntry {
  readonly plugin: string;
  readonly registry: string;
  readonly kind: string;
}

export interface LoaderOptions {
  readonly strict?: boolean;
  readonly pluginManifest?: readonly PluginManifestEntry[];
  readonly knownKindHints?: ReadonlyMap<string, string>;
  /**
   * AttackEffect kinds whose registered AttackEffectDef provides a `damagePreview`.
   * Supplements the Loader's built-in set. When a Tower configures
   * `attackSelection: { kind: "highest-damage" }`, the Loader emits a warning for
   * every Attack effect whose kind is not in the combined set.
   */
  readonly damagePreviewKinds?: ReadonlySet<string>;
  /**
   * GameRule keys some plugin registers via `registerGameRule`. When supplied,
   * a Scenario's `gameRuleOverrides` referencing any key outside this set
   * triggers an UNKNOWN_GAME_RULE error (mirrors UNKNOWN_KIND). Omitting the
   * option disables the check (back-compat for callers that don't yet wire
   * plugin metadata into the Loader).
   */
  readonly knownGameRuleKeys?: ReadonlySet<string>;
  /** Optional `key → registering plugin id` map; populates the UNKNOWN_GAME_RULE hint. */
  readonly knownGameRuleHints?: ReadonlyMap<string, string>;
  /**
   * Plugin-contributed per-bucket validators. The Loader dispatches each entry
   * to its bucket's validator. Built-in buckets (Maps, Towers, Enemies, Waves,
   * Scenarios, Upgrades) are populated by the built-in plugins; third-party
   * plugins can register validators for entirely new buckets. The wrapping
   * `buildRegistry` in `src/index.ts` defaults this to the built-in bundle's
   * validators when omitted.
   */
  readonly bucketValidators?: ReadonlyMap<string, BucketValidatorDef>;
}

export const BUCKETS = [
  "components",
  "entityKinds",
  "maps",
  "towers",
  "enemies",
  "summons",
  "waves",
  "scenarios",
  "upgrades",
  "difficulties",
  "gameRules",
] as const;
export type Bucket = (typeof BUCKETS)[number];
