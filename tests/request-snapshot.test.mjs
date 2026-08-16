import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendSnapshot,
  hashToolSchema,
  SNAPSHOT_FILE_ENV,
  snapshotFromAssembleAndRequest
} from "../plugins/dsh/scripts/lib/request-snapshot.mjs";

test("snapshotFromAssembleAndRequest always emits the P0 field set", () => {
  const snapshot = snapshotFromAssembleAndRequest({});
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    [
      "contextSourceKinds",
      "maxTokens",
      "model",
      "promoted",
      "reasoningEffort",
      "source",
      "systemTexts",
      "toolNames",
      "toolSchemaHashes",
      "turn"
    ]
  );
  assert.equal(snapshot.turn, 1);
  assert.deepEqual(snapshot.systemTexts, []);
  assert.deepEqual(snapshot.toolNames, []);
  assert.deepEqual(snapshot.contextSourceKinds, []);
});

test("hashToolSchema is stable for key order and sensitive to description", () => {
  const a = hashToolSchema({
    name: "bash",
    description: "Run commands",
    parameters: { type: "object", properties: { command: { type: "string" } } }
  });
  const b = hashToolSchema({
    parameters: { properties: { command: { type: "string" } }, type: "object" },
    description: "Run commands",
    name: "bash"
  });
  const c = hashToolSchema({
    name: "bash",
    description: "Persistent shell",
    parameters: { type: "object", properties: { command: { type: "string" } } }
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
});

test("snapshotFromAssembleAndRequest extracts system, tools, and context kinds", () => {
  const snapshot = snapshotFromAssembleAndRequest({
    assembled: {
      sections: [
        { name: "identity", text: "You are an AI agent powered by DeepSeek Harness." },
        { name: "deployment:persona", text: "You are a helpful software engineer assistant." }
      ],
      tools: [
        { name: "bash", description: "one-shot" },
        { name: "str_replace_editor", description: "edit" },
        { name: "read", description: "read files" }
      ],
      contexts: [{ source: { kind: "agent-instructions" } }]
    },
    request: {
      maxTokens: 256000,
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      messages: [{ source: { kind: "skill-catalog" } }]
    },
    turn: 1,
    promoted: false
  });
  assert.deepEqual(snapshot.systemTexts, [
    "You are an AI agent powered by DeepSeek Harness.",
    "You are a helpful software engineer assistant."
  ]);
  assert.deepEqual(snapshot.toolNames, ["bash", "str_replace_editor", "read"]);
  assert.equal(snapshot.toolSchemaHashes.length, 3);
  assert.deepEqual(snapshot.contextSourceKinds.sort(), ["agent-instructions", "skill-catalog"]);
  assert.equal(snapshot.maxTokens, 256000);
  assert.equal(snapshot.model, "deepseek-v4-pro");
  assert.equal(snapshot.reasoningEffort, "max");
  assert.equal(snapshot.promoted, false);
  assert.equal(snapshot.source, "assemble");
});

test("snapshotFromAssembleAndRequest reads context kinds from final pre-step messages", () => {
  const snapshot = snapshotFromAssembleAndRequest({
    assembled: { sections: [{ text: "You are a helpful software engineer assistant." }], tools: [{ name: "bash" }] },
    messages: [
      { source: { kind: "user" } },
      { source: { kind: "skill-catalog" } }
    ],
    source: "pre-step",
    promoted: false
  });
  assert.deepEqual(snapshot.contextSourceKinds, ["skill-catalog"]);
  assert.equal(snapshot.source, "pre-step");
  assert.equal(snapshot.model, null);
});

test("snapshotFromAssembleAndRequest reads model fields from EpochHeader.config", () => {
  const snapshot = snapshotFromAssembleAndRequest({
    assembled: { sections: [{ text: "You are a helpful software engineer assistant." }], tools: [{ name: "bash" }] },
    request: {
      config: {
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        maxTokens: 256000,
        reasoningEffort: "max"
      }
    },
    source: "request",
    promoted: false
  });
  assert.equal(snapshot.model, "deepseek-v4-pro");
  assert.equal(snapshot.maxTokens, 256000);
  assert.equal(snapshot.reasoningEffort, "max");
  assert.equal(snapshot.source, "request");
});

test("appendSnapshot writes JSONL when a path is given", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-snap-"));
  const file = path.join(dir, "out.jsonl");
  appendSnapshot(file, { turn: 1, toolNames: ["bash"] });
  appendSnapshot(file, { turn: 2, toolNames: ["bash", "read"] });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).toolNames, ["bash"]);
  assert.deepEqual(JSON.parse(lines[1]).toolNames, ["bash", "read"]);
  appendSnapshot("", { turn: 3 });
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2);
  assert.equal(SNAPSHOT_FILE_ENV, "DSH_CC_SNAPSHOT_FILE");
});
