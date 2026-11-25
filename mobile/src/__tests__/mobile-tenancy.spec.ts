// Multi-tenancy on the app: the sign-in pages' tenant code (shown, kept, sent), nothing of it while the
// switch is off, an unreadable switch asked again (never taken for off), the tenant package's features
// hiding the approval tab, its counts and the home shortcuts, the tenant's brand.
import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { MePayload, MeTenant, TenancyVo } from '@qiwu/shared'
import { hasFeature, visibleShortcuts, visibleTabs } from '@/core/features'
import { setSession } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import { useCountsStore } from '@/core/stores/counts'
import { TENANT_KEY, tenantBrand, useTenantCode } from '@/core/tenancy'

/** What `/auth/tenancy` answers (an Error: it fails); every other call answers `{}` / an empty page. */
let tenancy: TenancyVo | Error = { enabled: false }

beforeEach(() => {
  setActivePinia(createPinia())
  setSession({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800 })
  uni.removeStorageSync(TENANT_KEY)
  vi.mocked(uni.request).mockReset()
  vi.mocked(uni.request).mockImplementation((o) => {
    const reply =
      o.url === '/api/auth/tenancy'
        ? tenancy instanceof Error
          ? { statusCode: 500, data: {} }
          : { statusCode: 200, data: { code: 0, msg: 'ok', data: tenancy } }
        : {
            statusCode: 200,
            data: { code: 0, msg: 'ok', data: { items: [], total: 0, unread: 0 } },
          }
    setTimeout(() => o.success?.(reply as never))
    return {} as UniApp.RequestTask
  })
})

const bodies = (url: string) =>
  vi
    .mocked(uni.request)
    .mock.calls.filter(([o]) => o.url === `/api${url}`)
    .map(([o]) => o.data)

it('switch off: no field, nothing sent, nothing kept, the login body as before', async () => {
  uni.setStorageSync(TENANT_KEY, 'acme')
  tenancy = { enabled: false }
  const tenant = useTenantCode()
  expect(await tenant.read()).toEqual({})
  expect(tenant.shown).toBe(false)
  // the kept code is not filled in, and nothing typed is sent
  expect(tenant.text).toBe('')
  tenant.text = 'beta'
  expect(await tenant.read()).toEqual({})
  tenant.remember(true)
  tenant.remember(false)
  expect(uni.getStorageSync(TENANT_KEY)).toBe('acme')
  const auth = useAuthStore()
  await auth.login({ username: 'admin', password: 'x', ...(await useTenantCode().read()) })
  expect(bodies('/auth/login').at(-1)).toEqual({
    username: 'admin',
    password: 'x',
    clientId: 'mobile',
    keepSignedIn: true,
  })
})

it('unreadable: not taken for off; read() asks again and fails with the error, then recovers', async () => {
  uni.setStorageSync(TENANT_KEY, 'acme')
  tenancy = new Error('down')
  const tenant = useTenantCode()
  const asked = () => bodies('/auth/tenancy').length
  // the first answer failed: asked again, failing again → the caller shows the error (no sign-in sent)
  await expect(tenant.read()).rejects.toMatchObject({ status: 500 })
  expect(asked()).toBe(2)
  expect(tenant.shown).toBe(false)
  await expect(tenant.read()).rejects.toBeDefined()
  expect(asked()).toBe(3)
  // the server answers again: the field shows with the kept code, which is sent
  tenancy = { enabled: true }
  expect(await tenant.read()).toEqual({ tenantCode: 'acme' })
  expect(asked()).toBe(4)
  expect(tenant.shown).toBe(true)
  // answered once, never asked again
  await tenant.read()
  expect(asked()).toBe(4)
})

it('switch on, a host bound to a tenant (H5 on its domain): no field, as the web', async () => {
  tenancy = {
    enabled: true,
    tenant: { code: 'acme', name: 'Acme', brandName: null, logoUrl: null },
  }
  const tenant = useTenantCode()
  expect(await tenant.read()).toEqual({})
  expect(tenant.shown).toBe(false)
})

it('switch on, an unbound host: the kept code prefilled, read lower-cased, sent, kept or forgotten', async () => {
  tenancy = { enabled: true }
  uni.setStorageSync(TENANT_KEY, 'acme')
  const tenant = useTenantCode()
  // a request sent before `/auth/tenancy` answered still carries the kept code
  expect(await tenant.read()).toEqual({ tenantCode: 'acme' })
  expect(tenant.shown).toBe(true)
  expect(tenant.text).toBe('acme')

  tenant.text = '  Beta-Co '
  const code = await tenant.read()
  expect(code).toEqual({ tenantCode: 'beta-co' })
  const auth = useAuthStore()
  await auth.login({ username: 'admin', password: 'x', ...code })
  expect(bodies('/auth/login').at(-1)).toMatchObject({ username: 'admin', tenantCode: 'beta-co' })
  await auth.smsLogin({ mobile: '13800000000', code: '123456', ...code })
  expect(bodies('/auth/sms/login').at(-1)).toMatchObject({ tenantCode: 'beta-co' })
  tenant.remember(true)
  expect(uni.getStorageSync(TENANT_KEY)).toBe('beta-co')
  // "remember" unchecked forgets it
  tenant.remember(false)
  expect(uni.getStorageSync(TENANT_KEY)).toBe('')

  // blank = the default tenant: nothing sent, nothing kept
  tenant.text = '  '
  expect(await tenant.read()).toEqual({})
  tenant.remember(true)
  expect(uni.getStorageSync(TENANT_KEY)).toBe('')

  // malformed: no request, the field says why
  tenant.text = 'a b'
  expect(await tenant.read()).toBeNull()
  expect(tenant.error).toMatch(/^租户编码/)
  tenant.text = 'acme'
  expect(await tenant.read()).toEqual({ tenantCode: 'acme' })
  expect(tenant.error).toBe('')
})

it('features: without the workflow group no approval tab, counts or start; without system no bulletin', async () => {
  const auth = useAuthStore()
  const counts = useCountsStore()
  const loaded = () => vi.mocked(uni.request).mock.calls.map(([o]) => o.url)
  // the workbench's shortcuts and counters, by name
  const home = () =>
    visibleShortcuts(
      ['start', 'bulletin', 'todo', 'running', 'unread'].map((name) => ({ name })),
    ).map((e) => e.name)

  // display remains permissive until identity is known; counts use the confirmed package
  expect(visibleTabs()).toEqual(['home', 'approval', 'message', 'mine'])
  expect(home()).toEqual(['start', 'bulletin', 'todo', 'running', 'unread'])
  auth.me = { features: undefined } as MePayload
  counts.load()
  expect(loaded()).toEqual([
    '/api/wf/tasks/todo',
    '/api/wf/instances/mine',
    '/api/messaging/inboxes/mine/unread',
  ])
  await new Promise((r) => setTimeout(r))
  expect([counts.todo, counts.running]).toEqual([0, 0])

  vi.mocked(uni.request).mockClear()
  auth.me = { features: ['system', 'biz'] } as MePayload
  expect(hasFeature('workflow')).toBe(false)
  expect(hasFeature('system')).toBe(true)
  expect(visibleTabs()).toEqual(['home', 'message', 'mine'])
  expect(home()).toEqual(['bulletin', 'unread'])
  // the poll and the pushes go through load(): only the unread count is asked for
  counts.load()
  expect(loaded()).toEqual(['/api/messaging/inboxes/mine/unread'])
  expect([counts.todo, counts.running]).toEqual([null, null])

  auth.me = { features: ['workflow', 'system'] } as MePayload
  expect(visibleTabs()).toContain('approval')
  auth.me = { features: ['workflow', 'biz'] } as MePayload
  expect(home()).toEqual(['start', 'todo', 'running', 'unread'])
  // a perm still counts: none held, no leave shortcut
  expect(visibleShortcuts([{ name: 'leave', perm: 'biz.leave.create' }])).toEqual([])
  auth.me = { features: [] as string[] } as MePayload
  expect(visibleTabs()).toEqual(['home', 'message', 'mine'])
})

it("brand: the app's while off and for the default tenant; a tenant's brand name, else its name; its logo", () => {
  const tenant = (t: Partial<MeTenant>): MePayload =>
    ({
      tenant: {
        id: 2,
        code: 'acme',
        name: 'Acme',
        brandName: null,
        logoUrl: null,
        acting: false,
        ...t,
      },
    }) as MePayload
  expect(tenantBrand(null)).toEqual({ name: '栖梧', logo: '' })
  expect(tenantBrand({} as MePayload)).toEqual({ name: '栖梧', logo: '' })
  expect(tenantBrand(tenant({ id: 1, code: 'default', name: 'seed.tenant.default' }))).toEqual({
    name: '栖梧',
    logo: '',
  })
  expect(tenantBrand(tenant({}))).toEqual({ name: 'Acme', logo: '' })
  expect(tenantBrand(tenant({ brandName: 'Acme Cloud', logoUrl: '/files/logo.png' }))).toEqual({
    name: 'Acme Cloud',
    logo: '/files/logo.png',
  })
})
