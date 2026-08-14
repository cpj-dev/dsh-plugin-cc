#!/usr/bin/env node
/**
 * Per-workspace broker for multi-turn DSH sessions (Codex app-server-broker
 * pattern). Owns one long-lived `dsh --profile cc` runtime speaking the DSH
 * SDK wire protocol (newline JSON-RPC 2.0 over stdio) and serves bridge
 * requests on a unix socket with line-delimited JSON-RPC.
 *
 * Why it exists: the DSH SDK server get-or-creates agents by sessionId
 * *inside one live process*, and headless has no --resume — cross-process
 * continuation does not exist. Keeping this runtime alive is the only
 * multi-turn path.
 *
 * Wire facts (deepseek-harness packages/sdk/protocol):
 * - initialize { cwd, provider, model } → { serverInfo }
 * - session/prompt { sessionId, contentBlocks } → { messageId }
 * - notifications: session.event { sessionId, event }, session.status
 *   { sessionId, status: running|idle }
 * - run-to-idle: wait for the `agent/inbox/spliced` event whose
 *   data.inserted[].id === messageId, then collect until `idle`; the final
 *   response is the last `assistant/message` event's text blocks.
 * - No cancel method: abandoning a turn means killing this runtime.
 *
 * Usage: node dsh-broker.mjs serve --cwd <workspace> --state-dir <dir>
 *          [--provider <p>] [--model <m>] [--effort <e>] [--permission-mode <mode>]
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { parseArgs } from "./lib/args.mjs";
import {
  BROKER_BUSY_RPC_CODE,
  BROKER_STALE_SESSION_RPC_CODE,
  brokerRequest,
  DEFAULT_BROKER_RUN_TIMEOUT_MS
} from "./lib/broker-client.mjs";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  normalizePermissionMode,
  normalizeReasoningEffort,
  resolveDshBinary,
  writeModelOverlay,
  writeUnattendedOverlay
} from "./lib/dsh.mjs";
import { isPidAlive } from "./lib/process.mjs";

const DEFAULT_PROVIDER = "deepseek-official";

/** Line-JSON-RPC client for the DSH SDK runtime child process. */
class RuntimeClient {
  constructor({ cwd, provider, model, effort, permissionMode, binary, unattendedOverlay, effortOverlay }) {
    this.cwd = cwd;
    this.provider = provider;
    this.model = model;
    this.effort = effort ?? null;
    this.permissionMode = permissionMode;
    this.binary = binary;
    this.unattendedOverlay = unattendedOverlay ?? null;
    // Effort rides a --patch overlay (llm-deepseek row); the model itself
    // travels on the initialize wire message instead.
    this.effortOverlay = effortOverlay ?? null;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.initialized = null;
    this.stderrTail = [];
    // Identifies one runtime process instance. Sessions live only inside
    // that instance, so a resume is valid iff its recorded generation equals
    // the live one — a respawned child under the same daemon never matches.
    this.generation = null;
  }

  start() {
    if (this.child) {
      return;
    }
    // The unattended overlay rides --patch (last composition layer): it sets
    // approval never AND the permission preset matching this broker's fixed
    // mode — dsh-base's permission-presets service refuses to boot otherwise.
    const args = ["--profile", "cc"];
    if (this.unattendedOverlay) {
      args.push("--patch", this.unattendedOverlay);
    }
    if (this.effortOverlay) {
      args.push("--patch", this.effortOverlay);
    }
    this.child = spawn(this.binary, args, {
      cwd: this.cwd,
      env: { ...process.env, DSH_PERMISSION_MODE: this.permissionMode },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.generation = randomUUID();
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line.trim()) {
          this.onFrame(line);
        }
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail.push(chunk);
      while (this.stderrTail.join("").length > 8192) {
        this.stderrTail.shift();
      }
    });
    this.child.on("close", (code) => {
      const error = new Error(`dsh runtime exited (${code}). stderr tail: ${this.stderrTail.join("").slice(-1000)}`);
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.initialized = null;
      // A dead runtime has no generation: its in-memory sessions are gone,
      // and nothing recorded against it may validate as resumable.
      this.generation = null;
    });
  }

  onFrame(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Malformed frames are ignored, matching the DSH transport.
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`runtime error ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined && message.id === undefined) {
      for (const listener of this.notificationListeners) {
        listener(message);
      }
    }
  }

  request(method, params, { timeoutMs = 60_000 } = {}) {
    this.start();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`runtime request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async ensureInitialized() {
    if (!this.initialized) {
      this.initialized = this.request("initialize", {
        cwd: this.cwd,
        provider: this.provider,
        model: this.model
      }).catch((error) => {
        this.initialized = null;
        throw error;
      });
    }
    return this.initialized;
  }

  subscribe(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * One activity interval: queue the prompt, wait for its durable inbox
   * receipt, collect session events, stop at whole-agent idle. Port of the
   * TypeScript SDK's HarnessSession.run.
   */
  async run(sessionId, promptText, { timeoutMs = DEFAULT_BROKER_RUN_TIMEOUT_MS } = {}) {
    await this.ensureInitialized();
    const events = [];

    let settle;
    const done = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const timer = setTimeout(() => {
      settle.reject(new Error(`run on session ${sessionId} timed out after ${timeoutMs}ms (the runtime keeps working; stop the broker to abort)`));
    }, timeoutMs);

    // Notifications are buffered and replayed once the prompt's messageId is
    // known: the runtime may flush the prompt response and the notifications
    // in one stdout chunk, in which case the inbox receipt is dispatched
    // synchronously before the response promise's continuation runs. (The
    // TypeScript SDK avoids this with a pull-based subscription queue.)
    let received = false;
    let messageId = null;
    const pending = [];

    const consume = (notification) => {
      const { method, params } = notification;
      if (method === "session.event" && params?.sessionId === sessionId) {
        const event = params.event;
        if (!received) {
          if (
            event?.type === "agent/inbox/spliced" &&
            Array.isArray(event?.data?.inserted) &&
            event.data.inserted.some((msg) => msg?.id === messageId)
          ) {
            received = true;
          } else {
            return;
          }
        }
        events.push(event);
        return;
      }
      if (received && method === "session.status" && params?.sessionId === sessionId && params?.status === "idle") {
        settle.resolve();
      }
    };

    const unsubscribe = this.subscribe((notification) => {
      if (messageId === null) {
        pending.push(notification);
        return;
      }
      consume(notification);
    });

    try {
      const receipt = await this.request("session/prompt", {
        sessionId,
        contentBlocks: [{ type: "text", text: promptText }]
      });
      messageId = receipt.messageId;
      for (const notification of pending.splice(0)) {
        consume(notification);
      }
      await done;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }

    return { sessionId, finalResponse: finalResponse(events), eventCount: events.length, generation: this.generation };
  }

  async shutdown() {
    if (!this.child) {
      return;
    }
    try {
      await this.request("shutdown", undefined, { timeoutMs: 3000 });
    } catch {
      // The runtime exits on shutdown (or is already gone); force below.
    }
    if (this.child) {
      this.child.kill("SIGTERM");
    }
  }
}

/** Concatenated text of the last assistant/message event (SDK semantics). */
function finalResponse(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") {
      continue;
    }
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function send(socket, message) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node dsh-broker.mjs serve --cwd <workspace> --state-dir <dir> [--provider <p>] [--model <m>] [--effort <e>] [--permission-mode <mode>]"
    );
  }
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "state-dir", "socket", "provider", "model", "effort", "permission-mode"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const stateDir = options["state-dir"] ? path.resolve(options["state-dir"]) : null;
  if (!stateDir || !options.socket) {
    throw new Error("Missing required --state-dir or --socket.");
  }
  const brokerDir = path.join(stateDir, "broker");
  fs.mkdirSync(brokerDir, { recursive: true });
  // Short tmpdir path: unix sun_path is ~104 bytes on macOS (see state.mjs).
  const socketPath = options.socket;
  const pidFile = path.join(brokerDir, "broker.pid");
  const infoFile = path.join(brokerDir, "broker.json");

  // Never steal the socket from a live daemon: an orphaned-but-alive broker
  // still holds a dsh runtime with write access, and overwriting its pid file
  // would make it unreachable forever. Only a provably dead owner's socket
  // may be removed; the bind below is the final arbiter for ties.
  if (fs.existsSync(socketPath)) {
    const answered = await brokerRequest(socketPath, "status", {}, { timeoutMs: 1000 }).catch(() => null);
    if (answered) {
      process.stderr.write(`broker already running for this workspace (pid ${answered.pid}); exiting\n`);
      process.exit(1);
    }
    let recordedPid = null;
    try {
      recordedPid = Number(fs.readFileSync(pidFile, "utf8").trim()) || null;
    } catch {
      // No pid record — the socket has no provable owner.
    }
    if (recordedPid && recordedPid !== process.pid && isPidAlive(recordedPid)) {
      process.stderr.write(
        `stale socket at ${socketPath} but broker pid ${recordedPid} is alive; refusing to take over (run /dsh:stop --broker)\n`
      );
      process.exit(1);
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already removed by a concurrent starter; the bind decides.
    }
  }

  const runtimePermissionMode = normalizePermissionMode(options["permission-mode"]) ?? "workspace-write";
  const runtimeEffort =
    normalizeReasoningEffort(options.effort || process.env.DSH_CC_EFFORT || null) ?? DEFAULT_REASONING_EFFORT;
  const runtime = new RuntimeClient({
    cwd,
    provider: options.provider || process.env.DSH_CC_PROVIDER || DEFAULT_PROVIDER,
    model: options.model || process.env.DSH_CC_MODEL || DEFAULT_MODEL,
    effort: runtimeEffort,
    permissionMode: runtimePermissionMode,
    binary: resolveDshBinary(),
    unattendedOverlay: writeUnattendedOverlay(stateDir, runtimePermissionMode),
    effortOverlay: writeModelOverlay(stateDir, { effort: runtimeEffort })
  });

  let activeRun = null;
  let lastSessionId = null;

  const writeInfo = () => {
    fs.writeFileSync(
      infoFile,
      JSON.stringify(
        {
          pid: process.pid,
          socketPath,
          cwd,
          provider: runtime.provider,
          model: runtime.model,
          effort: runtime.effort,
          permissionMode: runtime.permissionMode,
          lastSessionId,
          // Informational only; the status RPC's generation is authoritative.
          runtimeGeneration: runtime.generation,
          startedAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );
  };
  async function shutdown(server) {
    await runtime.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already removed; shutdown stays idempotent.
    }
    // Only remove the pid file if it is still ours — a takeover-refusing
    // sibling never writes it, but defend the invariant anyway.
    try {
      if (Number(fs.readFileSync(pidFile, "utf8").trim()) === process.pid) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // Missing or unreadable; nothing to clean.
    }
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, { id: null, error: { code: -32700, message: `Invalid JSON: ${error.message}` } });
          continue;
        }
        if (message.id === undefined) {
          continue;
        }

        if (message.method === "status") {
          send(socket, {
            id: message.id,
            result: {
              pid: process.pid,
              runtimeAlive: Boolean(runtime.child),
              busy: Boolean(activeRun),
              lastSessionId,
              generation: runtime.generation,
              provider: runtime.provider,
              model: runtime.model,
              effort: runtime.effort,
              permissionMode: runtime.permissionMode
            }
          });
          continue;
        }

        if (message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.method === "run") {
          const params = message.params ?? {};
          // Race-proof final guard for resumes: the bridge validates against
          // `status` first, but the runtime can die between that check and
          // this request. An expectation against anything but the live
          // generation means the session's context no longer exists.
          if (params.expectedGeneration && (!runtime.child || runtime.generation !== params.expectedGeneration)) {
            send(socket, {
              id: message.id,
              error: {
                code: BROKER_STALE_SESSION_RPC_CODE,
                message: "The requested dsh session predates the current runtime; its context no longer exists."
              }
            });
            continue;
          }
          if (activeRun) {
            send(socket, {
              id: message.id,
              error: { code: BROKER_BUSY_RPC_CODE, message: "The shared DSH broker is busy with another run." }
            });
            continue;
          }
          const sessionId = params.sessionId || `cc-${randomUUID()}`;
          // Reject NaN and non-positive values, not just falsy ones.
          const requestedTimeout = Number(params.timeoutMs);
          const timeoutMs =
            Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : DEFAULT_BROKER_RUN_TIMEOUT_MS;
          activeRun = { sessionId, startedAt: Date.now() };
          try {
            const result = await runtime.run(sessionId, String(params.prompt ?? ""), { timeoutMs });
            lastSessionId = sessionId;
            writeInfo();
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, { id: message.id, error: { code: -32000, message: error.message } });
          } finally {
            activeRun = null;
          }
          continue;
        }

        send(socket, { id: message.id, error: { code: -32601, message: `Unknown broker method ${message.method}` } });
      }
    });
    socket.on("error", () => {
      // Client went away mid-write; per-request state is already settled.
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.on("error", (error) => {
    // EADDRINUSE here means a concurrent starter won the bind race — the
    // kernel is the final arbiter of socket ownership.
    process.stderr.write(`broker socket listen failed on ${socketPath}: ${error.message}\n`);
    process.exit(1);
  });
  // Bind first, publish second: the pid/info files must only ever name the
  // daemon that actually owns the socket.
  server.listen(socketPath, () => {
    fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    writeInfo();
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
