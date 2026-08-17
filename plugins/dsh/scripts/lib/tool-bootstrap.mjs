/**
 * Anchored-standard bootstrap — a Cordis plugin the bridge inserts via
 * `--patch`. It does not disable dsh-base tool rows. Instead it filters the
 * *model-visible* catalog on `system-prompt/assemble` until the session has
 * a durable promotion signal, then returns the assembled catalog unchanged.
 *
 * Promotion is derived from that session's event log (`promoteOn: either` =
 * first `tool/call` OR `assistant/message`). The phase used by pre-step and
 * `tools/pre-execute` is frozen at assemble — rc.7 still persists `assistant/message`
 * and the current `tool/call` *before* pre-execute, so a live event scan at
 * execute time would treat the bootstrap response as already promoted.
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
 * Empty inject: listeners only touch services at event time, so nothing here
 * may gate this plugin's activation. Combined with `--patch` (last composition
 * layer) and `{ prepend: true }` on assemble / pre-step / pre-execute, the
 * strip stays the outermost transform. The one service this plugin does touch
 * at apply() time — `systemPrompt` — is injected in a nested fiber instead
 * (see `registerCompletePersona`); a cordis context proxy throws on any
 * un-injected service property, so it can never be probed with `?.`.
 */
export const inject = [];

export const RL_PERSONA = "You are a helpful software engineer assistant.";
export const BOOTSTRAP_TOOLS = ["bash", "str_replace_editor"];
export const DEFAULT_SUPPRESSED_SOURCES = ["agent-instructions", "skill-catalog"];
export const COMPLETE_SECTION_NAME = "dsh-plugin-cc:persona";
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
    name: COMPLETE_SECTION_NAME,
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

/** rc.7 `tools/pre-execute` contract: `{ kind: "deny", reason }`. */
export function hiddenToolDeny(toolName) {
  return {
    kind: "deny",
    reason: `${name}: hidden tool "${toolName}" rejected during bootstrap`
  };
}

function sessionOf(payload, context) {
  return payload?.agent ?? context?.agent ?? payload;
}

/** WeakMap key for per-session freeze / pending snapshot. */
export function phaseKey(agent) {
  if (!agent || typeof agent !== "object") {
    return null;
  }
  const session = agent.session;
  return session && typeof session === "object" ? session : agent;
}

function sessionEventArgs(first, second) {
  if (second && typeof second === "object" && typeof second.type === "string") {
    return { session: first, event: second };
  }
  if (first && typeof first === "object" && typeof first.type === "string") {
    return { session: first.session ?? first, event: first };
  }
  return { session: first, event: second };
}

/**
 * Flatten an rc.7 `EpochHeader` into the snapshot request bag.
 * Session event data is `{ header, reason }`; the header itself is
 * `{ config: LlmCallConfig, adapterDefaults?, system?, tools? }` —
 * there is no `header.call` and no top-level `header.model`.
 */
export function requestFromHeader(header) {
  if (!header || typeof header !== "object") {
    return null;
  }
  const config = header.config && typeof header.config === "object" ? header.config : null;
  return {
    model: config?.model ?? header.model ?? null,
    maxTokens: config?.maxTokens ?? header.maxTokens ?? header.max_tokens ?? null,
    reasoningEffort: config?.reasoningEffort ?? header.reasoningEffort ?? null,
    messages: header.messages,
    tools: Array.isArray(header.tools) ? header.tools : null,
    config
  };
}

/**
 * Register the complete persona through a nested inject fiber.
 *
 * A cordis context proxy THROWS on `ctx.systemPrompt` when the accessing
 * plugin did not inject it — `typeof ctx?.systemPrompt?.section` is not a
 * safe probe, it is the crash (`cannot get property "systemPrompt" without
 * inject`). Declaring the service in this plugin's top-level `inject` would
 * fix the access but gate the whole plugin on it: a composition without the
 * registry would silently lose the tool filter too. `ctx.inject()` scopes the
 * dependency to the registration alone — the listeners below always attach,
 * and the section is registered (and disposed) with the nested fiber.
 *
 * Two consequences worth knowing. The callback runs on a later tick, which is
 * still long before the first assemble. And when nothing provides the registry
 * the fiber simply stays pending: no throw, no warning, no complete section —
 * the run keeps whatever persona the composition assembled, and the catalog
 * filter is unaffected. Cordis exposes no "will never be satisfied" signal to
 * warn on.
 */
function registerCompletePersona(ctx, persona, warnOnce) {
  try {
    ctx.inject(["systemPrompt"], function registerPersonaSection(scoped) {
      try {
        scoped.systemPrompt.section({
          name: COMPLETE_SECTION_NAME,
          order: 0,
          text: persona,
          complete: true
        });
      } catch (error) {
        warnOnce(`${name}: systemPrompt.section complete persona failed: ${String(error?.message ?? error)}`);
      }
    });
  } catch (error) {
    // Realistically only a host without `ctx.inject` at all; a pending
    // dependency does not land here.
    warnOnce(`${name}: could not request systemPrompt, keeping the composed persona: ${String(error?.message ?? error)}`);
  }
}

/** Per-session assemble counter for optional JSONL snapshots. */
function createTurnCounter() {
  const turns = new WeakMap();
  return (agent) => {
    const key = phaseKey(agent);
    if (!key) {
      return 1;
    }
    const turn = (turns.get(key) ?? 0) + 1;
    turns.set(key, turn);
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
  const phaseBySession = new WeakMap();
  const pendingBySession = new WeakMap();
  // Survives the per-turn pending bag: rc.7 still appends `request/header` only when
  // the header CHANGES (`reason: initial | resume | change`), so a steady-state
  // step emits none and the last snapshot is still that step's header.
  const headerBySession = new WeakMap();

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

  registerCompletePersona(ctx, persona, warnOnce);

  const listen = (event, fn, options) => {
    try {
      ctx.on(event, fn, options);
    } catch (error) {
      warnOnce(`${name}: failed to listen for ${event}: ${String(error?.message ?? error)}`);
    }
  };

  const freezePhase = (agent, promoted) => {
    const key = phaseKey(agent);
    const phase = { promoted: Boolean(promoted) };
    if (key) {
      phaseBySession.set(key, phase);
    }
    return phase;
  };

  const frozenPhase = (agent) => {
    const key = phaseKey(agent);
    if (key && phaseBySession.has(key)) {
      return phaseBySession.get(key);
    }
    return promotionStatus(agent, promoteEvents);
  };

  const clearPhase = (sessionLike) => {
    if (!sessionLike || typeof sessionLike !== "object") {
      return;
    }
    if (phaseBySession.has(sessionLike)) {
      phaseBySession.delete(sessionLike);
    }
    const key = phaseKey(sessionLike);
    if (key) {
      phaseBySession.delete(key);
    }
  };

  const replacePending = (agent, value) => {
    const key = phaseKey(agent);
    if (!key) {
      return;
    }
    pendingBySession.set(key, value);
  };

  const stashPending = (agent, patch) => {
    const key = phaseKey(agent);
    if (!key) {
      return;
    }
    pendingBySession.set(key, { ...(pendingBySession.get(key) ?? {}), ...patch });
  };

  const writeSnapshot = (agent, snapshotSource, extra = {}) => {
    const dest = process.env[SNAPSHOT_FILE_ENV];
    if (!dest) {
      return;
    }
    const key = phaseKey(agent);
    const stashed = (key && pendingBySession.get(key)) ?? {};
    try {
      const request = extra.request ?? stashed.request ?? null;
      const assembled = extra.assembled ?? stashed.assembled ?? null;
      // Overlay header.tools only on the request line. A pre-step snapshot
      // must use this assemble's catalog — the previous header's tools would
      // otherwise survive into a promoted pre-step via stash merge.
      const withHeaderTools =
        snapshotSource === "request" &&
        request &&
        Array.isArray(request.tools) &&
        assembled &&
        typeof assembled === "object"
          ? { ...assembled, tools: request.tools }
          : assembled;
      appendSnapshot(
        dest,
        snapshotFromAssembleAndRequest({
          assembled: withHeaderTools,
          request: snapshotSource === "request" ? request : null,
          messages: extra.messages ?? stashed.messages ?? null,
          turn: extra.turn ?? stashed.turn ?? 1,
          promoted: extra.promoted ?? stashed.promoted ?? null,
          source: snapshotSource
        })
      );
    } catch {
      // Recording must never brick a turn.
    }
  };

  // Outermost post-transform: later-registered append listeners cannot
  // re-append tools/sections after this filter. complete:true on the
  // *returned* AssembledSection is ignored by rc.7 (complete is captured
  // from the registry before the waterfall); the systemPrompt.section
  // registration above is the real complete constraint.
  listen(
    "system-prompt/assemble",
    async (_assembly, context, next) => {
      const assembled = await next();
      try {
        const agent = sessionOf(null, context);
        const { promoted } = freezePhase(agent, promotionStatus(agent, promoteEvents).promoted);
        let nextAssembled = applyCompletePersona(assembled, persona);
        if (!promoted) {
          nextAssembled = filterAssembledTools(nextAssembled, bootstrapTools);
        }
        const turn = nextTurn(agent);
        // Replace, do not merge: a leftover request/header from the previous
        // step would overlay that step's tools onto this pre-step snapshot.
        replacePending(agent, { assembled: nextAssembled, promoted, turn });
        return nextAssembled;
      } catch (error) {
        warnOnce(`${name}: assemble filter failed, exposing the full catalog: ${String(error?.message ?? error)}`);
        return assembled;
      }
    },
    { prepend: true }
  );

  listen(
    "agent/pre-step",
    async ({ agent }, next) => {
      const decision = await next();
      try {
        const { promoted } = frozenPhase(agent);
        const filtered = filterPreStepMessages(decision, { promoted, suppressedSources });
        stashPending(agent, { messages: filtered?.messages, promoted });
        writeSnapshot(agent, "pre-step", { messages: filtered?.messages, promoted });
        return filtered;
      } catch (error) {
        warnOnce(`${name}: pre-step filter failed, keeping injected context: ${String(error?.message ?? error)}`);
        return decision;
      }
    },
    { prepend: true }
  );

  const guardExecute = async (payload, next) => {
    const toolName = toolNameFromExecutePayload(payload);
    const { promoted } = frozenPhase(sessionOf(payload));
    if (shouldRejectHiddenTool(toolName, { promoted, visibleTools: visible })) {
      return hiddenToolDeny(toolName);
    }
    return next();
  };
  listen("tools/pre-execute", guardExecute, { prepend: true });

  listen("session/event", (first, second) => {
    const { session, event } = sessionEventArgs(first, second);
    const type = event?.type;
    const agent = session?.events ? { session } : session;
    if (type === "step/end") {
      // One wire line per step, written where the header for THIS step is
      // finally known. Recording on the `request/header` event alone left
      // every steady-state step unrecorded — in minimal mode the header never
      // changes after request #1, so the whole run produced a single wire
      // line and `docs/testing.md` had no per-step evidence to read.
      const key = phaseKey(agent);
      const request = key ? (headerBySession.get(key) ?? null) : null;
      if (request) {
        writeSnapshot(agent, "request", { request });
      }
      clearPhase(session);
      return;
    }
    if (type !== "request/header") {
      return;
    }
    const header = event.data?.header ?? event.data ?? event;
    const request = requestFromHeader(header);
    const key = phaseKey(agent);
    if (key) {
      headerBySession.set(key, request);
    }
  });
}
