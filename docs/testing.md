# Testing

## Automated (`npm test`)

`npm test` (= `node --test tests/*.test.mjs`) — pure-Node tests, no network, no real dsh, no API key. The glob is left unquoted so the shell expands it: Node 20's test runner does not expand globs and would otherwise look for a literal `tests/*.test.mjs` file.

- `args.test.mjs` — argv parsing and raw `$ARGUMENTS` splitting.
- `state.test.mjs` — state dir resolution, job upsert/prune (incl. log-file cleanup), terminal-claim races (single winner), and the SessionEnd-vs-writer concurrency race (`session-cleanup-writer.mjs` fixture).
- `dsh.test.mjs` — headless argv composition, model overlay YAML, mode overlays (minimal disable list + shared bootstrap insert, anchored-standard bootstrap insert without tool disables), structured-output parsing, a full `runHeadlessAgent` round-trip against the fake dsh fixture, binary-resolution order (env → npm-pin / harness / config → PATH), and source-checkout inspection.
- `request-snapshot.test.mjs` / `tool-bootstrap.test.mjs` — assemble/request snapshot reducer and the bootstrap filter (promotion, per-session isolation, pre-step strip, hidden-tool guard, filter-failure fallback, optional JSONL recorder) against a fake Cordis ctx; no real dsh.
- `setup.test.mjs` — `setup` npm-prefix install + registry SDK-server specs against a fake npm/dsh, `--harness` link of a built checkout (absolute-path SDK-server install), refusal of unbuilt / SDK-less checkouts, migration of pre-npm source configs, npm → `--harness` and checkout A → B profile switches, external `DSH_BINARY` profile repair (no npm prefix, including an already-ready profile), stale npm-pin reinstall and failed-refresh retry (CLI + `sdkProfileVersion` identity `npm:<pin>` / `harness:<realpath>`), and `check`'s source reporting plus stale pin/identity unreadiness (skipped on Node < 22.19, the harness floor).
- `git.test.mjs` — review-target resolution (incl. bad `--base` refusal), context collection, and the empty-diff vs failed-diff distinction on throwaway git repos.
- `process.test.mjs` — `terminateProcessTree` death confirmation (SIGTERM-ignoring child, descendant trees).
- `job-control.test.mjs` — `stop` target resolution: terminal refusal, stale reconciliation.
- `stop.test.mjs` — bridge-level stop semantics: finished-run refusal (PID-reuse regression), kill+cancel, stale cleanup, and in-flight broker-turn abort.
- `broker.test.mjs` — broker session continuity, timeout freeing, concurrent-startup convergence, stale-lock reclaim, socket-ownership rules, and mode-overlay composition (minimal disable list, standard none, anchored-standard bootstrap insert) against the fake SDK runtime.
- `resume.test.mjs` — resume continuity plus explicit refusal after broker stop/restart (generation checks), `--timeout-ms` validation/forwarding.
- `docs.test.mjs` — local Markdown link integrity, required community-health files (including LICENSE and NOTICE), NOTICE license labels, reciprocal English/Chinese entry links, and the public/private documentation ignore boundary.

Fixtures: `fake-dsh-fixture.mjs` (records argv/env, prints canned output — point `DSH_BINARY` at a wrapper for it), `fake-sdk-runtime.mjs` (speaks the SDK wire protocol; prompt directives `hang` and `sleep:<ms>` drive timeout tests), `ensure-broker-child.mjs` and `session-cleanup-writer.mjs` (child processes for real cross-process races), `helpers.mjs` (temp dirs, env isolation).

Tests set `CLAUDE_PLUGIN_DATA` to a per-test temp dir; never let a test touch the real state root.

## What automation deliberately does not cover

Real model behavior, profile installation, and the broker's live SDK handshake need a real `dsh` + `DEEPSEEK_API_KEY`. Those are manual acceptance, not CI.

## Manual acceptance checklist (run against the pinned dsh before release)

In a scratch git repo with the plugin installed:

1. `/dsh:check` → ready (or accurate next steps when deliberately unconfigured).
2. `/dsh:review` on a dirty tree → review text; repo files unmodified (reviews always run the read-only sandbox).
3. `/dsh:critique` → parsed findings render (or a graceful "unstructured output" fallback).
4. `/dsh:run --background "summarize this repo"` → run id immediately; `/dsh:runs` shows running → completed; `/dsh:show` replays the result.
5. `/dsh:setup` → cc profile composes; rerun is a no-op.
6. `/dsh:run --session "create NOTES.md with 3 bullets" --write` → file created, session id in footer.
7. `/dsh:run --resume "add a 4th bullet"` → same session continues (file grows).
8. `/dsh:import` → digest acknowledged; `/dsh:run --resume` continues with the imported context.
9. `/dsh:stop --broker` → broker gone; a later `--resume` errors explicitly ("no live broker holds it"), and after a new `--session` run the old session stays unreachable — never a silent fresh session reported as a resume.
10. Kill Claude Code mid-background-run → worker survives; a new session's `/dsh:runs --all` still finds it.
11. `/dsh:run "name every tool you can call"` → the answer names the full toolset (standard default: file/web search, skills, subagents). The same prompt with `--mode minimal` names only bash and `str_replace_editor`.
12. `/dsh:run --session "hi"` on a fresh workspace, then `/dsh:run --session --mode minimal "hi"` → explicit mode-mismatch error naming `/dsh:stop --broker`; after stopping, the minimal `--session` run works and `/dsh:check` shows the broker's mode.
13. Wire snapshot for `--mode anchored-standard` on a **new** session (set `DSH_CC_SNAPSHOT_FILE` or read session JSONL `request/header` — do not use `--dump-config` as a wire test):
    - First assemble: `systemTexts` is the one RL sentence (`You are a helpful software engineer assistant.`), `contextSourceKinds` is empty, `toolNames` is `bash` + `str_replace_editor`.
    - After the first tool call, the **next** header shows the full dsh-base catalog.
    - After a text-only first assistant reply (typical of `/dsh:import`), the next user turn is already promoted.
    - `--resume` on that session stays promoted (no re-anchor).
14. Two concurrent `--session` runs in the same broker with `--mode anchored-standard` (different sessions): promoting A must not widen B's first request.
15. `--mode minimal` on the same "name every tool you can call" prompt must **not** promote (still two tools after a reply). `--mode standard` still names the full set from request #1.
16. Read-only sandbox still blocks writes under `anchored-standard` in both phases (bootstrap pair and post-promotion catalog).
17. Loader probe (composition, not wire): `dsh --profile headless --patch <generated mode-anchored-standard.yml> --dump-config` must compose. If the insert `name` absolute path fails, the overlay already copies `tool-bootstrap.mjs` into that run's `overlays/` — retry that copied path before considering `dsh plugin add`.

Record the dsh version used at the top of the release notes; it must match the [dsh-compat.md](dsh-compat.md) pin.
