/**
 * DSH driver layer — the plugin's only file that knows how to invoke
 * DeepSeek Harness. Facts this file encodes (verified against
 * @deepseek-ai/dsh@0.1.0-rc.6 on npm):
 *
 * - One-shot runs: `dsh --profile headless [--patch <overlay>]... -- "<task>"`.
 *   Launcher flags must precede app arguments; the launcher consumes one
 *   `--`, so the task always travels behind an explicit `--`.
 * - stdout carries only the last non-empty assistant message; exit 0 on a
 *   completed final turn, else 1 with the error on stderr.
 * - Sandbox mode comes from the `DSH_PERMISSION_MODE` env var
 *   (read-only | workspace-write | danger-full-access), read by the
 *   dsh-base `sandbox-policy` row at boot.
 * - The base bundle's approval policy is `ask` (fails closed unattended),
 *   and its permission-presets service refuses to boot when the composed
 *   sandbox+approval pair names no preset — so every bridge run applies a
 *   generated per-mode unattended overlay (approval: never + a matching
 *   `unattended` preset; see buildUnattendedOverlayYaml).
 * - Model/effort selection is a generated `--patch` overlay replacing the
 *   `agent-default-model` and `llm-deepseek` rows; `--patch` is the last
 *   composition layer, so it wins over profile and home patches.
 * - Mode selection (minimal | standard | anchored-standard) is a generated
 *   `--patch` overlay too. `minimal` (the default) disables the dsh-base
 *   tool/prompt rows down to bash + str_replace_editor and tightens the
 *   persona; `standard` applies no overlay; `anchored-standard` keeps the
 *   full registry mounted and inserts lib/tool-bootstrap.mjs, which filters
 *   the model-visible catalog to the Minimal pair until the session records
 *   a durable tool/call or assistant/message, then restores the assembled
 *   catalog. The disabled row ids (minimal) and the bootstrap plugin
 *   (anchored-standard) must be re-verified on every dsh upgrade (see
 *   docs/dsh-compat.md). `DSH_TOOLS_MODE` is stripped from every spawn env:
 *   the headless bundle reads it to flip Code Mode process-wide, and mode
 *   ownership belongs to the plugin's --mode.
 * - Headless has no session resume; multi-turn goes through the broker
 *   (see dsh-broker.mjs), never through this file.
 * - Default install is the npm CLI (`@deepseek-ai/dsh@HARNESS_NPM_VERSION`)
 *   into the plugin data dir. The SDK JSON-RPC server is published
 *   separately and is outside the CLI's dependency closure — setup
 *   `dsh plugin add`s it into the cc profile together with that package's
 *   published peerDependencies (self-heal does not provide them).
 *   `--harness` still links a user-built checkout. The harness itself
 *   requires Node ^22.19 || >=24; profile plugin add still needs pnpm.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

/** Default follow-up prompt when resuming a broker session without new text. */
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

const DEFAULT_BINARY = "dsh";
const BINARY_ENV = "DSH_BINARY";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const PERMISSION_MODE_ENV = "DSH_PERMISSION_MODE";
const VALID_PERMISSION_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "max"]);
/** User-facing agent modes. `DEFAULT_MODE` stays `minimal` until A/B says otherwise. */
export const SUPPORTED_MODES = ["minimal", "standard", "anchored-standard"];
const VALID_MODES = new Set(SUPPORTED_MODES);
const MODE_ENV = "DSH_CC_MODE";
const ANCHORED_MODE = "anchored-standard";
const BOOTSTRAP_PLUGIN_FILES = ["tool-bootstrap.mjs", "request-snapshot.mjs"];
/** Read by the headless/web bundles to flip Code Mode process-wide; never ours to forward. */
const TOOLS_MODE_ENV = "DSH_TOOLS_MODE";

/**
 * Plugin-wide default agent mode. dsh shows better overall capability in
 * minimal mode, so every run and broker spawn defaults to it; `standard`
 * (the full dsh-base toolset) and `anchored-standard` (Minimal first
 * request, then the full assembled catalog) stay one `--mode` away.
 */
export const DEFAULT_MODE = "minimal";

/**
 * Plugin-wide default model selection, applied whenever a run does not pass
 * --model/--effort explicitly. Deliberately different from the dsh-base
 * defaults (deepseek-v4-flash, no forced effort), so every bridge run and
 * broker spawn must apply these rather than fall through to the base bundle.
 */
export const DEFAULT_MODEL = "deepseek-v4-pro";
export const DEFAULT_REASONING_EFFORT = "max";

/** Expected package name of the harness CLI (npm and source checkout). */
export const HARNESS_CLI_PACKAGE = "@deepseek-ai/dsh";
/** SDK JSON-RPC server — published separately, outside the CLI dependency closure. */
export const HARNESS_SDK_JSONRPC_PACKAGE = "@deepseek-ai/dsh-sdk-jsonrpc-server";
/**
 * npm versions this plugin release was verified against (see
 * docs/dsh-compat.md). Dist-tags are unsafe: SDK-server `latest` is not
 * the same as CLI `latest`. `--harness` checkouts may run whatever they like.
 */
export const HARNESS_NPM_VERSION = "0.1.0-rc.6";
/** Node floor the harness itself requires (higher than this plugin's >=20). */
export const HARNESS_NODE_FLOOR = "22.19.0";
/**
 * Direct peerDependencies of `@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.0-rc.6`,
 * pinned to the same release (cordis is versioned independently). Setup
 * installs these into the cc profile; without them the server cannot
 * resolve `@deepseek-ai/dsh-sdk-protocol` and cc boot fails.
 */
export const HARNESS_SDK_JSONRPC_PEER_SPECS = [
  `@deepseek-ai/dsh-agent@${HARNESS_NPM_VERSION}`,
  `@deepseek-ai/dsh-invariants@${HARNESS_NPM_VERSION}`,
  `@deepseek-ai/dsh-llm@${HARNESS_NPM_VERSION}`,
  `@deepseek-ai/dsh-llm-deepseek@${HARNESS_NPM_VERSION}`,
  `@deepseek-ai/dsh-scope@${HARNESS_NPM_VERSION}`,
  `@deepseek-ai/dsh-sdk-protocol@${HARNESS_NPM_VERSION}`,
  `@deepseek-ai/dsh-session@${HARNESS_NPM_VERSION}`,
  `@deepseek-ai/dsh-subagent@${HARNESS_NPM_VERSION}`,
  "@deepseek-ai/cordis@^4.0.1"
];

/** Registry spec for the pinned SDK JSON-RPC server. */
export function pinnedSdkServerSpec() {
  return `${HARNESS_SDK_JSONRPC_PACKAGE}@${HARNESS_NPM_VERSION}`;
}

/** `dsh plugin add` arguments that make the cc profile bootable from npm. */
export function pinnedSdkServerInstallSpecs() {
  return [pinnedSdkServerSpec(), ...HARNESS_SDK_JSONRPC_PEER_SPECS];
}

/**
 * Machine-level plugin config (not workspace state): the persisted dsh
 * binary and install source written by `/dsh:setup`. Lives at
 * `$CLAUDE_PLUGIN_DATA/config.json`, falling back to
 * `~/.config/dsh-plugin-cc/config.json` outside Claude Code.
 */
export function resolvePluginConfigFile(env = process.env) {
  const dataDir = env?.[PLUGIN_DATA_ENV];
  if (dataDir && String(dataDir).trim()) {
    return path.join(String(dataDir).trim(), "config.json");
  }
  return path.join(os.homedir(), ".config", "dsh-plugin-cc", "config.json");
}

/** Read the plugin config; never throws. */
export function readPluginConfig(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePluginConfigFile(env), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the plugin config on disk and return the result. Null values remove keys. */
export function writePluginConfig(patch, env = process.env) {
  const file = resolvePluginConfigFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readPluginConfig(env), ...patch };
  for (const [key, value] of Object.entries(next)) {
    if (value == null) {
      delete next[key];
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function configInstallSource(config) {
  if (config.dshInstall === "npm") {
    return "npm-pin";
  }
  if (config.dshInstall === "harness" || config.harnessCheckout) {
    return "harness";
  }
  return "config";
}

/**
 * Resolve the dsh binary and where it came from:
 * DSH_BINARY env > persisted config (`dshBinary`) > `dsh` on PATH.
 * Persisted sources: `npm-pin` (setup's npm prefix), `harness` (`--harness`
 * checkout), or generic `config`. A configured path that no longer exists
 * is reported but not used.
 */
export function describeDshBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return { binary: String(override).trim(), source: "env", staleConfig: null };
  }
  const config = readPluginConfig(env);
  const configured = config.dshBinary;
  if (configured && String(configured).trim()) {
    const candidate = String(configured).trim();
    if (fs.existsSync(candidate)) {
      return { binary: candidate, source: configInstallSource(config), staleConfig: null };
    }
    return { binary: DEFAULT_BINARY, source: "path", staleConfig: candidate };
  }
  return { binary: DEFAULT_BINARY, source: "path", staleConfig: null };
}

/** Resolve the dsh binary (see describeDshBinary for the source chain). */
export function resolveDshBinary(env = process.env) {
  return describeDshBinary(env).binary;
}

/**
 * Inspect a DeepSeek Harness source checkout. The npm CLI (`@deepseek-ai/dsh`)
 * is a separate install path; a source-built CLI is not self-contained —
 * it resolves its workspace dependencies through the checkout's
 * node_modules at runtime, so the checkout must stay in place.
 */
export function inspectHarnessCheckout(checkoutDir) {
  const root = path.resolve(String(checkoutDir ?? "").trim());
  const report = {
    root,
    valid: false,
    reason: null,
    version: null,
    commit: null,
    installed: false,
    built: false,
    binPath: path.join(root, "apps", "cli", "lib", "bin.js")
  };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "apps", "cli", "package.json"), "utf8"));
  } catch {
    report.reason = `not a DeepSeek Harness checkout (no readable apps/cli/package.json under ${root})`;
    return report;
  }
  if (manifest?.name !== HARNESS_CLI_PACKAGE) {
    report.reason = `apps/cli/package.json names "${manifest?.name}", expected "${HARNESS_CLI_PACKAGE}"`;
    return report;
  }
  report.valid = true;
  report.version = manifest.version ?? null;
  report.installed = fs.existsSync(path.join(root, "node_modules"));
  report.built = fs.existsSync(report.binPath);
  const head = runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
  report.commit = head.status === 0 ? head.stdout.trim() : null;
  return report;
}

/** Whether a node version string satisfies the harness engine range (^22.19 || >=24). */
export function nodeVersionSatisfiesHarness(version) {
  const match = String(version ?? "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major >= 24 || (major === 22 && minor >= 19);
}

/**
 * Pick the node that will run dsh: prefer the node running this bridge
 * (pinned by absolute path), else `node` on PATH (resolved at wrapper
 * runtime). Returns null when neither satisfies the harness floor.
 */
export function selectHarnessNode(env = process.env) {
  if (nodeVersionSatisfiesHarness(process.version)) {
    return { command: process.execPath, version: process.version };
  }
  const probe = runCommand("node", ["--version"], { env });
  const version = probe.status === 0 ? probe.stdout.trim() : null;
  if (version && nodeVersionSatisfiesHarness(version)) {
    return { command: "node", version };
  }
  return null;
}

/**
 * Where `/dsh:setup` keeps the pinned npm CLI: inside the plugin data dir
 * (same fallback root as the config file).
 */
export function resolveNpmInstallDir(env = process.env) {
  return path.join(path.dirname(resolvePluginConfigFile(env)), "npm");
}

/** Built CLI entry inside an npm prefix install of `@deepseek-ai/dsh`. */
export function resolveNpmCliBin(prefix) {
  return path.join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

/**
 * Install `@deepseek-ai/dsh@HARNESS_NPM_VERSION` into `prefix`. Live output
 * on our stderr — bridge stdout stays reserved for the result.
 */
export function installPinnedDshFromNpm(prefix, { actionsTaken = [] } = {}) {
  if (!binaryAvailable("npm", ["--version"]).available) {
    throw new Error(
      `Installing ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION} needs npm on PATH. Install Node (npm ships with it), then rerun /dsh:setup.`
    );
  }
  fs.mkdirSync(prefix, { recursive: true });
  const spec = `${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION}`;
  process.stderr.write(`Installing ${spec} into ${prefix}...\n`);
  const result = spawnSync("npm", ["install", "--prefix", prefix, "--no-fund", "--no-audit", spec], {
    cwd: prefix,
    stdio: ["ignore", 2, 2],
    windowsHide: true
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`npm install ${spec} failed (exit ${result.status}); see the output above.`);
  }
  const binPath = resolveNpmCliBin(prefix);
  if (!fs.existsSync(binPath)) {
    throw new Error(`npm install ${spec} succeeded but ${binPath} is missing.`);
  }
  actionsTaken.push(`Installed ${spec} into ${prefix}.`);
  return binPath;
}

/**
 * Write the persistent wrapper the plugin resolves as its dsh binary: a
 * one-line shim exec'ing the chosen node against the CLI entry. DSH_BINARY-
 * style resolution needs a single executable (no arguments), and bin.js
 * must run under a harness-compatible node regardless of PATH.
 */
export function writeDshWrapper(binPath, nodeCommand, env = process.env) {
  const wrapperPath = path.join(path.dirname(resolvePluginConfigFile(env)), "bin", "dsh");
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${nodeCommand}" "${binPath}" "$@"\n`, { mode: 0o755 });
  return wrapperPath;
}

/** Probe the dsh launcher (`dsh --version`). */
export function getDshAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveDshBinary(options.env ?? process.env);
  const probe = binaryAvailable(binary, ["--version"], { cwd, env: options.env });
  return { ...probe, binary };
}

/**
 * Credential probe. DSH resolves DEEPSEEK_API_KEY from the environment, the
 * managed `$DSH_HOME/.credentials.yaml`, or project/user `.env` files; this
 * probe checks the same places without reading secret values.
 */
export function getDshAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  if (env.DEEPSEEK_API_KEY && String(env.DEEPSEEK_API_KEY).trim()) {
    return { ok: true, detail: "DEEPSEEK_API_KEY present in environment", source: "env" };
  }
  const dshHome = env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const managed = path.join(dshHome, ".credentials.yaml");
  if (fs.existsSync(managed)) {
    return { ok: true, detail: `managed credentials found (${managed})`, source: "credentials-file" };
  }
  for (const envFile of [path.join(cwd ?? process.cwd(), ".env"), path.join(os.homedir(), ".env")]) {
    try {
      if (/^\s*DEEPSEEK_API_KEY\s*=/m.test(fs.readFileSync(envFile, "utf8"))) {
        return { ok: true, detail: `DEEPSEEK_API_KEY found in ${envFile}`, source: ".env" };
      }
    } catch {
      // File absent or unreadable — try the next credential source.
    }
  }
  return {
    ok: false,
    detail: "no DEEPSEEK_API_KEY in env, $DSH_HOME/.credentials.yaml, or .env files",
    source: null
  };
}

/** Validate and normalize a permission mode; null passes through. */
export function normalizePermissionMode(mode) {
  if (mode == null || mode === "") {
    return null;
  }
  const normalized = String(mode).trim();
  if (!VALID_PERMISSION_MODES.has(normalized)) {
    throw new Error(`Unsupported permission mode "${mode}". Use read-only, workspace-write, or danger-full-access.`);
  }
  return normalized;
}

/** Validate and normalize a reasoning effort; null passes through. */
export function normalizeReasoningEffort(effort) {
  if (effort == null || effort === "") {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported reasoning effort "${effort}". Use low, medium, high, or max.`);
  }
  return normalized;
}

/** Validate and normalize an agent mode; null passes through. */
export function normalizeMode(mode) {
  if (mode == null || mode === "") {
    return null;
  }
  const normalized = String(mode).trim().toLowerCase();
  if (!VALID_MODES.has(normalized)) {
    throw new Error(`Unsupported mode "${mode}". Use ${formatSupportedModes()}.`);
  }
  return normalized;
}

/**
 * Resolve the effective agent mode: --mode flag > DSH_CC_MODE env >
 * persisted plugin config (`defaultMode`) > built-in DEFAULT_MODE.
 */
export function resolveMode({ flag = null, env = process.env, config = null } = {}) {
  const fromFlag = normalizeMode(flag);
  if (fromFlag) {
    return fromFlag;
  }
  const fromEnv = normalizeMode(env?.[MODE_ENV]);
  if (fromEnv) {
    return fromEnv;
  }
  // Persisted machine state, not this invocation's input: an unrecognized
  // stored value (a future mode, a hand-edited config) must not brick every
  // command, so it falls back to the built-in default instead of throwing.
  const pluginConfig = config ?? readPluginConfig(env);
  try {
    const fromConfig = normalizeMode(pluginConfig.defaultMode);
    if (fromConfig) {
      return fromConfig;
    }
  } catch {
    // fall through to the built-in default
  }
  return DEFAULT_MODE;
}

/** "minimal, standard, or anchored-standard" for errors and check next-steps. */
export function formatSupportedModes() {
  if (SUPPORTED_MODES.length === 1) {
    return SUPPORTED_MODES[0];
  }
  return `${SUPPORTED_MODES.slice(0, -1).join(", ")}, or ${SUPPORTED_MODES.at(-1)}`;
}

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Absolute path of a sibling module in this lib/ directory. */
export function resolveLibModulePath(filename) {
  return fileURLToPath(new URL(`./${filename}`, import.meta.url));
}

/** Copy the bootstrap plugin (and its snapshot helper) next to a mode overlay. */
export function copyBootstrapModules(overlaysDir) {
  fs.mkdirSync(overlaysDir, { recursive: true });
  for (const filename of BOOTSTRAP_PLUGIN_FILES) {
    fs.copyFileSync(resolveLibModulePath(filename), path.join(overlaysDir, filename));
  }
  return path.join(overlaysDir, "tool-bootstrap.mjs");
}

/**
 * Render the model/effort selection overlay (a dsh `--patch` layer). Row ids
 * match the dsh-base bundle: `agent-default-model` carries the transport-
 * independent default route; `llm-deepseek` carries thinking/effort.
 */
export function buildModelOverlayYaml({ model = null, provider = "deepseek-official", effort = null } = {}) {
  const sections = [];
  if (model) {
    sections.push(
      ["- id: agent-default-model", "  config:", `    provider: ${yamlQuote(provider)}`, `    model: ${yamlQuote(model)}`].join("\n")
    );
  }
  if (effort) {
    sections.push(
      ["- id: llm-deepseek", "  config:", "    thinking: enabled", `    reasoningEffort: ${yamlQuote(effort)}`].join("\n")
    );
  }
  if (sections.length === 0) {
    return null;
  }
  return `# generated by dsh-plugin-cc (per-run model selection)\n${sections.join("\n")}\n`;
}

/**
 * The unattended overlay, generated per permission mode. Two jobs:
 * - approval `never`: nobody is present to answer prompts; the sandbox mode
 *   stays the real safety boundary.
 * - a `permission` row whose single `unattended` preset matches exactly
 *   (mode, never): dsh-base's permission-presets service refuses to boot
 *   when the composed sandbox+approval pair names no preset, and it PINS the
 *   default preset's knobs into fresh sessions — so the preset must mirror
 *   the launch mode or it would override DSH_PERMISSION_MODE.
 */
export function buildUnattendedOverlayYaml(permissionMode) {
  const mode = normalizePermissionMode(permissionMode) ?? "read-only";
  return [
    "# generated by dsh-plugin-cc (unattended composition; see lib/dsh.mjs)",
    "- id: approval",
    "  config:",
    "    policy: never",
    "- id: permission",
    "  config:",
    "    presets:",
    "      unattended:",
    `        sandbox: ${yamlQuote(mode)}`,
    "        approval: never",
    "        name: unattended",
    `        description: ${yamlQuote("dsh-plugin-cc unattended run: sandbox fixed at launch, approvals disabled.")}`,
    "    defaultPreset: unattended",
    ""
  ].join("\n");
}

/** Write the per-mode unattended overlay under `<dir>/overlays`; returns its path. */
export function writeUnattendedOverlay(dir, permissionMode) {
  const mode = normalizePermissionMode(permissionMode) ?? "read-only";
  const overlaysDir = path.join(dir, "overlays");
  fs.mkdirSync(overlaysDir, { recursive: true });
  const file = path.join(overlaysDir, `unattended-${mode}.yml`);
  fs.writeFileSync(file, buildUnattendedOverlayYaml(mode), "utf8");
  return file;
}

/**
 * dsh-base composition rows the minimal mode disables, by row id. Everything
 * model-facing except bash + str_replace_editor: the tool rows themselves,
 * the service rows only those tools consume, and the prompt contributors.
 * Deliberately kept despite the webui minimal preset dropping them: the
 * sandboxed fs stack (DSH_PERMISSION_MODE stays the safety boundary), the
 * one-shot tool-bash (the preset's persistent terminal stack is agent-plane),
 * and compaction (unattended long runs must survive context pressure).
 * Row ids mirror dsh-base's cordis.patch.yml — re-verify on every dsh
 * upgrade (docs/dsh-compat.md).
 */
export const MINIMAL_MODE_DISABLED_ROWS = [
  // model-facing tool rows
  "tool-pwsh",
  "tool-jobs",
  "tool-fs",
  "tool-fs-search",
  "tool-skill",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-report",
  "tool-workflow",
  "tool-todo",
  "tool-goal",
  "tool-ralph",
  "tool-web",
  // service rows only the disabled tools consume
  "skill",
  "skill-filesystem",
  "skill-badge",
  "subagent",
  "subagent-spawn-in-process",
  "subagent-fork-in-process",
  "workflow-worker-thread",
  "web",
  "web-search-deepseek",
  "goal",
  "goal-round-driver",
  "command-goal",
  "plan-mode",
  // prompt contributors
  "agent-instructions",
  "repeat-tool-reminder",
  "user-questions"
];

/** The complete minimal-mode persona (replaces the deployment persona). */
export const MINIMAL_MODE_PERSONA = "You are a helpful software engineer assistant.";

/**
 * Render the mode overlay (a dsh `--patch` layer).
 * - `standard`: untouched dsh-base, returns null.
 * - `minimal`: persona + identity/runtime-context off + disable down to
 *   bash / str_replace_editor (two tools for the whole run).
 * - `anchored-standard`: same persona/identity tightening, no tool-row
 *   disables, insert the bootstrap plugin so request #1 is the Minimal
 *   pair and later requests see the full assembled catalog.
 */
export function buildModeOverlayYaml(mode, { bootstrapModulePath = null } = {}) {
  const normalized = normalizeMode(mode) ?? DEFAULT_MODE;
  if (normalized === "standard") {
    return null;
  }
  if (normalized === ANCHORED_MODE) {
    const modulePath = bootstrapModulePath ?? resolveLibModulePath("tool-bootstrap.mjs");
    return [
      "# generated by dsh-plugin-cc (mode: anchored-standard; see lib/dsh.mjs)",
      "- id: system-prompt",
      "  config:",
      `    persona: ${yamlQuote(MINIMAL_MODE_PERSONA)}`,
      "    includeHarnessIdentity: false",
      "- insert:",
      "    - id: cc-tool-bootstrap",
      `      name: ${yamlQuote(modulePath)}`,
      "      config:",
      "        bootstrapTools: [bash, str_replace_editor]",
      "        promoteOn: either",
      "        suppressedContextSources: [agent-instructions, skill-catalog]",
      `        persona: ${yamlQuote(MINIMAL_MODE_PERSONA)}`,
      ""
    ].join("\n");
  }
  const lines = [
    "# generated by dsh-plugin-cc (mode: minimal; see lib/dsh.mjs)",
    "- id: system-prompt",
    "  config:",
    `    persona: ${yamlQuote(MINIMAL_MODE_PERSONA)}`,
    "    includeHarnessIdentity: false",
    "    includeRuntimeContext: false",
    // tool-bash advertises `run_in_background` by default, pointing the
    // model at job_output/job_kill — tools this mode disables. The `jobs`
    // SERVICE stays composed (other infrastructure may use it), so a
    // background call would actually spawn and return a job id the model
    // can neither read nor kill. Dropping the schema knob is the fix; it
    // also hard-rejects an undeclared run_in_background:true.
    "- id: tool-bash",
    "  config:",
    "    enableRunInBackground: false"
  ];
  for (const id of MINIMAL_MODE_DISABLED_ROWS) {
    lines.push(`- id: ${id}`, "  disabled: true");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write the mode overlay under `<dir>/overlays`; returns its path, or null
 * for standard (no overlay). Anchored-standard also copies the bootstrap
 * plugin next to the yaml so the insert `name` is a self-contained path.
 */
export function writeModeOverlay(dir, mode) {
  const normalized = normalizeMode(mode) ?? DEFAULT_MODE;
  if (normalized === "standard") {
    return null;
  }
  const overlaysDir = path.join(dir, "overlays");
  fs.mkdirSync(overlaysDir, { recursive: true });
  const bootstrapModulePath = normalized === ANCHORED_MODE ? copyBootstrapModules(overlaysDir) : null;
  const yaml = buildModeOverlayYaml(normalized, { bootstrapModulePath });
  const file = path.join(overlaysDir, `mode-${normalized}.yml`);
  fs.writeFileSync(file, yaml, "utf8");
  return file;
}

/** Write the model overlay to a temp file; returns its path or null. */
export function writeModelOverlay(stateDir, selection) {
  const yaml = buildModelOverlayYaml(selection);
  if (!yaml) {
    return null;
  }
  const dir = path.join(stateDir, "overlays");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yml`);
  fs.writeFileSync(file, yaml, "utf8");
  return file;
}

/**
 * Assemble the headless argv: launcher flags first (`--profile`, repeated
 * `--patch`), then `--`, then the task positional.
 */
export function buildHeadlessArgs({ task, patches = [] }) {
  const args = ["--profile", "headless"];
  for (const patch of patches) {
    if (patch) {
      args.push("--patch", patch);
    }
  }
  args.push("--", task);
  return args;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

/**
 * Run one unattended headless task.
 *
 * options:
 * - prompt (required): the task text
 * - permissionMode: read-only (default) | workspace-write | danger-full-access
 * - unattendedOverlay (required path): approval-never patch layer
 * - modelOverlay: optional generated model/effort patch layer
 * - modeOverlay: optional generated mode patch layer (null for standard)
 * - extraPatches: optional user-supplied overlay paths
 * - onProgress: progress reporter
 *
 * Resolves { status, stdout, stderr, finalMessage, agentPid, args, binary }.
 */
export function runHeadlessAgent(cwd, options = {}) {
  const binary = options.binary ?? resolveDshBinary(options.env ?? process.env);
  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required for a DeepSeek Harness run."));
  }
  if (!options.unattendedOverlay) {
    return Promise.reject(new Error("Internal error: the unattended overlay path is required for every bridge run."));
  }

  const permissionMode = normalizePermissionMode(options.permissionMode) ?? "read-only";
  const args = buildHeadlessArgs({
    task: prompt,
    patches: [options.unattendedOverlay, options.modeOverlay, options.modelOverlay, ...(options.extraPatches ?? [])]
  });

  const env = {
    ...(options.env ?? process.env),
    [PERMISSION_MODE_ENV]: permissionMode
  };
  // The headless bundle reads this to flip Code Mode process-wide; mode
  // ownership belongs to --mode, so an inherited value must not leak through.
  delete env[TOOLS_MODE_ENV];

  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      windowsHide: true
    });

    const agentPid = child.pid ?? null;
    emitProgress(options.onProgress, `Running dsh headless (${permissionMode}).`, "starting", {
      agentPid,
      pid: agentPid
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      const status = code ?? (signal ? 1 : 0);
      emitProgress(
        options.onProgress,
        status === 0 ? "dsh finished." : `dsh exited with status ${status}.`,
        status === 0 ? "finalizing" : "failed",
        { agentPid }
      );
      resolve({
        status,
        signal,
        stdout,
        stderr,
        agentPid,
        finalMessage: stdout.trimEnd(),
        args,
        binary
      });
    });
  });
}

/**
 * Parse a structured (JSON) result out of model text: bare JSON first, then
 * a fenced ```json block, then the outermost brace span. Mirrors the Grok
 * plugin's tolerance because DSH has no `--json-schema` output flag.
 */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "dsh did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }
  const text = String(rawOutput).trim();

  try {
    return { ...fallback, parsed: JSON.parse(text), parseError: null, rawOutput: text };
  } catch {
    // Not bare JSON; try the fenced block next.
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return { ...fallback, parsed: JSON.parse(fenced[1].trim()), parseError: null, rawOutput: text };
    } catch (error) {
      return { ...fallback, parsed: null, parseError: error.message, rawOutput: text };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return { ...fallback, parsed: JSON.parse(text.slice(start, end + 1)), parseError: null, rawOutput: text };
    } catch (error) {
      return { ...fallback, parsed: null, parseError: error.message, rawOutput: text };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from dsh output.",
    rawOutput: text
  };
}

/** Read the review output JSON schema. */
export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

/** Render schema instructions to embed in a structured-output prompt. */
export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return ["Return only valid JSON matching this schema:", "```json", JSON.stringify(schema, null, 2), "```"].join("\n");
}

/** Assemble the plain review prompt (structured critique uses prompts/critique.md). */
export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput }) {
  return [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files (your sandbox is read-only).",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)"
  ].join("\n");
}

/**
 * Check that a dsh profile composes and (optionally) contains a plugin row.
 * Uses `--dump-config`, which composes all layers without booting.
 */
export function probeProfile(profileName, { mustContain = null, cwd = process.cwd(), env = process.env, binary = null } = {}) {
  const bin = binary ?? resolveDshBinary(env);
  const result = runCommand(bin, ["--profile", profileName, "--dump-config"], { cwd, env });
  if (result.status !== 0) {
    return {
      ready: false,
      detail: `dsh --profile ${profileName} --dump-config failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`
    };
  }
  if (mustContain && !result.stdout.includes(mustContain)) {
    return { ready: false, detail: `profile ${profileName} composes but is missing ${mustContain}` };
  }
  return { ready: true, detail: `profile ${profileName} composes${mustContain ? ` and includes ${mustContain}` : ""}` };
}
