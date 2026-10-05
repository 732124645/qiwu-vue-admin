import { Injectable, type OnModuleInit } from '@nestjs/common'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import type { JobHandlerVo } from '@qiwu/shared'
import type { z } from 'zod'
import {
  JOB_HANDLER,
  type JobContext,
  type JobHandlerMeta,
} from '../../../core/scheduler/job-handler.js'

/** A registered `@JobHandler` method, bound to its provider. */
export interface RegisteredJob extends JobHandlerMeta {
  run: (params: unknown, ctx: JobContext) => unknown
}

/**
 * The handler whitelist: every `@JobHandler` provider method of the app, collected once at
 * start. A name registered twice fails the start. Tasks name handlers only from here.
 */
@Injectable()
export class JobRegistry implements OnModuleInit {
  private readonly jobs = new Map<string, RegisteredJob>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    for (const { instance } of this.discovery.getProviders()) {
      if (!instance || typeof instance !== 'object') continue
      const target = instance as Record<string, unknown>
      for (const method of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const fn = target[method]
        if (typeof fn !== 'function') continue
        const meta = this.reflector.get<JobHandlerMeta | undefined>(JOB_HANDLER, fn)
        if (!meta) continue
        if (this.jobs.has(meta.name))
          throw new Error(`@JobHandler('${meta.name}') registered twice`)
        this.jobs.set(meta.name, { ...meta, run: fn.bind(instance) as RegisteredJob['run'] })
      }
    }
  }

  get(name: string): RegisteredJob | undefined {
    return this.jobs.get(name)
  }

  /** The handler dropdown (`GET /tasks/handlers`): names in order, with the params a new task starts with. */
  list(): JobHandlerVo[] {
    return [...this.jobs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, params }) => ({ name, defaultParams: defaultParamsOf(params) }))
  }
}

/** JSON of what the schema makes of `{}` (its defaults), or null when that is empty or invalid. */
function defaultParamsOf(schema: z.ZodType): string | null {
  const r = schema.safeParse({})
  return r.success && r.data && typeof r.data === 'object' && Object.keys(r.data).length
    ? JSON.stringify(r.data, null, 2)
    : null
}
