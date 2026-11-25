// 聊天清理任务（see docs/im.md）：只删每个会话从 floor_seq 起连续的过期前缀（中间有未过期的行就停住，不跳着
// 删）、把 floor_seq 推进到前缀之后、软删这些行绑定的对象；每批至多 500 行、中止信号即停、下轮续跑；保留
// 天数 0 永久不删；剩下的行原样保留作者快照；逐租户清理（别的租户也清）。24 小时仍未绑定的聊天上传被软删，
// 新的、已绑定的、别的标签的不动，与绑定同时发生时绑定赢。
import { randomUUID } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { imParams } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
import { JobRegistry } from '../../src/modules/platform/scheduler/job-registry.js'
import { bootApp, createTenant, inTenant1, type TestTenant } from '../setup/tenants.js'
import { imKit } from './im-objects.helpers.js'

let app: NestExpressApplication
let kit: ReturnType<typeof imKit>
let ds: DataSource
let other: TestTenant
let author = 0
let storageId = 0
const rooms: number[] = []
const objects: number[] = []

/** 跑一次清理（像调度器那样不带租户）；返回输出。 */
const purge = (signal = new AbortController().signal) =>
  app
    .get(JobRegistry)
    .get('im.purge')!
    .run({}, { signal, log: () => undefined }) as Promise<string>

/** 一个对象行（不写文件本体：清理只做软删），创建于 `hoursAgo` 小时前。 */
async function object(
  tenantId: number,
  tag: string,
  ref: string | null,
  hoursAgo: number,
): Promise<number> {
  const { insertId } = await ds.query<{ insertId: number }>(
    `INSERT INTO fs_object (tenant_id, storage_id, object_key, original_name, mime, size, sha256,
       biz_tag, biz_ref, uploader_id, created_at)
     VALUES (?, ?, ?, 'a.png', 'image/png', 10, NULL, ?, ?, ?, NOW(3) - INTERVAL ? HOUR)`,
    [tenantId, storageId, `im-purge/${randomUUID()}.png`, tag, ref, author, hoursAgo],
  )
  objects.push(Number(insertId))
  return Number(insertId)
}

/**
 * 一个群会话与 `ages.length` 条消息（seq 从 1 起，第 i 条是 `ages[i]` 天前的）；`attached` 里的 seq 带原图
 * 与缩略图两个已绑定对象。返回会话 id 与各 seq 的对象。
 */
async function room(
  ages: number[],
  opts: { tenantId?: number; attached?: number[] } = {},
): Promise<{ id: number; files: Map<number, number[]> }> {
  const tenantId = opts.tenantId ?? 1
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO im_room (tenant_id, room_kind, label, last_seq) VALUES (?, 'group', 'Purge', ?)",
    [tenantId, ages.length],
  )
  const id = Number(insertId)
  rooms.push(id)
  const files = new Map<number, number[]>()
  for (const seq of opts.attached ?? [])
    files.set(seq, [
      await object(tenantId, 'im.attachment', `im:${id}:${seq}`, 1),
      await object(tenantId, 'im.attachment', `im:${id}:${seq}`, 1),
    ])
  const rows = ages.map((_, i) => {
    const seq = i + 1
    const f = files.get(seq)
    return [
      tenantId,
      id,
      seq,
      author,
      'admin',
      'Ann Author',
      f ? 'image' : 'text',
      f ? null : `line ${seq}`,
      f
        ? JSON.stringify({
            objectId: f[0],
            thumbObjectId: f[1],
            name: 'a.png',
            mime: 'image/png',
            size: 10,
            sha256: 'x',
          })
        : null,
    ]
  })
  await ds.query(
    `INSERT INTO im_entry (tenant_id, room_id, seq, author_id, author_kind, author_label, entry_kind,
       text_value, attachment) VALUES ?`,
    [rows],
  )
  // 按天数分组改创建时间（同一天数一条语句）
  for (const days of new Set(ages))
    await ds.query(
      `UPDATE im_entry SET created_at = NOW(3) - INTERVAL ? DAY
        WHERE tenant_id = ? AND room_id = ? AND seq IN (?)`,
      [days, tenantId, id, ages.flatMap((d, i) => (d === days ? [i + 1] : []))],
    )
  return { id, files }
}

const seqsOf = async (roomId: number) =>
  (
    await ds.query<{ seq: number }[]>('SELECT seq FROM im_entry WHERE room_id = ? ORDER BY seq', [
      roomId,
    ])
  ).map((r) => Number(r.seq))
const floorOf = async (roomId: number) =>
  Number(
    (
      await ds.query<{ f: number }[]>('SELECT floor_seq AS f FROM im_room WHERE id = ?', [roomId])
    )[0]!.f,
  )
const deleted = async (id: number) =>
  (
    await ds.query<{ d: Date | null }[]>('SELECT deleted_at AS d FROM fs_object WHERE id = ?', [id])
  )[0]!.d !== null

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  kit = imKit(app, 'im-purge-')
  ds = kit.ds
  author = (await kit.person('author')).id
  storageId = Number(
    (
      await ds.query<{ id: number }[]>(
        'SELECT id FROM fs_storage WHERE is_primary = 1 AND deleted_at IS NULL LIMIT 1',
      )
    )[0]!.id,
  )
  other = await createTenant(app)
})

afterEach(() => vi.restoreAllMocks())

afterAll(async () => {
  if (ds) {
    if (rooms.length) {
      await ds.query('DELETE FROM im_entry WHERE room_id IN (?)', [rooms])
      await ds.query('DELETE FROM im_room WHERE id IN (?)', [rooms])
    }
    if (objects.length) await ds.query('DELETE FROM fs_object WHERE id IN (?)', [objects])
  }
  await other?.dispose()
  await kit?.dispose()
  await app?.close()
})

describe('retention', () => {
  it('deletes only the contiguous expired prefix, advances floor_seq and soft-deletes what it bound', async () => {
    // seq 1–3 过期、4 未过期、5 又过期：只删 1–3
    const r = await room([60, 60, 60, 1, 60], { attached: [2, 5] })
    const out = await kit.withParam(imParams.retentionDays, '30', () => purge())
    expect(out).toMatch(/^kept 30 days, \d+ entries deleted; \d+ unbound uploads recycled$/)
    expect(await seqsOf(r.id)).toEqual([4, 5])
    expect(await floorOf(r.id)).toBe(4)
    for (const id of r.files.get(2)!) expect(await deleted(id)).toBe(true)
    for (const id of r.files.get(5)!) expect(await deleted(id)).toBe(false)
    // 剩下的行原样：作者快照、正文都在；last_seq 不变
    expect(
      await ds.query(
        'SELECT seq, author_id, author_label, text_value FROM im_entry WHERE room_id = ? ORDER BY seq',
        [r.id],
      ),
    ).toEqual([
      { seq: 4, author_id: author, author_label: 'Ann Author', text_value: 'line 4' },
      { seq: 5, author_id: author, author_label: 'Ann Author', text_value: null },
    ])
    expect(
      Number((await ds.query('SELECT last_seq AS s FROM im_room WHERE id = ?', [r.id]))[0].s),
    ).toBe(5)
    // 再跑一次：最早一条未过期，什么都不动
    await kit.withParam(imParams.retentionDays, '30', () => purge())
    expect(await seqsOf(r.id)).toEqual([4, 5])
    expect(await floorOf(r.id)).toBe(4)
  })

  it('works in batches of at most 500: an abort stops after a batch and the next run goes on', async () => {
    const r = await room(Array.from({ length: 520 }, () => 90))
    const abort = new AbortController()
    const original = ds.transaction.bind(ds) as (...a: unknown[]) => Promise<unknown>
    // 这个会话的第一批提交之后中止（像任务锁丢失）
    vi.spyOn(ds, 'transaction').mockImplementation((async (...args: unknown[]) => {
      const res = await original(...args)
      if ((await floorOf(r.id)) > 1) abort.abort(new Error('lock lost'))
      return res
    }) as never)
    await kit.withParam(imParams.retentionDays, '30', async () => {
      await expect(purge(abort.signal)).rejects.toThrow('lock lost')
      expect(await floorOf(r.id)).toBe(501)
      expect(await seqsOf(r.id)).toEqual(Array.from({ length: 20 }, (_, i) => 501 + i))
      vi.restoreAllMocks()
      await purge()
    })
    expect(await seqsOf(r.id)).toEqual([])
    expect(await floorOf(r.id)).toBe(521)
  })

  it('an aborted signal stops before anything is deleted', async () => {
    const r = await room([90, 90])
    const abort = new AbortController()
    abort.abort(new Error('shutting down'))
    await kit.withParam(imParams.retentionDays, '30', async () => {
      await expect(purge(abort.signal)).rejects.toThrow('shutting down')
    })
    expect(await seqsOf(r.id)).toEqual([1, 2])
    expect(await floorOf(r.id)).toBe(1)
  })

  it('0 keeps everything forever', async () => {
    const r = await room([4000, 4000], { attached: [1] })
    const out = await kit.withParam(imParams.retentionDays, '0', () => purge())
    expect(out).toMatch(/^kept forever; /)
    expect(await seqsOf(r.id)).toEqual([1, 2])
    expect(await floorOf(r.id)).toBe(1)
    for (const id of r.files.get(1)!) expect(await deleted(id)).toBe(false)
  })

  it('every tenant is purged in its own context', async () => {
    const r = await room([60, 60, 1], { tenantId: other.id, attached: [1] })
    await kit.withParam(imParams.retentionDays, '30', () => purge())
    expect(await seqsOf(r.id)).toEqual([3])
    expect(await floorOf(r.id)).toBe(3)
    for (const id of r.files.get(1)!) expect(await deleted(id)).toBe(true)
  })
})

describe('unbound uploads', () => {
  it('soft-deletes chat uploads unbound for 24 hours; fresh, bound and other tags stay', async () => {
    const oldFile = await object(1, 'im.attachment', null, 25)
    const oldSticker = await object(1, 'im.sticker', null, 25)
    const theirs = await object(other.id, 'im.attachment', null, 48)
    const fresh = await object(1, 'im.attachment', null, 23)
    const bound = await object(1, 'im.attachment', 'im:1:1', 48)
    const boundSticker = await object(1, 'im.sticker', 'stk:1', 48)
    const plain = await object(1, 'attachment', null, 48)
    const out = await kit.withParam(imParams.retentionDays, '0', () => purge())
    expect(out).toMatch(/; [1-9]\d* unbound uploads recycled$/)
    for (const id of [oldFile, oldSticker, theirs]) expect(await deleted(id)).toBe(true)
    for (const id of [fresh, bound, boundSticker, plain]) expect(await deleted(id)).toBe(false)
  })

  it('a bind in progress wins: the recycling waits for it and leaves the bound object', async () => {
    const racing = await object(1, 'im.attachment', null, 30)
    let running: Promise<string> | undefined
    await inTenant1(() =>
      ds.transaction(async (tx) => {
        await app.get(StorageService).bindRefs([racing], 'im.attachment', 'im:2:2', author, tx)
        // 绑定已写、未提交：回收在这行上等锁，提交后它的条件不再成立
        running = kit.withParam(imParams.retentionDays, '0', () => purge())
        await new Promise((resolve) => setTimeout(resolve, 300))
      }),
    )
    await running
    const [row] = await ds.query<{ biz_ref: string | null; deleted_at: Date | null }[]>(
      'SELECT biz_ref, deleted_at FROM fs_object WHERE id = ?',
      [racing],
    )
    expect(row).toEqual({ biz_ref: 'im:2:2', deleted_at: null })
  })
})
