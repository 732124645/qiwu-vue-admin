import type { WfNodeProgress } from '@qiwu/shared'

/** the renderer's default colors (designer and read-only diagram): tokens, the theme follows without a re-import */
export const RENDER_COLORS = {
  defaultFillColor: 'var(--qw-surface)',
  defaultStrokeColor: 'var(--qw-text)',
  defaultLabelColor: 'var(--qw-text)',
}

/** a progress the read-only diagram shows (`pending` shows none) */
export type Shown = Exclude<WfNodeProgress, 'pending'>

/** a sequence flow of the diagram: its id and its ends' element ids */
export interface Flow {
  id: string
  source: string
  target: string
}

/**
 * The read-only diagram's marks: element id → the progress it shows (marker `qw-<progress>`).
 * Nodes, forks and the fork paths' first flows: as `progress` (the server's, keyed by node and path id) says. A
 * join: its fork's (`joins`, from `bpmnToTree`), when that is done or skipped. Any other flow: skipped when one
 * end is, done when both are, else none; an end event does not count (the other end alone decides). Ids
 * `progress` names that the diagram lacks come through: the caller looks each one up.
 */
export function progressMarks(
  progress: Record<string, WfNodeProgress>,
  joins: Record<string, string>,
  flows: readonly Flow[],
  ends: ReadonlySet<string>,
): Map<string, Shown> {
  const out = new Map<string, Shown>()
  for (const [id, p] of Object.entries(progress)) if (p !== 'pending') out.set(id, p)
  for (const [join, fork] of Object.entries(joins)) {
    const p = progress[fork]
    if (p === 'done' || p === 'skipped') out.set(join, p)
  }
  for (const f of flows) {
    // a fork's path: the server's
    if (Object.hasOwn(progress, f.id)) continue
    const at = [f.source, f.target].filter((id) => !ends.has(id)).map((id) => out.get(id))
    if (at.includes('skipped')) out.set(f.id, 'skipped')
    else if (at.length && at.every((p) => p === 'done')) out.set(f.id, 'done')
  }
  return out
}
