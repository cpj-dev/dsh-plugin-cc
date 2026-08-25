# Changelog

Every change that ships anything under `plugins/` carries a version bump in the
same pull request. Claude Code keys a plugin's install directory by the manifest
version (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`) and records
it in `installed_plugins.json`, so a version that never moves makes every build
since the last bump indistinguishable to a user reading `/plugin` or filing a bug.
`tests/version.test.mjs` and the `version` CI job enforce it; there is no
`Unreleased` section to accumulate in.

## 2.0.2 (2026-08-25)

Pin bump to `@deepseek-ai/dsh@0.1.1-rc.2` and `@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.1-rc.2`. Existing machines pick up the new CLI and `cc` profile plugins only after `/dsh:setup`; `/dsh:check` reports a stale pin as not ready until then. In-memory broker sessions do not survive a pin bump.

### Changed

- Runtime pin `0.1.0-rc.7` → `0.1.1-rc.2` (covers upstream `0.1.0-rc.8`, `0.1.1-rc.1`, and `0.1.1-rc.2`). SDK-server peer package names are unchanged; cordis stays `^4.0.1`. `dsh-base` `cordis.patch.yml` row ids are identical to rc.7, so `MINIMAL_MODE_DISABLED_ROWS` is unchanged. Continue pinning the exact version — do not follow npm dist-tags (CLI `latest`/`next` are 0.1.1-rc.2; SDK-server `latest` is still `0.0.1-rc.5`, `next` is 0.1.1-rc.2).
- Catalog now includes `deepseek-v4-flash-vision-exp`. Plugin default remains `deepseek-v4-pro` at effort `max`; `--model` can select the vision id. **Vision is a non-goal for this plugin:** Claude keeps pasted images and should hand DSH a text brief. There is no `--image` flag. The plugin never sends image content blocks. `/dsh:import` is text-only. Native DSH vision belongs in `dsh web` / TUI. `standard` may let DSH `read_image` a workspace file if the route is image-capable; that is not a Claude-paste path.
- Web/UI-only surfaces from rc.8–0.1.1-rc.2 (native image requests, Files API image reuse, `@` file/session references, Claude Code/Codex Profile Bundles, Windows PTY PowerShell, Job Panel, Python SDK preset coverage) are not adopted. `minimal` still uses sandboxed one-shot `tool-bash`.
- Upstream rc.8 SQLite session-query on-disk format is incompatible with earlier versions. Headless/cc keep that row at `openAt: never`; this plugin does not open it.

### Fixed

- Upstream: Bubblewrap `/proc/*/root` sandbox bypass is closed; oversized/accumulated image payloads no longer fail the model request. Broker multi-turn runs inherit those runtime fixes.

## 2.0.1 (2026-08-18)

Pin bump to `@deepseek-ai/dsh@0.1.0-rc.7` and `@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.0-rc.7`. Existing machines pick up the new CLI and `cc` profile plugins only after `/dsh:setup`; `/dsh:check` reports a stale pin as not ready until then. In-memory broker sessions do not survive a pin bump.

### Changed

- Runtime pin `0.1.0-rc.6` → `0.1.0-rc.7`. SDK-server peer package names are unchanged; cordis stays `^4.0.1`. Continue pinning the exact version — do not follow npm dist-tags (CLI `latest`/`next` are rc.7; SDK-server `latest` is still `0.0.1-rc.5`).
- `--effort` is now `low|high|max` (plugin default remains `max`). `medium` is not in the upstream `llm-deepseek` schema and is rejected so an overlay cannot fail boot. Official schema also added `low` (already accepted) and `off` (the plugin still does not expose `off`).
- Web-only rc.7 surfaces (settings cards, Job Panel Codex/Claude Code subagents, MCP/ACP image persistence, PTC rename, Safari/history pagination) are not adopted. `minimal` still uses sandboxed one-shot `tool-bash`.

### Fixed

- Upstream: a session truncated at max-tokens can continue instead of dying with `INVALID_REPLAY_STATE`. Broker multi-turn runs inherit that recovery.

## 2.0.0 (2026-08-17)

Most of this release already reached users on `main` while the manifest still
said `1.0.0`; it is collected under one version because that is the label an
install can finally pin to. Major, not minor: `/dsh:setup --skip-build` is gone,
`--harness` no longer builds a checkout, and the default agent mode and model
selection both changed — breaking for anyone scripting against 1.0.0.

### Added

- `/dsh:check` (and `/dsh:setup`) report the plugin build as their first row — `✓ plugin — dsh 2.0.0` — so a pasted readiness block names the version a bug is against.
- `tests/version.test.mjs`: `package.json`, `plugins/dsh/.claude-plugin/plugin.json`, and both `.claude-plugin/marketplace.json` versions must agree, be semver, and head the changelog. A `version` CI job additionally fails a pull request that changes `plugins/**` or `.claude-plugin/**` without raising the manifest version above the base branch's, ordering by full SemVer precedence (`scripts/semver.mjs`, unit-tested) so a prerelease and its release are not treated as the same version.
- **`--mode anchored-standard`**: two-phase agent mode that keeps the full dsh-base tool registry mounted and filters the model-visible catalog to bash + `str_replace_editor` until that session records a durable `tool/call` or `assistant/message`, then restores the assembled catalog (and `agent-instructions` / `skill-catalog` injections). Built-in default stays `standard`; this mode is opt-in. The same bootstrap plugin is also inserted for `minimal` so assemble sections become one complete RL sentence (`ctx.systemPrompt.section({ complete: true })`); extra tools stay uncomposed there, so promotion cannot widen that catalog. Optional `DSH_CC_SNAPSHOT_FILE` records JSONL after `agent/pre-step` and once per step at `step/end` for the wire header (assemble-time empty context kinds are not a pass). Remaining wire delta vs official Web Minimal (persistent PTY bash, `dsh-fs-local`) is documented in `docs/dsh-compat.md` and is not a fourth mode.
- [NOTICE](NOTICE) now records third-party copyrights and licenses for the runtime (DeepSeek Harness), architectural inspiration (Codex and Grok Claude Code plugins, Apache-2.0), the anchored-standard mechanism port (`xiaobright/dsh-anchored-standard`, MIT), research citations (`xiaobright/modeltest`), and related work reviewed but not incorporated (`yjh051108/dsh-routing-suite`).
- English and Simplified Chinese entry points for setup, commands, troubleshooting, contribution, support, security, and community conduct, with bilingual command-palette descriptions.
- GitHub community-health files: Contributor Covenant 2.1, structured bug/feature forms, and a bilingual pull-request checklist.

### Changed

- **Agent modes are opt-in switches over a `standard` default.** Built-in default is `standard` (untouched dsh-base catalog from request #1, no overlay). `minimal` composes a fixed one-line persona (`includeHarnessIdentity` / `includeRuntimeContext` off) and exactly two tools (bash + `str_replace_editor`) via a generated `--patch` overlay; extra tools stay uncomposed. `anchored-standard` keeps the full registry mounted and filters to that pair until the session promotes. Switch per run with `--mode`, per shell with `DSH_CC_MODE`, or per machine with `/dsh:setup --mode`. A broker composes its mode at spawn and keeps it; a run resolving a different mode errors and names `/dsh:stop --broker`. `/dsh:check` reports the effective default and the live broker's mode. Inherited `DSH_TOOLS_MODE` is now stripped from every dsh spawn — previously it silently flipped one-shot runs into Code Mode.
- `/dsh:setup` now installs pinned `@deepseek-ai/dsh` from npm (plus `@deepseek-ai/dsh-sdk-jsonrpc-server` and that server's published peerDependencies into the `cc` profile). Auto-clone / `pnpm run build:lib` is gone. `--harness` still links a **user-built** checkout and does not compile it. Runtime pin is `0.1.0-rc.6`. Do not follow npm `latest`/`next` (SDK-server `latest` is not the CLI's `latest`).
- Default model selection is now plugin-owned: runs without `--model`/`--effort` use `deepseek-v4-pro` at reasoning effort `max` (previously fell through to the dsh-base defaults — `deepseek-v4-flash`, no forced effort). Applies to one-shot runs, reviews/critiques, and broker sessions; the broker `serve` command gained an `--effort` flag (env: `DSH_CC_EFFORT`) and reports `effort` in its status.
- `.gitignore` now separates public project documentation from private implementation notes, local agent/editor state, credentials, coverage, and generated output while allowing sanitized `.env.example` files.

### Removed

- `/dsh:setup --skip-build`. `--harness` now requires an already-built checkout (`pnpm install && pnpm run build:lib` yourself).

### Fixed

- **`--mode minimal` and `--mode anchored-standard` no longer fail to boot.** Both modes insert the bootstrap plugin, and its mount-time persona registration probed `typeof ctx?.systemPrompt?.section !== "function"`. A Cordis context proxy *throws* on a service the accessing plugin did not inject, so the probe was the crash: every run in either mode died before the first request with `dsh: plugin tree failed to load: … cc-tool-bootstrap … cannot get property "systemPrompt" without inject` — one-shot, `--session`, review, and critique alike. The registration now runs inside `ctx.inject(["systemPrompt"], …)`, which scopes the dependency to that one effect: the assemble / pre-step / pre-execute filters still attach on a composition that has no prompt registry at all. The unit suite missed it because the fake Cordis ctx exposed `systemPrompt` as a plain property; it is now a proxy that throws exactly like the real one, and mounting against a registry-less composition is covered.
- **`DSH_CC_SNAPSHOT_FILE` records one wire line per step.** rc.6 appends `request/header` only when the header changes (`reason: initial | resume | change`), so recording on that event alone left every steady-state step unrecorded — in `minimal`, where the catalog never changes after request #1, a whole run produced a single `source: "request"` line and the acceptance checklist had no per-step wire evidence to read. The last header snapshot is still that step's header, so the recorder keeps it per session and writes the wire line at `step/end`, after the step's header is known.
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
- Minimal mode no longer advertises bash's `run_in_background` parameter. The job tools that collect a background job (`job_output`/`job_kill`) are disabled with the rest of the toolset, while the `jobs` service stays composed — so a background call would have spawned and returned a job id the model could neither read nor kill. The mode overlay now pins `enableRunInBackground: false` on `tool-bash`.
- Bootstrap execute guard now freezes the assemble-time phase until session `step/end`. rc.6 persists `assistant/message` and the current `tool/call` before `tools/pre-execute`, so a live event-log scan let hidden tools through on the bootstrap response. Denial uses `{ kind: "deny", reason }` on `tools/pre-execute` only.
- Bootstrap assemble filter registers with `{ prepend: true }` so later append listeners cannot re-widen request #1. Complete persona is registered via `ctx.systemPrompt.section({ complete: true })`; a `complete` flag on the waterfall return value is not honored by rc.6.
- `DSH_CC_SNAPSHOT_FILE` now records after `agent/pre-step` as well, so empty `contextSourceKinds` is no longer a false pass for the context strip. The recorder reads rc.6 `EpochHeader.config` (`model` / `maxTokens` / `reasoningEffort`) and starts a fresh pending bag on each assemble so a promoted pre-step cannot inherit the previous header's two tools.
- [NOTICE](NOTICE) no longer labels the Codex and Grok Claude Code plugins as MIT. Both are Apache-2.0; this repository only used them as architectural inspiration and does not vendor their source.
- `/dsh:check` reports `ready: false` and `multiTurnReady: false` when `DSH_CC_MODE` holds an unsupported value, with a corrective next step. Every command resolves the agent mode before launching, so a bad value makes both paths unusable — previously the summary still said ready while every run/review/critique exited with "Unsupported mode".
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
