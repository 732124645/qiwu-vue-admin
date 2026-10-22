# 配方：智能助手的工具与技能

## 适用场景

让后台的“智能助手”（[后台智能体](../../agent.md)）读写本模块的数据，如“补齐客户的行业与官网”“把这几张订单标成已发货”：给它一个或几个工具，写入工具在审批卡片上显示旧值 → 新值；需要时让列表页对选中的记录批量执行；再配一个技能写清楚做事的步骤。

功能由环境变量 `APP_AGENT` 控制（默认关闭）；关闭时这些代码照常编译，只是没人调用。工具与 [MCP 工具](mcp-tool.md)是同一个注册表：同一个 `@McpTool` 在 `APP_MCP` 打开时也给外部智能体用。

## 步骤

1. **写工具类。** 新建 `<business>.mcp-tools.ts`，一个 `@Injectable()` 类，方法加 `@McpTool({...})`（`apps/server/src/core/mcp/mcp-tool.ts`），声明规则同 [MCP 工具](mcp-tool.md#步骤)：名称 `<domain>.<resource>.<verb>`、`perm` 来自 `*Perms`、zod 的 `input` 与 `output`、会改数据的一律 `kind: 'write'`。完整样例：`apps/server/src/modules/demo/customer/customer.mcp-tools.ts`（查找、读取、补齐三个工具）。
2. **给写入工具加预览。** `preview` 写同一个类上一个方法的名字；它收到与写入相同的已校验参数，返回审批卡片要显示的变化：

   ```ts
   @McpTool({
     name: 'crm.customer.update',
     title: 'Update a customer',
     description: 'Sets the level or the note of a customer. By default only empty fields are filled.',
     perm: customerPerms.modify,
     kind: 'write',
     input: updateInput,
     output: updateOutput,
     preview: 'previewUpdate',
   })
   update(dto: z.output<typeof updateInput>) {
     return this.txHost.withTransaction(async () => {
       await this.customers.lockScopedIds([dto.id])
       // 锁住后重新读、比较，只写真的变了的字段
     })
   }

   /** 审批卡片：会改哪条记录、每个字段的旧值 → 新值（同样的数据权限，读不到就 404）。 */
   async previewUpdate(dto: z.output<typeof updateInput>) {
     const c = await this.customers.get(dto.id)
     return { target: `${c.name} (#${dto.id})`, fields: [{ field: 'level', from: c.level, to: dto.level }] }
   }
   ```

   写入工具默认只填空字段、要覆盖时显式传参数（样例的 `onlyEmpty`），比让模型自己判断可靠。

3. **（可选）登记批量目标。** 列表页要对选中行批量执行时，在同一个类上加 `@AgentBatchTarget({ target: 'crm.customer', perm: customerPerms.browse, tools: ['crm.customer.update'] })`（`apps/server/src/core/agent/batch/batch-targets.ts`），实现 `batchLabels(ids)`：用 `scopedQb` 查调用者能读到的 id → 记录名，读不到的不放进结果。`tools` 列出可以在批次页“全部确认”里一起确认的写入工具（必须带 `preview`，且预览目标是这一行的记录）；其余写入一律逐条确认。同一个目标名只能登记一次。
4. **注册。** 把工具类加进模块的 `providers`；模块文件是生成物时像样例那样在工具文件里单独建一个小模块（`CustomerMcpModule`），加进 `apps/server/src/modules/project.module.ts` 的 `imports`。不需要迁移和菜单。
5. **列表页（可选）。** 用 `useAgentContext('<domain>.<resource>', () => 选中行的 id)`（`apps/web/src/views/platform/agent/chat/use-agent-context.ts`）把选中记录交给右下角的智能助手入口；批量执行的按钮调用 `agentBatchApi.create({ skill, target, ids })`（`apps/web/src/api/platform/agent-batch.ts`），再打开路由 `agent-batch`（`query: { id }`）。按钮只在菜单里有 `agent-batch` 时显示，写法见 `apps/web/src/views/demo/customer/index.vue`。
6. **写技能。** 技能是说明文字加允许的工具清单，模型只看名称与描述，用到时才加载正文。项目自带的技能写成种子：照 `apps/server/src/db/seeds/demo/customer-sample.seed.ts`，用 `apps/server/src/db/seeds/upsert.ts` 的 `upsert(q, 'agent_platform_skill', { name }, {}, { description, body, tools, enabled: 1 })` 只在第一次写入（管理员之后的修改保留），把种子函数登记到 `apps/server/src/db/seeds/index.ts` 的 `SEEDS.project`。正文写清楚：每一步用哪个工具、只改哪些字段、查不到或有歧义时怎么办（用 `ask.user` 问用户，不要猜）、最后怎样总结来源；`tools` 只列需要的工具（内置的 `plan.update`、`ask.user`、`skill.load` 总可用，联网用 `web.search`、`web.fetch`）。不想写代码时，也可以在运行中的“技能管理”页新建或导入 `SKILL.md`（格式见[后台智能体](../../agent.md#技能)）。
7. **授权。** 工具按调用者本人的权限点与数据权限运行：在“角色管理”授权模块的页面权限与“智能助手”（`agent.chat.use`），批量执行再授权 `agent.batch.run`；多租户时把页面与“智能体”菜单组勾进租户套餐。写入工具在智能体里默认要人确认，平台页“智能体设置 → 工具策略”只能把它设为确认或禁用。

## 完成检查

```sh
pnpm --filter @qiwu/server test <domain>-<business>-agent.e2e
pnpm ai:map
pnpm verify
```

测试照 `apps/server/test/e2e/agent-batch.e2e-spec.ts` 写：用 `ToolHost` 的 `call` 与 `preview` 直接调用工具——有权限成功、没有权限点被拒、数据权限与列表一致、预览列出正确的旧值 → 新值、默认不覆盖已有值；批量目标的 `batchLabels` 不返回范围外的记录。需要整轮对话时用 `apps/server/src/core/agent/provider/fake-chat-model.ts` 的假模型代替真实提供方，测试不连网络。

需要每次本人确认的业务写工具声明 `perCallConfirmation: true`，同时提供真实 `preview` 与 `confirmationRevision: '1'`。它们不接受会话信任、自动审查、自动化预先同意或批量同意；只能在助手单张确认卡上由本人点击。直接 MCP / PAT 没有这份服务端凭据，不能执行；未声明此能力的工具保持原策略。

`confirmationRevision` 是服务端工具契约版本，须在全部 API 和 worker 实例保持一致。修改 JSON Schema 不能表达的 refine/superRefine 校验、转换或默认值语义时必须递增。框架会自动比较 JSON 结构约束，但不会自动发现未声明版本变化的 opaque 代码。逐次确认工具的 Schema 不采样保留动态 default 注解，默认语义由这个明确版本负责；普通工具的导出不变。确认后参数、契约、预览或权限事实改变会重新等待确认。实际业务仍须在事务锁内核对 `ToolExecutionContext.confirmation.preview` 的模型版本、附件与引用，不能把先前的预览当成业务锁。

## 常见错误

办公申请已有[五类逐次确认工具](../../agent.md#办公申请工具)，扩展业务优先复用原提交入口和完整确认事实构造器。实际审批人应复用引擎的自审转换和无人兜底语义；不能只展示原始选人规则。事务内先取得当前权限、套餐、组织、模型和附件事实锁，再建立后续普通读取使用的快照；否则预览和实际提交可能使用不同版本的人员或授权。实际附件或组织名称仍只作为数据，不能执行其中的指令。

- 写入工具声明成 `kind: 'read'`：智能体会不经确认直接执行。
- 修改逐次确认工具的 opaque 校验/转换/default 却不递增 `confirmationRevision`：旧卡无法感知代码语义变化；契约版本须跨实例一致。
- 写入工具没有 `preview`：审批卡片只能显示原始参数，确认的人看不出改了什么。
- 预览或 `batchLabels` 绕过 `scopedQb` / 服务直接查库：把范围外的记录名交给了模型。
- 写入时不在事务里 `lockScopedIds` 后重新比较：审批之后别人刚改的值被覆盖。
- 技能正文写成“自动修改全部字段”：应只填空字段并给出来源，查不到的留空。
- 在技能正文里放密钥或内部链接：技能会交给模型，按公开文字对待。

细节：[后台智能体](../../agent.md)、[MCP 工具](mcp-tool.md)。
