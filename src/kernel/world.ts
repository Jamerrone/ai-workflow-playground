export interface Entity {
  readonly id: string;
  readonly components: import("../types.js").EntityComponents;
}

export interface QuerySpec {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
  readonly none?: readonly string[];
}

export interface World {
  spawn(id: string, components: Record<string, unknown>): Entity;
  destroy(id: string): void;
  get(id: string): Entity | undefined;
  query(spec: QuerySpec): Entity[];
  has(id: string, component: string): boolean;
  mutate(id: string, component: string, mutator: (current: unknown) => unknown): void;
}

interface InternalEntity {
  readonly id: string;
  components: Map<string, unknown>;
}

import type { Phase, ComponentRegistry, EntityComponents } from "../types.js";

export class WorldImpl {
  private entities = new Map<string, InternalEntity>();
  private insertionOrder: string[] = [];
  private writableIn = new Map<string, ReadonlySet<Phase>>();
  private currentPhase: Phase | null = null;

  declareComponent(name: string, writableIn: readonly Phase[]): void {
    this.writableIn.set(name, new Set(writableIn));
  }

  reset(): void {
    this.entities.clear();
    this.insertionOrder = [];
  }

  setPhase(phase: Phase | null): void {
    this.currentPhase = phase;
  }

  private assertWritable(component: string): void {
    if (this.currentPhase === null) return; // outside tick — engine setup / actions
    const allowed = this.writableIn.get(component);
    if (!allowed) return; // undeclared components are unrestricted
    if (!allowed.has(this.currentPhase)) {
      throw new Error(
        `Component '${component}' is not writable in phase '${this.currentPhase}' ` +
          `(writableIn: [${[...allowed].join(", ")}])`,
      );
    }
  }

  spawn(id: string, components: Record<string, unknown>): Entity {
    if (this.entities.has(id)) {
      throw new Error(`Entity '${id}' already exists`);
    }
    for (const c of Object.keys(components)) this.assertWritable(c);
    const e: InternalEntity = { id, components: new Map(Object.entries(components)) };
    this.entities.set(id, e);
    this.insertionOrder.push(id);
    return this.snapshot(e);
  }

  destroy(id: string): void {
    if (!this.entities.has(id)) return;
    this.entities.delete(id);
    const idx = this.insertionOrder.indexOf(id);
    if (idx >= 0) this.insertionOrder.splice(idx, 1);
  }

  get(id: string): Entity | undefined {
    const e = this.entities.get(id);
    return e ? this.snapshot(e) : undefined;
  }

  has(id: string, component: string): boolean {
    return this.entities.get(id)?.components.has(component) ?? false;
  }

  setComponent(id: string, component: string, value: unknown): void {
    const e = this.entities.get(id);
    if (!e) throw new Error(`Entity '${id}' not found`);
    this.assertWritable(component);
    e.components.set(component, value);
  }

  removeComponent(id: string, component: string): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.assertWritable(component);
    e.components.delete(component);
  }

  getComponent(id: string, component: string): unknown {
    return this.entities.get(id)?.components.get(component);
  }

  mutate(id: string, component: string, mutator: (current: unknown) => unknown): void {
    const e = this.entities.get(id);
    if (!e) throw new Error(`Entity '${id}' not found`);
    this.assertWritable(component);
    e.components.set(component, mutator(e.components.get(component)));
  }

  query(spec: QuerySpec): Entity[] {
    // Iterate in stable insertion order (id-ascending is unnecessary —
    // insertion is itself deterministic given the engine's deterministic
    // System order).
    const out: Entity[] = [];
    for (const id of this.insertionOrder) {
      const e = this.entities.get(id);
      if (!e) continue;
      if (spec.all && !spec.all.every((c) => e.components.has(c))) continue;
      if (spec.any && !spec.any.some((c) => e.components.has(c))) continue;
      if (spec.none && spec.none.some((c) => e.components.has(c))) continue;
      out.push(this.snapshot(e));
    }
    return out;
  }

  allEntitiesInOrder(): readonly InternalEntity[] {
    return this.insertionOrder
      .map((id) => this.entities.get(id))
      .filter((e): e is InternalEntity => e !== undefined);
  }

  private snapshot(e: InternalEntity): Entity {
    const map = new Map(e.components);
    return {
      id: e.id,
      components: {
        get<K extends keyof ComponentRegistry>(name: K): ComponentRegistry[K] | undefined {
          return map.get(name as string) as ComponentRegistry[K] | undefined;
        },
        has<K extends keyof ComponentRegistry>(name: K): boolean {
          return map.has(name as string);
        },
      } as EntityComponents,
    };
  }
}
