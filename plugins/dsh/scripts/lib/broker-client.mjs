/**
 * Bridge-side broker access: locate the per-workspace broker, start it on
 * demand (detached), send line-JSON-RPC requests, and stop it.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./fs.mjs";
import { isPidAlive, terminateProcessTree } from "./process.mjs";
import { resolveBrokerDir, resolveBrokerSocketPath, resolveStateDir } from "./state.mjs";

/** JSON-RPC error code the broker answers when another run is in flight. */
export const BROKER_BUSY_RPC_CODE = -32001;
/** JSON-RPC error code for a resume whose runtime generation no longer exists. */
export const BROKER_STALE_SESSION_RPC_CODE = -32002;
/** Default per-turn timeout, applied broker-side when the client sends none. */
export const DEFAULT_BROKER_RUN_TIMEOUT_MS = 20 * 60 * 1000;

const SCRIPTS_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const START_WAIT_MS = 15_000;
const START_POLL_MS = 200;
// A start lock older than this is presumed abandoned (> the full spawn/poll
// budget of START_WAIT_MS, so a live starter always finishes or fails first).
const STARTING_STALE_MS = 30_000;

/**
 * Mint a broker session id (`cc-<uuid>`). This is the broker protocol's own
 * convention (the daemon mints the same shape when none is supplied); minting
 * bridge-side lets a job record carry its session id before the turn starts.
 */
export function mintBrokerSessionId() {
  return `cc-${randomUUID()}`;
}

/** Broker file locations for a workspace (socket lives in tmpdir; see state.mjs). */
export function resolveBrokerPaths(workspaceRoot) {
  const dir = resolveBrokerDir(workspaceRoot);
  return {
    dir,
    socketPath: resolveBrokerSocketPath(workspaceRoot),
    pidFile: path.join(dir, "broker.pid"),
    infoFile: path.join(dir, "broker.json"),
    startLockFile: path.join(dir, "broker.starting")
  };
}

function readPid(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** One line-JSON-RPC request over the broker socket. */
export function brokerRequest(socketPath, method, params = {}, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`broker request ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      clearTimeout(timer);
      socket.end();
      try {
        const message = JSON.parse(buffer.slice(0, index));
        if (message.error) {
          const error = new Error(message.error.message);
          error.rpcCode = message.error.code;
          reject(error);
        } else {
          resolve(message.result);
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Broker status: null when not running. */
export async function getBrokerStatus(workspaceRoot) {
  const { socketPath, pidFile, infoFile } = resolveBrokerPaths(workspaceRoot);
  const pid = readPid(pidFile);
  if (!pid || !isPidAlive(pid) || !fs.existsSync(socketPath)) {
    return null;
  }
  try {
    const status = await brokerRequest(socketPath, "status", {}, { timeoutMs: 2000 });
    return { ...status, info: readJsonFile(infoFile) };
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to create the startup lock file (O_EXCL). Returns true when acquired.
 * The lock is stale — and reclaimed — when its recorded starter pid is dead
 * or its mtime exceeds STARTING_STALE_MS (a crashed starter never unlinks).
 */
function tryAcquireStartLock(startLockFile) {
  fs.mkdirSync(path.dirname(startLockFile), { recursive: true });
  try {
    fs.writeFileSync(startLockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
      flag: "wx"
    });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    return false;
  }
}

function reclaimStaleStartLock(startLockFile) {
  let starterPid = null;
  let mtimeMs = null;
  try {
    starterPid = JSON.parse(fs.readFileSync(startLockFile, "utf8"))?.pid ?? null;
  } catch {
    // Unreadable lock content; fall through to the mtime check.
  }
  try {
    mtimeMs = fs.statSync(startLockFile).mtimeMs;
  } catch {
    return { reclaimed: true, starterPid: null }; // Lock vanished — treat as released.
  }
  const starterDead = starterPid != null && !isPidAlive(starterPid);
  const expired = mtimeMs != null && Date.now() - mtimeMs > STARTING_STALE_MS;
  if (starterDead || expired) {
    try {
      fs.unlinkSync(startLockFile);
    } catch {
      // Another waiter reclaimed it first; both outcomes free the lock.
    }
    return { reclaimed: true, starterPid };
  }
  return { reclaimed: false, starterPid };
}

function spawnBrokerDaemon(workspaceRoot, { socketPath, permissionMode, provider, model }) {
  const args = [
    path.join(SCRIPTS_DIR, "dsh-broker.mjs"),
    "serve",
    "--cwd",
    workspaceRoot,
    "--state-dir",
    resolveStateDir(workspaceRoot),
    "--socket",
    socketPath,
    "--permission-mode",
    permissionMode
  ];
  if (provider) {
    args.push("--provider", provider);
  }
  if (model) {
    args.push("--model", model);
  }
  const child = spawn(process.execPath, args, {
    cwd: workspaceRoot,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

/**
 * Ensure a live broker for the workspace; spawns a detached one when needed.
 * Returns the socket path.
 *
 * Check-and-spawn is serialized by an O_EXCL startup lock so two concurrent
 * callers cannot both spawn daemons that fight over the socket and pid file.
 * (The state lock cannot be reused here: it is synchronous and this path
 * awaits a multi-second spawn/poll.) Losers piggyback on the winner's broker.
 */
export async function ensureBroker(workspaceRoot, { permissionMode = "workspace-write", provider = null, model = null } = {}) {
  const { socketPath, startLockFile } = resolveBrokerPaths(workspaceRoot);
  const deadline = Date.now() + START_WAIT_MS;

  while (Date.now() < deadline) {
    if (await getBrokerStatus(workspaceRoot)) {
      return socketPath;
    }
    if (!tryAcquireStartLock(startLockFile)) {
      const { reclaimed, starterPid } = reclaimStaleStartLock(startLockFile);
      if (!reclaimed) {
        // A live starter holds the lock; wait for its broker to come up.
        await sleep(START_POLL_MS);
        if (Date.now() >= deadline) {
          throw new Error(
            `The DSH broker is being started by another process${starterPid ? ` (pid ${starterPid})` : ""} but did not come up in time. Retry, or run /dsh:stop --broker to reset.`
          );
        }
      }
      continue;
    }

    try {
      // Double-check under the lock: a broker may have come up between the
      // status probe above and lock acquisition.
      if (await getBrokerStatus(workspaceRoot)) {
        return socketPath;
      }
      spawnBrokerDaemon(workspaceRoot, { socketPath, permissionMode, provider, model });
      while (Date.now() < deadline) {
        if (await getBrokerStatus(workspaceRoot)) {
          return socketPath;
        }
        await sleep(START_POLL_MS);
      }
      throw new Error("The DSH broker did not come up in time. Run /dsh:check, and verify `dsh --profile cc --dump-config` composes.");
    } finally {
      try {
        fs.unlinkSync(startLockFile);
      } catch {
        // Already reclaimed as stale by a waiter; nothing to release.
      }
    }
  }
  throw new Error("The DSH broker did not come up in time. Run /dsh:check, and verify `dsh --profile cc --dump-config` composes.");
}

/** Stop the workspace broker: protocol shutdown first, then tree kill. */
export async function stopBroker(workspaceRoot) {
  const { socketPath, pidFile } = resolveBrokerPaths(workspaceRoot);
  const pid = readPid(pidFile);
  try {
    await brokerRequest(socketPath, "broker/shutdown", {}, { timeoutMs: 3000 });
    // The RPC answers before the daemon finishes exiting; wait for confirmed
    // death so an immediately following ensureBroker cannot latch onto the
    // dying daemon and hand back a socket that is about to disappear.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const alive = pid ? isPidAlive(pid) : fs.existsSync(socketPath);
      if (!alive) {
        return true;
      }
      await sleep(50);
    }
    // Still up after the grace window: fall through to the tree kill.
  } catch {
    // Socket already dead or unresponsive; fall back to the pid below.
  }
  if (pid && isPidAlive(pid)) {
    await terminateProcessTree(pid);
    if (isPidAlive(pid)) {
      return false;
    }
    // A SIGKILL'd daemon never ran its shutdown cleanup; remove its files so
    // the next startup does not have to reason about them.
    for (const file of [socketPath, pidFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
    return true;
  }
  return false;
}
