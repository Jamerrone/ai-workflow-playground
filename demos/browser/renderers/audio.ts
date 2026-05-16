import type { Engine } from "../../../src/index.js";

// Despite the "Audio" name, this is currently a structured event logger —
// every interesting engine event prints one line prefixed with the tick.
// Keeping the class name preserves the "three renderers, mixed tech" shape
// from ADR-0020. When a real audio backend lands, replace the console.log
// bodies with sound triggers; subscriptions stay the same shape.
export class AudioRenderer {
  constructor(engine: Engine) {
    engine.on("scenarioWon", (e) => {
      log(e.tick, "SCENARIO WON");
    });

    engine.on("scenarioLost", (e) => {
      log(e.tick, "SCENARIO LOST");
    });

    engine.on("waveStarted", (e) => {
      log(e.tick, `wave ${e.waveIndex + 1} started (trigger=${e.trigger})`);
    });

    engine.on("waveCleared", (e) => {
      log(e.tick, `wave ${e.waveIndex + 1} cleared`);
    });

    engine.on("towerPlaced", (e) => {
      log(e.tick, `tower placed: ${e.archetype} (id=${e.tower})`);
    });

    engine.on("towerSold", (e) => {
      log(e.tick, `tower sold: ${e.archetype} (id=${e.tower})`);
    });

    engine.on("upgradePurchased", (e) => {
      log(e.tick, `upgrade purchased: ${e.upgrade} on ${e.tower}`);
    });

    engine.on("targetingOverridden", (e) => {
      log(e.tick, `targeting overridden: ${e.tower}`);
    });

    engine.on("towerFired", (e) => {
      log(e.tick, `tower fired: ${e.source} → ${e.target} (attack=${e.attackId})`);
    });

    engine.on("damageApplied", (e) => {
      log(e.tick, `damage: ${e.source} → ${e.target} (-${e.amount})`);
    });

    engine.on("splashApplied", (e) => {
      const n = e.targets.length;
      log(e.tick, `splash: ${e.source} → ${n} target${n === 1 ? "" : "s"} (-${e.amount} each, r=${e.radius})`);
    });

    engine.on("enemyKilled", (e) => {
      log(e.tick, `enemy killed: ${e.enemy} (+${e.killReward}g)`);
    });

    engine.on("enemyReachedBase", (e) => {
      log(e.tick, `enemy reached base: ${e.enemy} → ${e.base} (-${e.damage}hp)`);
    });

    engine.on("baseDamaged", (e) => {
      log(e.tick, `base damaged: ${e.base} -${e.damage} (${e.remainingHp}hp left)`);
    });

    engine.on("guardDied", (e) => {
      log(e.tick, `guard died: ${e.guard}`);
    });

    engine.on("goldChanged", (e) => {
      const sign = e.delta >= 0 ? "+" : "";
      log(e.tick, `gold ${sign}${e.delta} → ${e.amount}`);
    });
  }
}

function log(tick: number, message: string): void {
  console.log(`[t=${String(tick).padStart(4, " ")}] ${message}`);
}
