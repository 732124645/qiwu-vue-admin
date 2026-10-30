/** 本进程正在执行的一次定时任务。 */
export interface RunningJob {
  taskId: number
  handler: string
  /** 开始时间（epoch ms） */
  startedAt: number
}

const running = new Set<RunningJob>()

/**
 * 本进程正在执行的定时任务登记表。放在 core 并用模块级状态，是为了让日志配置（慢请求标记、事件循环
 * 周期日志）不依赖调度模块也能读到“卡顿时这个进程在跑什么”；登记表只反映当前进程，多实例各自一份。
 */
export const runningJobs = {
  /** 登记一次执行，返回结束时调用的注销函数（重复调用无副作用）。 */
  begin(job: RunningJob): () => void {
    const entry = { ...job }
    running.add(entry)
    return () => void running.delete(entry)
  },
  /** 当前登记的执行及已运行的毫秒数，按开始先后排列。 */
  list(now = Date.now()): { taskId: number; handler: string; ms: number }[] {
    return [...running].map(({ taskId, handler, startedAt }) => ({
      taskId,
      handler,
      ms: Math.max(0, now - startedAt),
    }))
  },
}
