# 配方：字典与系统参数

## 适用场景

- **字典**：一组固定可选值（状态、分类、类型），存值是编码，显示是按语言的标签。例：图书分类 `demo.genre`。
- **系统参数**：管理员在“参数设置”里可改的单个配置值（上限、开关、默认值）。例：`audit.retention_days`。

字典表 `cfg_dict` / `cfg_dict_entry` 与参数表 `cfg_param` 是平台表，全部租户共用同一份。只属于某个租户的可选值不要用字典，建自己的租户表。

## 步骤

### 字典

1. **定编码。** 点分小写，以领域开头：`crm.customer_level`。条目的值也是字符串编码（`vip`、`normal`），不要用数字序号。
2. **写种子。** 在项目种子里调用 `upsertDicts`（`apps/server/src/db/seeds/settings/settings.seed.ts`），名称与标签两种语言都要写（存进 `name_i18n` / `label_i18n` JSON）。参照 `apps/server/src/db/seeds/demo/demo.seed.ts`：

   ```ts
   import type { EntityManager } from 'typeorm'
   import { type DictSeed, upsertDicts } from '../settings/settings.seed.js'

   const DICTS: DictSeed[] = [
     {
       code: 'crm.customer_level',
       nameI18n: { 'zh-CN': '客户等级', 'en-US': 'Customer level' },
       entries: [
         { value: 'normal', labelI18n: { 'zh-CN': '普通', 'en-US': 'Normal' }, isDefault: true },
         { value: 'vip', labelI18n: { 'zh-CN': '贵宾', 'en-US': 'VIP' }, tagType: 'success' },
       ],
     },
   ]

   export async function seedCrmDicts(q: EntityManager): Promise<string[]> {
     await upsertDicts(q, DICTS)
     return []
   }
   ```

   文件放在项目自己的目录（如 `apps/server/src/db/seeds/project/` 下新建一个文件），函数加进 `apps/server/src/db/seeds/index.ts` 的 `SEEDS.project`。种子只插入缺少的字典与条目，管理员改过的标签、排序保持不变。中文只允许出现在种子与词条文件里。

3. **生成器里绑定。** 在代码生成配置里给列选控件 `select` 并填 `dictCode`（参照 `apps/server/src/db/seeds/codegen/demo_book.cg.ts` 的 `genre`），生成的表单、列表、详情和 Excel 自动用字典标签。
4. **手写页面。** 表单用 `DictSelect`（`apps/web/src/core/components/DictSelect.vue`），只读展示用 `DictTag`（`apps/web/src/core/components/DictTag.vue`），脚本里用 `useDict(code)`（`apps/web/src/core/composables/use-dict.ts`）。参照 `apps/web/src/views/demo/book/form.vue`。
5. **服务端校验值。** 生成的 schema 不检查值是否在字典里；值必须合法时，在共享 schema 里写成固定枚举，或在服务里校验。

### 系统参数

1. **定键名。** 点分 snake_case（正则 `^[a-z][a-z0-9_.]*$`），以领域开头：`crm.max_contacts`。键名常量放在项目自己的共享文件（如 `packages/shared/src/<domain>/` 下），前后端共用；种子要用这个常量时，先 `pnpm --filter @qiwu/shared build` 再 `pnpm db:seed`（种子先 `nest build`，读的是 shared 的构建产物）。
2. **写种子。** 用 `upsert`（`apps/server/src/db/seeds/upsert.ts`）按 `param_key` 写入，参照 `apps/server/src/db/seeds/settings/settings.seed.ts` 的 `seedSettings`：第四个参数每次种子都更新（名称），第五个参数只在首次插入时写（值归管理员所有）：

   ```ts
   await upsert(
     q,
     'cfg_param',
     { param_key: 'crm.max_contacts' },
     {
       name: '每个客户的联系人上限',
       name_i18n: { 'zh-CN': '每个客户的联系人上限', 'en-US': 'Contacts per customer' },
       group_code: 'crm',
       is_builtin: 1,
       is_public: 0,
     },
     { param_value: '20' },
   )
   ```

3. **服务端读取。** 注入 `ParamService`（`apps/server/src/core/settings/param.service.ts`）：`get(key)` 取字符串，`int(key, min, max, fallback)` 取限定范围的整数（值缺失或非法时用 `fallback`）。不要自己缓存参数值。
4. **未登录也要读**（如登录页开关）：种子里 `is_public: 1`，前端调用 `GET /api/settings/params/public/:key`。秘密不要设为公开。

## 完成检查

```sh
pnpm --filter @qiwu/shared build
pnpm db:seed
pnpm i18n:check
pnpm ai:map
pnpm verify
```

在后台“字典管理”“参数设置”核对新行，切换中英文看标签。

## 常见错误

- 字典编码不带领域前缀，或用数字做条目值：与平台字典冲突，Excel 与接口里出现无意义的数字。
- 只写了中文标签：英文界面显示中文或编码。种子类型要求两种语言都写。
- 把参数默认值写进第四个参数：每次 `pnpm db:seed` 都会覆盖管理员改过的值。
- 把租户自己的可选项做成字典：所有租户看到同一份，任何租户的修改都影响别的租户。
- 前端硬编码字典选项：管理员改了字典页面不跟着变，用 `DictSelect` / `useDict`。

细节：[国际化：数据库键与用户文本](../../i18n.md#数据库键与用户文本)。
