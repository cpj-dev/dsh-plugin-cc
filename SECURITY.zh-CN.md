# 安全策略

[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

## 支持版本

| 版本 | 是否支持 |
|---|---|
| 最新发布版本 | 是 |
| 更早版本 | 否 |

## 报告漏洞

请使用 GitHub 私有漏洞报告：
https://github.com/cpj-dev/dsh-plugin-cc/security/advisories/new

报告应包含受影响版本、复现步骤、影响和可选的修复建议。在协调修复发布前，不要在公开 Issue、Discussion 或 Pull Request 中披露可利用细节。

维护者目标是在三个工作日内确认收到报告，并在七个工作日内提供初步评估。具体时间取决于严重程度和维护者可用性；进度会保留在私有 advisory 中。

## 安全模型摘要

- **凭据：**插件不会读取或传输 `DEEPSEEK_API_KEY` 的值，只检查其来源供 `/dsh:check` 判断就绪状态。密钥由插件启动的 DeepSeek Harness 进程使用。
- **沙箱：**审查和评审始终只读；任务默认只读，只有显式 `--write` 才使用 `workspace-write`。插件不会使用 `danger-full-access`。
- **分离进程：**后台任务和 broker 可能在 Claude 会话结束后继续运行。使用 `/dsh:runs --all` 查看，使用 `/dsh:stop` 或 `/dsh:stop --broker` 终止。
- **网络：**`/dsh:setup` 会调用 `npm install`（把固定版本的 CLI 装进插件数据目录）以及 `dsh plugin add`（pnpm 拉取 SDK JSON-RPC server 及其已发布的 peers）。其他 bridge 命令只启动本地进程；模型 API 流量发生在 dsh 内部。

## 披露与致谢

修复可用后，维护者会与报告者协调公开时间和发布说明。报告者可选择署名；可能暴露敏感信息时不会公开身份。

中英文内容冲突时，以 [SECURITY.md](SECURITY.md) 为准。
