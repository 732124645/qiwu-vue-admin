// 真实应用的开发重载回归：只由有限的 smoke:boot --dev-reload 调用，始终还原临时探针。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runDevServer } from './dev-server.mjs'

/** 在实际 MySQL/Redis 健康检查下证明源码变更、编译失败和恢复均正确控制应用进程。 */
export async function devReloadSmoke(serverDir, env) {
  assert.equal(env.DB_NAME, 'qiwu_test', 'dev reload smoke requires the default test database')
  assert.equal(String(env.REDIS_DB), '15', 'dev reload smoke requires the default test Redis DB')
  assert.equal(env.HOST, '127.0.0.1', 'dev reload smoke binds loopback only')
  const port = Number(env.PORT)
  assert.ok(Number.isInteger(port) && port > 0, 'test PORT must be configured')
  // 任意占用都拒绝，避免把别的服务误认成本次启动的应用。
  const reservation = createServer()
  await new Promise((done, fail) => {
    reservation.once('error', fail).listen(port, env.HOST, done)
  })
  await new Promise((done) => reservation.close(done))

  const id = randomUUID().replaceAll('-', '')
  const name = `qwDevReload${id}`
  const sharedDir = resolve(serverDir, '../../packages/shared')
  const sharedIndex = join(sharedDir, 'src/index.ts')
  const healthFile = join(serverDir, 'src/core/health/health.controller.ts')
  const stem = `common/qw-dev-reload-${id}`
  const fixture = join(sharedDir, 'src', `${stem}.ts`)
  const declaration = join(sharedDir, 'dist', `${stem}.d.ts`)
  const route = `reload-probe-${id}`
  const base = `http://${env.HOST}:${port}/api/health`
  const originals = new Map(
    [sharedIndex, healthFile].map((file) => [file, readFileSync(file, 'utf8')]),
  )
  const expected = new Map(originals)
  const backup = mkdtempSync(join(tmpdir(), 'qw-dev-reload-backup-'))
  writeFileSync(join(backup, 'shared-index.ts'), originals.get(sharedIndex))
  writeFileSync(join(backup, 'health.controller.ts'), originals.get(healthFile))
  const abort = new AbortController()
  const limit = setTimeout(() => abort.abort(new Error('dev reload smoke exceeded 180 s')), 180_000)
  const onSignal = () => abort.abort(new Error('dev reload smoke interrupted'))
  process.once('SIGINT', onSignal).once('SIGTERM', onSignal)
  let runner
  const lines = []
  const readyCount = () =>
    lines.filter((line) => /^\[server\] (?:cold start|reload) ready /.test(line)).length

  /** 每次写入和还原前核对当前内容，绝不覆盖并行人工修改。 */
  function replace(file, value) {
    const actual = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    assert.equal(actual, expected.get(file), `source changed outside the smoke: ${file}`)
    writeFileSync(file, value)
    expected.set(file, value)
  }
  const source = (value) => `export function ${name}(): string { return ${value} }\n`

  /** 网络瞬断在重载期间可预期；各阶段仍必须在30秒内达到真实HTTP结果。 */
  async function waitFor(label, check) {
    const started = performance.now()
    let last = 'condition not reached'
    while (performance.now() - started < 30_000) {
      abort.signal.throwIfAborted()
      try {
        const result = await check()
        if (result) return result
      } catch (error) {
        last = error.message
      }
      await delay(100, undefined, { signal: abort.signal })
    }
    throw new Error(`${label}: timeout after 30 s; ${last}`)
  }
  async function response(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.code, 0)
    return body.data
  }
  async function state(shared, server, count, previousPid) {
    return waitFor(`${shared}/${server}`, async () => {
      const body = await response(`${base}/${route}`)
      assert.equal(body.shared, shared)
      assert.equal(body.server, server)
      assert.equal(
        readyCount(),
        count,
        'each successful edit must produce exactly one readiness event',
      )
      if (previousPid !== undefined) assert.notEqual(body.pid, previousPid)
      const health = await response(base)
      assert.equal(health.details.db.status, 'up')
      assert.equal(health.details.redis.status, 'up')
      return body
    })
  }
  /** 观察编译尾部事件，确认不会在首次ready后再多重启一次。 */
  async function stable(body, count) {
    const until = performance.now() + 1200
    while (performance.now() < until) {
      abort.signal.throwIfAborted()
      assert.deepEqual(await response(`${base}/${route}`), body)
      assert.equal(readyCount(), count, 'unexpected extra application restart')
      await delay(250, undefined, { signal: abort.signal })
    }
  }

  let failure
  try {
    replace(fixture, source("'shared-before'"))
    replace(sharedIndex, `${originals.get(sharedIndex)}\nexport { ${name} } from './${stem}.js'\n`)
    const health = originals.get(healthFile)
    const close = health.lastIndexOf('}')
    assert.notEqual(close, -1)
    const probe = `\n  @Get('${route}')\n  ${name}() {\n    return { shared: ${name}(), server: 'server-before', pid: process.pid }\n  }\n`
    replace(
      healthFile,
      `import { ${name} } from '@qiwu/shared'\n${health.slice(0, close)}${probe}${health.slice(close)}`,
    )
    runner = runDevServer({
      cwd: serverDir,
      env: { ...env, NODE_ENV: 'development', LOG_LEVEL: 'info', QW_INSPECT: '0' },
      inspect: [],
      write(line) {
        lines.push(line)
        console.log(line)
      },
    })
    let body = await state('shared-before', 'server-before', 1)
    await stable(body, 1)
    const dts = readFileSync(declaration, 'utf8')

    replace(fixture, source("'shared-after'"))
    body = await state('shared-after', 'server-before', 2, body.pid)
    assert.equal(
      readFileSync(declaration, 'utf8'),
      dts,
      'function body change must leave declarations unchanged',
    )
    await stable(body, 2)
    console.log(
      'smoke:dev-reload shared body change: HTTP updated; declaration unchanged; one restart',
    )

    replace(
      healthFile,
      expected.get(healthFile).replace("server: 'server-before'", "server: 'server-after'"),
    )
    body = await state('shared-after', 'server-after', 3, body.pid)
    await stable(body, 3)
    console.log('smoke:dev-reload server change: HTTP updated; one restart')

    const beforeError = lines.length
    replace(fixture, source('123'))
    await waitFor('shared compile error', () =>
      lines.slice(beforeError).some((line) => line.startsWith('[shared] compile failed:')),
    )
    await stable(body, 3)
    console.log(
      'smoke:dev-reload shared type error: previous PID and HTTP values retained; no restart',
    )

    replace(fixture, source("'shared-repaired'"))
    body = await state('shared-repaired', 'server-after', 4, body.pid)
    await stable(body, 4)
    console.log(
      'smoke:dev-reload repaired shared source: HTTP updated; one restart; MySQL/Redis healthy',
    )
  } catch (error) {
    failure = error
  } finally {
    try {
      await restore()
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'smoke and cleanup failed') : error
    }
  }
  if (failure) throw failure

  /** 停止监听后恢复源码与产物；失败时也保留原始错误，外部修改另存原文供恢复。 */
  async function restore() {
    clearTimeout(limit)
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal)
    const errors = []
    try {
      await runner?.stop()
    } catch (error) {
      errors.push(error)
    }
    const conflicts = []
    for (const [file, value] of expected) {
      try {
        if ((existsSync(file) ? readFileSync(file, 'utf8') : undefined) !== value) {
          conflicts.push(file)
          continue
        }
        if (originals.has(file)) writeFileSync(file, originals.get(file))
        else rmSync(file, { force: true })
      } catch (error) {
        errors.push(error)
        conflicts.push(file)
      }
    }
    for (const extension of ['.js', '.js.map', '.d.ts']) {
      try {
        rmSync(join(sharedDir, 'dist', `${stem}${extension}`), { force: true })
      } catch (error) {
        errors.push(error)
      }
    }
    if (conflicts.length)
      errors.push(
        new Error(
          `source recovery incomplete: ${conflicts.join(', ')}; originals saved in ${backup}`,
        ),
      )
    else {
      rmSync(backup, { recursive: true, force: true })
      // 还原构建产物，后续普通启动不能残留临时公共接口；每个编译也有独立上限。
      for (const [cwd, args] of [
        [sharedDir, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']],
        [serverDir, ['node_modules/@nestjs/cli/bin/nest.js', 'build']],
      ]) {
        const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', timeout: 45_000 })
        if (result.status !== 0)
          errors.push(
            new Error(
              `could not restore compiled output: ${result.error?.message ?? result.signal ?? result.status}`,
            ),
          )
      }
    }
    if (errors.length) throw new AggregateError(errors, 'dev reload smoke cleanup failed')
  }
}
