import { randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'

export async function openContentApp() {
  const fake = fakeWxoaGateway()
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WxoaGateway)
    .useValue(fake.gateway)
    .compile()
  const app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  const ds = app.get<DataSource>(getDataSourceToken())
  // 每个内容与运营 e2e 实例清掉自己的 Redis 命名空间，避免统计/通知缓存污染下一条用例。
  await cleanRedis(app.get<Redis>(REDIS))
  const admin = (await signIn(app)).accessToken
  return { app, ds, admin, fake }
}

export async function addAccount(ctx: Awaited<ReturnType<typeof openContentApp>>) {
  const appId = `wx${randomBytes(8).toString('hex')}`
  const res = await request(ctx.app.getHttpServer())
    .post('/api/wxoa/accounts')
    .set(bearer(ctx.admin))
    .send({
      label: `content-${appId}`,
      appId,
      accountKind: 'service',
      appSecret: 'a'.repeat(32),
      token: 'contenttoken',
    })
    .expect(201)
  return { id: Number(res.body.data.id), appId }
}

/** 创建仅携带指定功能权限的公众号测试用户。 */
export async function addContentUser(
  ctx: Awaited<ReturnType<typeof openContentApp>>,
  perms: string[],
) {
  const suffix = randomBytes(6).toString('hex')
  const roleId = await inTenant1(() =>
    insertRow(ctx.ds.manager, 'iam_role', {
      code: `wxoa-e2e-${suffix}`,
      name: `wxoa-e2e-${suffix}`,
      data_scope: 'all',
    }),
  )
  for (const perm of perms) {
    const menuId = await inTenant1(() => findId(ctx.ds.manager, 'iam_menu', { perms: perm }))
    if (!menuId) throw new Error(`wxoa e2e permission is not seeded: ${perm}`)
    await ctx.ds.query(
      'INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)',
      [roleId, menuId],
    )
  }
  const username = `wxoa-e2e-${suffix}`
  const userId = await inTenant1(() =>
    insertRow(ctx.ds.manager, 'iam_user', {
      username,
      display_name: username,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
    }),
  )
  await ctx.ds.query('INSERT INTO iam_user_roles (tenant_id, user_id, role_id) VALUES (1, ?, ?)', [
    userId,
    roleId,
  ])
  return { accessToken: (await signIn(ctx.app, username)).accessToken, userId, roleId }
}

export async function closeContentApp(
  ctx: Awaited<ReturnType<typeof openContentApp>>,
  accountIds: number[],
  userIds: number[] = [],
  roleIds: number[] = [],
) {
  if (accountIds.length) {
    for (const table of [
      'wxoa_inline_image',
      'wxoa_mass_job',
      'wxoa_publish',
      'wxoa_draft',
      'wxoa_message',
      'wxoa_fan',
      'wxoa_tag',
      'wxoa_reply_rule',
      'wxoa_menu',
      'wxoa_material',
      'wxoa_qrcode',
      'wxoa_account',
    ])
      await ctx.ds
        .query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
        .catch(() => undefined)
  }
  if (userIds.length) {
    await ctx.ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
    await ctx.ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
  }
  if (roleIds.length) {
    await ctx.ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
    await ctx.ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
  }
  await ctx.app.close()
}
