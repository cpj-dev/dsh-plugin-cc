---
description: Install Harness and the cc profile / 安装 Harness 并创建 cc profile
allowed-tools: ["Bash"]
---

Run the setup and show the user the resulting readiness report verbatim. First run installs and builds the harness — use a long Bash timeout (10 minutes) or run it in the background, and tell the user it is building:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" setup "$ARGUMENTS"
```

What it does, end to end (each step skipped when already done — rerunning is a no-op):

1. **Get dsh.** The CLI is on npm as `@deepseek-ai/dsh`, but this plugin still clones a pinned source checkout: the cc profile's SDK JSON-RPC server is published separately and is not in the CLI dependency tree. With no arguments, setup clones the harness (pinned to the commit this plugin was verified against) into the plugin's data directory, runs `pnpm install` + `pnpm run build:lib`, writes a wrapper, and persists it — after this, every `/dsh:*` command on this machine finds dsh with zero environment setup. `--harness <checkout-path>` uses an existing checkout instead (the user then controls its location and version). Requirements checked for you: `git` (auto-clone only), Node >= 22.19 (harness floor; the plugin itself needs only >= 20), and `pnpm` (suggest `corepack enable` when missing).
2. **The `cc` profile** for multi-turn sessions: dsh-base + the SDK JSON-RPC server (installed from the checkout by absolute path), approval `never`, verified via `--dump-config`. One-shot commands (`/dsh:review`, `/dsh:critique`, fresh `/dsh:run`) work without it; `--session`, `--resume`, and `/dsh:import` need it.

After setup, the only remaining prerequisite is a `DEEPSEEK_API_KEY` (env var, `$DSH_HOME/.credentials.yaml`, or `.env`) — the report's next steps say so when it is missing.

`--skip-build` refuses instead of building when the checkout is not ready (for users who insist on building manually).
