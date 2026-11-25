// Run the native Swift package on an owned temporary iPhone Simulator. This does not build the UTS host.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 只取可用且满足最低版本的 iOS runtime 声明的 iPhone 类型，不选择已有设备。 */
export function selectRuntime(inventory) {
  if (Array.isArray(inventory?.runtimes)) {
    for (const runtime of inventory.runtimes) {
      if (
        runtime?.platform !== 'iOS' ||
        runtime.isAvailable !== true ||
        typeof runtime.version !== 'string' ||
        !/^\d+(?:\.\d+){0,2}$/.test(runtime.version) ||
        Number(runtime.version.split('.')[0]) < 15 ||
        typeof runtime.identifier !== 'string' ||
        !runtime.identifier
      )
        continue
      const deviceType =
        Array.isArray(runtime.supportedDeviceTypes) &&
        runtime.supportedDeviceTypes.find(
          (type) =>
            type?.productFamily === 'iPhone' &&
            typeof type.identifier === 'string' &&
            type.identifier,
        )
      if (deviceType) return { runtime: runtime.identifier, deviceType: deviceType.identifier }
    }
  }
  throw new Error(
    'No available iOS 15+ runtime with a supported iPhone type; install one in Xcode.',
  )
}

/** CLI 成功不能代替测试证据：拒绝空执行、跳过、失败或不完整的 xcresult 摘要。 */
export function passedTests(summary) {
  if (
    summary?.result !== 'Passed' ||
    !Number.isSafeInteger(summary.passedTests) ||
    summary.passedTests <= 0 ||
    summary.failedTests !== 0 ||
    summary.skippedTests !== 0 ||
    summary.expectedFailures !== 0 ||
    summary.totalTestCount !== summary.passedTests
  ) {
    throw new Error(
      'xcresult must contain passed > 0, failed = 0, skipped = 0 and no expected failures.',
    )
  }
  return summary.passedTests
}

/** 每条命令有独立日志和时限；中止时结束自己的进程组，清理命令不继承已中止信号。 */
async function command(executable, args, label, cwd, artifacts, timeoutMs, signal) {
  signal?.throwIfAborted()
  const stdout = join(artifacts, `${label}.stdout.log`)
  const stderr = join(artifacts, `${label}.stderr.log`)
  const out = openSync(stdout, 'w'),
    err = openSync(stderr, 'w')
  const child = spawn(executable, args, { cwd, detached: true, stdio: ['ignore', out, err] })
  return await new Promise((done, reject) => {
    let failure, stopped, force
    const kill = (how) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, how)
      } catch (error) {
        if (error.code !== 'ESRCH') failure = error
      }
    }
    const stop = (reason) => {
      if (stopped) return
      stopped = reason
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 5000)
    }
    const abort = () => stop(signal.reason?.message ?? 'Interrupted')
    const timer = setTimeout(() => stop(`Timed out after ${timeoutMs} ms`), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code, exitSignal) => {
      if (stopped) kill('SIGKILL')
      clearTimeout(timer)
      clearTimeout(force)
      signal?.removeEventListener('abort', abort)
      closeSync(out)
      closeSync(err)
      if (stopped || failure || code !== 0) {
        reject(
          new Error(
            `${label}: ${stopped ?? failure?.message ?? `exit ${code ?? exitSignal}`}; logs: ${stdout}, ${stderr}`,
          ),
        )
      } else done(stdout)
    })
  })
}

/** 只运行临时工作副本，并在所有成功/失败/中断路径清理本次新建的设备。 */
async function main() {
  if (process.platform !== 'darwin') throw new Error('iOS native tests require macOS and Xcode.')
  const artifacts = mkdtempSync(join(tmpdir(), 'qw-livekit-ios-'))
  const work = join(artifacts, 'package')
  const packageCache = process.env.QW_NATIVE_IOS_PACKAGES
    ? resolve(process.env.QW_NATIVE_IOS_PACKAGES)
    : join(artifacts, 'SourcePackages')
  const source = fileURLToPath(new URL('../src/uni_modules/qw-livekit/', import.meta.url))
  const deviceName = `qw-livekit-${randomUUID()}`
  const controller = new AbortController()
  const interrupt = (signal) => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    controller.abort(new Error(`Interrupted by ${signal}`))
  }
  const onInt = () => interrupt('SIGINT'),
    onTerm = () => interrupt('SIGTERM')
  process.on('SIGINT', onInt).on('SIGTERM', onTerm)
  console.log(`native-ios: artifacts: ${artifacts}`)
  let deviceId,
    attemptedCreate = false,
    count,
    failure
  const run = (exe, args, label, timeout = 30_000, signal = controller.signal) =>
    command(exe, args, label, work, artifacts, timeout, signal)
  try {
    for (const part of [
      'Package.swift',
      'Package.resolved',
      'utssdk/app-ios',
      'native-tests/ios/Tests',
    ]) {
      const target = join(work, part)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(source, part), target, { recursive: true })
    }
    const catalog = JSON.parse(
      readFileSync(
        await run('xcrun', ['simctl', 'list', 'runtimes', '--json'], 'runtimes'),
        'utf8',
      ),
    )
    const chosen = selectRuntime(catalog)
    writeFileSync(
      join(artifacts, 'selection.json'),
      JSON.stringify({ ...chosen, deviceName }, null, 2) + '\n',
    )
    attemptedCreate = true
    deviceId = readFileSync(
      await run(
        'xcrun',
        ['simctl', 'create', deviceName, chosen.deviceType, chosen.runtime],
        'create',
        60_000,
      ),
      'utf8',
    ).trim()
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(deviceId)) {
      deviceId = undefined
      throw new Error('simctl create did not return a device UUID.')
    }
    writeFileSync(join(artifacts, 'device-id.txt'), deviceId + '\n')
    await run('xcrun', ['simctl', 'boot', deviceId], 'boot')
    await run('xcrun', ['simctl', 'bootstatus', deviceId, '-b'], 'boot-status', 180_000)
    const result = join(artifacts, 'NativeTests.xcresult')
    console.log(
      `native-ios: running XCTest on owned Simulator ${deviceId}; xcodebuild logs remain in artifacts`,
    )
    await run(
      'xcodebuild',
      [
        'test',
        '-scheme',
        'QwLiveKitNative',
        '-destination',
        `platform=iOS Simulator,id=${deviceId}`,
        '-destination-timeout',
        '60',
        '-derivedDataPath',
        join(artifacts, 'DerivedData'),
        '-clonedSourcePackagesDirPath',
        packageCache,
        '-onlyUsePackageVersionsFromResolvedFile',
        '-resultBundlePath',
        result,
        '-packageAuthorizationProvider',
        'netrc',
        '-parallel-testing-enabled',
        'NO',
        '-collect-test-diagnostics',
        'never',
        'CODE_SIGNING_ALLOWED=NO',
      ],
      'xcodebuild',
      30 * 60_000,
    )
    const summaryPath = await run(
      'xcrun',
      ['xcresulttool', 'get', 'test-results', 'summary', '--path', result, '--compact'],
      'summary',
    )
    count = passedTests(JSON.parse(readFileSync(summaryPath, 'utf8')))
  } catch (error) {
    failure = error
  } finally {
    try {
      // create 超时可能已创建设备但丢失 stdout；只找本次随机全名，不触碰用户已有设备。
      if (!deviceId && attemptedCreate) {
        const inventory = JSON.parse(
          readFileSync(
            await run(
              'xcrun',
              ['simctl', 'list', 'devices', '--json'],
              'cleanup-find',
              30_000,
              null,
            ),
            'utf8',
          ),
        )
        deviceId = Object.values(inventory.devices ?? {})
          .flat()
          .find((device) => device.name === deviceName)?.udid
      }
      if (deviceId) {
        try {
          await run('xcrun', ['simctl', 'shutdown', deviceId], 'cleanup-shutdown', 30_000, null)
        } catch {
          console.warn(
            'native-ios: shutdown did not succeed; attempting deletion (see cleanup logs).',
          )
        }
        await run('xcrun', ['simctl', 'delete', deviceId], 'cleanup-delete', 30_000, null)
      }
    } catch (error) {
      failure = new Error(
        [failure?.message, `Simulator cleanup failed: ${error.message}`].filter(Boolean).join('\n'),
      )
    }
    process.off('SIGINT', onInt).off('SIGTERM', onTerm)
    if (controller.signal.aborted && !failure) failure = controller.signal.reason
    console.log(`native-ios: evidence retained: ${artifacts}`)
  }
  if (failure) throw failure
  console.log(
    `native-ios: PASS (${count} XCTest passed, 0 failed, 0 skipped); owned Simulator deleted.`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log(
      'Usage: pnpm mobile:native:ios\nmacOS + Xcode; creates/deletes its own temporary iPhone Simulator.\nXcode test timeout: 30 minutes. Logs, package copy and xcresult stay in an isolated OS temporary directory.\nRequires a nonempty all-passing xcresult; does not build the UTS host.',
    )
  } else if (process.argv.length > 2) {
    console.error('native-ios: unknown argument; use --help.')
    process.exitCode = 1
  } else {
    main().catch((error) => {
      console.error(`native-ios: FAIL: ${error.message}`)
      process.exitCode ||= 1
    })
  }
}
