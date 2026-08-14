# Architecture

The plugin is an external-CLI bridge, the same shape as the Codex and Grok Build Claude Code plugins: Claude Code slash commands run one Node script (`dsh-bridge.mjs`), and that script drives DeepSeek Harness. Nothing in this repo modifies DSH; every capability composes from DSH's public CLI and SDK wire protocol.

## Two drive paths

```
Claude Code slash command / dsh-delegate agent
        │
        ▼
scripts/dsh-bridge.mjs  (subcommand dispatcher; stdout = user-facing result)
        │
        ├── one-shot path ──► spawn: dsh --profile headless
        │                       --patch <generated unattended overlay (per mode)>
        │                       [--patch <generated model overlay>] -- "<prompt>"
        │                       env DSH_PERMISSION_MODE=read-only|workspace-write
        │                     (review, critique, fresh run, import digest source)
        │
        └── multi-turn path ─► scripts/dsh-broker.mjs (per-workspace daemon, unix socket)
                                  │ owns
                                  ▼
                               dsh --profile cc --patch <generated unattended overlay>
                                  (dsh-base + SDK JSON-RPC server on stdio)
                                  sessions get-or-created by sessionId inside this
                                  one live process (run --session/--resume, import)
```

**One-shot** is the default because it is crash-isolated and needs no setup: each invocation is a complete DSH session that exits with the final assistant message on stdout. **Multi-turn** exists only because headless sessions cannot continue across processes and SDK sessions live inside one runtime (see [Headless profile](dsh-compat.md#headless-profile) and [SDK wire protocol](dsh-compat.md#sdk-wire-protocol-dsh-sdk-jsonrpc-server--protocol-package)); the broker keeps one SDK runtime alive per workspace and routes prompts to it by session id.

## Decisions forced by DSH facts

Each of these is a design decision downstream of a verified DSH behavior (all pinned in [dsh-compat.md](dsh-compat.md)):

- **A generated unattended overlay on every dsh spawn (one-shot AND broker runtime).** The dsh-base approval policy is `ask`, which fails closed with no approval answerer composed — and dsh-base's permission-presets service refuses to boot when the composed sandbox+approval pair names no preset, and pins the default preset's knobs into fresh sessions. The bridge therefore generates a per-mode overlay (`approval.policy: never` plus a single `unattended` preset exactly matching the launch mode) instead of shipping a static file; the sandbox mode (via `DSH_PERMISSION_MODE`) remains the real safety boundary.
- **Model selection is a generated `--patch` overlay.** Headless has no `--model` flag; model/effort live in the `agent-default-model` and `llm-deepseek` config rows, and `--patch` is the last composition layer, so a temp overlay wins deterministically.
- **The broker hand-rolls the SDK wire client.** The protocol is three requests and four notifications over newline JSON-RPC; embedding ~150 lines keeps the plugin dependency-free (both reference plugins made the same call). The run-to-idle algorithm is a direct port of the TypeScript SDK's `HarnessSession.run`: wait for the prompt's `agent/inbox/spliced` receipt, collect `session.event`s, stop at `session.status: idle`, extract the last `assistant/message` text.
- **Stop = kill.** The SDK wire has no cancel or session-close method; aborting a mid-turn broker run means killing the runtime, which discards its in-memory sessions. The bridge makes this explicit rather than pretending to cancel.
- **Structured critique output is prompt-contract, not API.** DSH has no structured-output flag, so the JSON schema is embedded in the prompt and the parser tolerates bare JSON, fenced blocks, and brace-span extraction, falling back to raw text.
- **Review targeting lives in the plugin.** The bridge resolves working-tree vs branch scope and collects bounded diff context itself, then hands DSH a self-contained prompt — DSH needs no git awareness beyond reading files.
- **Default install is the pinned npm CLI; the SDK JSON-RPC server is added separately with its published peers.** `@deepseek-ai/dsh` does not depend on `@deepseek-ai/dsh-sdk-jsonrpc-server`, and the launcher's `$DSH_HOME/profiles/node_modules` self-heal does not provide the server's peerDependencies (a server-only add fails at boot with `Cannot find package '@deepseek-ai/dsh-sdk-protocol'`). Setup therefore `plugin add`s the pinned server plus `HARNESS_SDK_JSONRPC_PEER_SPECS`. Dist-tags are unsafe (`latest` of the server is not the CLI's `latest`). `--harness` still `link:`-installs `packages/sdk/server` from a user-built checkout. The persisted `sdkProfileVersion` is the install identity (`npm:<pin>` or `harness:<realpath>`), so switching source re-adds the server instead of keeping the previous profile plugins.

## Process model

- `dsh-bridge.mjs` runs per command invocation and exits. Foreground runs block until DSH finishes; `--background` writes the job record + queued request to disk and re-spawns itself detached as `run-worker`.
- `dsh-broker.mjs` is spawned detached on first `--session`/`--resume`/`import` and survives Claude sessions. One broker per workspace state dir; one run in flight at a time (busy answers RPC code `-32001`).
- The SessionStart hook exports `DSH_CC_SESSION_ID` and `DSH_CC_TRANSCRIPT_PATH` through `CLAUDE_ENV_FILE`; SessionEnd cancels the session's still-active jobs. Jobs are scoped per Claude session for listing but stored per workspace (see [state-and-jobs.md](state-and-jobs.md)).

## Layering inside scripts/

- `dsh-bridge.mjs` — dispatch, argument surface, job orchestration. Knows nothing about DSH argv details.
- `lib/dsh.mjs` — the only file that composes DSH invocations (binary resolution, headless argv, overlays, output parsing, profile probes).
- `lib/broker-client.mjs` — the only file that talks to the broker socket.
- `lib/git.mjs`, `lib/claude-session-transfer.mjs` — context collection (git diffs, transcript digests).
- `lib/state.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs` — durable job state and lifecycle.
- `lib/render.mjs` — all user-facing text.

Keeping DSH knowledge inside `dsh.mjs` and `dsh-broker.mjs` means a DSH upgrade audit touches exactly two files plus [dsh-compat.md](dsh-compat.md).
