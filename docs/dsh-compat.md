# DSH compatibility contract

Everything this plugin assumes about DeepSeek Harness, verified against **`@deepseek-ai/dsh@0.1.0-rc.6` and `@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.0-rc.6` on npm** (developer preview; DSH promises no compatibility before its first tagged release). `--harness` checkouts are supported but unverified. On every dsh upgrade, re-verify each row **before** touching plugin code; each row names its verification command and the plugin file that consumes it.

## Distribution

| Fact | Verification | Consumed by |
|---|---|---|
| The dsh CLI is published as `@deepseek-ai/dsh`. Pin the **exact** version (`HARNESS_NPM_VERSION`); do not follow `latest`/`next`. `@deepseek-ai/dsh-sdk-jsonrpc-server` is published separately (`latest` is not the same version as the CLI) and is **outside the CLI's dependency closure**, so `/dsh:setup` installs it into the cc profile with `dsh plugin add`. Dist-tag trap: on 2026-08-14 CLI `latest` was 0.1.0-rc.6 while SDK-server `latest` was still 0.0.1-rc.5 | `npm view @deepseek-ai/dsh version`; `npm view @deepseek-ai/dsh-sdk-jsonrpc-server dist-tags`; `npm view @deepseek-ai/dsh dependencies` has no sdk-jsonrpc-server | `handleSetup`, `HARNESS_NPM_VERSION` |
| The SDK JSON-RPC server's published `peerDependencies` are **not** provided by the launcher's `$DSH_HOME/profiles/node_modules` self-heal. A profile that only `plugin add`s the server package fails at boot (`Cannot find package '@deepseek-ai/dsh-sdk-protocol'`). Setup therefore adds the pinned server **and** `HARNESS_SDK_JSONRPC_PEER_SPECS`. `--harness` still `link:`-installs `packages/sdk/server` from the checkout (workspace peers resolve there) | `npm view @deepseek-ai/dsh-sdk-jsonrpc-server@<pin> peerDependencies`; boot `dsh --profile cc` after add | `pinnedSdkServerInstallSpecs`, `handleSetup` |
| The npm CLI entry is `node_modules/@deepseek-ai/dsh/lib/bin.js` (`bin: {dsh: lib/bin.js}`). A source-built CLI is **not** self-contained — workspace deps resolve through the checkout's `node_modules`, so a `--harness` checkout must stay installed and built in place | npm tarball layout; `apps/cli/package.json` | `installPinnedDshFromNpm`, `inspectHarnessCheckout`, `writeDshWrapper` |
| The harness requires Node `^22.19.0 \|\| >=24` and pnpm (corepack-pinned) | `apps/cli/package.json` engines / root `package.json` | `selectHarnessNode`, setup errors |
| `dsh plugin --profile <p> add <spec...>` is a pnpm forwarder; absolute path specs pass through untouched and install as pnpm `link:`; registry specs install from npm. Multiple specs may be passed in one invocation | `apps/cli/src/plugin.ts` `anchorPathSpec`; `docs/user/develop/basic/publish.md` | `handleSetup` SDK-server install |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` lives at `packages/sdk/server` in a source tree and is **outside the CLI's dependency closure**, so the launcher's `profiles/node_modules` self-heal never provides it — it must be installed into the cc profile's own node_modules (registry spec, or `link:` from `--harness`) | `packages/sdk/server/package.json`; grep `apps/cli/package.json` deps | `resolveSdkServerDir`, `pinnedSdkServerInstallSpecs`, cc profile design |
| Built-in profiles are templates materialized in `$DSH_HOME` on first use (`web`, `headless`); non-shipped names exist only after `dsh plugin ... add` creates them | `packages/boot/app-boot/src/profile.ts` `PROFILE_TEMPLATES` | `probeProfile` failure semantics, setup flow |

## CLI launcher

| Fact | Verification | Consumed by |
|---|---|---|
| Launcher flags (`--profile`, repeatable `--patch <file>`) must precede app arguments; the launcher consumes one `--`, so the bridge always passes the task behind `--` | `dsh --profile headless --patch /dev/null -- "say hi"` | `lib/dsh.mjs` `buildHeadlessArgs` |
| `dsh --version` prints the launcher version and exits 0 | `dsh --version` | `lib/dsh.mjs` `getDshAvailability` |
| `dsh --profile <name> --dump-config` composes all layers without booting; nonzero exit on a broken profile | `dsh --profile cc --dump-config` | `lib/dsh.mjs` `probeProfile` |
| `dsh plugin --profile <name> add <pkg>` initializes a missing profile (dsh-base template for non-shipped names) and forwards installation to pnpm | run against a scratch `DSH_HOME` | `dsh-bridge.mjs` `handleSetup` |
| Profiles live at `$DSH_HOME/profiles/<name>` (default `~/.dsh`); the profile's `cordis.patch.yml` is the user patch layer; CLI `--patch` files compose after it (last wins) | inspect `$DSH_HOME/profiles/cc` | `dsh-bridge.mjs` `handleSetup`, overlay design |
| Profile init seeds `cordis.patch.yml` as header comments + a bare empty flow array (`[]`); a block sequence appended after that `[]` is invalid YAML, so the managed-block writer strips the empty-array line first | create a fresh profile via `dsh plugin ... add`, inspect the file | `handleSetup` managed patch block |

## Headless profile

| Fact | Verification | Consumed by |
|---|---|---|
| `dsh --profile headless -- "<task>"` runs one task to completion, prints only the last non-empty assistant message on stdout, exits 0 on a completed final turn / 1 otherwise | run a trivial task | `lib/dsh.mjs` `runHeadlessAgent` |
| Every headless invocation creates a new session; there is no `--resume` or session-selection flag | headless README / `--help` | broker exists at all |

## Config rows (dsh-base bundle)

| Fact | Verification | Consumed by |
|---|---|---|
| Sandbox mode comes from `DSH_PERMISSION_MODE` ∈ `read-only` \| `workspace-write` \| `danger-full-access`, read at boot | base bundle `cordis.patch.yml` | `lib/dsh.mjs` env handling |
| Approval policy row id `approval`, field `policy`; base default `ask` (fails closed unattended) unless danger mode | base bundle patch | `buildUnattendedOverlayYaml`, cc profile patch |
| Permission row id `permission` (`@deepseek-ai/dsh-permission-presets`): base presets are read-only+ask, workspace-write+ask, danger-full-access+never; **boot throws** when the composed sandbox+approval pair matches no preset and no `defaultPreset` is configured; the default preset's knobs are **pinned into fresh sessions**, overriding the env sandbox mode | base bundle patch; `packages/interaction/permission-presets/src/index.ts` (constructor + `pinInitialPermission`) | `buildUnattendedOverlayYaml` (defines a matching `unattended` preset per launch mode; applied to one-shot runs and the broker's `--profile cc` spawn) |
| Default model row id `agent-default-model` with `{ provider, model }`; DeepSeek adapter row id `llm-deepseek` with `{ thinking, reasoningEffort }` | base bundle patch | `lib/dsh.mjs` `buildModelOverlayYaml` |
| Base defaults: provider `deepseek-official`, model `deepseek-v4-flash` | base bundle patch | informational only — the plugin always overrides with its own defaults (`lib/dsh.mjs` `DEFAULT_MODEL` = `deepseek-v4-pro`, `DEFAULT_REASONING_EFFORT` = `max`), applied via the model overlay on one-shot runs and via `dsh-broker.mjs` initialize + effort overlay on broker spawns |
| `hmr` row exists in base and must be disabled for a stdio-serving profile | base bundle patch | cc profile patch block |

## SDK wire protocol (`dsh-sdk-jsonrpc-server` + protocol package)

| Fact | Verification | Consumed by |
|---|---|---|
| Transport: newline-delimited JSON-RPC 2.0 on stdio; stdout is protocol-only | sdk/protocol README | cc profile design (no stdout logger) |
| `initialize { cwd, provider, model, maxTokens? } → { serverInfo }`; `serverInfo.name` = `deepseek-harness-sdk-runtime` | sdk/protocol types | `dsh-broker.mjs` `ensureInitialized` |
| `session/prompt { sessionId, contentBlocks } → { messageId }`; an unknown sessionId lazily creates the agent+session pair **within this process only** | sdk/server README | broker multi-turn model |
| Run-to-idle: wait for the `session.event` of type `agent/inbox/spliced` whose `data.inserted[].id` equals the receipt's `messageId`, collect events, stop at `session.status` `idle` for that sessionId | sdk/client `api.ts` `HarnessSession.run` | `dsh-broker.mjs` `RuntimeClient.run` |
| Final response = last `assistant/message` event's `data.message.content` text blocks, concatenated | sdk/client `finalResponse` | `dsh-broker.mjs` `finalResponse` |
| No cancel and no per-session close on the wire; abandoning a turn means killing the runtime process | sdk/protocol Known Limitations | stop semantics, `stop --broker` |

## Credentials

| Fact | Verification | Consumed by |
|---|---|---|
| DSH resolves `DEEPSEEK_API_KEY` from env, `$DSH_HOME/.credentials.yaml`, or project/user `.env` | credentials package README | `lib/dsh.mjs` `getDshAuthStatus` |

## Upgrade procedure

1. Read the dsh release notes / changed package READMEs.
2. Re-verify every row above; update this file in the same commit as any code change it forces.
3. Run `npm test`, then the manual acceptance checklist in [testing.md](testing.md) against the new dsh.
4. Bump `HARNESS_NPM_VERSION` (and `HARNESS_SDK_JSONRPC_PEER_SPECS` if the server's peers changed) in `lib/dsh.mjs` and the pin at the top of this file and in the root README. Existing machines pick up the new CLI **and** profile plugins on the next `/dsh:setup` (`sdkProfileVersion` is the identity `npm:<pin>` or `harness:<realpath>`, written only after a successful `plugin add`, so a pin bump, source switch, or failed refresh is retried even if `--dump-config` already names the package). `/dsh:check` reports a stale pin or identity until that setup runs.
