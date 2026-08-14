import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, withEnv } from "./helpers.mjs";

import { getBrokerStatus, stopBroker } from "../plugins/dsh/scripts/lib/broker-client.mjs";
import { isPidAlive } from "../plugins/dsh/scripts/lib/process.mjs";
import { listJobs, upsertJob, writeJobFile } from "../plugins/dsh/scripts/lib/state.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(TESTS_DIR, "..", "plugins", "dsh", "scripts", "dsh-bridge.mjs");

function runBridge(args, env) {
  return spawnSync(process.execPath, [BRIDGE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000
  });
}

function seedJob(workspace, job) {
  upsertJob(workspace, job);
  writeJobFile(workspace, job.id, job);
}

function spawnSentinel() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  child.unref();
  return child;
}

function writeFakeRuntimeWrapper(dir) {
  const wrapper = path.join(dir, "dsh");
  const runtime = path.join(TESTS_DIR, "fake-sdk-runtime.mjs");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${runtime}"\n`, { mode: 0o755 });
  return wrapper;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("stop on a finished run refuses and never signals its recorded pids", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-stop-");
  const sentinel = spawnSentinel();
  try {
    await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
      seedJob(workspace, {
        id: "run-finished1",
        kind: "task",
        jobClass: "task",
        title: "Finished",
        status: "completed",
        agentPid: sentinel.pid,
        bridgePid: sentinel.pid,
        createdAt: new Date().toISOString()
      });
    });

    const result = runBridge(["stop", "run-finished1", "--cwd", workspace], { CLAUDE_PLUGIN_DATA: dataDir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already finished/);
    // The PID-reuse regression: the sentinel stands in for an unrelated
    // process that happens to hold a finished job's recorded pid.
    assert.equal(isPidAlive(sentinel.pid), true, "recorded pid of a finished run must not be signalled");
  } finally {
    sentinel.kill("SIGKILL");
  }
});

test("stop on a running job kills its pids and records cancelled", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-stop-");
  const sentinel = spawnSentinel();
  try {
    await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, async () => {
      seedJob(workspace, {
        id: "run-live1",
        kind: "task",
        jobClass: "task",
        title: "Live",
        status: "running",
        bridgePid: sentinel.pid,
        createdAt: new Date().toISOString()
      });

      const result = runBridge(["stop", "run-live1", "--cwd", workspace], { CLAUDE_PLUGIN_DATA: dataDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Stopped Live run-live1/);
      // The sentinel is this test process's child; while the bridge ran we
      // were blocked in spawnSync and could not reap it, so it may linger as
      // a zombie for a few ticks. Poll until the reap lands.
      const deadline = Date.now() + 3000;
      while (isPidAlive(sentinel.pid) && Date.now() < deadline) {
        await sleep(50);
      }
      assert.equal(isPidAlive(sentinel.pid), false);
      assert.equal(listJobs(workspace)[0].status, "cancelled");
    });
  } finally {
    if (isPidAlive(sentinel.pid)) {
      sentinel.kill("SIGKILL");
    }
  }
});

test("stop on a stale job cleans the record without signalling", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-stop-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    seedJob(workspace, {
      id: "run-stale1",
      kind: "task",
      jobClass: "task",
      title: "Stale",
      status: "running",
      agentPid: 99999999,
      createdAt: new Date().toISOString()
    });
  });

  const result = runBridge(["stop", "run-stale1", "--cwd", workspace], { CLAUDE_PLUGIN_DATA: dataDir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already gone/);
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    assert.equal(listJobs(workspace)[0].status, "cancelled");
  });
});

test("stop aborts an in-flight broker run by tearing the broker down", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-stop-broker-");
  const binDir = makeTempDir("bin-");
  const wrapper = writeFakeRuntimeWrapper(binDir);
  const env = { CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: wrapper };

  try {
    const started = runBridge(["run", "hang forever", "--session", "--background", "--cwd", workspace], env);
    assert.equal(started.status, 0, started.stderr);
    const jobId = started.stdout.match(/(run-[a-z0-9]+)/)?.[1];
    assert.ok(jobId, `no job id in: ${started.stdout}`);

    // Wait until the worker has patched the session id onto the running job
    // (the in-flight marker) and the broker reports busy.
    await withEnv(env, async () => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const job = listJobs(workspace).find((entry) => entry.id === jobId);
        const status = await getBrokerStatus(workspace);
        if (job?.status === "running" && job?.dshSessionId && status?.busy) {
          break;
        }
        assert.ok(Date.now() < deadline, `broker run never became in-flight (job: ${JSON.stringify(job)})`);
        await sleep(150);
      }
    });

    const stopped = runBridge(["stop", jobId, "--cwd", workspace], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /broker was stopped/);

    await withEnv(env, async () => {
      assert.equal(listJobs(workspace).find((entry) => entry.id === jobId)?.status, "cancelled");
      assert.equal(await getBrokerStatus(workspace), null, "broker must be gone after stopping an in-flight run");
    });
  } finally {
    await withEnv(env, () => stopBroker(workspace)).catch(() => {});
  }
});
