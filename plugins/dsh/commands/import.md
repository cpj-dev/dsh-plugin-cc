---
description: Import context into a resumable session / 将当前上下文导入可恢复会话
allowed-tools: ["Bash"]
---

Transfer the current conversation into DeepSeek Harness:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" import "$ARGUMENTS"
```

What this does (be transparent with the user):
- Compresses this session's transcript into a bounded text digest (this is a **weak import** — DSH cannot replay Claude history natively).
- Starts a resumable broker-backed dsh session seeded with that digest; dsh replies with its understanding and proposed next steps.
- Afterwards the user continues with `/dsh:run --resume <follow-up>`.

Options: `--source <path.jsonl>` imports a specific transcript instead of the current one. Requires `/dsh:setup` to have been run once.
