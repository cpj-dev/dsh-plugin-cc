# Troubleshooting

[English](troubleshooting.md) | [简体中文](zh-CN/troubleshooting.md)

Start with `/dsh:check`. It is read-only and reports the exact missing prerequisite plus the next action.

## Setup cannot find or build DeepSeek Harness

- **No `dsh` and no checkout:** run `/dsh:setup`. It clones the verified commit into the plugin data directory, builds it, writes a wrapper, and persists that path.
- **Existing checkout:** run `/dsh:setup --harness <absolute-path>`. The directory must be a DeepSeek Harness checkout.
- **Existing `DSH_BINARY`, missing `cc` profile:** run `/dsh:setup`. A source checkout is still required because setup installs the separately published SDK JSON-RPC server (`@deepseek-ai/dsh-sdk-jsonrpc-server`, outside the CLI dependency closure) from the pinned checkout.
- **Node version error:** plugin commands need Node >= 20, but building DeepSeek Harness needs Node >= 22.19.
- **`pnpm` missing:** enable Corepack with `corepack enable`, or install a compatible `pnpm`, then rerun setup.
- **Pinned checkout fails:** setup stops instead of continuing on an unverified branch. Resolve the Git error and rerun; do not bypass the pin for a release installation.

## Credentials are not ready

Provide `DEEPSEEK_API_KEY` through the environment, `$DSH_HOME/.credentials.yaml`, or a local `.env`. Never commit credentials; `.env` files are ignored, while sanitized `.env.example` files may be tracked.

Run `/dsh:check` again after changing credentials. The bridge reports where credentials were found, but never prints the secret.

## The `cc` profile is missing or broken

Run `/dsh:setup` again. Setup is idempotent: it repairs the SDK server link and managed profile patch, then verifies the composed profile with `--dump-config`.

If using a custom checkout, pass the same `--harness <path>` again so setup can locate `packages/sdk/server`.

## Resume is refused

Resumable sessions live only inside the current broker runtime. If the broker was stopped, crashed, or restarted, old session IDs are deliberately rejected rather than silently opening a new session.

Start a fresh session with:

```text
/dsh:run --session <task>
```

## A broker run is stuck

1. Inspect it with `/dsh:runs <run-id>`.
2. Stop the run with `/dsh:stop <run-id>`.
3. If the broker remains busy, use `/dsh:stop --broker`.

Stopping the broker discards all in-memory dsh sessions for that workspace. Use it only when losing resumability is acceptable.

## A run times out

`--timeout-ms` controls the broker-side turn deadline. A timeout releases the broker for another request, but DSH may still be working internally because the wire protocol has no per-turn cancel. Use `/dsh:stop --broker` when the underlying turn must be terminated.

## Collecting diagnostic information

Before opening a bug report, include:

- output from `/dsh:check` with secrets removed;
- the exact `/dsh:*` command and flags;
- Node, operating system, plugin, and dsh versions;
- the run ID and relevant job log excerpt;
- whether the problem reproduces with the pinned harness commit.

Use the repository's bug report form. Security-sensitive logs belong in a private vulnerability report, not a public issue.
