---
name: qiwu-agent-extension
description: 给栖梧后台的智能助手加一个只在对话里有意义的内置工具（@AgentBuiltinTool）、每轮的背景上下文（@AgentContextContributor）或写入前的审批规则（@AgentApprovalReviewer）。用户希望智能助手在对话里显示清单、带上项目自己的背景说明，或对某类写入加一道交给人确认的规则时使用；只是读写本模块数据时改用 qiwu-agent-skill。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/agent-extension.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm --filter @qiwu/server test <domain>-<business>-agent.e2e`、`pnpm ai:map`，最后 `pnpm verify`。
