---
description: Delegate a task in the background / 在后台委派大型任务
allowed-tools: ["Bash", "Task"]
---

Delegate the described task to DeepSeek Harness. For substantial tasks, prefer the `dsh-delegate` subagent (it manages the run lifecycle without cluttering this conversation). For quick tasks, call the bridge directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" run --background --write "$ARGUMENTS"
```

Rules:
- Include `--write` only when the task is supposed to modify files; omit it for analysis/investigation tasks.
- Immediately relay the returned run id to the user, then continue with other work.
- Check progress with `/dsh:runs <run-id>` and fetch the result with `/dsh:show <run-id>` when it finishes.
