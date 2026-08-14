import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, withEnv } from "./helpers.mjs";

import {
  claimJobTerminal,
  generateJobId,
  listJobs,
  patchJobIfActive,
  readStoredJob,
  removeJobsBySession,
  resolveJobsDir,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/dsh/scripts/lib/state.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function makeJob(id, status = "running") {
  return {
    id,
    kind: "task",
    title: "Test",
    status,
    createdAt: new Date().toISOString()
  };
}

test("resolveStateDir scopes by workspace under CLAUDE_PLUGIN_DATA", async () => {
  const dataDir = makeTempDir();
  const workspaceA = makeTempDir("ws-a-");
  const workspaceB = makeTempDir("ws-b-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    const dirA = resolveStateDir(workspaceA);
    const dirB = resolveStateDir(workspaceB);
    assert.ok(dirA.startsWith(path.join(dataDir, "state")));
    assert.notEqual(dirA, dirB);
    assert.equal(dirA, resolveStateDir(workspaceA), "stable across calls");
  });
});

test("upsertJob indexes newest first and job files round-trip", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    const first = makeJob(generateJobId("run"));
    const second = makeJob(generateJobId("run"));
    upsertJob(workspace, first);
    upsertJob(workspace, second);
    const jobs = listJobs(workspace);
    assert.equal(jobs[0].id, second.id);
    assert.equal(jobs[1].id, first.id);

    writeJobFile(workspace, first.id, { ...first, request: { prompt: "hi" } });
    assert.equal(readStoredJob(workspace, first.id).request.prompt, "hi");
  });
});

test("claimJobTerminal lets exactly one claimant win", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    const job = makeJob("run-claim1", "running");
    upsertJob(workspace, job);
    writeJobFile(workspace, job.id, job);

    const winner = claimJobTerminal(workspace, job.id, "completed", { result: { rendered: "done" } });
    assert.equal(winner.status, "completed");
    const loser = claimJobTerminal(workspace, job.id, "cancelled");
    assert.equal(loser, null);
    assert.equal(listJobs(workspace)[0].status, "completed");
  });
});

test("patchJobIfActive updates active jobs and leaves finished ones alone", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    const job = makeJob("run-patch1", "running");
    upsertJob(workspace, job);
    writeJobFile(workspace, job.id, job);

    const patched = patchJobIfActive(workspace, job.id, { phase: "reviewing", agentPid: 4242 });
    assert.equal(patched.phase, "reviewing");
    assert.equal(patched.agentPid, 4242);

    claimJobTerminal(workspace, job.id, "completed");
    const after = patchJobIfActive(workspace, job.id, { phase: "zombie" });
    assert.equal(after.status, "completed");
    assert.notEqual(after.phase, "zombie");
  });
});

test("removeJobsBySession removes only that session's entries and files", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    const jobsDir = resolveJobsDir(workspace);
    for (const [id, sessionId] of [
      ["run-a1", "session-a"],
      ["run-a2", "session-a"],
      ["run-b1", "session-b"]
    ]) {
      const job = { ...makeJob(id), sessionId };
      upsertJob(workspace, job);
      writeJobFile(workspace, id, job);
      fs.writeFileSync(path.join(jobsDir, `${id}.log`), "log\n");
    }

    const removed = removeJobsBySession(workspace, "session-a");
    assert.deepEqual(removed.map((job) => job.id).sort(), ["run-a1", "run-a2"]);
    assert.deepEqual(
      listJobs(workspace).map((job) => job.id),
      ["run-b1"]
    );
    for (const id of ["run-a1", "run-a2"]) {
      assert.equal(fs.existsSync(path.join(jobsDir, `${id}.json`)), false);
      assert.equal(fs.existsSync(path.join(jobsDir, `${id}.log`)), false);
    }
    assert.equal(fs.existsSync(path.join(jobsDir, "run-b1.json")), true);
    assert.equal(fs.existsSync(path.join(jobsDir, "run-b1.log")), true);
  });
});

test("the MAX_JOBS prune unlinks the pruned job's log too", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    const jobsDir = resolveJobsDir(workspace);
    // MAX_JOBS is 50; the 51st upsert prunes the oldest.
    for (let index = 0; index <= 50; index += 1) {
      const job = makeJob(`run-prune${index}`);
      upsertJob(workspace, job);
      writeJobFile(workspace, job.id, job);
      fs.writeFileSync(path.join(jobsDir, `${job.id}.log`), "log\n");
    }
    assert.equal(listJobs(workspace).length, 50);
    assert.equal(fs.existsSync(path.join(jobsDir, "run-prune0.json")), false);
    assert.equal(fs.existsSync(path.join(jobsDir, "run-prune0.log")), false);
  });
});

test("removeJobsBySession does not drop a concurrent writer's jobs", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-race-");
  const writerCount = 30;
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, async () => {
    // Seed some session-A jobs for the remover to chew on.
    for (let index = 0; index < 5; index += 1) {
      upsertJob(workspace, { ...makeJob(`run-a${index}`), sessionId: "session-a" });
    }

    const writer = spawn(
      process.execPath,
      [path.join(TESTS_DIR, "session-cleanup-writer.mjs"), workspace, String(writerCount)],
      { env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, stdio: ["ignore", "pipe", "inherit"] }
    );
    const writerDone = new Promise((resolve, reject) => {
      writer.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
      writer.on("error", reject);
    });

    // Race the SessionEnd-style removal against the live writer.
    while (writer.exitCode === null) {
      removeJobsBySession(workspace, "session-a");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await writerDone;

    const survivors = listJobs(workspace).filter((job) => job.sessionId === "session-b");
    assert.equal(survivors.length, writerCount, "no concurrent writer job may be lost to the cleanup");
  });
});

test("state files live inside the temp data dir only", async () => {
  const dataDir = makeTempDir();
  const workspace = makeTempDir("ws-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    upsertJob(workspace, makeJob("run-loc1"));
    const stateDir = resolveStateDir(workspace);
    assert.ok(fs.existsSync(path.join(stateDir, "state.json")));
    assert.ok(stateDir.startsWith(dataDir));
  });
});
