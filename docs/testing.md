# Testing

## Automated (`npm test`)

`npm test` (= `node scripts/run-tests.mjs`, which expands `tests/*.test.mjs` and runs `node --test` on that list) — pure-Node tests, no network, no real dsh, no API key. The expander exists because Windows cmd does not expand globs and Node 20's test runner does not either; a quoted or unquoted `tests/*.test.mjs` in package.json would look for a literal filename on windows-latest Node 20.

- `args.test.mjs` — argv parsing and raw `$ARGUMENTS` splitting.
- `state.test.mjs` — state dir resolution, job upsert/prune (incl. log-file cleanup), terminal-claim races (single winner), and the SessionEnd-vs-writer concurrency race (`session-cleanup-writer.mjs` fixture).
- `dsh.test.mjs` — headless argv composition, model overlay YAML, mode overlays (minimal disable list + shared bootstrap insert, anchored-standard bootstrap insert without tool disables), structured-output parsing, a full `runHeadlessAgent` round-trip against the fake dsh fixture, binary-resolution order (env → npm-pin / harness / config → PATH), and source-checkout inspection. Spawn argv is `node` + the JS CLI entry, never a `.cmd` and never `shell: true`.
- `spawn.test.mjs` — CVE-2024-27980 contract: rewrite a `.cmd` shim to `node` + JS; POSIX wrapper parse; persisted `{ dshNode, dshBinJs }`; `runCommand` / `binaryAvailable` against a fake `.cmd`; refuse `node.cmd` as the Node executable; a headless run against a fake `.cmd` DSH_BINARY. On windows-latest, a live `spawnSync(.cmd)` without shell documents Node's `EINVAL`.
- `request-snapshot.test.mjs` / `tool-bootstrap.test.mjs` — assemble/request snapshot reducer and the bootstrap filter (promotion, per-session isolation, assemble-time phase freeze vs persist-then-execute — 0.1.1-rc.2 still this shape — outermost assemble post-transform, pre-step strip, hidden-tool `deny`, filter-failure fallback, pre-step + `request/header` JSONL recorder against the EpochHeader shape `{ config, tools }`, which 0.1.1-rc.2 still uses) against a fake Cordis ctx; no real dsh.
- `setup.test.mjs` — `setup` npm-prefix install + registry SDK-server specs against a fake npm/dsh, `--harness` link of a built checkout (absolute-path SDK-server install), refusal of unbuilt / SDK-less checkouts, migration of pre-npm source configs, npm → `--harness` and checkout A → B profile switches, external `DSH_BINARY` profile repair (no npm prefix, including an already-ready profile), stale npm-pin reinstall and failed-refresh retry (CLI + `sdkProfileVersion` identity `npm:<pin>` / `harness:<realpath>`), and `check`'s source reporting plus stale pin/identity unreadiness (skipped on Node < 22.19, the harness floor).
- `git.test.mjs` — review-target resolution (incl. bad `--base` refusal), context collection, and the empty-diff vs failed-diff distinction on throwaway git repos.
- `process.test.mjs` — `terminateProcessTree` death confirmation (SIGTERM-ignoring child, descendant trees).
- `job-control.test.mjs` — `stop` target resolution: terminal refusal, stale reconciliation.
- `stop.test.mjs` — bridge-level stop semantics: finished-run refusal (PID-reuse regression), kill+cancel, stale cleanup, and in-flight broker-turn abort.
- `broker.test.mjs` — broker session continuity, timeout freeing, concurrent-startup convergence, stale-lock reclaim, socket-ownership rules, and mode-overlay composition (minimal disable list, standard none, anchored-standard bootstrap insert) against the fake SDK runtime.
- `resume.test.mjs` — resume continuity plus explicit refusal after broker stop/restart (generation checks), `--timeout-ms` validation/forwarding.
- `docs.test.mjs` — local Markdown link integrity, required community-health files (including LICENSE and NOTICE), NOTICE license labels, reciprocal English/Chinese entry links, and the public/private documentation ignore boundary.

Fixtures: `fake-dsh-fixture.mjs` (records argv/env, prints canned output — point `DSH_BINARY` at the `.mjs` file; spawn prefixes `node`), `fake-sdk-runtime.mjs` (speaks the SDK wire protocol; prompt directives `hang` and `sleep:<ms>` drive timeout tests), `ensure-broker-child.mjs` and `session-cleanup-writer.mjs` (child processes for real cross-process races), `helpers.mjs` (temp dirs, env isolation, `writeFakeRuntimeCli`).

The GitHub Actions `test` matrix is `ubuntu-latest`, `macos-latest`, and `windows-latest` × Node 20 and 22 (`fail-fast: false`). Broker, resume, and `terminateProcessTree` tests skip on Windows (unix sockets / `pgrep`). The windows-latest job is the proof that `.cmd` spawn throws `EINVAL` and that the plugin path does not.

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
13. Wire snapshot for `--mode anchored-standard` on a **new** session (set `DSH_CC_SNAPSHOT_FILE` and/or read session JSONL `request/header` — do not use `--dump-config` as a wire test). The JSONL recorder writes after `agent/pre-step` (`source: "pre-step"`) and once per step at `step/end` (`source: "request"`, carrying that step's wire header — 0.1.1-rc.2 still emits `request/header` only when the header *changes*, so a per-event line would skip every steady-state step). Assemble-time empty `contextSourceKinds` is **not** a pass — those injections happen at pre-step. 0.1.1-rc.2 still stores `model` / `maxTokens` / `reasoningEffort` on `event.data.header.config` (`EpochHeader`), not on the header root; `header.tools` is the wire catalog.
    - First `pre-step` / `request` line: `systemTexts` is the one RL sentence (`You are a helpful software engineer assistant.`), `contextSourceKinds` is empty, `toolNames` is `bash` + `str_replace_editor`, and the `request` line has non-null `model` / `maxTokens` / `reasoningEffort`.
    - After the first tool call, the **next** `pre-step` and `request` lines show the full dsh-base catalog — not the previous header's two tools.
    - After a text-only first assistant reply (typical of `/dsh:import`), the next user turn is already promoted.
    - `--resume` on that session stays promoted (no re-anchor).
14. Two concurrent `--session` runs in the same broker with `--mode anchored-standard` (different sessions): promoting A must not widen B's first request.
15. `--mode minimal` on the same "name every tool you can call" prompt must **not** promote (still two tools after a reply). `--mode standard` still names the full set from request #1. With `DSH_CC_SNAPSHOT_FILE` set, a multi-step minimal run writes one `pre-step` **and** one `request` line per step, every one of them naming exactly the pair.
    - **Boot smoke first, before anything about catalogs**: `/dsh:run "reply OK"` under each of `--mode minimal` and `--mode anchored-standard`, one-shot **and** `--session`. Both modes insert `tool-bootstrap.mjs`, so a mount-time mistake in it is a *boot* failure — `dsh: plugin tree failed to load: … cc-tool-bootstrap …` before request #1 — and it takes review, critique, and every session with it. Item 17's `--dump-config` probe cannot see this (see below).
16. Read-only sandbox still blocks writes under `anchored-standard` in both phases (bootstrap pair and post-promotion catalog).
17. Loader probe (composition, not wire, **and not execution**): `dsh --profile headless --patch <generated mode-anchored-standard.yml> --dump-config` must compose. If the insert `name` absolute path fails, the overlay already copies `tool-bootstrap.mjs` into that run's `overlays/` — retry that copied path before considering `dsh plugin add`. This probe resolves the row; it never calls the plugin's `apply()`. Verified: an inserted plugin whose `apply()` throws on the first line still exits 0 here. Only item 15's boot smoke covers mount-time failures.

Record the dsh version used at the top of the release notes; it must match the [dsh-compat.md](dsh-compat.md) pin.
