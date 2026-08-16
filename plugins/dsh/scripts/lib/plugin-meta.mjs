/**
 * The plugin's own identity, read from the manifest Claude Code installs.
 *
 * Claude Code keys a plugin's install path by this version
 * (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`) and records it
 * in `installed_plugins.json`. A version that never moves makes every build
 * since the last bump indistinguishable in a bug report and in `/plugin`, so
 * the readiness report prints it and `tests/version.test.mjs` keeps the four
 * manifests in lockstep with the changelog.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `plugins/dsh/.claude-plugin/plugin.json`, from `plugins/dsh/scripts/lib/`. */
export const PLUGIN_MANIFEST_PATH = fileURLToPath(new URL("../../.claude-plugin/plugin.json", import.meta.url));

/** Manifest name + version, or nulls when the manifest is unreadable. */
export function readPluginManifest(manifestPath = PLUGIN_MANIFEST_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      name: typeof parsed?.name === "string" ? parsed.name : null,
      version: typeof parsed?.version === "string" ? parsed.version : null
    };
  } catch {
    // A missing or malformed manifest must not take the readiness probe down:
    // every other row still tells the user something actionable.
    return { name: null, version: null };
  }
}

/**
 * One readiness row describing this plugin build. `installPath` is included
 * when it carries the version segment Claude Code created, because that is
 * what a stale cache looks like from the outside.
 */
export function describePluginBuild(manifestPath = PLUGIN_MANIFEST_PATH) {
  const { name, version } = readPluginManifest(manifestPath);
  if (!version) {
    return { ok: false, name, version: null, detail: `unknown build (unreadable ${path.basename(manifestPath)})` };
  }
  return { ok: true, name: name ?? "dsh", version, detail: `${name ?? "dsh"} ${version}` };
}
