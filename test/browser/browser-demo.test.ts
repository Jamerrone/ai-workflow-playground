import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface BrowserDemoState {
  done: boolean;
  outcome: { won: boolean; lost: boolean };
  snapshots: string[];
  events: unknown[];
}

const CLI_SNAPSHOT_DIR = join(__dirname, "../../demos/snapshots/cli");

test("browser demo plays through and reaches same outcome as CLI demo", async ({ page }) => {
  await page.goto("/?headless");

  await page.waitForFunction(
    () =>
      typeof (window as unknown as Record<string, unknown>).__BROWSER_DEMO_STATE__ !== "undefined" &&
      (
        (window as unknown as Record<string, { done: boolean }>).__BROWSER_DEMO_STATE__ as {
          done: boolean;
        }
      ).done === true,
    { timeout: 30_000 },
  );

  const state = await page.evaluate(
    () =>
      (window as unknown as { __BROWSER_DEMO_STATE__: BrowserDemoState })
        .__BROWSER_DEMO_STATE__,
  );

  expect(state.done).toBe(true);
  expect(state.outcome.won || state.outcome.lost).toBe(true);

  // Assert same win outcome as CLI demo (shared transcript plays to a win)
  expect(state.outcome.won).toBe(true);
  expect(state.outcome.lost).toBe(false);
});

test("browser demo snapshot count matches CLI demo snapshot count", async ({ page }) => {
  // Load CLI snapshot count if available; skip if not yet generated
  let cliSnapshotCount: number;
  try {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(CLI_SNAPSHOT_DIR).filter((f) => f.endsWith(".json"));
    cliSnapshotCount = files.length;
  } catch {
    test.skip(true, "CLI snapshots not yet generated — run npm run demo:cli first");
    return;
  }

  await page.goto("/?headless");

  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __BROWSER_DEMO_STATE__?: { done: boolean } })
        .__BROWSER_DEMO_STATE__;
      return s?.done === true;
    },
    { timeout: 30_000 },
  );

  const state = await page.evaluate(
    () =>
      (window as unknown as { __BROWSER_DEMO_STATE__: BrowserDemoState })
        .__BROWSER_DEMO_STATE__,
  );

  expect(state.snapshots).toHaveLength(cliSnapshotCount);
});
