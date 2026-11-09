import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { ownedAvdPath, passedTests, sourceTests } from './native-android.mjs'

const nativeClass = 'io.qiwu.livekit.QwLiveKitNativeTest'
const methods = Array.from({ length: 30 }, (_, i) => `nativeMethod${i}`)
const source = methods.map((name) => `@Test fun ${name}() = native { }`).join('\n')

// 纯输入回归，不调用 Gradle/ADB，不查询或启动用户设备。
test('derives every current native method and refuses deleted, duplicate or unreadable coverage', () => {
  assert.deepEqual(sourceTests(source), [...methods].sort())
  const addition = source + '\n@Test fun addedBoundary() = native { }'
  assert.equal(sourceTests(addition).length, 31)
  assert.deepEqual(
    sourceTests('/* @Test fun fake() {} */\n// @Test fun ignored() {}\n' + source),
    [...methods].sort(),
  )
  for (const text of [
    source.replace(/@Test fun nativeMethod0[^\n]*\n/, ''),
    source + '\n@Test fun nativeMethod0() {}',
    source + '\n@Test suspend fun unreadable() {}',
    '',
  ])
    assert.throws(() => sourceTests(text), /at least 30 uniquely named/)
})

function status(name, index, code, overrides = {}) {
  const fields = {
    class: nativeClass,
    current: String(index + 1),
    id: 'AndroidJUnitRunner',
    numtests: '30',
    test: name,
    ...overrides,
  }
  return (
    Object.entries(fields)
      .map(([key, value]) => `INSTRUMENTATION_STATUS: ${key}=${value}`)
      .join('\n') + `\nINSTRUMENTATION_STATUS_CODE: ${code}\n`
  )
}
const result =
  methods.map((name, i) => status(name, i, 1) + status(name, i, 0)).join('') +
  '\nINSTRUMENTATION_RESULT: stream=\nTime: 1.0\nOK (30 tests)\n\nINSTRUMENTATION_CODE: -1\n'

test('requires each actual method start and pass plus matching nonempty JUnit and instrumentation summaries', () => {
  assert.deepEqual(passedTests(result, methods), {
    passed: 30,
    failed: 0,
    skipped: 0,
    tests: [...methods].sort(),
  })
  assert.equal(passedTests(result.replace(/\n/g, '\r\n'), methods).passed, 30)
  const replaced = (value) => result.replace(status(methods[0], 0, 0), value)
  for (const text of [
    '',
    result.replace('OK (30 tests)', 'OK (0 tests)'),
    result.replace('OK (30 tests)', 'OK (29 tests)'),
    result.replace('INSTRUMENTATION_CODE: -1', 'INSTRUMENTATION_CODE: 0'),
    result.replace('INSTRUMENTATION_CODE: -1', ''),
    result.replace('OK (30 tests)', ''),
    result + '\nOK (30 tests)\n',
    result + '\nINSTRUMENTATION_CODE: -1\n',
    replaced(''),
    replaced(status(methods[0], 0, -3)),
    replaced(status(methods[0], 0, -2)),
    replaced(status(methods[0], 0, 0) + status(methods[0], 0, 0)),
    replaced(status(methods[0], 0, 0, { class: 'other.Test' })),
    replaced(status('unknownMethod', 0, 0)),
    replaced(status(methods[0], 0, 0, { numtests: '29' })),
    replaced(status(methods[0], 0, 0, { current: '0' })),
    result.replace(status(methods[0], 0, 1), ''),
    result.replace(status(methods[0], 0, 1), status(methods[0], 0, 1) + status(methods[0], 0, 1)),
    result + '\nINSTRUMENTATION_STATUS: stack=hidden failure\n',
    result + '\nINSTRUMENTATION_RESULT: shortMsg=Process crashed\n',
    result + '\nINSTRUMENTATION_FAILED: runner crashed\n',
  ])
    assert.throws(() => passedTests(text, methods), /every expected native method/)
  assert.throws(() => passedTests(result, []), /every expected native method/)
  assert.throws(() => passedTests(result, [...methods, methods[0]]), /every expected native method/)
})

test('keeps owned AVD deletion under the temporary directory and refuses arbitrary device names', () => {
  const name = 'qw-livekit-12345678-1234-1234-1234-123456789abc'
  assert.equal(ownedAvdPath('/tmp/native-evidence', name), join('/tmp/native-evidence', 'avd', `${name}.avd`))
  for (const foreign of [
    'Pixel_7',
    '../existing',
    'qw-livekit-../../other',
    'qw-livekit-short',
    '/tmp/device',
  ])
    assert.throws(() => ownedAvdPath('/tmp/native-evidence', foreign), /Invalid owned AVD name/)
})
