---
name: qiwu-table-migration
description: 在栖梧项目里新建或修改数据库表：真实时间戳的迁移文件、tenant_id 与 @TenantColumn、软删除 alive、唯一键、project-tables 登记。新增表、列或索引时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/table-migration.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm db:migrate`、`pnpm --filter @qiwu/server test db-migrations`、`pnpm ai:map`，最后 `pnpm verify`。
