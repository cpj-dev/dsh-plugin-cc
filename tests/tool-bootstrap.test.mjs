import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  apply,
  applyCompletePersona,
  BOOTSTRAP_TOOLS,
  COMPLETE_SECTION_NAME,
  filterAssembledTools,
  filterPreStepMessages,
  hiddenToolDeny,
  isPromoted,
  name as pluginName,
  promotionStatus,
  requestFromHeader,
  RL_PERSONA,
  shouldRejectHiddenTool,
  toolNameFromExecutePayload
} from "../plugins/dsh/scripts/lib/tool-bootstrap.mjs";

const TWO_TOOLS = [
  { name: "bash", description: "one-shot" },
  { name: "str_replace_editor", description: "edit" }
];
const FULL_TOOLS = [...TWO_TOOLS, { name: "read", description: "read files" }, { name: "web_search", description: "search" }];

function session(events) {
  return { session: { events } };
}

/** rc.6 `request/header` payload: `{ header: EpochHeader, reason }`. */
function rc6HeaderEvent({ tools = TWO_TOOLS, reason = "initial", config = {} } = {}) {
  return {
    type: "request/header",
    data: {
      header: {
        config: {
          provider: "deepseek-official",
          model: "deepseek-v4-pro",
          maxTokens: 256000,
          reasoningEffort: "max",
          ...config
        },
        tools
      },
      reason
    }
  };
}

function createFakeCtx() {
  const handlers = Object.create(null);
  const registeredSections = [];
  return {
    logger: { warn() {} },
    systemPrompt: {
      section(section) {
        registeredSections.push(section);
      }
    },
    registeredSections,
    on(event, fn, options) {
      const list = (handlers[event] ??= []);
      if (options?.prepend) {
        list.unshift(fn);
      } else {
        list.push(fn);
      }
    },
    async assemble(context, base) {
      const list = handlers["system-prompt/assemble"] ?? [];
      let index = 0;
      const next = async () => {
        if (index >= list.length) {
          return base;
        }
        const fn = list[index];
        index += 1;
        return fn(undefined, context, next);
      };
      return next();
    },
    async preStep(agent, decision) {
      const list = handlers["agent/pre-step"] ?? [];
      let index = 0;
      const next = async () => {
        if (index >= list.length) {
          return decision;
        }
        const fn = list[index];
        index += 1;
        return fn({ agent }, next);
      };
      return next();
    },
    async preExecute(payload) {
      const list = handlers["tools/pre-execute"] ?? [];
      let index = 0;
      const next = async () => "executed";
      const run = async () => {
        if (index >= list.length) {
          return next();
        }
        const fn = list[index];
        index += 1;
        return fn(payload, run);
      };
      return run();
    },
    emitSessionEvent(session, event) {
      const list = handlers["session/event"] ?? [];
      for (const fn of list) {
        fn(session, event);
      }
    }
  };
}

test("isPromoted: either fires on tool/call or assistant/message, not on other events", () => {
  assert.equal(isPromoted([]), false);
  assert.equal(isPromoted([{ type: "user/message" }]), false);
  assert.equal(isPromoted([{ type: "tool/call" }]), true);
  assert.equal(isPromoted([{ type: "assistant/message" }]), true);
  assert.equal(isPromoted([{ type: "assistant/message" }], ["tool/call"]), false);
});

test("promotionStatus is per-agent session events", () => {
  const a = session([{ type: "assistant/message" }]);
  const b = session([]);
  assert.equal(promotionStatus(a).promoted, true);
  assert.equal(promotionStatus(b).promoted, false);
});

test("applyCompletePersona replaces every system section with the RL sentence", () => {
  const assembled = applyCompletePersona({
    sections: [
      { name: "identity", text: "You are an AI agent powered by DeepSeek Harness." },
      { name: "tool:bash", text: "Check the exit code." }
    ],
    tools: FULL_TOOLS
  });
  assert.deepEqual(
    assembled.sections.map((section) => section.text),
    [RL_PERSONA]
  );
  assert.equal(assembled.sections[0].complete, true);
  assert.equal(assembled.sections[0].name, COMPLETE_SECTION_NAME);
  assert.equal(assembled.tools.length, 4);
});

test("filterAssembledTools keeps only the bootstrap pair", () => {
  const filtered = filterAssembledTools({ tools: FULL_TOOLS }, BOOTSTRAP_TOOLS);
  assert.deepEqual(
    filtered.tools.map((tool) => tool.name),
    ["bash", "str_replace_editor"]
  );
});

test("filterPreStepMessages strips skill-catalog and agent-instructions until promoted", () => {
  const decision = {
    kind: "enter",
    messages: [
      { source: { kind: "user" }, content: "task" },
      { source: { kind: "skill-catalog" }, content: "skills" },
      { source: { kind: "agent-instructions" }, content: "AGENTS.md" }
    ]
  };
  const stripped = filterPreStepMessages(decision, {
    promoted: false,
    suppressedSources: ["skill-catalog", "agent-instructions"]
  });
  assert.deepEqual(
    stripped.messages.map((message) => message.source.kind),
    ["user"]
  );
  const restored = filterPreStepMessages(decision, {
    promoted: true,
    suppressedSources: ["skill-catalog", "agent-instructions"]
  });
  assert.equal(restored.messages.length, 3);
});

test("shouldRejectHiddenTool only during bootstrap", () => {
  const visible = new Set(BOOTSTRAP_TOOLS);
  assert.equal(shouldRejectHiddenTool("read", { promoted: false, visibleTools: visible }), true);
  assert.equal(shouldRejectHiddenTool("bash", { promoted: false, visibleTools: visible }), false);
  assert.equal(shouldRejectHiddenTool("read", { promoted: true, visibleTools: visible }), false);
  assert.equal(toolNameFromExecutePayload({ name: "read" }), "read");
  assert.equal(toolNameFromExecutePayload({ tool: { name: "glob" } }), "glob");
});

test("apply(): first assemble is two tools; assistant/message promotes the next assemble", async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const agent = session([]);
  const first = await ctx.assemble({ agent }, { sections: [{ text: "extra" }], tools: FULL_TOOLS });
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ["bash", "str_replace_editor"]
  );
  assert.deepEqual(first.sections.map((section) => section.text), [RL_PERSONA]);

  agent.session.events.push({ type: "assistant/message" });
  const second = await ctx.assemble({ agent }, { sections: [{ text: "extra" }], tools: FULL_TOOLS });
  assert.deepEqual(
    second.tools.map((tool) => tool.name),
    ["bash", "str_replace_editor", "read", "web_search"]
  );
  assert.deepEqual(second.sections.map((section) => section.text), [RL_PERSONA]);
});

test("apply(): session A promoting does not widen session B", async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const a = session([{ type: "tool/call" }]);
  const b = session([]);
  const forA = await ctx.assemble({ agent: a }, { tools: FULL_TOOLS, sections: [] });
  const forB = await ctx.assemble({ agent: b }, { tools: FULL_TOOLS, sections: [] });
  assert.equal(forA.tools.length, 4);
  assert.equal(forB.tools.length, 2);
});

test("apply(): pre-step restores injections after promotion", async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const decision = {
    kind: "enter",
    messages: [
      { source: { kind: "user" } },
      { source: { kind: "skill-catalog" } }
    ]
  };
  const before = await ctx.preStep(session([]), decision);
  assert.equal(before.messages.length, 1);
  const after = await ctx.preStep(session([{ type: "assistant/message" }]), decision);
  assert.equal(after.messages.length, 2);
});

test("apply(): pre-execute denies hidden tools until the *next* assemble", async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const bootstrap = session([]);
  await ctx.assemble({ agent: bootstrap }, { tools: FULL_TOOLS, sections: [] });
  assert.deepEqual(await ctx.preExecute({ agent: bootstrap, name: "read" }), hiddenToolDeny("read"));
  assert.equal(await ctx.preExecute({ agent: bootstrap, name: "bash" }), "executed");

  const promoted = session([{ type: "tool/call" }]);
  await ctx.assemble({ agent: promoted }, { tools: FULL_TOOLS, sections: [] });
  assert.equal(await ctx.preExecute({ agent: promoted, name: "read" }), "executed");
});

test("apply(): rc.6 persist-then-execute still denies hidden tools on the bootstrap response", async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const agent = session([]);
  await ctx.assemble({ agent }, { tools: FULL_TOOLS, sections: [{ text: "extra" }] });
  // rc.6: persist assistant/message, then this tool/call, THEN tools/pre-execute.
  agent.session.events.push({ type: "assistant/message" }, { type: "tool/call" });
  assert.deepEqual(await ctx.preExecute({ agent, name: "read" }), hiddenToolDeny("read"));
  assert.equal(await ctx.preExecute({ agent, name: "bash" }), "executed");

  ctx.emitSessionEvent(agent.session, { type: "step/end" });
  const second = await ctx.assemble({ agent }, { tools: FULL_TOOLS, sections: [{ text: "extra" }] });
  assert.deepEqual(
    second.tools.map((tool) => tool.name),
    ["bash", "str_replace_editor", "read", "web_search"]
  );
  assert.equal(await ctx.preExecute({ agent, name: "read" }), "executed");
});

test("apply(): an already-registered outer post-transform cannot re-widen request #1", async () => {
  const ctx = createFakeCtx();
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    return {
      ...assembled,
      sections: [...(assembled.sections ?? []), { text: "extra guidance" }],
      tools: [...(assembled.tools ?? []), { name: "web_search", description: "search" }]
    };
  });
  apply(ctx, {});
  assert.equal(ctx.registeredSections[0]?.complete, true);
  assert.equal(ctx.registeredSections[0]?.name, COMPLETE_SECTION_NAME);

  const first = await ctx.assemble(
    { agent: session([]) },
    { sections: [{ text: "identity" }], tools: FULL_TOOLS }
  );
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ["bash", "str_replace_editor"]
  );
  assert.deepEqual(
    first.sections.map((section) => section.text),
    [RL_PERSONA]
  );
});

test("apply(): assemble filter failure exposes the full catalog once", async () => {
  const warnings = [];
  const ctx = createFakeCtx();
  ctx.logger = {
    warn(message) {
      warnings.push(message);
    }
  };
  apply(ctx, {});
  const assembled = {
    get tools() {
      throw new Error("boom");
    },
    sections: [{ text: "keep me" }]
  };
  const result = await ctx.assemble({ agent: session([]) }, assembled);
  assert.equal(result, assembled);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exposing the full catalog/);
});

test("requestFromHeader reads rc.6 EpochHeader.config, not a top-level model", () => {
  const request = requestFromHeader({
    config: {
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      maxTokens: 256000,
      reasoningEffort: "max"
    },
    tools: TWO_TOOLS
  });
  assert.equal(request.model, "deepseek-v4-pro");
  assert.equal(request.maxTokens, 256000);
  assert.equal(request.reasoningEffort, "max");
  assert.deepEqual(
    request.tools.map((tool) => tool.name),
    ["bash", "str_replace_editor"]
  );
  assert.equal(
    requestFromHeader({
      config: {},
      tools: TWO_TOOLS
    }).model,
    null
  );
});

test("apply() records EpochHeader.config and does not inherit the previous header into the next pre-step", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-boot-snap-"));
  const file = path.join(dir, "snap.jsonl");
  const previous = process.env.DSH_CC_SNAPSHOT_FILE;
  process.env.DSH_CC_SNAPSHOT_FILE = file;
  try {
    const ctx = createFakeCtx();
    apply(ctx, {});
    const agent = session([]);
    await ctx.assemble({ agent }, { sections: [{ text: "extra" }], tools: FULL_TOOLS });
    const injected = {
      kind: "enter",
      messages: [
        { source: { kind: "user" }, content: "task" },
        { source: { kind: "skill-catalog" }, content: "skills" },
        { source: { kind: "agent-instructions" }, content: "AGENTS.md" }
      ]
    };
    const stripped = await ctx.preStep(agent, injected);
    assert.deepEqual(
      stripped.messages.map((message) => message.source.kind),
      ["user"]
    );
    ctx.emitSessionEvent(agent.session, rc6HeaderEvent({ tools: TWO_TOOLS, reason: "initial" }));

    agent.session.events.push({ type: "assistant/message" });
    await ctx.assemble({ agent }, { sections: [{ text: "extra" }], tools: FULL_TOOLS });
    await ctx.preStep(agent, injected);
    ctx.emitSessionEvent(agent.session, rc6HeaderEvent({ tools: FULL_TOOLS, reason: "change" }));

    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const firstPreStep = lines.find((line) => line.source === "pre-step" && line.turn === 1);
    const firstHeader = lines.find((line) => line.source === "request" && line.turn === 1);
    const secondPreStep = lines.find((line) => line.source === "pre-step" && line.turn === 2);
    const secondHeader = lines.find((line) => line.source === "request" && line.turn === 2);
    assert.equal(firstPreStep.promoted, false);
    assert.deepEqual(firstPreStep.toolNames, ["bash", "str_replace_editor"]);
    assert.deepEqual(firstPreStep.systemTexts, [RL_PERSONA]);
    assert.deepEqual(firstPreStep.contextSourceKinds, []);
    assert.equal(firstHeader.model, "deepseek-v4-pro");
    assert.equal(firstHeader.maxTokens, 256000);
    assert.equal(firstHeader.reasoningEffort, "max");
    assert.deepEqual(firstHeader.toolNames, ["bash", "str_replace_editor"]);
    assert.deepEqual(firstHeader.contextSourceKinds, []);
    assert.equal(secondPreStep.promoted, true);
    assert.deepEqual(secondPreStep.toolNames, ["bash", "str_replace_editor", "read", "web_search"]);
    assert.deepEqual(secondPreStep.contextSourceKinds.sort(), ["agent-instructions", "skill-catalog"]);
    assert.equal(secondHeader.model, "deepseek-v4-pro");
    assert.deepEqual(secondHeader.toolNames, ["bash", "str_replace_editor", "read", "web_search"]);
  } finally {
    if (previous === undefined) {
      delete process.env.DSH_CC_SNAPSHOT_FILE;
    } else {
      process.env.DSH_CC_SNAPSHOT_FILE = previous;
    }
  }
});

test("apply() rejects unknown config keys at mount", () => {
  assert.throws(() => apply({ on() {} }, { extra: true }), /unknown config key/);
  assert.equal(pluginName, "dsh-plugin-cc-tool-bootstrap");
});
