import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, type Component } from 'vue'
import ElementPlus, {
  ElDatePicker,
  ElForm,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElPagination,
  ElRadioGroup,
  ElSelect,
  ElSwitch,
  ElTabs,
} from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { dialogs } from '@/core/dialog'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import ClockDashboard from '@/views/oa/attendance/index.vue'
import PolicyPage from '@/views/oa/attendance/policy.vue'
import PolicyForm from '@/views/oa/attendance/PolicyForm.vue'
import SitePage from '@/views/oa/attendance/sites.vue'
import SiteForm from '@/views/oa/attendance/SiteForm.vue'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const wrappers: VueWrapper[] = []
const t = (key: string) => i18n.global.t(key)
const policy = {
  id: 1,
  enabled: true,
  timezone: 'Asia/Shanghai',
  locationMode: 'site',
  retentionDays: 180,
}
const site = {
  id: 4,
  name: 'North office',
  latitude: '31.200000',
  longitude: '121.500000',
  radiusM: 150,
  maxAccuracyM: 40,
  enabled: true,
}
const record = (id = 7) => ({
  id,
  userId: 1,
  deptId: 3,
  employeeName: 'Employee A',
  deptName: 'Operations',
  workDate: '2026-10-22',
  action: 'check_in',
  punchedAt: '2026-10-21T23:30:00Z',
  timezone: 'Asia/Tokyo',
  policyId: 1,
  policySnapshot: policy,
  siteId: 4,
  siteName: 'North office',
  siteSnapshot: site,
  distanceM: 35,
  accuracyM: '12.50',
  validationResult: 'passed',
  source: 'native',
  requestId: 'employee-clock',
})
function identity(perms: string[] = ['*'], features = ['oa']) {
  useAuthStore().me = { ...me(perms), features }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
function render(component: Component, props: Record<string, unknown> = {}) {
  const wrapper = mount(component, {
    props,
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}
function button(wrapper: VueWrapper, key: string) {
  const match = wrapper
    .findAll('button')
    .find((entry) => entry.text() === t(key) && !entry.element.closest('.hidden-columns'))
  if (!match) throw new Error(`Missing button ${key}`)
  return match
}
function input(wrapper: VueWrapper, label: string) {
  return wrapper.get(`input[aria-label="${t(label)}"]`)
}
async function selectScope(wrapper: VueWrapper, scope: string) {
  wrapper.getComponent(ElRadioGroup).vm.$emit('update:modelValue', scope)
  await flushPromises()
}
async function selectTab(wrapper: VueWrapper, tab: string) {
  wrapper.getComponent(ElTabs).vm.$emit('update:modelValue', tab)
  await flushPromises()
}
function clockRoutes(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /oa/clock-records/mine': ok({ items: [record()], total: 65 }),
    'GET /oa/clock-records/admin': ok({ items: [record()], total: 65 }),
    'GET /iam/depts/tree': ok([]),
    ...extra,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  identity()
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  for (const entry of dialogs.splice(0)) entry.settle()
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('attendance record and daily views', () => {
  it('lets employees use their own records without workflow or management permissions', async () => {
    identity([])
    const calls = clockRoutes()
    const wrapper = render(ClockDashboard)
    await flushPromises()
    expect(wrapper.text()).toContain('2026-10-22')
    expect(wrapper.text()).toContain('Asia/Tokyo')
    expect(wrapper.text()).not.toContain(t('oa.attendance.admin'))
    expect(button(wrapper, 'oa.view').exists()).toBe(true)
    expect(calls.some((call) => call.url?.startsWith('/wf/'))).toBe(false)
    expect(calls.some((call) => call.url === '/oa/clock-records/admin')).toBe(false)
    expect(calls.filter((call) => call.method !== 'get')).toHaveLength(0)
  })

  it('does not query disabled features or expose management detail without view permission', async () => {
    identity(['oa.clock.browse'], [])
    const calls = clockRoutes()
    const wrapper = render(ClockDashboard)
    await flushPromises()
    expect(wrapper.text()).toContain(t('oa.attendance.unavailable'))
    expect(calls).toHaveLength(0)
    identity(['oa.clock.browse'])
    await flushPromises()
    await selectScope(wrapper, 'admin')
    expect(wrapper.text()).toContain('Employee A')
    expect(wrapper.findAll('button').some((entry) => entry.text() === t('oa.view'))).toBe(false)
    expect(calls.some((call) => call.url?.includes('/admin/'))).toBe(false)
  })

  it('keeps calendar dates literal, resets paging on searches and strips management filters on scope changes', async () => {
    const calls = clockRoutes()
    const wrapper = render(ClockDashboard)
    await flushPromises()
    await selectScope(wrapper, 'admin')
    const pager = wrapper.getComponent(ElPagination)
    pager.vm.$emit('update:current-page', 3)
    pager.vm.$emit('current-change', 3)
    await flushPromises()
    expect(calls.at(-1)?.params.page).toBe(3)
    wrapper.getComponent(ElDatePicker).vm.$emit('update:modelValue', ['2026-10-21', '2026-10-22'])
    wrapper.getComponent(ElSelect).vm.$emit('update:modelValue', 'check_out')
    wrapper.getComponent(DeptTreeSelect).vm.$emit('update:modelValue', 3)
    await nextTick()
    await button(wrapper, 'crud.action.search').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const admin = calls.filter((call) => call.url === '/oa/clock-records/admin').at(-1)!
    expect(admin.params).toMatchObject({
      page: 1,
      workDateFrom: '2026-10-21',
      workDateTo: '2026-10-22',
      action: 'check_out',
      deptId: 3,
    })
    await selectScope(wrapper, 'mine')
    const mine = calls.filter((call) => call.url === '/oa/clock-records/mine').at(-1)!
    expect(mine.params).toMatchObject({ page: 1 })
    expect(mine.params).not.toHaveProperty('deptId')
    expect(mine.params).not.toHaveProperty('userId')
    expect(mine.params).not.toHaveProperty('workDateFrom')
    expect(mine.params).not.toHaveProperty('action')
  })

  it('ignores delayed management results when permissions change back to employee scope', async () => {
    const held = deferred<ReturnType<typeof ok>>()
    clockRoutes({
      'GET /oa/clock-records/admin': () => held.promise,
      'GET /oa/clock-records/mine': ok({
        items: [{ ...record(), siteName: 'Personal site' }],
        total: 1,
      }),
    })
    const wrapper = render(ClockDashboard)
    await flushPromises()
    await selectScope(wrapper, 'admin')
    identity([])
    await flushPromises()
    held.resolve(ok({ items: [{ ...record(), siteName: 'Private management result' }], total: 1 }))
    await flushPromises()
    expect(wrapper.text()).toContain('Personal site')
    expect(wrapper.text()).not.toContain('Private management result')
    expect(wrapper.text()).not.toContain(t('oa.attendance.admin'))
  })

  it('shows bounded absence coverage, original punch zones and the active-pair total qualification', async () => {
    const daily = {
      workDate: '2026-10-22',
      timezone: 'America/New_York',
      dayStart: '2026-10-22T04:00:00Z',
      dayEnd: '2026-10-23T04:00:00Z',
      items: [
        {
          userId: 1,
          deptId: 3,
          employeeName: 'Employee A',
          deptName: 'Operations',
          checkIn: null,
          checkOut: null,
          recordCount: 0,
          clockTimezones: ['Asia/Tokyo', 'Asia/Shanghai'],
          absences: [
            {
              type: 'leave',
              sourceId: 88,
              state: 'approved',
              startAt: '2026-10-22T05:00:00Z',
              endAt: '2026-10-22T06:00:00Z',
            },
          ],
          absenceCount: 24,
          absencesTruncated: true,
        },
      ],
      total: 1,
    }
    const calls = clockRoutes({ 'GET /oa/clock-summaries/mine': ok(daily) })
    const wrapper = render(ClockDashboard)
    await flushPromises()
    await selectTab(wrapper, 'summary')
    wrapper.getComponent(ElDatePicker).vm.$emit('update:modelValue', '2026-10-22')
    await input(wrapper, 'oa.attendance.summaryTimezone').setValue('America/New_York')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(
      calls.filter((call) => call.url === '/oa/clock-summaries/mine').at(-1)?.params,
    ).toMatchObject({ page: 1, workDate: '2026-10-22', timezone: 'America/New_York' })
    expect(wrapper.text()).toContain(t('oa.attendance.activityHint'))
    expect(wrapper.text()).toContain(t('oa.attendance.utcHint'))
    expect(wrapper.text()).toContain('Asia/Tokyo, Asia/Shanghai')
    expect(wrapper.text()).toContain(
      i18n.global.t('oa.attendance.truncated', { shown: 1, count: 24 }),
    )
    expect(wrapper.text()).toContain(t('oa.attendance.noRecord'))
    expect(wrapper.findAll('a')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('#88')
    expect(wrapper.text()).toContain('2026-10-22T04:00:00Z')
  })

  it('clears old detail before a missing record and never displays precise employee coordinates', async () => {
    let count = 0
    clockRoutes({
      'GET /oa/clock-records/mine/7': () =>
        ++count === 1
          ? ok({
              ...record(),
              latitude: '11.123456',
              longitude: '22.123456',
              locationHash: 'secret-location-hash',
            })
          : fail(404, 'A0440', 'Record is no longer visible'),
    })
    const wrapper = render(ClockDashboard)
    await flushPromises()
    await button(wrapper, 'oa.view').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('12.50')
    expect(document.body.textContent).not.toContain('11.123456')
    expect(document.body.textContent).not.toContain('secret-location-hash')
    wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('update:modelValue', false)
    wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('closed')
    await nextTick()
    await button(wrapper, 'oa.view').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('Record is no longer visible')
    expect(document.body.textContent).not.toContain('12.50')
    expect(ElMessage.error).toHaveBeenCalledWith('Record is no longer visible')
  })

  it('displays management authorization errors and clears the previous table', async () => {
    clockRoutes({ 'GET /oa/clock-records/admin': fail(403, 'A0403', 'Management access denied') })
    const wrapper = render(ClockDashboard)
    await flushPromises()
    await selectScope(wrapper, 'admin')
    expect(wrapper.text()).toContain('Management access denied')
    expect(wrapper.text()).not.toContain('North office')
    expect(ElMessage.error).toHaveBeenCalled()
  })
})

describe('attendance policy configuration', () => {
  it('provides a read-only policy view and clears its stale content after reload fails', async () => {
    identity(['oa.attendance-policy.view'])
    let count = 0
    mockApi({
      'GET /oa/attendance-policies/current': () =>
        ++count === 1 ? ok(policy) : fail(404, 'A0440', 'Policy unavailable'),
    })
    const wrapper = render(PolicyPage)
    await flushPromises()
    expect(wrapper.text()).toContain('Asia/Shanghai')
    expect(wrapper.findAll('button').some((entry) => entry.text() === t('crud.action.edit'))).toBe(
      false,
    )
    await button(wrapper, 'crud.action.refresh').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Asia/Shanghai')
    expect(wrapper.text()).toContain('Policy unavailable')
  })

  it('checks real timezones and retention boundaries before permitting a single pending save', async () => {
    const held = deferred<ReturnType<typeof ok>>()
    const calls = mockApi({
      'GET /oa/attendance-policies/current': ok(policy),
      'PUT /oa/attendance-policies/current': () => held.promise,
    })
    const wrapper = render(PolicyForm)
    await flushPromises()
    const written = () => calls.filter((call) => call.method === 'put')
    await input(wrapper, 'field.oa.attendancePolicy.timezone').setValue('Mars/Olympus')
    await button(wrapper, 'crud.action.save').trigger('click')
    await flushPromises()
    expect(written()).toHaveLength(0)
    await input(wrapper, 'field.oa.attendancePolicy.timezone').setValue('Europe/Paris')
    await input(wrapper, 'field.oa.attendancePolicy.retentionDays').setValue('29')
    await input(wrapper, 'field.oa.attendancePolicy.retentionDays').trigger('change')
    await flushPromises()
    expect(wrapper.getComponent(ElInputNumber).props('modelValue')).toBe(30)
    expect(written()).toHaveLength(0)
    wrapper.getComponent(ElInputNumber).vm.$emit('update:modelValue', 730)
    await nextTick()
    const save = button(wrapper, 'crud.action.save')
    await Promise.all([save.trigger('click'), save.trigger('click')])
    await vi.waitFor(() => expect(written()).toHaveLength(1))
    expect(JSON.parse(written()[0]!.data)).toEqual({
      enabled: true,
      timezone: 'Europe/Paris',
      locationMode: 'site',
      retentionDays: 730,
    })
    expect(
      wrapper.findAll('button').every((entry) => entry.attributes('disabled') !== undefined),
    ).toBe(true)
    expect(
      input(wrapper, 'field.oa.attendancePolicy.timezone').attributes('disabled'),
    ).toBeDefined()
    held.resolve(ok(policy))
    await flushPromises()
    expect(wrapper.emitted('done')).toBeDefined()
  })

  it('enforces read-only permissions in the form and does not load a policy without view access', async () => {
    identity(['oa.attendance-policy.view'])
    const calls = mockApi({ 'GET /oa/attendance-policies/current': ok(policy) })
    const wrapper = render(PolicyForm)
    await flushPromises()
    expect(
      input(wrapper, 'field.oa.attendancePolicy.timezone').attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.findAll('button').some((entry) => entry.text() === t('crud.action.save'))).toBe(
      false,
    )
    identity(['oa.attendance-policy.modify'])
    const denied = render(PolicyForm)
    await flushPromises()
    expect(denied.text()).toContain(t('oa.attendance.notAllowed'))
    expect(calls.filter((call) => call.url?.includes('attendance-policies'))).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toBeDefined()
  })
})

describe('attendance site management', () => {
  it('validates decimal text without rounding invalid coordinates and sends six-decimal canonical values only once', async () => {
    const held = deferred<ReturnType<typeof ok>>()
    const calls = mockApi({ 'POST /oa/attendance-sites': () => held.promise })
    const wrapper = render(SiteForm)
    await input(wrapper, 'field.oa.attendanceSite.name').setValue('West office')
    await input(wrapper, 'field.oa.attendanceSite.longitude').setValue('120.5')
    for (const invalid of ['1e1', '90.000001', '31.1234567']) {
      await input(wrapper, 'field.oa.attendanceSite.latitude').setValue(invalid)
      await button(wrapper, 'crud.action.save').trigger('click')
      await flushPromises()
      expect(calls).toHaveLength(0)
    }
    await input(wrapper, 'field.oa.attendanceSite.latitude').setValue('31.2')
    const save = button(wrapper, 'crud.action.save')
    await Promise.all([save.trigger('click'), save.trigger('click')])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(JSON.parse(calls[0]!.data)).toEqual({
      name: 'West office',
      latitude: '31.200000',
      longitude: '120.500000',
      radiusM: 100,
      maxAccuracyM: 50,
      enabled: true,
    })
    expect(input(wrapper, 'field.oa.attendanceSite.latitude').attributes('disabled')).toBeDefined()
    expect(
      wrapper.findAll('button').every((entry) => entry.attributes('disabled') !== undefined),
    ).toBe(true)
    held.resolve(ok(site))
    await flushPromises()
    expect(wrapper.emitted('done')?.[0]).toMatchObject([{ id: 4 }])
  })

  it('opens existing site details read-only, closes missing details, and never fetches without view permission', async () => {
    mockApi({
      'GET /oa/attendance-sites/4': ok(site),
      'GET /oa/attendance-sites/5': fail(404, 'A0440'),
    })
    const wrapper = render(SiteForm, { id: 4, readonly: true })
    await flushPromises()
    expect(input(wrapper, 'field.oa.attendanceSite.name').element).toHaveProperty(
      'value',
      'North office',
    )
    expect(input(wrapper, 'field.oa.attendanceSite.name').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('button').some((entry) => entry.text() === t('crud.action.save'))).toBe(
      false,
    )
    const missing = render(SiteForm, { id: 5 })
    await flushPromises()
    expect(missing.emitted('cancel')).toBeDefined()
    identity(['oa.attendance-site.modify'])
    const calls = mockApi({ 'GET /oa/attendance-sites/4': ok(site) })
    const denied = render(SiteForm, { id: 4 })
    await flushPromises()
    expect(denied.text()).toContain(t('oa.attendance.notAllowed'))
    expect(calls).toHaveLength(0)
  })

  it('respects separate site permissions and resets filtered pagination', async () => {
    identity(['oa.attendance-site.browse', 'oa.attendance-site.view'])
    const calls = mockApi({ 'GET /oa/attendance-sites': ok({ items: [site], total: 65 }) })
    const wrapper = render(SitePage)
    await flushPromises()
    expect(button(wrapper, 'oa.view').exists()).toBe(true)
    expect(
      wrapper
        .findAll('button')
        .some((entry) =>
          [t('crud.action.create'), t('crud.action.edit'), t('crud.action.delete')].includes(
            entry.text(),
          ),
        ),
    ).toBe(false)
    expect(wrapper.getComponent(ElSwitch).props('disabled')).toBe(true)
    const pager = wrapper.getComponent(ElPagination)
    pager.vm.$emit('update:current-page', 3)
    pager.vm.$emit('current-change', 3)
    await flushPromises()
    expect(calls.filter((call) => call.url === '/oa/attendance-sites').at(-1)?.params.page).toBe(3)
    await input(wrapper, 'field.oa.attendanceSite.name').setValue(' North ')
    wrapper.getComponent(ElSelect).vm.$emit('update:modelValue', 'false')
    await nextTick()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(
      calls.filter((call) => call.url === '/oa/attendance-sites').at(-1)?.params,
    ).toMatchObject({ page: 1, name: 'North', enabled: false })
    await button(wrapper, 'oa.view').trigger('click')
    expect(dialogs.at(-1)?.props).toEqual({ id: 4, readonly: true })
  })

  it('locks every site write while enabling and reports a rejected update', async () => {
    const held = deferred<ReturnType<typeof fail>>()
    const calls = mockApi({
      'GET /oa/attendance-sites': ok({ items: [site], total: 1 }),
      'PUT /oa/attendance-sites/4': () => held.promise,
    })
    const wrapper = render(SitePage)
    await flushPromises()
    wrapper
      .findAllComponents(ElSwitch)
      .find((entry) => entry.props('modelValue') === true)!
      .vm.$emit('change', false)
    await flushPromises()
    expect(calls.filter((call) => call.method === 'put')).toHaveLength(1)
    expect(JSON.parse(calls.find((call) => call.method === 'put')!.data)).toEqual({
      enabled: false,
    })
    expect(
      wrapper
        .findAll('button')
        .filter(
          (entry) =>
            !entry.element.closest('.hidden-columns') &&
            [t('crud.action.create'), t('crud.action.edit'), t('oa.view')].includes(entry.text()),
        )
        .every((entry) => entry.attributes('disabled') !== undefined),
    ).toBe(true)
    held.resolve(fail(403, 'A0403', 'Site update denied'))
    await flushPromises()
    expect(wrapper.text()).toContain('Site update denied')
    expect(wrapper.text()).not.toContain('North office')
    expect(ElMessage.error).toHaveBeenCalled()
  })

  it('cancels a pending delete when the account or permissions change before confirmation', async () => {
    identity(['oa.attendance-site.browse', 'oa.attendance-site.remove'])
    const confirm = deferred<never>()
    vi.spyOn(ElMessageBox, 'confirm').mockReturnValue(confirm.promise)
    const calls = mockApi({
      'GET /oa/attendance-sites': ok({ items: [site], total: 1 }),
      'DELETE /oa/attendance-sites/4': ok(null),
    })
    const wrapper = render(SitePage)
    await flushPromises()
    await button(wrapper, 'crud.action.delete').trigger('click')
    expect(ElMessageBox.confirm).toHaveBeenCalled()
    identity(['oa.attendance-site.browse'])
    await flushPromises()
    confirm.resolve(undefined as never)
    await flushPromises()
    expect(calls.some((call) => call.method === 'delete')).toBe(false)
  })
})

describe('attendance form session boundaries', () => {
  it.each([
    ['policy update', PolicyForm, {}, 'PUT /oa/attendance-policies/current'],
    ['site create', SiteForm, {}, 'POST /oa/attendance-sites'],
    ['site update', SiteForm, { id: 4 }, 'PUT /oa/attendance-sites/4'],
  ] as const)(
    'does not send an old %s after identity changes during validation',
    async (_name, component, props, write) => {
      const held = deferred<boolean>()
      const calls = mockApi({
        'GET /oa/attendance-policies/current': ok(policy),
        'GET /oa/attendance-sites/4': ok(site),
        [write]: ok(site),
      })
      const wrapper = render(component, props)
      await flushPromises()
      if (write.startsWith('POST')) {
        await input(wrapper, 'field.oa.attendanceSite.name').setValue('Valid new office')
        await input(wrapper, 'field.oa.attendanceSite.latitude').setValue('31.200000')
        await input(wrapper, 'field.oa.attendanceSite.longitude').setValue('121.500000')
      }
      // 使用真实表单实例的公开校验入口设置屏障，模拟校验尚未返回时关闭对话框。
      const exposed = wrapper.getComponent(ElForm).vm.$.exposed as {
        validate: () => Promise<boolean>
      }
      const validate = vi.spyOn(exposed, 'validate').mockReturnValue(held.promise)
      await button(wrapper, 'crud.action.save').trigger('click')
      expect(validate).toHaveBeenCalledOnce()
      useAuthStore().me = { ...me(['*']), user: { ...me(['*']).user, id: 2 }, features: ['oa'] }
      accessToken.value = 'second-identity-token'
      await nextTick()
      expect(wrapper.emitted('cancel')).toBeDefined()
      wrapper.unmount()
      wrappers.splice(wrappers.indexOf(wrapper), 1)
      held.resolve(true)
      await flushPromises()
      expect(calls.filter((call) => call.method !== 'get')).toHaveLength(0)
    },
  )

  it('invalidates a closed form even when its session identity never changes', async () => {
    const held = deferred<boolean>()
    const calls = mockApi({
      'GET /oa/attendance-policies/current': ok(policy),
      'PUT /oa/attendance-policies/current': ok(policy),
    })
    const wrapper = render(PolicyForm)
    await flushPromises()
    const exposed = wrapper.getComponent(ElForm).vm.$.exposed as {
      validate: () => Promise<boolean>
    }
    vi.spyOn(exposed, 'validate').mockReturnValue(held.promise)
    await button(wrapper, 'crud.action.save').trigger('click')
    wrapper.unmount()
    wrappers.splice(wrappers.indexOf(wrapper), 1)
    held.resolve(true)
    await flushPromises()
    expect(calls.filter((call) => call.method !== 'get')).toHaveLength(0)
  })
})

describe('attendance reads and confirmations across identities', () => {
  it('closes an open record detail immediately and ignores its late response after a same-permission account switch', async () => {
    const held = deferred<ReturnType<typeof ok>>()
    const calls = clockRoutes({ 'GET /oa/clock-records/mine/7': () => held.promise })
    const wrapper = render(ClockDashboard)
    await flushPromises()
    await button(wrapper, 'oa.view').trigger('click')
    await flushPromises()
    expect(calls.some((call) => call.url === '/oa/clock-records/mine/7')).toBe(true)
    const dialog = wrapper.getComponent({ name: 'ElDialog' })
    expect(dialog.props('modelValue')).toBe(true)
    useAuthStore().me = { ...me(['*']), user: { ...me(['*']).user, id: 2 }, features: ['oa'] }
    await nextTick()
    expect(dialog.props('modelValue')).toBe(false)
    held.resolve(ok({ ...record(), siteSnapshot: { ...site, name: 'Former identity detail' } }))
    await flushPromises()
    expect(dialog.props('modelValue')).toBe(false)
    expect(document.body.textContent).not.toContain('Former identity detail')
    expect(document.body.textContent).not.toContain('12.50')
  })

  it('keeps the new identity policy when the former identity response arrives last', async () => {
    const held = deferred<ReturnType<typeof ok>>()
    let reads = 0
    mockApi({
      'GET /oa/attendance-policies/current': () =>
        ++reads === 1 ? held.promise : ok({ ...policy, timezone: 'Europe/London' }),
    })
    const wrapper = render(PolicyPage)
    await flushPromises()
    expect(reads).toBe(1)
    useAuthStore().me = { ...me(['*']), user: { ...me(['*']).user, id: 2 }, features: ['oa'] }
    await flushPromises()
    expect(reads).toBe(2)
    expect(wrapper.text()).toContain('Europe/London')
    held.resolve(ok({ ...policy, timezone: 'Asia/Tokyo' }))
    await flushPromises()
    expect(wrapper.text()).toContain('Europe/London')
    expect(wrapper.text()).not.toContain('Asia/Tokyo')
  })

  it('keeps the new identity sites when the former identity list arrives last', async () => {
    const held = deferred<ReturnType<typeof ok>>()
    let reads = 0
    mockApi({
      'GET /oa/attendance-sites': () =>
        ++reads === 1
          ? held.promise
          : ok({ items: [{ ...site, name: 'Current identity office' }], total: 1 }),
    })
    const wrapper = render(SitePage)
    await flushPromises()
    expect(reads).toBe(1)
    useAuthStore().me = { ...me(['*']), user: { ...me(['*']).user, id: 2 }, features: ['oa'] }
    await flushPromises()
    expect(reads).toBe(2)
    expect(wrapper.text()).toContain('Current identity office')
    held.resolve(ok({ items: [{ ...site, name: 'Former identity office' }], total: 1 }))
    await flushPromises()
    expect(wrapper.text()).toContain('Current identity office')
    expect(wrapper.text()).not.toContain('Former identity office')
  })

  it('does not delete under a different account that still has the same remove permission', async () => {
    const perms = ['oa.attendance-site.browse', 'oa.attendance-site.remove']
    identity(perms)
    const confirm = deferred<never>()
    vi.spyOn(ElMessageBox, 'confirm').mockReturnValue(confirm.promise)
    const calls = mockApi({
      'GET /oa/attendance-sites': ok({ items: [site], total: 1 }),
      'DELETE /oa/attendance-sites/4': ok(null),
    })
    const wrapper = render(SitePage)
    await flushPromises()
    await button(wrapper, 'crud.action.delete').trigger('click')
    expect(ElMessageBox.confirm).toHaveBeenCalledOnce()
    useAuthStore().me = { ...me(perms), user: { ...me(perms).user, id: 2 }, features: ['oa'] }
    accessToken.value = 'second-identity-token'
    await flushPromises()
    expect(useAuthStore().hasPerm('oa.attendance-site.remove')).toBe(true)
    confirm.resolve(undefined as never)
    await flushPromises()
    expect(calls.filter((call) => call.method === 'delete')).toHaveLength(0)
  })
})
