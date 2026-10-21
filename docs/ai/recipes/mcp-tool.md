# 配方：MCP 工具

## 适用场景

让智能体通过 MCP（`POST /api/mcp`）以某个用户的身份调用本模块的能力，如“按名称查客户”“新建一本书”。工具在调用者的租户、权限点与数据权限下运行，直接调用模块已有的服务；限流、超时、参数校验、输出裁剪与操作日志由底座统一做。

功能由环境变量 `APP_MCP` 控制（默认关闭）；关闭时工具不注册，代码照常编译。

## 步骤

1. **写工具类。** 新建 `<business>.mcp-tools.ts`，一个 `@Injectable()` 类，方法加 `@McpTool({...})`（`apps/server/src/core/mcp/mcp-tool.ts`）。样例：`apps/server/src/modules/demo/book/book.mcp-tools.ts`（写入类）；只读工具的写法见[给自己的模块加工具](../../mcp.md#给自己的模块加工具)。

   ```ts
   @McpTool({
     name: 'crm.customer.search',
     title: 'Search customers',
     description: 'Finds customers the caller may see by part of their name; one page with the total.',
     perm: customerPerms.browse,
     kind: 'read',
     input: findInput,
     output: findOutput,
   })
   async search(input: z.output<typeof findInput>) {
     const { items, total } = await this.customers.page({ ...input })
     return { total, items }
   }
   ```

2. **按声明规则填写**（启动时检查，不满足即拒绝启动）：
   - `name` 全局唯一，`<domain>.<resource>.<verb>`，须匹配 `^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2}$`（`packages/shared/src/platform/mcp/mcp.schema.ts` 的 `MCP_TOOL_NAME`）：只有小写字母、数字与连字符，多词的业务段用连字符（`erp.sale-order.search`），不同于权限码的小驼峰（`erp.saleOrder.browse`）。
   - `perm` 是共享包某个 `*Perms` 常量里的权限点；只有任何登录用户都能读的数据才写 `null`。
   - `input` 是 zod 对象 schema，字段写 `.describe()`（会变成给智能体的 JSON Schema），并给出上下限（如 `pageSize` 最大 50）。
   - `output` 写上：结果按它裁剪，内部字段不会交给智能体。
   - 会改数据的工具一律 `kind: 'write'`；`title`、`description` 用英文写给智能体看。
3. **复用服务，不绕过规则。** 方法里调用模块服务（`page`、`create` 等），不要直接查库，这样数据权限、唯一性、创建人与页面一致。
4. **注册。** 把工具类加进模块的 `providers`。模块文件是生成物时不要改它（生成物要与生成器的输出保持一致，改了以后对比和重新生成都对不上），像样例那样在工具文件里单独建一个小模块（`BookMcpModule`），再加进 `apps/server/src/modules/project.module.ts` 的 `imports`。不需要迁移和菜单。
5. **租户与套餐。** 带 `perm` 的工具随租户套餐收窄；`perm: null` 的工具不受套餐限制，只想给某些套餐用时声明 `feature`。

## 完成检查

```sh
pnpm --filter @qiwu/server test <domain>-<business>-mcp.e2e
pnpm ai:map
pnpm verify
```

测试参照 `apps/server/test/e2e/mcp-tools.e2e-spec.ts`，用 `apps/server/test/e2e/mcp-kit.ts` 的 `patFor` 建个人访问令牌、`callTool` 调用：有权限成功；没有权限点被拒（`A0430`）；写入类工具对不允许写入的令牌被拒；数据权限与页面接口一致。

## 常见错误

- 写入类工具声明成 `kind: 'read'`：只读令牌也能改数据。
- `perm` 写了不存在于任何 `*Perms` 常量的字符串：启动失败。
- 不写 `output`，把实体整行返回：内部字段、秘密列交给了智能体。
- 在工具里直接用 Repository 查询：绕过数据权限。
- 输入不设上限（无限 `pageSize`、超长字符串）。
- 在 `@Transactional()` 写入类工具里做长时间工作：超时后已开始的事务仍可能提交，写入类工具保持单次短事务。

细节：[智能体接入（MCP）](../../mcp.md)。
