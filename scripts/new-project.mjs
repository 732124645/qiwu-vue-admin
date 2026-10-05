#!/usr/bin/env node
// Node-only project setup. No database, Redis, git or server commands are executed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const files = [
  'apps/server/.env',
  'apps/server/.env.local',
  'apps/web/.env.development',
  'apps/web/.env.production',
]
const credentials = [
  'DB_USER',
  'DB_PASSWORD',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'APP_SECRET',
  'SEED_ADMIN_PASSWORD',
  'WX_MP_APPID',
  'WX_MP_SECRET',
]
// template dev 13, e2e 14, test 15, mobile e2e 9; an optional private file adds more
const lanesFile = join(root, 'scripts/test-lanes.private.json')
const reservedRedis = new Set([
  9,
  13,
  14,
  15,
  ...(existsSync(lanesFile)
    ? (JSON.parse(readFileSync(lanesFile, 'utf8')).reservedRedis ?? [])
    : []),
])
const reservedText = [...reservedRedis].sort((a, b) => a - b).join(', ')
const help = `用法 / Usage:
  node scripts/new-project.mjs --name demo --redis-db 0 [--db-name demo_dev] [--title Demo]
  node scripts/new-project.mjs --dry-run --name demo
  node scripts/new-project.mjs --self-test
  node scripts/new-project.mjs --help
无参数时交互输入；非交互执行必须提供 --name 和 --redis-db。
--name: lowercase slug (1–63); DB defaults to <name_with_underscores>_dev.
--redis-db: unused database number in your Redis configuration; ${reservedText} are reserved.
--title: HTML, browser, sidebar and login-page title; defaults to name (1–128 characters).
Title rejects CR/LF/NUL and $ < > & " (no variable expansion or HTML markup).
--dry-run: read-only plan; an omitted Redis DB stays pending, never defaults to 13.
Secrets: NEW_PROJECT_APP_SECRET / NEW_PROJECT_ADMIN_PASSWORD, otherwise securely generated.
已有真实密钥和密码保留，不回显；测试标记需手动替换。密码只检查默认策略
(8 characters, 2 character classes, <=72 UTF-8 bytes); runtime cfg_param policy still applies.
APP_SECRET >=32 characters, without not-for-production (case-insensitive).
Values must round-trip Node parseEnv with dotenv-compatible quoting; unrepresentable values are rejected.
Only server .env/.env.local and web development/production VITE_APP_TITLE are written.
Web title files are non-secret and commit-trackable; Without VITE_APP_TITLE, HTML defaults to zh-CN; browser, sidebar and login branding follow the locale.
`

function refuse(message) {
  throw Object.assign(new Error(message), { safeMessage: true })
}
function singleLine(value, key) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value))
    refuse(`${key}: 禁止 CR/LF/NUL / invalid value`)
}
function validate(options) {
  const { name } = options
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(name))
    refuse('--name: 需要 1–63 位小写 slug / invalid slug')
  const db = options['db-name'] ?? `${name.replaceAll('-', '_')}_dev`
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(db) || !db.endsWith('_dev') || db === 'qiwu_dev')
    refuse('--db-name: 需要新项目的 *_dev 库，禁止 qiwu_dev / invalid database')
  const title = options.title ?? name
  singleLine(title, '--title')
  if (!title.length || title.length > 128) refuse('--title: 长度须为 1–128 / invalid length')
  if (/[$<>&"]/.test(title))
    refuse('--title: 禁止 $ < > & " / variable expansion and HTML characters are not allowed')
  const redis = options['redis-db']
  if (redis === undefined && !options['dry-run']) refuse('需要 --redis-db / Redis DB required')
  if (
    redis !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(redis) ||
      !Number.isSafeInteger(Number(redis)) ||
      reservedRedis.has(Number(redis)))
  )
    refuse(`--redis-db: 需要非负整数，${reservedText} 已保留 / invalid or reserved Redis DB`)
  return { name, db, title, redis }
}

function checkSecret(value, key) {
  singleLine(value, key)
  if (/not-for-production/i.test(value)) refuse(`${key}: 测试标记须手动替换 / replace test secret`)
  if (key === 'APP_SECRET') {
    if (value.length < 32) refuse('APP_SECRET: 至少 32 字符 / too short')
  } else if (
    value.length < 8 ||
    Buffer.byteLength(value) > 72 ||
    [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((re) => re.test(value)).length < 2
  ) {
    refuse('SEED_ADMIN_PASSWORD: 不满足默认密码策略 / invalid default password policy')
  }
}

// Both parsers keep single/backtick quotes literal; dotenv expands \r/\n in double quotes.
function encode(value, key) {
  singleLine(value, key)
  for (const quote of ["'", '`', '"']) {
    if (quote === '"' && value.includes('\\')) continue
    const encoded = `${quote}${value}${quote}`
    if (parseEnv(`${key}=${encoded}\n`)[key] === value) return encoded
  }
  refuse(`${key}: 无法无损编码 / cannot round-trip dotenv quoting`)
}

function envFile(text, file) {
  const lines = text.split(/(?<=\n)/)
  const entries = new Map()
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)/.exec(lines[i])
    if (!match) continue
    const [, key, value] = match
    if (entries.has(key)) refuse(`${file}: ${key} 重复 / duplicate key`)
    const start = i
    if (/^['"`]/.test(value) && !value.slice(1).includes(value[0])) {
      while (++i < lines.length && !lines[i].includes(value[0])) {
        /* quoted multiline */
      }
      if (i === lines.length) refuse(`${file}: ${key} 引号未闭合 / unclosed quote`)
    }
    const rhs = lines
      .slice(start, i + 1)
      .join('')
      .split(/=(.*)/s)[1]
      .trimStart()
    const tail = /^['"`]/.test(rhs)
      ? rhs.slice(rhs.indexOf(rhs[0], 1) + 1)
      : rhs.slice(rhs.indexOf('#') < 0 ? rhs.length : rhs.indexOf('#'))
    const comment = /^\s*#[^\r\n]*(?:\r?\n)?$/.test(tail) ? tail.trimEnd() : ''
    entries.set(key, { start, end: i, comment })
  }
  return { lines, entries, values: parseEnv(text) }
}

function updateEnv(text, updates, file) {
  const parsed = envFile(text, file)
  for (const [key, value] of Object.entries(updates)) {
    const entry = parsed.entries.get(key)
    const line = `${key}=${encode(value, key)}${entry?.comment ? ` ${entry.comment.trimStart()}` : ''}\n`
    if (entry) {
      parsed.lines[entry.start] = line
      for (let i = entry.start + 1; i <= entry.end; i++) parsed.lines[i] = ''
    } else {
      if (parsed.lines.length && !parsed.lines.at(-1).endsWith('\n')) parsed.lines.push('\n')
      parsed.lines.push(line)
    }
  }
  const result = parsed.lines.join('')
  const expected = { ...parsed.values, ...updates }
  if (
    JSON.stringify(Object.entries(parseEnv(result)).sort()) !==
    JSON.stringify(Object.entries(expected).sort())
  )
    refuse(`${file}: dotenv 校验失败 / parse mismatch`)
  return result
}

async function readTarget(base, file) {
  const path = join(base, file)
  // Reject symlinked directories as well as files: setup stays inside its copy.
  for (const dir of [dirname(path), dirname(dirname(path))]) {
    const stat = await lstat(dir)
    if (!stat.isDirectory()) refuse(`${file}: 目录必须为真实目录 / invalid directory`)
  }
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (stat && !stat.isFile()) refuse(`${file}: 需要普通文件 / regular file required`)
  return {
    file,
    path,
    before: stat ? await readFile(path, 'utf8') : null,
    oldMode: stat ? stat.mode & 0o777 : null,
  }
}

async function planProject(base, options, secretEnv = {}) {
  const config = validate(options)
  const blockers = []
  const block = (message) => {
    if (!options['dry-run']) refuse(message)
    blockers.push(message)
  }
  const targets = await Promise.all(files.map((file) => readTarget(base, file)))
  const example =
    targets[0].before === null ? (await readTarget(base, 'apps/server/.env.example')).before : null
  if (targets[0].before === null && example === null)
    refuse('缺少 apps/server/.env.example / missing example')
  const source = targets[0].before ?? example
  const server = envFile(source, files[0])
  for (const key of credentials) {
    if (server.entries.has(key))
      block(`${files[0]}: ${key} 请先迁至 .env.local / move credentials first`)
  }
  const local = envFile(targets[1].before ?? '', files[1])
  const secrets = {}
  const secretStatus = {}
  for (const [key, envKey] of [
    ['APP_SECRET', 'NEW_PROJECT_APP_SECRET'],
    ['SEED_ADMIN_PASSWORD', 'NEW_PROJECT_ADMIN_PASSWORD'],
  ]) {
    const existing = local.values[key]
    if (existing !== undefined && existing !== '') {
      try {
        checkSecret(existing, key)
      } catch (error) {
        block(error.message)
        secretStatus[key] = '阻塞：请手动替换 / blocked: replace manually'
        continue
      }
      secretStatus[key] = '保留已有值 / keep existing'
    } else {
      const supplied = secretEnv[envKey]
      if (supplied !== undefined) checkSecret(supplied, key)
      secretStatus[key] =
        supplied === undefined ? '将生成 / generate' : '从环境读取 / from environment'
      if (!options['dry-run']) {
        secrets[key] =
          supplied ??
          (key === 'APP_SECRET'
            ? randomBytes(48).toString('base64url')
            : `Aa1!${randomBytes(24).toString('base64url')}`)
        checkSecret(secrets[key], key)
      } else if (supplied !== undefined) encode(supplied, key)
    }
  }
  const serverUpdates = { DB_NAME: config.db }
  if (config.redis !== undefined) serverUpdates.REDIS_DB = config.redis
  targets[0].after = updateEnv(source, serverUpdates, files[0])
  targets[1].after = updateEnv(targets[1].before ?? '', secrets, files[1])
  for (const target of targets.slice(2)) {
    target.after = updateEnv(target.before ?? '', { VITE_APP_TITLE: config.title }, target.file)
  }
  for (const target of targets)
    target.mode = target.file === files[1] ? 0o600 : (target.oldMode ?? 0o644)
  return { base, config, targets, secretStatus, blockers, dryRun: !!options['dry-run'] }
}

// Four files: stage all new contents and rollback copies before the first replacement.
// Process/power loss between renames isn't a cross-file transaction; rerun after recovery.
async function writeProject(plan, replace = rename) {
  if (plan.dryRun) return
  const changed = plan.targets.filter((t) => t.after !== t.before || t.mode !== t.oldMode)
  const staged = []
  const committed = []
  let preserveBackups = false
  try {
    for (const target of changed) {
      await access(dirname(target.path), constants.W_OK)
      if (target.oldMode !== null && !(target.oldMode & 0o222))
        refuse(`${target.file}: 文件只读 / read-only file`)
      const current = await readTarget(plan.base, target.file)
      if (current.before !== target.before || current.oldMode !== target.oldMode)
        refuse(`${target.file}: 文件已变化 / concurrent change`)
    }
    for (const target of changed) {
      const temp = `${target.path}.new-project-${randomUUID()}`
      const backup = `${temp}.backup`
      staged.push({ ...target, temp, backup })
      await writeFile(temp, target.after, { mode: 0o600, flag: 'wx' })
      await chmod(temp, target.mode)
      if (target.before !== null)
        await writeFile(backup, target.before, { mode: 0o600, flag: 'wx' })
    }
    for (const target of staged) {
      await replace(target.temp, target.path)
      committed.push(target)
    }
  } catch (error) {
    for (const target of committed.reverse()) {
      try {
        if (target.before === null) await rm(target.path)
        else {
          await rename(target.backup, target.path)
          await chmod(target.path, target.oldMode)
        }
      } catch {
        preserveBackups = true
      }
    }
    if (preserveBackups)
      refuse('写入失败，恢复未完成；保留 .new-project-*.backup，请手动恢复 / rollback incomplete')
    throw error
  } finally {
    for (const target of staged) {
      await rm(target.temp, { force: true })
      if (!preserveBackups) await rm(target.backup, { force: true })
    }
  }
}

function report(plan) {
  const { config, secretStatus, blockers } = plan
  return `${plan.dryRun ? 'DRY RUN — 零写入 / no writes' : '配置已保存 / configuration saved'}
${blockers.length ? `实际写入前须处理 / write blockers:\n${blockers.join('\n')}\n` : ''}
${files[0]}: DB_NAME=${config.db}, REDIS_DB=${config.redis ?? '待提供 --redis-db / required before writing'}
${files[1]} (0600): APP_SECRET=${secretStatus.APP_SECRET}; SEED_ADMIN_PASSWORD=${secretStatus.SEED_ADMIN_PASSWORD}
${files[2]} + ${files[3]}: VITE_APP_TITLE=${config.title} (HTML / browser / sidebar / login page)
下一步 / Next steps (仅打印，不执行 / printed only):
  确认 .gitignore 忽略 .env 和 .env.local；在 .env.local 配置 DB/Redis 凭据。
  web 标题文件为非秘密配置，可提交 / web title files are non-secret and commit-trackable.
  由部署者创建 ${config.db} 新库并配置 Redis ACL；确认库号空闲且在 Redis 的 databases 范围内。
  pnpm i
  pnpm --filter @qiwu/shared build
  pnpm db:migrate
  pnpm db:seed
  管理员密码在 .env.local；实际 cfg_param 密码策略仍需满足。
  pnpm dev (由用户交互启动 / interactive user command)
未连接数据库/Redis，未建库或 reset，未启动服务；未修改包名、表前缀或 mobile。
`
}

async function inputOptions(options, input = process.stdin, output = process.stdout) {
  if (options['dry-run'] || (options.name !== undefined && options['redis-db'] !== undefined))
    return options
  if (!input.isTTY) refuse('非交互执行需 --name 和 --redis-db / supply required CLI options')
  const rl = createInterface({ input, output })
  try {
    const ask = async (prompt) => {
      // EOF/timeout must terminate rather than leave a pending terminal read behind.
      let onClose
      try {
        return await Promise.race([
          rl.question(prompt, { signal: AbortSignal.timeout(60_000) }),
          new Promise((_, reject) => {
            onClose = () => reject(new Error('EOF'))
            rl.once('close', onClose)
          }),
        ])
      } catch {
        refuse('输入已结束或超时 / input ended or timed out')
      } finally {
        rl.removeListener('close', onClose)
      }
    }
    if (options.name === undefined) options.name = await ask('项目 slug / Name: ')
    if (options['redis-db'] === undefined)
      options['redis-db'] = await ask(
        `空闲 Redis 库号 / Unused Redis DB (${reservedText} reserved): `,
      )
    if (options['db-name'] === undefined)
      options['db-name'] = (await ask('数据库名 / Database (Enter = <name>_dev): ')) || undefined
    if (options.title === undefined)
      options.title = (await ask('显示标题 / Title (Enter = name): ')) || undefined
    return options
  } finally {
    rl.close()
  }
}

async function selfTest() {
  const base = await mkdtemp(join(tmpdir(), 'qiwu-new-project-'))
  const opts = { name: 'demo-project', 'redis-db': '0', title: "Demo # 'quoted' \\ title" }
  const password = `Sensitive-Pw1#'"\\=marker`
  const appSecret = 'Sensitive-AppSecret-123456789012345678901234567890'
  const env = { NEW_PROJECT_APP_SECRET: appSecret, NEW_PROJECT_ADMIN_PASSWORD: password }
  const local = `# credentials stay\nDB_USER=owner\nDB_PASSWORD='Sensitive-Db#=\\'\nREDIS_USERNAME=acl\nREDIS_PASSWORD='Sensitive-Redis#='\nOTHER='keep # comment'\n`
  const fixture = async (existing = '') => {
    await rm(join(base, 'apps'), { recursive: true, force: true })
    await mkdir(join(base, 'apps/server'), { recursive: true })
    await mkdir(join(base, 'apps/web'), { recursive: true })
    await writeFile(
      join(base, 'apps/server/.env.example'),
      '# DB_NAME=comment\nDB_NAME=qiwu_dev # database comment\nREDIS_DB=13\nPORT=3000\n',
    )
    await writeFile(join(base, files[1]), local + existing, { mode: 0o640 })
    await writeFile(join(base, files[2]), '# web\nVITE_API_BASE=/custom\nVITE_APP_TITLE=Old\n', {
      mode: 0o640,
    })
    await writeFile(join(base, files[3]), 'VITE_API_BASE=/production\n')
  }
  const snapshot = async (stats = false) => {
    const rows = []
    for (const dir of ['apps/server', 'apps/web']) {
      const path = join(base, dir)
      const ds = await lstat(path)
      if (stats) rows.push([dir, ds.mtimeMs, ds.ctimeMs])
      for (const name of (await readdir(path)).sort()) {
        const p = join(path, name)
        const st = await lstat(p)
        rows.push([
          `${dir}/${name}`,
          createHash('sha256')
            .update(await readFile(p))
            .digest('hex'),
          st.mode & 0o777,
          ...(stats ? [st.mtimeMs, st.ctimeMs, st.size, st.ino] : []),
        ])
      }
    }
    return rows
  }
  const rejectWithoutWrites = async (options = opts, secrets = env) => {
    const before = await snapshot()
    await assert.rejects(async () => writeProject(await planProject(base, options, secrets)))
    assert.deepEqual(await snapshot(), before)
  }
  try {
    await fixture()
    const before = await snapshot(true)
    const dry = await planProject(base, { name: 'demo', 'dry-run': true }, env)
    await writeProject(dry)
    assert.deepEqual(await snapshot(true), before)
    assert.match(report(dry), /required before writing/)
    assert.match(
      report(dry),
      /  pnpm i\n  pnpm --filter @qiwu\/shared build\n  pnpm db:migrate\n  pnpm db:seed\n/,
    )
    assert.equal(dry.targets[0].before, null)
    for (const name of ['', 'A', '../demo', 'a\nDB_NAME=bad', 'a'.repeat(64)])
      await rejectWithoutWrites({ ...opts, name })
    validate({
      ...opts,
      name: 'a'.repeat(63),
      'db-name': `${'a'.repeat(60)}_dev`,
      title: 'a'.repeat(128),
    })
    for (const db of [
      'qiwu_dev',
      'demo_test',
      'demo-dev',
      'demo_dev\nX=1',
      `${'a'.repeat(61)}_dev`,
    ])
      await rejectWithoutWrites({ ...opts, 'db-name': db })
    for (const title of ['', 'a\rX=1', 'a\nX=1', 'a\0', 'a'.repeat(129), ...'$<>&"'])
      await rejectWithoutWrites({ ...opts, title })
    for (const redis of [...reservedRedis]
      .map(String)
      .concat(['-1', '1.5', '01', '1e2', '', '0\nX=1', '9007199254740992']))
      await rejectWithoutWrites({ ...opts, 'redis-db': redis })
    await rejectWithoutWrites({ name: 'demo' })
    for (const value of [
      '',
      'short',
      'x'.repeat(40) + 'NOT-FOR-PRODUCTION',
      'x'.repeat(40) + '\nX=1',
    ])
      await rejectWithoutWrites(opts, { ...env, NEW_PROJECT_APP_SECRET: value })
    for (const value of ['short', 'abcdefgh', 'Aa1!' + 'x'.repeat(69), 'Aa1!\0abc', 'Aa1!\nabc'])
      await rejectWithoutWrites(opts, { ...env, NEW_PROJECT_ADMIN_PASSWORD: value })
    assert.equal(parseEnv(`X=${encode(password, 'X')}`).X, password)
    assert.equal(parseEnv(`X=${encode('literal\\n#=', 'X')}`).X, 'literal\\n#=')
    const literalCR = "Sensitive-Pw1'\\r#="
    const encodedCR = encode(literalCR, 'X')
    assert.equal(parseEnv(`X=${encodedCR}`).X, literalCR)
    assert.equal(encodedCR[0], '`') // dotenv@18 also preserves backtick-quoted backslashes.
    assert.throws(() => encode("Aa1'`\\r", 'X'), /cannot round-trip/)
    const plan = await planProject(base, opts, env)
    assert.ok(!report(plan).includes('Sensitive-'))
    await writeProject(plan)
    const server = parseEnv(await readFile(join(base, files[0]), 'utf8'))
    assert.equal(server.DB_NAME, 'demo_project_dev')
    assert.equal(server.REDIS_DB, '0')
    assert.equal(server.PORT, '3000')
    for (const key of [
      'DB_USER',
      'DB_PASSWORD',
      'REDIS_USERNAME',
      'REDIS_PASSWORD',
      'APP_SECRET',
      'SEED_ADMIN_PASSWORD',
      'WX_MP_APPID',
      'WX_MP_SECRET',
    ])
      assert.ok(!(key in server))
    const saved = parseEnv(await readFile(join(base, files[1]), 'utf8'))
    assert.equal(saved.APP_SECRET, appSecret)
    assert.equal(saved.SEED_ADMIN_PASSWORD, password)
    assert.equal(saved.DB_PASSWORD, 'Sensitive-Db#=\\')
    assert.equal(saved.REDIS_PASSWORD, 'Sensitive-Redis#=')
    assert.equal(saved.DB_USER, 'owner')
    assert.equal(saved.REDIS_USERNAME, 'acl')
    assert.equal(saved.OTHER, 'keep # comment')
    assert.equal((await lstat(join(base, files[1]))).mode & 0o777, 0o600)
    assert.equal((await lstat(join(base, files[2]))).mode & 0o777, 0o640)
    for (const file of files.slice(2)) {
      const web = parseEnv(await readFile(join(base, file), 'utf8'))
      assert.equal(web.VITE_APP_TITLE, opts.title)
      assert.ok(web.VITE_API_BASE.startsWith('/'))
      assert.ok(!JSON.stringify(web).includes('Sensitive-'))
    }
    assert.match(await readFile(join(base, files[0]), 'utf8'), /# DB_NAME=comment/)
    assert.match(await readFile(join(base, files[0]), 'utf8'), /# database comment/)
    const first = await snapshot(true)
    const repeat = await planProject(base, opts, { NEW_PROJECT_APP_SECRET: 'ignored' })
    assert.match(report(repeat), /keep existing/)
    assert.ok(!report(repeat).includes('Sensitive-'))
    await writeProject(repeat)
    assert.deepEqual(await snapshot(true), first)
    await fixture()
    await rm(join(base, files[1]))
    await rm(join(base, files[2]))
    await rm(join(base, files[3]))
    const generated = await planProject(base, opts)
    await writeProject(generated)
    const generatedEnv = parseEnv(await readFile(join(base, files[1]), 'utf8'))
    checkSecret(generatedEnv.APP_SECRET, 'APP_SECRET')
    checkSecret(generatedEnv.SEED_ADMIN_PASSWORD, 'SEED_ADMIN_PASSWORD')
    assert.ok(!report(generated).includes(generatedEnv.APP_SECRET))
    for (const file of files)
      assert.equal((await lstat(join(base, file))).mode & 0o777, file === files[1] ? 0o600 : 0o644)
    for (const key of ['APP_SECRET', 'SEED_ADMIN_PASSWORD']) {
      await fixture(`${key}='Aa1!NOT-FOR-PRODUCTION-${'x'.repeat(32)}'\n`)
      await rejectWithoutWrites()
    }
    for (const key of [
      'DB_USER',
      'DB_PASSWORD',
      'REDIS_USERNAME',
      'REDIS_PASSWORD',
      'APP_SECRET',
      'SEED_ADMIN_PASSWORD',
      'WX_MP_APPID',
      'WX_MP_SECRET',
    ]) {
      await fixture()
      await writeFile(join(base, files[0]), `DB_NAME=demo_dev\n${key}=\n`)
      await rejectWithoutWrites()
      const blockedBefore = await snapshot(true)
      const blockedDryRun = await planProject(base, { name: 'demo', 'dry-run': true }, env)
      await writeProject(blockedDryRun)
      assert.deepEqual(await snapshot(true), blockedBefore)
      assert.match(report(blockedDryRun), /move credentials first/)
    }
    for (const file of files) {
      await fixture()
      await writeFile(join(base, file), 'OTHER=one\nexport OTHER=two\n')
      await rejectWithoutWrites()
    }
    assert.match(
      updateEnv(
        "OTHER='line\nDB_NAME=not_a_key\nend'\nDB_NAME=old\n",
        { DB_NAME: 'new_dev' },
        'fixture',
      ),
      /DB_NAME=not_a_key/,
    )
    await fixture()
    const rollbackBefore = await snapshot()
    let renames = 0
    const rollback = await planProject(base, opts, env)
    await assert.rejects(
      writeProject(rollback, async (from, to) => {
        if (++renames === 3) throw new Error('injected write failure')
        await rename(from, to)
      }),
      /injected write failure/,
    )
    assert.deepEqual(await snapshot(), rollbackBefore)
    await chmod(join(base, files[2]), 0o444)
    await rejectWithoutWrites()
    await fixture()
    const stale = await planProject(base, opts, env)
    await writeFile(join(base, files[3]), 'OTHER=changed\n')
    const changedBefore = await snapshot()
    await assert.rejects(writeProject(stale), /concurrent change/)
    assert.deepEqual(await snapshot(), changedBefore)
    await fixture()
    // Only Node subprocesses, always bounded; CLI is copied into the fixture, never targets the repo.
    await mkdir(join(base, 'scripts'))
    const cli = join(base, 'scripts/new-project.mjs')
    await writeFile(cli, await readFile(script))
    const run = (args, nodeArgs = []) =>
      execFileSync(process.execPath, [...nodeArgs, cli, ...args], {
        input: '',
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      })
    assert.ok(!run(['--help']).includes('Sensitive-'))
    assert.ok(!run(['--dry-run', '--name', 'demo']).includes('Sensitive-'))
    for (const args of [[], ['--name', 'demo'], ['--name', password], ['--unknown', password]]) {
      let failure
      try {
        run(args)
      } catch (error) {
        failure = error
      }
      assert.equal(failure?.status, 1)
      assert.ok(!`${failure.stdout}${failure.stderr}`.includes('Sensitive-'))
    }
    assert.ok(!run(['--name', 'demo', '--redis-db', '0']).includes('Sensitive-'))
    const injection = join(base, 'parser-failure.mjs')
    await writeFile(
      injection,
      `import util from 'node:util'
import { syncBuiltinESMExports } from 'node:module'
util.parseEnv = () => { throw new Error('Sensitive-parser-input') }
syncBuiltinESMExports()
`,
    )
    let parserFailure
    try {
      run(['--name', 'demo', '--redis-db', '0'], ['--import', injection])
    } catch (error) {
      parserFailure = error
    }
    assert.equal(parserFailure?.status, 1)
    assert.equal(
      parserFailure.stderr,
      'new-project: operation failed (unknown); no secrets printed\n',
    )
    assert.ok(!`${parserFailure.stdout}${parserFailure.stderr}`.includes('Sensitive-'))
    const input = new PassThrough()
    input.isTTY = true
    const output = new PassThrough()
    const answers = ['demo', '0', '', 'Interactive Demo']
    output.on('data', () => {
      if (answers.length) setImmediate(() => input.write(`${answers.shift()}\n`))
    })
    assert.deepEqual(await inputOptions({}, input, output), {
      name: 'demo',
      'redis-db': '0',
      'db-name': undefined,
      title: 'Interactive Demo',
    })
    assert.equal(validate(opts).redis, '0')
    const endedInput = new PassThrough()
    endedInput.isTTY = true
    const pending = inputOptions({}, endedInput, new PassThrough())
    endedInput.end()
    await assert.rejects(pending, /input ended/)
    console.log(
      'new-project self-test: PASS (validation, dry-run, quoting, secret preservation, modes, rollback, CLI; temporary fixtures only)',
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function main() {
  let options
  try {
    options = parseArgs({
      options: {
        name: { type: 'string' },
        'db-name': { type: 'string' },
        title: { type: 'string' },
        'redis-db': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'self-test': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch {
    refuse('参数格式错误，运行 --help / invalid arguments; see --help')
  }
  if (options.help) {
    console.log(help)
    return
  }
  if (options['self-test']) {
    await selfTest()
    return
  }
  options = await inputOptions(options)
  const plan = await planProject(root, options, process.env)
  await writeProject(plan)
  console.log(report(plan))
}

if (process.argv[1] && realpathSync(process.argv[1]) === script) {
  try {
    await main()
  } catch (error) {
    // Parser/FS errors can include input contents; only our controlled messages or errno are safe.
    console.error(
      `new-project: ${error.safeMessage ? error.message : `operation failed (${error.code ?? 'unknown'}); no secrets printed`}`,
    )
    process.exitCode = 1
  }
}
