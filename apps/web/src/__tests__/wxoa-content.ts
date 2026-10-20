// Test helper (not a spec): mounting the official account content pages (drafts, publishing, mass
// send, statistics, notices) against the fake backend, with the account list and dicts they read.
import { afterEach, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { WxoaAccountOption, WxoaDraftArticle } from '@qiwu/shared'
import type { WxoaDraftVo } from '@/api/platform/wxoa/draft'
import { dialogs } from '@/core/dialog'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import { me, ok, type Route } from './mock-api'

export const AT = '2026-10-06T01:00:00.000Z'
export const OPTIONS: WxoaAccountOption[] = [
  { id: 2, label: 'Shop', accountKind: 'service', verified: true, enabled: true },
  { id: 3, label: 'Sandbox', accountKind: 'sandbox', verified: false, enabled: true },
]
export const article = (p: Partial<WxoaDraftArticle> = {}): WxoaDraftArticle => ({
  title: 'Spring news',
  author: '',
  digest: '',
  content: '<p>hello</p>',
  contentSourceUrl: '',
  thumbMediaId: 'thumb-1',
  needOpenComment: true,
  onlyFansCanComment: false,
  ...p,
})
export const draftVo = (id: number, p: Partial<WxoaDraftVo> = {}): WxoaDraftVo => ({
  id,
  accountId: 2,
  title: `Draft ${id}`,
  articles: [article({ title: `Draft ${id}` })],
  mediaId: `media-${id}`,
  origin: 'local',
  syncedAt: AT,
  syncedDigest: 'digest',
  dirty: false,
  createdAt: AT,
  updatedAt: AT,
  ...p,
})
const entries = (...pairs: [string, string][]) =>
  ok({ version: 1, entries: pairs.map(([value, label]) => ({ value, label, labelI18n: null })) })
export const BASE: Record<string, Route> = {
  'GET /wxoa/accounts/options': ok(OPTIONS),
  'GET /settings/dicts/wxoa.account_kind/entries': entries(['service', 'Service account']),
  'GET /settings/dicts/wxoa.publish_state/entries': entries(
    ['publishing', 'Publishing'],
    ['succeeded', 'Published'],
  ),
  'GET /settings/dicts/wxoa.mass_state/entries': entries(['submitted', 'Submitted']),
  'GET /settings/dicts/wxoa.mass_target/entries': entries(['all', 'All fans'], ['tag', 'By tag']),
  'GET /iam/profile/prefs/table.wxoa.draft': ok({ value: null }),
  'GET /iam/profile/prefs/table.wxoa.publish': ok({ value: null }),
  'GET /iam/profile/prefs/table.wxoa.mass': ok({ value: null }),
  'GET /iam/profile/prefs/table.wxoa.notice': ok({ value: null }),
}

type Call = { method?: string; url?: string; params?: unknown; data?: unknown }
export const sent = (calls: Call[], method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url)
export const body = (c: Call | undefined) => JSON.parse(String(c?.data)) as Record<string, unknown>

/** Registers the per-test setup: English, a user holding `perms` by default, a fresh account list. */
export function useContentPage() {
  let w: VueWrapper | undefined
  beforeEach(() => {
    setActivePinia(createPinia())
    setLocale('en-US')
    accessToken.value = 'at'
    localStorage.clear()
    useAuthStore().me = me(['*'])
    useWxoaAccount().options.value = []
    vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
    vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
    vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
  })
  afterEach(() => {
    w?.unmount()
    w = undefined
    dialogs.splice(0)
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    setLocale('zh-CN')
  })
  return {
    /** the user holds only these permissions */
    perms: (list: string[]) => (useAuthStore().me = me(list)),
    async show(component: object, props: Record<string, unknown> = {}) {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/', component: { render: () => null } }],
      })
      w = mount(component, {
        props,
        global: {
          plugins: [ElementPlus, i18n, router],
          directives: { perm: vPerm },
          stubs: { QwChart: true, RichEditor: true, HtmlFrame: true },
        },
        attachTo: document.body,
      })
      await flushPromises()
      return w
    },
    /** the visible buttons labelled `text` */
    buttons: (text: string) =>
      w!.findAll('button').filter((b) => b.text() === text && b.isVisible()),
    confirm: () => vi.spyOn(ElMessageBox, 'confirm'),
  }
}
