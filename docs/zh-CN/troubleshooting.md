# 排障指南

[English](../troubleshooting.md) | [简体中文](troubleshooting.md)

最后同步：2026-08-14。首先运行 `/dsh:check`；该命令只读，并会列出缺失条件和下一步操作。

## 无法找到 DeepSeek Harness

- **没有 `dsh`：**运行 `/dsh:setup`。它会把 `@deepseek-ai/dsh@<pin>` 从 npm 装进插件数据目录，生成 wrapper，并创建 `cc` profile。
- **已有已构建的源码目录：**运行 `/dsh:setup --harness <absolute-path>`。目录必须已经执行过 `pnpm install && pnpm run build:lib`；插件不会代为编译。之后再跑无参数的 `/dsh:setup` 会把已持久化的源码安装迁移到 npm pin。
- **已有 `DSH_BINARY`，但 `cc` profile 缺失或过期：**仍需运行 `/dsh:setup`。即使 `--dump-config` 里已有包名，也会把 `@deepseek-ai/dsh-sdk-jsonrpc-server@<pin>` 及其已发布的 peers 装进 profile（用 `sdkProfileVersion` 跟踪：`npm:<pin>` 或 `harness:<realpath>`）。
- **`/dsh:check` 报告 npm pin 或 cc profile 过期：**持久化的 CLI 版本或 profile 身份与当前插件 pin（或当前 `--harness` 检出）不一致。重新运行 `/dsh:setup`（要保留源码目录请再次传入 `--harness`）。
- **Node 版本错误：**插件命令需要 Node >= 20；运行 DeepSeek Harness 需要 Node >= 22.19。
- **缺少 `npm`：**安装 Node（自带 npm）后重试。
- **缺少 `pnpm`：**运行 `corepack enable`，或安装兼容版本的 `pnpm` 后重试。profile 插件安装始终需要 pnpm。
- **原生插件编译失败（`sharp`、`node-pty`）：**清理插件数据目录对应的 npm 缓存后重跑 `/dsh:setup`，或改用 `--harness` 指向已构建的源码目录。
- **不要把 `npx` 当作长期 binary**，也不要跟随 npm dist-tag（SDK server 的 `latest` 与 CLI 的 `latest` 不是同一版本）。

## 凭据未就绪

通过环境变量、`$DSH_HOME/.credentials.yaml` 或本地 `.env` 提供 `DEEPSEEK_API_KEY`。不要提交密钥；`.env` 会被忽略，脱敏后的 `.env.example` 可以提交。

修改后再次运行 `/dsh:check`。检查结果只显示凭据来源，不会输出密钥。

## `cc` profile 缺失或损坏

再次运行 `/dsh:setup`。setup 是幂等的，会修复 SDK server 链接和受管 profile 配置，并通过 `--dump-config` 验证。

如果使用自定义源码目录，请再次传入相同的 `--harness <path>`，以便定位 `packages/sdk/server`。否则 setup 会用固定版本的 npm spec 修复 profile。

## 无法恢复会话

可恢复会话只存在于当前 broker runtime 内。broker 被停止、崩溃或重启后，旧 session ID 会被明确拒绝，而不是静默创建新会话。

使用 `/dsh:run --session <task>` 开始新会话。

## Broker 任务卡住

1. 使用 `/dsh:runs <run-id>` 检查状态。
2. 使用 `/dsh:stop <run-id>` 停止任务。
3. 如果 broker 仍忙，使用 `/dsh:stop --broker`。

停止 broker 会丢失当前工作区的全部内存 dsh 会话；仅在可以接受无法恢复时使用。

## 任务超时

`--timeout-ms` 控制 broker 端的单轮期限。超时会释放 broker，但 DSH 可能仍在内部工作，因为协议没有单轮取消接口。必须终止底层任务时使用 `/dsh:stop --broker`。

## 提交问题前

请准备 `/dsh:check` 输出（移除敏感信息）、完整命令和参数、Node/操作系统/插件/dsh 版本、run ID、相关日志片段，以及是否能在 [dsh-compat.md](../dsh-compat.md) 固定的 npm 版本上复现。

普通问题使用仓库的 Bug 表单；包含安全敏感信息的日志必须通过私有漏洞报告提交。
