# Command reference

[English](commands.md) | [简体中文](zh-CN/commands.md)

Every `/dsh:*` command maps to one `dsh-bridge.mjs` subcommand; the markdown files under `plugins/dsh/commands/` only carry invocation wording and presentation guidance. This page is the authoritative flag reference. All commands accept `--json` (machine payload instead of rendered text) and `--cwd <dir>`.

## `/dsh:check` → `check`

Readiness probe: node, the `dsh` binary (resolution: `DSH_BINARY` env → persisted config from `/dsh:setup` → PATH; the report names the source as `env` / `npm-pin` / `harness` / `config` / `path`), optional npm-prefix or source-checkout health, harness Node-floor compliance (>= 22.19), credentials (env / `$DSH_HOME/.credentials.yaml` / `.env`), the multi-turn `cc` profile, and the broker. The npm row is not ok when the persisted CLI pin differs from `HARNESS_NPM_VERSION`, when the prefix lost its `bin.js`, or when the managed wrapper is missing; the profile is not ready when `sdkProfileVersion` is not the identity for the current install (`npm:<pin>` or `harness:<realpath>`). Read-only; never installs anything. `ready` covers the one-shot path — it is false when a not-ok npm row describes the binary that path resolves to (source `npm-pin`), because that is the CLI those commands would run; a `DSH_BINARY`/PATH dsh is the user's own and is not judged against the pin. `multiTurnReady` covers `--session`/`--resume`/`import`.

## `/dsh:setup` → `setup`

| Flag | Meaning |
|---|---|
| *(none)* | one-command install: `npm install --prefix <plugin-data>/npm @deepseek-ai/dsh@<HARNESS_NPM_VERSION>`, wrap it as this machine's dsh, then create the `cc` profile. Also migrates a persisted source install (pre-npm `harnessCheckout`, or `dshInstall: harness`) to that pin. A `dsh` already found through `DSH_BINARY` or PATH skips the CLI install. Versions are exact pins — `latest`/`next` are not used |
| `--harness <checkout-path>` | use an existing **already built** DeepSeek Harness checkout: validate `apps/cli/lib/bin.js` and `packages/sdk/server` exist (the plugin does not run `pnpm install` / `build:lib`, and does not fall back to npm for a missing SDK server), write a node wrapper, persist `config.json` (`dshBinary`, `dshInstall: harness`, `harnessCheckout`). Only this flag keeps a source checkout; a later no-args setup migrates to npm |

`/dsh:setup` still has to `dsh plugin --profile cc add` `@deepseek-ai/dsh-sdk-jsonrpc-server@<pin>` **together with that package's published peerDependencies** — the server is outside the CLI dependency closure, and the launcher's profile self-heal does not provide the peers (a server-only add boots with `Cannot find package '@deepseek-ai/dsh-sdk-protocol'`). `--harness` instead `link:`-installs `<checkout>/packages/sdk/server`. Then setup appends a managed patch block (marker `# managed by dsh-plugin-cc`: `hmr` disabled, `approval.policy: never`, the JSON-RPC server row) and verifies with `--dump-config`. Needs Node >= 22.19 to run the harness, `npm` for the default CLI install, and `pnpm` for `dsh plugin add` (`corepack enable`). Idempotent when the CLI pin and profile identity are unchanged; a pin bump, npm → `--harness`, or checkout A → B re-adds the SDK-server plugins. `sdkProfileVersion` stores that identity (`npm:<pin>` or `harness:<realpath>`) and is written only after a successful `plugin add`, so a failed refresh is retried even if `--dump-config` already names the package.

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
