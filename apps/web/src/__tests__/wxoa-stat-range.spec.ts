// Statistics of an official account (see docs/design-notes.md#wxoa): the shared range contract, the
// four groups loaded once when the page opens, each chart from its dates and metric series with the
// legend translated (the raw key when there is no translation), a failed group shown on its own, and the
// account's API quota opened from the page with the account browse permission.
import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { WXOA_STAT_METRICS, wxoaStatQuery } from '@qiwu/shared'
import enStat from '@/locales/en-US/wxoa.stat.json'
import zhStat from '@/locales/zh-CN/wxoa.stat.json'
import QwChart from '@/core/components/QwChart.vue'
import { dialogs } from '@/core/dialog'
import WxoaAccountQuota from '@/views/platform/wxoa/account/quota.vue'
import StatPage from '@/views/platform/wxoa/stat/index.vue'
import { fail, mockApi, ok } from './mock-api'
import { BASE, sent, useContentPage } from './wxoa-content'

const page = useContentPage()
const DATES = ['2026-10-01', '2026-10-02']
const ROUTES = {
  ...BASE,
  'GET /wxoa/stats/users': ok({
    dates: DATES,
    series: [
      { key: 'new_user', values: [3, 4] },
      { key: 'odd_metric', values: [1, 0] },
    ],
  }),
  'GET /wxoa/stats/messages': ok({ dates: DATES, series: [{ key: 'msg_count', values: [9, 8] }] }),
  'GET /wxoa/stats/interfaces': fail(500, 'B0001'),
  'GET /wxoa/stats/articles': ok({ dates: [], series: [] }),
}

describe('wxoa statistics range', () => {
  it('allows at most 90 complete days', () => {
    expect(
      wxoaStatQuery.safeParse({ accountId: 2, from: '2026-01-01', to: '2026-03-31' }).success,
    ).toBe(true)
    expect(
      wxoaStatQuery.safeParse({ accountId: 2, from: '2026-01-01', to: '2026-04-01' }).success,
    ).toBe(false)
  })
})

describe('metric labels', () => {
  it('every metric key of every group has a label in both languages', () => {
    const keys = Object.values(WXOA_STAT_METRICS).flat()
    for (const locale of [zhStat, enStat]) {
      const labels = locale.wxoa.stat.metric as Record<string, string>
      expect(keys.filter((k) => !labels[k])).toEqual([])
    }
  })
})

describe('statistics page', () => {
  it('loads each group once; charts from the series; a failed group shows its own error', async () => {
    const calls = mockApi(ROUTES)
    const w = await page.show(StatPage)
    await flushPromises()
    for (const g of ['users', 'messages', 'interfaces', 'articles'])
      expect(sent(calls, 'get', `/wxoa/stats/${g}`)).toHaveLength(1)
    expect(sent(calls, 'get', '/wxoa/stats/users')[0]!.params).toMatchObject({ accountId: 2 })

    const charts = w.findAllComponents(QwChart)
    // the failed group has no chart
    expect(charts).toHaveLength(3)
    const users = charts[0]!.props('option') as {
      xAxis: { data: string[] }
      series: { name: string; data: number[] }[]
      legend: { show: boolean }
    }
    expect(users.xAxis.data).toEqual(DATES)
    expect(users.series).toMatchObject([
      { name: 'New users', data: [3, 4] },
      { name: 'odd_metric', data: [1, 0] },
    ])
    expect(users.legend.show).toBe(true)
    expect(w.find('[data-group="interfaces"]').text()).toContain('This group could not be loaded')
    expect(w.find('[data-group="messages"]').text()).not.toContain('could not be loaded')
  })

  it('opens the API quota of the selected account; hidden without wxoa.account.browse', async () => {
    mockApi(ROUTES)
    await page.show(StatPage)
    await page.buttons('API quota')[0]!.trigger('click')
    expect(dialogs[0]!.component).toBe(WxoaAccountQuota)
    expect(dialogs[0]!.props).toEqual({ id: 2 })
    page.perms(['wxoa.stat.browse'])
    await flushPromises()
    expect(page.buttons('API quota')).toHaveLength(0)
  })

  it('the messaging users line says it is summed over message types', () => {
    expect(enStat.wxoa.stat.metric.msg_user).toContain('summed over message types')
    expect(zhStat.wxoa.stat.metric.msg_user).toContain('合计')
  })
})
