import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import { seedOaAttendancePages } from '../../src/db/seeds/project/oa-attendance-pages.seed.js'
import { bootApp, inTenant1 } from '../setup/tenants.js'

let app: NestExpressApplication, ds: DataSource
beforeAll(async () => {
  app = await bootApp({ multiTenant: false })
  ds = app.get(getDataSourceToken())
})
afterAll(async () => app?.close())

describe('attendance page installation', () => {
  it('installs real pages without granting staff configuration or management actions', async () => {
    const pages = await ds.query(
      'SELECT id,route_name,component FROM iam_menu WHERE route_name IN (?) AND deleted_at IS NULL ORDER BY route_name',
      [['oa-clock-records', 'oa-attendance-policy', 'oa-attendance-sites']],
    )
    expect(pages).toHaveLength(3)
    expect(pages.map((p: { component: string }) => p.component).sort()).toEqual([
      'oa/attendance/index',
      'oa/attendance/policy',
      'oa/attendance/sites',
    ])
    const rows = await ds.query(
      'SELECT r.code,m.route_name,m.perms FROM iam_role_menus rm JOIN iam_role r ON r.id=rm.role_id JOIN iam_menu m ON m.id=rm.menu_id WHERE rm.tenant_id=1 AND r.tenant_id=1 AND r.code IN (?) AND r.deleted_at IS NULL AND rm.deleted_at IS NULL AND m.deleted_at IS NULL AND (m.route_name IN (?) OR m.perms LIKE ? OR m.perms LIKE ? OR m.perms LIKE ?) ORDER BY r.code,m.route_name,m.perms',
      [
        ['staff', 'member'],
        pages.map((p: { route_name: string }) => p.route_name),
        'oa.clock.%',
        'oa.attendance-policy.%',
        'oa.attendance-site.%',
      ],
    )
    expect(rows).toEqual([
      { code: 'member', route_name: 'oa-clock-records', perms: null },
      { code: 'staff', route_name: 'oa-clock-records', perms: null },
    ])
  })

  it('does not revive an old office-group grant when the personal attendance page is first installed', async () => {
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await inTenant1(async () => {
        const [page] = await runner.query('SELECT id FROM iam_menu WHERE route_name=?', [
          'oa-clock-records',
        ])
        const [group] = await runner.query('SELECT id FROM iam_menu WHERE route_name=?', ['oa'])
        const roles = await runner.query(
          'SELECT id,code FROM iam_role WHERE tenant_id=1 AND code IN (?) AND deleted_at IS NULL',
          [['staff', 'member']],
        )
        expect(roles).toHaveLength(2)
        await runner.query('DELETE FROM iam_role_menus WHERE menu_id=?', [page.id])
        await runner.query('DELETE FROM iam_menu WHERE id=?', [page.id])
        await runner.query(
          'UPDATE iam_role_menus SET deleted_at=NOW(3) WHERE tenant_id=1 AND role_id IN (?) AND menu_id=?',
          [roles.map((r: { id: number }) => r.id), group.id],
        )
        await seedOaAttendancePages(runner.manager)
        const [created] = await runner.query(
          'SELECT id FROM iam_menu WHERE route_name=? AND deleted_at IS NULL',
          ['oa-clock-records'],
        )
        expect(created.id).not.toBe(page.id)
        for (const role of roles) {
          const links = await runner.query(
            'SELECT menu_id,deleted_at FROM iam_role_menus WHERE tenant_id=1 AND role_id=? AND menu_id IN (?)',
            [role.id, [group.id, created.id]],
          )
          expect(
            links.find((r: { menu_id: number }) => r.menu_id === group.id)?.deleted_at,
          ).toBeInstanceOf(Date)
          expect(
            links.find((r: { menu_id: number }) => r.menu_id === created.id)?.deleted_at,
          ).toBeNull()
        }
      })
    } finally {
      await runner.rollbackTransaction()
      await runner.release()
    }
  })

  it('preserves edited, deleted and existing pages and never restores withdrawn employee links', async () => {
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await inTenant1(async () => {
        const [page] = await runner.query('SELECT id FROM iam_menu WHERE route_name=?', [
          'oa-clock-records',
        ])
        await runner.query('UPDATE iam_menu SET name=?,sort_no=987 WHERE id=?', [
          'Custom attendance',
          page.id,
        ])
        await runner.query(
          'UPDATE iam_role_menus SET deleted_at=NOW(3) WHERE tenant_id=1 AND menu_id=?',
          [page.id],
        )
        await seedOaAttendancePages(runner.manager)
        const [kept] = await runner.query('SELECT name,sort_no FROM iam_menu WHERE id=?', [page.id])
        expect(kept).toEqual({ name: 'Custom attendance', sort_no: 987 })
        expect(
          await runner.query(
            'SELECT menu_id FROM iam_role_menus WHERE tenant_id=1 AND menu_id=? AND deleted_at IS NULL',
            [page.id],
          ),
        ).toEqual([])
        await runner.query('UPDATE iam_menu SET deleted_at=NOW(3) WHERE id=?', [page.id])
        await seedOaAttendancePages(runner.manager)
        expect(
          await runner.query('SELECT id FROM iam_menu WHERE route_name=? AND deleted_at IS NULL', [
            'oa-clock-records',
          ]),
        ).toEqual([])
        const [group] = await runner.query('SELECT id FROM iam_menu WHERE route_name=?', ['oa'])
        await runner.query('UPDATE iam_menu SET deleted_at=NOW(3) WHERE id=?', [group.id])
        await runner.query('DELETE FROM iam_menu WHERE route_name=?', ['oa-attendance-policy'])
        await seedOaAttendancePages(runner.manager)
        expect(
          await runner.query('SELECT id FROM iam_menu WHERE route_name=?', [
            'oa-attendance-policy',
          ]),
        ).toEqual([])
      })
    } finally {
      await runner.rollbackTransaction()
      await runner.release()
    }
  })
})
