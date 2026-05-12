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
    if (typeof s.map === "string" && !ids.maps?.has(s.map)) {
      errors.push(missingRef(`${base}.map`, "maps", s.map));
    } else if (typeof s.map === "string" && abstract.get("maps")?.has(s.map)) {
      errors.push(abstractRef(`${base}.map`, "maps", s.map));
    }
    if (typeof s.difficulty === "string" && !ids.difficulties?.has(s.difficulty)) {
      errors.push(missingRef(`${base}.difficulty`, "difficulties", s.difficulty));
    } else if (typeof s.difficulty === "string" && abstract.get("difficulties")?.has(s.difficulty)) {
      errors.push(abstractRef(`${base}.difficulty`, "difficulties", s.difficulty));
    }
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
        // Validate pathBindings → map.paths and group ids → wave.groups
        const bindings = entry.pathBindings;
        if (!isObject(bindings)) return;
        const mapId = typeof s.map === "string" ? s.map : null;
        const mapDef = mapId ? (input.maps?.[mapId] as Record<string, unknown> | undefined) : undefined;
        const pathIds = new Set<string>();
        const pathKindById = new Map<string, string>();
        if (mapDef && Array.isArray(mapDef.paths)) {
          for (const p of mapDef.paths as unknown[]) {
            if (isObject(p) && typeof p.id === "string") {
              pathIds.add(p.id);
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
        for (const [gid, pid] of Object.entries(bindings)) {
          const bp = `${base}.waves[${i}].pathBindings.${gid}`;
          if (!groupIdToEnemy.has(gid)) {
            errors.push(missingRef(bp, `waves.${wid}.groups`, gid));
            continue;
          }
          if (typeof pid !== "string" || pid === "*") continue;
          if (!pathIds.has(pid)) {
            errors.push(missingRef(bp, `maps.${mapId}.paths`, pid));
            continue;
          }
          const enemyId = groupIdToEnemy.get(gid)!;
          const enemyDef = input.enemies?.[enemyId] as Record<string, unknown> | undefined;
          const tags = Array.isArray(enemyDef?.tags) ? (enemyDef!.tags as unknown[]) : [];
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
          let found = false;
          if (Array.isArray(towerDef.attacks)) {
            for (const atk of towerDef.attacks as unknown[]) {
              if (!isObject(atk)) continue;
              if (Array.isArray(atk.effects)) {
                for (const eff of atk.effects as unknown[]) {
                  if (isObject(eff) && eff.id === op.effectId) {
                    found = true;
                    break;
                  }
                }
              }
              if (found) break;
            }
          }
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
}

function missingRef(path: string, registry: string, id: string): LoaderError {
  return {
    severity: "error",
    code: "MISSING_REFERENCE",
    path,
    message: `Reference '${id}' does not exist in ${registry}.`,
    expected: `id present in ${registry}`,
    actual: id,
    hint: `Check the id is spelled correctly and the entry is defined.`,
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
