# 贡献指南

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

感谢参与。本项目将详细的开发者文档放在统一文档集中：

- [开发指南](docs/development.md)说明零依赖、代码分层、命令扩展和发布流程。
- [测试策略](docs/testing.md)说明测试、fixture 和手工验收清单。
- [DSH 兼容性契约](docs/dsh-compat.md)记录所有外部行为假设和验证命令。

## 基本要求

1. 修改前后均保持 `npm test` 通过；测试纯 Node 运行且不访问网络。
2. 行为和文档在同一个提交中更新；缺少文档的行为变更不完整。
3. 不增加 npm 依赖。需要大型依赖的能力通常应由 DeepSeek Harness 提供。

## 开始修改前

1. 搜索已有 Issue 和 Pull Request。
2. 行为变更请先创建 Issue，确认范围和兼容性再实现。
3. 不要在公开 Issue 中披露漏洞；请遵循[安全策略](SECURITY.zh-CN.md)。

## 开发流程

```bash
git clone https://github.com/cpj-dev/dsh-plugin-cc.git
cd dsh-plugin-cc
npm test
```

本项目刻意保持零运行时和开发依赖，因此不需要安装步骤。请使用独立分支，保持改动聚焦，并为行为变更补充测试。

## 文档和本地化

- 英文是技术事实的权威版本；简体中文维护用户、贡献、支持、安全和行为准则入口。
- 用户可见行为变化时，同一个 Pull Request 必须同时更新英文源和对应中文页。
- 命令名、参数、环境变量、路径、JSON 字段、状态值和日志保持英文。
- 私有实现笔记放在已忽略的 `/.internal/` 或 `/implementation-notes.md`；需要长期维护的公开设计决策应写入 `docs/`。

## Pull Request 要求

- 说明问题、解决方案和兼容性影响。
- 关联已有 Issue（如有）。
- 提供自动化测试结果和手工检查说明。
- 不混入无关重构。
- 确认不包含凭据、本机路径、生成文件或私有笔记。

参与本项目即表示同意遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。如中英文存在冲突，以英文规则为准。
