import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { defineConfig, type Plugin } from "vite";

const SHARED_DATA_DIR = join(__dirname, "demos", "shared-data");
const TRANSCRIPT_PATH = join(SHARED_DATA_DIR, "transcript.json");

const BUCKETS = [
  "maps",
  "towers",
  "enemies",
  "summons",
  "waves",
  "scenarios",
  "upgrades",
  "difficulties",
  "gameRules",
] as const;

function walkBucket(bucket: string): Record<string, unknown> {
  const dir = join(SHARED_DATA_DIR, bucket);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (extname(entry) !== ".json") continue;
    const id = basename(entry, ".json");
    const raw = readFileSync(join(dir, entry), "utf8");
    result[id] = JSON.parse(raw) as unknown;
  }
  return result;
}

function buildLoaderInput(): Record<string, Record<string, unknown>> {
  const input: Record<string, Record<string, unknown>> = {};
  for (const bucket of BUCKETS) {
    input[bucket] = walkBucket(bucket);
  }
  return input;
}

function sharedDataPlugin(): Plugin {
  const transcriptJson = readFileSync(TRANSCRIPT_PATH, "utf8");

  return {
    name: "vite-plugin-shared-data",

    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "data.json",
        source: JSON.stringify(buildLoaderInput()),
      });
      this.emitFile({
        type: "asset",
        fileName: "transcript.json",
        source: transcriptJson,
      });
    },

    configureServer(server) {
      server.middlewares.use("/data.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(buildLoaderInput()));
      });
      server.middlewares.use("/transcript.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(transcriptJson);
      });
    },
  };
}

export default defineConfig({
  root: "demos/browser",
  build: {
    outDir: "../../dist/browser",
    emptyOutDir: true,
  },
  plugins: [sharedDataPlugin()],
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
