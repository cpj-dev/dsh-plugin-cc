#!/usr/bin/env node
/**
 * Fake `dsh` binary for spawn-path tests. Records argv and selected env to
 * FAKE_DSH_RECORD_FILE (JSON) and behaves per FAKE_DSH_MODE:
 * - "ok" (default): prints FAKE_DSH_STDOUT (default "fake final message"), exit 0
 * - "fail": prints FAKE_DSH_STDERR to stderr, exit 1
 * - "version": prints a version line, exit 0 (also used for --version probes)
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
const recordFile = process.env.FAKE_DSH_RECORD_FILE;
if (recordFile) {
  fs.writeFileSync(
    recordFile,
    JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        env: { DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null }
      },
      null,
      2
    ),
    "utf8"
  );
}

if (argv.includes("--version")) {
  console.log("0.1.0-rc.5-fake");
  process.exit(0);
}

const mode = process.env.FAKE_DSH_MODE ?? "ok";
if (mode === "fail") {
  process.stderr.write(process.env.FAKE_DSH_STDERR ?? "fake dsh failure\n");
  process.exit(1);
}
process.stdout.write(process.env.FAKE_DSH_STDOUT ?? "fake final message\n");
process.exit(0);
