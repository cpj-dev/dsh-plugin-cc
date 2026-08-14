# State and jobs

All durable bridge state lives under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash16(realpath)>/` (fallback when unset: `<tmpdir>/dsh-cc-runs/...`). The directory is keyed by workspace root (git toplevel), so parallel repositories never share state. Layout:

```
state.json         job index (projection; bounded at 50, oldest pruned)
state.json.lock    wx-created lock file guarding every read-modify-write
jobs/<id>.json     full job record, incl. the queued run request for workers
jobs/<id>.log      timestamped progress + outcome lines
overlays/          generated per-run model overlays (--patch inputs)
broker/            broker pid/info files (the socket lives in tmpdir; see broker.md)
```

## Job record essentials

`id` (`run-a1b2c3d4`-style), `kind`/`jobClass` (`review` | `critique` | `task` | `import`), `title`, `summary`, `write`, `status`, `phase`, `sessionId` (Claude session that started it), `broker` (true for `--session`/`--resume`/import runs), `dshSessionId` (the broker session id — minted and recorded at job creation for broker-backed runs, so `stop` can identify an in-flight broker turn), `dshSessionGeneration` (the broker runtime generation that answered — persisted only on successful completion; resume candidacy requires it, see [broker.md](broker.md)), `pid`/`agentPid`/`bridgePid`, `logFile`, timestamps, `errorMessage`, and — on finished jobs — `result: { rendered, summary, payload }` so `/dsh:show` replays output without re-running anything.

## Lifecycle

```
(foreground)  running ──► completed | failed
(background)  queued ──► running ──► completed | failed
(any active)  ──► cancelled   (stop command or SessionEnd hook)
(any active with all pids dead) ──► rendered as `stale` by list/status views
```

Terminal transitions go through `claimJobTerminal`, which re-checks the status under the lock — the worker finishing, a user `stop`, and the SessionEnd cleanup can race, and exactly one claimant wins. Process kills happen only after winning the claim (a lost claim means the pids may already belong to unrelated processes), escalate SIGTERM→SIGKILL, and wait for confirmed death before returning. Explicitly `stop`ping an already-terminal job is refused outright; a `stale` job is claimed without signalling its dead pids.

## Background execution

`--background` writes the full run request into the job file with status `queued`, then re-spawns the bridge detached as `run-worker --job-id <id>`. The worker reloads the request, re-attaches the log/progress plumbing, and executes the same code path a foreground run uses. Claude Code can exit; the worker keeps running.

## Session scoping

The SessionStart hook exports `DSH_CC_SESSION_ID`; jobs record it, and `runs` filters to the current session by default (`--all` lifts the filter; jobs recorded without a session id are visible everywhere). SessionEnd cancels the session's still-active jobs — claim-gated like `stop`: a lost claim means the job finished first and its pids are never signalled — then removes the session's records via `removeJobsBySession`, which runs under the state lock (so concurrent workers' writes survive) and unlinks the removed jobs' `jobs/<id>.json` and `.log` files. The broker deliberately survives SessionEnd — its dsh sessions are workspace-scoped, not Claude-session-scoped.
