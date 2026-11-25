// Event-loop sampling, the running-jobs registry and the slow-request marks of the request log.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { Logger } from '@nestjs/common'
import { startTime } from 'pino-http'
import type { MockInstance } from 'vitest'
import type { AppConfigService } from '../config/config.module.js'
import { slowRequestOptions } from '../logger/logger.module.js'
import {
  EventLoopMonitor,
  EventLoopSampler,
  LOOP_RESOLUTION_MS,
  loopDelayMs,
} from './event-loop.js'
import { runningJobs } from './running-jobs.js'

const busy = (ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until);
}

describe('event-loop sampler', () => {
  it('reports the delay since the previous read, then starts over', async () => {
    const sampler = new EventLoopSampler().start()
    try {
      await sleep(50)
      busy(200)
      await sleep(50)
      const blocked = sampler.read()
      expect(blocked.max).toBeGreaterThanOrEqual(150)
      expect(blocked.p99).toBeGreaterThanOrEqual(blocked.p50)
      expect(blocked.utilization).toBeGreaterThan(0)
      expect(blocked.utilization).toBeLessThanOrEqual(1)
      await sleep(50)
      const calm = sampler.read()
      expect(calm.max).toBeLessThan(blocked.max / 2)
      expect(calm.utilization).toBeGreaterThanOrEqual(0)
      expect(calm.utilization).toBeLessThanOrEqual(1)
    } finally {
      sampler.stop()
    }
  })

  it('counts only the delay beyond the sampling interval, never below 0', () => {
    expect(loopDelayMs(0)).toBe(0)
    expect(loopDelayMs((LOOP_RESOLUTION_MS - 1) * 1e6)).toBe(0)
    expect(loopDelayMs((LOOP_RESOLUTION_MS + 2.5) * 1e6)).toBeCloseTo(2.5)
  })
})

describe('event-loop log', () => {
  const stats = { p50: 1, p99: 5, max: 50, utilization: 0.2 }
  const monitor = (interval: number, warnMs: number) =>
    new EventLoopMonitor({
      get: (key: string) =>
        key === 'LOG_EVENT_LOOP_INTERVAL_MS'
          ? interval
          : key === 'LOG_EVENT_LOOP_WARN_MS'
            ? warnMs
            : 0,
    } as unknown as AppConfigService)
  let log: MockInstance
  let warn: MockInstance
  let every: MockInstance
  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    every = vi.spyOn(globalThis, 'setInterval')
    vi.spyOn(EventLoopSampler.prototype, 'read').mockReturnValue(stats)
  })
  afterEach(() => vi.restoreAllMocks())
  /** Starts the monitor, runs one tick of its log timer (if any), stops it. */
  const tick = (m: EventLoopMonitor) => {
    m.onModuleInit()
    try {
      for (const [fn] of every.mock.calls) (fn as () => void)()
    } finally {
      m.onModuleDestroy()
    }
  }

  it('interval 0 (the default): no timer, no log line', () => {
    tick(monitor(0, 10))
    expect(every).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('interval > 0: a line at info every interval, with the jobs then running', () => {
    tick(monitor(1000, 0))
    expect(every).toHaveBeenCalledWith(expect.any(Function), 1000)
    expect(log).toHaveBeenCalledWith({ eventLoop: stats, runningJobs: [] }, 'event loop')
    expect(warn).not.toHaveBeenCalled()
  })

  it('max at or past the warn threshold: warn; below it: info', () => {
    tick(monitor(1000, 50))
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventLoop: stats }),
      'event loop delay',
    )
    expect(log).not.toHaveBeenCalled()
    warn.mockClear()
    every.mockClear()
    tick(monitor(1000, 51))
    expect(warn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('running jobs', () => {
  it('lists what began and has not ended, with its running time', () => {
    const end = runningJobs.begin({ taskId: 7, handler: 'demo.echo', startedAt: 1000 })
    expect(runningJobs.list(1250)).toContainEqual({ taskId: 7, handler: 'demo.echo', ms: 250 })
    end()
    end()
    expect(runningJobs.list(1250).some((j) => j.taskId === 7)).toBe(false)
  })
})

describe('slow request marks', () => {
  const req = {} as IncomingMessage
  const res = (tookMs: number) =>
    ({ [startTime]: Date.now() - tookMs }) as unknown as ServerResponse

  it('off (0): no hooks, the request line stays as it is', () => {
    expect(slowRequestOptions(0)).toEqual({})
  })

  it('at or past the threshold: warn, slow and the jobs then running', () => {
    const o = slowRequestOptions(50)
    const end = runningJobs.begin({ taskId: 9, handler: 'web.fetch', startedAt: Date.now() - 500 })
    try {
      const r = res(120)
      expect(o.customLogLevel!(req, r)).toBe('warn')
      const line = o.customSuccessObject!(req, r, { responseTime: 120 })
      expect(line).toMatchObject({ responseTime: 120, slow: true })
      expect(line.runningJobs).toContainEqual(
        expect.objectContaining({ taskId: 9, handler: 'web.fetch' }),
      )
      const failed = res(80)
      expect(o.customLogLevel!(req, failed, new Error('x'))).toBe('warn')
      expect(o.customErrorObject!(req, failed, new Error('x'), { responseTime: 80 })).toMatchObject(
        { slow: true },
      )
    } finally {
      end()
    }
  })

  it('below the threshold: info and the same object', () => {
    const o = slowRequestOptions(5000)
    const r = res(1)
    expect(o.customLogLevel!(req, r)).toBe('info')
    const val = { responseTime: 1 }
    expect(o.customSuccessObject!(req, r, val)).toBe(val)
    expect(o.customErrorObject!(req, r, new Error('x'), val)).toBe(val)
  })
})
