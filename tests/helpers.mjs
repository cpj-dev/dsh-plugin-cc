/** Shared test helpers: temp dirs and env isolation. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a unique temp dir and return its path. */
export function makeTempDir(prefix = "dsh-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
