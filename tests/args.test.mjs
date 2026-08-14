import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/dsh/scripts/lib/args.mjs";

test("splitRawArgumentString honors quotes and whitespace", () => {
  assert.deepEqual(splitRawArgumentString(`--base main "focus on the state store" --write`), [
    "--base",
    "main",
    "focus on the state store",
    "--write"
  ]);
  assert.deepEqual(splitRawArgumentString("  "), []);
  assert.deepEqual(splitRawArgumentString(`'a b' c`), ["a b", "c"]);
});

test("parseArgs handles values, flags, =, aliases, and --", () => {
  const parsed = parseArgs(["-m", "deepseek-v4", "--effort=high", "--write", "task", "--", "--not-a-flag"], {
    valueOptions: ["model", "effort"],
    booleanOptions: ["write"],
    aliasMap: { m: "model" }
  });
  assert.equal(parsed.options.model, "deepseek-v4");
  assert.equal(parsed.options.effort, "high");
  assert.equal(parsed.options.write, true);
  assert.deepEqual(parsed.positionals, ["task", "--not-a-flag"]);
  assert.deepEqual(parsed.unknown, []);
});

test("parseArgs collects unknown options without throwing", () => {
  const parsed = parseArgs(["--mystery", "text"], { booleanOptions: ["write"] });
  assert.deepEqual(parsed.unknown, ["--mystery"]);
  assert.deepEqual(parsed.positionals, ["text"]);
});
