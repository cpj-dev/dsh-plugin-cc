import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";

import { cloneHarnessCheckout, resolveDefaultHarnessDir, selectHarnessNode } from "../plugins/dsh/scripts/lib/dsh.mjs";
import { withEnv } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(TESTS_DIR, "..", "plugins", "dsh", "scripts", "dsh-bridge.mjs");

// The harness (and therefore setup --harness) needs Node >= 22.19; on older
// CI legs these end-to-end tests are skipped, the unit layers still run.
const HARNESS_NODE_OK = Boolean(selectHarnessNode());

/**
 * Fake dsh CLI placed at apps/cli/lib/bin.js by the fixture (or by the fake
 * pnpm's "build"). Emulates: --version, plugin --profile <p> add <spec>
 * (records argv, creates the profile dir), --profile <p> --dump-config
 * (prints the profile's cordis.patch.yml).
 */
const FAKE_BIN_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const dshHome = process.env.DSH_HOME;
if (argv.includes("--version")) { console.log("0.1.0-rc.5-srcfake"); process.exit(0); }
if (argv[0] === "plugin") {
  const profile = argv[argv.indexOf("--profile") + 1];
  const dir = path.join(dshHome, "profiles", profile);
  fs.mkdirSync(dir, { recursive: true });
  // Real dsh initProfile seeds the user patch layer with header comments
  // and an empty flow array - the exact shape the managed-block append
  // must not corrupt.
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
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.5", type: "module" })
  );
  fs.mkdirSync(path.join(dir, "packages", "sdk", "server"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages", "sdk", "server", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-sdk-jsonrpc-server" })
  );
  // Template the fake pnpm's "build" copies into place.
  fs.writeFileSync(path.join(dir, ".fake-bin-template.mjs"), FAKE_BIN_SOURCE);
  if (installed) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  }
  if (built) {
    fs.mkdirSync(path.join(cliDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, "lib", "bin.js"), FAKE_BIN_SOURCE, { mode: 0o755 });
  }
  return dir;
}

/** Fake pnpm: `install` creates node_modules, `run build:lib` places bin.js. */
function writeFakePnpm(binDir) {
  const pnpm = path.join(binDir, "pnpm");
  fs.writeFileSync(
    pnpm,
    `#!/bin/sh
case "$1" in
  --version) echo "11.7.0-fake" ;;
  install) mkdir -p "$PWD/node_modules"; echo "fake pnpm install" >&2 ;;
  run) mkdir -p "$PWD/apps/cli/lib"; cp "$PWD/.fake-bin-template.mjs" "$PWD/apps/cli/lib/bin.js"; echo "fake pnpm build" >&2 ;;
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
  writeFakePnpm(fakeBinDir);
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
    DSH_HOME: dshHome,
    DEEPSEEK_API_KEY: "test-key",
    DSH_BINARY: "", // never let an outer override leak into these tests
    PATH: `${fakeBinDir}:${process.env.PATH}`
  };
  return { dataDir, dshHome, env };
}

function runBridge(args, env, cwd) {
  return spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env, cwd, timeout: 60_000 });
}

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
  assert.ok(report.actionsTaken.some((line) => line.includes("Linked dsh to the source checkout")));
  assert.ok(report.harness.ok, JSON.stringify(report.harness));

  // Persisted machine config: wrapper + checkout root.
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.harnessCheckout, checkout);
  assert.ok(fs.existsSync(config.dshBinary));
  assert.match(fs.readFileSync(config.dshBinary, "utf8"), /apps\/cli\/lib\/bin\.js/);

  // The SDK server was added by absolute checkout path (it is not on npm).
  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  assert.equal(addLog.length, 1);
  const addArgv = JSON.parse(addLog[0]);
  assert.deepEqual(addArgv, ["plugin", "--profile", "cc", "add", path.join(checkout, "packages", "sdk", "server")]);

  // Managed patch block written once, and dsh's seeded empty flow array
  // (`[]`) must be gone - a block sequence after a bare `[]` is invalid YAML.
  const patch = fs.readFileSync(path.join(dshHome, "profiles", "cc", "cordis.patch.yml"), "utf8");
  assert.match(patch, /managed by dsh-plugin-cc/);
  assert.match(patch, /# Your patch layer/, "dsh's header comments survive the append");
  assert.doesNotMatch(patch, /^\[\][ \t]*$/m, "the seeded empty array must be removed");

  // Rerun without --harness: idempotent, no second install, no duplicate block.
  const rerun = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n").length, 1);
  const patchAfter = fs.readFileSync(path.join(dshHome, "profiles", "cc", "cordis.patch.yml"), "utf8");
  assert.equal(patchAfter.match(/managed by dsh-plugin-cc/g).length, 1);
});

test("setup --harness installs and builds a bare checkout via pnpm", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-setup-");
  const checkout = writeFakeCheckout(makeTempDir("checkout-bare-"), { installed: false, built: false });

  const result = runBridge(["setup", "--harness", checkout, "--json", "--cwd", workspace], env, workspace);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.actionsTaken.some((line) => line.includes("pnpm install")));
  assert.ok(report.actionsTaken.some((line) => line.includes("build:lib")));
  assert.ok(fs.existsSync(path.join(checkout, "apps", "cli", "lib", "bin.js")));
  assert.ok(fs.existsSync(path.join(dataDir, "config.json")));
});

test("setup --harness rejects non-checkouts and refuses --skip-build on an unbuilt one", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { env } = makeSetupEnv();
  const workspace = makeTempDir("ws-setup-");

  const notCheckout = runBridge(["setup", "--harness", makeTempDir("empty-"), "--cwd", workspace], env, workspace);
  assert.equal(notCheckout.status, 1);
  assert.match(notCheckout.stderr, /not a DeepSeek Harness checkout/);

  const bare = writeFakeCheckout(makeTempDir("checkout-bare2-"), { installed: false, built: false });
  const skipped = runBridge(["setup", "--harness", bare, "--skip-build", "--cwd", workspace], env, workspace);
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /--skip-build/);
});

test("resolveDefaultHarnessDir lives next to the plugin config", async () => {
  const dataDir = makeTempDir();
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir }, () => {
    assert.equal(resolveDefaultHarnessDir(), path.join(dataDir, "deepseek-harness"));
  });
});

test("setup with no args adopts an existing checkout in the default dir (no clone)", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-auto-");
  const defaultDir = path.join(dataDir, "deepseek-harness");
  writeFakeCheckout(defaultDir);

  const result = runBridge(["setup", "--json", "--cwd", workspace], env, workspace);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.multiTurnReady, true);
  assert.ok(report.actionsTaken.some((line) => line.includes("Linked dsh to the source checkout")));
  assert.ok(!report.actionsTaken.some((line) => line.includes("Cloned")), "an existing checkout must not be re-cloned");
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.harnessCheckout, defaultDir);
});

test("setup with no args clones the pinned harness when nothing exists", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-clone-");

  // A bare template the fake git "clones" (fake pnpm then installs/builds it).
  const template = writeFakeCheckout(makeTempDir("template-"), { installed: false, built: false });
  const fakeGitDir = makeTempDir("fakegit-");
  fs.writeFileSync(
    path.join(fakeGitDir, "git"),
    `#!/bin/sh
case "$1" in
  --version) echo "git version 2.0.0-fake"; exit 0 ;;
  clone) mkdir -p "$3" && cp -R "$FAKE_CHECKOUT_TEMPLATE/." "$3/"; exit 0 ;;
  -C) exit 0 ;;
  rev-parse) exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const cloneEnv = { ...env, PATH: `${fakeGitDir}:${env.PATH}`, FAKE_CHECKOUT_TEMPLATE: template };

  const result = runBridge(["setup", "--json", "--cwd", workspace], cloneEnv, workspace);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.actionsTaken.some((line) => line.includes("Cloned")), JSON.stringify(report.actionsTaken));
  assert.ok(report.actionsTaken.some((line) => line.includes("pnpm install")));
  const defaultDir = path.join(dataDir, "deepseek-harness");
  assert.ok(fs.existsSync(path.join(defaultDir, "apps", "cli", "lib", "bin.js")), "clone + build must produce the CLI");
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(config.harnessCheckout, defaultDir);
});

test("plain setup provisions the checkout when an external dsh has no cc profile", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, dshHome, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-external-");

  // dsh reachable through DSH_BINARY, but no checkout configured anywhere:
  // the cc profile still needs one as the SDK server install source.
  const externalDir = makeTempDir("external-dsh-");
  fs.writeFileSync(path.join(externalDir, "bin.js"), FAKE_BIN_SOURCE);
  const externalDsh = path.join(externalDir, "dsh");
  fs.writeFileSync(externalDsh, `#!/bin/sh\nexec "${process.execPath}" "${externalDir}/bin.js" "$@"\n`, { mode: 0o755 });

  const template = writeFakeCheckout(makeTempDir("template-ext-"), { installed: false, built: false });
  const fakeGitDir = makeTempDir("fakegit-ext-");
  fs.writeFileSync(
    path.join(fakeGitDir, "git"),
    `#!/bin/sh
case "$1" in
  --version) echo "git version 2.0.0-fake"; exit 0 ;;
  clone) mkdir -p "$3" && cp -R "$FAKE_CHECKOUT_TEMPLATE/." "$3/"; exit 0 ;;
  -C) exit 0 ;;
  rev-parse) exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const cloneEnv = { ...env, DSH_BINARY: externalDsh, PATH: `${fakeGitDir}:${env.PATH}`, FAKE_CHECKOUT_TEMPLATE: template };

  const result = runBridge(["setup", "--json", "--cwd", workspace], cloneEnv, workspace);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.multiTurnReady, true);
  assert.ok(report.actionsTaken.some((line) => line.includes("Cloned")), JSON.stringify(report.actionsTaken));

  // The SDK server must come from the auto-provisioned default checkout.
  const defaultDir = path.join(dataDir, "deepseek-harness");
  const addLog = fs.readFileSync(path.join(dshHome, "plugin-add.log"), "utf8").trim().split("\n");
  const addArgv = JSON.parse(addLog[0]);
  assert.deepEqual(addArgv, ["plugin", "--profile", "cc", "add", path.join(defaultDir, "packages", "sdk", "server")]);
});

test("cloneHarnessCheckout retries the pin through an explicit fetch", async () => {
  const template = writeFakeCheckout(makeTempDir("template-pin-"), { installed: false, built: false });
  const fakeGitDir = makeTempDir("fakegit-pin-");
  const stateDir = makeTempDir("gitstate-");
  // Stateful fake: checkout fails until a fetch has happened.
  fs.writeFileSync(
    path.join(fakeGitDir, "git"),
    `#!/bin/sh
case "$1" in
  --version) echo "git version 2.0.0-fake"; exit 0 ;;
  clone) mkdir -p "$3" && cp -R "$FAKE_CHECKOUT_TEMPLATE/." "$3/"; exit 0 ;;
  -C)
    case "$3" in
      fetch) touch "$FAKE_GIT_STATE/fetched"; exit 0 ;;
      checkout) [ -f "$FAKE_GIT_STATE/fetched" ] && exit 0 || { echo "missing commit" >&2; exit 1; } ;;
    esac ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const target = path.join(makeTempDir("clone-target-"), "deepseek-harness");
  await withEnv(
    { PATH: `${fakeGitDir}:${process.env.PATH}`, FAKE_CHECKOUT_TEMPLATE: template, FAKE_GIT_STATE: stateDir },
    () => {
      assert.equal(cloneHarnessCheckout(target), target);
      assert.ok(fs.existsSync(target), "a pinned clone must survive");
      assert.ok(fs.existsSync(path.join(stateDir, "fetched")), "the pin retry must go through a fetch");
    }
  );
});

test("cloneHarnessCheckout fails loud and removes the clone when the pin cannot be applied", async () => {
  const template = writeFakeCheckout(makeTempDir("template-nopin-"), { installed: false, built: false });
  const fakeGitDir = makeTempDir("fakegit-nopin-");
  fs.writeFileSync(
    path.join(fakeGitDir, "git"),
    `#!/bin/sh
case "$1" in
  --version) echo "git version 2.0.0-fake"; exit 0 ;;
  clone) mkdir -p "$3" && cp -R "$FAKE_CHECKOUT_TEMPLATE/." "$3/"; exit 0 ;;
  -C) echo "fatal: reference is not a tree" >&2; exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const target = path.join(makeTempDir("clone-target-nopin-"), "deepseek-harness");
  await withEnv({ PATH: `${fakeGitDir}:${process.env.PATH}`, FAKE_CHECKOUT_TEMPLATE: template }, () => {
    assert.throws(() => cloneHarnessCheckout(target), /Could not check out the verified harness commit/);
    assert.ok(!fs.existsSync(target), "an unpinnable clone must not be left behind for a rerun to adopt");
  });
});

test("check reports the configured source build and flags a vanished one", (t) => {
  if (!HARNESS_NODE_OK) {
    t.skip("needs Node >= 22.19 to run the harness");
    return;
  }
  const { dataDir, env } = makeSetupEnv();
  const workspace = makeTempDir("ws-check-");
  const checkout = writeFakeCheckout(makeTempDir("checkout-"));

  const setup = runBridge(["setup", "--harness", checkout, "--cwd", workspace], env, workspace);
  assert.equal(setup.status, 0, setup.stderr);

  const check = runBridge(["check", "--json", "--cwd", workspace], env, workspace);
  assert.equal(check.status, 0, check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.dsh.source, "config");
  assert.equal(report.harness.ok, true);
  assert.match(report.harness.detail, /installed, built/);

  // Simulate the checkout being moved away: check must degrade loudly.
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  fs.rmSync(config.dshBinary);
  const degraded = runBridge(["check", "--json", "--cwd", workspace], env, workspace);
  const degradedReport = JSON.parse(degraded.stdout);
  assert.ok(degradedReport.nextSteps.some((step) => step.includes("no longer exists")));
});
