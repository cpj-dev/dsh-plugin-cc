/**
 * Reduce a DSH assemble + request payload into a small, comparable snapshot
 * of what the model would see. Used by tests and by the optional recorder
 * (`DSH_CC_SNAPSHOT_FILE`) — not a substitute for session JSONL
 * `request/header`, but enough to catch harness identity, extra context
 * sources, and a widened tool catalog without a live LLM.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Env var: when set to a file path, each assemble appends one JSONL snapshot. */
export const SNAPSHOT_FILE_ENV = "DSH_CC_SNAPSHOT_FILE";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/** 16-char sha256 of a tool's model-visible schema (name + parameters). */
export function hashToolSchema(tool) {
  const slice = {
    name: tool?.name ?? null,
    description: tool?.description ?? tool?.schema?.description ?? null,
    parameters: tool?.parameters ?? tool?.inputSchema ?? tool?.schema ?? null
  };
  return createHash("sha256").update(stableStringify(slice)).digest("hex").slice(0, 16);
}

function sectionText(section) {
  if (!section || typeof section !== "object") {
    return "";
  }
  const text = section.text ?? section.content ?? "";
  return typeof text === "string" ? text : "";
}

function toolName(tool) {
  return typeof tool?.name === "string" ? tool.name : "";
}

function collectSourceKinds(assembled, request) {
  const kinds = [];
  const bags = [
    assembled?.contexts,
    assembled?.messages,
    request?.messages,
    request?.contexts
  ];
  for (const bag of bags) {
    if (!Array.isArray(bag)) {
      continue;
    }
    for (const item of bag) {
      const kind = item?.source?.kind;
      if (typeof kind === "string" && kind.length > 0) {
        kinds.push(kind);
      }
    }
  }
  return [...new Set(kinds)];
}

/**
 * @param {object} input
 * @param {object} [input.assembled] system-prompt/assemble result
 * @param {object} [input.request] agent/request result
 * @param {number} [input.turn]
 * @param {boolean} [input.promoted]
 */
export function snapshotFromAssembleAndRequest({
  assembled = null,
  request = null,
  turn = 1,
  promoted = null
} = {}) {
  const tools = Array.isArray(assembled?.tools) ? assembled.tools : [];
  const sections = Array.isArray(assembled?.sections) ? assembled.sections : [];
  return {
    turn,
    promoted,
    systemTexts: sections.map(sectionText).filter((text) => text.length > 0),
    toolNames: tools.map(toolName).filter((name) => name.length > 0),
    toolSchemaHashes: tools.map(hashToolSchema),
    contextSourceKinds: collectSourceKinds(assembled, request),
    maxTokens: request?.maxTokens ?? request?.config?.maxTokens ?? null,
    model: request?.model ?? assembled?.model ?? null,
    reasoningEffort: request?.reasoningEffort ?? request?.config?.reasoningEffort ?? null
  };
}

/** Append one snapshot as a JSON line. No-op when filePath is empty. */
export function appendSnapshot(filePath, snapshot) {
  const dest = String(filePath ?? "").trim();
  if (!dest) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.appendFileSync(dest, `${JSON.stringify(snapshot)}\n`, "utf8");
}
