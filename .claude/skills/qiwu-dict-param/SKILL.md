---
name: qiwu-dict-param
description: 在栖梧项目里新增字典（固定可选值）或系统参数，双语种子与前后端读取。字段需要可选编码、或需要管理员可改的配置值时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/dict-param.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm --filter @qiwu/shared build`、`pnpm db:seed`、`pnpm i18n:check`、`pnpm ai:map`，最后 `pnpm verify`。
