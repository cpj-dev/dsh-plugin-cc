---
description: Adversarial design critique (read-only) / 对本地改动进行只读对抗式设计评审
allowed-tools: ["Bash"]
---

Run an adversarial design critique (structured JSON findings) of the local changes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" critique "$ARGUMENTS"
```

Argument handling is the same as `/dsh:review` (`--base`, `--scope`, `--model`, `--effort`, `--background`, free text = focus).

The critique attacks the approach — wrong abstraction, hidden coupling, failure modes — not just diff hygiene. Present the rendered findings verbatim. If the output says "unstructured output", the model failed the JSON contract; the raw text is still shown and still useful.
