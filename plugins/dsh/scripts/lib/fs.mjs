/** Small filesystem helpers shared by the bridge subcommands. */

import fs from "node:fs";

/** Read and parse a JSON file; returns null when missing or malformed. */
export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read piped stdin synchronously; returns "" when stdin is a TTY (nothing
 * piped). Lets `run` accept `echo task | node dsh-bridge.mjs run`.
 */
export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}
