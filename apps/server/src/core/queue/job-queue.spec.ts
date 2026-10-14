// Queue core without Redis: the eviction policy check (INFO stubbed), the tenant a processor runs a job
// in, and the tenant QueueService.add records.
import { type Job, Queue, UnrecoverableError } from 'bullmq'
import { allTenants, TenantContextMissing, tenantIdIfAny, withTenant } from '../context/tenant.js'
import { checkEvictionPolicy } from './queue.module.js'
import { registerQueue } from './queue-registry.js'
import { QueueService } from './queue.service.js'
import { type QueuedJob, TenantJobProcessor } from './tenant-job.processor.js'

const info = (policy: string) =>
  `# Memory\r\nused_memory:1024\r\nmaxmemory:0\r\nmaxmemory_policy:${policy}\r\nmem_fragmentation_ratio:1.2\r\n`

describe('checkEvictionPolicy', () => {
  const run = async (reply: () => Promise<string>) => {
    const sendCommand = vi.fn<(args: string[]) => Promise<string>>(reply)
    const warn = vi.fn<(message: string) => void>()
    const policy = await checkEvictionPolicy({ sendCommand } as never, { warn })
    return { policy, warn, sendCommand }
  }

  it('reads INFO memory and stays quiet on noeviction', async () => {
    const { policy, warn, sendCommand } = await run(async () => info('noeviction'))
    expect(sendCommand).toHaveBeenCalledWith(['INFO', 'memory'])
    expect(policy).toBe('noeviction')
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns, naming the setting, on any other policy', async () => {
    const { policy, warn } = await run(async () => info('allkeys-lru'))
    expect(policy).toBe('allkeys-lru')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain("maxmemory-policy is 'allkeys-lru'")
    expect(warn.mock.calls[0]![0]).toContain('noeviction')
  })

  it('warns instead of failing when INFO cannot be read or lacks the field', async () => {
    const denied = await run(() => Promise.reject(new Error('NOPERM')))
    expect(denied.policy).toBeUndefined()
    expect(denied.warn.mock.calls[0]![0]).toContain('NOPERM')
    const bare = await run(async () => '# Memory\r\nused_memory:1\r\n')
    expect(bare.warn.mock.calls[0]![0]).toContain("'unknown'")
  })
})

class Probe extends TenantJobProcessor<string, number | undefined> {
  calls: string[] = []
  protected async handle(payload: string) {
    this.calls.push(payload)
    return tenantIdIfAny()
  }
}

const job = (data: unknown, queueName = 'unit-tenant') =>
  ({ id: '1', queueName, data }) as unknown as Job<QueuedJob<string>>

describe('TenantJobProcessor', () => {
  registerQueue({ name: 'unit-platform', platform: true })

  it('runs a job in the tenant it names, whatever context the worker is in', async () => {
    const p = new Probe()
    expect(await p.process(job({ tenantId: 7, payload: 'a' }))).toBe(7)
    // qw:cross-tenant probe: an inherited tenant never leaks into the job
    expect(await withTenant(3, () => p.process(job({ tenantId: 9, payload: 'b' })))).toBe(9)
    expect(p.calls).toEqual(['a', 'b'])
  })

  it.each([
    ['no data', undefined],
    ['no tenant', { payload: 'x' }],
    ['tenant null in a tenant queue', { tenantId: null, payload: 'x' }],
    ['tenant 0', { tenantId: 0, payload: 'x' }],
    ['a string tenant', { tenantId: '2', payload: 'x' }],
    ['a fractional tenant', { tenantId: 1.5, payload: 'x' }],
  ])('fails a job with %s at once, without retries and without running it', async (_, data) => {
    const p = new Probe()
    await expect(p.process(job(data))).rejects.toBeInstanceOf(UnrecoverableError)
    expect(p.calls).toEqual([])
  })

  it('runs a platform-wide queue job (tenant null) with no tenant', async () => {
    const p = new Probe()
    // qw:cross-tenant probe: the caller's tenant is not the job's
    expect(
      await withTenant(4, () => p.process(job({ tenantId: null, payload: 'p' }, 'unit-platform'))),
    ).toBeUndefined()
    expect(p.calls).toEqual(['p'])
  })
})

describe('TenantJobProcessor errors', () => {
  class Thrower extends TenantJobProcessor {
    constructor(private readonly error: Error) {
      super()
    }
    protected async handle(): Promise<never> {
      throw this.error
    }
  }

  it("masks a database driver's quoted values in the failure message, rethrowing the same error", async () => {
    const dup = Object.assign(
      new Error("Duplicate entry 'alice@example.com' for key 'iam_user.uk_iam_user_email'"),
      { sqlState: '23000', code: 'ER_DUP_ENTRY' },
    )
    const e = (await new Thrower(dup)
      .process(job({ tenantId: 3, payload: 'x' }))
      .catch((x: Error) => x)) as Error
    expect(e).toBe(dup)
    expect(e.message).not.toContain('alice')
    expect(e.message).toContain('ER_DUP_ENTRY')
  })

  it('keeps an UnrecoverableError (and any other error) as thrown', async () => {
    const fatal = new UnrecoverableError("stop 'here'")
    const e = (await new Thrower(fatal)
      .process(job({ tenantId: 3, payload: 'x' }))
      .catch((x: Error) => x)) as Error
    expect(e).toBe(fatal)
    expect(e).toBeInstanceOf(UnrecoverableError)
    expect(e.message).toBe("stop 'here'")
  })
})

describe('QueueService.add', () => {
  const added: unknown[] = []
  const fake = (name: string) => {
    const q = Object.create(Queue.prototype) as Queue
    Object.defineProperty(q, 'name', { value: name })
    q.add = (async (jobName: string, data: unknown, opts?: object) => {
      added.push({ jobName, data, ...(opts && Object.keys(opts).length && { opts }) })
      return { id: '1' }
    }) as never
    return q
  }
  const service = new QueueService({
    getProviders: () => [
      { instance: fake('unit-tenant') },
      { instance: fake('unit-platform') },
      { instance: {} },
    ],
  } as never)

  beforeEach(() => (added.length = 0))

  it("records the context's tenant with the payload", async () => {
    // qw:cross-tenant probe: the adding tenant
    await withTenant(5, () => service.add('unit-tenant', 'hello', { n: 1 }))
    expect(added).toEqual([{ jobName: 'hello', data: { tenantId: 5, payload: { n: 1 } } }])
  })

  it('refuses without a tenant (none, or all tenants), but for a platform-wide queue', async () => {
    await expect(service.add('unit-tenant', 'x', 1)).rejects.toBeInstanceOf(TenantContextMissing)
    // qw:cross-tenant probe: allTenants names no tenant
    await expect(allTenants(() => service.add('unit-tenant', 'x', 1))).rejects.toBeInstanceOf(
      TenantContextMissing,
    )
    expect(added).toEqual([])
    // qw:cross-tenant probe: a platform queue ignores the caller's tenant
    await withTenant(5, () => service.add('unit-platform', 'p', 2))
    await service.add('unit-platform', 'p', 3)
    expect(added).toEqual([
      { jobName: 'p', data: { tenantId: null, payload: 2 } },
      { jobName: 'p', data: { tenantId: null, payload: 3 } },
    ])
  })

  it('prefixes custom job and deduplication ids with the tenant (none in a platform queue)', async () => {
    const opts = { jobId: 'report-7', deduplication: { id: 'd-7', ttl: 1000 }, attempts: 2 }
    // qw:cross-tenant probe: two tenants, the same custom ids
    await withTenant(5, () => service.add('unit-tenant', 'a', 1, opts))
    // qw:cross-tenant probe: two tenants, the same custom ids
    await withTenant(6, () => service.add('unit-tenant', 'b', 1, opts))
    await service.add('unit-platform', 'c', 1, opts)
    expect(added.map((a) => (a as { opts: object }).opts)).toEqual([
      { jobId: 't5-report-7', deduplication: { id: 't5-d-7', ttl: 1000 }, attempts: 2 },
      { jobId: 't6-report-7', deduplication: { id: 't6-d-7', ttl: 1000 }, attempts: 2 },
      opts,
    ])
    expect(opts.jobId).toBe('report-7')
  })

  it('leaves an empty custom id to BullMQ (no fixed per-tenant id)', async () => {
    // qw:cross-tenant probe: the adding tenant
    await withTenant(5, () => service.add('unit-tenant', 'e', 1, { jobId: '' }))
    expect((added[0] as { opts: { jobId: string } }).opts.jobId).toBe('')
  })

  it('throws for a queue not registered in the app', async () => {
    await expect(service.add('unit-nowhere', 'x', 1)).rejects.toThrow("no queue 'unit-nowhere'")
  })
})
