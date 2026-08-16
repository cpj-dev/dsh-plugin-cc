---
name: dsh-delegate-runtime
description: Internal contract for calling the dsh bridge from commands and the dsh-delegate agent — subcommands, flags, environment, and failure handling. Read before composing any dsh-bridge.mjs invocation.
---

# dsh bridge runtime contract

Every DeepSeek Harness interaction goes through one script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" <subcommand> [flags] [text]
```

stdout is the user-facing result; render it verbatim. A nonzero exit means the run failed and stderr carries the reason.

## Subcommands

| Subcommand | Purpose | Key flags |
|---|---|---|
| `check` | readiness probe | `--json` |
| `setup` | install the pinned npm CLI (or `--harness <built-checkout>`) and create/verify the multi-turn `cc` profile | `--harness <path>`, `--mode`, `--json` |
| `review` | read-only code review | `--base <ref>`, `--scope`, `--model`, `--effort`, `--mode`, `--background` |
| `critique` | structured adversarial critique | same as review |
| `run` | task execution | `--write`, `--session`, `--resume`, `--fresh`, `--model`, `--effort`, `--mode`, `--background`, `--prompt-file` |
| `run-resume-candidate` | is a resumable dsh session available? | `--json` |
| `import` | weak-import this conversation into a resumable session | `--source <jsonl>` |
| `runs` | list runs / one run's status | `[run-id]`, `--all` |
| `show` | stored result of a finished run | `[run-id]` |
| `stop` | kill a run's process tree / the broker | `[run-id]`, `--broker` |

## Facts that shape correct usage

- Sandbox: default runs are read-only; `--write` grants workspace-write. There is no mid-run approval — permissions are decided before launch.
- Fresh runs are one-shot headless dsh sessions and are NOT resumable. Only `--session`, `--resume`, and `import` (broker paths) record resumable session ids.
- `--model`/`--effort` work on one-shot runs; a `--resume` keeps the broker's startup model. Plugin defaults when omitted: model `deepseek-v4-pro`, effort `max` (one-shot and broker alike).
- Agent mode defaults to `minimal` (one-line persona, bash + str_replace_editor for the whole run). `--mode standard` restores the full toolset from request #1; `--mode anchored-standard` shows the Minimal pair until this session records a tool call or assistant reply, then restores the full catalog. `DSH_CC_MODE` and the persisted `/dsh:setup --mode` default sit between flag and built-in. A live broker keeps its startup mode — a `--session` run resolving a different mode errors and names `/dsh:stop --broker`.
- `--background` returns immediately with a run id; the actual work continues in a detached worker. Poll `runs <id>`, fetch `show <id>`.
- `stop` kills processes; a mid-turn broker stop discards all in-memory dsh sessions for the workspace.
- Environment: `DSH_BINARY` overrides the dsh executable; `DSH_CC_SESSION_ID`/`DSH_CC_TRANSCRIPT_PATH` are exported by the SessionStart hook — never set them manually.

## Failure handling

- "dsh CLI is not installed" → point the user at `/dsh:setup` (or `/dsh:check` for the readiness report).
- "cc profile" errors on `--session`/`--resume`/`import` → point at `/dsh:setup`.
- "broker is busy" → one run at a time per workspace; wait or `stop --broker`.
- Structured critique that reports "unstructured output" still contains the raw review text; show it.
