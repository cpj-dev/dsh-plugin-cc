# Changelog

## Unreleased

### Added

- English and Simplified Chinese entry points for setup, commands, troubleshooting, contribution, support, security, and community conduct, with bilingual command-palette descriptions.
- GitHub community-health files: Contributor Covenant 2.1, structured bug/feature forms, and a bilingual pull-request checklist.

### Changed

- `/dsh:setup` now installs pinned `@deepseek-ai/dsh` from npm (plus `@deepseek-ai/dsh-sdk-jsonrpc-server` and that server's published peerDependencies into the `cc` profile). Auto-clone / `pnpm run build:lib` is gone. `--harness` still links a **user-built** checkout and does not compile it. Runtime pin is `0.1.0-rc.6`. Do not follow npm `latest`/`next` (SDK-server `latest` is not the CLI's `latest`).
- Default model selection is now plugin-owned: runs without `--model`/`--effort` use `deepseek-v4-pro` at reasoning effort `max` (previously fell through to the dsh-base defaults — `deepseek-v4-flash`, no forced effort). Applies to one-shot runs, reviews/critiques, and broker sessions; the broker `serve` command gained an `--effort` flag (env: `DSH_CC_EFFORT`) and reports `effort` in its status.
- `.gitignore` now separates public project documentation from private implementation notes, local agent/editor state, credentials, coverage, and generated output while allowing sanitized `.env.example` files.

### Removed

- `/dsh:setup --skip-build`. `--harness` now requires an already-built checkout (`pnpm install && pnpm run build:lib` yourself).

### Fixed

- `npm test` no longer quotes the `tests/*.test.mjs` glob. Node 20's test runner does not expand globs, so CI on the Node 20 matrix looked for a literal filename and failed even though the suite exists.
- Plain `/dsh:setup` repairs the `cc` profile when dsh is already available via `DSH_BINARY` or PATH: the CLI install is skipped, and the SDK JSON-RPC server is added from the pinned npm specs plus peers (no checkout required).
- `/dsh:setup` re-adds the pinned SDK JSON-RPC server and peers when it refreshes a stale npm CLI pin. `--dump-config` only proves the package *name* is present, so a pin bump would otherwise leave the profile on the previous SDK-server/peer versions. The profile pin is stored as `sdkProfileVersion` (`npm:<pin>` or `harness:<realpath>`) and is written only after a successful `plugin add`, so a failed refresh is retried.
- Switching from the npm CLI to `--harness`, or from checkout A to B, re-adds the SDK server for the new source instead of keeping the previous profile plugins.
- `/dsh:check` treats a stale npm CLI pin or profile identity as not ready and adds `nextSteps` to rerun setup.
- No-args `/dsh:setup` migrates a persisted source install (pre-npm `harnessCheckout`, or `dshInstall: harness`) to the npm pin. Only an explicit `--harness` this run keeps a checkout.
- `--harness` errors when `packages/sdk/server` is missing instead of silently adding the npm SDK-server pin beside a custom CLI.
- `/dsh:check` no longer reports the `cc` profile as stale forever when `DSH_BINARY` is set on a machine that previously ran `/dsh:setup --harness`. Setup uses the pinned registry specs whenever the checkout is not the dsh in use, so the expected profile identity now follows the resolved binary instead of the persisted `dshInstall`; the old rule demanded a `harness:` identity no rerun could produce.
- `/dsh:setup` reinstalls the npm pin when the plugin's npm prefix lost its `bin.js` (moved or partially cleaned) while another `dsh` answers on PATH. Setup and `/dsh:check` now share one definition of a healthy npm install, so setup no longer skips the repair that check keeps asking for.
- `/dsh:setup` rewrites a deleted managed wrapper when the pinned package itself is intact — previously an unrelated `dsh` on PATH made setup skip the repair while every `/dsh:check` kept reporting the vanished configured path. The rewrite is local, so it needs no network and leaves the `cc` profile identity alone.
- `/dsh:check` reports `ready: false` when the managed npm install it resolves to is off the verified pin. One-shot commands run that CLI, and DSH promises no compatibility between preview versions, so a stale pin is unsupported rather than merely outdated. A `DSH_BINARY`/PATH dsh is still the user's own and is not judged against the pin.

## 1.0.0 (2026-08-14)

Verified against DeepSeek Harness source checkout `0.1.0-rc.5` (commit `47f9438`): full manual acceptance (docs/testing.md checklist — check/setup/review/critique/background runs/session/resume/import/stop, plus the stale-resume, finished-run-stop, and timeout-validation scenarios) run against a source-built dsh with a live `DEEPSEEK_API_KEY`. See the README quickstart for the source install flow (the CLI later published as `@deepseek-ai/dsh` on npm).

### Added

- **One-command install**: plain `/dsh:setup` clones DeepSeek Harness (pinned to the verified commit) into the plugin data dir, builds it, links dsh, and creates the multi-turn profile — no manual clone step. `--harness <checkout-path>` uses an existing checkout instead: same closure (validate, `pnpm install` / `pnpm run build:lib` when missing, node wrapper, persisted `config.json`). The cc profile's SDK JSON-RPC server installs from the checkout by absolute path (registry-free).
- `/dsh:check` reports the dsh binary's source (env / configured source build / PATH), the checkout's health (version, commit, installed/built), and harness Node-floor compliance.
- Broker runtime **generation token**: resumes are validated against the live runtime and refused explicitly ("no live broker holds it" / "runtime restarted") instead of silently minting a fresh session; `run-resume-candidate` performs the same validation.
- Broker startup lock (`broker.starting`) serializing concurrent `ensureBroker` callers, with stale-lock reclaim.

### Fixed

- `stop` on a finished run no longer signals its recorded pids (PID-reuse could kill unrelated processes); kills are now claim-gated, stale records are cleaned without signalling, and an in-flight broker turn is identifiable and aborted from job creation time.
- `terminateProcessTree` waits for confirmed death and actually escalates to SIGKILL (the fallback previously lived on an unref'd timer that never fired in short-lived callers).
- Broker daemons no longer steal a live daemon's socket or pid file; pid/info publish only after a successful bind.
- `--timeout-ms` is forwarded to the broker (which frees itself on expiry) and validated (`NaN` no longer becomes an instant timeout).
- Review `--base` typos error up front instead of producing an "empty diff" review; genuinely empty targets refuse before spending a model run.
- SessionEnd cleanup runs under the state lock (no more lost concurrent jobs) and removes job/log files (no more orphan accumulation).
- Real-dsh acceptance fixes: the managed cc-profile patch block no longer corrupts dsh's seeded `[]` patch file; the unattended overlay is generated per permission mode with a matching permission preset (dsh-base's permission-presets service refuses to boot otherwise, and would pin a mismatched preset over `DSH_PERMISSION_MODE`), applied to one-shot runs and the broker runtime alike; broker-run footers report the broker's actual permission mode, not the per-request flag.

## Provenance

Initial release candidate scaffolded after the Codex (`openai/codex-plugin-cc`) and Grok Build (`xai-org/grok-build-plugin-cc`) Claude Code plugins; see [NOTICE](NOTICE).
