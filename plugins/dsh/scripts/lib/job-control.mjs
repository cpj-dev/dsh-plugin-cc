/** Job queries backing `runs`, `show`, and `stop`. */

import { isPidAlive } from "./process.mjs";
import { listJobs, readStoredJob as readStoredJobFile } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

/** Human label for a job kind. */
export function resolveJobKindLabel(kind, jobClass) {
  const labels = {
    review: "Review",
    critique: "Critique",
    task: "Delegate",
    import: "Import"
  };
  return labels[kind] ?? labels[jobClass] ?? kind;
}

/** Newest-first ordering by creation time. */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * Jobs visible to one Claude session. Jobs recorded without a session id
 * (bridge invoked outside a hook-managed session) stay visible everywhere.
 */
export function filterJobsForSession(jobs, { sessionId } = {}) {
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => !job.sessionId || job.sessionId === sessionId);
}

/** Live job snapshot: reconciles a recorded `running` with actual pid liveness. */
function reconcileJob(job) {
  if (job.status !== "running" && job.status !== "queued") {
    return job;
  }
  const pids = [job.agentPid, job.bridgePid, job.pid].filter(Boolean);
  if (pids.length > 0 && !pids.some((pid) => isPidAlive(pid))) {
    return { ...job, status: "stale", phase: "stale" };
  }
  return job;
}

/** Status snapshot for `runs` (this session's jobs unless `all`). */
export function buildStatusSnapshot(cwd, { all = false, sessionId = process.env.DSH_CC_SESSION_ID } = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(reconcileJob);
  if (!all) {
    jobs = filterJobsForSession(jobs, { sessionId });
  }
  return { workspaceRoot, jobs };
}

/** Snapshot of one job by id (or unique prefix). */
export function buildSingleJobSnapshot(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const exact = jobs.find((job) => job.id === reference);
  const prefixed = exact ?? jobs.find((job) => job.id.startsWith(reference));
  if (!prefixed) {
    throw new Error(`No run found matching "${reference}". Use /dsh:runs to list runs.`);
  }
  const stored = readStoredJobFile(workspaceRoot, prefixed.id);
  return { workspaceRoot, job: reconcileJob(prefixed), stored };
}

const CANCELABLE_STATUSES = new Set(["queued", "running", "stale"]);

/**
 * Resolve the job `stop` should cancel: by reference, else newest active.
 * Terminal jobs are refused outright — their recorded pids may have been
 * reused by unrelated processes, so they must never become kill targets.
 * A reconciled `stale` view (recorded running, pids dead) is returned so the
 * caller can clean the record without signalling anything.
 */
export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(reconcileJob);
  if (reference) {
    const match = jobs.find((job) => job.id === reference || job.id.startsWith(reference));
    if (!match) {
      throw new Error(`No run found matching "${reference}".`);
    }
    if (!CANCELABLE_STATUSES.has(match.status)) {
      throw new Error(`Run "${match.id}" already finished (${match.status}). Nothing to stop.`);
    }
    return { workspaceRoot, job: match };
  }
  const active = jobs.find((job) => CANCELABLE_STATUSES.has(job.status));
  if (!active) {
    throw new Error("No active run to stop.");
  }
  return { workspaceRoot, job: active };
}

/** Resolve the job whose stored result `show` should replay. */
export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const job = reference
    ? jobs.find((entry) => entry.id === reference || entry.id.startsWith(reference))
    : jobs.find((entry) => entry.status === "completed" || entry.status === "failed");
  if (!job) {
    throw new Error(reference ? `No run found matching "${reference}".` : "No finished run found.");
  }
  return { workspaceRoot, job, stored: readStoredJobFile(workspaceRoot, job.id) };
}
