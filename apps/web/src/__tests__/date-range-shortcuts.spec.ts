import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ElementPlus, { ElDatePicker } from 'element-plus'
import dayjs from 'dayjs'
import { DATE_RANGE_SHORTCUTS, type useDateRangeShortcuts } from '@/core/date-shortcuts'
import { listParams } from '@/core/composables/use-crud'
import { i18n, setLocale } from '@/core/i18n'
import UserPage from '@/views/platform/iam/user/index.vue'
import ActionLogPage from '@/views/platform/audit/action-log/index.vue'
import { mockApi, ok } from './mock-api'

const wrappers: VueWrapper[] = []
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllEnvs()
  setLocale('zh-CN')
})

const local = (date: Date) => dayjs(date).format('YYYY-MM-DD HH:mm:ss.SSS')

describe('date range shortcuts', () => {
  it.each([
    ['2024-03-01', ['2024-03-01', '2024-02-24', '2024-02-01']],
    ['2025-03-01', ['2025-03-01', '2025-02-23', '2025-01-31']],
    ['2026-01-01', ['2026-01-01', '2025-12-26', '2025-12-03']],
  ])('inclusive local bounds at %s (month, leap day and year boundaries)', (today, starts) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T12:34:56`))
    expect(DATE_RANGE_SHORTCUTS).toHaveLength(3)
    DATE_RANGE_SHORTCUTS.forEach(({ value }, i) => {
      const [start, end] = value()
      expect(local(start)).toBe(`${starts[i]} 00:00:00.000`)
      expect(local(end)).toBe(`${today} 23:59:59.999`)
      expect(value()[0]).not.toBe(start)
    })
  })

  it('uses click time after midnight, rather than import or first render time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const value = DATE_RANGE_SHORTCUTS[0].value
    vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 59))
    expect(local(value()[0])).toBe('2026-10-03 00:00:00.000')
    vi.setSystemTime(new Date(2026, 9, 4, 0, 0, 1))
    expect(local(value()[0])).toBe('2026-10-04 00:00:00.000')
  })

  it.each([
    ['2026-03-09', '2026-03-03', '2026-02-08', 60],
    ['2026-11-02', '2026-10-27', '2026-10-04', -60],
  ])('uses calendar days across DST at %s', (today, week, month, offsetChange) => {
    vi.stubEnv('TZ', 'America/New_York')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T00:30:00`))
    for (const [i, expected] of [
      [1, week],
      [2, month],
    ] as const) {
      const [start, end] = DATE_RANGE_SHORTCUTS[i].value()
      expect(local(start)).toBe(`${expected} 00:00:00.000`)
      expect(local(end)).toBe(`${today} 23:59:59.999`)
      expect(start.getTimezoneOffset() - end.getTimezoneOffset()).toBe(offsetChange)
    }
  })

  it.each([UserPage, ActionLogPage])(
    'handwritten page binds shared values, updates labels, and submits whole days',
    async (Page) => {
      const calls = mockApi({
        'GET /iam/users': ok({ items: [], total: 0 }),
        'GET /audit/action-logs': ok({ items: [], total: 0 }),
        'GET /iam/depts/tree': ok([]),
      })
      const w = mount(Page, {
        global: {
          plugins: [ElementPlus, i18n],
          directives: { perm: () => undefined },
          stubs: {
            TreePanel: { template: '<div><slot /></div>' },
            DictSelect: true,
            QwTable: true,
            TableToolbar: true,
            Pagination: true,
          },
        },
        attachTo: document.body,
      })
      wrappers.push(w)
      await flushPromises()
      const picker = w.findComponent(ElDatePicker)
      const shortcuts = () =>
        picker.props('shortcuts') as ReturnType<typeof useDateRangeShortcuts>['value']
      expect(shortcuts().map((s) => s.text)).toEqual(['Today', 'Last 7 days', 'Last 30 days'])
      expect(shortcuts().map((s) => s.value)).toEqual(DATE_RANGE_SHORTCUTS.map((s) => s.value))
      setLocale('zh-CN')
      await nextTick()
      expect(shortcuts().map((s) => s.text)).toEqual(
        DATE_RANGE_SHORTCUTS.map((s) => i18n.global.t(s.labelKey)),
      )
      expect(shortcuts()[0]!.text).not.toBe('Today')
      setLocale('en-US')
      await nextTick()
      await picker.find('input').trigger('click')
      await flushPromises()
      const button = document.querySelector<HTMLButtonElement>('.el-picker-panel__shortcut')!
      expect(button.textContent).toBe('Today')
      button.click()
      await flushPromises()
      const date = dayjs().format('YYYY-MM-DD')
      expect(picker.props('modelValue')).toEqual([date, date])
      await w.find('form').trigger('submit')
      await flushPromises()
      const params = calls
        .filter((c) => c.url === (Page === UserPage ? '/iam/users' : '/audit/action-logs'))
        .at(-1)!.params
      expect(params).toMatchObject(listParams({ createdAtRange: [date, date] }))
      expect(params.createdAtFrom).toBe(dayjs(date).startOf('day').toISOString())
      expect(params.createdAtTo).toBe(dayjs(date).endOf('day').toISOString())
      expect(listParams({ publishedOnDates: [date, date] })).toEqual({
        publishedOnFrom: date,
        publishedOnTo: date,
      })
    },
  )
})
