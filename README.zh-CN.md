# dsh-plugin-cc

[English](README.md) | [简体中文](README.zh-CN.md)

[![测试](https://github.com/cpj-dev/dsh-plugin-cc/actions/workflows/test.yml/badge.svg)](https://github.com/cpj-dev/dsh-plugin-cc/actions/workflows/test.yml)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Claude Code 插件：用斜杠命令跑 **DeepSeek Harness**（`dsh`）——代码审查、对抗式评审、一次性任务、可恢复多轮会话。

Pin：[`@deepseek-ai/dsh@0.1.1-rc.2`](https://www.npmjs.com/package/@deepseek-ai/dsh)。升级插件后重新跑 `/dsh:setup`。升级 dsh 时重新核对 [docs/dsh-compat.md](docs/dsh-compat.md)。英文文档是技术事实的权威版本；命令名、参数、环境变量、路径和 JSON 字段保持英文。

## Agent 模式

默认是 **`standard`**。`minimal` 和 `anchored-standard` 是切换项，不是默认。

| 模式 | 模型看到的工具 |
|---|---|
| **`standard`**（默认） | 从请求 #1 起完整 dsh-base 目录（检索、skills、子代理……）。不加 overlay。 |
| `minimal` | **全程**仅 bash + `str_replace_editor`。额外工具后面不会出现。 |
| `anchored-standard` | 先两件套。该 session 出现工具调用 **或** 助手回复后，下一次 assemble 恢复完整目录。 |

切换：

- 本次运行：`/dsh:run --mode minimal …` 或 `--mode anchored-standard`
- 当前 shell：`DSH_CC_MODE=minimal`
- 本机默认：`/dsh:setup --mode minimal`

broker（`--session` / `--resume` / `/dsh:import`）沿用启动时的模式。不一致 → `/dsh:stop --broker`。

## 快速开始

需要 Node >= 20 和 `DEEPSEEK_API_KEY`。`/dsh:setup` 还需要 Node >= 22.19、`npm`、`pnpm`（`corepack enable`）。

```bash
/plugin marketplace add cpj-dev/dsh-plugin-cc
/plugin install dsh@deepseek-dsh
/dsh:setup
/dsh:review
```

已有构建好的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码目录：`/dsh:setup --harness <path>`。已有 `dsh` 可执行文件：设 `DSH_BINARY`。卸载：删插件、插件数据目录、`~/.dsh/profiles/cc`。

## 命令

| 命令 | 作用 |
|---|---|
| `/dsh:check` | 就绪检查 |
| `/dsh:setup` | 安装固定版本 npm CLI（或 `--harness`）并创建多轮 `cc` profile |
| `/dsh:review [focus]` | 只读审查本地改动 |
| `/dsh:critique [focus]` | 结构化对抗式评审 |
| `/dsh:run <task>` | 执行任务（`--write`、`--session`、`--resume`、`--mode`、`--background`） |
| `/dsh:delegate <task>` | 后台委派 |
| `/dsh:import` | 把当前对话弱导入可恢复 dsh 会话 |
| `/dsh:runs` / `/dsh:show` | 列出运行 / 回放结果 |
| `/dsh:stop` / `--broker` | 停止运行 / 共享 broker |

完整参数：[docs/zh-CN/commands.md](docs/zh-CN/commands.md)。排障：[docs/zh-CN/troubleshooting.md](docs/zh-CN/troubleshooting.md)。

## 给 Agent

按这个顺序读，能动手就停。

1. 本 README（模式 + 命令）
2. [docs/commands.md](docs/commands.md) — 参数（英文权威）
3. [plugins/dsh/skills/dsh-delegate-runtime/SKILL.md](plugins/dsh/skills/dsh-delegate-runtime/SKILL.md) — 如何调用 bridge
4. [docs/dsh-compat.md](docs/dsh-compat.md) — DSH pin；升级时重验
5. [NOTICE](NOTICE) — 第三方许可证（法律文本不翻译、不复述）

入口：`plugins/dsh/scripts/dsh-bridge.mjs`（一个能力一个子命令；stdout 给用户）。DSH argv 与 overlay：`plugins/dsh/scripts/lib/dsh.mjs`。Broker：`plugins/dsh/scripts/dsh-broker.mjs` —— 由 bridge 按需启动，**不要手动启动**。测试：`npm test`（假 dsh，不需要 API key）。

布局：`.claude-plugin/marketplace.json` · `plugins/dsh/commands/*.md` · `plugins/dsh/scripts/` · `docs/`。索引：[docs/zh-CN/README.md](docs/zh-CN/README.md)。

## 已知限制（v1）

- 不支持运行中交互审批；权限在启动前用 `--write` 决定。
- 一次性运行不可恢复。只有 `--session` / `--resume` / `/dsh:import` 会记录 session id，且只在对应 broker 进程存活期间有效。
- Stop = kill。SDK 没有单轮取消；停掉进行中的 broker 轮次会丢掉内存会话。
- `/dsh:import` 是压缩文本摘要，不是原生历史回放。非文本的 Claude 块（含图片）会被丢弃。
- 视觉理解留在 Claude 侧。Slash 的 `$ARGUMENTS` 是文本；本插件不会把粘贴的图片转发给 DSH。`--model deepseek-v4-flash-vision-exp` 只改模型 id。没有 `--image` 参数。原生 DSH 视觉属于 `dsh web` / TUI。`standard` 下 DSH 可能对仓库文件调用 `read_image`——那不是把 Claude 对话图片交给 DSH 的产品路径。
- 一次性运行已支持 Windows（`node` + `lib/bin.js`，不会 spawn `.cmd`）。多轮（`--session` / `--resume` / import）仍需要 unix socket broker（POSIX）。进程树终止（`pgrep`）仍是 POSIX。

## 社区与支持

- 提交前阅读[贡献指南](CONTRIBUTING.zh-CN.md)
- [支持说明](SUPPORT.zh-CN.md)
- 漏洞按[安全策略](SECURITY.zh-CN.md)私下报告
- [行为准则](CODE_OF_CONDUCT.zh-CN.md)

## 致谢

第三方版权、许可证与设计来源以英文 [NOTICE](NOTICE) 为准。摘要：

- 运行时：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。本插件只组合公开 CLI 与 SDK，不内嵌 harness 源码。
- 插件形态：[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 与 [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc)（Apache-2.0）。仅架构借鉴，未复制源码。
- `--mode anchored-standard`：从 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（MIT）重实现 assemble 过滤 / 晋升协议，不是其 Web preset 的拷贝。首轮触发证据见 [xiaobright/modeltest](https://github.com/xiaobright/modeltest)（研究引用；引用时该仓库无 LICENSE 文件）。
- [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 仅作对照阅读，**未接入**。

本项目与上述作者或组织无隶属或背书关系。

## 许可证

MIT，见 [LICENSE](LICENSE)。再分发须保留 LICENSE 与 NOTICE；法律文本以英文原文为准。
