import { demoNetwork } from './demo-network.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

afterEach(() => vi.unstubAllEnvs())

it('keeps non-demo network data unchanged', () => {
  vi.stubEnv('APP_DEMO_MODE', 'false')
  const row = { ip: '203.0.113.17', location: 'Visitor City', userAgent: UA }
  expect(demoNetwork(row)).toBe(row)
})

it.each([
  ['203.0.113.17', '203.0.*.*'],
  ['2001:db8:1234:5678:9abc:def0:1234:5678', '2001:db8::*'],
  ['2001::1234', '2001:0::*'],
  ['::1', '0:0::*'],
  ['::ffff:203.0.113.17', '0:0::*'],
  ['fe80::1234%en0', 'fe80:0::*'],
  ['unknown visitor', '*'],
  [null, null],
])('masks %s without mutating the original row', (ip, maskedIp) => {
  vi.stubEnv('APP_DEMO_MODE', 'true')
  const row = {
    ip,
    location: 'Visitor City',
    userAgent: UA,
    browser: 'Chrome 131.0.0.0',
    os: 'macOS 10.15.7',
  }
  expect(demoNetwork(row)).toEqual({
    ip: maskedIp,
    location: '*',
    userAgent: 'Chrome',
    browser: 'Chrome',
    os: '*',
  })
  expect(row).toEqual({
    ip,
    location: 'Visitor City',
    userAgent: UA,
    browser: 'Chrome 131.0.0.0',
    os: 'macOS 10.15.7',
  })
})

it('does not expose unknown agents or add fields missing from a row', () => {
  vi.stubEnv('APP_DEMO_MODE', 'true')
  expect(demoNetwork({ ip: null })).toEqual({ ip: null })
  expect(demoNetwork({ ip: null, userAgent: 'Visitor-specific-agent', location: null })).toEqual({
    ip: null,
    userAgent: '*',
    location: '*',
  })
})
