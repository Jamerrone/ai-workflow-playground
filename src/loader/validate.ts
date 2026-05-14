import { isObject } from "./normalize.js";
import type {
  BucketValidatorContext,
  BucketValidatorDef,
  LoaderError,
  LoaderInput,
  LoaderOptions,
} from "./types.js";

// Field-name suffixes forbidden by ADR-0004 (canonical-units doctrine).
const FORBIDDEN_SUFFIXES = ["Ms", "Sec", "PerSec", "Tiles", "Pixels", "WorldUnits"] as const;

export interface ValidationContext {
  readonly input: LoaderInput;
  readonly options: LoaderOptions;
  readonly errors: LoaderError[];
  readonly warnings: LoaderError[];
  readonly abstractIds: ReadonlyMap<string, ReadonlySet<string>>;
}

export function validateAll(ctx: ValidationContext): void {
  checkUnitSuffixesEverywhere(ctx);
  const validators = ctx.options.bucketValidators;
  if (!validators) return;
  const inputRecord = ctx.input as Record<string, Record<string, unknown> | undefined>;
  for (const [bucket, validator] of validators) {
    const entries = inputRecord[bucket];
    if (!entries) continue;
    for (const [id, entry] of Object.entries(entries)) {
      dispatchValidator(ctx, validator, bucket, id, entry);
    }
  }
}

function dispatchValidator(
  ctx: ValidationContext,
  validator: BucketValidatorDef,
  bucket: string,
  id: string,
  raw: unknown,
): void {
  if (!isObject(raw)) {
    ctx.errors.push({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${bucket}.${id}`,
      message: `Entry '${id}' in ${bucket} is not an object.`,
      expected: "object",
      actual: typeof raw,
    });
    return;
  }
  const validatorContext: BucketValidatorContext = {
    bucket,
    id,
    entry: raw,
    path: `${bucket}.${id}`,
    input: ctx.input,
    options: ctx.options,
    abstractIds: ctx.abstractIds,
    addError(e) {
      ctx.errors.push(e);
    },
    addWarning(w) {
      ctx.warnings.push(w);
    },
  };
  validator.validate(validatorContext);
}

function checkUnitSuffixesEverywhere(ctx: ValidationContext): void {
  for (const [bucket, entries] of Object.entries(ctx.input)) {
    if (!entries) continue;
    for (const [id, entry] of Object.entries(entries)) {
      walkFieldNames(entry, `${bucket}.${id}`, (fieldName, path) => {
        for (const suffix of FORBIDDEN_SUFFIXES) {
          // Suffix match must be at the end and capitalised (e.g. "cooldownMs" not "demos").
          if (
            fieldName.length > suffix.length &&
            fieldName.endsWith(suffix) &&
            // The char before the suffix must be lowercase to avoid false-positive matches
            // against words that happen to end in those letters (e.g. "rangeTiles" ✓; "antiles" ✗).
            isLowerCase(fieldName[fieldName.length - suffix.length - 1]!)
          ) {
            ctx.errors.push({
              severity: "error",
              code: "UNIT_SUFFIX_FORBIDDEN",
              path,
              message: `Field name '${fieldName}' uses a forbidden unit suffix '${suffix}'.`,
              expected: "no unit suffix; canonical units (seconds, tiles, 0-1 ratios)",
              actual: fieldName,
              hint: "Rename the field; all engine quantities use canonical units (see ADR-0004).",
            });
            break;
          }
        }
      });
    }
  }
}

function isLowerCase(c: string): boolean {
  return c >= "a" && c <= "z";
}

function walkFieldNames(
  node: unknown,
  path: string,
  visit: (fieldName: string, path: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkFieldNames(item, `${path}[${i}]`, visit));
    return;
  }
  if (!isObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    visit(k, `${path}.${k}`);
    walkFieldNames(v, `${path}.${k}`, visit);
  }
}
