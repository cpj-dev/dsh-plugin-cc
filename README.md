# dsh-plugin-cc

[English](README.md) | [简体中文](README.zh-CN.md)

[![test](https://github.com/cpj-dev/dsh-plugin-cc/actions/workflows/test.yml/badge.svg)](https://github.com/cpj-dev/dsh-plugin-cc/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/cpj-dev/dsh-plugin-cc?style=social)](https://github.com/cpj-dev/dsh-plugin-cc)

Claude Code plugin that runs **DeepSeek Harness** (`dsh`) from slash commands: review, critique, one-shot tasks, and resumable multi-turn sessions.

Pin: [`@deepseek-ai/dsh@0.1.1-rc.2`](https://www.npmjs.com/package/@deepseek-ai/dsh). After upgrading the plugin, rerun `/dsh:setup`. Re-verify [docs/dsh-compat.md](docs/dsh-compat.md) on every dsh upgrade.

## Agent modes

Default is **`standard`**. `minimal` and `anchored-standard` are switches — they are not the default.

| Mode | Tools the model sees |
|---|---|
| **`standard`** (default) | Full dsh-base catalog from request #1 (search, skills, subagents, …). No overlay. |
| `minimal` | bash + `str_replace_editor` for the **whole** run. Extra tools cannot appear later. |
| `anchored-standard` | Those two tools first. After this session records a tool call **or** an assistant reply, the next assemble restores the full catalog. |

Switch:

- this run: `/dsh:run --mode minimal …` or `--mode anchored-standard`
- this shell: `DSH_CC_MODE=minimal`
- this machine: `/dsh:setup --mode minimal`

A broker (`--session` / `--resume` / `/dsh:import`) keeps the mode it started with. Mismatch → `/dsh:stop --broker`.

## Quick start

Needs Node >= 20 and a `DEEPSEEK_API_KEY`. `/dsh:setup` also needs Node >= 22.19, `npm`, and `pnpm` (`corepack enable`).

```bash
/plugin marketplace add cpj-dev/dsh-plugin-cc
/plugin install dsh@deepseek-dsh
/dsh:setup
/dsh:review
```

Already have a built [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout? `/dsh:setup --harness <path>`. Already have a `dsh` binary? set `DSH_BINARY`. Uninstall: remove the plugin, the plugin data dir, and `~/.dsh/profiles/cc`.

## Commands

| Command | What it does |
|---|---|
| `/dsh:check` | Readiness probe |
| `/dsh:setup` | Install pinned npm CLI (or `--harness`) and the multi-turn `cc` profile |
| `/dsh:review [focus]` | Read-only review of local changes |
| `/dsh:critique [focus]` | Structured adversarial critique |
| `/dsh:run <task>` | Task (`--write`, `--session`, `--resume`, `--mode`, `--background`) |
| `/dsh:delegate <task>` | Background handoff via the `dsh-delegate` subagent |
| `/dsh:import` | Weak-import this conversation into a resumable dsh session |
| `/dsh:runs` / `/dsh:show` | List runs / replay a stored result |
| `/dsh:stop` / `--broker` | Kill a run / the shared broker |

Flags and failure modes: [docs/commands.md](docs/commands.md). Recovery: [docs/troubleshooting.md](docs/troubleshooting.md).

## For agents

Read in this order; stop when you can act.

1. This README (modes + commands)
2. [docs/commands.md](docs/commands.md) — flags
3. [plugins/dsh/skills/dsh-delegate-runtime/SKILL.md](plugins/dsh/skills/dsh-delegate-runtime/SKILL.md) — how to invoke the bridge
4. [docs/dsh-compat.md](docs/dsh-compat.md) — DSH pin; re-verify on upgrade
5. [NOTICE](NOTICE) — third-party licenses (do not restate)

Entry: `plugins/dsh/scripts/dsh-bridge.mjs` (one subcommand per capability; stdout is user-facing). DSH argv and overlays: `plugins/dsh/scripts/lib/dsh.mjs`. Broker: `plugins/dsh/scripts/dsh-broker.mjs` — started by the bridge; **never start it by hand**. Tests: `npm test` (fake dsh, no API key).

Layout: `.claude-plugin/marketplace.json` · `plugins/dsh/commands/*.md` · `plugins/dsh/scripts/` · `docs/`. Index: [docs/README.md](docs/README.md). Chinese user docs: [docs/zh-CN/README.md](docs/zh-CN/README.md).

## Known limitations (v1)

- No mid-run approvals. Permissions are decided before launch (`--write` or not).
- Fresh one-shot runs are not resumable. Only `--session` / `--resume` / `/dsh:import` record session ids, and those live only as long as the broker process.
- Stop = kill. The SDK wire has no per-turn cancel; stopping a mid-turn broker run discards in-memory sessions.
- `/dsh:import` is a compressed text digest, not native history replay. Non-text Claude blocks (including images) are dropped.
- Visual understanding stays with Claude. Slash `$ARGUMENTS` is text; this plugin never forwards pasted images to DSH. `--model deepseek-v4-flash-vision-exp` only changes the model id. There is no `--image` flag. Native DSH vision belongs in `dsh web` / TUI. In `standard`, DSH may `read_image` a repo file — that is not a product path for Claude chat images.
- One-shot Windows is supported (`node` + `lib/bin.js`, never a `.cmd` spawn). Multi-turn (`--session` / `--resume` / import) still needs a unix-socket broker (POSIX). Tree kill (`pgrep`) is POSIX.

## Community and support

- [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR
- [SUPPORT.md](SUPPORT.md) for support boundaries
- [SECURITY.md](SECURITY.md) for private vulnerability reports
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Acknowledgements

Third-party copyrights, licenses, and design provenance live in [NOTICE](NOTICE). In short:

- Runtime: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT). This plugin composes the public CLI and SDK; it does not vendor harness source.
- Plugin shape: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) and [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc) (Apache-2.0). Architectural inspiration only; no source copied.
- `--mode anchored-standard`: assemble-filter / promotion protocol reimplemented from [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) (MIT). Not a copy of that Web preset. First-request trigger evidence: [xiaobright/modeltest](https://github.com/xiaobright/modeltest) (research citation; no LICENSE file at citation time).
- [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) was reviewed and is **not** incorporated.

This project is not affiliated with or endorsed by those authors or organizations.

## License

MIT — see [LICENSE](LICENSE). Redistributors must keep LICENSE and NOTICE.
