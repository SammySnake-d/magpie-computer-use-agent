# GitHub 分发与 magpie 发现

本社区版本基于 [wbb6517/magpie-computer-use](https://github.com/wbb6517/magpie-computer-use)，保留其 MIT 许可和第三方来源声明。它通过公开 GitHub 仓库分发，不代表上游、OpenAI、Anthropic 或 magpie 官方版本。

在 magpie“扩展 → 插件”中添加 `github:SammySnake-d/magpie-computer-use-agent`，再在“资源库 → MCP 服务器”选择需要的 Agent。安装前请避免同时启用同名上游插件，防止 MCP 定义冲突。

GitHub 仓库使用 `magpie-plugin` topic 参与 magpie 的 GitHub 发现；GitHub 索引和 magpie 缓存可能延迟。官方推荐列表是独立的 `magpie-community/plugins` 注册表，topic 不等于推荐收录。

本版本未发布 npm。由于沿用上游包名，`package.json` 的 `private: true` 防止误将此社区版本发布到同名 npm 包；若将来需要 npm 分发，应先获得适当的包名与发布权限，另行决定和验证。

开发验证可运行 `npm test`、`npm run check` 和 `npm pack --dry-run --ignore-scripts`；不要把账户配置、密钥、原始批准文件或本机日志纳入仓库。
