import type { Engine } from "../../../src/index.js";

interface BaseDamagedEvent {
  readonly kind: "baseDamaged";
  readonly tick: number;
  readonly baseId: string;
  readonly hp: number;
  readonly damage: number;
}

interface GoldChangedEvent {
  readonly kind: "goldChanged";
  readonly tick: number;
  readonly gold: number;
}

interface WaveStartedEvent {
  readonly kind: "waveStarted";
  readonly tick: number;
  readonly waveIndex: number;
}

interface WaveClearedEvent {
  readonly kind: "waveCleared";
  readonly tick: number;
  readonly waveIndex: number;
}

export class HudRenderer {
  private readonly goldEl: HTMLElement;
  private readonly waveEl: HTMLElement;
  private readonly basesEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly baseHp = new Map<string, number>();

  constructor(container: HTMLElement, engine: Engine) {
    container.innerHTML = `
      <div id="hud-gold">Gold: —</div>
      <div id="hud-wave">Wave: —</div>
      <div id="hud-bases"></div>
      <div id="hud-banner" style="display:none"></div>
    `;

    this.goldEl = container.querySelector("#hud-gold")!;
    this.waveEl = container.querySelector("#hud-wave")!;
    this.basesEl = container.querySelector("#hud-bases")!;
    this.bannerEl = container.querySelector("#hud-banner")!;

    engine.on("goldChanged", (e) => {
      const ev = e as unknown as GoldChangedEvent;
      this.goldEl.textContent = `Gold: ${ev.gold}`;
    });

    engine.on("waveStarted", (e) => {
      const ev = e as unknown as WaveStartedEvent;
      this.waveEl.textContent = `Wave: ${ev.waveIndex + 1}`;
    });

    engine.on("waveCleared", (e) => {
      const ev = e as unknown as WaveClearedEvent;
      this.waveEl.textContent = `Wave ${ev.waveIndex + 1} cleared`;
    });

    engine.on("baseDamaged", (e) => {
      const ev = e as unknown as BaseDamagedEvent;
      this.baseHp.set(ev.baseId, ev.hp);
      this.renderBases();
    });

    engine.on("scenarioWon", () => {
      this.bannerEl.textContent = "Victory!";
      this.bannerEl.style.display = "block";
      this.bannerEl.style.color = "green";
    });

    engine.on("scenarioLost", () => {
      this.bannerEl.textContent = "Defeat!";
      this.bannerEl.style.display = "block";
      this.bannerEl.style.color = "red";
    });
  }

  private renderBases(): void {
    const parts: string[] = [];
    for (const [id, hp] of this.baseHp) {
      parts.push(`${id}: ${hp} HP`);
    }
    this.basesEl.textContent = parts.join(" | ");
  }
}
