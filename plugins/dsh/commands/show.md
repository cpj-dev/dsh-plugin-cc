---
description: Show a stored run result / 查看已保存的任务结果
allowed-tools: ["Bash"]
---

Show the stored result of a run (defaults to the most recently finished one):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" show "$ARGUMENTS"
```

Present the stored output verbatim. If the run is still active, point the user to `/dsh:runs` instead.
