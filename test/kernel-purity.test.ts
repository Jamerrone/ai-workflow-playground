import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_DIR = path.join(__dirname, "../src/kernel");
const PLUGIN_BUILTIN_RE = /plugins[\\/]builtin/;

function findKernelImportViolations(): string[] {
  const violations: string[] = [];
  const files = fs.readdirSync(KERNEL_DIR).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const src = fs.readFileSync(path.join(KERNEL_DIR, file), "utf-8");
    const importRe = /^\s*(?:import|export)\b[^'"]*['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      if (PLUGIN_BUILTIN_RE.test(m[1]!)) {
        violations.push(`${file}: imports '${m[1]}'`);
      }
    }
  }
  return violations;
}

describe("kernel purity (build-time import check)", () => {
  it("src/kernel/ files do not import any src/plugins/builtin/ module", () => {
    const violations = findKernelImportViolations();
    expect(violations, "Kernel files must not import built-in plugin modules").toEqual([]);
  });

  it("kernel purity script exits 0 on the current codebase", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const scriptPath = path.join(__dirname, "../scripts/check-kernel-purity.ts");
    const { stdout } = await exec("npx", ["tsx", scriptPath]);
    expect(stdout).toMatch(/Kernel purity OK/);
  });
});
