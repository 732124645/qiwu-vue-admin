// scripts/deploy: the deploy key's forced command passes on only "<vX.Y.Z> <commit sha>",
// server-deploy.sh checks its arguments before it reads, locks or writes anything, and a dry-run
// deploy against a scratch root takes the lock, switches `current`, refuses a downgrade, deletes a
// release that failed before the switch, never one that is live, and switches back when the health
// check fails; the layout script keeps the deploy key in a root-owned keys file. Needs bash; the
// dry-run part also flock, GNU mv and GNU readlink (Linux).
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const KIT = join(process.cwd(), '../../scripts/deploy')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const WINDOWS = process.platform === 'win32'
const LINUX_TOOLS =
  !WINDOWS &&
  spawnSync('bash', ['-c', 'command -v flock && mv --version && readlink -m /'], {
    stdio: 'ignore',
  }).status === 0

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'qw-deploy-kit-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** copies a kit script into <dir>/bin (executable) and returns its path */
function install(name: string, as = name): string {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const to = join(dir, 'bin', as)
  copyFileSync(join(KIT, name), to)
  chmodSync(to, 0o755)
  return to
}
const run = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(file, args, { encoding: 'utf8', env })

it('ecosystem.config.cjs: two cluster workers behind the current symlink', () => {
  const require = createRequire(import.meta.url)
  const [app] = require(join(KIT, 'ecosystem.config.cjs')).apps
  const server = '/srv/qiwu/current/apps/server'
  expect(app).toMatchObject({ exec_mode: 'cluster', instances: 2, cwd: server })
  expect(app.node_args).toBe(
    `--env-file-if-exists=${server}/.env.local --env-file-if-exists=${server}/.env`,
  )
})

describe.skipIf(WINDOWS)('shell scripts', () => {
  it('every script parses', () => {
    const scripts = readdirSync(KIT).filter((f) => f.endsWith('.sh'))
    expect(scripts.length).toBeGreaterThanOrEqual(3)
    for (const f of scripts) expect([f, run('bash', ['-n', join(KIT, f)]).status]).toEqual([f, 0])
  })

  it('the forced command passes on exactly "<vX.Y.Z> <commit sha>" and refuses everything else', () => {
    const forced = install('deploy-forced-command.sh')
    writeFileSync(
      join(dir, 'bin/server-deploy.sh'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$#" "$@" > "$(dirname "$0")/called"\n',
      { mode: 0o755 },
    )
    const called = join(dir, 'bin/called')
    const forcedRun = (cmd?: string) => {
      rmSync(called, { force: true })
      const env = { ...process.env, SSH_ORIGINAL_COMMAND: cmd }
      if (cmd === undefined) delete env.SSH_ORIGINAL_COMMAND
      return run(forced, [], env)
    }

    expect(forcedRun(`v1.2.3 ${SHA}`).status).toBe(0)
    expect(readFileSync(called, 'utf8')).toBe(`2\nv1.2.3\n${SHA}\n`)
    expect(forcedRun(`v10.20.30 ${SHA}`).status).toBe(0)
    for (const bad of [
      undefined,
      '',
      'v1.2.3',
      `v1.2.3 ${SHA} x`,
      `v1.2.3;id ${SHA}`,
      `$(id) ${SHA}`,
      `v1.2.3 ${SHA.toUpperCase()}`,
      `v1.2.3 ${SHA.slice(1)}`,
      `v1.2.3 ${SHA}\nid`,
      `v1.2.3 ${SHA}\n`,
      ` v1.2.3 ${SHA}`,
      `v1.2.3  ${SHA}`,
      `v1.2 ${SHA}`,
      `v1.2.3-rc.1 ${SHA}`,
      '--rollback',
      `--dry-run /tmp/x.tgz v1.2.3 ${SHA}`,
    ]) {
      const res = forcedRun(bad)
      expect([bad, res.status, existsSync(called)]).toEqual([bad, 64, false])
    }
  })

  it('server-deploy.sh refuses bad arguments before reading its settings', () => {
    const deploy = install('server-deploy.sh') // no deploy.env next to bin/
    for (const args of [
      [],
      ['v1.2.3;id'],
      ['V1.2.3'],
      ['v1.2'],
      ['v1.2.3', 'xyz'],
      ['v1.2.3', SHA.toUpperCase()],
      ['v1.2.3', SHA, 'x'],
      ['--rollback', 'x'],
      ['--dry-run'],
      ['--dry-run', join(dir, 'missing.tgz'), 'v1.2.3'],
    ]) {
      const res = run(deploy, args)
      expect([args, res.status]).toEqual([args, 64])
      expect(res.stderr).toContain('usage:')
    }
    // valid arguments get as far as the missing settings file
    expect(run(deploy, ['v1.2.3', SHA]).status).toBe(1)
  })

  it('server-migrate-layout.sh refuses a kit that anyone but root can change, before anything else', () => {
    // a scratch copy belongs to the test user (and sits under a world-writable temp directory)
    const res = run('bash', [install('server-migrate-layout.sh')])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('must be owned by root and not writable by group or others')
  })

  it('server-migrate-layout.sh keeps the deploy key in a root-owned keys file named by the sshd drop-in', () => {
    // deploy_key runs on its own under root's strictest umask: root-only commands are stand-ins
    // that log their arguments, sshd reports the drop-in's values for the app user and the defaults
    // for root; STUB_USER ("<keyword> <value>") and STUB_ROOT_* stand for an earlier Match block
    // whose value wins
    const fn = /^deploy_key\(\) \{[\s\S]*?^\}$/m.exec(
      readFileSync(join(KIT, 'server-migrate-layout.sh'), 'utf8'),
    )
    expect(fn).not.toBeNull()
    const dest = join(dir, 'opt')
    const conf = join(dir, 'sshd_config.d/60-qiwu-deploy.conf')
    const home = join(dir, 'home')
    const calls = join(dir, 'calls')
    const ak = join(dest, 'authorized_keys')
    const forced = join(dest, 'bin/deploy-forced-command.sh')
    for (const d of [dest, join(dir, 'sshd_config.d'), home]) mkdirSync(d)
    writeFileSync(
      join(dir, 'harness.sh'),
      [
        'set -euo pipefail',
        'umask 077',
        `DEST='${dest}' SSHD_CONF='${conf}' H='${home}' U=qiwu CALLS='${calls}'`,
        'log() { echo "== $*"; }',
        'die() { echo "STOP: $*" >&2; exit 1; }',
        'getent() { echo "qiwu:x:997:987::$H:/bin/bash"; }',
        "passwd() { echo 'qiwu L'; }",
        'as_app() { echo "as_app $*" >>"$CALLS"; }',
        'usermod() { echo "usermod $*" >>"$CALLS"; }',
        'chown() { echo "chown $*" >>"$CALLS"; }',
        'systemctl() { echo "systemctl $*" >>"$CALLS"; }',
        'sshd() {',
        '  case $* in',
        '    -t) return "${STUB_SYNTAX:-0}" ;;',
        '    *user=root,*) echo "authorizedkeysfile ${STUB_ROOT_KEYS:-.ssh/authorized_keys .ssh/authorized_keys2}"; echo "forcecommand ${STUB_ROOT_FC:-none}" ;;',
        '    *user=qiwu,*) awk -v o="${STUB_USER:-}" \'NR > 1 { k = tolower($1); sub(/^ *[^ ]+ /, ""); v = $0',
        '      if (k == substr(o, 1, index(o, " ") - 1)) v = substr(o, index(o, " ") + 1)',
        '      print k, v }\' "$SSHD_CONF" ;;',
        '  esac',
        '}',
        fn![0],
        'deploy_key "$1"',
        '',
      ].join('\n'),
    )
    const key = (n: number) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n}keyA== deploy`
    const runKey = (n: number, extra: NodeJS.ProcessEnv = {}) => {
      writeFileSync(join(dir, 'key.pub'), `${key(n)}\n`)
      return run('bash', [join(dir, 'harness.sh'), join(dir, 'key.pub')], {
        ...process.env,
        ...extra,
      })
    }

    // sshd would not apply the drop-in as written: it is removed and no key is written
    for (const extra of [
      { STUB_SYNTAX: '1' },
      ...[
        'authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2',
        'authenticationmethods any',
        'forcecommand /bin/sh',
        'disableforwarding no',
        'permituserrc yes',
        'permittty yes',
      ].map((STUB_USER) => ({ STUB_USER })),
      { STUB_ROOT_KEYS: ak },
      { STUB_ROOT_FC: forced },
    ]) {
      const res = runKey(1, extra)
      expect([extra, res.status, existsSync(conf), existsSync(ak)]).toEqual([
        extra,
        1,
        false,
        false,
      ])
      expect(res.stderr).toContain('the sshd drop-in did not check out')
    }

    const ok = runKey(1)
    expect({ status: ok.status, err: ok.stderr }).toMatchObject({ status: 0 })
    expect(readFileSync(conf, 'utf8')).toBe(
      [
        'Match User qiwu',
        `    AuthorizedKeysFile ${ak}`,
        '    AuthenticationMethods publickey',
        `    ForceCommand ${forced}`,
        '    DisableForwarding yes',
        '    PermitUserRC no',
        '    PermitTTY no',
        '',
      ].join('\n'),
    )
    const line = (n: number) => `restrict,command="${forced}" ${key(n)}\n`
    expect(readFileSync(ak, 'utf8')).toBe(line(1))
    expect(statSync(ak).mode & 0o777).toBe(0o644)
    expect(readFileSync(calls, 'utf8')).toContain(`chown root:root ${ak}\n`)

    // a key already present is skipped, a new one appended
    expect(runKey(1).status).toBe(0)
    expect(readFileSync(ak, 'utf8')).toBe(line(1))
    expect(runKey(2).status).toBe(0)
    expect(readFileSync(ak, 'utf8')).toBe(line(1) + line(2))

    // nothing in the app user's home, nothing run as the app user
    expect(readdirSync(home)).toEqual([])
    expect(readFileSync(calls, 'utf8')).not.toMatch(/^as_app /m)
  })

  it("server-migrate-layout.sh stops when anyone else is in the app user's group", () => {
    // the group may write the deploy root, which can be the app user's home
    const fn = /^own_group\(\) \{[\s\S]*?^\}$/m.exec(
      readFileSync(join(KIT, 'server-migrate-layout.sh'), 'utf8'),
    )
    expect(fn).not.toBeNull()
    writeFileSync(
      join(dir, 'group.sh'),
      [
        'set -euo pipefail',
        'U=qiwu G=qiwu ROOT=/srv/qiwu',
        'die() { echo "STOP: $*" >&2; exit 1; }',
        'getent() {',
        '  case $1 in',
        '    group) echo "qiwu:x:987:$STUB_MEMBERS" ;;',
        "    passwd) printf '%s\\n' qiwu:x:997:987::/srv/qiwu:/bin/bash www-data:x:33:33::/var/www:/bin/false $STUB_USERS ;;",
        '  esac',
        '}',
        fn![0],
        'own_group',
        '',
      ].join('\n'),
    )
    const check = (STUB_MEMBERS: string, STUB_USERS = '') =>
      run('bash', [join(dir, 'group.sh')], { ...process.env, STUB_MEMBERS, STUB_USERS })
    for (const members of ['', 'qiwu'])
      expect([members, check(members).status]).toEqual([members, 0])
    const ops = 'ops:x:1001:987::/home/ops:/bin/bash' // another user with the group as primary group
    for (const [members, users, who] of [
      ['qiwu,www-data', '', 'www-data'],
      ['', ops, 'ops'],
      ['qiwu,deploy', ops, 'deploy,ops'],
    ]) {
      const res = check(members, users)
      expect([res.status, res.stderr]).toEqual([
        1,
        `STOP: group qiwu of qiwu also holds ${who}, who could write in /srv/qiwu: give qiwu a group of its own\n`,
      ])
    }
  })
})

describe.skipIf(!LINUX_TOOLS)('server-deploy.sh --dry-run against a scratch root', () => {
  let deploy: string
  let commit: string
  let env: NodeJS.ProcessEnv
  /** a dry-run deploy; `extra` reaches the stand-in pm2 */
  const dry = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    run(deploy, ['--dry-run', ...args], { ...env, ...extra })
  beforeEach(() => {
    deploy = install('server-deploy.sh')
    // the tags resolve in a local repository: v1.2.4 is annotated (its commit is the peeled ^{} entry)
    const repo = join(dir, 'repo')
    const git = (...args: string[]) => {
      const res = spawnSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      })
      expect({ status: res.status, stderr: res.stderr }).toMatchObject({ status: 0 })
      return res.stdout.trim()
    }
    mkdirSync(repo)
    git('init', '-q')
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'r',
    )
    for (const tag of ['v1.2.2', 'v1.2.3', 'v1.2.5']) git('tag', tag)
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'tag', '-a', 'v1.2.4', '-m', 'r')
    commit = git('rev-parse', 'HEAD')
    writeFileSync(
      join(dir, 'deploy.env'),
      [
        `QW_DEPLOY_ROOT=${dir}`,
        `QW_REPO=${repo}`,
        `QW_APP_USER=${userInfo().username}`,
        `QW_HEALTH_URL=file://${dir}/current/health.json`,
        'QW_HEALTH_TRIES=1',
        'QW_MIN_FREE_MB=0',
        'QW_SHARED_LINKS=apps/server/.env',
        '',
      ].join('\n'),
    )
    writeFileSync(join(dir, 'DRY_RUN'), '')
    mkdirSync(join(dir, 'shared/apps/server'), { recursive: true })
    writeFileSync(join(dir, 'shared/apps/server/.env'), `STORAGE_LOCAL_ROOT=${dir}/uploads\n`)
    // stand-in for PM2: "pid <name>" lists STUB_WORKERS workers (default QW_PM2_INSTANCES) whose
    // working directory, in <root>/proc, is STUB_CWD (default: the release behind current)
    mkdirSync(join(dir, 'stub'))
    writeFileSync(
      join(dir, 'stub/pm2'),
      [
        '#!/usr/bin/env bash',
        '[[ $1 == pid ]] || exit 0',
        'cwd=$STUB_CWD n=$STUB_WORKERS',
        '[[ -n $cwd ]] || cwd=$(readlink -f "$QW_DEPLOY_ROOT/current")/apps/server',
        '[[ -n $n ]] || n=$QW_PM2_INSTANCES',
        'for ((i = 1; i <= n; i++)); do',
        '  mkdir -p "$QW_DEPLOY_ROOT/proc/$i" && ln -sfn "$cwd" "$QW_DEPLOY_ROOT/proc/$i/cwd" && echo "$i"',
        'done',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    env = { ...process.env, PATH: `${join(dir, 'stub')}:${process.env.PATH}` }
  })

  /** a release tarball like GitHub's (one top-level directory) with one web asset */
  function tarball(tag: string, healthy = true, extra?: (top: string) => void): string {
    const top = join(dir, 'src', tag, 'qiwu-src')
    mkdirSync(join(top, 'apps/server'), { recursive: true })
    mkdirSync(join(top, 'apps/web/dist/assets'), { recursive: true })
    writeFileSync(join(top, `apps/web/dist/assets/${tag}.js`), tag)
    if (healthy) writeFileSync(join(top, 'health.json'), '{"code":0,"data":{"status":"ok"}}')
    extra?.(top)
    const out = join(dir, `${tag}.tgz`)
    expect(run('tar', ['-czf', out, '-C', join(dir, 'src', tag), 'qiwu-src']).status).toBe(0)
    return out
  }
  const current = () => readlinkSync(join(dir, 'current'))
  const release = (tag: string) =>
    readdirSync(join(dir, 'releases')).find((d) => d.startsWith(`${tag}-`))

  it('deploys only the commit the tag points to, holds a lock, and refuses a downgrade', () => {
    const unknown = dry([tarball('v9.9.9'), 'v9.9.9'])
    expect(unknown.status).toBe(1)
    expect(unknown.stdout).toContain('tag v9.9.9 not found')
    const moved = dry([tarball('v1.2.3'), 'v1.2.3', SHA])
    expect(moved.status).toBe(1)
    expect(moved.stdout).toContain(`tag v1.2.3 points to ${commit}, the caller sent ${SHA}`)
    expect(existsSync(join(dir, 'current'))).toBe(false)

    const ok = dry([tarball('v1.2.3'), 'v1.2.3', commit])
    expect({ status: ok.status, out: ok.stdout }).toMatchObject({ status: 0 })
    expect(ok.stdout).toContain(`OK v1.2.3 ${commit} is live`)
    expect(current()).toMatch(/^releases\/v1\.2\.3-\d{8}T\d{6}Z$/)
    const live = join(dir, current())
    expect(existsSync(join(live, 'DEPLOYED'))).toBe(true)
    expect(readlinkSync(join(live, 'apps/server/.env'))).toBe(join(dir, 'shared/apps/server/.env'))

    const locked = spawnSync(
      'bash',
      [
        '-c',
        'exec 9>"$1/deploy.lock"; flock -n 9 || exit 99; "$2" --dry-run "$3" v1.2.4',
        '_',
      ].concat([dir, deploy, tarball('v1.2.4')]),
      { encoding: 'utf8', env },
    )
    expect(locked.status).toBe(75)
    expect(locked.stderr).toContain('another deploy is running')

    const down = dry([tarball('v1.2.2'), 'v1.2.2'])
    expect(down.status).toBe(1)
    expect(down.stdout).toContain('refusing to downgrade v1.2.3 -> v1.2.2')
    expect(current()).toBe(`releases/${release('v1.2.3')}`)
    expect(release('v1.2.4')).toBeUndefined()
    expect(release('v1.2.2')).toBeUndefined()

    rmSync(join(dir, 'DRY_RUN'))
    expect(dry([tarball('v1.2.5'), 'v1.2.5']).status).toBe(64)
  })

  it('runs only as the configured user and only with current as a symlink', () => {
    const settings = readFileSync(join(dir, 'deploy.env'), 'utf8')
    writeFileSync(join(dir, 'deploy.env'), `${settings}QW_APP_USER=nobody\n`)
    const other = dry([tarball('v1.2.3'), 'v1.2.3'])
    expect([other.status, other.stderr]).toEqual([64, 'server-deploy.sh runs as nobody\n'])
    writeFileSync(join(dir, 'deploy.env'), settings)

    mkdirSync(join(dir, 'current'))
    const plain = dry([tarball('v1.2.3'), 'v1.2.3'])
    expect(plain.status).toBe(1)
    expect(plain.stdout).toContain(`${dir}/current must be a symlink`)
    expect(existsSync(join(dir, 'releases'))).toBe(false)
  })

  it('a failure before or at the switch exits 1, deletes the new release and keeps current', () => {
    expect(dry([tarball('v1.2.3'), 'v1.2.3']).status).toBe(0)
    const good = current()
    const shared = join(dir, 'shared/apps/server/.env')
    const failsWith = (out: string) => {
      const res = dry([tarball('v1.2.4'), 'v1.2.4'])
      expect([res.status, release('v1.2.4'), current()]).toEqual([1, undefined, good])
      expect(res.stdout).toContain(out)
    }
    // uploads inside the code would be replaced by the next switch and deleted by pruning
    for (const bad of [
      'uploads',
      `${dir}/current/uploads`,
      `${dir}/app/uploads`,
      `${dir}/releases/x/uploads`,
      `${dir}/uploads/../current/up`,
    ]) {
      writeFileSync(shared, `STORAGE_LOCAL_ROOT='${bad}'\n`)
      failsWith(`STORAGE_LOCAL_ROOT=${bad} `)
    }
    writeFileSync(shared, 'APP_PORT=3000\n')
    failsWith('set STORAGE_LOCAL_ROOT')
    writeFileSync(shared, `STORAGE_LOCAL_ROOT=${dir}/shared/uploads\n`)

    // a failing command takes the same way out
    writeFileSync(join(dir, 'broken.tgz'), 'not a tarball')
    const broken = dry([join(dir, 'broken.tgz'), 'v1.2.4'])
    expect([broken.status, release('v1.2.4')]).toEqual([1, undefined])
    expect(broken.stdout).toContain('step "download v1.2.4')

    // the switch itself: a directory in the way of current.next
    mkdirSync(join(dir, 'current.next/x'), { recursive: true })
    failsWith(`could not switch ${dir}/current`)
    rmSync(join(dir, 'current.next'), { recursive: true })
    expect(dry([tarball('v1.2.4'), 'v1.2.4']).status).toBe(0)
  })

  it('a failure after the switch never deletes the live release', () => {
    // DEPLOYED cannot be written: a dangling link in the release
    const tgz = tarball('v1.2.3', true, (top) =>
      symlinkSync(join(dir, 'missing/DEPLOYED'), join(top, 'DEPLOYED')),
    )
    expect(dry([tgz, 'v1.2.3']).status).toBe(0)
    expect(current()).toBe(`releases/${release('v1.2.3')}`)
    expect(existsSync(join(dir, current(), 'apps/server'))).toBe(true)
  })

  it('stays unhealthy until every PM2 worker runs from the new release', () => {
    const few = dry([tarball('v1.2.3'), 'v1.2.3'], { STUB_WORKERS: '1' })
    expect({ status: few.status, out: few.stdout }).toMatchObject({ status: 3 })
    expect(few.stdout).toContain('no earlier release to go back to')
    const elsewhere = dry([tarball('v1.2.4'), 'v1.2.4'], { STUB_CWD: join(dir, 'src') })
    expect({ status: elsewhere.status, out: elsewhere.stdout }).toMatchObject({ status: 3 })
    expect(elsewhere.stdout).toContain('the earlier release is unhealthy too')
    for (const tag of ['v1.2.3', 'v1.2.4'])
      expect(existsSync(join(dir, 'releases', release(tag)!, 'DEPLOYED'))).toBe(false)
  })

  it('switches back when the new release fails its health check; --rollback goes to the previous one', () => {
    expect(dry([tarball('v1.2.3'), 'v1.2.3']).status).toBe(0)
    const good = `releases/${release('v1.2.3')}`

    const bad = dry([tarball('v1.2.4', false), 'v1.2.4', commit])
    expect({ status: bad.status, out: bad.stdout }).toMatchObject({ status: 2 })
    expect(bad.stdout).toContain('SWITCHED BACK to v1.2.3')
    expect(current()).toBe(good)
    const failed = join(dir, 'releases', release('v1.2.4')!)
    expect(existsSync(join(failed, 'DEPLOYED'))).toBe(false)
    // the running release's web assets were carried into the new one (hard links)
    expect(existsSync(join(failed, 'apps/web/dist/assets/v1.2.3.js'))).toBe(true)

    expect(dry([tarball('v1.2.5'), 'v1.2.5']).status).toBe(0)
    expect(release('v1.2.4')).toBeUndefined() // failed leftovers are pruned after a good deploy

    const back = dry(['--rollback'])
    expect({ status: back.status, out: back.stdout }).toMatchObject({ status: 0 })
    expect(current()).toBe(good)
  })
})
