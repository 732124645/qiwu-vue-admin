// Generator config of the demo_book sample module (G0; see docs/design-notes.md#codegen): the edits on top of the demo_book
// import defaults, with the detail drawer, export and import switched on so the optional template paths
// are rendered and tested too; its `dept_id` makes it data-scoped (the default), the department is
// picked in the form and shown in the detail drawer, not listed (a raw id). The page hangs under the `demo` menu group (系统工具 / 生成示例, the
// import default: the domain). Change it only together with the committed module files
// (`pnpm gen:check-golden` re-renders them from it).
import type { CgSeed } from './codegen.seed.js'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })

export const demoBookCg: CgSeed = {
  tableName: 'demo_book',
  table: {
    featureNameI18n: both('图书', 'Books'),
    withDetailView: true,
    options: {
      withExport: true,
      withImport: true,
      withOptions: false,
      // the uni-app pages too (rendered only where the repository has the mobile client)
      withMobile: true,
      menuIcon: 'lucide:library',
      menuSortNo: 10,
      entityI18n: both('图书', 'book'),
    },
  },
  columns: {
    isbn: { labelI18n: both('ISBN', 'ISBN'), inQuery: true, queryOp: 'like' },
    title: { labelI18n: both('书名', 'Title') },
    author: { labelI18n: both('作者', 'Author') },
    cover_url: { labelI18n: both('封面', 'Cover'), widget: 'image-upload' },
    published_on: { labelI18n: both('出版日期', 'Published on'), example: '2024-05-01' },
    price: { labelI18n: both('定价', 'Price'), example: '42.5' },
    genre: {
      labelI18n: both('分类', 'Genre'),
      widget: 'select',
      dictCode: 'demo.genre',
      inQuery: true,
      queryOp: 'eq',
      example: 'fiction',
    },
    dept_id: { labelI18n: both('所属部门', 'Department'), inList: false },
    enabled: { labelI18n: both('启用状态', 'Enabled') },
  },
}
