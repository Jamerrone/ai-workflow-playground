import type { ActionResult } from "../types.js";

/**
 * Build a typed `ActionResult` failure. The `hint` field is only included when
 * provided, satisfying `exactOptionalPropertyTypes`. Shared by the kernel's
 * `dispatch` and by every built-in PlayerActionHandler so failure shapes stay
 * uniform across the engine.
 */
export function actionFailure(
  code: string,
  message: string,
  hint?: string,
): ActionResult {
  return hint === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, hint };
}
