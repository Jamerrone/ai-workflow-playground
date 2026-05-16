const FORBIDDEN_MATH = new Set([
  "sin", "cos", "tan",
  "asin", "acos", "atan", "atan2",
  "exp", "log",
  "random",
]);

// Captured once at module load — restored after every withTickMath call.
const _originalMath = globalThis.Math;
let _activeSystemId = "<none>";

const _mathProxy = new Proxy(_originalMath, {
  get(target, prop) {
    const name = String(prop);
    if (FORBIDDEN_MATH.has(name)) {
      throw new Error(
        `Math.${name}() is forbidden in tick code (System '${_activeSystemId}'): ` +
          `transcendental or non-deterministic — breaks determinism. ` +
          `Allowed: arithmetic operators, Math.sqrt, Math.abs, Math.floor, Math.ceil, Math.round, Math.trunc.`,
      );
    }
    if (name === "pow") {
      return (base: number, exp: number): number => {
        if (!Number.isInteger(exp)) {
          throw new Error(
            `Math.pow() with non-integer exponent (${exp}) is forbidden in tick code ` +
              `(System '${_activeSystemId}'): breaks determinism.`,
          );
        }
        return _originalMath.pow(base, exp);
      };
    }
    const val = Reflect.get(target, prop);
    return typeof val === "function"
      ? (val as (...args: unknown[]) => unknown).bind(target)
      : val;
  },
}) as typeof Math;

const _isProd =
  typeof process !== "undefined" && process.env.NODE_ENV === "production";

export function withTickMath<T>(systemId: string, fn: () => T): T {
  if (_isProd) return fn();
  const prevId = _activeSystemId;
  _activeSystemId = systemId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Math = _mathProxy;
  try {
    return fn();
  } finally {
    _activeSystemId = prevId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Math = _originalMath;
  }
}
