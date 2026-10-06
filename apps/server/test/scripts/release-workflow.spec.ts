// .github/workflows/release.yml: a vX.Y.Z tag does not run the gate again. Before the GitHub Release
// it requires a completed, successful run of this repository's CI workflow (ci.yml) for a push to
// main of exactly the tagged commit whose gate job passed; no step or job can be skipped past or have
// its failure ignored; only the release job may write contents, deploy stays behind the "demo"
// environment. The CI check step runs here under bash with a stand-in `gh` (needs jq).
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Step {
  name?: string
  if?: string
  uses?: string
  run?: string
  env?: Record<string, string>
}
interface Job {
  if?: string
  uses?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  environment?: string
  steps?: Step[]
}
interface Workflow {
  permissions: Record<string, string>
  jobs: Record<string, Job>
}

// `yaml` ships with nestjs-i18n (a server dependency), so one test needs no extra dependency
const yaml = createRequire(createRequire(import.meta.url).resolve('nestjs-i18n'))('yaml') as {
  parse: (src: string) => unknown
}
const WORKFLOWS = join(process.cwd(), '../../.github/workflows')
const wf = yaml.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as Workflow
const STEP = 'CI passed for this commit on main'
const ciStep = () => wf.jobs.release?.steps?.find((s) => s.name === STEP)

it('no job calls ci.yml: the tag run does not repeat the gate', () => {
  const uses = Object.values(wf.jobs).flatMap((j) => [
    j.uses,
    ...(j.steps ?? []).map((s) => s.uses),
  ])
  expect(uses.filter((u) => u?.includes('ci.yml'))).toEqual([])
  expect(Object.keys(wf.jobs)).toEqual(['release', 'deploy'])
  // nothing else calls ci.yml either, so it has no workflow_call trigger
  const ci = yaml.parse(readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8')) as Workflow & {
    on: object
  }
  expect(Object.keys(ci.on)).toEqual(['push', 'pull_request', 'workflow_dispatch'])
  // the job the CI check looks up by name: the API names a job without `name:` by its key
  expect(ci.jobs.gate).toBeDefined()
  expect(ci.jobs.gate).not.toHaveProperty('name')
})

it('no step or job can be skipped past or have its failure ignored', () => {
  expect(wf.jobs.release?.if).toMatch(/^github\.repository == '[^']+'$/)
  expect(wf.jobs.deploy).not.toHaveProperty('if')
  for (const job of Object.values(wf.jobs)) {
    expect(job).not.toHaveProperty('continue-on-error')
    for (const step of job.steps ?? []) {
      expect(step).not.toHaveProperty('if')
      expect(step).not.toHaveProperty('continue-on-error')
    }
  }
  expect(Object.keys(ciStep() ?? {})).toEqual(['name', 'env', 'run'])
})

it('permissions stay minimal per job; only release writes contents, deploy waits for "demo"', () => {
  expect(wf.permissions).toEqual({ contents: 'read' })
  expect(wf.jobs.release?.permissions).toEqual({ contents: 'write', actions: 'read' })
  expect(wf.jobs.deploy?.permissions).toEqual({})
  expect(wf.jobs.deploy).toMatchObject({ needs: 'release', environment: 'demo' })
})

it('release checks the tag, then CI, and only then creates the Release', () => {
  const names = (wf.jobs.release?.steps ?? []).map((s) => s.name)
  const at = (name: string) => names.indexOf(name)
  expect(at('Tag on main, release notes from CHANGELOG.md')).toBeGreaterThan(-1)
  expect(at('Tag on main, release notes from CHANGELOG.md')).toBeLessThan(at(STEP))
  expect(at(STEP)).toBeLessThan(at('GitHub Release'))
  expect(ciStep()?.env).toEqual({
    GH_TOKEN: '${{ github.token }}',
    COMMIT: '${{ steps.tag.outputs.commit }}',
  })
})

const tools =
  process.platform !== 'win32' &&
  spawnSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0

describe.skipIf(!tools)('CI check step', () => {
  const REPO = 'owner/qiwu'
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  const ID = 161
  const RUN = 7
  const good = {
    id: RUN,
    workflow_id: ID,
    event: 'push',
    head_branch: 'main',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
  }
  const gate = { name: 'gate', status: 'completed', conclusion: 'success' }

  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qw-release-workflow-'))
    // answers exactly the three expected API calls, anything else fails like an API error
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env bash
[[ "$1 $2" == "api repos/${REPO}/actions/workflows/ci.yml" ]] && exec cat "${dir}/workflow.json"
[[ "$1 $2" == "api repos/${REPO}/actions/workflows/${ID}/runs?head_sha=${SHA}&per_page=100" ]] &&
  exec cat "${dir}/runs.json"
[[ "$1 $2" == "api repos/${REPO}/actions/runs/${RUN}/jobs" ]] && exec cat "${dir}/jobs.json"
echo "unexpected: $*" >&2
exit 1
`,
    )
    chmodSync(join(dir, 'gh'), 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function check(
    runs: object[],
    workflow = { id: ID, path: '.github/workflows/ci.yml' },
    jobs: object[] = [gate],
  ) {
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify(workflow))
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ total_count: jobs.length, jobs }))
    writeFileSync(
      join(dir, 'runs.json'),
      JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
    )
    // the runner's `shell: bash`
    const r = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', ciStep()?.run ?? 'exit 9'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_REPOSITORY: REPO,
          GITHUB_SERVER_URL: 'https://github.com',
          COMMIT: SHA,
        },
      },
    )
    return { status: r.status, out: r.stdout }
  }

  it('passes with a successful push run of ci.yml on main for the commit', () => {
    const r = check([{ ...good, id: RUN + 1, conclusion: 'failure' }, good])
    expect(r.status).toBe(0)
    expect(r.out).toContain(`CI passed: https://github.com/${REPO}/actions/runs/${RUN}`)
  })

  it.each([
    ['still running', { status: 'in_progress', conclusion: null }],
    ['not completed, whatever its conclusion', { status: 'in_progress' }],
    ['failed', { conclusion: 'failure' }],
    ['cancelled', { conclusion: 'cancelled' }],
    ['started by hand', { event: 'workflow_dispatch' }],
    ['a pull request', { event: 'pull_request' }],
    ['another branch', { head_branch: 'release' }],
    ['another commit', { head_sha: 'f'.repeat(40) }],
    ['another workflow', { workflow_id: ID + 1 }],
    ['a fork', { head_repository: { full_name: 'fork/qiwu' } }],
    ['another repository', { repository: { full_name: 'other/qiwu' } }],
  ])('fails when the only run is %s, telling how to get a passing run', (_, change) => {
    const r = check([{ ...good, ...change }])
    expect(r.status).toBe(1)
    expect(r.out).toContain(`::error::No successful CI run of a push to main for ${SHA}.`)
    expect(r.out).toContain('wait for it and re-run this release workflow')
    expect(r.out).toContain('re-run or fix CI first')
    expect(r.out).toContain('tag a commit that a successful push-to-main CI run tested')
  })

  it.each([
    ['skipped', [{ ...gate, conclusion: 'skipped' }]],
    ['failed', [{ ...gate, conclusion: 'failure' }]],
    ['missing', [{ ...gate, name: 'other' }]],
    ['listed twice', [gate, gate]],
  ])('fails when the run succeeded but its gate job is %s', (_, jobs) => {
    const r = check([good], undefined, jobs)
    expect(r.status).toBe(1)
    expect(r.out).toContain(`::error::CI run ${RUN} for ${SHA} did not pass its gate job`)
    expect(r.out).not.toContain('CI passed')
  })

  it('fails without any run, and when ci.yml is not the workflow the API returns', () => {
    expect(check([]).status).toBe(1)
    const other = check([good], { id: ID, path: '.github/workflows/release.yml' })
    expect(other.status).not.toBe(0)
    expect(other.out).not.toContain('CI passed')
  })
})
