// Node-only Loader entry: walks a directory of JSON files, parses each, and
// delegates to buildRegistry for validation. Keep this file isolated from the
// shared engine entry (src/index.ts) so browser bundlers don't pull in `fs`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildRegistry } from "./index.js";
import {
  BUCKETS,
  type Bucket,
  type LoaderError,
  type LoaderOptions,
  type LoaderResult,
} from "./types.js";

const KNOWN_BUCKETS: ReadonlySet<string> = new Set(BUCKETS);

export function loadFromDirectory(
  rootPath: string,
  options: LoaderOptions = {},
): LoaderResult {
  const parseErrors: LoaderError[] = [];
  const sourceByEntry = new Map<string, string>(); // "bucket.id" -> file path

  // Build the in-memory LoaderInput by walking each known bucket subdir.
  const input: Partial<Record<Bucket, Record<string, unknown>>> = {};
  for (const bucket of BUCKETS) {
    const bucketDir = join(rootPath, bucket);
    if (!isDirectory(bucketDir)) continue;
    const bucketEntries: Record<string, unknown> = {};
    for (const file of walkJsonFiles(bucketDir)) {
      const id = basenameWithoutExt(file);
      const entryPath = `${bucket}.${id}`;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        parseErrors.push({
          severity: "error",
          code: "MALFORMED_JSON",
          path: entryPath,
          source: { file },
          message: `Could not read file: ${describeError(e)}.`,
          hint: "Check file permissions and path correctness.",
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        const { line, col } = extractLineCol(e, text);
        parseErrors.push({
          severity: "error",
          code: "MALFORMED_JSON",
          path: entryPath,
          source: line !== undefined && col !== undefined
            ? { file, line, col }
            : line !== undefined
            ? { file, line }
            : { file },
          message: `JSON parse failed: ${describeError(e)}.`,
          hint: "Fix the syntax error and re-run the Loader.",
        });
        continue;
      }
      bucketEntries[id] = parsed;
      sourceByEntry.set(entryPath, file);
    }
    if (Object.keys(bucketEntries).length > 0) {
      input[bucket] = bucketEntries;
    }
  }

  const validated = buildRegistry(input, options);
  const warnings = annotateSources(validated.warnings, sourceByEntry);

  if (!validated.ok) {
    return {
      ok: false,
      errors: [...parseErrors, ...annotateSources(validated.errors, sourceByEntry)],
      warnings,
    };
  }

  // Parse failures (unparsable JSON files) must surface as loader errors even when
  // the rest of the registry validates cleanly.
  if (parseErrors.length > 0) {
    return { ok: false, errors: parseErrors, warnings };
  }

  return { ok: true, registry: validated.registry, warnings };
}

function annotateSources(
  list: readonly LoaderError[],
  sources: ReadonlyMap<string, string>,
): LoaderError[] {
  return list.map((e) => {
    if (e.source !== undefined) return e;
    const key = entryKeyFromPath(e.path);
    if (key === undefined) return e;
    const file = sources.get(key);
    if (file === undefined) return e;
    return { ...e, source: { file } };
  });
}

function entryKeyFromPath(p: string): string | undefined {
  // Path shape: "bucket.id" or "bucket.id.field" or "bucket.id.field[0].x".
  // The first two dotted segments identify the owning entry.
  const parts = p.split(/[.[]/, 3);
  if (parts.length < 2) return undefined;
  if (!parts[0] || !parts[1]) return undefined;
  if (!KNOWN_BUCKETS.has(parts[0])) return undefined;
  return `${parts[0]}.${parts[1]}`;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function* walkJsonFiles(dir: string): Generator<string> {
  let entries: ReadonlyArray<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Stable iteration order by entry name keeps the walk deterministic across platforms.
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJsonFiles(full);
    } else if (e.isFile() && e.name.endsWith(".json")) {
      yield full;
    }
  }
}

function basenameWithoutExt(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const name = slash >= 0 ? file.slice(slash + 1) : file;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// Extracts line and 1-based column from a SyntaxError thrown by JSON.parse.
// Node surfaces either "(line L column C)" or "at position P" depending on the
// engine version; we handle both, falling back to undefined when neither is present.
function extractLineCol(
  err: unknown,
  text: string,
): { line?: number; col?: number } {
  const message = err instanceof Error ? err.message : "";
  const lineColMatch = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColMatch) {
    return { line: Number(lineColMatch[1]), col: Number(lineColMatch[2]) };
  }
  const posMatch = /at position (\d+)/.exec(message);
  if (posMatch) {
    const pos = Math.min(Number(posMatch[1]), text.length);
    let line = 1;
    let col = 1;
    for (let i = 0; i < pos; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
    }
    return { line, col };
  }
  return {};
}
