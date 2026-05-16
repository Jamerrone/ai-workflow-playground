import type { Engine } from "../../../src/index.js";

export class AudioRenderer {
  constructor(engine: Engine) {
    engine.on("towerFired", (e) => {
      console.log(`[audio] tower fired at tick ${e.tick}`);
    });
    engine.on("projectilesSpawned", (e) => {
      console.log(`[audio] projectiles spawned at tick ${e.tick}`);
    });
    engine.on("enemyKilled", (e) => {
      console.log(`[audio] enemy killed at tick ${e.tick}`);
    });
    engine.on("guardDied", (e) => {
      console.log(`[audio] guard died at tick ${e.tick}`);
    });
  }
}
