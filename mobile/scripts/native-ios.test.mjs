import assert from 'node:assert/strict'
import { test } from 'node:test'
import { passedTests, selectRuntime } from './native-ios.mjs'

const phone = { productFamily: 'iPhone', identifier: 'phone-type' }
const tablet = { productFamily: 'iPad', identifier: 'tablet-type' }
const runtime = (patch = {}) => ({
  identifier: 'ios-runtime',
  platform: 'iOS',
  version: '26.2',
  isAvailable: true,
  supportedDeviceTypes: [tablet, phone],
  ...patch,
})

// 只测试纯输入，不调用 Xcode、启动模拟器或查询用户设备。
test('selects the first available iOS 15+ runtime and its declared iPhone type', () => {
  const catalog = {
    runtimes: [
      runtime({ platform: 'watchOS' }),
      runtime({ isAvailable: false }),
      runtime({ version: '14.9' }),
      runtime({ version: 'unknown' }),
      runtime({ supportedDeviceTypes: [tablet] }),
      runtime(),
      runtime({ identifier: 'newer-runtime', version: '27.0' }),
    ],
  }
  assert.deepEqual(selectRuntime(catalog), { runtime: 'ios-runtime', deviceType: 'phone-type' })
  assert.deepEqual(selectRuntime({ runtimes: [runtime({ version: '15.0' })] }), {
    runtime: 'ios-runtime',
    deviceType: 'phone-type',
  })
  for (const runtimes of [
    [],
    [runtime({ isAvailable: 'true' })],
    [runtime({ version: 15 })],
    [runtime({ supportedDeviceTypes: null })],
  ]) {
    assert.throws(() => selectRuntime({ runtimes }), /No available iOS 15/)
  }
  assert.throws(() => selectRuntime({}), /No available iOS 15/)
})

test('requires a real nonempty all-passing xcresult summary, including zero skips', () => {
  const summary = {
    result: 'Passed',
    passedTests: 28,
    failedTests: 0,
    skippedTests: 0,
    expectedFailures: 0,
    totalTestCount: 28,
  }
  assert.equal(passedTests(summary), 28)
  for (const patch of [
    { result: 'Failed' },
    { result: 'Skipped' },
    { passedTests: 0, totalTestCount: 0 },
    { failedTests: 1 },
    { skippedTests: 1 },
    { expectedFailures: 1 },
    { totalTestCount: 29 },
    { passedTests: '28' },
    { passedTests: 0.5 },
    { skippedTests: undefined },
  ])
    assert.throws(() => passedTests({ ...summary, ...patch }), /xcresult must/)
  assert.throws(() => passedTests({}), /xcresult must/)
  assert.throws(() => passedTests(null), /xcresult must/)
})
