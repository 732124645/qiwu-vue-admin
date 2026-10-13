import { describe, expect, it } from 'vitest'
import {
  loginBody,
  signupBody,
  smsCodeBody,
  smsLoginBody,
  smsResetPasswordBody,
  wxMpBindBody,
  wxMpLoginBody,
} from '../../common/auth.js'
import { DEFAULT_PASSWORD_POLICY } from '../../common/password-policy.js'
import { PERM_CODE } from '../../common/auth.js'
import { Err } from '../../common/error-codes.js'
import { DEFAULT_TENANT_ID, PLATFORM_ONLY_ROUTES } from '../../common/tenancy.js'
import {
  tenantPackageCreate,
  tenantPackagePerms,
  tenantPackageUpdate,
} from './tenant-package.schema.js'
import {
  DEFAULT_TENANT_CODE,
  newTenantCode,
  RESERVED_TENANT_CODES,
  TENANT_DOMAINS_MAX,
  tenancyVo,
  tenantCode,
  tenantCreate,
  tenantDomain,
  tenantDomains,
  tenantEnterBody,
  tenantPerms,
  tenantUpdate,
} from './tenant.schema.js'

describe('tenant contracts', () => {
  it('a tenant code is a DNS label of 3 to 32 characters, read in lower case', () => {
    for (const ok of ['abc', 'acme', 'a-1', 'acme-cn-2', `a${'b'.repeat(30)}c`])
      expect(tenantCode.parse(ok)).toBe(ok)
    expect(tenantCode.parse('  ACME-Cn ')).toBe('acme-cn')
    for (const bad of [
      '',
      'ab',
      '1abc',
      '-abc',
      'abc-',
      'ab_c',
      'ab.c',
      'ab c',
      'acme.example.com',
      `a${'b'.repeat(31)}c`,
    ])
      expect(tenantCode.safeParse(bad).success).toBe(false)
  })

  it('a new tenant takes no reserved code (case-insensitive); signing in may name the default one', () => {
    for (const code of [
      'default',
      'www',
      'api',
      'admin',
      'demo',
      'docs',
      'files',
      'static',
      'mail',
    ])
      expect(RESERVED_TENANT_CODES).toContain(code)
    expect(RESERVED_TENANT_CODES).toContain(DEFAULT_TENANT_CODE)
    for (const code of RESERVED_TENANT_CODES) {
      expect(tenantCode.safeParse(code).success).toBe(true)
      expect(newTenantCode.safeParse(code).success).toBe(false)
      expect(newTenantCode.safeParse(code.toUpperCase()).success).toBe(false)
    }
    const reserved = newTenantCode.safeParse('WWW').error!.issues[0]!
    expect(reserved.message).toBe('validation.tenant_code_reserved')
    expect(newTenantCode.parse('Acme')).toBe('acme')
  })

  it('the sign-in, SMS, bind and sign-up bodies take an optional tenant code; the WeChat sign-in none', () => {
    const policy = DEFAULT_PASSWORD_POLICY
    const bodies: [{ safeParse: (v: unknown) => { success: boolean; data?: unknown } }, object][] =
      [
        [loginBody, { username: 'alice', password: 'x' }],
        [smsCodeBody, { mobile: '13800000000', scene: 'signin' }],
        [smsLoginBody, { mobile: '13800000000', code: '123456' }],
        [
          smsResetPasswordBody(policy),
          { mobile: '13800000000', code: '123456', newPassword: 'Abcdef#2026x' },
        ],
        [wxMpBindBody, { ticket: 't'.repeat(24), username: 'alice', password: 'x' }],
        [wxMpBindBody, { ticket: 't'.repeat(24), mobile: '13800000000', code: '123456' }],
        [signupBody(policy), { username: 'alice', password: 'Abcdef#2026x' }],
      ]
    for (const [schema, body] of bodies) {
      const without = schema.safeParse(body)
      expect(without.success).toBe(true)
      expect(without.data).not.toHaveProperty('tenantCode')
      const named = schema.safeParse({ ...body, tenantCode: 'ACME' })
      expect(named.success).toBe(true)
      expect(named.data).toMatchObject({ tenantCode: 'acme' })
      expect(schema.safeParse({ ...body, tenantCode: 'a b' }).success).toBe(false)
    }
    expect(wxMpLoginBody.parse({ code: 'abc', tenantCode: 'acme' })).toEqual({ code: 'abc' })
  })

  it('/auth/tenancy names a tenant only when the host is bound to one', () => {
    expect(tenancyVo.parse({ enabled: false })).toEqual({ enabled: false })
    const bound = {
      enabled: true,
      tenant: { code: 'acme', name: 'Acme', brandName: null, logoUrl: null },
    }
    expect(tenancyVo.parse(bound)).toEqual(bound)
  })

  it('the default tenant is 1 and the platform-only routes are unique', () => {
    expect(DEFAULT_TENANT_ID).toBe(1)
    expect(new Set(PLATFORM_ONLY_ROUTES).size).toBe(PLATFORM_ONLY_ROUTES.length)
    // groups are never listed: the demo pages hang under the dev tools group
    for (const group of ['system', 'monitor', 'devtools', 'demo', 'biz', 'workflow', 'messaging'])
      expect(PLATFORM_ONLY_ROUTES).not.toContain(group)
  })

  it('the tenant and package pages are platform pages; their perms are well formed, a tenant has no remove', () => {
    expect(PLATFORM_ONLY_ROUTES).toEqual(
      expect.arrayContaining(['iam-tenant', 'iam-tenant-package']),
    )
    expect(Object.keys(tenantPerms)).toEqual([
      'browse',
      'view',
      'create',
      'modify',
      'enter',
      'reset-password',
    ])
    expect(Object.keys(tenantPackagePerms)).toEqual([
      'browse',
      'view',
      'create',
      'modify',
      'remove',
    ])
    for (const perm of [...Object.values(tenantPerms), ...Object.values(tenantPackagePerms)])
      expect(perm).toMatch(PERM_CODE)
    expect(tenantPerms.enter).toBe('iam.tenant.enter')
    expect([Err.IAM_TENANT_PACKAGE_PLATFORM_MENU, Err.IAM_TENANT_DEFAULT_FIXED]).toEqual([
      expect.objectContaining({ code: 'B1014', status: 422 }),
      expect.objectContaining({ code: 'B1015', status: 422 }),
    ])
    expect(Err.IAM_TENANT_DOMAIN_RESERVED).toMatchObject({ code: 'B1016', status: 422 })
  })

  it('a bound domain is a host name read in lower case: no scheme, port, path, wildcard or blank', () => {
    for (const ok of ['acme.example.com', 'b1.test', 'localhost', 'a-b.c-d.io', '10.0.0.8'])
      expect(tenantDomain.parse(ok)).toBe(ok)
    expect(tenantDomain.parse('  ACME.Example.COM ')).toBe('acme.example.com')
    const bad = [
      '',
      'acme.example.com:8080',
      'https://acme.example.com',
      'acme.example.com/x',
      '*.example.com',
      'acme..com',
      '-acme.com',
      'acme-.com',
      'ac me.com',
      'ac_me.com',
      '.acme.com',
      'acme.com.',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(126)}ab`,
    ]
    expect(bad.filter((d) => tenantDomain.safeParse(d).success)).toEqual([])
    expect(tenantDomain.safeParse('a:1').error!.issues[0]!.message).toBe('validation.tenant_domain')
    const many = Array.from({ length: TENANT_DOMAINS_MAX }, (_, i) => `t${i}.example.com`)
    expect(tenantDomains.parse(many)).toEqual(many)
    expect(tenantDomains.safeParse([...many, 'x.example.com']).success).toBe(false)
    const twice = tenantDomains.safeParse(['a.example.com', 'A.example.com'])
    expect(twice.error!.issues[0]!.message).toBe('validation.tenant_domain_duplicate')
  })

  it('opening a tenant takes a new code, a package and its administrator; editing never takes the code', () => {
    const body = {
      code: 'Acme',
      name: 'Acme',
      packageId: 3,
      domains: ['Acme.Example.com'],
      admin: { username: 'boss', displayName: 'Boss' },
    }
    expect(tenantCreate.parse(body)).toMatchObject({
      code: 'acme',
      packageId: 3,
      domains: ['acme.example.com'],
      admin: { username: 'boss', displayName: 'Boss' },
    })
    expect(
      tenantCreate.parse({ ...body, expiresAt: null, userQuota: null, brandName: ' ' }),
    ).toMatchObject({ expiresAt: null, userQuota: null, brandName: null })
    for (const bad of [
      { ...body, code: 'www' },
      { ...body, packageId: undefined },
      { ...body, admin: { username: 'boss' } },
      { ...body, admin: undefined },
      { ...body, userQuota: 0 },
      { ...body, expiresAt: 'tomorrow' },
    ])
      expect(tenantCreate.safeParse(bad).success).toBe(false)
    expect(tenantUpdate.parse({})).toEqual({})
    expect(tenantUpdate.parse({ name: 'Acme 2', expiresAt: null, domains: [] })).toEqual({
      name: 'Acme 2',
      expiresAt: null,
      domains: [],
    })
    for (const extra of [{ code: 'acme' }, { admin: { username: 'x', displayName: 'x' } }]) {
      const out = tenantUpdate.safeParse({ name: 'Acme', ...extra })
      expect(out.success).toBe(false)
      expect(out.error!.issues[0]!.code).toBe('unrecognized_keys')
    }
    expect(tenantUpdate.safeParse({ packageId: null }).success).toBe(false)
  })

  it('entering a tenant needs a reason of 1 to 200 characters', () => {
    expect(tenantEnterBody.parse({ reason: ' ticket 42 ' })).toEqual({ reason: 'ticket 42' })
    for (const reason of ['', '   ', 'x'.repeat(201)])
      expect(tenantEnterBody.safeParse({ reason }).success).toBe(false)
    expect(tenantEnterBody.safeParse({}).success).toBe(false)
  })

  it('a package is a name and its menus; an edit changes what it sends', () => {
    expect(tenantPackageCreate.parse({ name: ' Basic ', menuIds: [1, 2] })).toEqual({
      name: 'Basic',
      menuIds: [1, 2],
    })
    expect(tenantPackageCreate.safeParse({ name: 'Basic' }).success).toBe(false)
    expect(tenantPackageCreate.safeParse({ name: '', menuIds: [] }).success).toBe(false)
    expect(tenantPackageUpdate.parse({ enabled: false })).toEqual({ enabled: false })
  })
})
