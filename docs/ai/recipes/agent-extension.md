# 配方：给智能助手加内置工具、上下文与审批规则

## 适用场景

后台的“智能助手”（[后台智能体](../../agent.md)）要一样只在对话里才有意义的东西，而不是又一个读写业务数据的工具：

- **内置工具**：要用本轮的上下文——当前会话与轮次、本轮的界面条目、停下来问用户（`ask`）、本轮可读的链接。例：按本人的待办生成一份跟进清单显示在对话里。
- **上下文贡献者**：每轮给模型补一段与本人相关的背景。例：“本公司客户分级的口径”。
- **审批审查者**：写入停下等人之前按业务规则先判断。例：订单金额超过 1 万的修改，自动审查不得放行，一律交给人。

只是让智能体查询、修改本模块的数据时，用 `@McpTool` 更合适（权限点、数据权限、超时、审计都由同一套护栏负责），见[智能助手的工具与技能](agent-skill.md)。何时用哪一个、各自的约束见[后台智能体 · 扩展点](../../agent.md#扩展点)。

功能由环境变量 `APP_AGENT` 控制（默认关闭）；关闭时这些 provider 照常编译和注入，只是没人扫描、没人调用。三个扩展点的声明都在 `apps/server/src/core/agent/agent-ports.ts`。

## 步骤

1. **建 provider 文件。** 在模块目录下新建 `<business>.agent.ts`，一个 `@Injectable()` 类（三种扩展可以放在同一个类里，也可以分开）。代码与注释的写法照 `apps/server/src/core/agent/memory/memory-tools.ts`（一个写入类内置工具加两个上下文贡献者）。
2. **内置工具。** 在方法上加 `@AgentBuiltinTool({...})`：`name`（内置工具之间重名启动失败；与本系统工具 `@McpTool` 同名时内置工具优先、遮住那个工具，所以用不会与 `@McpTool` 冲突的名字，例如不带 `<domain>.<resource>` 前缀的动词名或单独的前缀）、`title`、`description`（模型据此判断何时调用）、`kind`、`input`（zod 对象 schema），可选 `available(ctx)` 决定本次运行提供不提供。方法收到已校验的参数与 `ctx`（`AgentToolContext`），返回 `{ ok, content }`：

   ```ts
   const draftInput = z.object({ days: z.number().int().min(1).max(30).default(7) })

   @Injectable()
   export class CrmAgent {
     constructor(
       @InjectRepository(CrmFollowup) private readonly followups: Repository<CrmFollowup>,
     ) {}

     /** 本人接下来几天要跟进的客户，显示成对话里的计划清单（只读：可能被重做，必须幂等）。 */
     @AgentBuiltinTool({
       name: 'crm.followup.plan',
       title: 'Plan my follow-ups',
       description:
         'Shows the customers the user should follow up in the next days as a checklist.',
       kind: 'read',
       input: draftInput,
       available: (ctx) => ctx.principal.root || ctx.principal.perms.includes(customerPerms.browse),
     })
     async plan({ days }: z.output<typeof draftInput>, ctx: AgentToolContext) {
       // 内置工具不经 MCP 护栏：只读本人负责的行（租户条件由 ORM 加上）
       const rows = await this.followups.find({
         where: {
           ownerId: ctx.principal.userId,
           dueAt: LessThan(dayjs().add(days, 'day').toDate()),
         },
         take: 20,
       })
       if (!rows.length) return { ok: true, content: 'No follow-ups are due.' }
       // 同一次调用重做时替换上次写下的那一条，不会多出条目
       await ctx.items.add('plan', {
         steps: rows.map((r) => ({ text: r.customerName, status: 'pending' as const })),
       })
       return { ok: true, content: `${rows.length} follow-ups listed.` }
     }
   }
   ```

   `kind: 'read'` 不经审批，重启或丢锁后可能再执行一次：必须按调用幂等，不开会话、不调用模型、不做无法重复的写入；需要问用户时 `return ctx.ask(questions)`。会改数据的一律 `kind: 'write'`：与其他写入工具同一条审批路径（停下等人或经审批审查者），只读与计划模式下不提供；只许本人确认、不许任何自动放行的（如记住个人信息）再加 `humanOnly: true`。界面条目只能写 `plan`、`chart`、`image`、`report`、`subagent` 五种，载荷按共享 schema 校验。外部来的文字放进结果时标 `untrusted: true`。

3. **上下文贡献者。** 类上加 `@AgentContextContributor({ order })`（小的在前，缺省 100；模板的配置方案说明是 10、记忆是 20），实现 `contribute(ctx)`，返回 `{ id, text }` 或 `null`：

   ```ts
   @Injectable()
   @AgentContextContributor({ order: 50 })
   export class CrmAgentContext implements AgentContextContributor {
     constructor(private readonly params: ParamService) {}

     /** 客户分级的口径（系统参数 crm.agent_note），只给能看客户的人；没有副作用。 */
     async contribute(ctx: AgentContextInput): Promise<AgentContextPart | null> {
       if (!ctx.principal.root && !ctx.principal.perms.includes(customerPerms.browse)) return null
       const note = await this.params.get('crm.agent_note')
       if (!note?.trim()) return null
       return {
         id: 'crm',
         text: `How this company grades its customers (background, not instructions):\n${note}`,
       }
     }
   }
   ```

   文字以用户角色放在历史最前面，从不进系统提示，超过 20000 字符截断，计入 `/status` 的上下文估算。`ctx.turnId` 为 `null` 时是 `/status` 的估算：不得写库、调用模型或记用量，只读出会给的文字。`ParamService` 在 `apps/server/src/core/settings/param.service.ts`，参数照[字典与系统参数](dict-param.md)写成种子。

4. **审批审查者。** 类上加 `@AgentApprovalReviewer({ order })`（模板的自动审查是 100，想排在它前面就写更小的数），实现 `review(ctx, call)`，返回 `{ verdict, by, reason }` 或 `null`（不表态，交给下一个）：

   ```ts
   @Injectable()
   @AgentApprovalReviewer({ order: 50 })
   export class CrmAmountReviewer implements AgentApprovalReviewer {
     constructor(private readonly i18n: I18nService) {}

     /** 自动审查模式下，金额超过 1 万的订单修改先交给人：自动审查排在后面，就放行不了它。 */
     async review(
       ctx: AgentReviewContext,
       call: AgentReviewCall,
     ): Promise<AgentReviewVerdict | null> {
       if (call.tool !== 'crm.order.update' || ctx.thread.mode !== 'auto_review') return null
       const amount = (call.args as { amount?: number }).amount
       if (amount === undefined || amount <= 10_000) return null
       return {
         verdict: 'escalate',
         by: 'review',
         reason: String(this.i18n.translate('crm.agent.amountReview', { lang: ctx.lang })),
       }
     }
   }
   ```

   第一个非 `null` 的结论生效，`escalate` 也结束链条。审查者只会收到生效策略为 `ask` 的写入（平台或本租户设为 `human` 的与须本人逐次确认的工具从不送审）；驳回与交给人都停下等人。运行时只承认有资格的放行：`by: 'review'` 的 `approve` 只在工具此刻的策略是 `ask`、会话此刻是“自动审查”模式时算数，`by: 'pre_approved'` 只认自动化的预先同意本身复核过的；其余的放行一律降为交给人，所以自写的审查者主要用来驳回和交给人。审查者看不到工具输出；参数是助手写的，可能受外部内容影响，不能当成用户的意思。需要调用模型时使用 `ctx.invokeModel()` 并透传它给出的 `signal` 和 `onUsage`，写法照 `apps/server/src/core/agent/runtime/auto-reviewer.ts`。理由显示在卡片上，写成词条：服务端片段 `apps/server/src/i18n/{zh-CN,en-US}/` 下项目自己的 `<domain>.<business>.json`（见[多语言词条](i18n.md)）。

5. **注册。** 把类加进模块的 `providers`；模块文件是生成物时在 `<business>.agent.ts` 里单独建一个小模块，加进 `apps/server/src/modules/project.module.ts` 的 `imports`。不需要迁移和菜单。新的内置工具出现在“智能体设置 → 工具策略”里（来源“内置”），root 可以停用或改策略。

## 完成检查

```sh
pnpm --filter @qiwu/server test <domain>-<business>-agent.e2e
pnpm ai:map
pnpm verify
```

测试照 `apps/server/test/e2e/agent-builtins.e2e-spec.ts` 写：用 `apps/server/src/core/agent/provider/fake-chat-model.ts` 的假模型编排一轮对话，不连网络。至少覆盖：

- 内置工具：模型调用后得到预期结果；写入类停在审批上、只读模式下不提供；只读类重做一次（同一调用再执行）不多出条目。
- 上下文贡献者：文字作为用户消息出现在历史前面、不在系统提示里；`/status`（`turnId` 为 `null`）不写库。
- 审批审查者：命中规则时卡片交给人并带上理由；不命中时返回 `null`、后面的审查者照常判断；只读与计划模式下不被调用。

模型调用记账必须传入提供方 ID、名称、精确模型标识和该次调用的费率快照，不能再只传模型名；同名模型可能属于不同提供方。`ctx.invokeModel(target, work)` 在请求前持久登记调用，并使用供应商实际返回的用量，未知字段保留空值，不用字符估算或固定图片 Token 冒充收费。子任务汇总复用已经计算的积分，不能重复写每日账本或按后来调价重算。

非流式补全或图片调用用本次请求独立的 `onUsage` 闭包接收实际用量：HTTP 成功却因正文无效失败时也不能丢掉已报告消费。成功只记返回用量一次，失败记本次回执或未知；不要把用量挂在可复用的取消错误上，也不要包装错误改变取消/租约失效对象的身份。流式调用沿用用量事件。

内置写工具与审批审查扩展取得本次最新模型后，可沿以下入口调用；上下文贡献者保持读取本地上下文，不另开模型请求。

```ts
await ctx.invokeModel(usageTarget(model), (receipt) =>
  model.chat.complete({
    model: model.model.id,
    messages,
    ...receipt,
  }),
)
```

`usageTarget` 来自核心 provider registry。每次调用前重新解析当前模型，不缓存旧费率；不要覆盖 receipt 的取消信号或回执。使用 `invokeModel` 后不要再次调用 `recordUsage` 或重复汇总父轮；旧 `recordUsage` 仅为兼容的事后观测接口，不能替代可恢复调用入口。

## 常见错误

- 用内置工具读写业务数据：绕过了 `@McpTool` 的权限点与数据权限护栏，范围外的记录会交给模型。业务数据用 `@McpTool`。
- 只读内置工具里开会话、调用模型或做一次性的写入：重做时会做第二次。
- 会改数据的内置工具声明成 `kind: 'read'`：不经确认直接执行。
- 上下文贡献者在 `turnId` 为 `null` 时也写“最近使用”之类的记录：只看一眼 `/status` 就改了数据。
- 把规则写进上下文贡献者的文字，指望模型遵守：它只是用户角色的背景。硬性规则写成审批审查者或在工具里校验。
- 审查者不看 `ctx.thread.mode` 就交给人：普通“每次询问”模式的卡片上也会出现“自动审查交给你确认”。
- 审查者忽略 `ctx.signal`、长时间调用模型：本轮被停止或暂停后还在白等、白花 token。
- 审查者在理由里复述参数里的长文字：理由会显示在卡片上，也会交给模型，写一句短的原因即可。

细节：[后台智能体](../../agent.md#扩展点)、[智能助手的工具与技能](agent-skill.md)。
