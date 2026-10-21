---
name: qiwu-job
description: 在栖梧项目里新增后台队列任务（QueueService.add 与 TenantJobProcessor）或定时任务处理器（@JobHandler）。工作需要异步执行、失败重试或按 cron 周期运行时使用。
---

1. 先读 `AGENTS.md`；项目有 `docs/project-rules.md` 时一并读，冲突时以它为准。
2. 按 `docs/ai/recipes/job.md` 逐步执行。
3. 结束前运行配方的完成检查：`pnpm --filter @qiwu/server test <spec 文件名去掉 -spec.ts>`、`pnpm ai:map`，最后 `pnpm verify`。
