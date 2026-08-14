import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([
  ".git",
  ".internal",
  ".claude",
  ".codex",
  ".agents",
  "node_modules"
]);

function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...collectMarkdownFiles(path.join(directory, entry.name)));
      }
      continue;
    }
    if (entry.name.endsWith(".md") && entry.name !== "implementation-notes.md") {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

test("local Markdown links resolve", () => {
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const failures = [];

  for (const file of collectMarkdownFiles(rootDir)) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(linkPattern)) {
      const destination = match[1].replace(/^<|>$/g, "");
      if (destination.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(destination)) {
        continue;
      }
      const relativePath = decodeURIComponent(destination.split("#", 1)[0]);
      if (!relativePath) {
        continue;
      }
      const target = path.resolve(path.dirname(file), relativePath);
      if (!existsSync(target)) {
        failures.push(`${path.relative(rootDir, file)} -> ${destination}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("community health and bilingual entry files exist", () => {
  const expectedFiles = [
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "CONTRIBUTING.zh-CN.md",
    "SECURITY.md",
    "SECURITY.zh-CN.md",
    "SUPPORT.md",
    "SUPPORT.zh-CN.md",
    "CODE_OF_CONDUCT.md",
    "CODE_OF_CONDUCT.zh-CN.md",
    "docs/README.md",
    "docs/zh-CN/README.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/PULL_REQUEST_TEMPLATE.md"
  ];

  for (const file of expectedFiles) {
    assert.equal(existsSync(path.join(rootDir, file)), true, `${file} is required`);
  }
});

test("English and Chinese entry pages link to each other", () => {
  const pairs = [
    ["README.md", "README.zh-CN.md"],
    ["CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md"],
    ["SECURITY.md", "SECURITY.zh-CN.md"],
    ["SUPPORT.md", "SUPPORT.zh-CN.md"],
    ["CODE_OF_CONDUCT.md", "CODE_OF_CONDUCT.zh-CN.md"]
  ];

  for (const [englishFile, chineseFile] of pairs) {
    const english = readFileSync(path.join(rootDir, englishFile), "utf8");
    const chinese = readFileSync(path.join(rootDir, chineseFile), "utf8");
    assert.match(english, new RegExp(chineseFile.replace(".", "\\.")));
    assert.match(chinese, new RegExp(englishFile.replace(".", "\\.")));
  }
});

test("gitignore preserves public examples and excludes private notes", () => {
  const gitignore = readFileSync(path.join(rootDir, ".gitignore"), "utf8");
  assert.match(gitignore, /^!\.env\.example$/m);
  assert.match(gitignore, /^\/implementation-notes\.md$/m);
  assert.match(gitignore, /^\/docs\/internal\/$/m);
  assert.doesNotMatch(gitignore, /^docs\/$/m);
  assert.doesNotMatch(gitignore, /^\*\.md$/m);
});
