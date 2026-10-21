---
name: qiwu-permission-menu
description: 在栖梧项目里新增权限点、菜单动作、菜单分组、操作日志动词并给角色授权。功能需要新权限、按钮、菜单项，或要授权给角色、租户套餐时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/permission-menu.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm --filter @qiwu/shared build`、`pnpm db:seed`、对应的接口测试、`pnpm ai:map`，最后 `pnpm verify`。
