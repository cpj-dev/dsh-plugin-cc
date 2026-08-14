import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";

import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../plugins/dsh/scripts/lib/git.mjs";

function makeGitRepo() {
  const dir = makeTempDir("git-");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com"
      }
    });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

test("ensureGitRepository rejects non-repos", () => {
  const dir = makeTempDir();
  assert.throws(() => ensureGitRepository(dir), /Not inside a git repository/);
});

test("auto scope prefers a dirty working tree", () => {
  const { dir } = makeGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  const target = resolveReviewTarget(dir, {});
  assert.equal(target.kind, "working-tree");
  assert.match(target.label, /uncommitted/);
});

test("clean tree resolves a branch target against the given base", () => {
  const { dir, git } = makeGitRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "b.txt"), "new file\n");
  git("add", ".");
  git("commit", "-q", "-m", "feature work");
  const target = resolveReviewTarget(dir, { base: "main" });
  assert.equal(target.kind, "branch");
  assert.equal(target.base, "main");
});

test("rejects an unknown scope and a missing base loudly", () => {
  const { dir } = makeGitRepo();
  assert.throws(() => resolveReviewTarget(dir, { scope: "everything" }), /Unsupported review scope/);
});

test("rejects a nonexistent --base ref instead of reviewing an empty diff", () => {
  const { dir } = makeGitRepo();
  assert.throws(() => resolveReviewTarget(dir, { base: "does-not-exist" }), /Unknown base ref "does-not-exist"/);
});

test("a branch with no changes over base reports empty, not an error", () => {
  const { dir, git } = makeGitRepo();
  git("checkout", "-q", "-b", "feature");
  const target = resolveReviewTarget(dir, { base: "main" });
  const context = collectReviewContext(dir, target);
  assert.equal(context.empty, true);
});

test("a failing branch diff throws instead of masquerading as empty", () => {
  const { dir, git } = makeGitRepo();
  // An orphan branch shares no merge base with main: `git diff main...HEAD`
  // fails, which must surface as an error, not as "no changes".
  git("checkout", "-q", "--orphan", "rootless");
  git("add", ".");
  git("commit", "-q", "-m", "unrelated history");
  const target = resolveReviewTarget(dir, { base: "main" });
  assert.throws(() => collectReviewContext(dir, target), /git diff .* failed/);
});

test("working-tree context includes diffs and untracked contents", () => {
  const { dir } = makeGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\nchanged\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "brand new content\n");
  const target = resolveReviewTarget(dir, {});
  const context = collectReviewContext(dir, target);
  assert.match(context.content, /changed/);
  assert.match(context.content, /untracked: untracked\.txt/);
  assert.match(context.content, /brand new content/);
  assert.ok(context.summary.length > 0);
});

test("branch context carries the base...HEAD diff", () => {
  const { dir, git } = makeGitRepo();
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "b.txt"), "feature payload\n");
  git("add", ".");
  git("commit", "-q", "-m", "feature work");
  const target = resolveReviewTarget(dir, { base: "main" });
  const context = collectReviewContext(dir, target);
  assert.match(context.content, /feature payload/);
});
