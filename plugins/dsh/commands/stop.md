---
description: Stop a run or shared broker / 停止任务或共享 broker
allowed-tools: ["Bash"]
---

Stop a run (defaults to the newest active one):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" stop "$ARGUMENTS"
```

Facts to keep in mind:
- Stopping kills the dsh process tree; the DSH SDK wire has no per-turn cancel.
- Stopping a broker-backed run that is mid-turn also stops the broker, which discards all in-memory dsh sessions for this workspace.
- `--broker` stops the shared broker explicitly (same session-loss caveat).
- Stopping an already-finished run errors out ("already finished") — that is correct behavior, not a failure to relay as a problem.

Warn the user about session loss before stopping a broker-backed run unless they clearly want it gone.
