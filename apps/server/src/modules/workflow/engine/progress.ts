import type { WfCompiled, WfFields, WfInstance, WfNode, WfNodeProgress, WfTask } from '@qiwu/shared'
import { pathsTaken } from './advance.js'

/**
 * The nodes an ended instance stopped at: those whose latest round (top-level tasks created together, as
 * `withdraw` counts it) was still open when it ended: rejected there, or canceled with the instance. A round
 * is passed once one approved (`any`) or all did. A round a send-back left open behind the stop lies after
 * it, where `progressOf` never looks for a stop.
 * An after-sign still open at the end is not seen (its parent is approved): that node reads done
 * and the rest of its line too; look at the round's children if that shows up.
 */
function stoppedAt(flow: WfCompiled, tasks: readonly WfTask[]): string[] {
  const top = tasks.filter((t) => t.parentTaskId === null && t.state !== 'withdrawn')
  return [...flow.nodes].flatMap(([id, { node }]) => {
    const mine = top.filter((t) => t.nodeId === id)
    const last = mine.reduce<WfTask | undefined>((a, t) => (a && a.id > t.id ? a : t), undefined)
    if (!last) return []
    const round = mine.filter((t) => t.fromTaskId === last.fromTaskId)
    const passed =
      node.type === 'review' && node.sign === 'any'
        ? round.some((t) => t.state === 'approved')
        : round.every((t) => t.state === 'approved' || t.state === 'transferred')
    return passed ? [] : [id]
  })
}

/**
 * Where an instance stands on its tree (the progress tree of its detail), by node and fork path id.
 * The fronts are the nodes holding a token (running: `active`), where it stopped (rejected, canceled,
 * terminated: `stopped`) or none (approved). Along a line, the nodes before a front are `done` and those
 * after it `pending`; a fork holding a front is that front too. A fork takes the paths holding a front
 * (an `exclusive` one only those: a resubmit to its sender takes that path), else the paths the engine
 * takes on the current form values; the others are `skipped` with their nodes, a taken one `done`.
 * A fork passed before an approver's edit changed the values shows the paths the new values take
 * (as `backTargets`); keep each fork's pass if that shows up.
 */
export function progressOf(
  flow: WfCompiled,
  fields: WfFields,
  inst: WfInstance,
  tasks: readonly WfTask[],
): Record<string, WfNodeProgress> {
  const running = inst.state === 'running'
  const fronts = new Set(
    running ? inst.activeNodeIds : inst.state === 'approved' ? [] : stoppedAt(flow, tasks),
  )
  const front: WfNodeProgress = running ? 'active' : 'stopped'
  const out: Record<string, WfNodeProgress> = {}
  /** the line from `n` holds a front (in a fork path too) */
  const holds = (n: WfNode | undefined): boolean => {
    for (; n; n = n.next)
      if (fronts.has(n.id) || (n.type === 'fork' && n.paths.some((p) => holds(p.child))))
        return true
    return false
  }
  /** the line from `n`, fork paths and their nodes too */
  const mark = (n: WfNode | undefined, s: WfNodeProgress) => {
    for (; n; n = n.next) {
      out[n.id] = s
      if (n.type === 'fork')
        for (const p of n.paths) {
          out[p.id] = s
          mark(p.child, s)
        }
    }
  }
  const walk = (n: WfNode | undefined) => {
    for (; n; n = n.next) {
      if (n.type !== 'fork') {
        if (!fronts.has(n.id)) {
          out[n.id] = 'done'
          continue
        }
        out[n.id] = front
        return mark(n.next, 'pending')
      }
      const inside = n.paths.filter((p) => holds(p.child))
      const taken =
        inside.length && (n.mode ?? 'exclusive') === 'exclusive'
          ? inside
          : [...inside, ...pathsTaken(fields, inst, n)]
      for (const p of n.paths)
        if (taken.includes(p)) {
          out[p.id] = 'done'
          walk(p.child)
        } else {
          out[p.id] = 'skipped'
          mark(p.child, 'skipped')
        }
      if (!inside.length) {
        out[n.id] = 'done'
        continue
      }
      out[n.id] = front
      return mark(n.next, 'pending')
    }
  }
  walk(flow.root)
  return out
}
