// Audit rows for specs (see docs/design-notes.md#audit): they are inserted after the response (fire-and-forget), so a spec
// polls for them. A "no row" check must not wait on this: assert on something that has already
// happened instead (a spy on AuditWriter, or the row of a sentinel request sent afterwards).
import type { DataSource } from 'typeorm'

/** Audit tables whose rows carry the request's `trace_id`. */
export type TracedTable = 'aud_action_log' | 'aud_http_trace' | 'aud_http_fault'

/**
 * The `table` row (default the action log) of `traceId`, polled every 25 ms until it appears; null
 * after `waitMs` (5 s: room for a loaded run, and only a failing spec ever waits it out).
 */
export async function logOf<T = any>(
  ds: DataSource,
  traceId: string,
  table: TracedTable = 'aud_action_log',
  waitMs = 5000,
): Promise<T | null> {
  for (const until = Date.now() + waitMs; ; await new Promise((r) => setTimeout(r, 25))) {
    // arch-allow: sql-concat table name from the TracedTable union
    const [row] = await ds.query<T[]>(`SELECT * FROM ${table} WHERE trace_id = ?`, [traceId])
    if (row || Date.now() > until) return row ?? null
  }
}
