/**
 * Child-process fixture for the SessionEnd-vs-writer race test: upserts
 * `count` jobs for session B into the workspace given as argv[2] while the
 * parent concurrently removes session A's jobs.
 */

import process from "node:process";

import { upsertJob, writeJobFile } from "../plugins/dsh/scripts/lib/state.mjs";

const workspace = process.argv[2];
const count = Number(process.argv[3] ?? 30);

for (let index = 0; index < count; index += 1) {
  const job = {
    id: `run-b${index}`,
    kind: "task",
    jobClass: "task",
    title: `B${index}`,
    status: "running",
    sessionId: "session-b",
    createdAt: new Date().toISOString()
  };
  upsertJob(workspace, job);
  writeJobFile(workspace, job.id, job);
  await new Promise((resolve) => setTimeout(resolve, 2));
}
console.log("done");
