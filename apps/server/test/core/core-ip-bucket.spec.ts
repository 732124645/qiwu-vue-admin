import { describe, expect, it } from 'vitest'
import { smsIpBucket } from '../../src/core/auth/auth-params.js'

describe('SMS IP buckets', () => {
  it('keeps IPv4 and unparsable input, and groups IPv6 by canonical /64', () => {
    expect(smsIpBucket('192.0.2.1')).toBe('192.0.2.1')
    expect(smsIpBucket('::ffff:198.51.100.7')).toBe('198.51.100.7')
    expect(smsIpBucket('::ffff:198.51.100.8')).not.toBe(smsIpBucket('::ffff:198.51.100.7'))
    const bucket = smsIpBucket('2001:db8:a:b::1')
    expect(bucket).toBe('2001:db8:a:b::')
    expect(smsIpBucket('2001:0db8:000a:000b:0:0:0:ffff')).toBe(bucket)
    expect(smsIpBucket('2001:db8:a:b:ffff:ffff:ffff:ffff')).toBe(bucket)
    expect(smsIpBucket('2001:db8:a:c::1')).not.toBe(bucket)
    expect(smsIpBucket('fe80::1%eth0')).toBe('fe80::')
    expect(smsIpBucket('::1')).toBe('::')
    expect(smsIpBucket('64:ff9b::192.0.2.1')).toBe('64:ff9b::')
    expect(smsIpBucket('garbage')).toBe('garbage')
  })
})
