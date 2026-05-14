import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEngine,
  formatLoaderErrors,
  type Engine,
  type GameEvent,
  type PlayerAction,
} from "../../src/index.js";
import { loadFromDirectory } from "../../src/loader/node.js";
import { builtInBundle } from "../../src/plugins/builtin/index.js";

interface TranscriptFile {
  readonly scenario: string;
  readonly seed: number;
  readonly dt: number;
  readonly maxTicks: number;
  readonly actions: ReadonlyArray<readonly [number, PlayerAction]>;
}

export interface DemoOptions {
  /** Directory of shared-data JSON (the canonical set committed alongside this CLI). */
  readonly dataDir: string;
  /** Transcript JSON path; defaults to `${dataDir}/transcript.json`. */
  readonly transcriptPath?: string;
  /** Where to write per-tick snapshots. Created if absent. */
  readonly snapshotDir: string;
  /** Optional stream to receive human-readable per-event lines. */
  readonly out?: { write(line: string): void };
}

export interface DemoOutcome {
  readonly won: boolean;
  readonly lost: boolean;
  readonly tickIndex: number;
  readonly eventCount: number;
  readonly snapshotCount: number;
}

const DEFAULT_DATA_DIR = resolve(fileURLToPath(import.meta.url), "..", "..", "shared-data");

export function runDemo(options: DemoOptions): DemoOutcome {
  const { dataDir, snapshotDir, out } = options;
  const transcriptPath = options.transcriptPath ?? join(dataDir, "transcript.json");

  // Loader path: walk the shared-data directory (exercises the real on-disk
  // loader path, not the in-memory shortcut).
  const result = loadFromDirectory(dataDir);
  if (!result.ok) {
    throw new Error(
      "Loader rejected demo registry:\n" + formatLoaderErrors(result.errors),
    );
  }
  const registry = result.registry;

  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8")) as TranscriptFile;

  mkdirSync(snapshotDir, { recursive: true });

  const engine: Engine = createEngine(registry, {
    plugins: builtInBundle,
    seed: transcript.seed,
  });

  let eventCount = 0;
  let won = false;
  let lost = false;
  engine.onEvent((e) => {
    eventCount++;
    out?.write(formatEvent(e) + "\n");
    if (e.kind === "scenarioWon") won = true;
    if (e.kind === "scenarioLost") lost = true;
  });

  engine.loadScenario(transcript.scenario);

  const actionsByTick = new Map<number, PlayerAction[]>();
  for (const [tick, action] of transcript.actions) {
    let bucket = actionsByTick.get(tick);
    if (!bucket) {
      bucket = [];
      actionsByTick.set(tick, bucket);
    }
    bucket.push(action);
  }

  // Snapshot file naming uses 4-digit zero-padded tick numbers so directory
  // listings sort in tick order for byte-comparison against the browser demo.
  const writeSnapshot = (tickIndex: number): void => {
    const padded = String(tickIndex).padStart(4, "0");
    writeFileSync(join(snapshotDir, `tick-${padded}.json`), engine.snapshot());
  };

  let snapshotCount = 0;
  for (let t = 0; t < transcript.maxTicks; t++) {
    const queued = actionsByTick.get(t);
    if (queued) {
      for (const action of queued) {
        engine.dispatch(action);
      }
    }
    if (won || lost) break;
    engine.tick(transcript.dt);
    writeSnapshot(t);
    snapshotCount++;
    if (won || lost) break;
  }

  engine.dispose();
  return { won, lost, tickIndex: snapshotCount, eventCount, snapshotCount };
}

function formatEvent(e: GameEvent): string {
  const tick = String(e.tick).padStart(4, " ");
  const head = `[t=${tick}] ${e.kind}`;
  // Trim verbose fields off the inline summary so the stream stays readable.
  const { kind: _kind, tick: _tick, ...rest } = e as Record<string, unknown> & {
    kind: string;
    tick: number;
  };
  const compact = Object.keys(rest).length === 0 ? "" : "  " + JSON.stringify(rest);
  return head + compact;
}

function ensureAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function isMainModule(): boolean {
  // Robust against being launched via `tsx`, which sets process.argv[1] to the
  // entry script's resolved path.
  const entry = process.argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  return resolve(entry) === resolve(here);
}

if (isMainModule()) {
  const dataDir = ensureAbsolute(process.env.DEMO_DATA_DIR ?? DEFAULT_DATA_DIR);
  const snapshotDir = ensureAbsolute(
    process.env.DEMO_SNAPSHOT_DIR ?? join(dirname(dataDir), "snapshots", "cli"),
  );
  const outcome = runDemo({
    dataDir,
    snapshotDir,
    out: { write: (line) => process.stdout.write(line) },
  });
  let status = "stalled";
  if (outcome.won) status = "won";
  else if (outcome.lost) status = "lost";
  process.stdout.write(
    `\nScenario ${status} ` +
      `after ${outcome.tickIndex} tick(s); ${outcome.eventCount} events; ` +
      `${outcome.snapshotCount} snapshot file(s) written to ${snapshotDir}\n`,
  );
  if (!outcome.won) process.exitCode = 1;
}
