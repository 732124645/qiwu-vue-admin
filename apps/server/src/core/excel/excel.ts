// Pure helpers of ExcelService (Excel row; see docs/design-notes.md#security): formula-injection escaping, time zone formatting
// and the zip checks an import runs before exceljs reads the file.
import { createInflateRaw } from 'node:zlib'

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

/** A central directory record with what an import rebuilds its local header from. */
interface ListedEntry extends ZipEntry {
  rawName: Buffer
  flags: number
  /** 0 = stored, 8 = deflate */
  method: number
  time: number
  date: number
  crc: number
  /** declared compressed size */
  packed: number
}

const ZIP64 = 0xffffffff

/**
 * The entries of a zip's central directory, or null when `buf` is not a zip. An .xlsx is a zip: its
 * part names show macros (`xl/vbaProject.bin`) and external links (`xl/externalLinks/…`), and the
 * declared sizes bound what unzipping may allocate. `base` > 0: `buf` is only the zip's tail from that
 * offset on (a streamed file's last bytes), which must hold the whole central directory.
 */
export const zipEntries = (buf: Buffer, base = 0): ZipEntry[] | null =>
  centralDirectory(buf, base)?.entries ?? null

function centralDirectory(buf: Buffer, base = 0): { entries: ListedEntry[]; start: number } | null {
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
  const entries: ListedEntry[] = []
  if (start < base) return null
  for (let i = 0, at = start - base; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null
    const nameLen = buf.readUInt16LE(at + 28)
    const rawName = buf.subarray(at + 46, at + 46 + nameLen)
    entries.push({
      name: rawName.toString('utf8'),
      size: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42),
      rawName,
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      time: buf.readUInt16LE(at + 12),
      date: buf.readUInt16LE(at + 14),
      crc: buf.readUInt32LE(at + 16),
      packed: buf.readUInt32LE(at + 20),
    })
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }
  return { entries, start }
}

const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/

/**
 * The compressed bytes of listed entry `e`: its local header must be where the directory says, with
 * the listed name; exactly the listed compressed size follows it, before the central directory at `end`.
 * Null for anything else, and for zip64, encrypted entries and methods other than store / deflate.
 */
function listedData(buf: Buffer, e: ListedEntry, end: number): Buffer | null {
  if (e.size === ZIP64 || e.packed === ZIP64 || e.flags & 1) return null
  if (e.method !== 0 && e.method !== 8) return null
  if (e.method === 0 && e.packed !== e.size) return null
  const at = e.offset
  if (at + 30 > end || buf.readUInt32LE(at) !== 0x04034b50) return null
  const nameLen = buf.readUInt16LE(at + 26)
  if (!buf.subarray(at + 30, at + 30 + nameLen).equals(e.rawName)) return null
  const start = at + 30 + nameLen + buf.readUInt16LE(at + 28)
  return start + e.packed <= end ? buf.subarray(start, start + e.packed) : null
}

/** A local header for `e` carrying its listed sizes (so no data descriptor follows it). */
function localHeader(e: ListedEntry): Buffer {
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(e.flags & 0xfff7, 6)
  head.writeUInt16LE(e.method, 8)
  head.writeUInt16LE(e.time, 10)
  head.writeUInt16LE(e.date, 12)
  head.writeUInt32LE(e.crc, 14)
  head.writeUInt32LE(e.packed, 18)
  head.writeUInt32LE(e.size, 22)
  head.writeUInt16LE(e.rawName.length, 26)
  return Buffer.concat([head, e.rawName])
}

/**
 * A central directory over `parts` (each `[entry, offset of its rebuilt local header]`) and its end
 * record: the rebuilt file ends as a zip does, with nothing of the uploaded file after the entries.
 */
function directoryOf(parts: readonly [ListedEntry, number][], start: number): Buffer {
  const records = parts.map(([e, offset]) => {
    const rec = Buffer.alloc(46)
    rec.writeUInt32LE(0x02014b50, 0)
    rec.writeUInt16LE(20, 4)
    rec.writeUInt16LE(20, 6)
    rec.writeUInt16LE(e.flags & 0xfff7, 8)
    rec.writeUInt16LE(e.method, 10)
    rec.writeUInt16LE(e.time, 12)
    rec.writeUInt16LE(e.date, 14)
    rec.writeUInt32LE(e.crc, 16)
    rec.writeUInt32LE(e.packed, 20)
    rec.writeUInt32LE(e.size, 24)
    rec.writeUInt16LE(e.rawName.length, 28)
    rec.writeUInt32LE(offset, 42)
    return Buffer.concat([rec, e.rawName])
  })
  const dir = Buffer.concat(records)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(parts.length, 8)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(start, 16)
  return Buffer.concat([dir, end])
}

/** What raw deflate `data` inflates to, counted and dropped; null past `limit` bytes or when corrupt. */
function inflatedSize(data: Buffer, limit: number): Promise<number | null> {
  return new Promise((resolve) => {
    let n = 0
    const z = createInflateRaw()
    z.on('data', (chunk: Buffer) => {
      n += chunk.length
      if (n > limit) {
        z.destroy()
        resolve(null)
      }
    })
    z.on('error', () => resolve(null))
    z.on('end', () => resolve(n))
    z.end(data)
  })
}

/**
 * Zip `buf` as exceljs's streaming reader gets it for an import: `checkZip` first, then rebuilt from the
 * central directory, so the reader sees only what was checked: each listed entry behind a fresh local
 * header with exactly its listed compressed bytes, then a directory of them (every other byte of the
 * upload, entries it does not list among them, is dropped), and each entry inflated once beforehand,
 * counting: one inflating past its declared size, or all of them past `maxUnpacked`, is `invalid`.
 * Worksheets come after every other part: the reader needs the shared strings and workbook rels before
 * a sheet, else it spills the whole sheet to a temp file first (Excel writes sharedStrings.xml after the
 * sheets); this way a sheet is parsed as it streams and reading can stop at the first row over the limit.
 */
export async function importParts(
  buf: Buffer,
  maxUnpacked: number,
): Promise<Buffer[] | 'invalid' | 'unsafe'> {
  const verdict = checkZip(buf, maxUnpacked)
  const dir = centralDirectory(buf)
  if (verdict !== 'ok' || !dir) return verdict === 'ok' ? 'invalid' : verdict
  const parts: { entry: ListedEntry; bytes: Buffer }[] = []
  let left = maxUnpacked
  for (const e of dir.entries) {
    const data = listedData(buf, e, dir.start)
    if (!data) return 'invalid'
    const real =
      e.method === 0 || !e.packed ? data.length : await inflatedSize(data, Math.min(e.size, left))
    if (real === null || real > e.size) return 'invalid'
    left -= real
    parts.push({ entry: e, bytes: Buffer.concat([localHeader(e), data]) })
  }
  const sheet = (p: (typeof parts)[number]) => WORKSHEET_PART.test(p.entry.name)
  const ordered = [...parts.filter((p) => !sheet(p)), ...parts.filter(sheet)]
  let offset = 0
  const placed = ordered.map((p): [ListedEntry, number] => {
    const at = offset
    offset += p.bytes.length
    return [p.entry, at]
  })
  return [...ordered.map((p) => p.bytes), directoryOf(placed, offset)]
}

/** Parts that make a workbook unsafe to accept: VBA macros, external workbook links, embedded objects. */
const UNSAFE_PART = /(^|\/)vbaProject\.bin$|^xl\/externalLinks\/|^xl\/embeddings\//i

export type ZipVerdict = 'ok' | 'invalid' | 'unsafe'

/**
 * `invalid` = not a zip or declares more than `maxUnpacked` bytes in total (zip bomb); `unsafe` = macros,
 * external links or embedded objects. Trusts the declared sizes: an import reads the file only through
 * `importParts`, which also proves them.
 */
export function checkZip(buf: Buffer, maxUnpacked: number): ZipVerdict {
  const entries = zipEntries(buf)
  if (!entries) return 'invalid'
  if (entries.some((e) => UNSAFE_PART.test(e.name))) return 'unsafe'
  const total = entries.reduce((sum, e) => sum + e.size, 0)
  return total > maxUnpacked ? 'invalid' : 'ok'
}
