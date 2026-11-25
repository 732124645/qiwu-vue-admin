// Compile and run the Kotlin instrumentation source on an owned temporary Android Emulator.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'

const testClass = 'io.qiwu.livekit.QwLiveKitNativeTest'
const ports = { server: 5039, console: 5588, emulatorAdb: 5589 }

/** 从当前实际测试源确定验收集合；新增方法必须执行，删除既有覆盖不能降低通过门槛。 */
export function sourceTests(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const names = [...text.matchAll(/@Test\s+fun\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1])
  if (
    names.length < 30 ||
    names.length !== new Set(names).size ||
    names.length !== [...text.matchAll(/@Test\b/g)].length
  )
    throw new Error(
      'Native source must declare at least 30 uniquely named, recognizable @Test methods.',
    )
  return names.sort()
}

/** 成功须逐方法开始/通过、非空 JUnit 汇总与 instrumentation 终局一致；忽略/崩溃不能算通过。 */
export function passedTests(output, expected) {
  const text = output.replace(/\r/g, '')
  const bad = () =>
    new Error(
      'Instrumentation must execute every expected native method exactly once, with zero failures or skips.',
    )
  if (
    !expected.length ||
    new Set(expected).size !== expected.length ||
    /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS: (?:stack|Error)=|INSTRUMENTATION_RESULT: shortMsg=/.test(
      text,
    )
  )
    throw bad()
  const started = new Set(),
    passed = new Set()
  let status = {},
    count = 0
  for (const line of text.split('\n')) {
    const field = /^INSTRUMENTATION_STATUS: (class|test|current|numtests)=(.*)$/.exec(line)
    if (field) status[field[1]] = field[2]
    const code = /^INSTRUMENTATION_STATUS_CODE:\s*(-?\d+)\s*$/.exec(line)
    if (!code) continue
    if (
      status.class !== testClass ||
      !expected.includes(status.test) ||
      Number(status.numtests) !== expected.length ||
      !/^\d+$/.test(status.current ?? '') ||
      Number(status.current) < 1 ||
      Number(status.current) > expected.length
    )
      throw bad()
    if (code[1] === '1' && !started.has(status.test)) started.add(status.test)
    else if (code[1] === '0' && started.has(status.test) && !passed.has(status.test))
      passed.add(status.test)
    else throw bad()
    count++
    status = {}
  }
  const totals = [...text.matchAll(/^OK\s+\((\d+) tests?\)\s*$/gm)]
  const finals = [...text.matchAll(/^INSTRUMENTATION_CODE:\s*(-?\d+)\s*$/gm)]
  if (
    count !== expected.length * 2 ||
    passed.size !== expected.length ||
    totals.length !== 1 ||
    Number(totals[0][1]) !== expected.length ||
    finals.length !== 1 ||
    finals[0][1] !== '-1'
  )
    throw bad()
  return { passed: passed.size, failed: 0, skipped: 0, tests: [...passed].sort() }
}

/** 清理只面向本次随机目录；不能由设备名或环境变量拼接删除现有 AVD。 */
export function ownedAvdPath(artifacts, name) {
  if (!/^qw-livekit-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid owned AVD name.')
  return join(artifacts, 'avd', `${name}.avd`)
}

/** 保留文件日志并持有自己的进程组；异常、超时和中断都只停止这个进程组。 */
function launch(executable, args, label, cwd, artifacts, env, input) {
  const stdout = join(artifacts, `${label}.stdout.log`),
    stderr = join(artifacts, `${label}.stderr.log`)
  const out = openSync(stdout, 'w'),
    err = openSync(stderr, 'w')
  let child
  try {
    child = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', out, err],
    })
  } catch (error) {
    closeSync(out)
    closeSync(err)
    throw error
  }
  let finished = false
  const completion = new Promise((done) => {
    let failure
    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code, signal) => {
      finished = true
      closeSync(out)
      closeSync(err)
      done({ code, signal, failure })
    })
  })
  if (input !== undefined) {
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  }
  const kill = (signal) => {
    if (!child.pid || finished) return
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  return { stdout, stderr, completion, kill, alive: () => !finished && !!child.pid }
}

async function stop(process) {
  if (!process) return
  process.kill('SIGTERM')
  if (
    !(await Promise.race([
      process.completion.then(() => true),
      pause(5000, undefined, { ref: false }).then(() => false),
    ]))
  )
    process.kill('SIGKILL')
  await Promise.race([
    process.completion,
    pause(10_000, undefined, { ref: false }).then(() => {
      throw new Error('Owned native process did not stop.')
    }),
  ])
}

async function command(
  exe,
  args,
  label,
  context,
  timeout = 30_000,
  signal = context.signal,
  input,
  allowFailure = false,
) {
  signal?.throwIfAborted()
  const child = launch(exe, args, label, context.cwd, context.artifacts, context.env, input)
  let reason, force
  const terminate = (message) => {
    if (reason) return
    reason = message
    child.kill('SIGTERM')
    force = setTimeout(() => child.kill('SIGKILL'), 5000)
  }
  const abort = () => terminate(signal.reason?.message ?? 'Interrupted')
  const timer = setTimeout(() => terminate(`Timed out after ${timeout} ms`), timeout)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const result = await child.completion
    if (reason || result.failure || (!allowFailure && result.code !== 0))
      throw new Error(
        `${label}: ${reason ?? result.failure?.message ?? `exit ${result.code ?? result.signal}`}; logs: ${child.stdout}, ${child.stderr}`,
      )
    return { ...result, text: readFileSync(child.stdout, 'utf8') }
  } finally {
    clearTimeout(timer)
    clearTimeout(force)
    signal?.removeEventListener('abort', abort)
  }
}

/** 提前独占检查三处本地端口；占用就失败，不杀进程或借用现有 ADB/模拟器。 */
async function freePorts() {
  const reservations = []
  try {
    for (const port of Object.values(ports)) {
      const server = net.createServer()
      await new Promise((done, reject) =>
        server.once('error', reject).listen({ host: '127.0.0.1', port, exclusive: true }, done),
      )
      reservations.push(server)
    }
  } catch {
    throw new Error(
      'Private native ports 5039/5588/5589 must be free; existing processes are left untouched.',
    )
  } finally {
    await Promise.all(reservations.map((server) => new Promise((done) => server.close(done))))
  }
}

/** 真实工具只在临时源副本运行，finally 删除本次 AVD 并停止自己持有的 ADB/Emulator。 */
async function main() {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Android native runner currently requires macOS or Linux process groups.')
  const cache = join(homedir(), '.cache', 'qiwu-native')
  const sdk = resolve(process.env.QW_NATIVE_ANDROID_SDK || join(cache, 'android-sdk'))
  const gradle = resolve(process.env.QW_NATIVE_GRADLE || join(cache, 'gradle-8.9', 'bin', 'gradle'))
  const java =
    process.env.JAVA_HOME || (process.platform === 'darwin' ? '/opt/homebrew/opt/openjdk@17' : '')
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : process.arch === 'x64' ? 'x86_64' : null
  const image = abi && `system-images;android-35;default;${abi}`
  const avdmanager = join(sdk, 'cmdline-tools', '22.0', 'bin', 'avdmanager')
  const adb = join(sdk, 'platform-tools', 'adb'),
    emulator = join(sdk, 'emulator', 'emulator')
  if (
    !abi ||
    !java ||
    ![
      gradle,
      adb,
      emulator,
      avdmanager,
      join(java, 'bin', 'java'),
      join(sdk, 'platforms', 'android-35', 'android.jar'),
      join(sdk, 'build-tools', '35.0.0', 'aapt2'),
      join(sdk, 'system-images', 'android-35', 'default', abi, 'system.img'),
    ].every(existsSync)
  )
    throw new Error(
      'Install JDK 17, Gradle 8.9 and the complete API 35 native toolchain; see native-tests/android/README.md.',
    )
  const artifacts = mkdtempSync(join(tmpdir(), 'qw-livekit-android-'))
  const work = join(artifacts, 'plugin'),
    name = `qw-livekit-${randomUUID()}`
  const avdPath = ownedAvdPath(artifacts, name),
    avdHome = dirname(avdPath)
  const controller = new AbortController()
  const onInt = () => {
    process.exitCode = 130
    controller.abort(new Error('Interrupted by SIGINT'))
  }
  const onTerm = () => {
    process.exitCode = 143
    controller.abort(new Error('Interrupted by SIGTERM'))
  }
  process.on('SIGINT', onInt).on('SIGTERM', onTerm)
  const env = {
    ...process.env,
    JAVA_HOME: java,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ANDROID_USER_HOME: join(artifacts, 'android-user'),
    ANDROID_EMULATOR_HOME: join(artifacts, 'android-user'),
    ANDROID_AVD_HOME: avdHome,
    GRADLE_USER_HOME: join(cache, 'gradle-user-home'),
    ANDROID_ADB_SERVER_PORT: String(ports.server),
    ADB_SERVER_SOCKET: `tcp:127.0.0.1:${ports.server}`,
    ADB_LOCAL_TRANSPORT_MAX_PORT: '0',
    ADB_MDNS_AUTO_CONNECT: '',
  }
  delete env.ANDROID_SERIAL
  const context = {
    cwd: join(work, 'native-tests', 'android'),
    artifacts,
    env,
    signal: controller.signal,
  }
  const run = (exe, args, label, timeout, signal, input, allowFailure) =>
    command(exe, args, label, context, timeout, signal, input, allowFailure)
  let server, device, summary, failure
  console.log(`native-android: evidence: ${artifacts}`)
  try {
    const source = fileURLToPath(new URL('../src/uni_modules/qw-livekit/', import.meta.url))
    for (const part of ['utssdk/app-android', 'native-tests/android']) {
      mkdirSync(dirname(join(work, part)), { recursive: true })
      cpSync(join(source, part), join(work, part), {
        recursive: true,
        filter: (path) =>
          !/(?:^|\/)\.(?:gradle|build)(?:\/|$)|(?:^|\/)build(?:\/|$)|(?:^|\/)local\.properties$/.test(
            path,
          ),
      })
    }
    mkdirSync(avdHome, { recursive: true })
    mkdirSync(env.ANDROID_USER_HOME, { recursive: true })
    const expected = sourceTests(
      readFileSync(
        join(context.cwd, 'src/androidTest/java/io/qiwu/livekit/QwLiveKitNativeTest.kt'),
        'utf8',
      ),
    )
    writeFileSync(join(artifacts, 'expected-tests.json'), JSON.stringify(expected, null, 2) + '\n')
    const javaVersion = await run(join(java, 'bin', 'java'), ['-version'], 'java-version')
    if (
      !/version "17[.\"]/.test(
        readFileSync(join(artifacts, 'java-version.stderr.log'), 'utf8') + javaVersion.text,
      )
    )
      throw new Error('Native tests require JDK 17.')
    const version = await run(gradle, ['--version'], 'gradle-version')
    if (!/^Gradle 8\.9\s*$/m.test(version.text)) throw new Error('Native tests require Gradle 8.9.')
    await run(
      gradle,
      ['--no-daemon', ':native:assembleDebugAndroidTest', ':native:writeDependencyClasspath'],
      'gradle-build',
      20 * 60_000,
    )
    await run(
      avdmanager,
      [
        'create',
        'avd',
        '--name',
        name,
        '--package',
        image,
        '--path',
        avdPath,
        '--device',
        'pixel_7',
      ],
      'avd-create',
      60_000,
      controller.signal,
      'no\n',
    )
    if (!existsSync(join(avdPath, 'config.ini')))
      throw new Error('AVD manager did not create the owned emulator configuration.')
    writeFileSync(
      join(artifacts, 'ownership.json'),
      JSON.stringify({ name, avdPath, ...ports, sdk, image }, null, 2) + '\n',
    )
    await freePorts()
    server = launch(
      adb,
      [
        '-L',
        `tcp:${ports.server}`,
        '--one-device',
        `${name}-no-usb`,
        'server',
        'nodaemon',
      ],
      'private-adb',
      context.cwd,
      artifacts,
      env,
    )
    const deviceRun = async (args, label, timeout, signal, allowFailure) => {
      if (!server.alive())
        throw new Error('Owned private ADB exited; refusing to use another server.')
      const result = await run(
        adb,
        ['-H', '127.0.0.1', '-P', String(ports.server), '-s', `emulator-${ports.console}`, ...args],
        label,
        timeout,
        signal,
        undefined,
        allowFailure,
      )
      if (!server.alive()) throw new Error('Owned private ADB exited during a device command.')
      return result
    }
    // nodaemon 让父进程保留实际服务进程；不使用会复用/关闭其它服务的 start-server/kill-server。
    await pause(1000, undefined, { signal: controller.signal })
    if (!server.alive())
      throw new Error('Private ADB could not bind its owned port; inspect private-adb logs.')
    device = launch(
      emulator,
      [
        '-avd',
        name,
        '-ports',
        `${ports.console},${ports.emulatorAdb}`,
        '-no-window',
        '-no-audio',
        '-no-snapshot',
        '-no-boot-anim',
        '-gpu',
        'swiftshader',
        '-memory',
        '2048',
        '-cores',
        '2',
        '-camera-back',
        'none',
        '-camera-front',
        'none',
        '-no-metrics',
      ],
      'emulator',
      context.cwd,
      artifacts,
      env,
    )
    const deadline = Date.now() + 300_000
    let booted = false
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted()
      if (!device.alive())
        throw new Error('Owned emulator exited during startup; inspect emulator logs.')
      const boot = await deviceRun(
        ['shell', 'getprop', 'sys.boot_completed'],
        'boot-state',
        10_000,
        controller.signal,
        true,
      )
      if (boot.code === 0 && boot.text.trim() === '1') {
        booted = true
        break
      }
      await pause(2000, undefined, { signal: controller.signal })
    }
    if (!booted) throw new Error('Owned emulator did not boot within five minutes.')
    const kind = await deviceRun(['shell', 'getprop', 'ro.kernel.qemu'], 'emulator-kind')
    const identity = await deviceRun(['emu', 'avd', 'name'], 'emulator-name')
    if (kind.text.trim() !== '1' || identity.text.split(/\r?\n/)[0] !== name)
      throw new Error('Refusing to install on a device outside this owned AVD.')
    const apk = join(
      context.cwd,
      'native/build/outputs/apk/androidTest/debug/native-debug-androidTest.apk',
    )
    await deviceRun(['install', '-t', '-r', apk], 'install', 120_000)
    const result = await deviceRun(
      [
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        '-e',
        'disableAnalytics',
        'true',
        '-e',
        'class',
        testClass,
        'io.qiwu.livekit.nativeharness.test/androidx.test.runner.AndroidJUnitRunner',
      ],
      'instrumentation',
      240_000,
    )
    summary = passedTests(result.text, expected)
    writeFileSync(
      join(artifacts, 'summary.json'),
      JSON.stringify(
        {
          ...summary,
          avd: name,
          image,
          actualAndroidFramework: true,
          sdkPortControlled: true,
          realMediaTested: false,
        },
        null,
        2,
      ) + '\n',
    )
  } catch (error) {
    failure = error
  } finally {
    const errors = []
    for (const child of [device, server]) {
      try {
        await stop(child)
      } catch (error) {
        errors.push(error.message)
      }
    }
    // AVD 只存在于这个 mkdtemp 目录，清理不通过外部设备名/全局清单寻址。
    try {
      if (device?.alive())
        throw new Error('Emulator still running; its temporary AVD is retained for safe recovery.')
      rmSync(avdPath, { recursive: true, force: true })
      rmSync(join(avdHome, `${name}.ini`), { force: true })
    } catch (error) {
      errors.push(error.message)
    }
    process.off('SIGINT', onInt).off('SIGTERM', onTerm)
    if (controller.signal.aborted && !failure) failure = controller.signal.reason
    if (errors.length)
      failure = new Error(
        [failure?.message, `Owned Android cleanup failed: ${errors.join('; ')}`]
          .filter(Boolean)
          .join('\n'),
      )
    console.log(`native-android: evidence retained: ${artifacts}`)
  }
  if (failure) throw failure
  console.log(
    `native-android: PASS (${summary.passed} native tests, 0 failed, 0 skipped); owned AVD and private processes removed.`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help')
    console.log(
      'Usage: pnpm mobile:native:android\nJDK17, Gradle8.9, Android SDK/API35; bounded build and owned temporary AVD/private ADB.\nUses ~/.cache/qiwu-native unless JAVA_HOME/QW_NATIVE_ANDROID_SDK/QW_NATIVE_GRADLE override tools.\nZero failures/skips and every current native method required. Does not validate UTS host or real media.',
    )
  else if (process.argv.length > 2) {
    console.error('native-android: unknown argument; use --help.')
    process.exitCode = 1
  } else
    main().catch((error) => {
      console.error(`native-android: FAIL: ${error.message}`)
      process.exitCode ||= 1
    })
}
