/**
 * Release-identity tests.
 *
 * Claude Code installs a plugin into `cache/<marketplace>/<plugin>/<version>/`
 * and records that version in `installed_plugins.json`. Four files carry the
 * number and nothing used to compare them, so `1.0.0` stayed on every build
 * for the entire life of the plugin: `/plugin` showed one version for a dozen
 * different trees, and a bug report could not name what it was filed against.
 * These tests are the offline half of the guard; `.github/workflows/test.yml`
 * adds the half that needs git (a bump relative to the base branch).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { describePluginBuild, readPluginManifest } from "../plugins/dsh/scripts/lib/plugin-meta.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

test("every manifest that carries a version agrees", () => {
  const pluginManifest = readJson("plugins/dsh/.claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const pkg = readJson("package.json");
  const entry = marketplace.plugins.find((plugin) => plugin.name === pluginManifest.name);
  assert.ok(entry, `marketplace.json has no entry for plugin "${pluginManifest.name}"`);

  const versions = {
    "package.json": pkg.version,
    "plugins/dsh/.claude-plugin/plugin.json": pluginManifest.version,
    "marketplace.json metadata": marketplace.metadata.version,
    [`marketplace.json plugins[${pluginManifest.name}]`]: entry.version
  };
  for (const [where, version] of Object.entries(versions)) {
    assert.match(version ?? "", SEMVER, `${where} is not a semver version`);
  }
  assert.equal(
    new Set(Object.values(versions)).size,
    1,
    `version mismatch across manifests: ${JSON.stringify(versions, null, 2)}`
  );
});

test("the changelog documents the version being shipped", () => {
  const { version } = readPluginManifest();
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const headings = [...changelog.matchAll(/^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b.*$/gm)];
  assert.ok(headings.length > 0, "CHANGELOG.md has no version headings");
  assert.equal(
    headings[0][1],
    version,
    `CHANGELOG.md leads with ${headings[0][1]} but the manifests say ${version}`
  );
  // No `Unreleased` bucket: an entry that is written but unreleased is exactly
  // the state that let the shipped version drift away from the shipped code.
  assert.doesNotMatch(changelog, /^## Unreleased\b/m);
});

test("the readiness report can name this build", () => {
  const { version } = readPluginManifest();
  const build = describePluginBuild();
  assert.equal(build.ok, true);
  assert.equal(build.version, version);
  assert.match(build.detail, new RegExp(`\\b${version.replace(/\./g, "\\.")}$`));
});

test("an unreadable manifest degrades to a reported row, not a crash", () => {
  const build = describePluginBuild(path.join(repoRoot, "does-not-exist.json"));
  assert.equal(build.ok, false);
  assert.equal(build.version, null);
  assert.match(build.detail, /unknown build/);
});
