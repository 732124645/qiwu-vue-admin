import { randomUUID } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { Inject, Injectable, NotFoundException, StreamableFile } from '@nestjs/common'
import {
  DEFAULT_EXCEL_IMPORT_LIMITS,
  Err,
  excelImportParams,
  fieldDomainOf,
  fieldLabelKeys,
  type ImportResult,
  LOCALES,
  validationMessage,
} from '@qiwu/shared'
import ExcelJS from 'exceljs'
import { I18nService } from 'nestjs-i18n'
import type { z } from 'zod'
import { clsGet } from '../context/cls.js'
import { BizError } from '../http/biz-error.js'
import { classify } from '../http/http-error.filter.js'
import { ValidationException } from '../http/validation.pipe.js'
import { currentLocale, currentTimezone } from '../i18n/locale.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { DictService } from '../settings/dict.service.js'
import { ParamService } from '../settings/param.service.js'
import { checkZip, escapeFormula, formatInZone, unescapeFormula, worksheetsLast } from './excel.js'

/**
 * One column of an export, import template or import ("Excel 字典转换、@InDict"): modules
 * declare them once, next to their schema, as a module-level constant.
 */
export interface ExcelColumn {
  /** row property (export) / DTO field the cell parses into (import) */
  prop: string
  /** header: i18n key, e.g. `field.iam.position.code` */
  label: string
  /** export only: `label` is the header text itself (a form field's title, formula-escaped) */
  literal?: boolean
  /** default `string`; `datetime` is written as `YYYY-MM-DD HH:mm:ss` in the request's time zone */
  type?: 'string' | 'number' | 'boolean' | 'datetime'
  /**
   * dict code: export writes the entry label, the template offers the labels as a dropdown, import
   * takes a label (any language) or a value; anything else fails the row (`@InDict`)
   */
  dict?: string
  /** export: a `seed.*` value (seeded display names; see docs/design-notes.md#i18n) is written as its text */
  seedName?: boolean
  /**
   * picker column (e.g. a dept id): the template's dropdown lists `<value> - <label>` from the `lists`
   * the caller passes, import takes the value before ` - `
   */
  pick?: boolean
  /** leave out of the export (`import`) or of the template and import (`export`); default both */
  only?: 'export' | 'import'
  /** characters; default 18 */
  width?: number
}

export interface ExcelOption {
  value: string | number
  label: string
}

/** One parsed data row: its sheet line (header = 1), the cell texts, the schema output. */
export interface ImportRow<T> {
  line: number
  cells: Record<string, string>
  value: T
}

export interface ImportFailure {
  line: number
  cells: Record<string, string>
  messages: string[]
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const REPORT_TTL_SEC = 1800
/** hidden sheet with the template's dropdown lists */
const LISTS = 'lists'

const file = (name: string, body: Readable | Buffer) => {
  const opts = {
    type: XLSX_TYPE,
    disposition: `attachment; filename="${encodeURIComponent(name)}.xlsx"`,
  }
  return body instanceof Readable ? new StreamableFile(body, opts) : new StreamableFile(body, opts)
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v !== 'object') return String(v).trim()
  if ('richText' in v)
    return v.richText
      .map((r) => r.text)
      .join('')
      .trim()
  if ('formula' in v || 'sharedFormula' in v) return cellText(v.result as ExcelJS.CellValue)
  if ('text' in v) return String(v.text).trim()
  return ''
}

async function* oneBatch(rows: object[]): AsyncGenerator<object[]> {
  yield rows
}

/**
 * Rows of the workbook's first sheet (workbook order) as exceljs's streaming reader parses them; no
 * sheet → 400 `excel.invalid`. Worksheet parts are streamed last (`worksheetsLast`), so the shared
 * strings are known when rows arrive and nothing spills to disk; styles are kept for date cells.
 * Leaving the loop early stops inflating the file.
 */
async function* firstSheetRows(buf: Buffer): AsyncGenerator<ExcelJS.Row> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(
    Readable.from(worksheetsLast(buf), { objectMode: false }),
    { styles: 'cache' },
  )
  // a sheet arriving before these would be spilled to a temp file; the parts, when present, come
  // first and replace them (our own exports have no shared strings part)
  Object.assign(reader, { sharedStrings: [], workbookRels: [] })
  // exceljs keeps the parsed workbook.xml here; not in its types
  const first = () => (reader as unknown as SheetsModel).model?.sheets?.[0]?.name
  for await (const ws of reader) {
    const name = first()
    if (name !== undefined && (ws as unknown as { name?: string }).name !== name) continue
    yield* ws
    return
  }
  throw new BizError(Err.EXCEL_INVALID)
}

interface SheetsModel {
  model?: { sheets?: { name: string }[] }
}

interface DataValidations {
  add(range: string, validation: ExcelJS.DataValidation): void
}

const importable = (c: ExcelColumn) => c.only !== 'export'
const exportable = (c: ExcelColumn) => c.only !== 'import'

/**
 * Excel export, import template and import (see docs/design-notes.md#i18n, #security), in the request's language and time zone:
 * headers are translated `label` keys, dict columns labels, `datetime` in `X-Timezone` →
 * `core.default_timezone`. Exported text never starts like a formula (`'` prefix, dropped again on import). Imports refuse
 * files over the size/row/column params, macros and external links, check each row with the module's
 * zod schema, and keep the failed rows as a downloadable report (`GET /api/excel/reports/:id`).
 */
@Injectable()
export class ExcelService {
  constructor(
    private readonly i18n: I18nService,
    private readonly dicts: DictService,
    private readonly params: ParamService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * `rows` as `<name>.xlsx`, streamed to the response (a worksheet writer, row by row): batches as they
   * come (`BaseCrudService.exportRows`), or one array. The first batch is read before the response
   * starts, so its errors are still the request's.
   * The output buffers when the client reads slower than rows arrive; await the stream's
   * drain per batch if exports get huge.
   */
  async export(
    name: string,
    columns: ExcelColumn[],
    rows: AsyncIterable<object[]> | object[],
  ): Promise<StreamableFile> {
    const batches = (Array.isArray(rows) ? oneBatch(rows) : rows)[Symbol.asyncIterator]()
    const first = await batches.next()
    const cols = columns.filter(exportable)
    const render = await this.renderer(cols)
    const out = new PassThrough()
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true })
    const ws = wb.addWorksheet(name)
    ws.columns = cols.map((c) => ({ width: c.width ?? 18 }))
    // a literal header is user text (a form field's title): escaped like the cells
    this.header(
      ws.addRow(cols.map((c) => (c.literal ? escapeFormula(c.label) : this.t(c.label)))),
    ).commit()
    // after the response starts, a failure can only abort it
    void (async () => {
      for (let b = first; !b.done; b = await batches.next())
        for (const row of b.value) ws.addRow(render(row)).commit()
      ws.commit()
      await wb.commit()
    })().catch((e: unknown) => out.destroy(e as Error))
    return file(name, out)
  }

  /**
   * The import template `<name>.xlsx`: the importable columns' headers, dropdowns for dict columns
   * (labels) and `pick` columns (`<value> - <label>` from `lists[prop]`) on every data row the limits allow.
   */
  async template(
    name: string,
    columns: ExcelColumn[],
    lists: Record<string, ExcelOption[]> = {},
  ): Promise<StreamableFile> {
    const cols = columns.filter(importable)
    const { maxRows } = await this.limits()
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet(name)
    ws.columns = cols.map((c) => ({ width: c.width ?? 18 }))
    this.header(ws.addRow(cols.map((c) => this.t(c.label))))
    const hidden = wb.addWorksheet(LISTS, { state: 'veryHidden' })
    let listNo = 0
    for (const [i, c] of cols.entries()) {
      const items = c.dict
        ? (await this.dictLabels(c.dict)).map(([, label]) => label)
        : c.pick
          ? (lists[c.prop] ?? []).map((o) => `${o.value} - ${o.label}`)
          : []
      if (!items.length) continue
      const col = hidden.getColumn(++listNo)
      items.forEach((item, r) => (hidden.getCell(r + 1, col.number).value = item))
      const letter = ws.getColumn(i + 1).letter
      // a range in one rule (not one per cell); exceljs has it at runtime but not in its types
      const validations = (ws as unknown as { dataValidations: DataValidations }).dataValidations
      validations.add(`${letter}2:${letter}${maxRows + 1}`, {
        type: 'list',
        allowBlank: true,
        formulae: [`${LISTS}!$${col.letter}$1:$${col.letter}$${items.length}`],
      })
    }
    return file(name, Buffer.from(await wb.xlsx.writeBuffer()))
  }

  /**
   * Parses an uploaded .xlsx (first sheet; headers matched by their text in any language) into rows
   * checked by `schema`. File-level problems throw: size → 413, not an xlsx → 400 `excel.invalid`,
   * macros/external links → 400 `excel.unsafe`, rows/columns over the params → 413, no known header →
   * 400 `excel.no_columns`. Row problems (schema, dict values) become `failures`. The sheet is read as
   * it inflates (exceljs streaming reader) and reading stops at the first row over a limit, so a small
   * but highly compressible file never gets modelled whole.
   */
  async read<T>(
    buf: Buffer,
    columns: ExcelColumn[],
    schema: z.ZodType<T>,
  ): Promise<{ rows: ImportRow<T>[]; failures: ImportFailure[] }> {
    const { maxMb, maxRows, maxColumns } = await this.limits()
    const max = maxMb * 1024 * 1024
    if (buf.length > max) throw new BizError(Err.PAYLOAD_TOO_LARGE)
    const zip = checkZip(buf, max * 20)
    if (zip === 'unsafe') throw new BizError(Err.EXCEL_UNSAFE)
    if (zip === 'invalid') throw new BizError(Err.EXCEL_INVALID)

    const byHeader = new Map<string, ExcelColumn>()
    for (const c of columns.filter(importable))
      for (const text of [c.prop, ...LOCALES.map((lang) => this.t(c.label, lang))])
        byHeader.set(text.toLowerCase(), c)
    // per dict: lower-cased label (any language) or value → value, and the labels to list in errors;
    // loaded up front, so the catch below only ever sees the file's problems
    const dicts = new Map<string, { input: Map<string, string>; labels: string }>()
    for (const c of columns.filter(importable))
      if (c.dict && !dicts.has(c.dict))
        dicts.set(c.dict, {
          input: await this.dictInput(c.dict),
          labels: (await this.dictLabels(c.dict)).map(([, label]) => label).join(', '),
        })
    const domain = fieldDomainOf(schema)
    const rows: ImportRow<T>[] = []
    const failures: ImportFailure[] = []
    let at: [number, ExcelColumn][] | undefined
    let valued = 0
    try {
      for await (const row of firstSheetRows(buf)) {
        if (!row.hasValues) continue
        if (row.cellCount > maxColumns)
          throw new BizError(Err.EXCEL_TOO_MANY_COLUMNS, { max: maxColumns })
        // the header plus maxRows data rows
        if (++valued > maxRows + 1) throw new BizError(Err.EXCEL_TOO_MANY_ROWS, { max: maxRows })
        if (!at) {
          at = []
          // the header is line 1; a sheet starting lower has none
          if (row.number === 1)
            row.eachCell((cell, n) => {
              const c = byHeader.get(cellText(cell.value).toLowerCase())
              if (c) at!.push([n, c])
            })
          if (!at.length) throw new BizError(Err.EXCEL_NO_COLUMNS)
          continue
        }
        const cells: Record<string, string> = {}
        const input: Record<string, unknown> = {}
        const messages: string[] = []
        for (const [n, c] of at) {
          const text = unescapeFormula(cellText(row.getCell(n).value))
          cells[c.prop] = text
          if (text === '') continue
          let v: string | undefined = c.pick ? text.split(' - ')[0]!.trim() : text
          if (c.dict) {
            const dict = dicts.get(c.dict)!
            v = dict.input.get(v.toLowerCase())
            if (v === undefined) {
              messages.push(
                this.t('validation.invalid_value', undefined, {
                  field: this.t(c.label),
                  values: dict.labels,
                }),
              )
              continue
            }
          }
          input[c.prop] = this.typed(v, c.type)
        }
        if (!Object.values(cells).some(Boolean)) continue // blank line
        const parsed = schema.safeParse(input)
        if (parsed.success && !messages.length)
          rows.push({ line: row.number, cells, value: parsed.data })
        else
          failures.push({
            line: row.number,
            cells,
            messages: [
              ...messages,
              ...(parsed.success ? [] : this.issues(parsed.error.issues, domain, at)),
            ],
          })
      }
    } catch (e) {
      if (e instanceof BizError) throw e
      throw new BizError(Err.EXCEL_INVALID)
    }
    if (!at) throw new BizError(Err.EXCEL_NO_COLUMNS)
    return { rows, failures }
  }

  /**
   * The failure of `row` for an error the module's write threw (duplicate key, out of scope, a business
   * rule …): its translated message. Server errors (5xx) are rethrown: they are not the row's fault.
   */
  failure(row: ImportRow<unknown>, e: unknown): ImportFailure {
    const { err, status, params } = classify(e)
    if (status >= 500) throw e
    const messages =
      e instanceof ValidationException
        ? this.issues(e.issues, e.domain, [])
        : [this.t(err.key, undefined, params)]
    return { line: row.line, cells: row.cells, messages }
  }

  /**
   * The import's result; with failures also their report (the failed rows as imported + line + errors),
   * kept 30 min for the caller only.
   */
  async result(
    counts: { inserted: number; updated: number },
    failures: ImportFailure[],
    columns: ExcelColumn[],
  ): Promise<ImportResult> {
    const result: ImportResult = { ...counts, failed: failures.length }
    if (!failures.length) return result
    const cols = columns.filter(importable)
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('report')
    ws.columns = [{ width: 8 }, ...cols.map((c) => ({ width: c.width ?? 18 })), { width: 60 }]
    this.header(
      ws.addRow([
        this.t('excel.report.line'),
        ...cols.map((c) => this.t(c.label)),
        this.t('excel.report.errors'),
      ]),
    )
    for (const f of [...failures].sort((a, b) => a.line - b.line))
      ws.addRow(
        [f.line, ...cols.map((c) => f.cells[c.prop] || null), f.messages.join('; ')].map((v) =>
          typeof v === 'string' ? escapeFormula(v) : v,
        ),
      )
    const id = randomUUID()
    await this.redis.set(
      redisKey('excelReport', this.me(), id),
      Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'),
      { expiration: { type: 'EX', value: REPORT_TTL_SEC } },
    )
    return { ...result, reportId: id }
  }

  /** The caller's report `id` as a download; someone else's or an expired one → 404. */
  async report(id: string): Promise<StreamableFile> {
    const data = await this.redis.get(redisKey('excelReport', this.me(), id))
    if (!data) throw new NotFoundException()
    return file('import-errors', Buffer.from(data, 'base64'))
  }

  /** Time zone of server-rendered times (see docs/design-notes.md#api-envelope): `X-Timezone` → `core.default_timezone` → Asia/Shanghai. */
  async timezone(): Promise<string> {
    return currentTimezone(this.params)
  }

  /** Row object → cell values of `cols`. */
  private async renderer(cols: ExcelColumn[]) {
    const tz = await this.timezone()
    const dicts = new Map<string, Map<string, string>>()
    for (const c of cols) if (c.dict) dicts.set(c.dict, new Map(await this.dictLabels(c.dict)))
    return (row: object) =>
      cols.map((c): ExcelJS.CellValue => {
        const v: unknown = (row as Record<string, unknown>)[c.prop]
        if (v === null || v === undefined || v === '') return null
        if (c.dict) return escapeFormula(dicts.get(c.dict)!.get(String(v)) ?? String(v))
        if (c.type === 'datetime')
          return formatInZone(v instanceof Date ? v : new Date(String(v)), tz)
        if (typeof v === 'number' || typeof v === 'boolean') return v
        const text = String(v)
        return escapeFormula(c.seedName && text.startsWith('seed.') ? this.t(text) : text)
      })
  }

  /** [value, label in the request language] of a dict's enabled entries. */
  private async dictLabels(code: string): Promise<[string, string][]> {
    const lang = currentLocale()
    return ((await this.dicts.entries(code))?.entries ?? []).map((e) => [
      e.value,
      e.labelI18n?.[lang] ?? e.label ?? e.value,
    ])
  }

  /** lower-cased label (any language) or value → value */
  private async dictInput(code: string): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    for (const e of (await this.dicts.entries(code))?.entries ?? [])
      for (const text of [e.value, e.label, ...Object.values(e.labelI18n ?? {})])
        if (text) map.set(text.toLowerCase(), e.value)
    return map
  }

  private typed(v: string, type: ExcelColumn['type']): unknown {
    if (type === 'number') return Number.isFinite(Number(v)) ? Number(v) : v
    if (type === 'boolean') return v === 'true' ? true : v === 'false' ? false : v
    return v
  }

  /** zod issues → messages like the error filter's, a column's header as the field name. */
  private issues(
    issues: readonly z.core.$ZodIssue[],
    domain: string | undefined,
    at: [number, ExcelColumn][],
  ): string[] {
    return issues.map((issue) => {
      const { key, params } = validationMessage(issue)
      const col = at.find(([, c]) => c.prop === issue.path[0])?.[1]
      const label = col
        ? col.label
        : fieldLabelKeys(domain, issue.path).find((k) => this.t(k) !== k)
      return this.t(key, undefined, {
        ...params,
        field: label ? this.t(label) : issue.path.join('.'),
      })
    })
  }

  private header(row: ExcelJS.Row): ExcelJS.Row {
    row.font = { bold: true }
    return row
  }

  private t(key: string, lang: string = currentLocale(), args?: Record<string, unknown>): string {
    return String(this.i18n.translate(key, { lang, args }))
  }

  private me(): number {
    const userId = clsGet('principal')?.userId
    if (userId === undefined) throw new NotFoundException()
    return userId
  }

  private async limits() {
    const d = DEFAULT_EXCEL_IMPORT_LIMITS
    return {
      maxMb: await this.params.int(excelImportParams.maxMb, 1, 100, d.maxMb),
      maxRows: await this.params.int(excelImportParams.maxRows, 1, 100_000, d.maxRows),
      maxColumns: await this.params.int(excelImportParams.maxColumns, 1, 1000, d.maxColumns),
    }
  }
}
