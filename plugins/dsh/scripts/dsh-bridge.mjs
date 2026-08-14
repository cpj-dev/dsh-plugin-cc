#!/usr/bin/env node
/**
 * The DeepSeek Harness ↔ Claude Code bridge. Slash commands call this script
 * with one subcommand; stdout is returned to the user verbatim.
 *
 * Drive paths:
 * - One-shot (review / critique / fresh run / import bootstrap):
 *   `dsh --profile headless` behind the unattended overlay, sandbox mode via
 *   DSH_PERMISSION_MODE. Crash-isolated; every invocation is a new session.
 * - Multi-turn (run --session / --resume): the per-workspace broker
 *   (dsh-broker.mjs) holding one live `dsh --profile cc` SDK runtime —
 *   the only place DSH sessions can be continued.
 *
 * Job state lives under $CLAUDE_PLUGIN_DATA (see lib/state.mjs). Background
 * execution re-enters this script as a detached `run-worker`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildReviewPrompt,
  DEFAULT_CONTINUE_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  describeDshBinary,
  getDshAuthStatus,
  getDshAvailability,
  HARNESS_CLI_PACKAGE,
  HARNESS_NODE_FLOOR,
  HARNESS_NPM_VERSION,
  HARNESS_SDK_JSONRPC_PACKAGE,
  inspectHarnessCheckout,
  installPinnedDshFromNpm,
  normalizePermissionMode,
  normalizeReasoningEffort,
  parseStructuredOutput,
  pinnedSdkServerInstallSpecs,
  probeProfile,
  readPluginConfig,
  resolveDshBinary,
  resolveNpmCliBin,
  resolveNpmInstallDir,
  runHeadlessAgent,
  schemaInstructionsFromPath,
  selectHarnessNode,
  writeDshWrapper,
  writeModelOverlay,
  writePluginConfig,
  writeUnattendedOverlay
} from "./lib/dsh.mjs";
import {
  BROKER_STALE_SESSION_RPC_CODE,
  brokerRequest,
  DEFAULT_BROKER_RUN_TIMEOUT_MS,
  ensureBroker,
  getBrokerStatus,
  mintBrokerSessionId,
  resolveBrokerPaths,
  stopBroker
} from "./lib/broker-client.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForSession,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { compressTranscript, resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import {
  claimJobTerminal,
  generateJobId,
  listJobs,
  patchJobIfActive,
  readStoredJob,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  resolveJobKillTargets,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveJobKindLabel } from "./lib/job-control.mjs";
import {
  renderCancelReport,
  renderCheckReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderStatusReport,
  renderStopRefusedReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const JSONRPC_PLUGIN = HARNESS_SDK_JSONRPC_PACKAGE;
const MANAGED_MARKER = "# managed by dsh-plugin-cc";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/dsh-bridge.mjs check [--json]",
      "  node scripts/dsh-bridge.mjs setup [--harness <checkout-dir>] [--json]",
      "  node scripts/dsh-bridge.mjs review   [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--effort <e>]",
      "  node scripts/dsh-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--effort <e>] [focus text]",
      "  node scripts/dsh-bridge.mjs run [--background] [--write] [--session|--resume|--resume-last|--fresh] [--model <m>] [--effort <e>] [prompt]",
      "  node scripts/dsh-bridge.mjs run-resume-candidate [--json]",
      "  node scripts/dsh-bridge.mjs import [--source <jsonl>] [--json]",
      "  node scripts/dsh-bridge.mjs runs [run-id] [--all] [--json]",
      "  node scripts/dsh-bridge.mjs show [run-id] [--json]",
      "  node scripts/dsh-bridge.mjs stop [run-id] [--broker] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", m: "model", ...(config.aliasMap ?? {}) }
  });
  for (const token of parsed.unknown ?? []) {
    process.stderr.write(`Warning: ignoring unknown option ${token}\n`);
  }
  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function ensureDshAvailable(cwd) {
  const availability = getDshAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      `The dsh CLI is not available. Run /dsh:setup — it installs ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION} from npm and creates the cc profile (or pass --harness <built-checkout>, or set DSH_BINARY). Then rerun /dsh:check.`
    );
  }
  return availability;
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function ccProfileDir() {
  return path.join(dshHomeDir(), "profiles", "cc");
}

// ─── check / setup ───────────────────────────────────────────────────────────

async function buildCheckReport(cwd, actionsTaken = []) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const binaryInfo = describeDshBinary();
  const dshStatus = { ...getDshAvailability(cwd), source: binaryInfo.source, staleConfig: binaryInfo.staleConfig };
  const DSH_SOURCE_LABEL = {
    path: "PATH",
    env: "DSH_BINARY",
    "npm-pin": "npm pin",
    harness: "configured source checkout",
    config: "configured binary"
  };
  if (dshStatus.available) {
    dshStatus.detail = `${dshStatus.detail} (via ${DSH_SOURCE_LABEL[binaryInfo.source] ?? binaryInfo.source})`;
  }
  const authStatus = dshStatus.available ? getDshAuthStatus(cwd) : { ok: false, detail: "dsh unavailable; skipped" };
  let profileStatus = dshStatus.available
    ? probeProfile("cc", { mustContain: JSONRPC_PLUGIN, cwd })
    : { ready: false, detail: "dsh unavailable; skipped" };
  const brokerStatus = await getBrokerStatus(resolveWorkspaceRoot(cwd));

  // Optional install-health rows. Absence is fine when dsh comes from PATH
  // or DSH_BINARY; npm prefix / checkout only appear when setup persisted them.
  const pluginConfig = readPluginConfig();
  const configuredCheckout = pluginConfig.harnessCheckout ?? null;
  let harness = null;
  if (configuredCheckout) {
    const inspection = inspectHarnessCheckout(configuredCheckout);
    harness = {
      ok: inspection.valid && inspection.installed && inspection.built,
      root: inspection.root,
      detail: inspection.valid
        ? `${inspection.root} (${inspection.version ?? "unknown version"}${inspection.commit ? ` @ ${inspection.commit}` : ""}; ${inspection.installed ? "installed" : "NOT installed"}, ${inspection.built ? "built" : "NOT built"})`
        : inspection.reason
    };
  }
  const npm = describeNpmInstall(pluginConfig);
  const managedNpmStale = binaryInfo.source === "npm-pin" && Boolean(npm) && !npm.ok;
  const expectedProfileIdentity = expectedSdkProfileIdentity(pluginConfig, binaryInfo.source);
  const actualProfileIdentity = pluginConfig.sdkProfileVersion ?? null;
  if (dshStatus.available && profileStatus.ready && actualProfileIdentity !== expectedProfileIdentity) {
    profileStatus = {
      ready: false,
      detail: `cc profile plugins are ${actualProfileIdentity ?? "unpinned"} (want ${expectedProfileIdentity})`
    };
  }
  const harnessNode = selectHarnessNode();

  const nextSteps = [];
  if (!dshStatus.available) {
    nextSteps.push(
      `Run /dsh:setup — it installs ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION} from npm and creates the multi-turn cc profile (needs npm, pnpm, Node >= ${HARNESS_NODE_FLOOR}). Already have a built checkout? /dsh:setup --harness <path>. Or set DSH_BINARY to an already-built dsh.`
    );
  }
  if (binaryInfo.staleConfig) {
    nextSteps.push(
      `The configured dsh (${binaryInfo.staleConfig}) no longer exists — the install was moved or cleaned. Rerun /dsh:setup.`
    );
  }
  if (npm && !npm.ok) {
    nextSteps.push(
      npm.version && npm.version !== HARNESS_NPM_VERSION
        ? `The configured npm pin is ${npm.version} (plugin pin is ${HARNESS_NPM_VERSION}). Rerun /dsh:setup.`
        : `The configured npm install is not runnable (${npm.detail}). Rerun /dsh:setup.`
    );
  }
  if (harness && !harness.ok) {
    nextSteps.push(
      `The configured harness checkout is not runnable (${harness.detail}). Build it with \`pnpm install && pnpm run build:lib\`, then rerun /dsh:setup --harness ${harness.root}.`
    );
  }
  if (!harnessNode) {
    nextSteps.push(
      `Running the harness needs Node >= ${HARNESS_NODE_FLOOR} (or >= 24); this environment has ${process.version} and no suitable \`node\` on PATH.`
    );
  }
  if (dshStatus.available && !authStatus.ok) {
    nextSteps.push("Provide DEEPSEEK_API_KEY (env, $DSH_HOME/.credentials.yaml, or .env).");
  }
  if (dshStatus.available && !profileStatus.ready) {
    nextSteps.push(
      actualProfileIdentity !== expectedProfileIdentity
        ? `Rerun /dsh:setup to refresh the cc profile plugins (${profileStatus.detail}).`
        : "Run /dsh:setup to create the multi-turn `cc` profile (one-shot review/delegate works without it)."
    );
  }

  return {
    // A managed npm install off the verified pin makes the one-shot path
    // unsupported, not merely outdated: it is the CLI those commands run,
    // and DSH promises no compatibility between preview versions. The same
    // row describing an install the user overrode (DSH_BINARY / PATH) says
    // nothing about what will run, so readiness keys on the resolved source.
    ready: nodeStatus.available && dshStatus.available && authStatus.ok && !managedNpmStale,
    multiTurnReady: profileStatus.ready,
    node: nodeStatus,
    dsh: dshStatus,
    auth: authStatus,
    profile: profileStatus,
    harness,
    npm,
    broker: { detail: brokerStatus ? `running (pid ${brokerStatus.pid}, model ${brokerStatus.model})` : "not running (starts on demand)" },
    actionsTaken,
    nextSteps
  };
}

async function handleCheck(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const report = await buildCheckReport(cwd);
  outputCommandResult(report, renderCheckReport(report), options.json);
}

const CC_PROFILE_PATCH = `${MANAGED_MARKER}
# The cc profile serves the DSH SDK wire protocol on stdio for the
# dsh-plugin-cc broker. stdout must stay JSON-RPC-only; do not add a stdout
# logger here. Approval is 'never' because broker runs are unattended; the
# sandbox mode still comes from DSH_PERMISSION_MODE at runtime spawn.
- id: hmr
  disabled: true
- id: approval
  config:
    policy: never
- insert:
    - id: cc-sdk-jsonrpc
      name: '${JSONRPC_PLUGIN}'
`;

/**
 * Link a user-built DeepSeek Harness checkout as this machine's dsh.
 * The plugin does not install or compile the checkout.
 */
function linkBuiltHarnessCheckout(checkoutRoot, { actionsTaken, harnessNode }) {
  const inspection = inspectHarnessCheckout(checkoutRoot);
  if (!inspection.valid) {
    throw new Error(`--harness rejected: ${inspection.reason}`);
  }
  if (!inspection.installed || !inspection.built) {
    const missing = [
      inspection.installed ? null : "not installed (`pnpm install`)",
      inspection.built ? null : `not built (${inspection.binPath} missing; \`pnpm run build:lib\`)`
    ]
      .filter(Boolean)
      .join(" and ");
    throw new Error(
      `The checkout at ${inspection.root} is ${missing}. Run \`pnpm install && pnpm run build:lib\` there yourself, then rerun /dsh:setup --harness.`
    );
  }
  resolveSdkServerDir(inspection.root);
  const wrapper = writeDshWrapper(inspection.binPath, harnessNode.command);
  writePluginConfig({
    dshBinary: wrapper,
    dshInstall: "harness",
    harnessCheckout: inspection.root,
    npmPrefix: null,
    npmVersion: null
    // Do not clear sdkProfileVersion here: a same-checkout rerun must stay
    // idempotent. npm→harness and checkout A→B are detected by comparing
    // the stored identity (`npm:<pin>` / `harness:<realpath>`) with the
    // identity this run will write after a successful plugin add.
  });
  actionsTaken.push(
    `Linked dsh to the source checkout at ${inspection.root} (${inspection.version ?? "unknown version"}${inspection.commit ? ` @ ${inspection.commit}` : ""}; wrapper at ${wrapper}, node ${harnessNode.version}).`
  );
  return inspection;
}

/** Resolve the SDK server package dir from a harness checkout. */
function resolveSdkServerDir(checkoutRoot) {
  const dir = path.join(checkoutRoot, "packages", "sdk", "server");
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    throw new Error(`No SDK server package at ${dir}; is ${checkoutRoot} a complete DeepSeek Harness checkout?`);
  }
  return dir;
}

function npmSdkProfileIdentity() {
  return `npm:${HARNESS_NPM_VERSION}`;
}

function harnessSdkProfileIdentity(checkoutRoot) {
  const resolved = path.resolve(String(checkoutRoot));
  try {
    return `harness:${fs.realpathSync(resolved)}`;
  } catch {
    return `harness:${resolved}`;
  }
}

/** Identity written to sdkProfileVersion after a successful plugin add. */
function sdkProfileIdentityForSetup(checkoutRoot) {
  return checkoutRoot ? harnessSdkProfileIdentity(checkoutRoot) : npmSdkProfileIdentity();
}

/**
 * Identity check expects, mirroring which SDK source handleSetup would pick
 * now. The checkout counts only while it is the dsh actually in use:
 * DSH_BINARY (or a vanished wrapper) sends setup down the registry-spec path
 * whatever the config still records, so keying on `dshInstall` alone would
 * demand a `harness:` identity that no rerun can ever produce.
 */
function expectedSdkProfileIdentity(config, binarySource) {
  if (binarySource === "harness" && config.harnessCheckout) {
    return harnessSdkProfileIdentity(config.harnessCheckout);
  }
  return npmSdkProfileIdentity();
}

/**
 * Health of the persisted npm CLI install, or null when setup never wrote
 * one. `ok` is the single definition of "the pinned CLI is in place": check
 * reports it and handleSetup repairs on it, so a damaged install cannot look
 * healthy to one and broken to the other. The two halves are separate
 * because they need different repairs — `cliOk` (the pinned package) takes a
 * reinstall, `wrapperOk` (the shim dsh resolution goes through) only takes a
 * rewrite.
 */
function describeNpmInstall(config) {
  if (config.dshInstall !== "npm") {
    return null;
  }
  const prefix = config.npmPrefix ?? null;
  const version = config.npmVersion ?? null;
  const binPath = prefix ? resolveNpmCliBin(prefix) : null;
  const binOk = Boolean(binPath) && fs.existsSync(binPath);
  const cliOk = binOk && version === HARNESS_NPM_VERSION;
  const wrapper = config.dshBinary ?? null;
  const wrapperOk = Boolean(wrapper) && fs.existsSync(wrapper);
  let detail = `${prefix} (${HARNESS_CLI_PACKAGE}@${version})`;
  if (!prefix) {
    detail = `${HARNESS_CLI_PACKAGE} is recorded as an npm install with no prefix`;
  } else if (!binOk) {
    detail = `${prefix} is missing ${binPath}`;
  } else if (!cliOk) {
    detail = `${prefix} (${HARNESS_CLI_PACKAGE}@${version ?? "unknown"}; plugin pin is ${HARNESS_NPM_VERSION})`;
  } else if (!wrapperOk) {
    detail = `${prefix} (${HARNESS_CLI_PACKAGE}@${version}); the managed wrapper ${wrapper ?? "(unset)"} is missing`;
  }
  return { ok: cliOk && wrapperOk, cliOk, wrapperOk, prefix, version, detail };
}

/** True when persisted config is a source checkout, including pre-npm-pin installs. */
function isLegacySourceInstall(config) {
  return config.dshInstall !== "npm" && (config.dshInstall === "harness" || Boolean(config.harnessCheckout));
}

function requireHarnessNode() {
  const harnessNode = selectHarnessNode();
  if (!harnessNode) {
    throw new Error(
      `Running DeepSeek Harness needs Node >= ${HARNESS_NODE_FLOOR} (or >= 24); this environment has ${process.version} and no suitable \`node\` on PATH. Install a newer Node, then rerun /dsh:setup.`
    );
  }
  return harnessNode;
}

function persistNpmCli(prefix, binPath, harnessNode, actionsTaken) {
  const wrapper = writeDshWrapper(binPath, harnessNode.command);
  writePluginConfig({
    dshBinary: wrapper,
    dshInstall: "npm",
    npmPrefix: prefix,
    npmVersion: HARNESS_NPM_VERSION,
    harnessCheckout: null,
    // Cleared until plugin add succeeds — a CLI pin refresh must re-add
    // even when the stored identity already names the current pin, and a
    // failed add must retry even if dump-config already names the package.
    sdkProfileVersion: null
  });
  actionsTaken.push(
    `Linked dsh to the npm install at ${prefix} (${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION}; wrapper at ${wrapper}, node ${harnessNode.version}).`
  );
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "harness"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const actionsTaken = [];

  let checkoutRoot = null;
  const envBinary = String(process.env.DSH_BINARY ?? "").trim();
  if (options.harness) {
    const inspection = linkBuiltHarnessCheckout(path.resolve(cwd, options.harness), {
      actionsTaken,
      harnessNode: requireHarnessNode()
    });
    checkoutRoot = inspection.root;
  } else if (envBinary) {
    // External binary: skip the CLI install. Profile repair uses registry
    // specs — do not persist dshInstall: npm, and do not treat a leftover
    // harnessCheckout as the SDK-server source.
    checkoutRoot = null;
  } else {
    const config = readPluginConfig();
    const dshAvailable = getDshAvailability(cwd).available;
    // A stale pin or a prefix that lost its bin.js both need the reinstall
    // even while some other dsh answers on PATH. Pre-npm configs only stored
    // dshBinary + harnessCheckout; a still-runnable wrapper must not keep the
    // machine on the old source install, and only an explicit --harness this
    // run retains a checkout.
    const npmInstall = describeNpmInstall(config);
    if (npmInstall?.cliOk && !npmInstall.wrapperOk) {
      // Only the shim is gone. Rewriting it converges without a reinstall —
      // and without a network — while the pinned package stays untouched, so
      // the cc profile keeps its identity and needs no re-add.
      const wrapper = writeDshWrapper(resolveNpmCliBin(npmInstall.prefix), requireHarnessNode().command);
      writePluginConfig({ dshBinary: wrapper });
      actionsTaken.push(`Rewrote the managed dsh wrapper at ${wrapper} (${HARNESS_CLI_PACKAGE}@${npmInstall.version} was intact).`);
    } else if (!dshAvailable || (npmInstall && !npmInstall.ok) || isLegacySourceInstall(config)) {
      const harnessNode = requireHarnessNode();
      const prefix = resolveNpmInstallDir();
      const binPath = installPinnedDshFromNpm(prefix, { actionsTaken });
      persistNpmCli(prefix, binPath, harnessNode, actionsTaken);
    }
  }

  ensureDshAvailable(cwd);
  const binary = resolveDshBinary();

  // 1. Ensure the cc profile exists with the jsonrpc server installed.
  //    `dsh plugin --profile cc add <spec>` initializes a missing profile
  //    (dsh-base alone for non-shipped names) and forwards to pnpm.
  //    `--harness` link:-installs the checkout's SDK server (missing
  //    packages/sdk/server is an error, not a silent registry fallback).
  //    The default path adds the pinned npm package plus its published
  //    peerDependencies. sdkProfileVersion is a full identity
  //    (`npm:<pin>` or `harness:<realpath>`) written only after add
  //    succeeds, so pin bumps, npm↔harness switches, checkout A→B, and
  //    failed adds are retried even when dump-config already names the package.
  const probeBefore = probeProfile("cc", { mustContain: JSONRPC_PLUGIN, cwd });
  const expectedIdentity = sdkProfileIdentityForSetup(checkoutRoot);
  const profileIdentityStale = readPluginConfig().sdkProfileVersion !== expectedIdentity;
  if (!probeBefore.ready || profileIdentityStale) {
    const specs = checkoutRoot ? [resolveSdkServerDir(checkoutRoot)] : pinnedSdkServerInstallSpecs();
    const pnpmStatus = binaryAvailable("pnpm", ["--version"], { cwd });
    if (!pnpmStatus.available) {
      throw new Error("Profile setup needs pnpm on PATH (dsh plugin forwards to pnpm). Install pnpm (`corepack enable`) and rerun /dsh:setup.");
    }
    const { runCommand } = await import("./lib/process.mjs");
    const install = runCommand(binary, ["plugin", "--profile", "cc", "add", ...specs], { cwd });
    if (install.status !== 0) {
      throw new Error(`dsh plugin --profile cc add ${specs.join(" ")} failed:\n${(install.stderr || install.stdout).trim().slice(0, 800)}`);
    }
    writePluginConfig({ sdkProfileVersion: expectedIdentity });
    actionsTaken.push(
      probeBefore.ready
        ? `Refreshed ${JSONRPC_PLUGIN} in the cc profile from ${specs.join(" ")}.`
        : `Installed ${JSONRPC_PLUGIN} into the cc profile from ${specs.join(" ")}.`
    );
  }

  // 2. Write the managed patch block (idempotent via marker).
  const patchFile = path.join(ccProfileDir(), "cordis.patch.yml");
  const existing = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";
  if (!existing.includes(MANAGED_MARKER)) {
    // dsh initializes the user patch layer as header comments + an empty
    // flow array (`[]`); a block sequence appended after that bare `[]` is
    // invalid YAML, so drop the empty-array line (comments survive fine).
    const base = existing.replace(/^\[\][ \t]*$/m, "").trimEnd();
    const next = base.trim() ? `${base}\n\n${CC_PROFILE_PATCH}` : CC_PROFILE_PATCH;
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, next, "utf8");
    actionsTaken.push(`Wrote the managed patch block to ${patchFile}.`);
  }

  // 3. Verify the composition without booting it.
  const probeAfter = probeProfile("cc", { mustContain: JSONRPC_PLUGIN, cwd });
  if (!probeAfter.ready) {
    throw new Error(`cc profile still not ready after setup: ${probeAfter.detail}`);
  }

  const report = await buildCheckReport(cwd, actionsTaken);
  outputCommandResult(report, renderCheckReport(report), options.json);
}

// ─── review / critique ───────────────────────────────────────────────────────

function buildCritiquePrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "critique");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Critique",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

async function executeReviewRun(request) {
  ensureDshAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);
  if (context.empty) {
    // A genuinely empty diff (bad refs already threw in collection): don't
    // waste a model run reviewing a placeholder string.
    throw new Error(`Nothing to review: ${target.label} has no changes.`);
  }

  let prompt;
  let structured = false;
  if (reviewName === "Critique") {
    prompt = buildCritiquePrompt(context, focusText);
    const schemaHint = schemaInstructionsFromPath(REVIEW_SCHEMA);
    if (schemaHint) {
      prompt = `${prompt}\n\n${schemaHint}`;
    }
    structured = true;
  } else {
    prompt = buildReviewPrompt({
      targetLabel: context.target.label,
      focusText,
      collectionGuidance: context.collectionGuidance,
      reviewInput: context.content
    });
  }

  const modelOverlay = writeModelOverlay(resolveStateDir(request.cwd), {
    model: request.model ?? DEFAULT_MODEL,
    effort: request.effort ?? DEFAULT_REASONING_EFFORT
  });

  // Reviews are always read-only + unattended: the sandbox is the safety
  // boundary; approval 'never' just prevents fail-closed hangs (same
  // reasoning as Grok's alwaysApprove-within-read-only).
  const result = await runHeadlessAgent(context.repoRoot, {
    prompt,
    permissionMode: "read-only",
    unattendedOverlay: writeUnattendedOverlay(resolveStateDir(request.cwd), "read-only"),
    modelOverlay,
    onProgress: request.onProgress
  });

  if (structured) {
    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage: result.stderr
    });
    const payload = {
      review: reviewName,
      target,
      context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary },
      dsh: { status: result.status, stderr: result.stderr, stdout: result.finalMessage },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    };
    return {
      exitStatus: result.status,
      payload,
      rendered: renderReviewResult(parsed, { reviewLabel: reviewName, targetLabel: context.target.label }),
      summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
      jobTitle: `DSH ${reviewName}`,
      jobClass: "review"
    };
  }

  const payload = {
    review: reviewName,
    target,
    dsh: { status: result.status, stderr: result.stderr, stdout: result.finalMessage }
  };
  return {
    exitStatus: result.status,
    payload,
    rendered: renderNativeReviewResult(
      { status: result.status, stdout: result.finalMessage, stderr: result.stderr },
      { reviewLabel: reviewName, targetLabel: target.label }
    ),
    summary: firstMeaningfulLine(result.finalMessage, `${reviewName} completed.`),
    jobTitle: `DSH ${reviewName}`,
    jobClass: "review"
  };
}

// ─── run (delegate) ──────────────────────────────────────────────────────────

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  return filterJobsForSession(jobs, { sessionId: getCurrentClaudeSessionId() });
}

function findLatestResumableTaskJob(jobs) {
  // Only completed runs with a recorded runtime generation are candidates:
  // session ids are recorded at job creation, so a failed or cancelled run
  // may carry an id the broker never finished a turn with, and a session
  // without its generation cannot be proven to still exist anywhere.
  return (
    jobs.find(
      (job) => job.jobClass === "task" && job.dshSessionId && job.dshSessionGeneration && job.status === "completed"
    ) ?? null
  );
}

async function resolveLatestDshSession(workspaceRoot, { excludeJobId = null } = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== excludeJobId);
  const visible = filterJobsForCurrentClaudeSession(jobs);
  const active = visible.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (active) {
    throw new Error(`Delegate run ${active.id} is still running. Use /dsh:runs before continuing it.`);
  }
  const resumable = findLatestResumableTaskJob(visible);
  return resumable ? { sessionId: resumable.dshSessionId, generation: resumable.dshSessionGeneration } : null;
}

/**
 * A dsh session exists only inside the runtime process that created it.
 * Refuse a resume unless a live broker's runtime generation matches the one
 * recorded with the session — anything else would silently mint a fresh
 * session and report it as a successful resume.
 */
async function assertResumableBrokerSession(workspaceRoot, { sessionId, generation }) {
  const status = await getBrokerStatus(workspaceRoot);
  if (!status) {
    throw new Error(
      `Cannot resume dsh session ${sessionId}: no live broker holds it (sessions are in-memory only and did not survive the broker exit). Start fresh with /dsh:run --session <task>.`
    );
  }
  if (!status.generation || status.generation !== generation) {
    throw new Error(
      `Cannot resume dsh session ${sessionId}: the DSH runtime restarted since that session was recorded, so its context is gone. Start fresh with /dsh:run --session <task>.`
    );
  }
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureDshAvailable(request.cwd);

  const write = Boolean(request.write);
  const permissionMode = write ? "workspace-write" : "read-only";

  // Broker path: --session (fresh resumable) or --resume (continue).
  if (request.useBroker) {
    const resuming = Boolean(request.resumeSessionId);
    // The session id is normally minted by the command handler and stored on
    // the job record before this runs; minting here is the fallback for
    // queued job files written by older plugin versions.
    let sessionId = request.sessionId ?? request.resumeSessionId ?? mintBrokerSessionId();
    const prompt = String(request.prompt ?? "").trim() || (resuming ? DEFAULT_CONTINUE_PROMPT : "");
    if (!prompt) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume.");
    }
    let socketPath;
    if (resuming) {
      // Re-validate at execution time (a background worker may start long
      // after the enqueue check), and never ensureBroker on a resume — a
      // freshly spawned broker cannot hold the session by definition.
      await assertResumableBrokerSession(workspaceRoot, {
        sessionId,
        generation: request.resumeGeneration ?? null
      });
      socketPath = resolveBrokerPaths(workspaceRoot).socketPath;
    } else {
      request.onProgress?.({ message: "Ensuring the DSH broker is up.", phase: "starting" });
      // Broker permission mode applies at runtime spawn; a live broker keeps
      // the mode it started with (documented limitation).
      socketPath = await ensureBroker(workspaceRoot, { permissionMode: write ? "workspace-write" : "read-only" });
    }
    // Patch the session id onto the job record BEFORE the turn starts, so a
    // concurrent `stop` can see this is a broker-backed run in flight.
    request.onProgress?.({
      message: resuming ? `Continuing dsh session ${sessionId}.` : `Starting dsh session ${sessionId}.`,
      phase: "running",
      dshSessionId: sessionId
    });
    // Forward the turn timeout to the broker (which frees itself on expiry)
    // and give the client socket a grace margin on top, so the broker's own
    // timeout error - the one that clears its busy state - always arrives
    // before the client disconnects.
    const runTimeoutMs = request.timeoutMs ?? DEFAULT_BROKER_RUN_TIMEOUT_MS;
    let result;
    try {
      result = await brokerRequest(
        socketPath,
        "run",
        {
          sessionId,
          prompt,
          timeoutMs: runTimeoutMs,
          ...(resuming ? { expectedGeneration: request.resumeGeneration ?? null } : {})
        },
        { timeoutMs: runTimeoutMs + 30_000 }
      );
    } catch (error) {
      if (error?.rpcCode === BROKER_STALE_SESSION_RPC_CODE) {
        throw new Error(
          `Cannot resume dsh session ${sessionId}: the DSH runtime restarted since that session was recorded, so its context is gone. Start fresh with /dsh:run --session <task>.`
        );
      }
      throw error;
    }
    sessionId = result.sessionId;
    request.onProgress?.({ message: `dsh session ${sessionId} idle.`, phase: "finalizing", dshSessionId: sessionId });

    // The broker keeps the permission mode it started with (documented
    // limitation) — report THAT, not this request's flag: a resume without
    // --write still writes when the broker was started workspace-write.
    const brokerMode = (await getBrokerStatus(workspaceRoot))?.permissionMode ?? (write ? "workspace-write" : "read-only");
    const effectiveWrite = brokerMode !== "read-only";
    const rendered = renderTaskResult(
      { rawOutput: result.finalResponse ?? "", failureMessage: "" },
      { title: request.title, jobId: request.jobId ?? null, write: effectiveWrite, dshSessionId: sessionId }
    );
    return {
      exitStatus: 0,
      dshSessionId: sessionId,
      dshSessionGeneration: result.generation ?? null,
      payload: { status: 0, dshSessionId: sessionId, permissionMode: brokerMode, rawOutput: result.finalResponse ?? "" },
      rendered,
      summary: firstMeaningfulLine(result.finalResponse, `${request.title} finished.`),
      jobTitle: request.title,
      jobClass: "task",
      write: effectiveWrite
    };
  }

  // One-shot headless path.
  const prompt = String(request.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume.");
  }
  const modelOverlay = writeModelOverlay(resolveStateDir(workspaceRoot), {
    model: request.model ?? DEFAULT_MODEL,
    effort: request.effort ?? DEFAULT_REASONING_EFFORT
  });
  const result = await runHeadlessAgent(workspaceRoot, {
    prompt,
    permissionMode,
    unattendedOverlay: writeUnattendedOverlay(resolveStateDir(workspaceRoot), permissionMode),
    modelOverlay,
    onProgress: request.onProgress
  });

  const rawOutput = result.finalMessage ?? "";
  const failureMessage = result.status === 0 ? "" : result.stderr || "dsh exited nonzero";
  return {
    exitStatus: result.status,
    payload: { status: result.status, rawOutput, stderr: result.stderr },
    rendered: renderTaskResult({ rawOutput, failureMessage }, { title: request.title, jobId: request.jobId ?? null, write }),
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${request.title} finished.`)),
    jobTitle: request.title,
    jobClass: "task",
    write
  };
}

// ─── job plumbing (foreground / background) ──────────────────────────────────

function createBridgeJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, broker = false, dshSessionId = null }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: resolveJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    broker,
    dshSessionId
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, { stderr: !options.json });
  const execution = await runTrackedJob({ ...job, logFile }, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedRunWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "dsh-bridge.mjs");
  const child = spawn(process.execPath, [scriptPath, "run-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundJob(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queued = { ...job, status: "queued", phase: "queued", pid: null, agentPid: null, bridgePid: null, logFile, request };
  writeJobFile(job.workspaceRoot, job.id, queued);
  upsertJob(job.workspaceRoot, queued);

  const child = spawnDetachedRunWorker(cwd, job.id);
  const workerPid = child?.pid ?? null;
  if (workerPid != null) {
    patchJobIfActive(job.workspaceRoot, job.id, { status: "queued", pid: workerPid, bridgePid: workerPid, logFile });
  }
  return {
    payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile, bridgePid: workerPid },
    rendered: `${job.title} started in the background as ${job.id}. Check /dsh:runs ${job.id} for progress.\n`
  };
}

// ─── subcommand handlers ─────────────────────────────────────────────────────

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = options.model ? String(options.model).trim() : null;
  const effort = normalizeReasoningEffort(options.effort);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });

  const kind = config.reviewName === "Critique" ? "critique" : "review";
  const job = createBridgeJob({
    prefix: kind,
    kind,
    title: `DSH ${config.reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${config.reviewName} ${target.label}`
  });
  const request = {
    kind: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    effort,
    focusText,
    reviewName: config.reviewName
  };

  if (options.background && !options.wait) {
    ensureDshAvailable(cwd);
    const { payload, rendered } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, rendered, options.json);
    return;
  }
  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), { json: options.json });
}

async function handleRun(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "timeout-ms"],
    booleanOptions: ["json", "write", "session", "resume", "resume-last", "fresh", "background"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = options.model ? String(options.model).trim() : null;
  const effort = normalizeReasoningEffort(options.effort);

  let prompt = "";
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  } else {
    prompt = positionals.join(" ") || readStdinIfPiped();
  }

  const resume = Boolean(options.resume || options["resume-last"]);
  const fresh = Boolean(options.fresh);
  const session = Boolean(options.session);
  if (resume && fresh) {
    throw new Error("Choose either --resume or --fresh.");
  }
  let timeoutMs;
  if (options["timeout-ms"] !== undefined) {
    const parsed = Number(options["timeout-ms"]);
    // NaN slips through `??` defaults and becomes setTimeout(NaN) = fire now.
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --timeout-ms "${options["timeout-ms"]}". Pass a positive number of milliseconds.`);
    }
    timeoutMs = parsed;
  }
  if (resume && model) {
    process.stderr.write("Warning: --model is ignored on --resume; the broker keeps its startup model.\n");
  }

  let resumeSessionId = null;
  let resumeGeneration = null;
  if (resume) {
    const candidate = await resolveLatestDshSession(workspaceRoot);
    if (!candidate) {
      throw new Error("No previous DSH session found for this repository. Start one with /dsh:run --session <task>.");
    }
    resumeSessionId = candidate.sessionId;
    resumeGeneration = candidate.generation;
    // Fail fast (before any job is created or enqueued) when the recorded
    // session cannot exist anymore; the worker re-validates at execution.
    await assertResumableBrokerSession(workspaceRoot, candidate);
  }
  const useBroker = resume || session;
  if (!prompt.trim() && !resume) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume.");
  }

  // Broker session ids are minted up front and stored on the job record so
  // `stop` can identify a broker-backed run while its turn is in flight.
  const brokerSessionId = resume ? resumeSessionId : useBroker ? mintBrokerSessionId() : null;
  const title = resume ? "DSH Resume" : session ? "DSH Session Run" : "DSH Delegate";
  const job = createBridgeJob({
    prefix: "run",
    kind: "task",
    title,
    workspaceRoot,
    jobClass: "task",
    summary: shorten(prompt || DEFAULT_CONTINUE_PROMPT),
    write: Boolean(options.write),
    broker: useBroker,
    dshSessionId: brokerSessionId
  });
  const request = {
    kind: "task",
    cwd,
    model,
    effort,
    prompt,
    write: Boolean(options.write),
    useBroker,
    sessionId: brokerSessionId,
    resumeSessionId,
    resumeGeneration,
    title,
    jobId: job.id,
    timeoutMs
  };

  if (options.background) {
    ensureDshAvailable(cwd);
    const { payload, rendered } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, rendered, options.json);
    return;
  }
  await runForegroundCommand(job, (progress) => executeTaskRun({ ...request, onProgress: progress }), { json: options.json });
}

async function handleRunResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let available = false;
  let sessionId = null;
  let detail = "no resumable dsh session for this repository";
  try {
    const candidate = await resolveLatestDshSession(workspaceRoot);
    if (candidate) {
      sessionId = candidate.sessionId;
      // A recorded session only counts when the broker that holds it is
      // still live; otherwise commands would suggest a dead resume.
      try {
        await assertResumableBrokerSession(workspaceRoot, candidate);
        available = true;
        detail = `resumable dsh session ${sessionId}`;
      } catch {
        detail = `previous dsh session ${sessionId} is no longer live (broker restarted or stopped); start fresh with --session`;
      }
    }
  } catch (error) {
    detail = error.message;
  }
  const payload = { available, sessionId, detail };
  outputCommandResult(payload, `${detail}\n`, options.json ?? true);
}

async function handleImport(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "source"], booleanOptions: ["json", "write"] });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  ensureDshAvailable(cwd);

  const sourcePath = resolveClaudeSessionPath(cwd, { source: options.source });
  const digest = compressTranscript(sourcePath);
  const template = loadPromptTemplate(ROOT_DIR, "import");
  const prompt = interpolateTemplate(template, {
    TRANSCRIPT_DIGEST: digest,
    WORKSPACE_ROOT: workspaceRoot
  });

  const importSessionId = mintBrokerSessionId();
  const job = createBridgeJob({
    prefix: "import",
    kind: "import",
    title: "DSH Import",
    workspaceRoot,
    jobClass: "task",
    summary: `weak import of ${path.basename(sourcePath)}`,
    write: Boolean(options.write),
    broker: true,
    dshSessionId: importSessionId
  });

  // Import always starts a resumable broker session so the transferred
  // context can be continued with /dsh:run --resume.
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        kind: "task",
        cwd,
        prompt,
        write: Boolean(options.write),
        useBroker: true,
        sessionId: importSessionId,
        resumeSessionId: null,
        title: "DSH Import",
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleRuns(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "all"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }
  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputCommandResult(report, renderStatusReport(report), options.json);
}

async function handleShow(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const { job, stored } = resolveResultJob(cwd, positionals[0] ?? null);
  outputCommandResult({ job, stored }, renderStoredJobResult(job, stored), options.json);
}

async function handleStop(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "broker"] });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  if (options.broker) {
    const stopped = await stopBroker(workspaceRoot);
    outputCommandResult(
      { stopped },
      stopped ? "Stopped the DSH broker (in-memory sessions are gone).\n" : "No running DSH broker for this workspace.\n",
      options.json
    );
    return;
  }

  const { job } = resolveCancelableJob(cwd, positionals[0] ?? null);
  const stale = job.status === "stale";
  const claimed = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    phase: "cancelled",
    errorMessage: "Stopped by user."
  });
  if (!claimed) {
    // Another writer (worker finish, session end) won the terminal claim
    // between resolve and here. Its recorded pids may already be reused —
    // signalling them could kill unrelated processes, so refuse.
    const brokerStatus = await getBrokerStatus(workspaceRoot);
    outputCommandResult(
      { job, stopped: false, brokerBusy: Boolean(brokerStatus?.busy) },
      renderStopRefusedReport(job, { brokerBusy: Boolean(brokerStatus?.busy) }),
      options.json
    );
    return;
  }
  // A broker-backed run has no per-turn cancel on the SDK wire; killing the
  // broker runtime is the only way to abort its in-flight turn. `broker` is
  // set at job creation, so this fires even while the turn is still running
  // (dshSessionId fallback covers records written by older plugin versions).
  // Tear the broker down BEFORE killing the worker tree: a background worker
  // that spawned the broker is still its process-tree parent, so the tree
  // kill below could take the broker with it un-reported otherwise.
  let brokerStopped = false;
  if (claimed.broker === true || (claimed.jobClass === "task" && claimed.dshSessionId)) {
    const status = await getBrokerStatus(workspaceRoot);
    if (status?.busy) {
      brokerStopped = await stopBroker(workspaceRoot);
    }
  }
  if (!stale) {
    for (const pid of resolveJobKillTargets(job)) {
      await terminateProcessTree(pid);
    }
  }
  outputCommandResult(
    { job: claimed, stopped: true, stale, brokerStopped },
    renderCancelReport(claimed, { stale, brokerStopped }),
    options.json
  );
}

async function handleRunWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for run-worker.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let stored = null;
  for (let attempt = 0; attempt < 10 && !stored; attempt += 1) {
    stored = readStoredJob(workspaceRoot, options["job-id"]);
    if (!stored) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!stored) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  const request = stored.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its run request payload.`);
  }

  const { logFile, progress } = createTrackedProgress({ ...stored, workspaceRoot }, { logFile: stored.logFile ?? null });
  const runner =
    request.kind === "review" || stored.jobClass === "review"
      ? () => executeReviewRun({ ...request, onProgress: progress })
      : () => executeTaskRun({ ...request, onProgress: progress });
  await runTrackedJob({ ...stored, workspaceRoot, logFile }, runner, { logFile });
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

const HANDLERS = {
  check: handleCheck,
  setup: handleSetup,
  review: (argv) => handleReviewCommand(argv, { reviewName: "Review" }),
  critique: (argv) => handleReviewCommand(argv, { reviewName: "Critique" }),
  run: handleRun,
  "run-worker": handleRunWorker,
  "run-resume-candidate": handleRunResumeCandidate,
  import: handleImport,
  runs: handleRuns,
  show: handleShow,
  stop: handleStop
};

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const handler = HANDLERS[subcommand];
  if (!handler) {
    printUsage();
    process.exitCode = subcommand ? 1 : 0;
    return;
  }
  await handler(argv);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
