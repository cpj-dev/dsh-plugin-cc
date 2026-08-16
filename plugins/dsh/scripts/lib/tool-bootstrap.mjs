/**
 * Anchored-standard bootstrap — a Cordis plugin the bridge inserts via
 * `--patch`. It does not disable dsh-base tool rows. Instead it filters the
 * *model-visible* catalog on `system-prompt/assemble` until the session has
 * a durable promotion signal, then returns the assembled catalog unchanged.
 *
 * Promotion is derived from that session's event log (`promoteOn: either` =
 * first `tool/call` OR `assistant/message`), so a text-only first reply
 * (typical of `/dsh:import`) still promotes on the next request, and two
 * broker sessions cannot unlock each other.
 *
 * SPDX-License-Identifier: MIT
 *
 * Mechanism provenance (reimplemented, not a vendor copy):
 *   xiaobright/dsh-anchored-standard
 *   Copyright (c) 2026 xiaobright
 *   Portions Copyright (c) 2026 DeepSeek
 *   MIT License
 *   https://github.com/xiaobright/dsh-anchored-standard
 *
 * Experimental evidence (no code incorporated):
 *   xiaobright/modeltest
 *   docs/v4.1/DEEPSEEK_V4_TRIGGER_MECHANISM_EXPERIMENTS_20260814.md
 *
 * Written against headless/cc rather than a Web agent preset. Does not add
 * discovery tools; restores the full assembled catalog after promotion.
 * Full attribution: NOTICE at the repository root.
 */

import { appendSnapshot, snapshotFromAssembleAndRequest, SNAPSHOT_FILE_ENV } from "./request-snapshot.mjs";

export const name = "dsh-plugin-cc-tool-bootstrap";

/**
 * Empty inject: listeners only touch services at event time. Combined with
 * `--patch` (last composition layer) and `{ prepend: true }` on pre-step /
 * pre-execute, the strip stays the outermost transform.
 */
export const inject = [];

export const RL_PERSONA = "You are a helpful software engineer assistant.";
export const BOOTSTRAP_TOOLS = ["bash", "str_replace_editor"];
export const DEFAULT_SUPPRESSED_SOURCES = ["agent-instructions", "skill-catalog"];
export const PROMOTE_EVENTS = {
  either: ["tool/call", "assistant/message"],
  "tool-call": ["tool/call"],
  "assistant-message": ["assistant/message"]
};

const ALLOWED_KEYS = new Set(["bootstrapTools", "promoteOn", "suppressedContextSources", "persona"]);

function stringList(value, field, fallback) {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function parsePromoteOn(value) {
  if (value === undefined || value === "either") {
    return PROMOTE_EVENTS.either;
  }
  if (value === "tool-call" || value === "assistant-message") {
    return PROMOTE_EVENTS[value];
  }
  throw new TypeError(
    `${name}: promoteOn must be one of "either", "tool-call", "assistant-message"; got ${JSON.stringify(value)}`
  );
}

function parsePersona(value) {
  if (value === undefined) {
    return RL_PERSONA;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name}: persona must be a non-empty string`);
  }
  return value;
}

/** True when `events` already contains a durable promotion signal. */
export function isPromoted(events, promoteEvents = PROMOTE_EVENTS.either) {
  if (!Array.isArray(events) || promoteEvents.length === 0) {
    return false;
  }
  const wanted = new Set(promoteEvents);
  return events.some((event) => wanted.has(event?.type));
}

export function promotionStatus(agent, promoteEvents = PROMOTE_EVENTS.either) {
  return { promoted: isPromoted(agent?.session?.events, promoteEvents) };
}

export function applyCompletePersona(assembled, persona = RL_PERSONA) {
  if (!assembled || typeof assembled !== "object") {
    return assembled;
  }
  const next = {
    name: "deployment:persona",
    order: 0,
    text: persona,
    complete: true
  };
  return { ...assembled, sections: [next] };
}

export function filterAssembledTools(assembled, keepNames) {
  if (!assembled || typeof assembled !== "object" || !Array.isArray(assembled.tools)) {
    return assembled;
  }
  const keep = new Set(keepNames);
  return {
    ...assembled,
    tools: assembled.tools.filter((tool) => keep.has(tool?.name))
  };
}

export function filterPreStepMessages(decision, { promoted, suppressedSources }) {
  if (promoted || !decision || decision.kind === "reject" || !Array.isArray(decision.messages)) {
    return decision;
  }
  const blocked = new Set(suppressedSources);
  if (blocked.size === 0) {
    return decision;
  }
  const kept = decision.messages.filter((message) => {
    const kind = message?.source?.kind;
    return typeof kind !== "string" || !blocked.has(kind);
  });
  return kept.length === decision.messages.length ? decision : { ...decision, messages: kept };
}

export function toolNameFromExecutePayload(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const candidates = [payload.name, payload.toolName, payload.tool?.name, payload.call?.name];
  return candidates.find((value) => typeof value === "string" && value.length > 0) ?? "";
}

/** Reject model-hidden tools during bootstrap. After promotion, allow all. */
export function shouldRejectHiddenTool(toolName, { promoted, visibleTools }) {
  if (promoted || !toolName) {
    return false;
  }
  return !visibleTools.has(toolName);
}

function sessionOf(payload, context) {
  return payload?.agent ?? context?.agent ?? payload;
}

function recordSnapshot(assembled, request, extra) {
  const dest = process.env[SNAPSHOT_FILE_ENV];
  if (!dest) {
    return;
  }
  try {
    appendSnapshot(dest, snapshotFromAssembleAndRequest({ assembled, request, ...extra }));
  } catch {
    // Recording must never brick a turn.
  }
}

/** Per-session assemble counter for optional JSONL snapshots. */
function createTurnCounter() {
  const turns = new WeakMap();
  return (agent) => {
    const session = agent?.session;
    if (!session || typeof session !== "object") {
      return 1;
    }
    const turn = (turns.get(session) ?? 0) + 1;
    turns.set(session, turn);
    return turn;
  };
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`);
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(", ")} — allowed: ${[...ALLOWED_KEYS].sort().join(", ")}`
    );
  }

  const bootstrapTools = stringList(source.bootstrapTools, "bootstrapTools", BOOTSTRAP_TOOLS);
  const promoteEvents = parsePromoteOn(source.promoteOn);
  const suppressedSources = stringList(
    source.suppressedContextSources,
    "suppressedContextSources",
    DEFAULT_SUPPRESSED_SOURCES
  );
  const persona = parsePersona(source.persona);
  const visible = new Set(bootstrapTools);
  const nextTurn = createTurnCounter();

  let warned = false;
  const warnOnce = (message) => {
    if (warned) {
      return;
    }
    warned = true;
    try {
      ctx.logger.warn(message);
    } catch {
      // ignore
    }
  };

  const listen = (event, fn, options) => {
    try {
      ctx.on(event, fn, options);
    } catch (error) {
      warnOnce(`${name}: failed to listen for ${event}: ${String(error?.message ?? error)}`);
    }
  };

  listen("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    try {
      const agent = sessionOf(null, context);
      const { promoted } = promotionStatus(agent, promoteEvents);
      let nextAssembled = applyCompletePersona(assembled, persona);
      if (!promoted) {
        nextAssembled = filterAssembledTools(nextAssembled, bootstrapTools);
      }
      recordSnapshot(nextAssembled, null, { promoted, turn: nextTurn(agent) });
      return nextAssembled;
    } catch (error) {
      warnOnce(`${name}: assemble filter failed, exposing the full catalog: ${String(error?.message ?? error)}`);
      return assembled;
    }
  });

  listen(
    "agent/pre-step",
    async ({ agent }, next) => {
      const decision = await next();
      try {
        const { promoted } = promotionStatus(agent, promoteEvents);
        return filterPreStepMessages(decision, { promoted, suppressedSources });
      } catch (error) {
        warnOnce(`${name}: pre-step filter failed, keeping injected context: ${String(error?.message ?? error)}`);
        return decision;
      }
    },
    { prepend: true }
  );

  const guardExecute = async (payload, next) => {
    const toolName = toolNameFromExecutePayload(payload);
    const { promoted } = promotionStatus(sessionOf(payload), promoteEvents);
    if (shouldRejectHiddenTool(toolName, { promoted, visibleTools: visible })) {
      const error = new Error(`${name}: hidden tool "${toolName}" rejected during bootstrap`);
      if (payload && typeof payload === "object" && "kind" in payload) {
        return { kind: "reject", error };
      }
      throw error;
    }
    return next();
  };
  listen("tools/pre-execute", guardExecute, { prepend: true });
  listen("tool/pre-execute", guardExecute, { prepend: true });
}
