# 排障指南

[English](../troubleshooting.md) | [简体中文](troubleshooting.md)

最后同步：2026-08-14。首先运行 `/dsh:check`；该命令只读，并会列出缺失条件和下一步操作。

## 无法找到或构建 DeepSeek Harness

- **没有 `dsh`，也没有源码目录：**运行 `/dsh:setup`，自动克隆已验证提交、构建、生成 wrapper 并保存路径。
- **已有源码目录：**运行 `/dsh:setup --harness <absolute-path>`。
- **已有 `DSH_BINARY`，但缺少 `cc` profile：**仍需运行 `/dsh:setup`。profile 使用的 SDK JSON-RPC server 只存在于源码目录中。
- **Node 版本错误：**插件命令需要 Node >= 20；构建 DeepSeek Harness 需要 Node >= 22.19。
- **缺少 `pnpm`：**运行 `corepack enable`，或安装兼容版本的 `pnpm` 后重试。
- **固定提交检出失败：**setup 会停止，不会在未验证分支上继续。处理 Git 错误后重试，不要在发布安装中绕过固定提交。

## 凭据未就绪

通过环境变量、`$DSH_HOME/.credentials.yaml` 或本地 `.env` 提供 `DEEPSEEK_API_KEY`。不要提交密钥；`.env` 会被忽略，脱敏后的 `.env.example` 可以提交。

修改后再次运行 `/dsh:check`。检查结果只显示凭据来源，不会输出密钥。

## `cc` profile 缺失或损坏

再次运行 `/dsh:setup`。setup 是幂等的，会修复 SDK server 链接和受管 profile 配置，并通过 `--dump-config` 验证。

如果使用自定义源码目录，请再次传入相同的 `--harness <path>`。

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

请准备 `/dsh:check` 输出（移除敏感信息）、完整命令和参数、Node/操作系统/插件/dsh 版本、run ID、相关日志片段，以及是否能在固定 Harness 提交上复现。

普通问题使用仓库的 Bug 表单；包含安全敏感信息的日志必须通过私有漏洞报告提交。
