// Tenant brands (see docs/design-notes.md#tenancy): a tenant's brand name and logo sit on its row, the logo
// being a public object of the default tenant (the platform uploads it). The sign-in pages get the brand of
// the host's tenant (`GET /auth/tenancy`; none on a host bound to no tenant), a signed-in user that of the
// session's tenant (`/me.tenant`). Whatever tenant the request runs in, the logo's URL is read in the
// default tenant: an object of another tenant or a deleted one shows no logo. Rows are written straight.
import { randomUUID } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { MePayload } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { REDIS } from '../../src/core/redis/redis.module.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { addRow, bootApp, createTenant, signInDirect, type TestTenant } from '../setup/tenants.js'

/** bound to the default tenant */
const HOST_A = 'portal.tenant-brand.test'
const HOST_B = 'b.tenant-brand.test'
const IP = '198.51.100.21'

let on: NestExpressApplication
let ds: DataSource
let B: TestTenant
const objects: number[] = []
const tokens = { admin: '', bOwner: '' }

const http = () => request(on.getHttpServer())
/** GET /auth/tenancy on `host` (default: one bound to no tenant). */
async function tenancy(host?: string) {
  const req = http().get('/api/auth/tenancy').set('X-Forwarded-For', IP)
  return (await (host ? req.set('Host', host) : req).expect(200)).body.data
}
const meTenant = async (token: string) =>
  ((await http().get('/api/auth/me').set(bearer(token)).expect(200)).body.data as MePayload).tenant
const setBrand = (tenantId: number, brandName: string | null, logoObjectId: number | null) =>
  ds.query('UPDATE iam_tenant SET brand_name = ?, logo_object_id = ? WHERE id = ?', [
    brandName,
    logoObjectId,
    tenantId,
  ])

/** A public `cover` image of tenant `tenantId`, as an upload leaves it. */
async function cover(tenantId: number, uploaderId: number) {
  const key = `2026/10/13/${randomUUID()}.png`
  const [storage] = await ds.query<{ id: number }[]>(
    'SELECT id FROM fs_storage WHERE is_primary = 1 AND deleted_at IS NULL',
  )
  const url = `/files/${key}`
  const id = await addRow(on, tenantId, 'fs_object', {
    storage_id: storage!.id,
    object_key: key,
    original_name: 'logo.png',
    mime: 'image/png',
    size: 1,
    is_public: 1,
    public_url: url,
    biz_tag: 'cover',
    uploader_id: uploaderId,
  })
  objects.push(id)
  return { id, url }
}

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  await cleanRedis(on.get(REDIS))
  B = await createTenant(on, { domains: [HOST_B] })
  await ds.query('INSERT INTO iam_tenant_domain (tenant_id, domain) VALUES (1, ?)', [HOST_A])
  tokens.admin = (await signIn(on)).accessToken
  tokens.bOwner = (await signInDirect(on, B.ownerId))!.accessToken
})

afterAll(async () => {
  if (ds) {
    await setBrand(1, null, null)
    await ds.query('DELETE FROM iam_tenant_domain WHERE domain = ?', [HOST_A])
    if (objects.length) await ds.query('DELETE FROM fs_object WHERE id IN (?)', [objects])
    await B?.dispose()
    await cleanRedis(on.get(REDIS))
  }
  await on?.close()
})

describe('the default tenant', () => {
  it('without a brand: empty brand fields on its bound host and in /me, no tenant on an unbound host', async () => {
    const own = { code: 'default', name: 'seed.tenant.default', brandName: null, logoUrl: null }
    expect(await tenancy()).toEqual({ enabled: true })
    expect(await tenancy(HOST_A)).toEqual({ enabled: true, tenant: own })
    expect(await meTenant(tokens.admin)).toEqual({ id: 1, ...own, acting: false })
  })

  it('with a brand: shown the same way', async () => {
    const logo = await cover(1, 1)
    await setBrand(1, 'Platform', logo.id)
    try {
      const brand = { brandName: 'Platform', logoUrl: logo.url }
      expect((await tenancy(HOST_A)).tenant).toMatchObject(brand)
      expect(await meTenant(tokens.admin)).toMatchObject({ id: 1, ...brand })
    } finally {
      await setBrand(1, null, null)
    }
  })
})

describe('another tenant', () => {
  afterEach(() => setBrand(B.id, null, null))

  it('its brand on its bound host and in its users’ /me, the logo an object of the default tenant', async () => {
    const logo = await cover(1, 1)
    await setBrand(B.id, 'Brand B', logo.id)
    const brand = { code: B.code, name: B.code, brandName: 'Brand B', logoUrl: logo.url }
    expect(await tenancy(HOST_B)).toEqual({ enabled: true, tenant: brand })
    expect(await meTenant(tokens.bOwner)).toEqual({ id: B.id, ...brand, acting: false })
    // nowhere else: not on a host bound to no tenant, not for the default tenant
    expect(await tenancy()).toEqual({ enabled: true })
    expect(await meTenant(tokens.admin)).toMatchObject({ id: 1, brandName: null, logoUrl: null })
  })

  it('a logo naming an object of its own tenant or a deleted one shows none', async () => {
    const own = await cover(B.id, B.ownerId)
    const gone = await cover(1, 1)
    await ds.query('UPDATE fs_object SET deleted_at = NOW(3) WHERE id = ?', [gone.id])
    for (const logo of [own, gone]) {
      await setBrand(B.id, 'Brand B', logo.id)
      expect((await tenancy(HOST_B)).tenant).toMatchObject({ brandName: 'Brand B', logoUrl: null })
      expect(await meTenant(tokens.bOwner)).toMatchObject({ brandName: 'Brand B', logoUrl: null })
    }
  })
})
