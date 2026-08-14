# Command reference

[English](commands.md) | [简体中文](zh-CN/commands.md)

Every `/dsh:*` command maps to one `dsh-bridge.mjs` subcommand; the markdown files under `plugins/dsh/commands/` only carry invocation wording and presentation guidance. This page is the authoritative flag reference. All commands accept `--json` (machine payload instead of rendered text) and `--cwd <dir>`.

## `/dsh:check` → `check`

Readiness probe: node, the `dsh` binary (resolution: `DSH_BINARY` env → persisted config from `setup --harness` → PATH; the report names the source), the configured source checkout's health (path, version/commit, installed/built), harness Node-floor compliance (>= 22.19), credentials (env / `$DSH_HOME/.credentials.yaml` / `.env`), the multi-turn `cc` profile, and the broker. Read-only; never installs anything. `ready` covers the one-shot path; `multiTurnReady` covers `--session`/`--resume`/`import`.

## `/dsh:setup` → `setup`

| Flag | Meaning |
|---|---|
| *(none)* | one-command install when no usable source checkout is configured: clone the harness — **pinned to the verified commit** (`HARNESS_PINNED_COMMIT` in `lib/dsh.mjs`; the harness promises breaking changes, so "latest" is unsafe) — into the plugin data dir (or repair the previously configured checkout), then build and link as below. A `dsh` found through `DSH_BINARY` or PATH does not remove the source requirement for creating the `cc` profile |
| `--harness <checkout-path>` | use an existing DeepSeek Harness checkout instead of cloning: validate it, run `pnpm install` / `pnpm run build:lib` when missing (progress on stderr), write a node wrapper, persist it as this machine's dsh (`config.json`: `dshBinary`, `harnessCheckout`) |
| `--skip-build` | refuse instead of building when the checkout is not installed/built |

There is no npm distribution of the harness; source install is the only path (auto-clone needs `git`; building needs Node >= 22.19 and pnpm — `corepack enable`). Independently of the install, every run creates and verifies the `cc` profile: `dsh plugin --profile cc add <checkout>/packages/sdk/server` when missing (absolute path → pnpm `link:`, registry-free; the SDK server only exists inside a checkout), appends a managed patch block (marker `# managed by dsh-plugin-cc`: `hmr` disabled, `approval.policy: never`, the JSON-RPC server row), then verifies with `--dump-config`. Idempotent.

## `/dsh:review` → `review`, `/dsh:critique` → `critique`

| Flag | Meaning |
|---|---|
| free text | review/critique focus |
| `--base <ref>` | branch review against this ref (default: detected origin HEAD / main / master) |
| `--scope auto\|working-tree\|branch` | target selection; `auto` prefers a dirty working tree |
| `--model <name>`, `--effort low\|medium\|high\|max` | per-run model overlay |
| `--background` | queue and return a run id; `--wait` forces foreground |

Both run one-shot headless with the read-only sandbox. `review` returns free-form review text; `critique` uses the adversarial prompt plus `schemas/review-output.schema.json` and renders parsed findings (falling back to raw text when the model breaks the JSON contract).

A nonexistent `--base` errors up front ("Unknown base ref"), before any background job is enqueued; a target with genuinely no changes refuses with "Nothing to review" instead of running the model against an empty diff; a failing diff (e.g. unrelated histories) surfaces the git error.

## `/dsh:run` → `run`, `/dsh:delegate`

| Flag | Meaning |
|---|---|
| free text / `--prompt-file <path>` / piped stdin | the task |
| `--write` | workspace-write sandbox (default read-only) |
| `--session` | run through the broker; records a resumable dsh session id |
| `--resume`, `--resume-last` | continue the latest recorded dsh session (empty prompt = "continue"); validated against the live broker's runtime generation — a stopped or restarted broker/runtime yields an explicit error, never a silent fresh session |
| `--fresh` | force the one-shot path |
| `--model`, `--effort` | one-shot runs only; a resume keeps the broker's startup model |
| `--background` | detached execution, returns a run id |
| `--timeout-ms <n>` | broker-run turn timeout, forwarded to the broker so it frees itself on expiry (default 20 minutes; must be a positive integer, rejected otherwise) |

`/dsh:delegate` is `/dsh:run --background --write` shaped for handing off substantial tasks, preferring the `dsh-delegate` subagent. `run-resume-candidate` reports whether a resumable session exists (used by commands before suggesting `--resume`).

## `/dsh:import` → `import`

Weak import: compresses the Claude transcript (explicit `--source <jsonl>`, else the hook-recorded path, else the newest transcript for this project) into a bounded digest and starts a resumable broker session seeded with it. Continue with `/dsh:run --resume`. `--write` grants the imported session workspace-write.

## `/dsh:runs` → `runs`, `/dsh:show` → `show`

`runs` lists this Claude session's jobs newest-first (`--all` for the whole workspace); `runs <id>` shows one job's live status, reconciling recorded `running` against actual pid liveness (dead pids render as `stale`). `show [id]` replays the stored rendered result of a finished run (default: most recent finished).

## `/dsh:stop` → `stop`

`stop [id]` claims the job's terminal state and only then kills its process tree (default: newest active job). Referencing a finished run errors with "already finished" — its recorded pids may belong to unrelated processes by now and are never signalled; losing the terminal-claim race to a concurrent writer is reported the same way. A `stale` job (recorded running, pids dead) is marked cancelled without signalling anything. There is no per-turn cancel on the DSH wire; when the stopped job is broker-backed (`--session`/`--resume`/import, identifiable from job creation) and the broker is busy, the broker is stopped first, discarding all in-memory dsh sessions for the workspace. `stop --broker` stops the broker explicitly.
