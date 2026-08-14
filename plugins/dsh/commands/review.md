---
description: Review local changes (read-only) / 以只读模式审查本地改动
allowed-tools: ["Bash"]
---

Run a DeepSeek Harness code review of the local changes. The bridge resolves the target automatically: dirty working tree → uncommitted changes; clean tree → branch diff against the default base.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" review "$ARGUMENTS"
```

Argument handling:
- Free text becomes the review focus (e.g. `/dsh:review concurrency in the session store`).
- `--base <ref>` reviews the branch diff against that ref; `--scope working-tree|branch` forces a side.
- `--model <name>` / `--effort low|medium|high|max` select the model for this run (defaults: `deepseek-v4-pro` at effort `max`).
- `--background` queues the review and returns a run id; check it later with `/dsh:runs`.

The run is read-only and can take several minutes; prefer `--background` when the user wants to keep working. Present the review output verbatim, then add your own judgement only if the user asks.
