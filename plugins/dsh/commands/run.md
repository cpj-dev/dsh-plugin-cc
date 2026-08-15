---
description: Run a one-shot or resumable task / 执行一次性或可恢复任务
allowed-tools: ["Bash"]
---

Run a task on DeepSeek Harness:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" run "$ARGUMENTS"
```

Flags (explain to the user when relevant):
- Default: one-shot headless run, **read-only** sandbox. Crash-isolated, not resumable.
- `--write`: allow workspace file edits (workspace-write sandbox).
- `--session`: run through the shared broker and record a resumable dsh session id.
- `--resume` (or `--resume-last`): continue the most recent recorded dsh session; new text becomes the follow-up prompt, empty means "continue". The resume is validated against the live broker runtime — if the broker was stopped or restarted since, the command errors and asks for a fresh `--session` instead of silently starting over (relay that to the user).
- `--model <name>` / `--effort low|medium|high|max`: per-run model selection (ignored on `--resume`; the broker keeps its startup model). Defaults: `deepseek-v4-pro` at effort `max`.
- `--mode minimal|standard`: agent mode. Default `minimal` (dsh shows better overall capability there): a fixed one-line persona and just bash + str_replace_editor. `standard` restores the full dsh toolset (file search, web search, skills, subagents, plan/goal tools). Ignored on `--resume`; a live broker keeps its startup mode, and a `--session` run whose mode differs from the live broker errors with a `/dsh:stop --broker` hint — relay that to the user. `/dsh:setup --mode <m>` persists a machine default.
- `--background`: queue the run, return a run id, check with `/dsh:runs`.

Before suggesting `--resume`, you may probe availability with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" run-resume-candidate
```

Present the run output verbatim, including the footer line with the run id and session id.
