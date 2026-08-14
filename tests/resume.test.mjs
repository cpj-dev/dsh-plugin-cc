import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, withEnv } from "./helpers.mjs";

import {
  BROKER_STALE_SESSION_RPC_CODE,
  brokerRequest,
  ensureBroker,
  getBrokerStatus,
  stopBroker
} from "../plugins/dsh/scripts/lib/broker-client.mjs";
import { listJobs } from "../plugins/dsh/scripts/lib/state.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(TESTS_DIR, "..", "plugins", "dsh", "scripts", "dsh-bridge.mjs");

function writeFakeRuntimeWrapper(dir) {
  const wrapper = path.join(dir, "dsh");
  const runtime = path.join(TESTS_DIR, "fake-sdk-runtime.mjs");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${runtime}"\n`, { mode: 0o755 });
  return wrapper;
}

test("resume lifecycle: continuity while live, explicit refusal once the broker or runtime is gone", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-resume-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper };
  const runBridge = (args) => spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env, timeout: 30_000 });

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    try {
      // Turn 1: a fresh session records id + runtime generation on the job.
      const first = runBridge(["run", "hello", "--session", "--cwd", workspace]);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /turn 1: hello/);
      const firstJob = listJobs(workspace)[0];
      assert.equal(firstJob.status, "completed");
      assert.ok(firstJob.dshSessionId, "completed session run records its session id");
      assert.ok(firstJob.dshSessionGeneration, "completed session run records the runtime generation");

      // Resume continues the same in-memory session (turn 2, not turn 1).
      const second = runBridge(["run", "again", "--resume", "--cwd", workspace]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /turn 2: again/);

      // Broker gone: resume must refuse loudly, never silently start fresh.
      assert.equal(await stopBroker(workspace), true);
      const afterStop = runBridge(["run", "more", "--resume", "--cwd", workspace]);
      assert.equal(afterStop.status, 1);
      assert.match(afterStop.stderr, /no live broker holds it/);
      assert.doesNotMatch(afterStop.stdout, /turn 1/, "a refused resume must not run a fresh session");

      // run-resume-candidate must stop suggesting the dead session too.
      const candidate = runBridge(["run-resume-candidate", "--json", "--cwd", workspace]);
      assert.equal(candidate.status, 0, candidate.stderr);
      const parsed = JSON.parse(candidate.stdout);
      assert.equal(parsed.available, false);
      assert.match(parsed.detail, /no longer live/);

      // A fresh broker (new daemon, no runtime yet) is a different world:
      // the recorded generation cannot match, so resume still refuses.
      await ensureBroker(workspace, { permissionMode: "read-only" });
      const afterRestart = runBridge(["run", "more", "--resume", "--cwd", workspace]);
      assert.equal(afterRestart.status, 1);
      assert.match(afterRestart.stderr, /runtime restarted/);
      assert.doesNotMatch(afterRestart.stdout, /turn 1/);
    } finally {
      await stopBroker(workspace);
    }
  });
});

test("--timeout-ms is validated and forwarded to the broker", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-timeout-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper };
  const runBridge = (args) => spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env, timeout: 30_000 });

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    try {
      const invalid = runBridge(["run", "x", "--session", "--timeout-ms", "abc", "--cwd", workspace]);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Invalid --timeout-ms/);

      // The broker-side timeout wording proves the value crossed the socket:
      // a client-side timeout renders as "broker request run timed out".
      const timedOut = runBridge(["run", "hang forever", "--session", "--timeout-ms", "400", "--cwd", workspace]);
      assert.equal(timedOut.status, 1);
      assert.match(timedOut.stdout, /timed out after 400ms.*runtime keeps working/);

      const status = await getBrokerStatus(workspace);
      assert.equal(status?.busy, false, "the broker must not stay busy past the forwarded deadline");
    } finally {
      await stopBroker(workspace);
    }
  });
});

test("broker rejects a run whose expectedGeneration is not the live one", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-resume-rpc-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper }, async () => {
    try {
      const socketPath = await ensureBroker(workspace, { permissionMode: "read-only" });
      await assert.rejects(
        brokerRequest(socketPath, "run", { sessionId: "cc-x", prompt: "hi", expectedGeneration: "bogus" }, { timeoutMs: 5000 }),
        (error) => error.rpcCode === BROKER_STALE_SESSION_RPC_CODE
      );
    } finally {
      await stopBroker(workspace);
    }
  });
});
