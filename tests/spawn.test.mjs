/**
 * Spawn-contract tests for CVE-2024-27980: Node throws EINVAL when
 * CreateProcess is asked to run a `.cmd`/`.bat` without `shell`. The plugin
 * must spawn `node` + a JS CLI entry instead. The EINVAL assertion runs on
 * windows-latest CI; rewrite + fake-dsh tests run on every OS.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, prependPath, withEnv } from "./helpers.mjs";
import {
  binaryAvailable,
  isWindowsBatchFile,
  locateCommandOnPath,
  parsePosixNodeWrapper,
  resolveBatchShimToJs,
  resolveNodeExecutable,
  resolveSpawn,
  runCommand
} from "../plugins/dsh/scripts/lib/process.mjs";
import { resolveDshInvocation, runHeadlessAgent, writePluginConfig } from "../plugins/dsh/scripts/lib/dsh.mjs";

const FAKE_DSH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-dsh-fixture.mjs");

function writeCmdShim(dir, jsEntry, basename = "dsh") {
  const cmd = path.join(dir, `${basename}.cmd`);
  fs.writeFileSync(
    cmd,
    [
      "@ECHO OFF",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "GOTO :eof",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      `endLocal & "${process.execPath}" "${jsEntry}" %*`,
      ""
    ].join("\r\n")
  );
  return cmd;
}

test("Node rejects .cmd spawn without shell (CVE-2024-27980 EINVAL)", (t) => {
  if (process.platform !== "win32") {
    t.skip("CreateProcess EINVAL is a Windows Node behavior");
    return;
  }
  const dir = makeTempDir("einval-cmd-");
  const cmd = writeCmdShim(dir, FAKE_DSH);
  const result = spawnSync(cmd, ["--version"], { encoding: "utf8", windowsHide: true, shell: false });
  assert.equal(result.error?.code, "EINVAL", result.error?.message ?? "expected spawn EINVAL");
});

test("resolveSpawn rewrites a .cmd shim to node + the quoted JS entry", () => {
  const dir = makeTempDir("shim-");
  const cmd = writeCmdShim(dir, FAKE_DSH);
  assert.equal(isWindowsBatchFile(cmd), true);
  assert.equal(resolveBatchShimToJs(cmd), FAKE_DSH);
  const resolved = resolveSpawn(cmd, ["--version"]);
  assert.equal(resolved.shell, false);
  assert.doesNotMatch(resolved.command, /\.(cmd|bat)$/i);
  assert.equal(path.basename(resolved.command).replace(/\.exe$/i, ""), "node");
  assert.deepEqual(resolved.args, [FAKE_DSH, "--version"]);
});

test("resolveDshInvocation turns a POSIX wrapper into node + bin.js, never shell:true", () => {
  const dir = makeTempDir("wrapper-");
  const wrapper = path.join(dir, "dsh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DSH}" "$@"\n`, { mode: 0o755 });
  const parsed = parsePosixNodeWrapper(wrapper);
  assert.deepEqual(parsed, { node: process.execPath, binJs: FAKE_DSH });
  const invocation = resolveDshInvocation({ ...process.env, DSH_BINARY: wrapper, CLAUDE_PLUGIN_DATA: dir });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [FAKE_DSH]);
  assert.equal(invocation.shell, false);
  assert.equal(isWindowsBatchFile(invocation.command), false);
});

test("resolveDshInvocation prefers persisted dshNode + dshBinJs over a wrapper file", async () => {
  const dataDir = makeTempDir("launch-config-");
  await withEnv({ CLAUDE_PLUGIN_DATA: dataDir, DSH_BINARY: undefined }, () => {
    writePluginConfig({
      dshInstall: "npm",
      dshNode: process.execPath,
      dshBinJs: FAKE_DSH,
      dshBinary: path.join(dataDir, "bin", "dsh")
    });
    const invocation = resolveDshInvocation();
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [FAKE_DSH]);
    assert.equal(invocation.shell, false);
    assert.equal(invocation.source, "npm-pin");
  });
});

test("runCommand and binaryAvailable rewrite a .cmd shim without shell:true", () => {
  const dir = makeTempDir("run-cmd-");
  const cmd = writeCmdShim(dir, FAKE_DSH);
  const result = runCommand(cmd, ["--version"]);
  assert.equal(result.error, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0\.1\.0-rc\.5-fake/);
  const probe = binaryAvailable(cmd, ["--version"]);
  assert.equal(probe.available, true, probe.detail);
});

test("resolveSpawn never uses a PATH node.cmd as the Node executable", () => {
  const dir = makeTempDir("node-cmd-");
  const js = path.join(dir, "cli.mjs");
  fs.writeFileSync(js, "console.log('from-js');\n");
  fs.writeFileSync(path.join(dir, "node.cmd"), "@ECHO OFF\r\n");
  const env = prependPath(dir, process.env);
  const resolved = resolveSpawn(js, ["--version"], env);
  assert.equal(resolved.shell, false);
  assert.equal(isWindowsBatchFile(resolved.command), false);
  assert.equal(path.basename(resolved.command).replace(/\.exe$/i, ""), "node");
  assert.deepEqual(resolved.args, [js, "--version"]);
  const node = resolveNodeExecutable(env, path.join(dir, "node.cmd"));
  assert.equal(isWindowsBatchFile(node), false);
  assert.doesNotMatch(node, /\.(cmd|bat)$/i);
});

test("parsePosixNodeWrapper only matches the plugin-managed two-line wrapper", () => {
  const dir = makeTempDir("wrap-shape-");
  const plugin = path.join(dir, "plugin-dsh");
  fs.writeFileSync(plugin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DSH}" "$@"\n`, { mode: 0o755 });
  assert.deepEqual(parsePosixNodeWrapper(plugin), { node: process.execPath, binJs: FAKE_DSH });

  const custom = path.join(dir, "custom-dsh");
  fs.writeFileSync(
    custom,
    `#!/bin/sh\nexport DSH_HOME=/tmp/dsh-home\nexec "${process.execPath}" "${FAKE_DSH}" "$@"\n`,
    { mode: 0o755 }
  );
  assert.equal(parsePosixNodeWrapper(custom), null);
  const invocation = resolveDshInvocation({ ...process.env, DSH_BINARY: custom, CLAUDE_PLUGIN_DATA: dir });
  assert.equal(invocation.command, custom);
  assert.deepEqual(invocation.args, []);
  assert.equal(invocation.shell, false);
});

test("Windows PATH prefers npm.cmd over the extensionless POSIX npm shim", (t) => {
  if (process.platform !== "win32") {
    t.skip("PATHEXT vs extensionless POSIX shims is a Windows PATH behavior");
    return;
  }
  const dir = makeTempDir("pathext-npm-");
  fs.writeFileSync(path.join(dir, "npm"), "#!/bin/sh\necho posix-npm\n");
  writeCmdShim(dir, FAKE_DSH, "npm");
  const env = prependPath(dir, process.env);
  const located = locateCommandOnPath("npm", env);
  assert.equal(path.dirname(located), dir);
  assert.match(path.basename(located), /^npm\.cmd$/i);
  assert.equal(isWindowsBatchFile(located), true);
  const resolved = resolveSpawn("npm", ["--version"], env);
  assert.equal(resolved.shell, false);
  assert.doesNotMatch(resolved.command, /\.(cmd|bat)$/i);
  assert.deepEqual(resolved.args, [FAKE_DSH, "--version"]);
  const probe = binaryAvailable("npm", ["--version"], { env });
  assert.equal(probe.available, true, probe.detail);
});

test("runHeadlessAgent spawns node + JS entry for a .cmd DSH_BINARY, never shell:true", async () => {
  const dir = makeTempDir("cmd-run-");
  const cmd = writeCmdShim(dir, FAKE_DSH);
  const recordFile = path.join(dir, "record.json");
  const unattended = path.join(dir, "unattended.yml");
  fs.writeFileSync(unattended, "- id: approval\n  config:\n    policy: never\n");

  await withEnv({ DSH_BINARY: cmd, FAKE_DSH_RECORD_FILE: recordFile, FAKE_DSH_STDOUT: "cmd-shim-ok\n" }, async () => {
    const result = await runHeadlessAgent(dir, { prompt: "one plus one", unattendedOverlay: unattended });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.finalMessage, "cmd-shim-ok");
    assert.equal(result.spawnShell, false);
    assert.equal(isWindowsBatchFile(result.spawnCommand), false);
    assert.equal(path.basename(result.spawnCommand).replace(/\.exe$/i, ""), "node");
    assert.equal(result.spawnArgs[0], FAKE_DSH);
    assert.ok(!result.spawnArgs.some((arg) => isWindowsBatchFile(arg)));
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    assert.equal(path.basename(record.execPath).replace(/\.exe$/i, ""), "node");
    assert.equal(fs.realpathSync(record.script), fs.realpathSync(FAKE_DSH));
  });
});
