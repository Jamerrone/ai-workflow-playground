import { isObject } from "./normalize.js";
import type { LoaderError, LoaderInput } from "./types.js";

export function checkReferences(
  input: LoaderInput,
  validIds: Record<string, Set<string>>,
  abstractIds: ReadonlyMap<string, ReadonlySet<string>>,
  errors: LoaderError[],
): void {
  checkScenarioRefs(input, validIds, abstractIds, errors);
  checkWaveRefs(input, validIds, errors);
  checkUpgradeRefs(input, validIds, errors);
}

function checkScenarioRefs(
  input: LoaderInput,
  ids: Record<string, Set<string>>,
  abstract: ReadonlyMap<string, ReadonlySet<string>>,
  errors: LoaderError[],
): void {
  for (const [sid, s] of Object.entries(input.scenarios ?? {})) {
    if (!isObject(s)) continue;
    const base = `scenarios.${sid}`;
    checkScalarRef(`${base}.map`, "maps", s.map, ids, abstract, errors);
    checkScalarRef(`${base}.difficulty`, "difficulties", s.difficulty, ids, abstract, errors);
    if (Array.isArray(s.waves)) {
      s.waves.forEach((entry, i) => {
        if (!isObject(entry)) return;
        const wid = entry.id;
        if (typeof wid !== "string") return;
        const wpath = `${base}.waves[${i}].id`;
        if (!ids.waves?.has(wid)) {
          errors.push(missingRef(wpath, "waves", wid));
          return;
        }
        if (abstract.get("waves")?.has(wid)) {
          errors.push(abstractRef(wpath, "waves", wid));
          return;
        }
        // Validate pathBindings — three shapes: undefined (use defaultPath), "*" (all
        // paths for all groups), or { groupId: pathId | "*" } per-group map. Per
        // ADR-0009 the per-wave bindings live next to the wave reference.
        const mapId = typeof s.map === "string" ? s.map : null;
        const mapDef = mapId ? (input.maps?.[mapId] as Record<string, unknown> | undefined) : undefined;
        const pathIds = new Set<string>();
        const pathKindById = new Map<string, string>();
        const allPaths: string[] = [];
        if (mapDef && Array.isArray(mapDef.paths)) {
          for (const p of mapDef.paths as unknown[]) {
            if (isObject(p) && typeof p.id === "string") {
              pathIds.add(p.id);
              allPaths.push(p.id);
              if (typeof p.kind === "string") pathKindById.set(p.id, p.kind);
            }
          }
        }
        const waveDef = input.waves?.[wid] as Record<string, unknown> | undefined;
        const groupIdToEnemy = new Map<string, string>();
        if (waveDef && Array.isArray(waveDef.groups)) {
          for (const g of waveDef.groups as unknown[]) {
            if (isObject(g) && typeof g.id === "string" && typeof g.enemy === "string") {
              groupIdToEnemy.set(g.id, g.enemy);
            }
          }
        }
        const defaultPath = typeof s.defaultPath === "string" ? s.defaultPath : null;

        const resolveBoundPaths = (gid: string): { ok: true; paths: string[] } | { ok: false } => {
          const bindings = entry.pathBindings;
          if (bindings === undefined) {
            if (defaultPath === null) return { ok: false };
            return { ok: true, paths: [defaultPath] };
          }
          if (typeof bindings === "string") {
            if (bindings === "*") return { ok: true, paths: [...allPaths] };
            return { ok: true, paths: [bindings] };
          }
          if (isObject(bindings)) {
            const value = (bindings as Record<string, unknown>)[gid];
            if (value === undefined) {
              if (defaultPath === null) return { ok: false };
              return { ok: true, paths: [defaultPath] };
            }
            if (typeof value !== "string") return { ok: false };
            if (value === "*") return { ok: true, paths: [...allPaths] };
            return { ok: true, paths: [value] };
          }
          return { ok: false };
        };

        // 1. Per-group object bindings: every key must reference an existing group.
        if (isObject(entry.pathBindings)) {
          for (const gid of Object.keys(entry.pathBindings)) {
            if (!groupIdToEnemy.has(gid)) {
              errors.push(
                missingRef(
                  `${base}.waves[${i}].pathBindings.${gid}`,
                  `waves.${wid}.groups`,
                  gid,
                ),
              );
            }
          }
        }

        // 2. Every group on the referenced Wave must resolve to at least one valid path,
        //    and each bound Path must exist on the Map; the bound Enemy must carry the
        //    Path's kind as a tag.
        for (const [gid, enemyId] of groupIdToEnemy) {
          const resolved = resolveBoundPaths(gid);
          const bp = `${base}.waves[${i}].pathBindings.${gid}`;
          if (!resolved.ok || resolved.paths.length === 0) {
            errors.push({
              severity: "error",
              code: "MISSING_BINDING",
              path: bp,
              message: `Group '${gid}' has no path binding and the Scenario has no 'defaultPath' fallback.`,
              expected: "explicit binding or scenario.defaultPath",
              actual: "no binding",
              hint: `Add a binding for '${gid}' or set 'defaultPath' on the Scenario.`,
            });
            continue;
          }
          const enemyDef = input.enemies?.[enemyId] as Record<string, unknown> | undefined;
          const tags = Array.isArray(enemyDef?.tags) ? (enemyDef!.tags as unknown[]) : [];
          for (const pid of resolved.paths) {
            if (!pathIds.has(pid)) {
              errors.push(missingRef(bp, `maps.${mapId}.paths`, pid));
              continue;
            }
            const pathKind = pathKindById.get(pid);
            if (pathKind && !tags.includes(pathKind)) {
              errors.push({
                severity: "error",
                code: "PATH_BINDING_TAG_MISMATCH",
                path: bp,
                message: `Group '${gid}' enemy '${enemyId}' lacks tag '${pathKind}' required by path '${pid}'.`,
                expected: `enemy.tags includes '${pathKind}'`,
                actual: `tags: [${tags.map((t) => `'${String(t)}'`).join(", ")}]`,
                hint: `Add '${pathKind}' to enemy '${enemyId}'.tags or bind this group to a different path.`,
              });
            }
          }
        }
      });
    }
  }
}

function checkWaveRefs(
  input: LoaderInput,
  ids: Record<string, Set<string>>,
  errors: LoaderError[],
): void {
  for (const [wid, w] of Object.entries(input.waves ?? {})) {
    if (!isObject(w)) continue;
    if (!Array.isArray(w.groups)) continue;
    w.groups.forEach((g, i) => {
      if (!isObject(g)) return;
      const enemy = g.enemy;
      if (typeof enemy === "string" && !ids.enemies?.has(enemy)) {
        errors.push(
          missingRef(`waves.${wid}.groups[${i}].enemy`, "enemies", enemy),
        );
      }
    });
  }
}

function checkUpgradeRefs(
  input: LoaderInput,
  ids: Record<string, Set<string>>,
  errors: LoaderError[],
): void {
  const upgrades = input.upgrades ?? {};
  // Pass 1: missing-reference checks on prerequisites + effectId.
  for (const [uid, u] of Object.entries(upgrades)) {
    if (!isObject(u)) continue;
    if (Array.isArray(u.prerequisites)) {
      u.prerequisites.forEach((pre, i) => {
        if (typeof pre !== "string") return;
        if (!ids.upgrades?.has(pre)) {
          errors.push(missingRef(`upgrades.${uid}.prerequisites[${i}]`, "upgrades", pre));
        }
      });
    }
    if (Array.isArray(u.ops)) {
      u.ops.forEach((op, i) => {
        if (!isObject(op)) return;
        if (typeof op.effectId === "string" && typeof u.tower === "string") {
          const towerDef = input.towers?.[u.tower] as Record<string, unknown> | undefined;
          if (!towerDef) return;
          const attacks = Array.isArray(towerDef.attacks) ? (towerDef.attacks as unknown[]) : [];
          const found = attacks.some(
            (atk) =>
              isObject(atk) &&
              Array.isArray(atk.effects) &&
              (atk.effects as unknown[]).some((eff) => isObject(eff) && eff.id === op.effectId),
          );
          if (!found) {
            errors.push(
              missingRef(
                `upgrades.${uid}.ops[${i}].effectId`,
                `towers.${u.tower}.attacks[*].effects[*].id`,
                op.effectId,
              ),
            );
          }
        }
      });
    }
  }
  // Pass 2: prerequisite cycle detection via DFS for back-edges. Dedupe by the
  // sorted set of nodes on the cycle path so a 2-cycle "a ↔ b" emits a single
  // UPGRADE_PREREQ_CYCLE regardless of which side we entered from.
  const reportedCycles = new Set<string>();
  for (const uid of Object.keys(upgrades)) {
    detectCycle(uid, upgrades, reportedCycles, errors);
  }
}

function detectCycle(
  start: string,
  upgrades: Record<string, unknown>,
  reported: Set<string>,
  errors: LoaderError[],
): void {
  const stack: string[] = [start];
  const seen = new Set<string>([start]);
  while (stack.length > 0) {
    const id = stack[stack.length - 1]!;
    const entry = upgrades[id];
    const prereqs = isObject(entry) && Array.isArray(entry.prerequisites) ? entry.prerequisites : [];
    let advanced = false;
    for (const pre of prereqs) {
      if (typeof pre !== "string") continue;
      if (pre === start) {
        const key = stack.slice().sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({
            severity: "error",
            code: "UPGRADE_PREREQ_CYCLE",
            path: `upgrades.${start}.prerequisites`,
            message: `Circular prerequisite chain: ${[...stack, start].join(" → ")}.`,
            hint: "Break the cycle by removing a prerequisite edge.",
          });
        }
        return;
      }
      if (!seen.has(pre) && upgrades[pre] !== undefined) {
        seen.add(pre);
        stack.push(pre);
        advanced = true;
        break;
      }
    }
    if (!advanced) stack.pop();
  }
}

function missingRef(path: string, registry: string, id: string): LoaderError {
  return {
    severity: "error",
    code: "MISSING_REFERENCE",
    path,
    message: `Reference '${id}' does not exist in ${registry}.`,
    expected: `id present in ${registry}`,
    actual: id,
    hint: "Check the id is spelled correctly and the entry is defined.",
  };
}

function abstractRef(path: string, registry: string, id: string): LoaderError {
  return {
    severity: "error",
    code: "ABSTRACT_REFERENCED",
    path,
    message: `Reference '${id}' in ${registry} is marked 'abstract: true' and cannot be referenced directly.`,
    expected: `concrete entry in ${registry}`,
    actual: `${id} (abstract)`,
    hint: `Reference a concrete entry, or remove 'abstract: true' from '${id}'.`,
  };
}

function checkScalarRef(
  path: string,
  registry: string,
  value: unknown,
  ids: Record<string, Set<string>>,
  abstract: ReadonlyMap<string, ReadonlySet<string>>,
  errors: LoaderError[],
): void {
  if (typeof value !== "string") return;
  if (!ids[registry]?.has(value)) {
    errors.push(missingRef(path, registry, value));
  } else if (abstract.get(registry)?.has(value)) {
    errors.push(abstractRef(path, registry, value));
  }
}
