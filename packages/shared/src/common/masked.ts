/**
 * Display masking of personal data (`@Desensitize` equivalent; see docs/design-notes.md#security): the server applies it to
 * VO fields a caller may list but not edit (`userVo.mobile` / `email` without `iam.user.modify`), e.g.
 * `mobile: masked.mobile(row.mobile)`, or as a zod `.transform(masked.mobile)`. Masked values are for
 * display only and never parse back into a valid value. `null`/`undefined` pass through; masking keeps
 * separators and always hides at least a third of the characters.
 */

type Masker = {
  (value: string): string
  (value: string | null): string | null
  (value: string | null | undefined): string | null | undefined
}

const STAR = '*'

/** Keeps the first `head` and last `tail` characters matching `keep`; every other matching one → `*`. */
function maskChars(value: string, head: number, tail: number, keep: RegExp): string {
  const total = [...value].filter((c) => keep.test(c)).length
  // at least a third stays hidden: short values show less
  const short = total - head - tail < Math.ceil(total / 3)
  const h = short ? Math.floor(total / 3) : head
  const t = short ? Math.floor(total / 3) : tail
  let seen = 0
  return [...value]
    .map((c) => {
      if (!keep.test(c)) return c
      const i = seen++
      return i < h || i >= total - t ? c : STAR
    })
    .join('')
}

const masker = (fn: (value: string) => string): Masker =>
  ((value: string | null | undefined) =>
    value === null || value === undefined || value === '' ? value : fn(value)) as Masker

const ALNUM = /[\p{L}\p{N}]/u
const DIGIT = /\d/

export const masked = {
  /** `13812345678` → `138****5678`; `+86 138-1234-5678` keeps its `+`, spaces and dashes */
  mobile: masker((v) => maskChars(v, 3, 4, DIGIT)),
  /** `alice@example.com` → `a***@example.com`: the local part's first character + a fixed `***` */
  email: masker((v) => {
    const at = v.lastIndexOf('@')
    if (at < 0) return maskChars(v, 1, 0, ALNUM)
    const local = Array.from(v.slice(0, at)) // code points
    return `${local.length > 1 ? local[0] : ''}***${v.slice(at)}`
  }),
  /** `110101199001011234` → `1101**********1234` */
  idCard: masker((v) => maskChars(v, 4, 4, ALNUM)),
  /** `6222021234567890123` → `6222***********0123`; spaces kept */
  bankCard: masker((v) => maskChars(v, 4, 4, DIGIT)),
} as const satisfies Record<string, Masker>
