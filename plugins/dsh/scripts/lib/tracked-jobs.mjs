/**
 * Tracked job execution: job records, log files, progress reporting, and the
 * run wrapper that claims exactly one terminal state per job.
 */

import fs from "node:fs";
import path from "node:path";

import {
  claimJobTerminal,
  nowIso,
  patchJobIfActive,
  resolveJobsDir,
  upsertJob,
  writeJobFile
} from "./state.mjs";

/** Env var carrying the Claude Code session id (set by the SessionStart hook). */
export const SESSION_ID_ENV = "DSH_CC_SESSION_ID";

/** Build a fresh job record (status `running` until enqueued or finished). */
export function createJobRecord({
  id,
  kind,
  kindLabel,
  title,
  workspaceRoot,
  jobClass,
  summary,
  write = false,
  broker = false,
  dshSessionId = null
}) {
  return {
    id,
    kind,
    kindLabel,
    title,
    summary,
    jobClass,
    write,
    workspaceRoot,
    sessionId: process.env[SESSION_ID_ENV] ?? null,
    // Broker-backed jobs carry their session id from creation so `stop` can
    // identify an in-flight broker turn (there is no per-turn cancel on the
    // SDK wire; the broker must be torn down instead).
    broker: Boolean(broker),
    dshSessionId,
    status: "running",
    phase: "starting",
    pid: null,
    agentPid: null,
    bridgePid: process.pid,
    logFile: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    errorMessage: null
  };
}

/** Create the per-job log file and write its header line. */
export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = path.join(resolveJobsDir(workspaceRoot), `${jobId}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `# ${title} (${jobId}) — started ${nowIso()}\n`, "utf8");
  return logFile;
}

/** Append one timestamped line to a job log. */
export function appendLogLine(logFile, line) {
  if (!logFile) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${line}\n`, "utf8");
  } catch {
    // Log loss is acceptable; job state stays authoritative in state.json.
  }
}

/**
 * Progress reporter: writes to stderr (foreground runs), the job log, and
 * forwards structured phase/pid updates to the job record.
 */
export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  return (update) => {
    const message = typeof update === "string" ? update : update?.message;
    if (!message) {
      return;
    }
    if (stderr) {
      process.stderr.write(`${message}\n`);
    }
    appendLogLine(logFile, message);
    if (onEvent && typeof update === "object") {
      onEvent(update);
    }
  };
}

/** Patch phase / agent pid / dsh session id onto the live job record. */
export function createJobProgressUpdater(workspaceRoot, jobId) {
  return (update) => {
    const patch = {};
    if (update.phase) {
      patch.phase = update.phase;
    }
    if (update.agentPid) {
      patch.agentPid = update.agentPid;
      patch.pid = update.agentPid;
    }
    if (update.dshSessionId) {
      patch.dshSessionId = update.dshSessionId;
    }
    if (update.dshSessionGeneration) {
      patch.dshSessionGeneration = update.dshSessionGeneration;
    }
    if (Object.keys(patch).length > 0) {
      patchJobIfActive(workspaceRoot, jobId, patch);
    }
  };
}

/** PIDs `stop` must terminate for a job: agent child and bridge worker. */
export function resolveJobKillTargets(job) {
  const targets = new Set();
  for (const pid of [job.agentPid, job.bridgePid, job.pid]) {
    if (pid && Number(pid) !== process.pid) {
      targets.add(Number(pid));
    }
  }
  return [...targets];
}

/**
 * Run one job to a terminal state. Persists `running` first, executes the
 * runner, then claims `completed` / `failed` with the rendered result stored
 * on the job file so `show` can replay it later.
 */
export async function runTrackedJob(job, runner, { logFile = null } = {}) {
  const record = { ...job, status: "running", phase: job.phase ?? "running", logFile, bridgePid: process.pid };
  writeJobFile(job.workspaceRoot, job.id, record);
  upsertJob(job.workspaceRoot, record);

  try {
    const execution = await runner();
    const status = execution.exitStatus === 0 ? "completed" : "failed";
    claimJobTerminal(job.workspaceRoot, job.id, status, {
      phase: status,
      errorMessage: status === "failed" ? execution.summary ?? "dsh exited nonzero" : null,
      dshSessionId: execution.dshSessionId ?? record.dshSessionId ?? null,
      // The runtime generation that actually answered; resume candidacy
      // requires it, so it only ever lands on successfully finished turns.
      dshSessionGeneration: execution.dshSessionGeneration ?? record.dshSessionGeneration ?? null,
      result: {
        rendered: execution.rendered ?? "",
        summary: execution.summary ?? "",
        payload: execution.payload ?? null
      }
    });
    appendLogLine(logFile, `Job ${status}.`);
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    claimJobTerminal(job.workspaceRoot, job.id, "failed", {
      phase: "failed",
      errorMessage: message,
      result: { rendered: `${message}\n`, summary: message, payload: null }
    });
    appendLogLine(logFile, `Job failed: ${message}`);
    return {
      exitStatus: 1,
      payload: { error: message },
      rendered: `${message}\n`,
      summary: message
    };
  }
}
