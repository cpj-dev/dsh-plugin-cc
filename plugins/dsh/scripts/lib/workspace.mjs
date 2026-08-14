/** Workspace-root resolution: git toplevel when available, else the cwd. */

import path from "node:path";

import { runCommand } from "./process.mjs";

/** Resolve the workspace root for state scoping. */
export function resolveWorkspaceRoot(cwd) {
  const base = path.resolve(cwd ?? process.cwd());
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: base });
  if (result.status === 0) {
    const top = result.stdout.trim();
    if (top) {
      return top;
    }
  }
  return base;
}
