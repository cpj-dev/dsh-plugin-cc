---
description: Install Harness and the cc profile / 安装 Harness 并创建 cc profile
allowed-tools: ["Bash"]
---

Run the setup and show the user the resulting readiness report verbatim. First run installs the pinned npm CLI — use a long Bash timeout (10 minutes) or run it in the background, and tell the user it is installing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-bridge.mjs" setup "$ARGUMENTS"
```

What it does, end to end (each step skipped when already done — rerunning is a no-op):

1. **Get dsh.** Default: install `@deepseek-ai/dsh@<HARNESS_NPM_VERSION>` into the plugin data directory (`npm install --prefix`), write a wrapper pinned to Node >= 22.19, persist it. A persisted source install (old `harnessCheckout` / `dshInstall: harness`) is migrated to that pin. `--harness <checkout-path>` uses an already-built DeepSeek Harness checkout instead (the plugin does not run `pnpm install` / `build:lib`; `packages/sdk/server` must exist). A later no-args setup migrates back to npm. Requirements: Node >= 22.19 (harness floor; the plugin itself needs only >= 20), `npm` (default path), and `pnpm` for profile plugin add (`corepack enable` when missing). Do not follow npm `latest`/`next`.
2. **The `cc` profile** for multi-turn sessions: dsh-base + the SDK JSON-RPC server. Default path: `dsh plugin --profile cc add @deepseek-ai/dsh-sdk-jsonrpc-server@<pin>` **plus that package's published peerDependencies** (a server-only add cannot resolve `@deepseek-ai/dsh-sdk-protocol` at boot). `--harness` link:-installs `<checkout>/packages/sdk/server`. Approval `never`, verified via `--dump-config`. One-shot commands (`/dsh:review`, `/dsh:critique`, fresh `/dsh:run`) work without the profile; `--session`, `--resume`, and `/dsh:import` need it.

After setup, the only remaining prerequisite is a `DEEPSEEK_API_KEY` (env var, `$DSH_HOME/.credentials.yaml`, or `.env`) — the report's next steps say so when it is missing.
