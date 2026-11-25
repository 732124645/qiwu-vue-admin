// scripts/arch/scoped-access.mjs (see docs/design-notes.md#data-scope, #auth-sessions) against a throwaway source tree: data-scoped
// writes by id must reach lockScopedIds (directly or through a locking service method, inherited from
// BaseCrudService or BaseTreeService too), and only
// core/auth may name auth:* keys. The real tree passing is `pnpm arch:check` (pnpm verify).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const NOTE = `@DataScoped({ dept: 'dept_id', owner: 'created_by' })
export class Note extends BaseEntity {}
export class Plain {}

export class NoteService extends BaseCrudService<Note> {
  override async remove(ids: readonly number[]) {
    await this.repo.softDelete([...ids])
  }
  archive(ids: number[]) {
    return this.txHost.withTransaction(() => this.lockScopedIds(ids))
  }
  archiveOne(id: number) {
    return this.archive([id])
  }
  rename(id: number) {
    return super.update(id, {})
  }
  touch(id: number) {
    return this.repo.update(id, {})
  }
}
export class PlainService extends BaseCrudService<Plain> {}

@Controller('notes')
export class NoteController {
  constructor(
    private readonly notes: NoteService,
    private readonly plain: PlainService,
  ) {}
  @Get(':id') get(@Param('id') id: number) { return this.notes.get(id) }
  @Post() create(@Body() dto: object) { return this.notes.create(dto) }
  @Put(':id') update(@Param('id') id: number, @Body() dto: object) { return this.notes.update(id, dto) }
  @Delete(':id') remove(@Param('id') id: number) { return this.notes.remove([id]) }
  @Post('batch-archive') archive(@Body() body: { ids: number[] }) { return this.notes.archive(body.ids) }
  @Put(':id/archive') archiveOne(@Param('id') id: number) { return this.notes.archiveOne(id) }
  @Put(':id/rename') rename(@Param('id') id: number) { return this.notes.rename(id) }
  @Put(':id/touch') touch(@Param('id') id: number) { return this.notes.touch(id) }
  @Put(':id/plain') plainWrite(@Param('id') id: number) { return this.plain.update(id, {}) }
}
`
/** A service below BaseTreeService (itself below BaseCrudService): its inherited writes lock too. */
const TREE = `@DataScoped({ dept: 'id', owner: null })
export class Topic extends BaseEntity {}

export class TopicService extends BaseTreeService<Topic> {
  peek(id: number) {
    return this.get(id)
  }
}

@Controller('topics')
export class TopicController {
  constructor(private readonly topics: TopicService) {}
  @Put(':id') update(@Param('id') id: number, @Body() dto: object) { return this.topics.update(id, dto) }
  @Delete(':id') remove(@Param('id') id: number) { return this.topics.remove([id]) }
  @Put(':id/peek') peek(@Param('id') id: number) { return this.topics.peek(id) }
}
`
const KEYS = `const a = redisKey('authSession', sid)
await redis.unlink(keyPattern('authUser'))
const b = redisKey('dict', code)
// redisKey('authSession', sid) in a comment is not code
`

const DELEGATED = `@DataScoped({ dept: 'dept_id', owner: 'created_by' })
export class Entry extends BaseEntity {}
@DataScoped({ dept: 'dept_id', owner: 'created_by' })
export class Trail extends BaseEntity {}
export class FirstService extends BaseCrudService<Trail> {
  constructor(private readonly next: SecondService) {}
  write(id: number) { return this.next.write(id) }
}
export class SecondService extends BaseCrudService<Trail> {
  constructor(private readonly owner: OwnerService) {}
  write(id: number) { return this.owner.lockCurrent(id) }
}
export class OwnerService extends BaseCrudService<Entry> {
  lockCurrent(id: number) { return this.lockScopedIds([id]) }
  peek(id: number) { return this.get(id) }
}
export class ReadService extends BaseCrudService<Trail> {
  constructor(private readonly owner: OwnerService) {}
  write(id: number) { return this.owner.peek(id) }
  unusedLock(id: number) { return this.owner.lockCurrent(id) }
}
export class UnknownService { write(id: number) { return id } }
export class UnresolvedService extends BaseCrudService<Trail> {
  constructor(private readonly unknown: UnknownService) {}
  write(id: number) { return this.unknown.write(id) }
}
export class CycleFirstService extends BaseCrudService<Trail> {
  constructor(private readonly next: CycleSecondService) {}
  write(id: number) { return this.next.write(id) }
}
export class CycleSecondService extends BaseCrudService<Trail> {
  constructor(private readonly next: CycleFirstService) {}
  write(id: number) { return this.next.write(id) }
}
@Controller('delegated')
export class DelegatedController {
  constructor(private readonly service: FirstService) {}
  @Post(':id') write(@Param('id') id: number) { return this.service.write(id) }
}
@Controller('read-only')
export class ReadController {
  constructor(private readonly service: ReadService) {}
  @Post(':id') write(@Param('id') id: number) { return this.service.write(id) }
}
@Controller('unknown')
export class UnknownController {
  constructor(private readonly service: UnresolvedService) {}
  @Post(':id') write(@Param('id') id: number) { return this.service.write(id) }
}
@Controller('cycle')
export class CycleController {
  constructor(private readonly service: CycleFirstService) {}
  @Post(':id') write(@Param('id') id: number) { return this.service.write(id) }
}
`

it.each([
  ['native', true],
  ['windows', true],
  ['native', false],
  ['windows', false],
] as const)('%s: injected service paths require a reachable lock (%s)', (platform, locked) => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-delegation-'))
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  try {
    put(
      'apps/server/src/core/db/base-crud.service.ts',
      readFileSync('src/core/db/base-crud.service.ts', 'utf8'),
    )
    put(
      'apps/server/src/modules/demo/delegation.ts',
      locked ? DELEGATED : DELEGATED.replace('this.lockScopedIds([id])', 'this.get(id)'),
    )
    const r = spawnSync(
      process.execPath,
      [
        ...(platform === 'windows' ? ['--import', './test/arch/fixtures/windows-paths.mjs'] : []),
        '../../scripts/arch/run.mjs',
        '--root',
        root,
        '--only',
        'scoped-access',
      ],
      { encoding: 'utf8', timeout: 20_000 },
    )
    expect(r.status).toBe(1)
    const found = [...r.stderr.matchAll(/x \S+:\d+ (\S+)/g)].map(([, what]) => what)
    expect(found).toEqual([
      ...(locked ? [] : ['DelegatedController.write:']),
      'ReadController.write:',
      'UnknownController.write:',
      'CycleController.write:',
    ])
    expect(r.stderr).not.toContain('check crashed:')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  ['native', false],
  ['windows', false],
  ['native', true],
  ['windows', true],
] as const)(
  '%s: ambiguous injected service names or ancestors do not prove a lock (%s)',
  (platform, inherited) => {
    const root = mkdtempSync(join(tmpdir(), 'qw-arch-ambiguous-'))
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    try {
      put(
        'apps/server/src/core/db/base-crud.service.ts',
        readFileSync('src/core/db/base-crud.service.ts', 'utf8'),
      )
      const service = inherited ? 'UniqueService' : 'SharedService'
      put(
        'apps/server/src/modules/demo/a-writer.ts',
        `import { ${service} } from './${inherited ? 'b-unique' : 'm-unlocked'}.js'
@DataScoped({ dept: 'dept_id', owner: 'created_by' })
export class Entry extends BaseEntity {}
export class WriterService extends BaseCrudService<Entry> {
  constructor(private readonly helper: ${service}) {}
  write(id: number) { return this.helper.change(id) }
}
@Controller('ambiguous')
export class AmbiguousController {
  constructor(private readonly service: WriterService) {}
  @Put(':id') write(@Param('id') id: number) { return this.service.write(id) }
}`,
      )
      if (inherited)
        put(
          'apps/server/src/modules/demo/b-unique.ts',
          `import { SharedService } from './m-unlocked.js'
export class UniqueService extends SharedService<Entry> {}`,
        )
      put(
        'apps/server/src/modules/demo/m-unlocked.ts',
        `export class SharedService extends BaseCrudService<Entry> {
  change(id: number) { return this.repo.update(id, {}) }
}`,
      )
      put(
        'apps/server/src/modules/demo/z-locked.ts',
        `export class SharedService extends BaseCrudService<Entry> {
  change(id: number) { return this.lockScopedIds([id]) }
}`,
      )
      const r = spawnSync(
        process.execPath,
        [
          ...(platform === 'windows' ? ['--import', './test/arch/fixtures/windows-paths.mjs'] : []),
          '../../scripts/arch/run.mjs',
          '--root',
          root,
          '--only',
          'scoped-access',
        ],
        { encoding: 'utf8', timeout: 20_000 },
      )
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('AmbiguousController.write:')
      expect(r.stderr).not.toContain('check crashed:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it.each(['native', 'windows'])(
  '%s: flags unlocked writes by id and auth:* keys outside core/auth, nothing else',
  (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    try {
      // the real base classes: which of their methods lock is read from them
      for (const base of ['src/core/db/base-crud.service.ts', 'src/core/db/base-tree.service.ts'])
        put(`apps/server/${base}`, readFileSync(base, 'utf8'))
      put('apps/server/src/modules/demo/note.ts', NOTE)
      put('apps/server/src/modules/demo/tree.ts', TREE)
      put('apps/server/src/modules/demo/keys.ts', KEYS)
      put('apps/server/src/core/auth/keys.ts', KEYS)
      const r = spawnSync(
        process.execPath,
        [
          ...(platform === 'windows' ? ['--import', './test/arch/fixtures/windows-paths.mjs'] : []),
          '../../scripts/arch/run.mjs',
          '--root',
          root,
          '--only',
          'scoped-access',
        ],
        { encoding: 'utf8' },
      )
      expect(r.status).toBe(1)
      const found = [...r.stderr.matchAll(/x (\S+:\d+) (\S+)/g)].map(
        ([, at, what]) => `${at} ${what}`,
      )
      expect(found).toEqual([
        'apps/server/src/modules/demo/note.ts:33 NoteController.remove:',
        'apps/server/src/modules/demo/note.ts:37 NoteController.touch:',
        'apps/server/src/modules/demo/tree.ts:15 TopicController.peek:',
        'apps/server/src/modules/demo/keys.ts:1 auth:*',
        'apps/server/src/modules/demo/keys.ts:2 auth:*',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
