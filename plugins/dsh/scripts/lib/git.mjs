/**
 * Git context collection for review/critique: target resolution (working
 * tree vs branch diff) and bounded diff/untracked-content gathering. All
 * review-target selection happens here in the plugin, not inside DSH —
 * the same division Codex and Grok use.
 */

import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";

const MAX_CONTEXT_CHARS = 180_000;
const MAX_UNTRACKED_FILE_CHARS = 12_000;

function git(cwd, args) {
  const result = runCommand("git", args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function tryGit(cwd, args) {
  const result = runCommand("git", args, { cwd });
  return result.status === 0 ? result.stdout : "";
}

/** Throw unless `cwd` is inside a git work tree. */
export function ensureGitRepository(cwd) {
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error("Not inside a git repository. Reviews need local git state.");
  }
}

function detectDefaultBase(cwd) {
  const remoteHead = tryGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
  if (remoteHead) {
    return remoteHead.replace("refs/remotes/", "");
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (runCommand("git", ["rev-parse", "--verify", "--quiet", candidate], { cwd }).status === 0) {
      return candidate;
    }
  }
  return null;
}

function hasWorkingTreeChanges(cwd) {
  return tryGit(cwd, ["status", "--short", "--untracked-files=all"]).trim().length > 0;
}

/**
 * Resolve what to review.
 *
 * scope: `auto` (default) prefers the working tree when dirty, else the
 * branch diff against `base`; `working-tree` / `branch` force one side.
 */
export function resolveReviewTarget(cwd, { base = null, scope = "auto" } = {}) {
  ensureGitRepository(cwd);
  const normalizedScope = String(scope ?? "auto").trim() || "auto";
  if (!["auto", "working-tree", "branch"].includes(normalizedScope)) {
    throw new Error(`Unsupported review scope "${scope}". Use auto, working-tree, or branch.`);
  }

  const dirty = hasWorkingTreeChanges(cwd);
  if (normalizedScope === "working-tree" || (normalizedScope === "auto" && dirty)) {
    return { kind: "working-tree", base: null, label: "uncommitted working-tree changes" };
  }

  const resolvedBase = (base && String(base).trim()) || detectDefaultBase(cwd);
  if (!resolvedBase) {
    throw new Error("No base branch found. Pass --base <ref> for a branch review.");
  }
  // Fail loudly on a nonexistent ref: swallowing it downstream would turn a
  // typo'd --base into an "empty diff" review of nothing.
  if (runCommand("git", ["rev-parse", "--verify", "--quiet", `${resolvedBase}^{commit}`], { cwd }).status !== 0) {
    throw new Error(`Unknown base ref "${resolvedBase}". Pass a ref that exists (e.g. origin/main) via --base.`);
  }
  return { kind: "branch", base: resolvedBase, label: `branch changes vs ${resolvedBase}` };
}

function collectUntrackedContents(cwd, budget) {
  const list = tryGit(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sections = [];
  let used = 0;
  for (const file of list) {
    if (used >= budget) {
      sections.push(`(further untracked files omitted: ${list.length - sections.length} remaining)`);
      break;
    }
    let content = "";
    try {
      content = fs.readFileSync(path.join(cwd, file), "utf8");
    } catch {
      content = "(unreadable or binary; skipped)";
    }
    if (content.length > MAX_UNTRACKED_FILE_CHARS) {
      content = `${content.slice(0, MAX_UNTRACKED_FILE_CHARS)}\n… (truncated)`;
    }
    const section = `--- untracked: ${file} ---\n${content}`;
    sections.push(section);
    used += section.length;
  }
  return sections.join("\n\n");
}

/**
 * Collect the review context: repo facts plus the diff (and untracked file
 * contents for working-tree reviews), truncated to a fixed budget so the
 * prompt stays bounded.
 */
export function collectReviewContext(cwd, target) {
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const branch = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "(detached)";

  let diff = "";
  let summary = "";
  let collectionGuidance = "";

  // Diff collection uses the throwing git() on purpose: a failed diff (bad
  // ref, unrelated histories) must surface as an error, never masquerade as
  // "no changes" — that distinction is exactly what `empty` reports below.
  if (target.kind === "working-tree") {
    summary = tryGit(cwd, ["status", "--short", "--untracked-files=all"]).trim();
    const staged = git(cwd, ["diff", "--cached"]);
    const unstaged = git(cwd, ["diff"]);
    const untracked = collectUntrackedContents(repoRoot, MAX_CONTEXT_CHARS / 3);
    diff = [staged && `--- staged diff ---\n${staged}`, unstaged && `--- unstaged diff ---\n${unstaged}`, untracked]
      .filter(Boolean)
      .join("\n\n");
    collectionGuidance =
      "The context below contains the staged diff, unstaged diff, and untracked file contents. Read other repository files only to understand the changes.";
  } else {
    summary = git(cwd, ["diff", "--shortstat", `${target.base}...HEAD`]).trim();
    diff = git(cwd, ["diff", `${target.base}...HEAD`]);
    collectionGuidance = `The context below is the full diff of ${target.base}...HEAD. Read other repository files only to understand the changes.`;
  }

  const empty = !diff.trim();
  let content = diff.trim();
  if (!content) {
    content = "(the resolved target produced an empty diff)";
  }
  if (content.length > MAX_CONTEXT_CHARS) {
    content = `${content.slice(0, MAX_CONTEXT_CHARS)}\n… (context truncated at ${MAX_CONTEXT_CHARS} chars; inspect the repository for the remainder)`;
  }

  return { repoRoot, branch, summary, content, collectionGuidance, target, empty };
}
