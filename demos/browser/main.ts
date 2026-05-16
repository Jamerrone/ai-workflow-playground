import {
  buildRegistry,
  createEngine,
  formatLoaderErrors,
} from "../../src/index.js";
import type { PlayerAction } from "../../src/index.js";
import { builtInBundle } from "../../src/plugins/builtin/index.js";
import { TranscriptActionSource } from "./action-source.js";
import { BrowserDemoLoop, MaxSpeedClock, RafClock } from "./loop.js";
import { GameplayRenderer } from "./renderers/gameplay.js";
import { HudRenderer } from "./renderers/hud.js";
import { AudioRenderer } from "./renderers/audio.js";

interface TranscriptFile {
  readonly scenario: string;
  readonly seed: number;
  readonly dt: number;
  readonly maxTicks: number;
  readonly actions: ReadonlyArray<readonly [number, PlayerAction]>;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const useMaxSpeed = params.has("headless");

  const [dataRes, transcriptRes] = await Promise.all([
    fetch("data.json"),
    fetch("transcript.json"),
  ]);

  if (!dataRes.ok) throw new Error(`Failed to load data.json: ${dataRes.status}`);
  if (!transcriptRes.ok) throw new Error(`Failed to load transcript.json: ${transcriptRes.status}`);

  const data = await dataRes.json() as Record<string, unknown>;
  const transcript = await transcriptRes.json() as TranscriptFile;

  const result = buildRegistry(data);
  if (!result.ok) {
    throw new Error("Registry errors:\n" + formatLoaderErrors(result.errors));
  }

  const engine = createEngine(result.registry, {
    plugins: builtInBundle,
    seed: transcript.seed,
  });

  const canvas = document.getElementById("gameplay") as HTMLCanvasElement;
  const hudContainer = document.getElementById("hud") as HTMLElement;

  const gameplayRenderer = new GameplayRenderer(canvas, engine, result.registry, transcript.scenario);
  new HudRenderer(hudContainer, engine);
  new AudioRenderer(engine);

  const actionSource = new TranscriptActionSource(transcript);
  const clock = useMaxSpeed
    ? new MaxSpeedClock(transcript.dt)
    : new RafClock();

  const loop = new BrowserDemoLoop({
    engine,
    scenarioId: transcript.scenario,
    actionSource,
    clock,
    fixedDt: transcript.dt,
    maxTicks: transcript.maxTicks,
    gameplayRenderer,
  });

  loop.start();
}

main().catch((err: unknown) => {
  console.error("Demo failed:", err);
  const el = document.getElementById("error");
  if (el) {
    el.textContent = String(err);
    el.style.display = "block";
  }
});
