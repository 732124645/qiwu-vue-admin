---
name: qiwu-mcp-tool
description: 把栖梧模块的能力做成 MCP 工具（@McpTool），智能体按令牌用户的权限与数据权限调用。用户希望智能体或 MCP 客户端读写本模块数据时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/mcp-tool.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm --filter @qiwu/server test <domain>-<business>-mcp.e2e`、`pnpm ai:map`，最后 `pnpm verify`。
