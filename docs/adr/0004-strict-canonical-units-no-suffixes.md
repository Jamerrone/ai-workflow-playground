# Strict canonical units, no unit suffixes in field names

All quantities in JSON game-data use a single canonical unit and field names carry no unit suffix. Time is seconds (`cooldown: 1.2`, `dotDuration: 4`). Distance is tiles (`range: 5`). Ratios are 0–1 (`slowFactor: 0.4`). The Loader rejects any field name ending in a unit suffix — `Ms`, `Sec`, `PerSec`, `Tiles`, `Pixels`, `WorldUnits` — and any plugin-registered Component schema that introduces such a name.

Chosen over allowing common-sense suffixes (`cooldownMs`, `attackSpeed`) because the engine is JSON-driven across many files contributed by many authors, and unit confusion is the class of bug least visible in JSON code review: a `cooldown: 2000` intending milliseconds will silently break a determinism check or skew a balance pass without any signal. A single canonical form means a value of `2` can only mean two seconds; there is no other reading.

Rejected a canonical-with-aliases scheme (`attackSpeed` accepted, converted to `1/cooldown` by the Loader) because the dual surface forces every plugin author to handle both forms when registering Components, and renderers cannot rely on stable field names without a normalisation pass. The "kindness" is a long tail.

Authors and renderers do the math themselves when they want a different unit on screen — stats are upgrade-mutable, so display values must be computed from resolved live values anyway. Storing `cooldown` and rendering as "1.5/sec" is one division in the renderer; the engine sees one form.

## Consequences

- A units cheat-sheet at the top of the JSON data-model reference is load-bearing documentation, not optional.
- Plugins registering new Components must use the same convention. The Loader enforces it at registration time, not just at JSON parse time.
- The full canonical set: seconds for time, tiles for distance, tile-space coordinates for position (sub-tile permitted), 0–1 for ratios, 0–N for multipliers, non-negative integers for counts, strings for tags, booleans for booleans.
