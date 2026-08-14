---
description: Check bridge readiness / 检查 dsh、凭据、profile 和 broker 是否就绪
allowed-tools: ["Bash"]
---

Run the readiness probe and show the user the result verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" check
```

If the report says "not ready", relay the listed next steps. Do not attempt to install anything yourself unless the user asks; when `dsh` is missing entirely, the fix is a single command — `/dsh:setup` clones (pinned), builds, and links DeepSeek Harness automatically. Users with their own checkout can pass `/dsh:setup --harness <path>` instead. The CLI also exists as `@deepseek-ai/dsh` on npm; this plugin still uses a pinned source checkout because the cc profile's SDK server is outside that package's dependency closure.
