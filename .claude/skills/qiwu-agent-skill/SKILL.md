---
name: qiwu-agent-skill
description: 给栖梧后台的智能助手加一个读写本模块的工具（@McpTool，写入工具带审批预览）、可选的批量执行目标（@AgentBatchTarget）和一个技能。用户希望智能助手能查询、补齐或修改本模块数据，或对列表选中的记录批量处理时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/agent-skill.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm --filter @qiwu/server test <domain>-<business>-agent.e2e`、`pnpm ai:map`，最后 `pnpm verify`。
