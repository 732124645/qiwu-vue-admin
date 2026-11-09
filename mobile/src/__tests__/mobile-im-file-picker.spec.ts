// 聊天选文件：显示名清洗（路径分隔符、控制字符、超长）、扩展名白名单与大小上限、content:// 与 file:// 到
// 显示名与副本路径的映射、发送成功或过期后删除副本；App 的 Android 选择器跑在一个假的 Native.js 上，
// 证明检查发生在复制之前、复制中超限会删半成品。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImOutboxRecord } from '@qiwu/shared/im-client'
import {
  OUTBOX_EXPIRE_MS,
  checkPick,
  fileExt,
  nameFromUri,
  outboxCopies,
  outboxPath,
  rememberOutboxCopy,
  safeFileName,
  staleOutboxCopies,
  sweepOutboxCopies,
} from '@/core/im/file-pick'
import { copyIntoOutbox, pickAppFile } from '@/core/im/file-picker-app'

const LIMITS = {
  fileExts: ['pdf', 'docx', 'zip'],
  imageExts: ['jpg', 'png'],
  fileMaxMb: 20,
}
const MB = 1024 * 1024

beforeEach(() => uni.removeStorageSync('qw.im.outbox'))

describe('names, types and sizes', () => {
  it('a display name becomes a safe file name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('D:\\docs\\me\\q3.pdf')).toBe('q3.pdf')
    expect(safeFileName('bad\u0000na\u001fme\u0085.pdf')).toBe('badname.pdf')
    expect(safeFileName(' a?b*.pdf ')).toBe('a_b_.pdf')
    expect(safeFileName('...')).toBe('file')
    expect(safeFileName('')).toBe('file')
    const long = safeFileName(`${'名'.repeat(300)}.docx`)
    expect([...long]).toHaveLength(100)
    expect(long.endsWith('.docx')).toBe(true)
  })

  it('extensions: lower case, none for dot files or a trailing dot', () => {
    expect(fileExt('A.PDF')).toBe('pdf')
    expect(fileExt('.bashrc')).toBe('')
    expect(fileExt('noext')).toBe('')
    expect(fileExt('a.')).toBe('')
  })

  it('only listed types, not empty, within the size limit', () => {
    expect(checkPick({ name: 'q3.pdf', size: 10 }, LIMITS)).toBeNull()
    expect(checkPick({ name: 'photo.PNG', size: 10 }, LIMITS)).toBeNull()
    expect(checkPick({ name: 'tool.exe', size: 10 }, LIMITS)).toBe('type')
    expect(checkPick({ name: 'page.html', size: 10 }, LIMITS)).toBe('type')
    expect(checkPick({ name: 'noext', size: 10 }, LIMITS)).toBe('type')
    expect(checkPick({ name: '../x.pdf/..', size: 10 }, LIMITS)).toBe('type')
    expect(checkPick({ name: 'q3.pdf', size: 0 }, LIMITS)).toBe('empty')
    expect(checkPick({ name: 'q3.pdf', size: 20 * MB }, LIMITS)).toBeNull()
    expect(checkPick({ name: 'q3.pdf', size: 20 * MB + 1 }, LIMITS)).toBe('size')
  })

  it('copies go under the outbox folder only', () => {
    expect(outboxPath('k1-2', '../../x.pdf')).toBe('_doc/im-outbox/k1-2-x.pdf')
    expect(outboxPath('k1', 'a/b\\c.zip')).toBe('_doc/im-outbox/k1-c.zip')
    for (const id of ['../a', 'a/b', '', 'a.b']) expect(() => outboxPath(id, 'x.pdf'), id).toThrow()
  })

  it('content:// and file:// to a display name', () => {
    expect(
      nameFromUri(
        'content://com.android.externalstorage.documents/document/primary%3ADownload%2Freport%20q3.pdf',
      ),
    ).toBe('report q3.pdf')
    expect(nameFromUri('file:///storage/emulated/0/Download/a%20b.zip')).toBe('a b.zip')
    expect(nameFromUri('file:///var/mobile/tmp/x.docx?y=1#z')).toBe('x.docx')
    // undecodable: kept as it is, still made safe
    expect(nameFromUri('content://p/document/bad%E0%A4%A.pdf')).toBe('bad%E0%A4%A.pdf')
  })
})

const item = (ref: string, state: 'pending' | 'failed', createdAt: number): ImOutboxRecord => ({
  clientEntryId: ref,
  roomId: 1,
  kind: 'file',
  file: { name: 'x.pdf', size: 1, mime: 'application/pdf', localRef: ref },
  state,
  attempts: 0,
  createdAt,
  nextAttemptAt: createdAt,
})

describe('outbox copies', () => {
  const now = 10 * OUTBOX_EXPIRE_MS
  const D = '_doc/im-outbox/'

  it('stale: acknowledged (no outbox item any more) and failed past 24 hours', () => {
    const copies = [`${D}pending`, `${D}failed`, `${D}expired`, `${D}acked`, '_doc/other.pdf']
    const outbox = [
      item(`${D}pending`, 'pending', now - 2 * OUTBOX_EXPIRE_MS),
      item(`${D}failed`, 'failed', now - OUTBOX_EXPIRE_MS + 1),
      item(`${D}expired`, 'failed', now - OUTBOX_EXPIRE_MS),
    ]
    expect(staleOutboxCopies(copies, outbox, now)).toEqual([`${D}expired`, `${D}acked`])
  })

  it('sweeping deletes the stale copies and forgets them; all = every copy', async () => {
    for (const p of ['a', 'b', 'c']) rememberOutboxCopy(D + p)
    const remove = vi.fn(async () => {})
    await sweepOutboxCopies([item(`${D}b`, 'pending', now)], remove, now)
    expect(remove.mock.calls.map((c) => (c as unknown[])[0])).toEqual([`${D}a`, `${D}c`])
    expect(outboxCopies()).toEqual([`${D}b`])
    await sweepOutboxCopies([item(`${D}b`, 'pending', now)], remove, now, true)
    expect(remove).toHaveBeenLastCalledWith(`${D}b`)
    expect(outboxCopies()).toEqual([])
  })
})

describe('App picker on Android (a stand-in Native.js)', () => {
  let meta: { name: string | null; size: number | null }
  let reads: number[]
  let cancel: boolean
  const opened = vi.fn()
  const writes: number[] = []
  const deleted: string[] = []

  class Intent {
    static ACTION_OPEN_DOCUMENT = 'open-document'
    static CATEGORY_OPENABLE = 'openable'
    addCategory() {}
    setType() {}
  }
  class File {
    constructor(readonly path: string) {}
    getParentFile = () => ({ mkdirs: () => true })
    delete = () => void deleted.push(this.path)
  }
  class FileOutputStream {
    write = (_buf: unknown, _off: number, n: number) => void writes.push(n)
    close() {}
  }
  const uri = { toString: () => 'content://p/document/primary%3ADownload%2Ffallback.pdf' }
  const resolver = {
    query: () => ({
      moveToFirst: () => true,
      getColumnIndex: (c: string) => (c === '_display_name' ? (meta.name === null ? -1 : 0) : 1),
      getString: () => meta.name,
      isNull: () => meta.size === null,
      getLong: () => meta.size,
      close() {},
    }),
    openInputStream: () => {
      opened()
      return { read: () => reads.shift() ?? -1, close() {} }
    },
  }
  const main: Record<string, unknown> = {
    getContentResolver: () => resolver,
    startActivityForResult: (_intent: unknown, code: number) =>
      setTimeout(() =>
        (main.onActivityResult as (c: number, r: number, d: unknown) => void)(
          code,
          cancel ? 0 : -1,
          cancel ? null : { getData: () => uri },
        ),
      ),
  }
  const classes: Record<string, unknown> = {
    'android.content.Intent': Intent,
    'android.app.Activity': { RESULT_OK: -1 },
    'java.io.File': File,
    'java.io.FileOutputStream': FileOutputStream,
    'java.lang.Byte': { TYPE: 'byte' },
  }

  beforeEach(() => {
    meta = { name: 'q3 report.pdf', size: 3 }
    reads = [2, 1]
    cancel = false
    opened.mockClear()
    writes.length = 0
    deleted.length = 0
    vi.stubGlobal('plus', {
      os: { name: 'Android' },
      io: { convertLocalFileSystemURL: (p: string) => `/data/app/${p}` },
      android: {
        runtimeMainActivity: () => main,
        importClass: (c: unknown) => (typeof c === 'string' ? classes[c] : c),
        invoke: (obj: unknown, method: string, ...args: unknown[]) =>
          typeof obj === 'string'
            ? { array: args }
            : (obj as Record<string, (...a: unknown[]) => unknown>)[method]!(...args),
      },
    })
  })

  it('a listed file within the limit is copied into the outbox folder and remembered', async () => {
    const out = await pickAppFile(LIMITS)
    expect(out).toMatchObject({ name: 'q3 report.pdf', size: 3, mime: 'application/pdf' })
    const ref = (out as { localRef: string }).localRef
    expect(ref).toMatch(/^_doc\/im-outbox\/[a-z0-9-]+-q3 report\.pdf$/)
    expect(writes).toEqual([2, 1])
    expect(outboxCopies()).toEqual([ref])
  })

  it('a type or a declared size refused before anything is copied', async () => {
    meta = { name: 'tool.exe', size: 3 }
    expect(await pickAppFile(LIMITS)).toBe('type')
    meta = { name: 'big.zip', size: 20 * MB + 1 }
    expect(await pickAppFile(LIMITS)).toBe('size')
    expect(opened).not.toHaveBeenCalled()
    expect(outboxCopies()).toEqual([])
  })

  it('no display name: the URI names it; no declared size: over the limit while copying → deleted', async () => {
    meta = { name: null, size: null }
    reads = [700_000, 700_000]
    const out = await pickAppFile({ ...LIMITS, fileMaxMb: 1 })
    expect(out).toBe('size')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatch(/fallback\.pdf$/)
    expect(outboxCopies()).toEqual([])
  })

  it('a read failing halfway through the copy deletes the partial copy and keeps nothing', async () => {
    let calls = 0
    reads = []
    const failing = vi.fn(() => {
      if (++calls > 1) throw new Error('revoked')
      return 2
    })
    resolver.openInputStream = () => {
      opened()
      return { read: failing, close() {} }
    }
    try {
      expect(await pickAppFile(LIMITS)).toBe('type')
    } finally {
      resolver.openInputStream = () => {
        opened()
        return { read: () => reads.shift() ?? -1, close() {} }
      }
    }
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatch(/q3 report\.pdf$/)
    expect(outboxCopies()).toEqual([])
  })

  it('cancelled: nothing opened, nothing kept', async () => {
    cancel = true
    expect(await pickAppFile(LIMITS)).toBeNull()
    expect(opened).not.toHaveBeenCalled()
  })
})

describe('App image from the system picker', () => {
  it('its temporary file is copied into the outbox folder and remembered', async () => {
    const copied: { dir: string; name: string }[] = []
    const entry = (path: string) => ({
      path,
      getDirectory: (sub: string, _flag: unknown, ok: (d: unknown) => void) => ok(entry(path + sub)),
      copyTo: (dir: { path: string }, name: string, ok: () => void) => {
        copied.push({ dir: dir.path, name })
        ok()
      },
    })
    vi.stubGlobal('plus', {
      io: {
        resolveLocalFileSystemURL: (url: string, ok: (e: unknown) => void) => ok(entry(url)),
      },
    })
    const path = await copyIntoOutbox('_doc/uniapp_temp/compressed/a1.jpg', 'a1.jpg')
    expect(path).toMatch(/^_doc\/im-outbox\/[a-z0-9-]+-a1\.jpg$/)
    expect(copied).toEqual([{ dir: '_doc/im-outbox', name: path.slice('_doc/im-outbox/'.length) }])
    expect(outboxCopies()).toEqual([path])
  })
})
