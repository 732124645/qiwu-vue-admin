import { type IntervalHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks'
import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { AppConfigService } from '../config/config.module.js'
import { runningJobs } from './running-jobs.js'

/** 一段时间内的事件循环延迟（超出正常调度的部分，毫秒）与利用率（0–1），均保留两位小数。 */
export interface EventLoopStats {
  p50: number
  p99: number
  max: number
  utilization: number
}

/** 事件循环延迟直方图的采样间隔（毫秒），监控采样器与每次任务执行的直方图共用。 */
export const LOOP_RESOLUTION_MS = 20

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 直方图记录的是两次采样之间的完整间隔（含采样间隔本身），空闲进程也约为 20 ms；
 * 减去采样间隔并截到 0，得到“超出正常调度的延迟”（毫秒），与文档口径一致。
 */
export const loopDelayMs = (ns: number) => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS)
const nsToMs = (ns: number) => round2(loopDelayMs(ns))

/**
 * 一个独立的采样器：自己的延迟直方图与利用率基准，`read()` 返回上次读取以来的值并清零。
 * 每个读者各用一个，互不消耗对方的“上次读取以来”。
 */
export class EventLoopSampler {
  private readonly histogram: IntervalHistogram = monitorEventLoopDelay({
    resolution: LOOP_RESOLUTION_MS,
  })
  private elu = performance.eventLoopUtilization()

  /** 开始采样。 */
  start(): this {
    this.histogram.enable()
    this.elu = performance.eventLoopUtilization()
    return this
  }

  /** 停止采样，释放计时器。 */
  stop(): void {
    this.histogram.disable()
  }

  /** 上次读取（或开始）以来的 p50 / p99 / max 与利用率，读后清零。没有样本时延迟为 0。 */
  read(): EventLoopStats {
    const now = performance.eventLoopUtilization()
    const { utilization } = performance.eventLoopUtilization(now, this.elu)
    this.elu = now
    const h = this.histogram
    const stats = {
      p50: nsToMs(h.percentile(50)),
      p99: nsToMs(h.percentile(99)),
      max: nsToMs(h.max),
      utilization: round2(utilization),
    }
    h.reset()
    return stats
  }
}

/**
 * 本进程的事件循环观测：`read()` 供服务监控接口使用（上次读取以来的值）；`LOG_EVENT_LOOP_INTERVAL_MS`
 * 大于 0 时按间隔写一行日志（带当时正在执行的定时任务），`max` 达到 `LOG_EVENT_LOOP_WARN_MS`（大于 0）
 * 时用 warn。日志用另一个采样器，免得周期日志把监控页“上次读取以来”的数据清掉。
 */
@Injectable()
export class EventLoopMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventLoop')
  private readonly page = new EventLoopSampler()
  private logSampler: EventLoopSampler | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly cfg: AppConfigService) {}

  /** 启动时开始采样；周期日志按配置开启，计时器不阻止进程退出。 */
  onModuleInit(): void {
    this.page.start()
    const every = this.cfg.get('LOG_EVENT_LOOP_INTERVAL_MS')
    if (every > 0) {
      const sampler = (this.logSampler = new EventLoopSampler().start())
      this.timer = setInterval(() => this.logOnce(sampler), every)
      this.timer.unref()
    }
  }

  /** 关闭时停止采样与周期日志。 */
  onModuleDestroy(): void {
    clearInterval(this.timer)
    this.logSampler?.stop()
    this.page.stop()
  }

  /** 监控页：上次读取以来本进程的事件循环数据。 */
  read(): EventLoopStats {
    return this.page.read()
  }

  /** 写一行周期日志；超过告警阈值时用 warn。 */
  private logOnce(sampler: EventLoopSampler): void {
    const eventLoop = sampler.read()
    const warnMs = this.cfg.get('LOG_EVENT_LOOP_WARN_MS')
    const line = { eventLoop, runningJobs: runningJobs.list() }
    if (warnMs > 0 && eventLoop.max >= warnMs) this.logger.warn(line, 'event loop delay')
    else this.logger.log(line, 'event loop')
  }
}

/** 事件循环观测（全局）：服务监控页读取，周期日志按配置开启。 */
@Global()
@Module({ providers: [EventLoopMonitor], exports: [EventLoopMonitor] })
export class CoreMonitorModule {}
