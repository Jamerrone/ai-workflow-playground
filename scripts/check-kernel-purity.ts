#!/usr/bin/env tsx
/**
 * Build-time kernel purity check.
 *
 * Walks every .ts file in src/kernel/ and asserts that none of them import
 * any module path containing "plugins/builtin". The Kernel must not depend on
 * any built-in Plugin — Plugins are loaded at runtime through the Plugin
 * surface, not through compile-time imports.
 *
 * Exit 0 = clean. Exit 1 = violation found.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KERNEL_DIR = path.resolve(__dirname, "../src/kernel");
const PLUGIN_BUILTIN_RE = /plugins[\\/]builtin/;

const files = fs.readdirSync(KERNEL_DIR).filter((f) => f.endsWith(".ts"));
const violations: string[] = [];

for (const file of files) {
  const src = fs.readFileSync(path.join(KERNEL_DIR, file), "utf-8");
  // Match all static import / export … from "..." statements.
  const importRe = /^\s*(?:import|export)\b[^'"]*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    if (PLUGIN_BUILTIN_RE.test(m[1]!)) {
      violations.push(`  src/kernel/${file}: imports '${m[1]}'`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `KERNEL PURITY VIOLATION: src/kernel/ imports built-in plugin module(s):\n` +
      violations.join("\n") +
      `\n\nThe Kernel must not import any src/plugins/builtin/ module.\n` +
      `Plugins are registered at runtime through EngineOptions.plugins.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Kernel purity OK — ${files.length} kernel file(s) checked, no built-in plugin imports found.\n`,
);
