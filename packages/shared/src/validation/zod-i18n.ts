import { z } from 'zod'

// docs/adr/003-validation.md: every zod message is an i18n key. Importing @qiwu/shared installs
// `validationKey` as zod's global customError, so server and web get the same keys from the same schemas.
// A schema may still set its own key (`.refine(fn, { error: 'validation.xyz' })`); that takes precedence.

/** zod types re-exported for packages that do not depend on zod directly (web). */
export type ObjectSchema = z.ZodObject
export type ValidationIssue = z.core.$ZodIssue

/** i18n key + interpolation params for one issue; translate as `t(key, { ...params, field })`. */
export interface ValidationMessage {
  key: string
  params: Record<string, string | number>
}

const SIZE_ORIGIN: Record<string, 'string' | 'number' | 'array'> = {
  string: 'string',
  number: 'number',
  int: 'number',
  bigint: 'number',
  array: 'array',
  set: 'array',
}

/** zod raw issue → `validation.<code>[.<variant>]` (keys in `src/i18n/<lang>/validation.json`). */
export function validationKey(iss: z.core.$ZodRawIssue): string {
  switch (iss.code) {
    case 'invalid_type':
      if (iss.input == null) return 'validation.required'
      return iss.expected === 'int' ? 'validation.integer' : 'validation.invalid_type'
    case 'too_small':
    case 'too_big': {
      const size = SIZE_ORIGIN[iss.origin]
      if (!size) return 'validation.invalid'
      if (iss.code === 'too_small' && size === 'string' && Number(iss.minimum) === 1)
        return 'validation.required'
      const variant = size === 'number' && iss.inclusive === false ? 'number_exclusive' : size
      return `validation.${iss.code}.${variant}`
    }
    case 'invalid_format':
      return `validation.invalid_format.${iss.format === 'email' || iss.format === 'url' ? iss.format : 'other'}`
    case 'invalid_value':
      // an enum left empty is missing, not a wrong code
      return iss.input == null || iss.input === ''
        ? 'validation.required'
        : 'validation.invalid_value'
    case 'not_multiple_of':
    case 'unrecognized_keys':
      return `validation.${iss.code}`
    default:
      return 'validation.invalid'
  }
}

const PARAM_KEYS = [
  'minimum',
  'maximum',
  'divisor',
  'expected',
  'format',
  'values',
  'keys',
] as const

/** Final issue → key (its message) + primitive params; custom issues add their own `params`. */
export function validationMessage(issue: z.core.$ZodIssue): ValidationMessage {
  const custom = issue.code === 'custom' ? (issue.params ?? {}) : {}
  const src: Record<string, unknown> = { ...issue, ...custom }
  const params: Record<string, string | number> = {}
  for (const k of [...PARAM_KEYS, ...Object.keys(custom)]) {
    const v = src[k]
    if (typeof v === 'number' || typeof v === 'string') params[k] = v
    else if (typeof v === 'bigint') params[k] = String(v)
    else if (Array.isArray(v)) params[k] = v.map(String).join(', ')
  }
  return { key: issue.message, params }
}

/** Field-label domain of an object schema: `schema.register(fieldDomains, { domain: 'iam' })`. */
export const fieldDomains = z.registry<{ domain: string }>()

export const fieldDomainOf = (schema: unknown): string | undefined =>
  schema instanceof z.ZodType ? fieldDomains.get(schema)?.domain : undefined

/**
 * Label keys to try for an issue path, first existing wins: `field.<domain>.<prop>`, then
 * `field.common.<prop>` (fields shared by many schemas, e.g. page/pageSize), then `field.common.input`.
 */
export function fieldLabelKeys(domain: string | undefined, path: readonly PropertyKey[]): string[] {
  // no Array#findLast: shared code must also compile under the web app's (older) lib
  const prop = [...path].reverse().find((p): p is string => typeof p === 'string')
  if (!prop) return ['field.common.input']
  return [...(domain ? [`field.${domain}.${prop}`] : []), `field.common.${prop}`]
}

// jitless: zod otherwise probes/compiles parsers with `new Function`, which the SPA CSP blocks
// (script-src 'self'; see docs/design-notes.md#security) and the no-eval rule forbids on the server too
z.config({ customError: validationKey, jitless: true })
