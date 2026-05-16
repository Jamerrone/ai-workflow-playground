import type { Engine } from "../../../src/index.js";

// Despite the "Audio" name, this is currently a structured event logger —
// every interesting engine event prints one line prefixed with the tick.
// Keeping the class name preserves the "three renderers, mixed tech" shape
// from ADR-0020. When a real audio backend lands, replace the console.log
// bodies with sound triggers; subscriptions stay the same shape.
export class AudioRenderer {
  constructor(engine: Engine) {
    engine.on("scenarioWon", (e) => {
      log(e["tick"] as number, "SCENARIO WON");
    });

    engine.on("scenarioLost", (e) => {
      log(e["tick"] as number, "SCENARIO LOST");
    });

    engine.on("waveStarted", (e) => {
      const waveIndex = e["waveIndex"] as number;
      const trigger = e["trigger"] as string;
      log(
        e["tick"] as number,
        `wave ${waveIndex + 1} started (trigger=${trigger})`,
      );
    });

    engine.on("waveCleared", (e) => {
      const waveIndex = e["waveIndex"] as number;
      log(e["tick"] as number, `wave ${waveIndex + 1} cleared`);
    });

    engine.on("towerPlaced", (e) => {
      const tower = e["tower"] as string;
      const archetype = e["archetype"] as string;
      log(e["tick"] as number, `tower placed: ${archetype} (id=${tower})`);
    });

    engine.on("towerSold", (e) => {
      const tower = e["tower"] as string;
      const archetype = e["archetype"] as string;
      log(e["tick"] as number, `tower sold: ${archetype} (id=${tower})`);
    });

    engine.on("upgradePurchased", (e) => {
      const tower = e["tower"] as string;
      const upgrade = e["upgrade"] as string;
      log(e["tick"] as number, `upgrade purchased: ${upgrade} on ${tower}`);
    });

    engine.on("targetingOverridden", (e) => {
      const tower = e["tower"] as string;
      log(e["tick"] as number, `targeting overridden: ${tower}`);
    });

    engine.on("towerFired", (e) => {
      const source = e["source"] as string;
      const target = e["target"] as string;
      const attackId = e["attackId"] as string;
      log(
        e["tick"] as number,
        `tower fired: ${source} → ${target} (attack=${attackId})`,
      );
    });

    engine.on("damageApplied", (e) => {
      const source = e["source"] as string | undefined;
      const target = e["target"] as string;
      const amount = e["amount"] as number;
      log(
        e["tick"] as number,
        `damage: ${source ?? "?"} → ${target} (-${amount})`,
      );
    });

    engine.on("splashApplied", (e) => {
      const source = e["source"] as string | undefined;
      const targets = (e["targets"] as ReadonlyArray<string> | undefined) ?? [];
      const amount = e["amount"] as number;
      const radius = e["radius"] as number;
      log(
        e["tick"] as number,
        `splash: ${source ?? "?"} → ${targets.length} target${targets.length === 1 ? "" : "s"} (-${amount} each, r=${radius})`,
      );
    });

    engine.on("enemyKilled", (e) => {
      const enemy = e["enemy"] as string;
      const killReward = e["killReward"] as number;
      log(e["tick"] as number, `enemy killed: ${enemy} (+${killReward}g)`);
    });

    engine.on("enemyReachedBase", (e) => {
      const enemy = e["enemy"] as string;
      const base = e["base"] as string;
      const damage = e["damage"] as number;
      log(
        e["tick"] as number,
        `enemy reached base: ${enemy} → ${base} (-${damage}hp)`,
      );
    });

    engine.on("baseDamaged", (e) => {
      const base = e["base"] as string;
      const damage = e["damage"] as number;
      const remainingHp = e["remainingHp"] as number;
      log(
        e["tick"] as number,
        `base damaged: ${base} -${damage} (${remainingHp}hp left)`,
      );
    });

    engine.on("guardDied", (e) => {
      const guard = e["guard"] as string;
      log(e["tick"] as number, `guard died: ${guard}`);
    });

    engine.on("goldChanged", (e) => {
      const delta = e["delta"] as number;
      const amount = e["amount"] as number;
      const sign = delta >= 0 ? "+" : "";
      log(e["tick"] as number, `gold ${sign}${delta} → ${amount}`);
    });
  }
}

function log(tick: number, message: string): void {
  console.log(`[t=${String(tick).padStart(4, " ")}] ${message}`);
}
