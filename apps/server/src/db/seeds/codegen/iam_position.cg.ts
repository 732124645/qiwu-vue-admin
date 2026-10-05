// Generator config of the golden position module (docs/codegen-golden.md): the edits on top of the
// iam_position import defaults. Change it only together with the committed module files
// (`pnpm gen:check-golden` re-renders them from it).
import type { CgSeed } from './codegen.seed.js'

export const iamPositionCg: CgSeed = {
  tableName: 'iam_position',
  table: {
    featureNameI18n: { 'zh-CN': '岗位管理', 'en-US': 'Positions' },
    options: {
      withExport: true,
      withImport: false,
      withOptions: true,
      menuIcon: 'lucide:briefcase-business',
      menuSortNo: 50,
      entityI18n: { 'zh-CN': '岗位', 'en-US': 'position' },
      // a position a user holds is not deleted (409 in_use, no foreign key)
      referencedBy: [{ table: 'iam_user_positions', column: 'position_id', label: '用户岗位' }],
    },
  },
  columns: {
    code: { labelI18n: { 'zh-CN': '岗位编码', 'en-US': 'Position code' } },
    name: {
      labelI18n: { 'zh-CN': '岗位名称', 'en-US': 'Position name' },
      options: { seedName: true, unique: true },
    },
    sort_no: { labelI18n: { 'zh-CN': '排序号', 'en-US': 'Sort order' } },
    enabled: { labelI18n: { 'zh-CN': '启用状态', 'en-US': 'Enabled' } },
    created_at: { inQuery: false },
  },
}
