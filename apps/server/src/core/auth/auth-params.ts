import { BlockList, isIP } from 'node:net'
import { Injectable } from '@nestjs/common'
import {
  DEFAULT_LOGIN_SECURITY,
  IP_BLACKLIST_PARAM,
  type LoginSecurity,
  loginSecurityParams,
  type PasswordPolicy,
  passwordPolicyOf,
  passwordPolicyParams,
  signupParams,
} from '@qiwu/shared'
import { ParamService } from '../settings/param.service.js'

/** The sign-in and password settings from `cfg_param` (see docs/design-notes.md#auth-sessions). */
export interface AuthSettings {
  security: LoginSecurity
  policy: PasswordPolicy
  /** the sign-in IP blacklist */
  blocked: BlockList
}

/** An integer in [min, max], else the default (params are admin-edited strings). */
const int = (raw: string | null | undefined, min: number, max: number, fallback: number) => {
  const n = Number(raw)
  return raw?.trim() && Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/** `::ffff:10.0.0.1` → `10.0.0.1`, so IPv4 rules, counters and logs see one form. */
export const plainIp = (ip: string | undefined): string => {
  const v = ip ?? ''
  return v.startsWith('::ffff:') && isIP(v.slice(7)) === 4 ? v.slice(7) : v
}

/** Use one SMS limit bucket for every address in an IPv6 /64. */
export const smsIpBucket = (ip: string): string => {
  ip = plainIp(ip)
  const address = ip.split('%', 1)[0]!
  if (isIP(address) !== 6) return ip
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [left, right] = canonical.split('::')
  const head = left ? left.split(':') : []
  const tail = right ? right.split(':') : []
  const groups =
    right === undefined
      ? head
      : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  return new URL(`http://[${groups.slice(0, 4).join(':')}:0:0:0:0]/`).hostname.slice(1, -1)
}

const family = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4')

/** Addresses and CIDR subnets; anything unparsable is skipped. */
export function parseBlockList(raw: string): BlockList {
  const list = new BlockList()
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const [addr = '', bits, extra] = entry.split('/')
    const ip = plainIp(addr)
    if (!isIP(ip) || extra !== undefined) continue
    const type = family(ip)
    if (bits === undefined) list.addAddress(ip, type)
    else {
      const n = int(bits, 0, type === 'ipv6' ? 128 : 32, -1)
      if (n >= 0) list.addSubnet(ip, n, type)
    }
  }
  return list
}

export const isBlocked = (list: BlockList, ip: string): boolean =>
  isIP(ip) !== 0 && list.check(ip, family(ip))

/** Auth settings through the shared `param:` cache. */
@Injectable()
export class AuthParams {
  constructor(private readonly params: ParamService) {}

  async load(): Promise<AuthSettings> {
    const keys = [
      ...Object.values(loginSecurityParams),
      ...Object.values(passwordPolicyParams),
      IP_BLACKLIST_PARAM,
    ]
    const values = await Promise.all(keys.map((key) => this.params.get(key)))
    const v = new Map(keys.map((key, i) => [key, values[i] ?? null]))
    const s = DEFAULT_LOGIN_SECURITY
    return {
      security: {
        lockThreshold: int(v.get(loginSecurityParams.lockThreshold), 1, 100, s.lockThreshold),
        lockMinutes: int(v.get(loginSecurityParams.lockMinutes), 1, 1440, s.lockMinutes),
        crossIpThreshold: int(
          v.get(loginSecurityParams.crossIpThreshold),
          1,
          10_000,
          s.crossIpThreshold,
        ),
      },
      policy: passwordPolicyOf((key) => v.get(key)),
      blocked: parseBlockList(v.get(IP_BLACKLIST_PARAM) ?? ''),
    }
  }

  async signup(): Promise<{
    enabled: boolean
    defaultRoleId: number | null
    defaultDeptId: number | null
  }> {
    const [enabled, role, dept] = await Promise.all([
      this.params.get(signupParams.enabled),
      this.params.get(signupParams.defaultRoleId),
      this.params.get(signupParams.defaultDeptId),
    ])
    const roleId = Number(role)
    const deptId = Number(dept)
    return {
      enabled: enabled === 'true',
      defaultRoleId: role?.trim() && Number.isSafeInteger(roleId) && roleId > 0 ? roleId : null,
      defaultDeptId: dept?.trim() && Number.isSafeInteger(deptId) && deptId > 0 ? deptId : null,
    }
  }
}
