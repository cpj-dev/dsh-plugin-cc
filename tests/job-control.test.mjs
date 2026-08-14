import assert from "node:assert/strict";
import test from "node:test";

import { makeTempDir, withEnv } from "./helpers.mjs";

import { resolveCancelableJob } from "../plugins/dsh/scripts/lib/job-control.mjs";
import { upsertJob, writeJobFile } from "../plugins/dsh/scripts/lib/state.mjs";

function seedJob(workspace, job) {
  upsertJob(workspace, job);
  writeJobFile(workspace, job.id, job);
}

function makeJob(id, status, extra = {}) {
  return {
    id,
    kind: "task",
    jobClass: "task",
    title: "Test",
    status,
    createdAt: new Date().toISOString(),
    ...extra
  };
}

test("resolveCancelableJob refuses explicitly referenced terminal jobs", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      const job = makeJob(`run-${status}1`, status, { bridgePid: process.pid });
      seedJob(workspace, job);
      assert.throws(() => resolveCancelableJob(workspace, job.id), /already finished/);
    }
  });
});

test("resolveCancelableJob reports dead-pid running jobs as stale", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    // Use an implausibly high pid that cannot be alive.
    seedJob(workspace, makeJob("run-dead1", "running", { agentPid: 99999999, bridgePid: 99999998 }));
    const { job } = resolveCancelableJob(workspace, "run-dead1");
    assert.equal(job.status, "stale");
  });
});

test("resolveCancelableJob without a reference picks the newest active job", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    seedJob(workspace, makeJob("run-old1", "completed"));
    seedJob(workspace, makeJob("run-live1", "running", { bridgePid: process.pid }));
    const { job } = resolveCancelableJob(workspace, null);
    assert.equal(job.id, "run-live1");
  });
});

test("resolveCancelableJob without a reference errors when nothing is active", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    seedJob(workspace, makeJob("run-done1", "completed"));
    assert.throws(() => resolveCancelableJob(workspace, null), /No active run/);
  });
});
