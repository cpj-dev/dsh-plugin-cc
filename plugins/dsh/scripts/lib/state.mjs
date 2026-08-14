/**
 * Durable bridge state under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/`
 * (fallback: os tmpdir). Same layout as the Grok Build plugin:
 *
 *   state.json        — job index (bounded, newest first wins on prune)
 *   state.json.lock   — `wx`-created lock file guarding read-modify-write
 *   jobs/<id>.json    — full job record incl. the queued run request
 *   jobs/<id>.log     — combined progress + agent output tail
 *   broker/           — broker socket, pid file, and last-session record
 *
 * State is per-workspace (git toplevel), so parallel repos never share jobs.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "dsh-cc-runs");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.json.lock";
const JOBS_DIR_NAME = "jobs";
const BROKER_DIR_NAME = "broker";
const MAX_JOBS = 50;
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;

/** ISO timestamp used across all job records. */
export function nowIso() {
  return new Date().toISOString();
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

function defaultState() {
  return { version: STATE_VERSION, config: {}, jobs: [] };
}

/** Resolve the per-workspace state directory. */
export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    // Path exists (we resolved it); realpath fails only on races. Keep as-is.
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

/** state.json path for a workspace. */
export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

/** jobs/ directory for a workspace. */
export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

/** broker/ directory for a workspace (pid file and session record). */
export function resolveBrokerDir(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_DIR_NAME);
}

/**
 * Unix-socket path for the workspace broker. Deliberately NOT inside the
 * state dir: `sun_path` is limited to ~104 bytes on macOS, and
 * CLAUDE_PLUGIN_DATA-based paths exceed it. A short tmpdir path keyed by
 * the same workspace hash stays unique per workspace.
 */
export function resolveBrokerSocketPath(cwd) {
  const hash = path.basename(resolveStateDir(cwd)).split("-").pop();
  return path.join(os.tmpdir(), `dsh-cc-${hash}.sock`);
}

/** Ensure the state tree exists. */
export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
  fs.mkdirSync(resolveBrokerDir(cwd), { recursive: true });
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

/** Run `fn` while holding the workspace state lock. */
export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        sleepMs(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }
    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // fd already closed by a crash path; unlink below still releases.
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Lock file already removed; the lock is released either way.
      }
    }
  }
  throw new Error(`Timed out acquiring state lock at ${lockPath}`);
}

/** Load the workspace state (never throws; falls back to empty state). */
export function loadState(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.jobs)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt state file: start over with an empty index.
  }
  return defaultState();
}

/** Persist the workspace state atomically. */
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveStateFile(cwd), JSON.stringify(state, null, 2));
}

/** Generate a short unique job id like `review-3fk2ac`. */
export function generateJobId(prefix) {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** List all indexed jobs for a workspace. */
export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

function unlinkJobFiles(cwd, jobId) {
  for (const suffix of [".json", ".log"]) {
    try {
      fs.unlinkSync(path.join(resolveJobsDir(cwd), `${jobId}${suffix}`));
    } catch {
      // File already gone; the index entry removal is what matters.
    }
  }
}

/** Insert or replace a job in the index, pruning past MAX_JOBS. */
export function upsertJob(cwd, job) {
  withStateLock(cwd, () => {
    const state = loadState(cwd);
    const jobs = state.jobs.filter((existing) => existing.id !== job.id);
    jobs.unshift(job);
    while (jobs.length > MAX_JOBS) {
      const removed = jobs.pop();
      unlinkJobFiles(cwd, removed.id);
    }
    saveState(cwd, { ...state, jobs });
  });
}

/**
 * Remove every job belonging to a Claude session — index entries plus their
 * job/log files — under the state lock. This is the SessionEnd cleanup; an
 * unlocked read-modify-write here would clobber concurrent workers' writes.
 * Returns the removed jobs.
 */
export function removeJobsBySession(cwd, sessionId) {
  if (!sessionId) {
    return [];
  }
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const removed = state.jobs.filter((job) => job.sessionId === sessionId);
    if (removed.length === 0) {
      return removed;
    }
    for (const job of removed) {
      unlinkJobFiles(cwd, job.id);
    }
    saveState(cwd, { ...state, jobs: state.jobs.filter((job) => job.sessionId !== sessionId) });
    return removed;
  });
}

/** Write the full per-job record (index stays the small projection). */
export function writeJobFile(cwd, jobId, record) {
  ensureStateDir(cwd);
  writeFileAtomic(path.join(resolveJobsDir(cwd), `${jobId}.json`), JSON.stringify(record, null, 2));
}

/** Read the full per-job record; null when absent or malformed. */
export function readStoredJob(cwd, jobId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveJobsDir(cwd), `${jobId}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Patch a job in index + file, only while it is still queued/running. */
export function patchJobIfActive(cwd, jobId, patch) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const index = state.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      return null;
    }
    const existing = state.jobs[index];
    if (existing.status !== "queued" && existing.status !== "running") {
      return existing;
    }
    const next = { ...existing, ...patch, updatedAt: nowIso() };
    state.jobs[index] = next;
    saveState(cwd, state);
    const stored = readStoredJob(cwd, jobId);
    if (stored) {
      writeJobFile(cwd, jobId, { ...stored, ...patch, updatedAt: nowIso() });
    }
    return next;
  });
}

/**
 * Atomically claim a job's terminal state. Returns the updated job, or null
 * when another writer (worker vs stop vs session-end) already claimed it —
 * exactly one claimant wins.
 */
export function claimJobTerminal(cwd, jobId, status, extra = {}) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const index = state.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      return null;
    }
    const existing = state.jobs[index];
    if (existing.status !== "queued" && existing.status !== "running") {
      return null;
    }
    const next = { ...existing, ...extra, status, finishedAt: nowIso(), updatedAt: nowIso() };
    state.jobs[index] = next;
    saveState(cwd, state);
    const stored = readStoredJob(cwd, jobId);
    if (stored) {
      writeJobFile(cwd, jobId, { ...stored, ...extra, status, finishedAt: next.finishedAt, updatedAt: next.updatedAt });
    }
    return next;
  });
}
