// Pure helpers of ExcelService (Excel row; see docs/design-notes.md#security): formula-injection escaping, time zone formatting
// and the zip checks an import runs before exceljs reads the file.

/**
 * A cell text Excel (or a CSV consumer) could run as a formula starts with one of these; quotes before
 * one are escaped too, so `unescapeFormula` can tell a text's own leading quote from the escape.
 */
const FORMULA_START = /^'*[=+\-@\t\r]/
const ESCAPED = /^'+[=+\-@\t\r]/

/** `=1+1` → `'=1+1`: exported text never starts like a formula (see docs/design-notes.md#security). */
export const escapeFormula = (text: string): string =>
  FORMULA_START.test(text) ? `'${text}` : text

/** `'=1+1` → `=1+1`: an imported cell loses the escape's quote, so export → import round-trips. */
export const unescapeFormula = (text: string): string => (ESCAPED.test(text) ? text.slice(1) : text)

const zoned = new Map<string, Intl.DateTimeFormat>()

/** `YYYY-MM-DD HH:mm:ss` of `date` in the IANA zone `tz` (zone checked by the caller). */
export function formatInZone(date: Date, tz: string): string {
  let fmt = zoned.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    zoned.set(tz, fmt)
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

export interface ZipEntry {
  name: string
  /** declared uncompressed size; 0xFFFFFFFF = zip64 (too big for an import anyway) */
  size: number
  /** offset of the entry's local header */
  offset: number
}

/**
 * The entries of a zip's central directory, or null when `buf` is not a zip. An .xlsx is a zip: its
 * part names show macros (`xl/vbaProject.bin`) and external links (`xl/externalLinks/…`), and the
 * declared sizes bound what unzipping may allocate. `base` > 0: `buf` is only the zip's tail from that
 * offset on (a streamed file's last bytes), which must hold the whole central directory.
 */
export const zipEntries = (buf: Buffer, base = 0): ZipEntry[] | null =>
  centralDirectory(buf, base)?.entries ?? null

function centralDirectory(buf: Buffer, base = 0): { entries: ZipEntry[]; start: number } | null {
  if (buf.length < 22 || (base === 0 && buf.readUInt32LE(0) !== 0x04034b50)) return null
  // end of central directory: 22 bytes + a comment of up to 64 KiB at the very end
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  const start = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  if (start < base) return null
  for (let i = 0, at = start - base; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null
    const nameLen = buf.readUInt16LE(at + 28)
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLen),
      size: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42),
    })
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }
  return { entries, start }
}

const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/

/**
 * The parts of zip `buf` (checked by `checkZip`) in stream order, worksheets after every other part.
 * exceljs's streaming reader needs the shared strings and workbook rels before a sheet, else it spills
 * the whole sheet to a temp file first (Excel writes sharedStrings.xml after the sheets); this way a
 * sheet is parsed as it inflates and reading can stop at the first row over the limit.
 */
export function worksheetsLast(buf: Buffer): Buffer[] {
  const dir = centralDirectory(buf)
  if (!dir) return [buf]
  const starts = [...dir.entries.map((e) => e.offset), dir.start].sort((a, b) => a - b)
  const part = (e: ZipEntry) =>
    buf.subarray(
      e.offset,
      starts.find((s) => s > e.offset),
    )
  const sheet = (e: ZipEntry) => WORKSHEET_PART.test(e.name)
  return [
    ...dir.entries.filter((e) => !sheet(e)).map(part),
    ...dir.entries.filter(sheet).map(part),
    buf.subarray(dir.start),
  ]
}

/** Parts that make a workbook unsafe to accept: VBA macros, external workbook links, embedded objects. */
const UNSAFE_PART = /(^|\/)vbaProject\.bin$|^xl\/externalLinks\/|^xl\/embeddings\//i

export type ZipVerdict = 'ok' | 'invalid' | 'unsafe'

/**
 * `invalid` = not a zip or declares more than `maxUnpacked` bytes in total (zip bomb); `unsafe` = macros,
 * external links or embedded objects.
 * Trusts the declared sizes; a zip lying about them still stops at the row limit (rows are
 * read as the sheet inflates), but not a single giant cell or shared-strings part: add a byte-counting
 * inflate if imports ever take untrusted multi-GB bombs seriously.
 */
export function checkZip(buf: Buffer, maxUnpacked: number): ZipVerdict {
  const entries = zipEntries(buf)
  if (!entries) return 'invalid'
  if (entries.some((e) => UNSAFE_PART.test(e.name))) return 'unsafe'
  const total = entries.reduce((sum, e) => sum + e.size, 0)
  return total > maxUnpacked ? 'invalid' : 'ok'
}
