import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import dayjs from 'dayjs'
import { init, use } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { BarChart } from 'echarts/charts'
import { GridComponent, LegendComponent } from 'echarts/components'
import QwChart from '@/core/components/QwChart.vue'
import AppLogo from '@/core/layout/AppLogo.vue'
import {
  chartLocale,
  currentLocale,
  detectLocale,
  elementLocale,
  formLocale,
  i18n,
  localized,
  setLocale,
  tx,
} from '@/core/i18n'

const t = i18n.global.t

afterEach(() => {
  setLocale('zh-CN')
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('setLocale', () => {
  it('switches vue-i18n, Element Plus, form-create, dayjs, <html lang> and localStorage together', () => {
    setLocale('en-US')
    expect(currentLocale()).toBe('en-US')
    expect(t('common.app.title')).toBe('Qiwu Admin')
    expect(elementLocale.value.name).toBe('en')
    expect(formLocale.value).toBe('en')
    expect(dayjs.locale()).toBe('en')
    expect(document.documentElement.lang).toBe('en-US')
    expect(localStorage.getItem('qw.locale')).toBe('en-US')

    setLocale('zh-CN')
    expect(t('common.app.title')).toBe('栖梧管理系统')
    expect(elementLocale.value.name).toBe('zh-cn')
    expect(formLocale.value).toBe('zh-cn')
    expect(dayjs.locale()).toBe('zh-cn')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('gives ECharts the language: charts built with chartLocale show its built-in texts', () => {
    use([SVGRenderer, BarChart, GridComponent, LegendComponent])
    // server-side SVG render of a legend with its all / inverse selector buttons (built-in texts)
    const render = () => {
      const chart = init(null, null, {
        renderer: 'svg',
        ssr: true,
        width: 400,
        height: 200,
        locale: chartLocale.value,
      })
      chart.setOption({
        legend: { selector: true },
        xAxis: { type: 'category', data: ['a'] },
        yAxis: {},
        series: [{ type: 'bar', name: 's', data: [1] }],
      })
      const svg = chart.renderToSVGString()
      chart.dispose()
      return svg
    }
    setLocale('en-US')
    expect(chartLocale.value).toBe('EN')
    expect(render()).toContain('>All<')
    setLocale('zh-CN')
    expect(chartLocale.value).toBe('ZH')
    expect(render()).toContain('>全选<')
  })

  it('rebuilds QwChart charts in the new language (their :key)', async () => {
    setActivePinia(createPinia())
    setLocale('en-US')
    const chart = mount(QwChart, {
      props: {
        title: 'Memory',
        option: { series: [{ type: 'gauge', data: [{ value: 25, name: 'used' }] }] },
      },
      attachTo: document.body,
    })
    await flushPromises()
    // the aria description ECharts generates from its locale texts
    const label = () => chart.find('[aria-label]').attributes('aria-label') ?? ''
    expect(label()).toContain('This is a chart about "Memory"')
    setLocale('zh-CN')
    await flushPromises()
    expect(label()).toContain('这是一个关于“Memory”的图表')
    chart.unmount()
  })

  it('merges every locale namespace plus the shared validation/field messages', () => {
    expect(i18n.global.te('settings.dict.entity', 'en-US')).toBe(true)
    expect(i18n.global.te('validation.required', 'en-US')).toBe(true)
    expect(i18n.global.te('validation.required', 'zh-CN')).toBe(true)
  })

  it('deep-merges module fragments (web iam.position.json, shared modules/iam.position.json)', () => {
    setLocale('en-US')
    expect(t('menu.iam.position')).toBe('Positions')
    expect(t('menu.system.title')).toBe('System') // menu.json keeps its own keys
    expect(t('iam.position.entity')).toBe('position')
    expect(t('iam.user.entity')).toBe('user')
    expect(t('field.iam.position.code')).toBe('Position code')
    expect(t('field.iam.user.username')).toBe('Username')
  })
})

describe('detectLocale', () => {
  const lang = (v: string) => vi.spyOn(navigator, 'language', 'get').mockReturnValue(v)

  it('prefers localStorage, then navigator.language, then zh-CN', () => {
    lang('en-GB')
    expect(detectLocale()).toBe('en-US')
    localStorage.setItem('qw.locale', 'zh-CN')
    expect(detectLocale()).toBe('zh-CN')
    localStorage.setItem('qw.locale', 'xx')
    expect(detectLocale()).toBe('en-US')
    lang('fr-FR')
    expect(detectLocale()).toBe('zh-CN')
    lang('EN-us')
    expect(detectLocale()).toBe('en-US')
  })
})

describe('tx / localized', () => {
  it('translates keys, passes plain text through and prefers *_i18n values', () => {
    setLocale('en-US')
    expect(tx('common.action.signIn')).toBe('Sign in')
    expect(tx('Admin-made name')).toBe('Admin-made name')
    expect(localized({ 'en-US': 'Male', 'zh-CN': '男' }, 'x')).toBe('Male')
    expect(localized({ 'zh-CN': '男' }, 'Male (fallback)')).toBe('Male (fallback)')
    expect(localized(null, 'common.action.signOut')).toBe('Sign out')
  })
})

describe('AppLogo wordmark', () => {
  it('reads as the browser-title brand in both locales, the suffix in its own lighter span', async () => {
    const logo = mount(AppLogo, {
      global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } },
    })
    for (const [locale, text, suffix] of [
      ['zh-CN', '栖梧管理系统', '管理系统'],
      ['en-US', 'Qiwu Admin', 'Admin'],
    ] as const) {
      setLocale(locale)
      await flushPromises()
      expect(logo.find('.app-logo__text').text()).toBe(text)
      expect(logo.find('.app-logo__suffix').text()).toBe(suffix)
      expect(t('common.app.title')).toBe(text)
    }
    logo.unmount()
  })
})
