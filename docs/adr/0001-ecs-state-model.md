# ECS state model with direct component mutation

The engine's state container is an ECS (entity-component-system): entities are ids, data lives in typed component stores owned by the kernel, and plugin logic runs as systems hooked into tick phases. Systems mutate components directly inside their registered phase; the kernel enforces phase boundaries (Proxy/freeze in dev mode) rather than going via a command/patch queue.

Chosen over a plain mutable object graph and over a command-pattern surface because plugins are first-class extenders of entity *shape* — they must be able to add new fields (e.g. a charge meter on Towers, an aggro counter on Enemies) without forking or replacing built-in entity kinds. ECS makes that a registry operation instead of a schema-merge dance, and it makes deterministic iteration order a property of the kernel-owned component stores rather than a discipline every plugin has to follow. Direct mutation rather than commands because sandboxing untrusted plugins is an explicit non-goal: built-in plugins and developer plugins share one capability surface.

## Consequences

- The registry list grows: Component is a first-class registered thing. EntityKind reduces to an archetype-prototype (a named bundle of components + a JSON `kind` discriminator) rather than carrying its own bespoke runtime state schema.
- The plugin authoring guide's worked example carries ECS conceptual weight. We accept that cost; the alternative is a registry of ad-hoc side-tables, which is ECS poorly disguised.
- Cross-plugin coupling becomes explicit: a system that wants to read another plugin's state declares the component it depends on, and the kernel can surface "this system needs a component no loaded plugin provides" at construction time.
