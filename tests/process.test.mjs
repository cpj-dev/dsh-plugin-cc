import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";

import { isPidAlive, terminateProcessTree } from "../plugins/dsh/scripts/lib/process.mjs";

/** Spawn a node child running `script`, resolving once it prints `ready`. */
function spawnReady(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("ready")) {
        resolve(child);
      }
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error("child exited before signalling ready")));
  });
}

test("terminateProcessTree SIGKILLs a SIGTERM-ignoring process before resolving", async () => {
  const child = await spawnReady(
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');"
  );
  child.on("exit", () => {});
  const { survivors } = await terminateProcessTree(child.pid, { graceMs: 300 });
  assert.equal(survivors.length, 0);
  assert.equal(isPidAlive(child.pid), false);
});

test("terminateProcessTree resolves fast for a cooperative process", async () => {
  const child = await spawnReady("setInterval(() => {}, 1000); console.log('ready');");
  child.on("exit", () => {});
  const startedAt = Date.now();
  await terminateProcessTree(child.pid, { graceMs: 5000 });
  assert.ok(Date.now() - startedAt < 2000, "cooperative exit should not wait out the full grace period");
  assert.equal(isPidAlive(child.pid), false);
});

test("terminateProcessTree kills descendants too", async () => {
  // Parent spawns a grandchild and prints its pid; wait for both in one listener.
  const script = `
    const { spawn } = require('node:child_process');
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
    console.log('kid=' + kid.pid);
  `;
  const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  parent.on("exit", () => {});
  const grandchildPid = await new Promise((resolve, reject) => {
    let out = "";
    parent.stdout.on("data", (chunk) => {
      out += String(chunk);
      const match = out.match(/kid=(\d+)/);
      if (match) {
        resolve(Number(match[1]));
      }
    });
    parent.on("error", reject);
  });

  await terminateProcessTree(parent.pid, { graceMs: 1000 });
  assert.equal(isPidAlive(parent.pid), false);
  assert.equal(isPidAlive(grandchildPid), false);
});

test("terminateProcessTree tolerates bogus pids", async () => {
  assert.deepEqual(await terminateProcessTree(null), { pids: [], survivors: [] });
  assert.deepEqual(await terminateProcessTree(-5), { pids: [], survivors: [] });
});
