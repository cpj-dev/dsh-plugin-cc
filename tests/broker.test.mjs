import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, withEnv } from "./helpers.mjs";

import {
  brokerRequest,
  ensureBroker,
  getBrokerStatus,
  resolveBrokerPaths,
  stopBroker
} from "../plugins/dsh/scripts/lib/broker-client.mjs";
import { resolveStateDir } from "../plugins/dsh/scripts/lib/state.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BROKER_SCRIPT = path.join(TESTS_DIR, "..", "plugins", "dsh", "scripts", "dsh-broker.mjs");

/** Count live broker daemons serving this state dir (ps-based, POSIX). */
function countBrokerDaemons(stateDir) {
  const out = execFileSync("ps", ["ax", "-o", "command="], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes("dsh-broker.mjs") && line.includes(stateDir)).length;
}

/**
 * A wrapper `dsh` that ignores its argv (`--profile cc`) and execs the fake
 * SDK runtime, so the broker's spawn path runs unmodified.
 */
function writeFakeRuntimeWrapper(dir) {
  const wrapper = path.join(dir, "dsh");
  const runtime = path.join(TESTS_DIR, "fake-sdk-runtime.mjs");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${runtime}"\n`, { mode: 0o755 });
  return wrapper;
}

test("broker multi-turn: session continuity, status, and shutdown", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-broker-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    const socketPath = await ensureBroker(workspace, { permissionMode: "read-only" });

    const first = await brokerRequest(socketPath, "run", { prompt: "hello" }, { timeoutMs: 10_000 });
    assert.ok(first.sessionId.startsWith("cc-"));
    assert.equal(first.finalResponse, "turn 1: hello");

    const second = await brokerRequest(
      socketPath,
      "run",
      { sessionId: first.sessionId, prompt: "again" },
      { timeoutMs: 10_000 }
    );
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.finalResponse, "turn 2: again", "same session accumulates turns");

    const fresh = await brokerRequest(socketPath, "run", { prompt: "other" }, { timeoutMs: 10_000 });
    assert.notEqual(fresh.sessionId, first.sessionId);
    assert.equal(fresh.finalResponse, "turn 1: other", "new session starts at turn 1");

    const status = await getBrokerStatus(workspace);
    assert.equal(status.runtimeAlive, true);
    assert.equal(status.busy, false);
    assert.equal(status.lastSessionId, fresh.sessionId);
    assert.equal(status.model, "deepseek-v4-pro", "broker sessions default to the plugin model");
    assert.equal(status.effort, "max", "broker sessions default to the plugin reasoning effort");

    assert.equal(await stopBroker(workspace), true);
    assert.equal(await getBrokerStatus(workspace), null);
  });
});

test("a timed-out run frees the broker at the requested deadline", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-broker-timeout-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    try {
      const socketPath = await ensureBroker(workspace, { permissionMode: "read-only" });
      const startedAt = Date.now();
      await assert.rejects(
        brokerRequest(socketPath, "run", { prompt: "hang", timeoutMs: 300 }, { timeoutMs: 10_000 }),
        /timed out after 300ms/
      );
      assert.ok(Date.now() - startedAt < 5000, "the 300ms request timeout must apply, not the 20-minute default");

      const status = await getBrokerStatus(workspace);
      assert.equal(status.busy, false, "the broker must free itself when a run times out");

      const next = await brokerRequest(socketPath, "run", { prompt: "hello" }, { timeoutMs: 10_000 });
      assert.equal(next.finalResponse, "turn 1: hello", "a new run must succeed right after a timeout");
    } finally {
      await stopBroker(workspace);
    }
  });
});

test("concurrent ensureBroker calls converge on exactly one daemon", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-broker-race-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper };
  const child = path.join(TESTS_DIR, "ensure-broker-child.mjs");

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    const stateDir = resolveStateDir(workspace);
    try {
      const runs = await Promise.all(
        [0, 1].map(
          () =>
            new Promise((resolve, reject) => {
              const proc = spawn(process.execPath, [child, workspace], { env, stdio: ["ignore", "pipe", "pipe"] });
              let stdout = "";
              let stderr = "";
              proc.stdout.on("data", (chunk) => (stdout += chunk));
              proc.stderr.on("data", (chunk) => (stderr += chunk));
              proc.on("error", reject);
              proc.on("close", (code) => resolve({ code, stdout, stderr }));
            })
        )
      );
      for (const run of runs) {
        assert.equal(run.code, 0, run.stderr);
      }
      const pids = runs.map((run) => JSON.parse(run.stdout).pid);
      assert.ok(pids[0], "first caller saw a broker");
      assert.equal(pids[0], pids[1], "both callers must land on the same daemon");
      assert.equal(countBrokerDaemons(stateDir), 1, "exactly one daemon may survive the race");

      const probe = await brokerRequest(resolveBrokerPaths(workspace).socketPath, "run", { prompt: "hello" }, { timeoutMs: 10_000 });
      assert.equal(probe.finalResponse, "turn 1: hello");
    } finally {
      await stopBroker(workspace);
    }
    // The shutdown RPC answers before the daemon finishes exiting; give it a
    // moment before asserting nothing survived.
    const deadline = Date.now() + 5000;
    while (countBrokerDaemons(stateDir) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(countBrokerDaemons(stateDir), 0, "no orphan daemon after stopBroker");
  });
});

test("ensureBroker reclaims a stale start lock", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-broker-stale-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    const { startLockFile } = resolveBrokerPaths(workspace);
    fs.mkdirSync(path.dirname(startLockFile), { recursive: true });
    fs.writeFileSync(startLockFile, JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }));
    try {
      const socketPath = await ensureBroker(workspace, { permissionMode: "read-only" });
      assert.ok(socketPath);
      assert.ok(await getBrokerStatus(workspace));
      assert.equal(fs.existsSync(startLockFile), false, "the reclaimed lock is released after startup");
    } finally {
      await stopBroker(workspace);
    }
  });
});

test("daemon startup: dead-owner socket is taken over, live-owner socket is refused", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-broker-sock-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    const { socketPath, pidFile } = resolveBrokerPaths(workspace);
    const stateDir = resolveStateDir(workspace);
    const daemonArgs = [
      BROKER_SCRIPT,
      "serve",
      "--cwd",
      workspace,
      "--state-dir",
      stateDir,
      "--socket",
      socketPath,
      "--permission-mode",
      "read-only"
    ];
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper };

    // Live foreign owner recorded: the daemon must refuse to take the socket.
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(socketPath, "not-a-socket");
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    const refused = spawnSync(process.execPath, daemonArgs, { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to take over/);
    assert.ok(fs.existsSync(socketPath), "a refused daemon must not remove the socket");

    // Dead owner recorded: the daemon may clean up and take over.
    fs.writeFileSync(pidFile, "99999999\n");
    try {
      await ensureBroker(workspace, { permissionMode: "read-only" });
      const status = await getBrokerStatus(workspace);
      assert.ok(status, "takeover of a dead owner's stale socket must succeed");
    } finally {
      await stopBroker(workspace);
    }
  });
});
