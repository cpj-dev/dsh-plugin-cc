/**
 * Weak import of a Claude Code transcript: locate the session JSONL and
 * compress it into a bounded text digest that seeds one DSH headless prompt.
 * DSH has no Claude-session importer, so v1 transfers context, not history.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Env var carrying the transcript path (set by the SessionStart hook). */
export const TRANSCRIPT_PATH_ENV = "DSH_CC_TRANSCRIPT_PATH";

const DEFAULT_MAX_CHARS = 60_000;

function claudeProjectDirFor(cwd) {
  // Claude Code stores transcripts under ~/.claude/projects/<munged-abs-path>/.
  const munged = path.resolve(cwd).replace(/[/\\.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", munged);
}

/**
 * Resolve the Claude session JSONL to import: explicit `source` first, then
 * the hook-provided env path, then the newest transcript for this project.
 */
export function resolveClaudeSessionPath(cwd, { source = null } = {}) {
  if (source) {
    const resolved = path.resolve(cwd, source);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Transcript not found: ${resolved}`);
    }
    return resolved;
  }

  const fromEnv = process.env[TRANSCRIPT_PATH_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const projectDir = claudeProjectDirFor(cwd);
  if (fs.existsSync(projectDir)) {
    const newest = fs
      .readdirSync(projectDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const full = path.join(projectDir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) {
      return newest.full;
    }
  }

  throw new Error(
    "No Claude transcript found. Pass --source <path-to-jsonl>, or start a fresh Claude Code session so the SessionStart hook records one."
  );
}

function extractText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Compress a Claude transcript JSONL into a plain-text conversation digest,
 * keeping the newest turns within `maxChars`.
 */
export function compressTranscript(transcriptPath, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const turns = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message ?? entry;
    const role = message?.role ?? entry?.type;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractText(message?.content).trim();
    if (!text) {
      continue;
    }
    turns.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }

  if (turns.length === 0) {
    throw new Error(`Transcript ${transcriptPath} contains no user/assistant text turns.`);
  }

  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (used + turn.length > maxChars) {
      kept.unshift(`(older turns omitted: ${i + 1})`);
      break;
    }
    kept.unshift(turn);
    used += turn.length;
  }
  return kept.join("\n\n");
}
