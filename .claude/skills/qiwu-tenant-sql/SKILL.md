---
name: qiwu-tenant-sql
description: 在栖梧项目里对租户表写原始 SQL，或写跨租户的代码（withTenant/allTenants 加 qw:cross-tenant，arch-allow sql-concat 加 tenant:）。写 tx.query/ds.query，或写扫描所有租户的任务时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/tenant-sql.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm arch:check`、带跨租户 404 的接口测试，最后 `pnpm verify`。
