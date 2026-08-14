# Troubleshooting

[English](troubleshooting.md) | [简体中文](zh-CN/troubleshooting.md)

Start with `/dsh:check`. It is read-only and reports the exact missing prerequisite plus the next action.

## Setup cannot find DeepSeek Harness

- **No `dsh`:** run `/dsh:setup`. It installs `@deepseek-ai/dsh@<pin>` from npm into the plugin data directory, writes a wrapper, and creates the `cc` profile.
- **Existing built checkout:** run `/dsh:setup --harness <absolute-path>`. The directory must already be installed and built (`pnpm install && pnpm run build:lib`); the plugin will not compile it. A later no-args `/dsh:setup` migrates a persisted source install to the npm pin.
- **Existing `DSH_BINARY`, missing or stale `cc` profile:** run `/dsh:setup`. It adds `@deepseek-ai/dsh-sdk-jsonrpc-server@<pin>` and that package's published peers into the profile even if `--dump-config` already names the package (tracked as `sdkProfileVersion`: `npm:<pin>` or `harness:<realpath>`).
- **`/dsh:check` says the npm pin or cc profile is stale:** the persisted CLI version or profile identity does not match this plugin release (or the current `--harness` checkout). Rerun `/dsh:setup` (pass `--harness` again to keep a checkout).
- **Node version error:** plugin commands need Node >= 20; running DeepSeek Harness needs Node >= 22.19.
- **`npm` missing:** install Node (npm ships with it), then rerun setup.
- **`pnpm` missing:** enable Corepack with `corepack enable`, or install a compatible `pnpm`, then rerun setup. Profile plugin installation always needs pnpm.
- **Native addon failure (`sharp`, `node-pty`):** clear the npm cache for the plugin data prefix and rerun `/dsh:setup`, or use a built checkout via `--harness`.
- **Do not use `npx` as the long-lived binary** and do not follow npm dist-tags (`latest` of the SDK server is not the CLI's `latest`).

## Credentials are not ready

Provide `DEEPSEEK_API_KEY` through the environment, `$DSH_HOME/.credentials.yaml`, or a local `.env`. Never commit credentials; `.env` files are ignored, while sanitized `.env.example` files may be tracked.

Run `/dsh:check` again after changing credentials. The bridge reports where credentials were found, but never prints the secret.

## The `cc` profile is missing or broken

Run `/dsh:setup` again. Setup is idempotent: it repairs the SDK server link and managed profile patch, then verifies the composed profile with `--dump-config`.

If using a custom checkout, pass the same `--harness <path>` again so setup can locate `packages/sdk/server`. Otherwise setup repairs the profile from the pinned npm specs.

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
- whether the problem reproduces with the pinned npm version (`@deepseek-ai/dsh@` the version in [dsh-compat.md](dsh-compat.md)).

Use the repository's bug report form. Security-sensitive logs belong in a private vulnerability report, not a public issue.
