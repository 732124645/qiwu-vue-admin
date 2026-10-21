---
name: qiwu-data-scope
description: 让栖梧项目的表按调用者的数据范围（部门、本人）过滤：@DataScoped、scopedQb、lockScopedIds、dataScopeSql、qw:no-data-scope。行要按部门或创建人限制，或手写 SQL 读带数据权限的表时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/data-scope.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm arch:check`、对应的接口测试，最后 `pnpm verify`。
