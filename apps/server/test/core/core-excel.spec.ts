// core/excel (see docs/design-notes.md#i18n, #security): export (i18n headers, dict labels, seeded names, formula escaping,
// time zone), import template (dropdowns), import (headers in any language, dict values, zod per row,
// limits, macros/external links) and the error report. Real translations (CoreI18nModule), fake
// dict/param/Redis: no database needed.
import fs from 'node:fs'
import { crc32, deflateRawSync } from 'node:zlib'
import type { StreamableFile } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Err, excelImportParams, positionCreate } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import { ClsService } from 'nestjs-cls'
import type { Principal } from '../../src/core/auth/principal.js'
import { clsGet } from '../../src/core/context/cls.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import {
  checkZip,
  escapeFormula,
  formatInZone,
  unescapeFormula,
  zipEntries,
} from '../../src/core/excel/excel.js'
import {
  type ExcelColumn,
  ExcelService,
  type ImportFailure,
} from '../../src/core/excel/excel.service.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { CoreI18nModule } from '../../src/core/i18n/i18n.module.js'
import { REDIS } from '../../src/core/redis/redis.module.js'
import { DictService } from '../../src/core/settings/dict.service.js'
import { ParamService } from '../../src/core/settings/param.service.js'

const params = new Map<string, string>()
const store = new Map<string, string>()
const entry = (value: string, zh: string, en: string) => ({
  value,
  label: zh,
  labelI18n: { 'zh-CN': zh, 'en-US': en },
  tagType: null,
  cssClass: null,
  isDefault: false,
  sortNo: 0,
})
const fakeDict = {
  entries: async (code: string) =>
    code === 'core.enabled'
      ? {
          version: 0,
          entries: [entry('true', '启用', 'Enabled'), entry('false', '停用', 'Disabled')],
        }
      : null,
}
// the real int() parsing over a fake get()
const fakeParams = Object.assign(Object.create(ParamService.prototype) as ParamService, {
  get: async (key: string) => params.get(key) ?? null,
})
const fakeRedis = {
  get: async (key: string) => store.get(key) ?? null,
  set: async (key: string, value: string) => void store.set(key, value),
}

let excel: ExcelService
let cls: ClsService

const principal = (userId: number): Principal => ({
  userId,
  deptId: null,
  deptTreePath: null,
  roles: [],
  perms: [],
})
/** Runs fn in a request context: language, `X-Timezone`, caller. */
const inRequest = <T>(
  fn: () => Promise<T>,
  {
    locale = 'zh-CN',
    timezone,
    userId = 1,
  }: { locale?: string; timezone?: string; userId?: number } = {},
) =>
  cls.run(() => {
    cls.set('locale', locale)
    cls.set('timezone', timezone)
    cls.set('principal', principal(userId))
    return fn()
  })

async function sheetOf(file: StreamableFile) {
  const chunks: Buffer[] = []
  for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Uint8Array))
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as Parameters<typeof wb.xlsx.load>[0])
  return wb
}
/** Cell values of `row` under the header's columns (empty → null). */
const values = (ws: ExcelJS.Worksheet, row: number) =>
  Array.from(
    { length: ws.getRow(1).cellCount },
    (_, i) => ws.getRow(row).getCell(i + 1).value ?? null,
  )

/** An .xlsx whose first sheet holds `rows` (header first). */
async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('data')
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** A zip of `parts` (deflated) in this order: lets a spec lay out an .xlsx the way Excel does. */
function zipOf(parts: [name: string, text: string][]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of parts) {
    const data = Buffer.from(text)
    const packed = deflateRawSync(data)
    const n = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(8, 8) // deflate
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(n.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(crc32(data), 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(n.length, 28)
    dir.writeUInt32LE(offset, 42)
    local.push(head, n, packed)
    central.push(dir, n)
    offset += 30 + n.length + packed.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(parts.length, 8)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}

const NS = 'http://schemas.openxmlformats.org'
/**
 * An .xlsx in Excel's part order (sheets before the shared strings): sheet `data` (first in workbook
 * order, but after `other` in the zip) = the header 岗位编码 / 岗位名称, then `rows` rows of `c`/`n`
 * (shared strings), then `tail` (raw sheet XML); `other` has an unknown header.
 */
function excelLike(rows: number, tail = ''): Buffer {
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="${NS}/officeDocument/2006/relationships/${type}" Target="${target}"/>`
  const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`
  const sheet = (body: string) =>
    `<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  let data = `<row r="1">${s('A1', 0)}${s('B1', 1)}</row>`
  for (let r = 2; r <= rows + 1; r++) data += `<row r="${r}">${s(`A${r}`, 2)}${s(`B${r}`, 3)}</row>`
  return zipOf([
    [
      '_rels/.rels',
      `<Relationships xmlns="${NS}/package/2006/relationships">${rel('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="data" sheetId="1" r:id="rId1"/><sheet name="other" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="${NS}/package/2006/relationships">${rel('rId1', 'worksheet', 'worksheets/sheet1.xml')}${rel('rId2', 'worksheet', 'worksheets/sheet2.xml')}</Relationships>`,
    ],
    ['xl/worksheets/sheet2.xml', sheet(`<row r="1">${s('A1', 4)}</row>`)],
    ['xl/worksheets/sheet1.xml', sheet(data + tail)],
    [
      'xl/sharedStrings.xml',
      `<sst xmlns="${NS}/spreadsheetml/2006/main">${['岗位编码', '岗位名称', 'c', 'n', 'nothing'].map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
    ],
  ])
}

const columns: ExcelColumn[] = [
  { prop: 'code', label: 'field.iam.position.code' },
  { prop: 'name', label: 'field.iam.position.name', seedName: true },
  { prop: 'sortNo', label: 'field.iam.position.sortNo', type: 'number' },
  { prop: 'enabled', label: 'field.iam.position.enabled', type: 'boolean', dict: 'core.enabled' },
  { prop: 'createdAt', label: 'field.common.createdAt', type: 'datetime', only: 'export' },
]

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [CoreContextModule, CoreI18nModule],
    providers: [
      ExcelService,
      { provide: DictService, useValue: fakeDict },
      { provide: ParamService, useValue: fakeParams },
      { provide: REDIS, useValue: fakeRedis },
    ],
  }).compile()
  excel = moduleRef.get(ExcelService)
  cls = moduleRef.get(ClsService)
})

beforeEach(() => {
  params.clear()
  store.clear()
})

describe('helpers', () => {
  it('escapeFormula prefixes text that starts like a formula', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])
      expect(escapeFormula(s)).toBe(`'${s}`)
    for (const s of ['a=1', '1-2', "'x", '']) expect(escapeFormula(s)).toBe(s)
    // a text's own quote before a formula start is escaped too: unescape is its exact inverse
    expect(escapeFormula("'=1")).toBe("''=1")
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', "'=1", "''@x", "'x", 'a=1', ''])
      expect(unescapeFormula(escapeFormula(s))).toBe(s)
  })

  it('formatInZone renders a UTC instant in the zone (Asia/Shanghai +8h, across midnight)', () => {
    const d = new Date('2026-01-31T20:05:09Z')
    expect(formatInZone(d, 'Asia/Shanghai')).toBe('2026-02-01 04:05:09')
    expect(formatInZone(d, 'UTC')).toBe('2026-01-31 20:05:09')
    expect(formatInZone(new Date('2026-01-01T00:00:00Z'), 'Asia/Shanghai')).toBe(
      '2026-01-01 08:00:00',
    )
  })

  it('zipEntries lists an xlsx; anything else is not a zip', async () => {
    const names = zipEntries(await xlsx([['a']]))!.map((e) => e.name)
    expect(names).toContain('xl/workbook.xml')
    expect(zipEntries(Buffer.from('PK not really a zip'))).toBeNull()
    expect(zipEntries(Buffer.from('plain text, long enough to scan'))).toBeNull()
    expect(checkZip(await xlsx([['a']]), 10)).toBe('invalid') // declares more than 10 bytes unpacked
  })
})

describe('export', () => {
  const rows = [
    {
      code: '=HYPERLINK("http://x")',
      name: 'seed.position.engLead',
      sortNo: -3,
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    { code: '@cmd', name: '+plain', sortNo: 2, enabled: false, createdAt: null },
  ]

  it('headers and dict labels in the request language, seeded names as text, formulas escaped, times +8h', async () => {
    const wb = await sheetOf(await inRequest(() => excel.export('positions', columns, rows)))
    const ws = wb.worksheets[0]!
    expect(ws.name).toBe('positions')
    expect(values(ws, 1)).toEqual(['岗位编码', '岗位名称', '排序号', '启用状态', '创建时间'])
    // no X-Timezone and no param → Asia/Shanghai: 00:00 UTC is 08:00
    expect(values(ws, 2)).toEqual([
      `'=HYPERLINK("http://x")`,
      '技术负责人',
      -3,
      '启用',
      '2026-01-01 08:00:00',
    ])
    expect(values(ws, 3)).toEqual(["'@cmd", "'+plain", 2, '停用', null])
    expect(ws.actualRowCount).toBe(3)
  })

  it("batches (exportRows): every batch in order, later ones still in the request's context; the first is read before the response, so its error is the request's", async () => {
    // each batch as a scoped query would see it: the caller from CLS when the batch is read
    async function* batches() {
      for (let b = 0; b < 3; b++) {
        const me = clsGet('principal')?.userId
        yield Array.from({ length: 2 }, (_, i) => ({ code: `b${b}-u${me}-${i}`, name: 'n' }))
      }
    }
    const file = await inRequest(() => excel.export('p', columns, batches()), { userId: 7 })
    const ws = (await sheetOf(file)).worksheets[0]!
    expect(Array.from({ length: 6 }, (_, i) => values(ws, i + 2)[0])).toEqual(
      [0, 1, 2].flatMap((b) => [`b${b}-u7-0`, `b${b}-u7-1`]),
    )
    // oxlint-disable-next-line require-yield -- fails before its first batch
    async function* failing(): AsyncGenerator<object[]> {
      throw new Error('db down')
    }
    await expect(inRequest(() => excel.export('p', columns, failing()))).rejects.toThrow('db down')
  })

  it('en-US + X-Timezone: English headers/labels, the request zone wins over core.default_timezone', async () => {
    params.set('core.default_timezone', 'Asia/Tokyo')
    const ws = (
      await sheetOf(
        await inRequest(() => excel.export('positions', columns, rows), {
          locale: 'en-US',
          timezone: 'America/New_York',
        }),
      )
    ).worksheets[0]!
    expect(values(ws, 1)).toEqual([
      'Position code',
      'Position name',
      'Sort order',
      'Enabled',
      'Created at',
    ])
    expect(values(ws, 2).slice(1)).toEqual([
      'Engineering lead',
      -3,
      'Enabled',
      '2025-12-31 19:00:00',
    ])
    // without the header the param applies
    const byParam = (await sheetOf(await inRequest(() => excel.export('p', columns, rows))))
      .worksheets[0]!
    expect(values(byParam, 2)[4]).toBe('2026-01-01 09:00:00')
  })
})

describe('template', () => {
  it('importable columns only, dict and picker dropdowns from a hidden sheet', async () => {
    const cols: ExcelColumn[] = [
      ...columns,
      { prop: 'deptId', label: 'field.iam.user.deptId', type: 'number', pick: true },
    ]
    const lists = {
      deptId: [
        { value: 1, label: 'HQ' },
        { value: 5, label: 'HQ / R&D' },
      ],
    }
    params.set(excelImportParams.maxRows, '50')
    const wb = await sheetOf(await inRequest(() => excel.template('positions', cols, lists)))
    const [ws, hidden] = wb.worksheets
    expect(values(ws!, 1)).toEqual(['岗位编码', '岗位名称', '排序号', '启用状态', '所属部门'])
    expect(hidden!.state).toBe('veryHidden')
    expect(hidden!.getColumn(1).values.slice(1)).toEqual(['启用', '停用'])
    expect(hidden!.getColumn(2).values.slice(1)).toEqual(['1 - HQ', '5 - HQ / R&D'])
    expect(ws!.getCell('D2').dataValidation).toMatchObject({
      type: 'list',
      formulae: ['lists!$A$1:$A$2'],
    })
    expect(ws!.getCell('E51').dataValidation).toMatchObject({ formulae: ['lists!$B$1:$B$2'] })
    expect(ws!.getCell('E52').dataValidation).toBeUndefined() // maxRows data rows only
    expect(ws!.getCell('A2').dataValidation).toBeUndefined()
  })
})

describe('import', () => {
  const read = (buf: Buffer, cols = columns) =>
    inRequest(() => excel.read(buf, cols, positionCreate))

  it('parses rows by header text (any language), dict labels/values, numbers; failures carry messages', async () => {
    const buf = await xlsx([
      ['Position code', '岗位名称', '排序号', '启用状态', 'ignored column'],
      ['c1', 'Name 1', 3, '停用', 'x'],
      ['c2', 'Name 2', null, 'Enabled', null],
      [],
      ['c3', 'Name 3', 'abc', 'maybe', null],
      ['', 'Name 4', 1, 'true', null],
    ])
    const { rows, failures } = await read(buf)
    expect(rows).toEqual([
      {
        line: 2,
        cells: { code: 'c1', name: 'Name 1', sortNo: '3', enabled: '停用' },
        value: { code: 'c1', name: 'Name 1', sortNo: 3, enabled: false },
      },
      {
        line: 3,
        cells: { code: 'c2', name: 'Name 2', sortNo: '', enabled: 'Enabled' },
        value: { code: 'c2', name: 'Name 2', enabled: true },
      },
    ])
    expect(failures).toEqual([
      {
        line: 5,
        cells: { code: 'c3', name: 'Name 3', sortNo: 'abc', enabled: 'maybe' },
        messages: ['启用状态只能是：启用, 停用', '排序号的类型不正确'],
      },
      {
        line: 6,
        cells: { code: '', name: 'Name 4', sortNo: '1', enabled: 'true' },
        messages: ['岗位编码不能为空'],
      },
    ])
  })

  it('picker columns take the value before " - "', async () => {
    const cols: ExcelColumn[] = [
      { prop: 'code', label: 'field.iam.position.code' },
      { prop: 'sortNo', label: 'field.iam.position.sortNo', type: 'number', pick: true },
    ]
    const parsed = await inRequest(async () =>
      excel.read(
        await xlsx([
          ['岗位编码', '排序号'],
          ['a', '12 - HQ / R&D'],
        ]),
        cols,
        positionCreate.pick({ code: true, sortNo: true }),
      ),
    )
    expect(parsed.rows.map((r) => r.value)).toEqual([{ code: 'a', sortNo: 12 }])
  })

  it('file limits and safety: size, rows, columns, not an xlsx, macros, external links, unknown headers', async () => {
    const reject = async (buf: Buffer, err: object) => {
      const e = await read(buf).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).err).toBe(err)
      return e as BizError
    }
    const ok = await xlsx([['岗位编码'], ['a'], ['b'], ['c']])
    params.set(excelImportParams.maxRows, '2')
    expect((await reject(ok, Err.EXCEL_TOO_MANY_ROWS)).params).toEqual({ max: 2 })
    params.set(excelImportParams.maxRows, '3')
    const within = await read(ok) // name missing: 3 failed rows, but read
    expect(within.rows.length + within.failures.length).toBe(3)
    params.set(excelImportParams.maxColumns, '2')
    await reject(await xlsx([['a', 'b', 'c']]), Err.EXCEL_TOO_MANY_COLUMNS)
    params.clear()
    params.set(excelImportParams.maxMb, '1')
    await reject(Buffer.concat([ok, Buffer.alloc(1024 * 1024)]), Err.PAYLOAD_TOO_LARGE)
    params.clear()
    await reject(Buffer.from('code,name\n1,2\n'), Err.EXCEL_INVALID)
    // same-length renames keep the zip valid: a macro part, an external link part
    const renamed = (from: string, to: string) =>
      Buffer.from(ok.toString('latin1').replaceAll(from, to), 'latin1')
    await reject(renamed('docProps/core.xml', 'xl/vbaProject.bin'), Err.EXCEL_UNSAFE)
    await reject(renamed('xl/theme/theme1.xml', 'xl/externalLinks/a1'), Err.EXCEL_UNSAFE)
    await reject(await xlsx([['nothing'], ['a']]), Err.EXCEL_NO_COLUMNS)
  })

  it("reads Excel's part order (shared strings after the sheets) and its own exports, never through a temp file", async () => {
    const spill = vi.spyOn(fs, 'createWriteStream')
    try {
      const { rows, failures } = await read(excelLike(3))
      expect(failures).toEqual([])
      // the first sheet in workbook order, though `other` comes first in the zip
      expect(rows.map((r) => [r.line, r.value])).toEqual(
        [2, 3, 4].map((line) => [line, { code: 'c', name: 'n' }]),
      )
      // an export (streamed, inline strings, no shared strings part) read back
      const exported = await inRequest(() =>
        excel.export('p', columns, [{ code: 'e1', name: 'E', sortNo: 2, enabled: true }]),
      )
      const chunks: Buffer[] = []
      for await (const c of exported.getStream()) chunks.push(Buffer.from(c as Uint8Array))
      const back = await read(Buffer.concat(chunks))
      expect(back.rows.map((r) => r.value)).toEqual([
        { code: 'e1', name: 'E', sortNo: 2, enabled: true },
      ])
      // formula-like text round-trips: the export's escape quote is dropped again on import
      const formulas = [
        { code: '=1+1', name: '@cmd', sortNo: 1, enabled: true },
        { code: '-x', name: "'+y", sortNo: 2, enabled: false },
      ]
      const again = await inRequest(() => excel.export('p', columns, formulas))
      const parts: Buffer[] = []
      for await (const c of again.getStream()) parts.push(Buffer.from(c as Uint8Array))
      expect((await read(Buffer.concat(parts))).rows.map((r) => r.value)).toEqual(formulas)
      expect(spill).not.toHaveBeenCalled()
    } finally {
      spill.mockRestore()
    }
  })

  it('stops at the first row over the limit: rows after it are never parsed (a compressible bomb)', async () => {
    params.set(excelImportParams.maxRows, '3')
    // 50 000 rows (~3 MB of XML, ~400 KB zipped), then XML that fails a whole-file parse
    const bomb = excelLike(50_000, '<row r="60000"><c r="A60000"><<< not xml')
    const e = await read(bomb).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BizError)
    expect((e as BizError).err).toBe(Err.EXCEL_TOO_MANY_ROWS)
    expect((e as BizError).params).toEqual({ max: 3 })
    // within the limit, the broken tail is reached: a parse error is still 400 excel.invalid
    params.set(excelImportParams.maxRows, '100000')
    const invalid = await read(bomb).catch((x: unknown) => x)
    expect((invalid as BizError).err).toBe(Err.EXCEL_INVALID)
  })
})

describe('write failures and the report', () => {
  it('failure(): business errors become the row message; server errors are rethrown', async () => {
    const row = { line: 7, cells: { code: 'x' }, value: {} }
    const f = await inRequest(async () => excel.failure(row, new BizError(Err.DUPLICATE)))
    expect(f).toEqual({ line: 7, cells: { code: 'x' }, messages: ['数据已存在，不能重复'] })
    const boom = new Error('db down')
    await expect(inRequest(async () => excel.failure(row, boom))).rejects.toBe(boom)
  })

  it('result(): no failures → no report; failures → a report only its owner can download', async () => {
    const counts = { inserted: 2, updated: 1 }
    expect(await inRequest(() => excel.result(counts, [], columns))).toEqual({
      ...counts,
      failed: 0,
    })
    const failures: ImportFailure[] = [
      { line: 9, cells: { code: '=bad', name: 'n' }, messages: ['a', 'b'] },
      { line: 4, cells: { code: 'c' }, messages: ['x'] },
    ]
    const res = await inRequest(() => excel.result(counts, failures, columns))
    expect(res).toEqual({ ...counts, failed: 2, reportId: expect.any(String) })
    const ws = (await sheetOf(await inRequest(() => excel.report(res.reportId!)))).worksheets[0]!
    expect(values(ws, 1)).toEqual([
      '行号',
      '岗位编码',
      '岗位名称',
      '排序号',
      '启用状态',
      '错误信息',
    ])
    expect(values(ws, 2)).toEqual([4, 'c', null, null, null, 'x'])
    expect(values(ws, 3)).toEqual([9, "'=bad", 'n', null, null, 'a; b'])
    await expect(inRequest(() => excel.report(res.reportId!), { userId: 2 })).rejects.toThrow(
      'Not Found',
    )
  })
})
