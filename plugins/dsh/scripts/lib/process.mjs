/** Subprocess helpers: sync command runs, availability probes, tree kill. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";

const JS_ENTRY = /\.(cjs|mjs|js)$/i;
const BATCH_FILE = /\.(cmd|bat)$/i;

/** True when `command` is a Windows batch shim Node refuses to CreateProcess without a shell. */
export function isWindowsBatchFile(command) {
  return BATCH_FILE.test(String(command ?? ""));
}

/** True when `command` is a JS CLI entry we should run with `node`. */
export function isJsCliEntry(command) {
  return JS_ENTRY.test(String(command ?? ""));
}

function envPathValue(env = process.env) {
  if (process.platform !== "win32") {
    return env?.PATH ?? "";
  }
  const key = Object.keys(env ?? {}).find((name) => name.toLowerCase() === "path");
  return key ? env[key] : "";
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Candidate names for a bare command on PATH.
 *
 * Windows: never the extensionless POSIX shim (`npm`, `pnpm`, `dsh`) that
 * ships next to `*.cmd` in Node's install dir — CreateProcess cannot run
 * it. `.mjs` test fakes come first (not in default PATHEXT), then PATHEXT
 * so `.exe` wins over `.cmd`. `node` skips `.mjs` so we pick `node.exe`.
 * Unix: exact name, then `.mjs`/`.js` test fakes.
 */
function pathSearchNames(command) {
  if (process.platform !== "win32") {
    return [command, `${command}.mjs`, `${command}.js`];
  }
  const names = [];
  if (!/^node$/i.test(command)) {
    names.push(`${command}.mjs`);
  }
  const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const ext of pathext) {
    names.push(`${command}${ext}`);
  }
  return names;
}

/** Resolve a bare command name to a file on PATH, or null. */
export function locateCommandOnPath(command, env = process.env) {
  if (!command || String(command).includes(path.sep) || path.isAbsolute(command)) {
    return fileExists(command) ? command : null;
  }
  const dirs = envPathValue(env)
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of pathSearchNames(command)) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Read an npm/cmd-shim `.cmd`/`.bat` and return the JS file it would have
 * handed to `node`. Never execute the shim — Node 18.20.2+/20.12.2+/22+/24
 * throw `EINVAL` on `spawn(.cmd)` without `shell` (CVE-2024-27980 / DEP0190).
 */
export function resolveBatchShimToJs(cmdPath) {
  let text;
  try {
    text = fs.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  for (const raw of quoted.reverse()) {
    const expanded = raw.replace(/%~dp0%?/gi, `${dir}${path.sep}`).replace(/%dp0%/gi, `${dir}${path.sep}`);
    if (!JS_ENTRY.test(expanded)) {
      continue;
    }
    const candidate = path.resolve(dir, expanded);
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  const guesses = [
    path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(dir, "..", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "..", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ];
  for (const guess of guesses) {
    if (fileExists(guess)) {
      return guess;
    }
  }
  return null;
}

/**
 * Parse the plugin-managed POSIX wrapper (`#!/bin/sh` plus a single
 * `exec "node" "bin.js" "$@"` line). `/dsh:setup` writes exactly that on
 * Unix, and 2.0.2 wrote it on Windows too (where CreateProcess cannot run
 * it). Custom wrappers that do extra work before `exec` are not rewritten —
 * Unix spawns them as supplied; Windows cannot run them.
 */
export function parsePosixNodeWrapper(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024) {
      return null;
    }
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const match = text.match(/^#![^\n]+\nexec "([^"]+)" "([^"]+)" "\$@"\n*$/);
    if (!match || !JS_ENTRY.test(match[2])) {
      return null;
    }
    return { node: match[1], binJs: match[2] };
  } catch {
    return null;
  }
}

function isUsableNodeBinary(file) {
  if (!file || isWindowsBatchFile(file) || isJsCliEntry(file)) {
    return false;
  }
  if (path.isAbsolute(file) || String(file).includes(path.sep)) {
    return fileExists(file);
  }
  return false;
}

/**
 * A CreateProcess-safe Node executable: never `.cmd`/`.bat`, never a JS
 * file. Prefers `preferred` (persisted `dshNode` or a wrapper's node path),
 * then `node` on PATH, then `process.execPath`.
 */
export function resolveNodeExecutable(env = process.env, preferred = null) {
  const candidates = [];
  if (preferred && String(preferred).trim() && String(preferred).trim() !== "node") {
    candidates.push(String(preferred).trim());
  }
  const located = locateCommandOnPath("node", env);
  if (located) {
    candidates.push(located);
  }
  candidates.push(process.execPath);
  for (const candidate of candidates) {
    if (isUsableNodeBinary(candidate)) {
      return candidate;
    }
  }
  return process.execPath;
}

function looksLikeNodeExecutable(original, located) {
  const base = path.basename(String(located ?? original));
  return original === "node" || /^node(\.exe|\.cmd|\.bat)?$/i.test(base);
}

/**
 * Turn `(command, args)` into a CreateProcess-safe spawn: never a `.cmd`/
 * `.bat` as the executable, never `shell: true`. JS entries and npm shims
 * become `node <cli.js> ...args`.
 */
export function resolveSpawn(command, args = [], env = process.env) {
  const original = String(command ?? "");
  const located = locateCommandOnPath(original, env) ?? original;

  // `node` / `node.exe` / a `node.cmd` PATH shim: run a real Node binary,
  // never CreateProcess the batch file and never treat node.cmd as a CLI shim.
  if (looksLikeNodeExecutable(original, located)) {
    return { command: resolveNodeExecutable(env, located), args: [...args], shell: false };
  }

  if (isJsCliEntry(located)) {
    return { command: resolveNodeExecutable(env), args: [located, ...args], shell: false };
  }
  if (isWindowsBatchFile(located)) {
    const js = resolveBatchShimToJs(located);
    if (!js) {
      throw new Error(
        `Refusing to spawn ${located}: Node cannot CreateProcess .cmd/.bat without shell (CVE-2024-27980). Point DSH_BINARY at a JS CLI entry, or rerun /dsh:setup.`
      );
    }
    return { command: resolveNodeExecutable(env), args: [js, ...args], shell: false };
  }
  const posix = parsePosixNodeWrapper(located);
  if (posix) {
    return { command: resolveNodeExecutable(env, posix.node), args: [posix.binJs, ...args], shell: false };
  }
  return { command: located, args: [...args], shell: false };
}

/** spawnSync after resolveSpawn; never sets `shell: true`. */
export function spawnResolvedSync(command, args = [], options = {}) {
  const resolved = resolveSpawn(command, args, options.env ?? process.env);
  return spawnSync(resolved.command, resolved.args, {
    ...options,
    windowsHide: options.windowsHide ?? true,
    shell: false
  });
}

/** Run a command synchronously; never throws, returns { status, stdout, stderr, error }. */
export function runCommand(command, args = [], options = {}) {
  let resolved;
  try {
    resolved = resolveSpawn(command, args, options.env ?? process.env);
  } catch (error) {
    return { status: 1, stdout: "", stderr: error.message, error };
  }
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true,
    shell: false
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
 * schedule it on an unref'd timer. POSIX-only (pgrep); Windows support for
 * tree kill is still deferred (one-shot runs do not need it).
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
