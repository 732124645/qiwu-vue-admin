---
name: qiwu-new-module
description: 在栖梧项目里为一张新表新增业务模块（列表、表单、详情、导入导出），生成器优先。用户要求新增页面、模块或某张表的增删改查时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/new-module.md` 逐步执行，能用 `pnpm gen` 的步骤不手写。
3. 改了 shared 的导出或权限点后，先 `pnpm --filter @qiwu/shared build` 再运行 `pnpm db:seed` / `pnpm gen`（它们读 shared 的构建产物）；需要后台界面的步骤请用户操作，不自己启动 `pnpm dev`。
4. 结束前运行配方的完成检查：`pnpm --filter @qiwu/server test <domain>-<business>.e2e`、`pnpm ai:map`，最后 `pnpm verify`。
