/** Success envelope returned by every API (see docs/design-notes.md#api-envelope). */
export interface ApiOk<T> {
  code: 0
  msg: string
  data: T
}

/** Paged list payload (`data` of list endpoints). */
export interface Page<T> {
  items: T[]
  total: number
}

/** Wraps `data` in the success envelope. */
export const ok = <T>(data: T): ApiOk<T> => ({ code: 0, msg: 'ok', data })
