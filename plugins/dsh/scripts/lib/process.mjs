/** Subprocess helpers: sync command runs, availability probes, tree kill. */

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

/** Run a command synchronously; never throws, returns { status, stdout, stderr, error }. */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true
  });
  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

/** Probe a binary by running it with the given args; returns { available, detail }. */
export function binaryAvailable(command, args = ["--version"], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return {
      available: false,
      detail: (result.stderr || result.stdout || `exit ${result.status}`).trim()
    };
  }
  const firstLine = (result.stdout || result.stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return { available: true, detail: firstLine ?? "ok" };
}

/** Whether a pid refers to a live process. */
export function isPidAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function listChildPids(pid) {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function collectProcessTree(root, seen = new Set()) {
  if (seen.has(root)) {
    return seen;
  }
  seen.add(root);
  for (const child of listChildPids(root)) {
    collectProcessTree(child, seen);
  }
  return seen;
}

function signalAll(pids, signal) {
  for (const p of pids) {
    try {
      process.kill(p, signal);
    } catch {
      // Already gone; nothing else throws for a live pid we own.
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntilDead(pids, deadlineMs, pollMs) {
  let survivors = pids.filter(isPidAlive);
  const deadline = Date.now() + deadlineMs;
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    survivors = survivors.filter(isPidAlive);
  }
  return survivors;
}

/**
 * Terminate a process and its descendants: SIGTERM the whole set, then
 * SIGKILL whatever survives `graceMs`, and only resolve once the tree is
 * confirmed dead (or the confirm window expires). Callers are short-lived
 * CLI processes, so the escalation must complete before they exit — never
 * schedule it on an unref'd timer. POSIX-only (pgrep); Windows support is
 * deferred with the rest of the plugin.
 *
 * Returns { pids, survivors }: every pid signalled and whatever still
 * refused to die (normally empty; unkillable pids are the OS's problem).
 */
export async function terminateProcessTree(pid, { graceMs = 2000, pollMs = 50, confirmMs = 500 } = {}) {
  const target = Number(pid);
  if (!Number.isFinite(target) || target <= 0) {
    return { pids: [], survivors: [] };
  }

  const pids = [...collectProcessTree(target)];
  signalAll(pids, "SIGTERM");

  let survivors = await pollUntilDead(pids, graceMs, pollMs);
  if (survivors.length > 0) {
    // Survivors may have spawned children after the first walk; re-collect
    // before escalating so the whole live tree gets the SIGKILL.
    const expanded = new Set();
    for (const p of survivors) {
      collectProcessTree(p, expanded);
    }
    signalAll([...expanded], "SIGKILL");
    survivors = await pollUntilDead([...expanded], confirmMs, pollMs);
  }
  return { pids, survivors };
}
