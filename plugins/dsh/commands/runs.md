---
description: List or inspect workspace runs / 列出或查看工作区任务
allowed-tools: ["Bash"]
---

List runs (newest first), or show one run's status when the user names an id:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" runs "$ARGUMENTS"
```

`--all` includes runs from other Claude sessions in this workspace. Present the listing verbatim; suggest `/dsh:show <run-id>` for finished runs and `/dsh:stop <run-id>` for stuck ones.
