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
- `--model <name>` / `--effort low|high|max`: per-run model selection (ignored on `--resume`; the broker keeps its startup model). Defaults: `deepseek-v4-pro` at effort `max`. `low` is in the official schema; `medium` is not. A vision id such as `deepseek-v4-flash-vision-exp` does not attach Claude chat images — this plugin sends text only.
- `--mode minimal|standard|anchored-standard`: agent mode. Default `standard` (full dsh toolset from request #1, no overlay). `minimal` locks bash + str_replace_editor for the whole run. `anchored-standard` shows that pair until this session records a tool call or assistant reply, then restores the full catalog. Ignored on `--resume`; a live broker keeps its startup mode, and a `--session` run whose mode differs from the live broker errors with a `/dsh:stop --broker` hint — relay that to the user. `/dsh:setup --mode <m>` persists a machine default.
- `--background`: queue the run, return a run id, check with `/dsh:runs`.

Before suggesting `--resume`, you may probe availability with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" run-resume-candidate
```

Present the run output verbatim, including the footer line with the run id and session id.
