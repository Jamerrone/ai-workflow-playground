import type { ConfigRegistry } from "../types.js";

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
  readonly waves?: Record<string, unknown>;
  readonly scenarios?: Record<string, unknown>;
  readonly upgrades?: Record<string, unknown>;
  readonly difficulties?: Record<string, unknown>;
  readonly gameRules?: Record<string, unknown>;
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
}

export const BUCKETS = [
  "components",
  "entityKinds",
  "maps",
  "towers",
  "enemies",
  "waves",
  "scenarios",
  "upgrades",
  "difficulties",
  "gameRules",
] as const;
export type Bucket = (typeof BUCKETS)[number];
