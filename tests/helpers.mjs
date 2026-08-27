/** Shared test helpers: temp dirs and env isolation. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Create a unique temp dir and return its path. */
export function makeTempDir(prefix = "dsh-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Prepend `dir` to PATH using the platform delimiter and the env's PATH key. */
export function prependPath(dir, env = process.env) {
  const next = { ...env };
  const key =
    process.platform === "win32"
      ? Object.keys(next).find((name) => name.toLowerCase() === "path") ?? "PATH"
      : "PATH";
  if (process.platform === "win32") {
    for (const name of Object.keys(next)) {
      if (name !== key && name.toLowerCase() === "path") {
        delete next[name];
      }
    }
  }
  next[key] = `${dir}${path.delimiter}${next[key] ?? ""}`;
  return next;
}

/**
 * JS stand-in for `dsh --profile cc`: records argv, then stdio-inherits the
 * fake SDK runtime. Safe to spawn as `node <this file>` on every platform.
 */
export function writeFakeRuntimeCli(dir, { runtimePath = path.join(TESTS_DIR, "fake-sdk-runtime.mjs") } = {}) {
  const cli = path.join(dir, "dsh.mjs");
  const argvFile = path.join(dir, "runtime-argv.txt");
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
fs.writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join("\\n") + "\\n");
const child = spawn(process.execPath, [${JSON.stringify(runtimePath)}], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
`
  );
  return cli;
}

/** Set env vars for the duration of `fn`, restoring afterwards. */
export async function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
