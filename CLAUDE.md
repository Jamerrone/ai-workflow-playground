# ai-workflow-playground

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `Jamerrone/ai-workflow-playground`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Using the default canonical label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

The **Extension surface** section in `CONTEXT.md` draws the JSON-vs-plugin-code line explicitly. Before speccing or implementing a new feature, check it: content (new Tower, Enemy, Map, Wave, Scenario, Upgrade, Difficulty) is JSON only; new behaviour (new AttackEffect kind, TargetingStrategy, Component, System, EntityKind, PlayerActionHandler, GameRule key) always requires a Plugin.
