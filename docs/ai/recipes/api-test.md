# 配方：接口测试

## 适用场景

新增或修改服务端接口后写端到端测试。每个接口至少覆盖：成功、没有权限点 403、参数不合法 400、不存在或超出数据范围 404；多租户下每个接口至少一条跨租户 404。生成的模块已带 `apps/server/test/e2e/<domain>-<business>.e2e-spec.ts`，只给手写部分写新 spec。

## 步骤

1. **文件名全仓唯一。** 端到端测试放在 `apps/server/test/e2e/`，命名 `<domain>-<business>[-<主题>].e2e-spec.ts`；生成模块的补充用例写进 `<domain>-<business>-extra.e2e-spec.ts`，不改生成的 spec。文件名不能是别的 spec 名字的一部分（运行时按名字筛选）。
2. **启动应用与登录。** 参照 `apps/server/test/e2e/demo-book.e2e-spec.ts`：`Test.createTestingModule({ imports: [AppModule] })` + `setupApp(...)` 启动，`signIn(app)` 拿管理员令牌，`bearer(token)` 设请求头（`apps/server/test/setup/auth.ts`）。测试数据带唯一前缀，`afterAll` 里删除本 spec 写入的行并 `app.close()`。
3. **四类用例。**
   - 成功：检查信封 `{ code: 0, data }`、分页 `{ items, total }` 与写入后的库内容。
   - 403：建一个只有 browse 权限的角色和一个没有角色的用户（`insertRow` 写 `iam_role`、`iam_role_menus`、`iam_user_roles`），断言 `res.body.code` 为 `Err.FORBIDDEN.code`。
   - 400：缺必填、超长、格式错，断言消息已翻译（字段名不是 `field.*` 键本身）。
   - 404：不存在的 id；带数据权限的模块再用 `own_dept` 角色访问别的部门的行，读写都 404 且库里没被改。
4. **跨租户 404。** 用 `apps/server/test/setup/tenants.ts` 的工具：

   ```ts
   describe('tenant isolation: the switch on, the rows of another tenant', () => {
     let on: NestExpressApplication
     let other: TestTenant
     beforeAll(async () => {
       on = await bootApp({ multiTenant: true })
       other = await createTenant(on)
     })
     afterAll(async () => {
       await other?.dispose()
       await on?.close()
     })
     // 用另一租户的管理员（signInDirect(on, other.ownerId)）建一行，
     // 再用默认租户的令牌读、改、删它：每个都 404，库里没被改
   })
   ```

   `afterAll` 里一定 `dispose()`：测试初始化（`apps/server/test/setup/tenant-leftovers.ts`）在每个 spec 文件结束时检查，留下租户的文件直接失败。生成 spec 末尾的 `tenant isolation` 分组是完整示例。

5. **公开接口。** 新的 `@Public()` 路由要在 `apps/server/test/e2e/tenant-public.e2e-spec.ts` 的 `PUBLIC_ROUTES` 里登记它的租户来源，否则该测试失败。这个 spec 属于模板，没有项目自己的登记处，升级时可能冲突，见[升级模板版本](../../upgrade.md#3-常见冲突与处理)。
6. **写接口的附加断言。** 新增类接口重复提交返回 429（`@Idempotent()`）；写接口在操作日志里有一行（`apps/server/test/setup/audit.ts` 的 `logOf`）。

## 完成检查

用 spec 文件名去掉 `-spec.ts` 作为筛选（完整名字，不用片段）：

```sh
pnpm --filter @qiwu/server test crm-customer-extra.e2e
pnpm verify
```

测试使用独立的测试库（`.env.test`，库名以 `_test` 结尾），每次运行开始会重建它；准备与本地快速模式见[入门指南：服务端测试](../../getting-started.md#服务端测试)。命令里不要加 `--`，它会让筛选失效、跑全部测试。

## 常见错误

- spec 名字与别的 spec 重名或是其片段（如 `customer` 与 `crm-customer`）：筛选跑进别的文件。
- 只测了成功路径：没有 403、400、404 用例。
- 跨租户用例只读了列表：还要对 get、update、delete、批量操作逐个断言 404。
- 忘了 `dispose()` 或 `app.close()`：留下租户的 spec 失败，留下的连接让测试挂起。
- 用开发库跑测试：测试会重置数据库，只用 `_test` 库。
- 改生成的 spec 来加用例：以后重新生成时与改过的文件冲突（生成器不覆盖已有文件），补充用例写进 `-extra` 文件。

细节：[多租户：编写租户感知的项目代码](../../multi-tenancy.md#编写租户感知的项目代码)、[代码生成：模板能力与公共控件](../../codegen.md#模板能力与公共控件)。
