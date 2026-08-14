# 命令参考

[English](../commands.md) | [简体中文](commands.md)

最后同步：2026-08-14。

每个 `/dsh:*` 命令对应一个 `dsh-bridge.mjs` 子命令。`plugins/dsh/commands/` 中的 Markdown 只定义调用措辞和展示方式；本页是参数行为的中文参考。所有命令都接受 `--json`（输出机器可读数据）和 `--cwd <dir>`。

## `/dsh:check` → `check`

只读检查以下内容：Node、`dsh` 可执行文件（解析顺序为 `DSH_BINARY` → `setup --harness` 保存的配置 → PATH）、源码目录状态、Harness Node 最低版本（>= 22.19）、凭据、`cc` profile 和 broker。`ready` 表示一次性运行可用；`multiTurnReady` 表示 `--session`、`--resume` 和 `import` 可用。该命令不会安装任何内容。

## `/dsh:setup` → `setup`

| 参数 | 含义 |
|---|---|
| 无 | 没有可用源码目录时，将 Harness 的**已验证固定提交**克隆到插件数据目录，然后构建、链接并创建 `cc` profile。即使通过 `DSH_BINARY` 或 PATH 找到 `dsh`，setup 仍会从该检出目录安装已单独发布、但不在 CLI 依赖闭包里的 SDK server |
| `--harness <checkout-path>` | 使用已有源码目录；验证后按需运行 `pnpm install` 和 `pnpm run build:lib`，生成 Node wrapper，并把 `dshBinary` 与 `harnessCheckout` 保存到 `config.json` |
| `--skip-build` | 源码未安装或未构建时直接拒绝，不自动构建 |

CLI 已以 `@deepseek-ai/dsh` 发布到 npm；`/dsh:setup` 仍会克隆固定提交的源码，因为 `cc` profile 需要的 `@deepseek-ai/dsh-sdk-jsonrpc-server` 虽已单独发布，但不在 CLI 的依赖闭包里。自动克隆需要 `git`；构建需要 Node >= 22.19 和 `pnpm`。setup 会按需从检出目录 `link:` 安装 `packages/sdk/server`、维护受管 profile 配置，并使用 `--dump-config` 验证结果。重复执行是安全的。

## `/dsh:review` → `review`，`/dsh:critique` → `critique`

| 参数 | 含义 |
|---|---|
| 自由文本 | 审查或评审重点 |
| `--base <ref>` | 相对指定 ref 审查分支；默认自动检测远端 HEAD、`main` 或 `master` |
| `--scope auto\|working-tree\|branch` | 目标范围；`auto` 优先审查未提交改动 |
| `--model <name>`、`--effort low\|medium\|high\|max` | 本次运行的模型配置 |
| `--background` | 后台排队并返回 run ID；`--wait` 强制前台等待 |

两者都在只读沙箱中一次性执行。`review` 返回自由文本；`critique` 使用 JSON schema 约束结构化 finding，并在模型不满足格式时回退为原始文本。

不存在的 `--base` 会在创建任务前报错；真正没有改动时返回 `Nothing to review`；Git diff 失败会保留原始错误，不会被误判为空 diff。

## `/dsh:run` → `run`，`/dsh:delegate`

| 参数 | 含义 |
|---|---|
| 自由文本 / `--prompt-file <path>` / stdin | 任务内容 |
| `--write` | 使用 `workspace-write` 沙箱；默认只读 |
| `--session` | 通过 broker 执行并记录可恢复 session ID |
| `--resume`、`--resume-last` | 恢复最近的 dsh 会话；会校验当前 broker runtime generation，broker 已停止或重启时明确报错，不会静默创建新会话 |
| `--fresh` | 强制走一次性运行路径 |
| `--model`、`--effort` | 仅用于一次性运行；恢复会话沿用 broker 启动配置 |
| `--background` | 分离到后台执行并返回 run ID |
| `--timeout-ms <n>` | broker 单轮超时，默认 20 分钟；必须为正整数，并会转发到 broker |

`/dsh:delegate` 相当于面向大型任务的 `/dsh:run --background --write`，优先交给 `dsh-delegate` 子代理。内部命令 `run-resume-candidate` 用于判断是否存在可恢复会话。

## `/dsh:import` → `import`

将 Claude 会话记录压缩成有限长度的文本摘要，并以此启动可恢复 broker 会话。这是弱导入，不是原生历史回放。可通过 `--source <jsonl>` 指定记录文件，之后使用 `/dsh:run --resume` 继续；`--write` 允许导入会话修改工作区。

## `/dsh:runs` → `runs`，`/dsh:show` → `show`

`runs` 按新到旧列出当前 Claude 会话的任务；`--all` 包含工作区内其他会话。`runs <id>` 查看单个任务并校验 PID 存活状态，进程已消失时显示 `stale`。`show [id]` 重放已完成任务保存的结果。

## `/dsh:stop` → `stop`

`stop [id]` 先原子认领终态，再终止进程树；默认选择最新活动任务。已结束任务会返回 `already finished`，并且绝不会向其历史 PID 发送信号。`stale` 任务只标记取消，不发送信号。

DSH 协议没有单轮取消接口。停止 broker 支持的活动任务时，会先停止忙碌的 broker，并丢失该工作区全部内存 dsh 会话。`stop --broker` 显式停止共享 broker。
