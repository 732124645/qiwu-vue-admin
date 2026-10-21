---
name: qiwu-api-test
description: 为栖梧的服务端接口写端到端测试：成功、403、400、404，以及用 createTenant/dispose 的跨租户 404。新增或修改接口之后使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/api-test.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm --filter @qiwu/server test <spec 文件名去掉 -spec.ts>`，最后 `pnpm verify`。
