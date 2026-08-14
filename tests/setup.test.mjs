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
  const profile = argv[argv.indexOf("--profile") + 1];
  const dir = path.join(dshHome, "profiles", profile);
  fs.mkdirSync(dir, { recursive: true });
  const patchFile = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(patchFile)) {
    fs.writeFileSync(patchFile, "# Your patch layer for this dsh profile.\\n[]\\n");
  }
  fs.appendFileSync(path.join(dshHome, "plugin-add.log"), JSON.stringify(argv) + "\\n");
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

function writeFakeCheckout(dir, { installed = true, built = true } = {}) {
  const cliDir = path.join(dir, "apps", "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(
    path.join(cliDir, "package.json"),
    JSON.stringify({ name: HARNESS_CLI_PACKAGE, version: HARNESS_NPM_VERSION, type: "module" })
  );
  fs.mkdirSync(path.join(dir, "packages", "sdk", "server"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages", "sdk", "server", "package.json"),
    JSON.stringify({ name: HARNESS_SDK_JSONRPC_PACKAGE })
  );
  if (installed) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  }
  if (built) {
    fs.mkdirSync(path.join(cliDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, "lib", "bin.js"), FAKE_BIN_SOURCE, { mode: 0o755 });
  }
  return dir;
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
  return { dataDir, dshHome, env };
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
  assert.ok(fs.existsSync(config.dshBinary));
  assert.match(fs.readFileSync(config.dshBinary, "utf8"), /apps\/cli\/lib\/bin\.js/);

  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  assert.equal(addLog.length, 1);
  const addArgv = JSON.parse(addLog[0]);
  assert.deepEqual(addArgv, ["plugin", "--profile", "cc", "add", path.join(checkout, "packages", "sdk", "server")]);

  const patch = fs.readFileSync(path.join(dshHome, "profiles", "cc", "cordis.patch.yml"), "utf8");
  assert.match(patch, /managed by dsh-plugin-cc/);
  assert.doesNotMatch(patch, /^\[\][ \t]*$/m);

  const rerun = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n").length, 1);
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
});

test("plain setup with an external dsh adds the SDK server from npm specs", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-external-");

  const externalDir = makeTempDir("external-dsh-");
  fs.writeFileSync(path.join(externalDir, "bin.js"), FAKE_BIN_SOURCE);
  const externalDsh = path.join(externalDir, "dsh");
  fs.writeFileSync(externalDsh, `#!/bin/sh\nexec "${process.execPath}" "${externalDir}/bin.js" "$@"\n`, { mode: 0o755 });

  const extEnv = { ...env, DSH_BINARY: externalDsh };
  const result = runBridge(["setup", "--json", "--cwd", workspace], extEnv, workspace);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.multiTurnReady, true);
  assert.equal(report.dsh.source, "env");
  assert.ok(!report.actionsTaken.some((line) => line.includes("Installed @deepseek-ai/dsh@")));
  assert.ok(!fs.existsSync(path.join(dataDir, "npm")), "external dsh must not trigger an npm prefix install");
  const configPath = path.join(dataDir, "config.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.notEqual(config.dshInstall, "npm");
  }

  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  const addArgv = JSON.parse(addLog[0]);
  assert.deepEqual(addArgv, ["plugin", "--profile", "cc", "add", ...pinnedSdkServerInstallSpecs()]);
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

test("setup reinstalls the npm pin when the persisted version is stale", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-stale-");

  const setup = runBridge(["setup", "--cwd", workspace], env, workspace);
  assert.equal(setup.status, 0, setup.stderr);

  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.npmVersion = "0.0.1-rc.5";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const rerun = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(rerun.status, 0, rerun.stderr);
  const report = JSON.parse(rerun.stdout);
  assert.ok(report.actionsTaken.some((line) => line.includes(`Installed ${HARNESS_CLI_PACKAGE}@${HARNESS_NPM_VERSION}`)));
  const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(next.npmVersion, HARNESS_NPM_VERSION);
  assert.equal(next.dshInstall, "npm");
});
