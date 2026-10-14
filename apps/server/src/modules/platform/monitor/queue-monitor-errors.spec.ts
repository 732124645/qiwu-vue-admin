// Queue monitor without Redis: BullMQ refusing a job that changed between the state check and the write
// answers 404 / 409 (not 500), which job ids reach BullMQ at all, and the masking of a job's secrets.
import { Err } from '@qiwu/shared'
import { ErrorCode } from 'bullmq'
import { BizError } from '../../../core/http/biz-error.js'
import { QueueMonitorService } from './queue-monitor.service.js'

const coded = (code: number) => Object.assign(new Error(`code ${code}`), { code })

function service(job: {
  state?: string
  retry?: () => Promise<void>
  remove?: () => Promise<void>
}) {
  const getJob = vi.fn<(id: string) => Promise<unknown>>(async () => ({
    getState: async () => job.state ?? 'failed',
    retry: job.retry ?? (async () => undefined),
    remove: job.remove ?? (async () => undefined),
  }))
  const queues = new Map([['q', { name: 'q', getJob }]])
  return { svc: new QueueMonitorService({ queues: () => queues } as never), getJob }
}

const errOf = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x)
  expect(e).toBeInstanceOf(BizError)
  return (e as BizError).err
}

it.each([
  ['not in the failed state any more', ErrorCode.JobNotInState, Err.CONFLICT],
  ['locked by a worker', ErrorCode.JobLockNotExist, Err.CONFLICT],
  ['gone meanwhile', ErrorCode.JobNotExist, Err.NOT_FOUND],
])('a retry racing a job %s answers %#', async (_, code, err) => {
  const { svc } = service({ retry: () => Promise.reject(coded(code)) })
  expect(await errOf(svc.retry('q', '1'))).toBe(err)
})

it('a removal racing a worker that took the job answers 409; other errors stay errors', async () => {
  const locked = service({
    state: 'waiting',
    remove: () =>
      Promise.reject(
        new Error('Job 1 could not be removed because it is locked by another worker'),
      ),
  })
  expect(await errOf(locked.svc.remove('q', '1'))).toBe(Err.CONFLICT)
  const scheduled = service({
    state: 'delayed',
    remove: () => Promise.reject(coded(ErrorCode.JobBelongsToJobScheduler)),
  })
  expect(await errOf(scheduled.svc.remove('q', '1'))).toBe(Err.CONFLICT)
  const broken = service({ state: 'waiting', remove: () => Promise.reject(new Error('READONLY')) })
  await expect(broken.svc.remove('q', '1')).rejects.toThrow('READONLY')
})

it("passes BullMQ's own id shapes (no ':' or exactly two) and nothing else", async () => {
  for (const id of ['17', 't5-report-7', 'repeat:abc123:1760000000000', 'x*', 'a b', 'ü@x.com']) {
    const { svc, getJob } = service({})
    await svc.retry('q', id)
    expect(getJob).toHaveBeenCalledWith(id)
  }
  for (const id of ['a:b', 'a:b:c:d', '', ':a:b', 'x'.repeat(257)]) {
    const { svc, getJob } = service({})
    expect(await errOf(svc.retry('q', id))).toBe(Err.NOT_FOUND)
    expect(getJob).not.toHaveBeenCalled()
  }
})

it('answers 404 for an id naming one of the queue keys of another type (WRONGTYPE)', async () => {
  const { svc, getJob } = service({})
  getJob.mockRejectedValueOnce(
    new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
  )
  expect(await errOf(svc.remove('q', 'wait'))).toBe(Err.NOT_FOUND)
  getJob.mockRejectedValueOnce(new Error('LOADING'))
  await expect(svc.remove('q', 'wait')).rejects.toThrow('LOADING')
})

it('masks a secret with quotes or backslashes wherever the data or the failure quotes it', async () => {
  const secret = 'pa"ss\\word-1'
  const job = {
    id: '9',
    name: 'n',
    data: { tenantId: 2, payload: { password: secret, note: `copied ${secret}`, list: [secret] } },
    attemptsMade: 1,
    opts: { attempts: 1 },
    failedReason: `refused ${secret}`,
    timestamp: 0,
  }
  const queues = new Map([
    ['q', { name: 'q', getJobs: async () => [job], getJobCountByTypes: async () => 1 }],
  ])
  const svc = new QueueMonitorService({ queues: () => queues } as never)
  const page = await svc.jobs('q', { state: 'failed', page: 1, pageSize: 20 })
  const [vo] = page.items
  expect(vo!.data).toBe('{"password":"***","note":"copied ***","list":["***"]}')
  expect(vo!.failedReason).toBe('refused ***')
  expect(JSON.stringify(vo)).not.toContain('word-1')
})
