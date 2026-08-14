#!/usr/bin/env node
/**
 * Fake DSH SDK runtime for broker tests. Speaks just enough of the wire
 * protocol (newline JSON-RPC on stdio): answers `initialize` and
 * `session/prompt`, then emits the inbox receipt, an assistant/message
 * event echoing the prompt, and the idle status — the exact sequence the
 * broker's run-to-idle logic waits for. Tracks per-session turn counts so
 * resume tests can assert session continuity.
 *
 * Prompt directives (per-run behaviors, since the daemon captures env once):
 * - "hang…"        → receipt only; never answers, never goes idle.
 * - "sleep:<ms> …" → answers after the given delay.
 */

import process from "node:process";

const turnCounts = new Map();
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});

function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    return;
  }
  if (message.method === "session/prompt") {
    const { sessionId, contentBlocks } = message.params;
    const turn = (turnCounts.get(sessionId) ?? 0) + 1;
    turnCounts.set(sessionId, turn);
    const messageId = `msg-${sessionId}-${turn}`;
    send({ jsonrpc: "2.0", id: message.id, result: { messageId } });

    const promptText = contentBlocks.map((block) => block.text ?? "").join("");
    send({
      jsonrpc: "2.0",
      method: "session.event",
      params: { sessionId, event: { type: "agent/inbox/spliced", data: { inserted: [{ id: messageId }] } } }
    });
    if (promptText.startsWith("hang")) {
      return;
    }
    const sleepMatch = promptText.match(/^sleep:(\d+)\s*/);
    const respond = () => {
      send({
        jsonrpc: "2.0",
        method: "session.event",
        params: {
          sessionId,
          event: {
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: `turn ${turn}: ${promptText}` }] } }
          }
        }
      });
      send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: "idle" } });
    };
    if (sleepMatch) {
      setTimeout(respond, Number(sleepMatch[1]));
    } else {
      respond();
    }
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    process.exit(0);
  }
}
