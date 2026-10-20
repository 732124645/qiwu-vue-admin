// 项目自己的多租户登记（见 docs/design-notes.md#tenancy），由 core/db/tenant-tables.ts 与模板的登记合并。
// 本文件属于项目（模板发布时为空），模板升级不会改它：项目的表与键只登记在这里，不改 core 文件。
// 规则与模板相同：新表默认是租户表（带 `tenant_id`，唯一键以它开头）；只有平台运营方为全部租户统一
// 维护的表才登记为平台表；租户表的唯一键只有必须跨租户唯一时才登记为全局键，并写明占用的值怎样释放
// （`none` / `row-delete` / `takeover`）。两者保持纯字面量：检查脚本按文本读取。
import type { GlobalUnique } from '../core/db/tenant-tables.js'

/** 项目的平台表：全部租户共用，不加租户条件。 */
export const PROJECT_PLATFORM_TABLES: readonly string[] = []

/** 项目里保持全局唯一的租户表唯一键：索引名 → 所在表与释放方式。 */
export const PROJECT_GLOBAL_UNIQUE: Readonly<Record<string, GlobalUnique>> = {}
