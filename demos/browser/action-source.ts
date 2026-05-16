import type { PlayerAction } from "../../src/index.js";

export interface ActionSource {
  actionsForTick(tickIndex: number): ReadonlyArray<PlayerAction>;
  recordAction?(tickIndex: number, action: PlayerAction): void;
}

interface TranscriptInput {
  readonly actions: ReadonlyArray<readonly [number, PlayerAction]>;
}

export class TranscriptActionSource implements ActionSource {
  private readonly byTick: Map<number, PlayerAction[]>;

  constructor(transcript: TranscriptInput) {
    this.byTick = new Map();
    for (const [tick, action] of transcript.actions) {
      let bucket = this.byTick.get(tick);
      if (!bucket) {
        bucket = [];
        this.byTick.set(tick, bucket);
      }
      bucket.push(action);
    }
  }

  actionsForTick(tickIndex: number): ReadonlyArray<PlayerAction> {
    return this.byTick.get(tickIndex) ?? [];
  }
}
