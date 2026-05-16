import type { Engine } from "../../../src/index.js";

const TOWERS_STATE_ENTITY = "towers/state";
const WIN_LOSS_STATE_ENTITY = "win-loss/state";
const WAVES_STATE_ENTITY = "waves/state";

export class HudRenderer {
  private readonly engine: Engine;
  private readonly goldEl: HTMLElement;
  private readonly waveEl: HTMLElement;
  private readonly basesEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly baseHp = new Map<string, number>();
  private readonly baseMaxHp = new Map<string, number>();

  constructor(container: HTMLElement, engine: Engine) {
    this.engine = engine;
    container.innerHTML = `
      <section class="hud-stat">
        <div class="hud-label">Gold</div>
        <div class="hud-value" id="hud-gold-value">—</div>
      </section>
      <section class="hud-stat">
        <div class="hud-label">Wave</div>
        <div class="hud-value" id="hud-wave-value">—</div>
      </section>
      <section class="hud-stat">
        <div class="hud-label">Bases</div>
        <ul class="hud-base-list" id="hud-bases"></ul>
      </section>
      <div class="hud-banner" id="hud-banner" hidden></div>
    `;

    this.goldEl = container.querySelector("#hud-gold-value")!;
    this.waveEl = container.querySelector("#hud-wave-value")!;
    this.basesEl = container.querySelector("#hud-bases")!;
    this.bannerEl = container.querySelector("#hud-banner")!;

    engine.on("goldChanged", (e) => {
      this.goldEl.textContent = String(e.amount);
    });

    engine.on("waveStarted", (e) => {
      this.waveEl.textContent = String(e.waveIndex + 1);
    });

    engine.on("waveCleared", (e) => {
      this.waveEl.textContent = `${e.waveIndex + 1} (cleared)`;
    });

    engine.on("baseDamaged", (e) => {
      this.baseHp.set(e.base, e.remainingHp);
      this.renderBases();
    });

    engine.on("scenarioWon", () => {
      this.bannerEl.textContent = "Victory!";
      this.bannerEl.hidden = false;
      this.bannerEl.style.color = "#2ecc71";
    });

    engine.on("scenarioLost", () => {
      this.bannerEl.textContent = "Defeat!";
      this.bannerEl.hidden = false;
      this.bannerEl.style.color = "#e74c3c";
    });
  }

  // Reads initial gold / bases / wave state directly from the world.
  // Call after engine.loadScenario, otherwise the relevant entities
  // haven't been spawned yet.
  syncFromWorld(): void {
    const towersState = this.engine.world.get(TOWERS_STATE_ENTITY);
    const gold = towersState?.components.get("gold");
    if (gold) this.goldEl.textContent = String(gold.amount);

    const winLossState = this.engine.world.get(WIN_LOSS_STATE_ENTITY);
    const bases = winLossState?.components.get("bases");
    if (bases) {
      for (const b of bases.entries) {
        this.baseHp.set(b.id, b.hp);
        this.baseMaxHp.set(b.id, b.hp);
      }
      this.renderBases();
    }

    const wavesState = this.engine.world.get(WAVES_STATE_ENTITY);
    const ws = wavesState?.components.get("waveState");
    if (ws) {
      this.waveEl.textContent = ws.active
        ? String(ws.nextIndex + 1)
        : `${ws.nextIndex + 1} (pending)`;
    }
  }

  private renderBases(): void {
    this.basesEl.replaceChildren();
    for (const [id, hp] of this.baseHp) {
      const max = this.baseMaxHp.get(id) ?? hp;
      const pct = max > 0 ? Math.max(0, Math.min(100, (hp / max) * 100)) : 0;

      const li = document.createElement("li");
      li.className = "hud-base";

      const row = document.createElement("div");
      row.className = "hud-base-row";

      const nameEl = document.createElement("span");
      nameEl.className = "hud-base-name";
      nameEl.textContent = id;

      const hpEl = document.createElement("span");
      hpEl.className = "hud-base-hp";
      hpEl.textContent = `${hp} / ${max}`;

      row.append(nameEl, hpEl);

      const bar = document.createElement("div");
      bar.className = "hud-base-bar";
      const fill = document.createElement("div");
      fill.className = "hud-base-bar-fill";
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);

      li.append(row, bar);
      this.basesEl.appendChild(li);
    }
  }
}
