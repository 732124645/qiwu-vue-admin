import type { WfChangeSet, WfInstance, WfNewCc, WfNewEvent, WfTask } from '@qiwu/shared'

/**
 * An instance and its rows in memory for the engine specs: `apply` writes a change set the way the
 * TypeORM adapter does (task ids from 1, `createdAt` = the action time, a patch only on the state it expects).
 */
export function memoryRun(instance: WfInstance) {
  const tasks: WfTask[] = []
  const ccs: WfNewCc[] = []
  const events: WfNewEvent[] = []
  let endedAt: Date | undefined
  return {
    instance,
    tasks,
    ccs,
    events,
    endedAt: () => endedAt,
    /** tasks in `state` (default pending), by id */
    open: (state: WfTask['state'] = 'pending') => tasks.filter((t) => t.state === state),
    apply(set: WfChangeSet, now: Date) {
      const { endedAt: end, ...columns } = set.instance
      Object.assign(instance, columns)
      endedAt = end ?? endedAt
      for (const p of set.taskPatches) {
        const t = tasks.find((x) => x.id === p.id)
        if (t?.state !== p.from) throw new Error(`task ${p.id} is not ${p.from}`)
        Object.assign(t, p.set)
      }
      for (const t of set.newTasks)
        tasks.push({ ...t, id: tasks.length + 1, comment: null, createdAt: now, handledAt: null })
      ccs.push(...set.ccs)
      events.push(...set.events)
    },
  }
}
