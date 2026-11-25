import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { AgentRetire20261125040531 } from '../../src/db/migrations/20261125040531-agent-retire.js'
import { insertRow } from '../../src/db/seeds/upsert.js'

let ds: DataSource
const menus: number[] = []
const packages: number[] = []
const params: number[] = []
const inbox: number[] = []
const mail: number[] = []

beforeAll(async () => {
  ds = await new DataSource(dataSourceOptions()).initialize()
})
afterAll(async () => {
  if (packages.length) {
    await ds.query('DELETE FROM iam_tenant_package_menus WHERE package_id IN (?)', [packages])
    await ds.query('DELETE FROM iam_tenant_package WHERE id IN (?)', [packages])
  }
  if (menus.length) {
    // qw:cross-tenant 测试清理自己插入的旧平台菜单引用，保留其他角色和菜单。
    await ds.query('DELETE FROM iam_role_menus WHERE menu_id IN (?)', [menus])
    await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus])
  }
  if (params.length) await ds.query('DELETE FROM cfg_param WHERE id IN (?)', [params])
  if (inbox.length) await ds.query('DELETE FROM msg_inbox_template WHERE id IN (?)', [inbox])
  if (mail.length) await ds.query('DELETE FROM msg_mail_template WHERE id IN (?)', [mail])
  await ds?.destroy()
})

const deletedAt = async (table: string, id: number) =>
  // arch-allow: sql-concat 表名只来自本文件的固定调用。tenant: 测试按主键读取自己插入的行。
  (await ds.query(`SELECT deleted_at FROM ${table} WHERE id = ?`, [id]))[0].deleted_at

it('retires legacy assistant entry points, settings and templates and leaves the rest alone', async () => {
  const group = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'group',
    route_name: 'agent',
    route_path: '/agent',
    name: 'test.legacy.agent.group',
    enabled: 1,
    visible: 1,
  })
  menus.push(group)
  const page = await insertRow(ds.manager, 'iam_menu', {
    parent_id: group,
    kind: 'page',
    route_name: 'agent-chat',
    route_path: '/agent/chat',
    name: 'test.legacy.agent',
    enabled: 1,
    visible: 1,
  })
  menus.push(page)
  const action = await insertRow(ds.manager, 'iam_menu', {
    parent_id: page,
    kind: 'action',
    perms: 'agent.chat.use',
    name: 'test.legacy.agent.use',
  })
  menus.push(action)
  const ordinary = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'page',
    route_name: 'test-agent-retire',
    route_path: '/test/agent-retire',
    name: 'test.agent.retire',
  })
  menus.push(ordinary)
  const [{ id: role }] = await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_role WHERE tenant_id = 1 AND code = 'member' AND deleted_at IS NULL",
  )
  await insertRow(ds.manager, 'iam_role_menus', { tenant_id: 1, role_id: role, menu_id: action })
  await insertRow(ds.manager, 'iam_role_menus', { tenant_id: 1, role_id: role, menu_id: ordinary })
  const packageId = await insertRow(ds.manager, 'iam_tenant_package', {
    name: 'test assistant retirement',
  })
  packages.push(packageId)
  await ds.query(
    'INSERT INTO iam_tenant_package_menus (package_id, menu_id) VALUES (?, ?), (?, ?)',
    [packageId, action, packageId, ordinary],
  )
  const oldParam = await insertRow(ds.manager, 'cfg_param', {
    param_key: 'agent.test_retired',
    param_value: 'true',
    name: 'test retired',
  })
  params.push(oldParam)
  const liveParam = await insertRow(ds.manager, 'cfg_param', {
    param_key: 'test.agent_retire.kept',
    param_value: 'true',
    name: 'test kept',
  })
  params.push(liveParam)
  const template = { locale: 'zh-CN', name: 'test', title: 't', body: 'b', category: 'system' }
  const oldInbox = await insertRow(ds.manager, 'msg_inbox_template', {
    ...template,
    code: 'agent.turn.waiting',
  })
  inbox.push(oldInbox)
  const liveInbox = await insertRow(ds.manager, 'msg_inbox_template', {
    ...template,
    code: 'test.agent_retire.kept',
  })
  inbox.push(liveInbox)
  const oldMail = await insertRow(ds.manager, 'msg_mail_template', {
    code: 'agent.automation.result',
    locale: 'zh-CN',
    name: 'test',
    subject: 's',
    body: 'b',
  })
  mail.push(oldMail)
  const liveMail = await insertRow(ds.manager, 'msg_mail_template', {
    code: 'test.agent_retire.kept',
    locale: 'zh-CN',
    name: 'test',
    subject: 's',
    body: 'b',
  })
  mail.push(liveMail)

  const q = ds.createQueryRunner()
  try {
    const migration = new AgentRetire20261125040531()
    await migration.up(q)
    const retired = await ds.query<{ enabled: number; visible: number; deleted_at: Date }[]>(
      'SELECT enabled, visible, deleted_at FROM iam_menu WHERE id IN (?)',
      [[group, page, action]],
    )
    expect(retired).toHaveLength(3)
    for (const row of retired) {
      expect(row.enabled).toBe(0)
      expect(row.visible).toBe(0)
      expect(row.deleted_at).toBeInstanceOf(Date)
    }
    const grants = await ds.query<{ menu_id: number; deleted_at: Date | null }[]>(
      'SELECT menu_id, deleted_at FROM iam_role_menus WHERE tenant_id = 1 AND menu_id IN (?)',
      [[action, ordinary]],
    )
    expect(grants.find((g) => g.menu_id === action)?.deleted_at).toBeInstanceOf(Date)
    expect(grants.find((g) => g.menu_id === ordinary)?.deleted_at).toBeNull()
    const links = await ds.query<{ menu_id: number; deleted_at: Date | null }[]>(
      'SELECT menu_id, deleted_at FROM iam_tenant_package_menus WHERE package_id = ?',
      [packageId],
    )
    expect(links.find((l) => l.menu_id === action)?.deleted_at).toBeInstanceOf(Date)
    expect(links.find((l) => l.menu_id === ordinary)?.deleted_at).toBeNull()
    expect(await deletedAt('cfg_param', oldParam)).toBeInstanceOf(Date)
    expect(await deletedAt('cfg_param', liveParam)).toBeNull()
    expect(await deletedAt('msg_inbox_template', oldInbox)).toBeInstanceOf(Date)
    expect(await deletedAt('msg_inbox_template', liveInbox)).toBeNull()
    expect(await deletedAt('msg_mail_template', oldMail)).toBeInstanceOf(Date)
    expect(await deletedAt('msg_mail_template', liveMail)).toBeNull()
    const [menu] = await ds.query('SELECT enabled, deleted_at FROM iam_menu WHERE id = ?', [
      ordinary,
    ])
    expect(menu).toEqual({ enabled: 1, deleted_at: null })
    // 重复执行保持首次退役时间，down 不复活任何入口。
    const first = await deletedAt('iam_menu', page)
    await migration.up(q)
    await migration.down()
    expect(await deletedAt('iam_menu', page)).toEqual(first)
  } finally {
    await q.release()
  }
})
