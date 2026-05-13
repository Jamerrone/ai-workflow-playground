import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildRegistry } from "../src/index.js";
import { loadFromDirectory } from "../src/loader/node.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "loader-fromdir-"));
}

function materialiseRegistry(root: string, reg: Record<string, unknown>): void {
  for (const [bucket, entries] of Object.entries(reg)) {
    if (entries === null || typeof entries !== "object") continue;
    const obj = entries as Record<string, unknown>;
    if (Object.keys(obj).length === 0) continue;
    const bucketDir = join(root, bucket);
    mkdirSync(bucketDir, { recursive: true });
    for (const [id, entry] of Object.entries(obj)) {
      writeFileSync(join(bucketDir, `${id}.json`), JSON.stringify(entry, null, 2));
    }
  }
}

describe("loadFromDirectory: happy path", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("walks the tree and produces a valid ConfigRegistry", () => {
    materialiseRegistry(root, buildTracerRegistry() as unknown as Record<string, unknown>);
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.registry.towers)).toEqual(["archer"]);
      expect(Object.keys(result.registry.maps)).toEqual(["tracer-map"]);
      expect(Object.keys(result.registry.enemies)).toEqual(["grunt"]);
      expect(Object.keys(result.registry.waves)).toEqual(["w1"]);
      expect(Object.keys(result.registry.scenarios)).toEqual(["tracer"]);
    }
  });

  it("recurses into nested sub-directories within a bucket directory", () => {
    materialiseRegistry(root, buildTracerRegistry() as unknown as Record<string, unknown>);
    mkdirSync(join(root, "enemies", "boss-tier"), { recursive: true });
    writeFileSync(
      join(root, "enemies", "boss-tier", "boss.json"),
      JSON.stringify({
        tags: ["ground"],
        stats: { hp: 100, speed: 0.5, baseDamage: 5 },
        killReward: 50,
      }),
    );
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.registry.enemies).sort()).toEqual(["boss", "grunt"]);
    }
  });

  it("ignores files outside a known bucket directory and non-JSON files", () => {
    materialiseRegistry(root, buildTracerRegistry() as unknown as Record<string, unknown>);
    writeFileSync(join(root, "README.md"), "ignored");
    writeFileSync(join(root, "stray.json"), JSON.stringify({ noBucket: true }));
    mkdirSync(join(root, "not-a-bucket"), { recursive: true });
    writeFileSync(join(root, "not-a-bucket", "thing.json"), JSON.stringify({}));
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(true);
  });
});

describe("loadFromDirectory: MALFORMED_JSON", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("emits MALFORMED_JSON with source.file when a JSON file fails to parse", () => {
    mkdirSync(join(root, "enemies"), { recursive: true });
    const badPath = join(root, "enemies", "broken.json");
    writeFileSync(badPath, '{ "tags": ["ground" '); // unterminated
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === "MALFORMED_JSON");
      expect(err).toBeDefined();
      expect(err!.source).toBeDefined();
      expect(err!.source!.file).toBe(badPath);
    }
  });

  it("extracts line/col when the JSON parser surfaces them", () => {
    mkdirSync(join(root, "enemies"), { recursive: true });
    const badPath = join(root, "enemies", "broken.json");
    // Multi-line content with an obvious error on line 3.
    writeFileSync(
      badPath,
      ['{', '  "tags": ["ground"],', '  oops: 1', '}', ''].join("\n"),
    );
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === "MALFORMED_JSON");
      expect(err).toBeDefined();
      // line/col are best-effort; assert presence and positive integers when present.
      if (err!.source!.line !== undefined) {
        expect(err!.source!.line).toBeGreaterThanOrEqual(1);
      }
      if (err!.source!.col !== undefined) {
        expect(err!.source!.col).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("a malformed file does not prevent valid neighbours from being parsed", () => {
    materialiseRegistry(root, buildTracerRegistry() as unknown as Record<string, unknown>);
    writeFileSync(join(root, "enemies", "broken.json"), "{ not json");
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The malformed file is reported, AND the valid registry still includes 'grunt'.
      expect(result.errors.some((e) => e.code === "MALFORMED_JSON")).toBe(true);
      // The valid entries should still pass through buildRegistry, so other validation
      // errors should not appear.
      const otherErrors = result.errors.filter((e) => e.code !== "MALFORMED_JSON");
      expect(otherErrors).toEqual([]);
    }
  });
});

describe("loadFromDirectory: source mapping on every error", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("validation errors carry source.file pointing at the entry's file", () => {
    const reg = buildTracerRegistry();
    ((reg.enemies as Record<string, Record<string, Record<string, unknown>>>).grunt!
      .stats as Record<string, unknown>).baseDamageMs = 1;
    materialiseRegistry(root, reg as unknown as Record<string, unknown>);
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === "UNIT_SUFFIX_FORBIDDEN");
      expect(err).toBeDefined();
      expect(err!.source).toBeDefined();
      expect(err!.source!.file).toBe(join(root, "enemies", "grunt.json"));
    }
  });

  it("referential-integrity errors carry source.file pointing at the entry that owns the reference", () => {
    const reg = buildTracerRegistry();
    (reg.scenarios as Record<string, Record<string, unknown>>).tracer!.map = "no-such-map";
    materialiseRegistry(root, reg as unknown as Record<string, unknown>);
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find(
        (e) => e.code === "MISSING_REFERENCE" && e.path.endsWith(".map"),
      );
      expect(err).toBeDefined();
      expect(err!.source!.file).toBe(join(root, "scenarios", "tracer.json"));
    }
  });

  it("every error produced by loadFromDirectory has source.file unless it has no owning file", () => {
    const reg = buildTracerRegistry();
    // Plant several distinct errors across different files.
    ((reg.enemies as Record<string, Record<string, Record<string, unknown>>>).grunt!
      .stats as Record<string, unknown>).baseDamageMs = 1;
    delete (reg.maps as Record<string, Record<string, unknown>>)["tracer-map"]!.width;
    materialiseRegistry(root, reg as unknown as Record<string, unknown>);
    const result = loadFromDirectory(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const err of result.errors) {
        expect(err.source).toBeDefined();
        expect(err.source!.file).toBeTruthy();
      }
    }
  });
});

describe("loadFromDirectory: parity with buildRegistry", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("produces a validated registry deeply equal to buildRegistry on the same in-memory input", () => {
    const reg = buildTracerRegistry();
    materialiseRegistry(root, reg as unknown as Record<string, unknown>);
    const memResult = buildRegistry(reg);
    const diskResult = loadFromDirectory(root);
    expect(memResult.ok).toBe(true);
    expect(diskResult.ok).toBe(true);
    if (memResult.ok && diskResult.ok) {
      expect(diskResult.registry).toEqual(memResult.registry);
    }
  });

  it("forwards loader options (e.g. strict mode, pluginManifest) to buildRegistry", () => {
    const reg = buildTracerRegistry();
    materialiseRegistry(root, reg as unknown as Record<string, unknown>);
    const result = loadFromDirectory(root, {
      strict: true,
      pluginManifest: [
        { plugin: "p1", registry: "rewardKind", kind: "gold-on-kill" },
        { plugin: "p2", registry: "rewardKind", kind: "gold-on-kill" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const replacement = result.errors.find((e) => e.code === "REGISTRY_REPLACEMENT");
      expect(replacement).toBeDefined();
      expect(replacement!.severity).toBe("error");
    }
  });
});

describe("shared engine entry stays browser-safe", () => {
  it("transitive imports from src/index.ts do not include node-only modules", () => {
    const srcRoot = resolve(__dirname, "..", "src");
    const seen = new Set<string>();
    const specs = new Set<string>();
    collectImports(resolve(srcRoot, "index.ts"), srcRoot, seen, specs);
    for (const spec of specs) {
      expect(spec).not.toMatch(/^(node:)?fs(\/|$)/);
      expect(spec).not.toMatch(/^(node:)?path(\/|$)/);
      expect(spec).not.toMatch(/^(node:)?os(\/|$)/);
      expect(spec).not.toMatch(/^(node:)?child_process(\/|$)/);
    }
  });

  it("loadFromDirectory is exported from a separate Node-only entry path, not from src/index.ts", async () => {
    const root = resolve(__dirname, "..", "src", "index.ts");
    const src = readFileSync(root, "utf8");
    expect(src).not.toContain("loadFromDirectory");
  });
});

// --- helpers --------------------------------------------------------------

function collectImports(
  file: string,
  srcRoot: string,
  seen: Set<string>,
  specs: Set<string>,
): void {
  if (seen.has(file)) return;
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const importRe =
    /(?:^|\n)\s*(?:import|export)(?:[^'";\n]*?)\s+from\s+['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [importRe, dynamicRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1]!;
      specs.add(spec);
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (resolved) collectImports(resolved, srcRoot, seen, specs);
      }
    }
  }
}

function resolveRelative(fromFile: string, spec: string): string | undefined {
  // Internal imports use `.js` suffixes (TS bundler-mode). Map back to a real source file.
  const base = join(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // not a file — keep trying
    }
  }
  return undefined;
}
