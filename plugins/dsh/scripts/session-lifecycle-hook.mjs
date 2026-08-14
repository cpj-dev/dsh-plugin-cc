#!/usr/bin/env node
/**
 * Claude Code session lifecycle hook.
 *
 * SessionStart: exports the Claude session id, transcript path, and plugin
 * data dir into CLAUDE_ENV_FILE so later Bash tool calls (the bridge) see
 * them. SessionEnd: cancels this session's still-running bridge jobs and
 * removes their records.
 */

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { claimJobTerminal, loadState, removeJobsBySession, resolveStateFile } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveJobKillTargets, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }
  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }
  for (const job of sessionJobs) {
    if (job.status === "queued" || job.status === "running") {
      let claimed = null;
      try {
        claimed = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
          errorMessage: "Stopped by session end.",
          phase: "cancelled"
        });
      } catch {
        // Lock contention; treat as a lost claim below.
      }
      if (!claimed) {
        // Another writer finished the job first — its pids may already be
        // reused by unrelated processes, so they must not be signalled.
        continue;
      }
      for (const pid of resolveJobKillTargets(job)) {
        try {
          await terminateProcessTree(pid);
        } catch {
          // Process already gone.
        }
      }
    }
  }
  removeJobsBySession(workspaceRoot, sessionId);
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";
  if (eventName === "SessionStart") {
    handleSessionStart(input);
  } else if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
