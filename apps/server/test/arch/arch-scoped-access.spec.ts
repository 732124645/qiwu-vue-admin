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
