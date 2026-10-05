// Generator config of the demo_topic sample module (G0; see docs/design-notes.md#codegen): the `tree` template's sample, the
// edits on top of the demo_topic import defaults (a table with parent_id + tree_path imports as a tree,
// labelled by its title). The page hangs under the `demo` menu group (系统工具 / 生成示例, the import
// default: the domain), after the books. Change it only together with the committed module files
// (`pnpm gen:check-golden` re-renders them from it).
import type { CgSeed } from './codegen.seed.js'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })

export const demoTopicCg: CgSeed = {
  tableName: 'demo_topic',
  table: {
    featureNameI18n: both('知识主题', 'Knowledge topics'),
    options: {
      // the uni-app pages too (rendered only where the repository has the mobile client)
      withMobile: true,
      menuIcon: 'lucide:list-tree',
      menuSortNo: 20,
      entityI18n: both('主题', 'topic'),
    },
  },
  columns: {
    parent_id: { labelI18n: both('上级主题', 'Parent topic') },
    tree_path: { labelI18n: both('祖先路径', 'Tree path') },
    title: { labelI18n: both('主题名称', 'Title') },
    sort_no: { labelI18n: both('排序号', 'Sort order') },
    enabled: { labelI18n: both('启用状态', 'Enabled') },
    created_at: { inQuery: false },
  },
}
