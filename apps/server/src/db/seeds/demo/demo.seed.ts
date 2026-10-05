// demo seed: what the generated demo modules (demo_book) use besides their own
// menus: their menu group `demo` (生成示例) under the developer tools group (db/seeds/codegen) and the
// `demo.genre` (books) and `demo.invoice_state` (invoices) dictionaries. Codes and texts made up for this project.
import type { EntityManager } from 'typeorm'
import { type DictSeed, upsertDicts } from '../settings/settings.seed.js'
import { findId, upsert } from '../upsert.js'

const DICTS: DictSeed[] = [
  {
    code: 'demo.genre',
    nameI18n: { 'zh-CN': '图书分类', 'en-US': 'Book genre' },
    entries: [
      { value: 'fiction', labelI18n: { 'zh-CN': '小说', 'en-US': 'Fiction' } },
      { value: 'science', labelI18n: { 'zh-CN': '科普', 'en-US': 'Popular science' } },
      { value: 'history', labelI18n: { 'zh-CN': '历史', 'en-US': 'History' } },
      { value: 'technology', labelI18n: { 'zh-CN': '技术', 'en-US': 'Technology' } },
      { value: 'children', labelI18n: { 'zh-CN': '少儿', 'en-US': 'Children' } },
    ],
  },
  {
    code: 'demo.invoice_state',
    nameI18n: { 'zh-CN': '发票状态', 'en-US': 'Invoice state' },
    entries: [
      { value: 'draft', labelI18n: { 'zh-CN': '草稿', 'en-US': 'Draft' }, tagType: 'info' },
      { value: 'issued', labelI18n: { 'zh-CN': '已开具', 'en-US': 'Issued' }, tagType: 'success' },
      { value: 'void', labelI18n: { 'zh-CN': '已作废', 'en-US': 'Void' }, tagType: 'danger' },
    ],
  },
]

export async function seedDemo(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'devtools' })
  if (parentId === undefined) throw new Error('seedDemo: the devtools menu group is missing')
  // the generated demo pages find it by route_name (their config's parent menu: the domain)
  await upsert(
    q,
    'iam_menu',
    { route_name: 'demo' },
    {
      parent_id: parentId,
      kind: 'group',
      name: 'menu.demo.title',
      route_path: '/demo',
      icon: 'lucide:flask-conical',
      sort_no: 40,
    },
  )
  await upsertDicts(q, DICTS)
  return []
}
