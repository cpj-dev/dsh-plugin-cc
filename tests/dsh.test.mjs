import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, withEnv } from "./helpers.mjs";

import {
  buildHeadlessArgs,
  buildModelOverlayYaml,
  describeDshBinary,
  getDshAvailability,
  inspectHarnessCheckout,
  normalizePermissionMode,
  normalizeReasoningEffort,
  parseStructuredOutput,
  resolveDshBinary,
  runHeadlessAgent,
  writePluginConfig,
  writeModelOverlay
} from "../plugins/dsh/scripts/lib/dsh.mjs";

const FAKE_DSH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-dsh-fixture.mjs");
const FAKE_DSH_CMD = process.execPath; // run the fixture through node
const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "dsh", "scripts", "dsh-bridge.mjs");

function fakeDshEnv(extra = {}) {
  // DSH_BINARY cannot carry arguments, so tests use a wrapper script.
  return extra;
}

function writeFakeDshWrapper(dir) {
  const wrapper = path.join(dir, "dsh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${FAKE_DSH_CMD}" "${FAKE_DSH}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

test("buildHeadlessArgs keeps launcher flags first and guards the task with --", () => {
  const args = buildHeadlessArgs({ task: "--tricky task", patches: ["/tmp/a.yml", null, "/tmp/b.yml"] });
  assert.deepEqual(args, [
    "--profile",
    "headless",
    "--patch",
    "/tmp/a.yml",
    "--patch",
    "/tmp/b.yml",
    "--",
    "--tricky task"
  ]);
});

test("model overlay renders the dsh-base row ids", () => {
  const yaml = buildModelOverlayYaml({ model: "deepseek-v4", effort: "high" });
  assert.match(yaml, /id: agent-default-model/);
  assert.match(yaml, /provider: 'deepseek-official'/);
  assert.match(yaml, /model: 'deepseek-v4'/);
  assert.match(yaml, /id: llm-deepseek/);
  assert.match(yaml, /reasoningEffort: 'high'/);
  assert.equal(buildModelOverlayYaml({}), null);

  const dir = makeTempDir();
  const file = writeModelOverlay(dir, { model: "deepseek-v4" });
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, "utf8"), /agent-default-model/);
  assert.equal(writeModelOverlay(dir, {}), null);
});

test("permission mode and effort validation fail loud on bad values", () => {
  assert.equal(normalizePermissionMode("workspace-write"), "workspace-write");
  assert.equal(normalizePermissionMode(null), null);
  assert.throws(() => normalizePermissionMode("yolo"), /Unsupported permission mode/);
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.throws(() => normalizeReasoningEffort("extreme"), /Unsupported reasoning effort/);
});

test("parseStructuredOutput handles bare JSON, fences, brace spans, and garbage", () => {
  assert.deepEqual(parseStructuredOutput('{"a":1}').parsed, { a: 1 });
  assert.deepEqual(parseStructuredOutput('Here you go:\n```json\n{"a":2}\n```').parsed, { a: 2 });
  assert.deepEqual(parseStructuredOutput('prefix {"a":3} suffix').parsed, { a: 3 });
  const garbage = parseStructuredOutput("no json here");
  assert.equal(garbage.parsed, null);
  assert.ok(garbage.parseError);
  assert.equal(garbage.rawOutput, "no json here");
});

test("runHeadlessAgent spawns the exact dsh invocation with the sandbox env", async () => {
  const dir = makeTempDir();
  const wrapper = writeFakeDshWrapper(dir);
  const recordFile = path.join(dir, "record.json");
  const overlay = path.join(dir, "unattended.yml");
  fs.writeFileSync(overlay, "- id: approval\n  config:\n    policy: never\n");

  await withEnv(
    fakeDshEnv({ DSH_BINARY: wrapper, FAKE_DSH_RECORD_FILE: recordFile, FAKE_DSH_STDOUT: "final answer\n" }),
    async () => {
      const result = await runHeadlessAgent(dir, {
        prompt: "do the thing",
        permissionMode: "workspace-write",
        unattendedOverlay: overlay
      });
      assert.equal(result.status, 0);
      assert.equal(result.finalMessage, "final answer");

      const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      assert.deepEqual(record.argv, ["--profile", "headless", "--patch", overlay, "--", "do the thing"]);
      assert.equal(record.env.DSH_PERMISSION_MODE, "workspace-write");
    }
  );
});

test("bridge one-shot runs default to deepseek-v4-pro at effort max, overridable per run", () => {
  const dir = makeTempDir();
  const workspace = makeTempDir("ws-model-defaults-");
  const wrapper = writeFakeDshWrapper(dir);
  const recordFile = path.join(dir, "record.json");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dir, DSH_BINARY: wrapper, FAKE_DSH_RECORD_FILE: recordFile };
  const runBridge = (args) => spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env, timeout: 30_000 });
  // The record file holds the last fake-dsh invocation: the headless run
  // itself (any --version probes happen before it).
  const readPatchYaml = () => {
    const { argv } = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    return argv
      .map((arg, index) => (argv[index - 1] === "--patch" ? fs.readFileSync(arg, "utf8") : ""))
      .join("\n");
  };

  const defaulted = runBridge(["run", "task", "--cwd", workspace]);
  assert.equal(defaulted.status, 0, defaulted.stderr);
  let patches = readPatchYaml();
  assert.match(patches, /model: 'deepseek-v4-pro'/);
  assert.match(patches, /reasoningEffort: 'max'/);

  const overridden = runBridge(["run", "task", "--model", "deepseek-v4-flash", "--effort", "low", "--cwd", workspace]);
  assert.equal(overridden.status, 0, overridden.stderr);
  patches = readPatchYaml();
  assert.match(patches, /model: 'deepseek-v4-flash'/);
  assert.match(patches, /reasoningEffort: 'low'/);
  assert.doesNotMatch(patches, /deepseek-v4-pro/);
});

test("runHeadlessAgent surfaces nonzero exits with stderr", async () => {
  const dir = makeTempDir();
  const wrapper = writeFakeDshWrapper(dir);
  const overlay = path.join(dir, "unattended.yml");
  fs.writeFileSync(overlay, "- id: approval\n  config:\n    policy: never\n");

  await withEnv(fakeDshEnv({ DSH_BINARY: wrapper, FAKE_DSH_MODE: "fail", FAKE_DSH_STDERR: "boom\n" }), async () => {
    const result = await runHeadlessAgent(dir, {
      prompt: "explode",
      permissionMode: "read-only",
      unattendedOverlay: overlay
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /boom/);
  });
});

test("getDshAvailability reports the fake version through DSH_BINARY", async () => {
  const dir = makeTempDir();
  const wrapper = writeFakeDshWrapper(dir);
  await withEnv(fakeDshEnv({ DSH_BINARY: wrapper }), async () => {
    const availability = getDshAvailability(dir);
    assert.equal(availability.available, true);
    assert.match(availability.detail, /0\.1\.0-rc\.5-fake/);
  });
});

test("writePluginConfig strips null keys", async () => {
  const dataDir = makeTempDir();
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: undefined }, () => {
    writePluginConfig({ dshBinary: "/tmp/dsh", harnessCheckout: "/tmp/h", dshInstall: "harness" });
    writePluginConfig({ harnessCheckout: null, dshInstall: "npm" });
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(config.harnessCheckout, undefined);
    assert.equal(config.dshInstall, "npm");
    assert.equal(config.dshBinary, "/tmp/dsh");
  });
});

test("binary resolution order: DSH_BINARY env > persisted config > PATH default", async () => {
  const dataDir = makeTempDir();
  const binDir = makeTempDir("bin-");
  const configured = writeFakeDshWrapper(binDir);

  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: undefined }, () => {
    // Nothing configured: fall back to `dsh` on PATH.
    assert.deepEqual(describeDshBinary(), { binary: "dsh", source: "path", staleConfig: null });

    writePluginConfig({ dshBinary: configured });
    assert.deepEqual(describeDshBinary(), { binary: configured, source: "config", staleConfig: null });
    assert.equal(resolveDshBinary(), configured);

    writePluginConfig({ dshInstall: "npm" });
    assert.equal(describeDshBinary().source, "npm-pin");
    writePluginConfig({ dshInstall: "harness", harnessCheckout: "/tmp/harness" });
    assert.equal(describeDshBinary().source, "harness");
  });

  // The env override beats the config.
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: "/custom/dsh" }, () => {
    assert.deepEqual(describeDshBinary(), { binary: "/custom/dsh", source: "env", staleConfig: null });
  });

  // A configured binary that vanished is reported stale, not used.
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: undefined }, () => {
    fs.rmSync(configured);
    const description = describeDshBinary();
    assert.equal(description.binary, "dsh");
    assert.equal(description.source, "path");
    assert.equal(description.staleConfig, configured);
  });
});

function writeFakeCheckout(dir, { name = "@deepseek-ai/dsh", installed = false, built = false } = {}) {
  const cliDir = path.join(dir, "apps", "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, "package.json"), JSON.stringify({ name, version: "0.1.0-rc.5" }));
  if (installed) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  }
  if (built) {
    fs.mkdirSync(path.join(cliDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, "lib", "bin.js"), "#!/usr/bin/env node\nconsole.log('fake');\n", { mode: 0o755 });
  }
  return dir;
}

test("inspectHarnessCheckout recognizes checkouts and their install/build state", () => {
  const missing = inspectHarnessCheckout(makeTempDir("not-a-checkout-"));
  assert.equal(missing.valid, false);
  assert.match(missing.reason, /no readable apps\/cli\/package\.json/);

  const wrongName = inspectHarnessCheckout(writeFakeCheckout(makeTempDir("wrong-"), { name: "something-else" }));
  assert.equal(wrongName.valid, false);
  assert.match(wrongName.reason, /expected "@deepseek-ai\/dsh"/);

  const bare = inspectHarnessCheckout(writeFakeCheckout(makeTempDir("bare-")));
  assert.equal(bare.valid, true);
  assert.equal(bare.installed, false);
  assert.equal(bare.built, false);
  assert.equal(bare.version, "0.1.0-rc.5");

  const ready = inspectHarnessCheckout(writeFakeCheckout(makeTempDir("ready-"), { installed: true, built: true }));
  assert.equal(ready.valid, true);
  assert.equal(ready.installed, true);
  assert.equal(ready.built, true);
  assert.ok(ready.binPath.endsWith(path.join("apps", "cli", "lib", "bin.js")));
});

test("the unattended overlay pairs approval never with a mode-matching preset", async () => {
  const { buildUnattendedOverlayYaml, writeUnattendedOverlay } = await import("../plugins/dsh/scripts/lib/dsh.mjs");
  const yaml = buildUnattendedOverlayYaml("workspace-write");
  assert.match(yaml, /id: approval/);
  assert.match(yaml, /policy: never/);
  assert.match(yaml, /id: permission/);
  assert.match(yaml, /sandbox: 'workspace-write'/);
  assert.match(yaml, /defaultPreset: unattended/);
  // The preset must mirror the launch mode - a mismatch would let the pinned
  // preset override DSH_PERMISSION_MODE.
  assert.match(buildUnattendedOverlayYaml("read-only"), /sandbox: 'read-only'/);
  assert.throws(() => buildUnattendedOverlayYaml("yolo"), /Unsupported permission mode/);

  const dir = makeTempDir();
  const file = writeUnattendedOverlay(dir, "read-only");
  assert.ok(file.endsWith("unattended-read-only.yml"));
  assert.match(fs.readFileSync(file, "utf8"), /defaultPreset: unattended/);
});
