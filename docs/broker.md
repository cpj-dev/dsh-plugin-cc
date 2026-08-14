# Broker internals

`scripts/dsh-broker.mjs` is a per-workspace daemon that makes multi-turn DSH sessions possible. It owns exactly one `dsh --profile cc` child (the DSH SDK JSON-RPC runtime) and exposes a line-JSON-RPC unix socket to the bridge. Pattern provenance: the Codex plugin's app-server broker.

## Why a daemon at all

The DSH SDK server get-or-creates agents by `sessionId` **inside one live process**; headless has no resume flag, and the wire has no session persistence. The only way `/dsh:run --resume` can work is to keep that process alive between Claude turns. See [dsh-compat.md](dsh-compat.md) for the verified facts.

## Files

- `<tmpdir>/dsh-cc-<workspace-hash>.sock` — the unix socket (removed on shutdown). It lives in tmpdir, not the state dir, because macOS limits `sun_path` to ~104 bytes and `CLAUDE_PLUGIN_DATA`-based paths exceed it.
- `broker/broker.pid` (state dir) — daemon pid, written only after the socket is bound (the pid file must never name a daemon that does not own the socket)
- `broker/broker.json` (state dir) — pid, socket path, provider/model, permission mode, `lastSessionId`, start time
- `broker/broker.starting` (state dir) — O_EXCL startup lock held by the `ensureBroker` caller that is spawning the daemon; contains `{ pid, startedAt }`

## Socket protocol (bridge ↔ broker)

Line-delimited JSON with `id`/`method`/`params` → `result`/`error`:

| Method | Params | Result |
|---|---|---|
| `run` | `{ sessionId?, prompt, timeoutMs?, expectedGeneration? }` | `{ sessionId, finalResponse, eventCount, generation }` |
| `status` | — | `{ pid, runtimeAlive, busy, lastSessionId, generation, provider, model, permissionMode }` |
| `broker/shutdown` | — | `{}` then process exit |

One run in flight at a time; a concurrent `run` gets error code `-32001` ("busy"). Omitted `sessionId` mints `cc-<uuid>`.

**Runtime generation**: a UUID minted every time the runtime child is spawned and nulled when it dies. Sessions exist only inside one runtime instance, so a resume is valid iff its recorded generation equals the live one — the daemon pid proves nothing, because a respawned child under the same daemon has lost every session. `run` with an `expectedGeneration` that does not match the live runtime is rejected with error code `-32002` (stale session); the bridge checks `status.generation` first and this is the race-proof final guard.

## Runtime child (broker ↔ dsh)

Spawned lazily on the first `run`: `dsh --profile cc` with `DSH_PERMISSION_MODE` fixed at broker startup (default `workspace-write`; a live broker cannot change mode — documented limitation). The embedded client speaks the SDK wire protocol:

1. `initialize { cwd, provider, model }` once per child.
2. Per run: `session/prompt { sessionId, contentBlocks: [{type:"text",text}] }` → `{ messageId }`.
3. Wait for the `session.event` of type `agent/inbox/spliced` whose `data.inserted[].id === messageId` (the durable receipt), then collect this session's events until `session.status` reports `idle`.
4. `finalResponse` = concatenated text blocks of the last `assistant/message` event.

This is a JavaScript port of the TypeScript SDK's `HarnessSession.run`, with one transport nuance: notifications are buffered until the prompt response's `messageId` is known, because the runtime may flush the response and the receipt notification in one stdout chunk (the SDK avoids this with a pull-based subscription queue). If the SDK changes its activity-ownership rules, port the change here and update [dsh-compat.md](dsh-compat.md).

## Lifecycle and failure modes

- **Start**: `lib/broker-client.mjs` `ensureBroker` serializes check-and-spawn behind the `broker.starting` O_EXCL lock (the synchronous state lock cannot span an async spawn), double-checks liveness under the lock, then spawns the daemon detached and polls `status` for up to 15s. Concurrent callers piggyback on the winner's broker; a lock whose starter pid is dead or whose mtime exceeds 30s is reclaimed as stale.
- **Socket ownership**: on startup the daemon never steals a live socket — an answering socket means "already running" (exit 1); a silent socket with a live recorded pid means an unreachable-but-alive owner (exit 1, `stop --broker` first); only a provably dead owner's socket is removed. The pid/info files are written in the `listening` callback (bind first, publish second), and `EADDRINUSE` on a concurrent bind is fatal — the kernel arbitrates ties. Shutdown removes the pid file only if it still contains the daemon's own pid.
- **Runtime death**: the child's exit rejects all pending requests with its stderr tail and nulls the runtime generation; the next `run` respawns it under a fresh generation. Previous in-memory sessions are gone, and every resume recorded against the old generation is now refused explicitly (bridge check + `-32002` guard) instead of silently minting fresh state.
- **Turn timeout**: `--timeout-ms` is forwarded as the run param (default 20 minutes, applied broker-side), and the client socket waits an extra 30s so the broker's own timeout error — which clears its busy state — always arrives first. On expiry the broker answers the RPC with an error and frees itself, but the runtime keeps working; only `stop --broker` actually aborts (no cancel on the wire).
- **Shutdown**: `broker/shutdown` → SDK `shutdown` request → SIGTERM fallback; socket and pid files unlinked. SIGTERM/SIGINT to the daemon do the same.
- **Stale socket**: liveness = pid alive AND socket answers `status` within 2s; anything else counts as "not running" and gets replaced.
