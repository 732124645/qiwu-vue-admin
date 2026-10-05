import type { ErrorDef } from '@qiwu/shared'

/**
 * An expected business failure (see docs/design-notes.md#api-envelope): `throw new BizError(Err.IAM_USERNAME_TAKEN, { username })`.
 * The error filter answers with `err.status`, `err.code` and `err.key` translated with `params`.
 */
export class BizError extends Error {
  constructor(
    readonly err: ErrorDef,
    readonly params: Record<string, unknown> = {},
  ) {
    super(err.key)
    this.name = 'BizError'
  }
}
