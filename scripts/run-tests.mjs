#!/usr/bin/env node
/**
 * Expand tests/*.test.mjs without a Unix shell so `npm test` works on
 * Windows cmd (no glob expansion) and Node 20 (test runner does not expand
 * globs either).
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDir = fileURLToPath(new URL("../tests", import.meta.url));
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testsDir, name));

if (files.length === 0) {
  process.stderr.write("scripts/run-tests.mjs: no tests/*.test.mjs files found\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
