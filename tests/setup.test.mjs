import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";

import {
  HARNESS_CLI_PACKAGE,
  HARNESS_NPM_VERSION,
  HARNESS_SDK_JSONRPC_PACKAGE,
  pinnedSdkServerInstallSpecs,
  resolveNpmCliBin,
  resolveNpmInstallDir,
  selectHarnessNode
} from "../plugins/dsh/scripts/lib/dsh.mjs";
import { withEnv } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(TESTS_DIR, "..", "plugins/dsh/scripts/dsh-bridge.mjs");
const NPM_PROFILE_IDENTITY = `npm:${HARNESS_NPM_VERSION}`;

function harnessProfileIdentity(checkout) {
  return `harness:${fs.realpathSync(checkout)}`;
}

// The harness (and therefore setup) needs Node >= 22.19; on older CI legs
// these end-to-end tests are skipped, the unit layers still run.
const HARNESS_NODE_OK = Boolean(selectHarnessNode());

/**
 * Fake dsh CLI. Emulates: --version, plugin --profile <p> add <spec...>
 * (records argv, creates the profile dir), --profile <p> --dump-config
 * (prints the profile's cordis.patch.yml).
 */
const FAKE_BIN_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const dshHome = process.env.DSH_HOME;
if (argv.includes("--version")) { console.log("0.1.0-rc.6-npmfake"); process.exit(0); }
if (argv[0] === "plugin") {
  fs.appendFileSync(path.join(dshHome, "plugin-add.log"), JSON.stringify(argv) + "\\n");
  if (process.env.DSH_FAIL_PLUGIN_ADD) {
    process.stderr.write("simulated plugin add failure\\n");
    process.exit(1);
  }
  const profile = argv[argv.indexOf("--profile") + 1];
  const dir = path.join(dshHome, "profiles", profile);
  fs.mkdirSync(dir, { recursive: true });
  const patchFile = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(patchFile)) {
    fs.writeFileSync(patchFile, "# Your patch layer for this dsh profile.\\n[]\\n");
  }
  process.exit(0);
}
if (argv.includes("--dump-config")) {
  const profile = argv[argv.indexOf("--profile") + 1];
  const dir = path.join(dshHome, "profiles", profile);
  if (!fs.existsSync(dir)) { process.stderr.write("unknown profile " + profile + "\\n"); process.exit(1); }
  try { process.stdout.write(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8")); } catch { process.stdout.write("[]\\n"); }
  process.exit(0);
}
process.exit(0);
`;

function writeFakeCheckout(dir, { installed = true, built = true, sdkServer = true } = {}) {
  const cliDir = path.join(dir, "apps", "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(
    path.join(cliDir, "package.json"),
    JSON.stringify({ name: HARNESS_CLI_PACKAGE, version: HARNESS_NPM_VERSION, type: "module" })
  );
  if (sdkServer) {
    fs.mkdirSync(path.join(dir, "packages", "sdk", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "packages", "sdk", "server", "package.json"),
      JSON.stringify({ name: HARNESS_SDK_JSONRPC_PACKAGE })
    );
  }
  if (installed) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  }
  if (built) {
    fs.mkdirSync(path.join(cliDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, "lib", "bin.js"), FAKE_BIN_SOURCE, { mode: 0o755 });
  }
  return dir;
}

function seedReadyCcProfile(dshHome) {
  const dir = path.join(dshHome, "profiles", "cc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cordis.patch.yml"),
    `# seeded ready profile\n- name: '${HARNESS_SDK_JSONRPC_PACKAGE}'\n`
  );
}

function pluginAddCount(dshHome) {
  const file = path.join(dshHome, "plugin-add.log");
  if (!fs.existsSync(file)) {
    return 0;
  }
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
}

function writeFakeNpm(binDir, templatePath) {
  const npm = path.join(binDir, "npm");
  fs.writeFileSync(
    npm,
    `#!/bin/sh
prefix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) echo "10.9.7-fake"; exit 0 ;;
    --prefix) prefix="$2"; shift 2; continue ;;
    --no-fund|--no-audit|install) shift; continue ;;
    *) shift; continue ;;
  esac
done
if [ -z "$prefix" ]; then echo "missing --prefix" >&2; exit 1; fi
mkdir -p "$prefix/node_modules/@deepseek-ai/dsh/lib"
cp "$FAKE_DSH_BIN_TEMPLATE" "$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
chmod +x "$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
printf '%s\\n' '{"name":"@deepseek-ai/dsh","version":"${HARNESS_NPM_VERSION}"}' > "$prefix/node_modules/@deepseek-ai/dsh/package.json"
echo "fake npm install" >&2
exit 0
`.replace("${HARNESS_NPM_VERSION}", HARNESS_NPM_VERSION),
    { mode: 0o755 }
  );
  return { npm, templatePath };
}

function writeFakePnpm(binDir) {
  const pnpm = path.join(binDir, "pnpm");
  fs.writeFileSync(
    pnpm,
    `#!/bin/sh
case "$1" in
  --version) echo "11.7.0-fake" ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  return pnpm;
}

function makeSetupEnv() {
  const dataDir = makeTempDir("data-");
  const dshHome = makeTempDir("dsh-home-");
  const fakeBinDir = makeTempDir("fakebin-");
  const templatePath = path.join(fakeBinDir, "fake-dsh-bin.mjs");
  fs.writeFileSync(templatePath, FAKE_BIN_SOURCE);
  writeFakeNpm(fakeBinDir, templatePath);
  writeFakePnpm(fakeBinDir);
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
    DSH_HOME: dshHome,
    DEEPSEEK_API_KEY: "test-key",
    DSH_BINARY: "",
    FAKE_DSH_BIN_TEMPLATE: templatePath,
    PATH: `${fakeBinDir}:${process.env.PATH}`
  };
  return { dataDir, dshHome, fakeBinDir, templatePath, env };
}

/** A dsh the plugin did not install, for DSH_BINARY / PATH scenarios. */
function writeExternalDsh(dir = makeTempDir("external-dsh-")) {
  fs.writeFileSync(path.join(dir, "bin.js"), FAKE_BIN_SOURCE);
  const dsh = path.join(dir, "dsh");
  fs.writeFileSync(dsh, `#!/bin/sh\nexec "${process.execPath}" "${dir}/bin.js" "$@"\n`, { mode: 0o755 });
  return dsh;
}

function runBridge(args, env, cwd) {
  return spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env, cwd, timeout: 60_000 });
}

test("pinnedSdkServerInstallSpecs pins the server and its published peers", () => {
  const specs = pinnedSdkServerInstallSpecs();
  assert.equal(specs[0], `${HARNESS_SDK_JSONRPC_PACKAGE}@${HARNESS_NPM_VERSION}`);
  assert.ok(specs.some((spec) => spec.startsWith("@deepseek-ai/dsh-sdk-protocol@")));
  assert.ok(specs.some((spec) => spec.startsWith("@deepseek-ai/cordis@")));
});

test("resolveNpmInstallDir lives next to the plugin config", async () => {
  const dataDir = makeTempDir();
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    const prefix = resolveNpmInstallDir();
    assert.equal(prefix, path.join(dataDir, "npm"));
    assert.equal(resolveNpmCliBin(prefix), path.join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  });
});

test("setup with no args installs the pinned npm CLI and registry SDK specs", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-npm-");

  const result = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.multiTurnReady, true);
  assert.equal(report.dsh.source, "npm-pin");
  assert.ok(report.npm.ok, JSON.stringify(report.npm));
  assert.ok(report.actionsTaken.some((line) => line.includes(`Installed ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION}`)));

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.dshInstall, "npm");
  assert.equal(config.npmVersion, HARNESS_NPM_VERSION);
  assert.equal(config.sdkProfileVersion, NPM_PROFILE_IDENTITY);
  assert.equal(config.npmPrefix, path.join(dataDir, "npm"));
  assert.equal(config.harnessCheckout, undefined);
  assert.ok(fs.existsSync(config.dshBinary));
  assert.match(fs.readFileSync(config.dshBinary, "utf8"), /@deepseek-ai\/dsh\/lib\/bin\.js/);

  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  assert.equal(addLog.length, 1);
  const addArgv = JSON.parse(addLog[0]);
  assert.deepEqual(addArgv, ["plugin", "--profile", "cc", "add", ...pinnedSdkServerInstallSpecs()]);

  const patch = fs.readFileSync(path.join(dshHome, "profiles", "cc", "cordis.patch.yml"), "utf8");
  assert.match(patch, /managed by dsh-plugin-cc/);
  assert.match(patch, /# Your patch layer/, "dsh's header comments survive the append");
  assert.doesNotMatch(patch, /^\[\][ \t]*$/m, "the seeded empty array must be removed");

  const rerun = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n").length, 1);
  const patchAfter = fs.readFileSync(path.join(dshHome, "profiles", "cc", "cordis.patch.yml"), "utf8");
  assert.equal(patchAfter.match(/managed by dsh-plugin-cc/g).length, 1);
});

test("setup --harness on a built checkout links dsh and installs the SDK server by absolute path", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-setup-");
  const checkout = writeFakeCheckout(makeTempDir("checkout-"));

  const result = runBridge(["setup", "--harness", checkout, "--json", "--cwd", workspace], env, workspace);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.multiTurnReady, true);
  assert.equal(report.dsh.source, "harness");
  assert.ok(report.actionsTaken.some((line) => line.includes("Linked dsh to the source checkout")));
  assert.ok(report.harness.ok, JSON.stringify(report.harness));

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.dshInstall, "harness");
  assert.equal(config.harnessCheckout, checkout);
  assert.equal(config.sdkProfileVersion, harnessProfileIdentity(checkout));
  assert.ok(fs.existsSync(config.dshBinary));
  assert.match(fs.readFileSync(config.dshBinary, "utf8"), /apps\/cli\/lib\/bin\.js/);

  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  assert.equal(addLog.length, 1);
  const addArgv = JSON.parse(addLog[0]);
  assert.deepEqual(addArgv, ["plugin", "--profile", "cc", "add", path.join(checkout, "packages", "sdk", "server")]);

  const patch = fs.readFileSync(path.join(dshHome, "profiles", "cc", "cordis.patch.yml"), "utf8");
  assert.match(patch, /managed by dsh-plugin-cc/);
  assert.doesNotMatch(patch, /^\[\][ \t]*$/m);

  const rerun = runBridge(["setup", "--harness", checkout, "--json", "--cwd", workspace], env, workspace);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(pluginAddCount(dshHome), 1);

  const migrated = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(migrated.status, 0, migrated.stderr);
  const migratedReport = JSON.parse(migrated.stdout);
  assert.equal(migratedReport.dsh.source, "npm-pin");
  const migratedConfig = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(migratedConfig.dshInstall, "npm");
  assert.equal(migratedConfig.harnessCheckout, undefined);
  assert.equal(migratedConfig.sdkProfileVersion, NPM_PROFILE_IDENTITY);
  assert.equal(pluginAddCount(dshHome), 2);
});

test("setup switches the cc profile when moving from npm to --harness", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-npm-to-harness-");
  const checkout = writeFakeCheckout(makeTempDir("checkout-from-npm-"));

  const npmSetup = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(npmSetup.status, 0, npmSetup.stderr);
  assert.equal(pluginAddCount(dshHome), 1);
  const afterNpm = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(afterNpm.sdkProfileVersion, NPM_PROFILE_IDENTITY);

  const harnessSetup = runBridge(["setup", "--harness", checkout, "--json", "--cwd", workspace], env, workspace);
  assert.equal(harnessSetup.status, 0, harnessSetup.stderr);
  const report = JSON.parse(harnessSetup.stdout);
  assert.ok(report.actionsTaken.some((line) => line.includes("Linked dsh to the source checkout")));
  assert.ok(report.actionsTaken.some((line) => line.includes(HARNESS_SDK_JSONRPC_PACKAGE) || line.includes("packages/sdk/server")));
  assert.equal(pluginAddCount(dshHome), 2, "npm → --harness must re-add the checkout SDK server, not keep npm registry specs");

  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  assert.deepEqual(JSON.parse(addLog[0]), ["plugin", "--profile", "cc", "add", ...pinnedSdkServerInstallSpecs()]);
  assert.deepEqual(JSON.parse(addLog[1]), ["plugin", "--profile", "cc", "add", path.join(checkout, "packages", "sdk", "server")]);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.dshInstall, "harness");
  assert.equal(config.sdkProfileVersion, harnessProfileIdentity(checkout));

  const rerun = runBridge(["setup", "--harness", checkout, "--json", "--cwd", workspace], env, workspace);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(pluginAddCount(dshHome), 2, "same-checkout --harness must stay idempotent after the switch");
});

test("setup switches the cc profile when moving from checkout A to checkout B", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-checkout-switch-");
  const checkoutA = writeFakeCheckout(makeTempDir("checkout-a-"));
  const checkoutB = writeFakeCheckout(makeTempDir("checkout-b-"));

  const first = runBridge(["setup", "--harness", checkoutA, "--cwd", workspace], env, workspace);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(pluginAddCount(dshHome), 1);
  const afterA = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(afterA.sdkProfileVersion, harnessProfileIdentity(checkoutA));

  const second = runBridge(["setup", "--harness", checkoutB, "--json", "--cwd", workspace], env, workspace);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(pluginAddCount(dshHome), 2, "checkout A → B must re-add B's SDK server");
  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  assert.deepEqual(JSON.parse(addLog[1]), ["plugin", "--profile", "cc", "add", path.join(checkoutB, "packages", "sdk", "server")]);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.harnessCheckout, checkoutB);
  assert.equal(config.sdkProfileVersion, harnessProfileIdentity(checkoutB));
});

test("setup retries --harness profile plugin add after a failed checkout link", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-harness-retry-");
  const checkout = writeFakeCheckout(makeTempDir("checkout-retry-"));

  const failed = runBridge(["setup", "--harness", checkout, "--cwd", workspace], { ...env, DSH_FAIL_PLUGIN_ADD: "1" }, workspace);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /simulated plugin add failure/);
  const afterFail = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(afterFail.dshInstall, "harness");
  assert.equal(afterFail.sdkProfileVersion, undefined, "identity must be written only after a successful plugin add");
  assert.equal(pluginAddCount(dshHome), 1);

  const retry = runBridge(["setup", "--harness", checkout, "--json", "--cwd", workspace], env, workspace);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(pluginAddCount(dshHome), 2);
  const afterRetry = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(afterRetry.sdkProfileVersion, harnessProfileIdentity(checkout));
});

test("setup --harness rejects non-checkouts and unbuilt trees without compiling them", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { env } = makeSetupEnv();
  const workspace = makeTempDir("ws-setup-");

  const notCheckout = runBridge(["setup", "--harness", makeTempDir("empty-"), "--cwd", workspace], env, workspace);
  assert.equal(notCheckout.status, 1);
  assert.match(notCheckout.stderr, /not a DeepSeek Harness checkout/);

  const bare = writeFakeCheckout(makeTempDir("checkout-bare-"), { installed: false, built: false });
  const unbuilt = runBridge(["setup", "--harness", bare, "--cwd", workspace], env, workspace);
  assert.equal(unbuilt.status, 1);
  assert.match(unbuilt.stderr, /pnpm install && pnpm run build:lib/);

  const noSdk = writeFakeCheckout(makeTempDir("checkout-no-sdk-"), { sdkServer: false });
  const missingSdk = runBridge(["setup", "--harness", noSdk, "--cwd", workspace], env, workspace);
  assert.equal(missingSdk.status, 1);
  assert.match(missingSdk.stderr, /No SDK server package/);
  assert.equal(pluginAddCount(env.DSH_HOME), 0, "--harness must not silently add registry SDK specs");
});

test("plain setup with an external dsh adds the SDK server from npm specs", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-external-");

  const extEnv = { ...env, DSH_BINARY: writeExternalDsh() };
  const result = runBridge(["setup", "--json", "--cwd", workspace], extEnv, workspace);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.multiTurnReady, true);
  assert.equal(report.dsh.source, "env");
  assert.ok(!report.actionsTaken.some((line) => line.includes("Installed @deepseek-ai/dsh@")));
  assert.ok(!fs.existsSync(path.join(dataDir, "npm")), "external dsh must not trigger an npm prefix install");
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.sdkProfileVersion, NPM_PROFILE_IDENTITY);
  assert.notEqual(config.dshInstall, "npm");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim()), [
    "plugin",
    "--profile",
    "cc",
    "add",
    ...pinnedSdkServerInstallSpecs()
  ]);
});

test("check reports the configured npm pin and flags a vanished binary", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-check-");

  const setup = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(setup.status, 0, setup.stderr);

  const check = runBridge(["check", "--json", "--cwd", workspace], env, workspace);
  assert.equal(check.status, 0, check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.dsh.source, "npm-pin");
  assert.equal(report.npm.ok, true);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  fs.rmSync(config.dshBinary);
  const degraded = runBridge(["check", "--json", "--cwd", workspace], env, workspace);
  const degradedReport = JSON.parse(degraded.stdout);
  assert.ok(degradedReport.nextSteps.some((step) => step.includes("no longer exists")));
});

test("check reports a stale npm pin and profile identity as not ready", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-check-stale-");

  const setup = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(setup.status, 0, setup.stderr);

  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.npmVersion = "0.1.0-rc.5";
  config.sdkProfileVersion = "0.1.0-rc.5";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const check = runBridge(["check", "--json", "--cwd", workspace], env, workspace);
  assert.equal(check.status, 0, check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.npm.ok, false);
  assert.equal(report.npm.version, "0.1.0-rc.5");
  assert.equal(report.profile.ready, false);
  assert.equal(report.multiTurnReady, false);
  // The stale pin is the CLI one-shot runs will use, so the headline cannot
  // stay "ready" while the npm row is not.
  assert.equal(report.dsh.source, "npm-pin");
  assert.equal(report.ready, false);
  assert.ok(report.nextSteps.some((step) => step.includes("0.1.0-rc.5") && step.includes(HARNESS_NPM_VERSION)));
  assert.ok(report.nextSteps.some((step) => step.includes("cc profile plugins")));
});

test("a stale npm row does not unready a dsh the user supplied instead", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-check-stale-env-");

  const setup = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(setup.status, 0, setup.stderr);

  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.npmVersion = "0.1.0-rc.5";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // DSH_BINARY is what runs now; the old npm prefix says nothing about it.
  const extEnv = { ...env, DSH_BINARY: writeExternalDsh() };
  const report = JSON.parse(runBridge(["check", "--json", "--cwd", workspace], extEnv, workspace).stdout);
  assert.equal(report.dsh.source, "env");
  assert.equal(report.npm.ok, false);
  assert.equal(report.ready, true);
});

test("setup reinstalls the npm pin when the persisted version is stale", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-stale-");

  const setup = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n").length, 1);

  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.npmVersion = "0.0.1-rc.5";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const rerun = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(rerun.status, 0, rerun.stderr);
  const report = JSON.parse(rerun.stdout);
  assert.ok(report.actionsTaken.some((line) => line.includes(`Installed ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION}`)));
  assert.ok(report.actionsTaken.some((line) => line.startsWith(`Refreshed ${HARNESS_SDK_JSONRPC_PACKAGE}`)));
  const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(next.npmVersion, HARNESS_NPM_VERSION);
  assert.equal(next.dshInstall, "npm");
  assert.equal(next.sdkProfileVersion, NPM_PROFILE_IDENTITY);

  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  assert.equal(addLog.length, 2, "pin refresh must re-add SDK server + peers, not skip because dump-config already names the package");
  assert.deepEqual(JSON.parse(addLog[1]), ["plugin", "--profile", "cc", "add", ...pinnedSdkServerInstallSpecs()]);
});

test("plain setup migrates a pre-npm source config to the npm pin", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-legacy-");
  const checkout = writeFakeCheckout(makeTempDir("legacy-checkout-"));
  const wrapper = path.join(dataDir, "bin", "dsh");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${checkout}/apps/cli/lib/bin.js" "$@"\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    `${JSON.stringify({ dshBinary: wrapper, harnessCheckout: checkout }, null, 2)}\n`
  );
  seedReadyCcProfile(dshHome);

  const result = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dsh.source, "npm-pin");
  assert.ok(report.npm.ok, JSON.stringify(report.npm));
  assert.ok(report.actionsTaken.length > 0);
  assert.ok(report.actionsTaken.some((line) => line.includes(`Installed ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION}`)));

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.dshInstall, "npm");
  assert.equal(config.harnessCheckout, undefined);
  assert.equal(config.sdkProfileVersion, NPM_PROFILE_IDENTITY);
  assert.match(fs.readFileSync(config.dshBinary, "utf8"), /@deepseek-ai\/dsh\/lib\/bin\.js/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim()), [
    "plugin",
    "--profile",
    "cc",
    "add",
    ...pinnedSdkServerInstallSpecs()
  ]);
});

test("setup retries profile plugin add after a failed pin refresh", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-retry-");

  const setup = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(pluginAddCount(dshHome), 1);

  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.npmVersion = "0.0.1-rc.5";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const failed = runBridge(["setup", "--cwd", workspace], { ...env, DSH_FAIL_PLUGIN_ADD: "1" }, workspace);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /simulated plugin add failure/);
  const afterFail = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(afterFail.npmVersion, HARNESS_NPM_VERSION);
  assert.equal(afterFail.sdkProfileVersion, undefined);
  assert.equal(pluginAddCount(dshHome), 2);

  const retry = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(retry.status, 0, retry.stderr);
  const report = JSON.parse(retry.stdout);
  assert.ok(report.actionsTaken.some((line) => line.includes(HARNESS_SDK_JSONRPC_PACKAGE)));
  assert.equal(pluginAddCount(dshHome), 3);
  const afterRetry = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(afterRetry.sdkProfileVersion, NPM_PROFILE_IDENTITY);
});

test("external dsh with a ready profile still refreshes pinned SDK specs", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-ext-stale-profile-");
  seedReadyCcProfile(dshHome);

  const result = runBridge(["setup", "--json", "--cwd", workspace], { ...env, DSH_BINARY: writeExternalDsh() }, workspace);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.ok(report.actionsTaken.some((line) => line.startsWith(`Refreshed ${HARNESS_SDK_JSONRPC_PACKAGE}`)));
  assert.ok(!fs.existsSync(path.join(dataDir, "npm")));
  assert.equal(pluginAddCount(dshHome), 1);
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.sdkProfileVersion, NPM_PROFILE_IDENTITY);
  assert.notEqual(config.dshInstall, "npm");
});

test("DSH_BINARY over a persisted checkout reports the profile it just wrote as ready", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-env-over-harness-");
  const checkout = writeFakeCheckout(makeTempDir("harness-env-"));

  const linked = runBridge(["setup", "--json", "--harness", checkout, "--cwd", workspace], env, workspace);
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(JSON.parse(linked.stdout).multiTurnReady, true);

  // DSH_BINARY sends setup down the registry-spec path, so the leftover
  // harnessCheckout must not make check demand a `harness:` identity that no
  // rerun can produce.
  const extEnv = { ...env, DSH_BINARY: writeExternalDsh() };
  const result = runBridge(["setup", "--json", "--cwd", workspace], extEnv, workspace);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.profile.ready, true);
  assert.equal(report.multiTurnReady, true);

  const check = JSON.parse(runBridge(["check", "--json", "--cwd", workspace], extEnv, workspace).stdout);
  assert.equal(check.profile.ready, true);
  assert.equal(check.multiTurnReady, true);
  assert.ok(!check.nextSteps.some((step) => step.includes("cc profile plugins")));
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.sdkProfileVersion, NPM_PROFILE_IDENTITY);
});

test("setup reinstalls the npm pin when the prefix lost its CLI, even with dsh on PATH", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, fakeBinDir, templatePath, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-npm-repair-");

  const first = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(first.status, 0, first.stderr);

  // The prefix and wrapper are cleaned while an unrelated dsh answers on
  // PATH: availability alone must not convince setup the pin is installed.
  fs.rmSync(path.join(dataDir, "npm"), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, "bin"), { recursive: true, force: true });
  fs.writeFileSync(path.join(fakeBinDir, "dsh"), `#!/bin/sh\nexec "${process.execPath}" "${templatePath}" "$@"\n`, {
    mode: 0o755
  });

  const stale = JSON.parse(runBridge(["check", "--json", "--cwd", workspace], env, workspace).stdout);
  assert.equal(stale.npm.ok, false);

  const repair = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(repair.status, 0, repair.stderr);
  const report = JSON.parse(repair.stdout);
  assert.ok(report.actionsTaken.some((line) => line.includes(`Installed ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION}`)));
  assert.ok(fs.existsSync(resolveNpmCliBin(path.join(dataDir, "npm"))));
  assert.equal(report.npm.ok, true);
  assert.equal(report.dsh.source, "npm-pin");
  assert.equal(report.multiTurnReady, true);
  assert.deepEqual(report.nextSteps, []);
});

test("setup rewrites a deleted wrapper without reinstalling the intact pin", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, fakeBinDir, templatePath, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-wrapper-repair-");

  const first = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(first.status, 0, first.stderr);
  const addsAfterFirst = pluginAddCount(dshHome);

  // Only the wrapper is cleaned; the pinned package survives and an
  // unrelated dsh answers on PATH, so nothing else looks broken.
  fs.rmSync(path.join(dataDir, "bin"), { recursive: true, force: true });
  fs.writeFileSync(path.join(fakeBinDir, "dsh"), `#!/bin/sh\nexec "${process.execPath}" "${templatePath}" "$@"\n`, {
    mode: 0o755
  });

  const stale = JSON.parse(runBridge(["check", "--json", "--cwd", workspace], env, workspace).stdout);
  assert.equal(stale.npm.ok, false);
  assert.ok(stale.nextSteps.some((step) => step.includes("no longer exists")));

  const repair = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(repair.status, 0, repair.stderr);
  const report = JSON.parse(repair.stdout);
  assert.ok(report.actionsTaken.some((line) => line.startsWith("Rewrote the managed dsh wrapper")));
  assert.ok(!report.actionsTaken.some((line) => line.includes(`Installed ${HARNESS_CLI_PACKAGE}@`)));
  assert.equal(pluginAddCount(dshHome), addsAfterFirst, "an intact profile must not be re-added");
  assert.equal(report.npm.ok, true);
  assert.equal(report.dsh.source, "npm-pin");
  assert.equal(report.ready, true);
  assert.deepEqual(report.nextSteps, []);
});
