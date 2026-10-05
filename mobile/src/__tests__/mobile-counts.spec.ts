// Workbench counts (main frame): to-dos, my running processes and unread messages, silent loads, a
// sign-in / sign-out drops the previous user's answers.
import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setSession } from '@/core/request'
import { useCountsStore } from '@/core/stores/counts'

type Reply = (o: UniApp.RequestOptions) => void
/** the pending calls: each takes the reply it gets */
const replies: ((reply: Reply) => void)[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  setSession({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800 })
  replies.length = 0
  vi.mocked(uni.showToast).mockClear()
  // each call waits until the spec answers it
  vi.mocked(uni.request).mockImplementation((o) => {
    replies.push((reply) => reply(o))
    return {} as UniApp.RequestTask
  })
})

const ok = (data: unknown) => (o: UniApp.RequestOptions) =>
  o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data } } as never)
const fail = (o: UniApp.RequestOptions) => o.success?.({ statusCode: 500, data: {} } as never)
const flush = () => new Promise((r) => setTimeout(r))
/** Answers the pending calls in their order: the to-do page, the running page, the unread count. */
const answer = async (...answers: Reply[]) => {
  for (const [i, call] of replies.splice(0, answers.length).entries()) call(answers[i]!)
  await flush()
}
const page = (total: number) => ok({ items: [], total })

it('loads my to-dos and running processes (one-row pages: their totals) and unread messages, silently', async () => {
  const counts = useCountsStore()
  const all = () => [counts.todo, counts.running, counts.unread]
  expect(all()).toEqual([null, null, null])
  counts.load()
  const urls = vi.mocked(uni.request).mock.calls.map(([o]) => [o.url, o.data])
  expect(urls).toEqual([
    ['/api/wf/tasks/todo', { page: 1, pageSize: 1 }],
    ['/api/wf/instances/mine', { page: 1, pageSize: 1, state: 'running' }],
    ['/api/messaging/inboxes/mine/unread', undefined],
  ])
  await answer(page(3), page(2), ok({ unread: 5 }))
  expect(all()).toEqual([3, 2, 5])

  // a failed load keeps the last values and shows nothing
  counts.load()
  await answer(fail, fail, ok({ unread: 6 }))
  expect(all()).toEqual([3, 2, 6])
  expect(uni.showToast).not.toHaveBeenCalled()

  // every to-do answer bumps the tick, the same count too (the workbench's newest to-dos reload with it)
  expect(counts.tick).toBe(1)
  counts.load()
  await answer(page(3), page(2), ok({ unread: 6 }))
  expect([...all(), counts.tick]).toEqual([3, 2, 6, 2])
})

it('reset (sign-in / sign-out) clears the counts and ignores answers still pending', async () => {
  const counts = useCountsStore()
  const all = () => [counts.todo, counts.running, counts.unread]
  counts.load()
  await answer(page(2), page(1), ok({ unread: 1 }))
  counts.load()
  counts.reset()
  expect([...all(), counts.tick]).toEqual([null, null, null, 0])
  await answer(page(9), page(9), ok({ unread: 9 }))
  expect([...all(), counts.tick]).toEqual([null, null, null, 0])
})
