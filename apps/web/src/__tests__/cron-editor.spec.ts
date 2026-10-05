// CronEditor (scheduler page-1): the @vue-js-cron picker only builds crons the server takes,
// the text box, cronstrue in the current locale and the server's next fire times; against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, type Component } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon } from 'element-plus'
import { CronElementPlus } from '@vue-js-cron/element-plus'
import dayjs from 'dayjs'
import { CRON_PATTERN } from '@qiwu/shared'
import CronEditor from '@/core/components/CronEditor.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { fail, mockApi, ok, type Route } from './mock-api'

const NEXT = 'GET /scheduler/tasks/next-fire-times'
const TIMES = [1, 2, 3, 4, 5].map((d) => `2026-10-0${d}T02:00:00.000Z`)

/**
 * Mounts the editor with a working `v-model` (a value set during setup lands a microtask later, as a
 * parent's re-render would), registering only what main.ts registers for the picker.
 */
function editor(value = '', props = {}) {
  const w: VueWrapper = mount(CronEditor as Component, {
    props: {
      modelValue: value,
      'onUpdate:modelValue': (v: unknown) =>
        void Promise.resolve().then(() => w.setProps({ modelValue: v })),
      ...props,
    },
    global: {
      plugins: [i18n, ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon],
    },
    attachTo: document.body,
  })
  mounted.push(w)
  return w
}
// unmounted after each test: a live editor would rebuild its picker on every later locale switch
const mounted: VueWrapper[] = []
const modelOf = (w: VueWrapper) => (w.props() as { modelValue: string }).modelValue
/** lets the 400 ms debounce run out, then the fake backend answer */
async function settle() {
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  setLocale('en-US')
  accessToken.value = 'at'
  warn = vi.spyOn(console, 'warn')
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('CronEditor', () => {
  it('the picker builds only crons of 6 fields in range, numbers and * , - / (what the server takes)', async () => {
    mockApi({ [NEXT]: ok({ times: TIMES }) })
    const w = editor('* * * * * *')
    const picker = w.findComponent(CronElementPlus).vm as unknown as {
      period: { items: { id: string }[]; select: (id: string) => void }
      selected: { items: { value: number }[]; select: (values: number[]) => void }[]
    }
    const seen = new Set<string>()
    const pickerValue = () => w.findComponent(CronElementPlus).props('modelValue') as string
    // every period (each shows its own fields); in the widest ("every year") every field: one value,
    // first / last, runs (ranges), steps, lists, all, none
    for (const { id } of picker.period.items) {
      picker.period.select(id)
      await flushPromises()
      seen.add(modelOf(w))
    }
    expect(picker.selected).toHaveLength(6)
    for (const field of picker.selected) {
      const all = field.items.map((i) => i.value)
      const picks = [
        [all[0]!],
        [all.at(-1)!],
        all.slice(0, 3),
        all.slice(2, 6),
        all.filter((_, i) => i % 5 === 0),
        all.filter((_, i) => i % 2 === 1),
        [all[0]!, all[2]!, all[3]!, all[4]!, all.at(-1)!],
        all,
        [],
      ]
      for (const pick of picks) {
        field.select(pick)
        await flushPromises()
        seen.add(modelOf(w))
        // the model is what the picker shows
        expect(pickerValue()).toBe(modelOf(w))
      }
    }
    // second, minute, hour, day, month, weekday (0 = Sunday), as the server's cron reads them
    const RANGES = [
      [0, 59],
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ] as const
    const outOfRange = (cron: string) =>
      cron.split(' ').some((part, i) =>
        part
          .split(/[,/-]/)
          .filter((n) => n !== '*')
          .some((n, j, parts) => {
            const step = part.includes('/') && j === parts.length - 1
            const [min, max] = RANGES[i]!
            return step ? Number(n) < 1 : Number(n) < min || Number(n) > max
          }),
      )
    expect(seen.size).toBeGreaterThan(40)
    expect([...seen].filter((c) => !CRON_PATTERN.test(c) || c.split(' ').length !== 6)).toEqual([])
    expect([...seen].filter(outOfRange)).toEqual([])
    // ranges, steps and lists all came up
    expect([...seen].some((c) => /\d-\d/.test(c))).toBe(true)
    expect([...seen].some((c) => c.includes('*/'))).toBe(true)
    expect([...seen].some((c) => c.includes(','))).toBe(true)
    // the picker's Element Plus parts resolve with only main.ts' five registered, its props check out
    expect(warn.mock.calls.flat().join(' ')).not.toContain('[Vue warn]')
  })

  it('starts a blank field at midnight daily; typed crons reach the picker and the words follow the locale', async () => {
    mockApi({ [NEXT]: ok({ times: TIMES }) })
    const w = editor('')
    await flushPromises()
    expect(modelOf(w)).toBe('0 0 0 * * *')
    expect(w.find('.cron-editor__desc').text()).toBe('At 00:00')

    await w.find('input').setValue('0 30 9 * * 1-5')
    expect(modelOf(w)).toBe('0 30 9 * * 1-5')
    expect(w.findComponent(CronElementPlus).props('modelValue')).toBe('0 30 9 * * 1-5')
    expect(w.find('.cron-editor__desc').text()).toBe('At 09:30, Monday through Friday')

    setLocale('zh-CN')
    await nextTick()
    expect(w.find('.cron-editor__desc').text()).toMatch(/09:30.*星期一.*星期五/)
    expect(w.findComponent(CronElementPlus).props('locale')).toBe('zh-CN')

    // not a cron the server takes: the field order instead of words
    await w.find('input').setValue('0 0 12 ? * MON')
    expect(w.find('.cron-editor__desc').text()).toBe(
      '依次为秒、分、时、日、月、星期（0 为周日），以空格分隔',
    )
  })

  it('a disabled blank field stays blank', async () => {
    mockApi({})
    const w = editor('', { disabled: true })
    await flushPromises()
    expect(modelOf(w)).toBe('')
    expect(w.find('input').attributes('disabled')).toBeDefined()
  })

  it('shows the next 5 fire times the server computes, once the typing settles', async () => {
    const calls = mockApi({ [NEXT]: ok({ times: TIMES }) })
    const w = editor('0 0 2 * * *')
    await settle()
    expect(calls.map((c) => c.params)).toEqual([{ cron: '0 0 2 * * *' }])
    expect(w.find('.cron-editor__label').text()).toBe('Next 5 runs')
    expect(w.findAll('.cron-editor__times li').map((li) => li.text())).toEqual(
      TIMES.map((iso) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss')),
    )

    // keystrokes within the debounce: one request, for the last value
    const input = w.find('input')
    await input.setValue('0 0 3 * * ')
    await vi.advanceTimersByTimeAsync(200)
    await input.setValue('0 0 3 * * *')
    await settle()
    expect(calls.map((c) => c.params)).toEqual([{ cron: '0 0 2 * * *' }, { cron: '0 0 3 * * *' }])

    // not a cron the server takes (a name): nothing asked, no times
    await input.setValue('0 0 3 * * MON')
    await settle()
    expect(calls).toHaveLength(2)
    expect(w.findAll('.cron-editor__times li')).toHaveLength(0)
  })

  it('shows the server’s reason for a cron it refuses; an older answer arriving late is dropped', async () => {
    let late = (_reply: ReturnType<typeof ok>) => {}
    const next: Route = (c) => {
      const cron = (c.params as { cron: string }).cron
      if (cron === '0 0 1 * * *') return new Promise((r) => (late = r))
      if (cron === '99 * * * * *')
        return [
          400,
          {
            code: 'A0400',
            msg: 'Invalid request',
            data: null,
            errors: [{ path: 'cron', msg: 'Cron expression is invalid' }],
          },
        ]
      return fail(500, 'A0500', 'Server error')
    }
    mockApi({ [NEXT]: next })
    const w = editor('0 0 1 * * *')
    await settle()

    await w.find('input').setValue('99 * * * * *')
    await settle()
    expect(w.find('.cron-editor__error').text()).toBe('Cron expression is invalid')

    // the answer for the first cron comes in after: not shown over the newer state
    late(ok({ times: TIMES }))
    await flushPromises()
    expect(w.findAll('.cron-editor__times li')).toHaveLength(0)
    expect(w.find('.cron-editor__error').text()).toBe('Cron expression is invalid')

    await w.find('input').setValue('0 0 4 * * *')
    await settle()
    expect(w.find('.cron-editor__error').text()).toBe('The next runs could not be loaded')
  })
})
