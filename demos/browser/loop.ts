import type { Engine } from "../../src/index.js";
import type { ActionSource } from "./action-source.js";

export interface Clock {
  start(step: (wallTimeDelta: number) => void): void;
  stop(): void;
}

export class RafClock implements Clock {
  private rafId: number | null = null;
  private lastTime: number | null = null;

  start(step: (wallTimeDelta: number) => void): void {
    const tick = (now: number) => {
      if (this.rafId === null) return;
      const dt = this.lastTime !== null ? (now - this.lastTime) / 1000 : 0;
      this.lastTime = now;
      step(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.lastTime = null;
    }
  }
}

export class MaxSpeedClock implements Clock {
  private running = false;

  constructor(private readonly fixedDt: number) {}

  start(step: (wallTimeDelta: number) => void): void {
    this.running = true;
    while (this.running) {
      step(this.fixedDt);
    }
  }

  stop(): void {
    this.running = false;
  }
}

export interface GameplayRendererHooks {
  beforeTick(): void;
  afterTick(): void;
  draw(interpolationFactor: number): void;
}

export interface BrowserDemoLoopOptions {
  readonly engine: Engine;
  readonly scenarioId: string;
  readonly actionSource: ActionSource;
  readonly clock: Clock;
  readonly fixedDt: number;
  readonly maxTicks: number;
  readonly gameplayRenderer: GameplayRendererHooks;
}

export interface BrowserDemoState {
  readonly done: boolean;
  readonly outcome: { readonly won: boolean; readonly lost: boolean };
  readonly snapshots: readonly string[];
  readonly events: readonly unknown[];
}

declare global {
  interface Window {
    __BROWSER_DEMO_STATE__?: BrowserDemoState;
  }
}

export class BrowserDemoLoop {
  private readonly _snapshots: string[] = [];
  private _tickIndex = 0;
  private won = false;
  private lost = false;

  constructor(private readonly opts: BrowserDemoLoopOptions) {
    opts.engine.on("scenarioWon", () => {
      this.won = true;
    });
    opts.engine.on("scenarioLost", () => {
      this.lost = true;
    });
    opts.engine.loadScenario(opts.scenarioId);
  }

  get snapshots(): readonly string[] {
    return this._snapshots;
  }

  get tickIndex(): number {
    return this._tickIndex;
  }

  get outcome(): { readonly won: boolean; readonly lost: boolean } {
    return { won: this.won, lost: this.lost };
  }

  start(): void {
    const { engine, actionSource, clock, fixedDt, maxTicks, gameplayRenderer } = this.opts;
    let accumulator = 0;

    const finish = () => {
      clock.stop();
      if (typeof window !== "undefined") {
        window.__BROWSER_DEMO_STATE__ = {
          done: true,
          outcome: { won: this.won, lost: this.lost },
          snapshots: [...this._snapshots],
          events: [],
        };
      }
    };

    const step = (wallDelta: number): void => {
      accumulator += wallDelta;
      while (accumulator >= fixedDt) {
        if (this._tickIndex >= maxTicks || this.won || this.lost) {
          finish();
          return;
        }

        for (const action of actionSource.actionsForTick(this._tickIndex)) {
          engine.dispatch(action);
        }

        gameplayRenderer.beforeTick();
        engine.tick(fixedDt);
        gameplayRenderer.afterTick();

        this._snapshots.push(engine.snapshot());
        this._tickIndex++;
        accumulator -= fixedDt;

        if (this.won || this.lost) {
          finish();
          return;
        }
      }

      gameplayRenderer.draw(accumulator / fixedDt);
    };

    clock.start(step);
  }
}
