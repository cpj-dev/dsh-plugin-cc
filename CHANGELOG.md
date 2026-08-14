# Changelog

## Unreleased

### Added

- English and Simplified Chinese entry points for setup, commands, troubleshooting, contribution, support, security, and community conduct, with bilingual command-palette descriptions.
- GitHub community-health files: Contributor Covenant 2.1, structured bug/feature forms, and a bilingual pull-request checklist.

### Changed

- Default model selection is now plugin-owned: runs without `--model`/`--effort` use `deepseek-v4-pro` at reasoning effort `max` (previously fell through to the dsh-base defaults — `deepseek-v4-flash`, no forced effort). Applies to one-shot runs, reviews/critiques, and broker sessions; the broker `serve` command gained an `--effort` flag (env: `DSH_CC_EFFORT`) and reports `effort` in its status.
- `.gitignore` now separates public project documentation from private implementation notes, local agent/editor state, credentials, coverage, and generated output while allowing sanitized `.env.example` files.

### Fixed

- Plain `/dsh:setup` now works when dsh is already available externally (`DSH_BINARY`/PATH) but the cc profile is missing: the auto-clone keys on the missing checkout/profile requirement, not just on dsh availability. Previously that supported configuration failed with "Rerun /dsh:setup --harness" because no SDK server source existed.
- The auto-clone no longer falls back to the upstream default branch when the pinned verified commit cannot be checked out. It fetches the commit explicitly and retries once; on failure it removes the clone and fails setup instead of silently recording an unpinned harness as pinned.

## 1.0.0 (2026-08-14)

Verified against DeepSeek Harness source checkout `0.1.0-rc.5` (commit `47f9438`): full manual acceptance (docs/testing.md checklist — check/setup/review/critique/background runs/session/resume/import/stop, plus the stale-resume, finished-run-stop, and timeout-validation scenarios) run against a source-built dsh with a live `DEEPSEEK_API_KEY`. The harness has no npm distribution; see the README quickstart for the source install flow.

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
