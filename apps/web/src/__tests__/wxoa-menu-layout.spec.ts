// Custom menu editor of an official account (see docs/design-notes.md#wxoa): the 3 × 5 button tree and
// its moves, byte counts by the shared function, a request carrying only each kind's fields, retired kinds
// kept or removed but never changed, the confirmed publish / pull / clear and the unpublished notice.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { defineComponent, h, KeepAlive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import {
  utf8Bytes,
  wxoaMenuCreate,
  wxoaMenuPullResult,
  wxoaMenuTryMatchVo,
  wxoaMenuUpdateFor,
  type WxoaAccountOption,
  type WxoaButton,
  type WxoaMenuVo,
} from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import MenuPage from '@/views/platform/wxoa/menu/index.vue'
import TryMatch from '@/views/platform/wxoa/menu/try-match.vue'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import {
  addSub,
  addTop,
  canAddSub,
  canMove,
  issueSlot,
  moveBy,
  nameBytes,
  removeAt,
  toButtons,
  toDraft,
  type DraftButton,
} from '@/views/platform/wxoa/menu/menu-layout'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const cjk = (n: number) => '菜'.repeat(n)
const click = (name: string, key = 'k'): DraftButton => ({ name, kind: 'click', key })

describe('menu layout', () => {
  it('at most 3 buttons of at most 5 sub-buttons; the first sub-button makes a parent', () => {
    const buttons: DraftButton[] = []
    expect([addTop(buttons), addTop(buttons), addTop(buttons)]).toEqual([
      { i: 0 },
      { i: 1 },
      { i: 2 },
    ])
    expect(addTop(buttons)).toBeNull()
    expect(buttons).toHaveLength(3)

    buttons[0] = { name: 'Shop', kind: 'view', url: 'https://example.com/' }
    const slots = [1, 2, 3, 4, 5].map(() => addSub(buttons, 0))
    expect(slots.at(-1)).toEqual({ i: 0, j: 4 })
    expect(addSub(buttons, 0)).toBeNull()
    expect(canAddSub(buttons[0]!)).toBe(false)
    // a parent sends its name and sub-buttons only
    expect(toButtons(buttons)[0]).toEqual({
      name: 'Shop',
      subButtons: Array.from({ length: 5 }, () => ({ name: '', kind: 'click' })),
    })

    // removing the last sub-button gives the button back its own kind and link
    let at = removeAt(buttons, { i: 0, j: 4 })
    expect(at).toEqual({ i: 0, j: 3 })
    for (let n = 0; n < 4; n++) at = removeAt(buttons, at!)
    expect(at).toEqual({ i: 0 })
    expect(toButtons(buttons)[0]).toEqual({
      name: 'Shop',
      kind: 'view',
      url: 'https://example.com/',
    })
    // a parent pulled without a kind becomes a click button
    const pulled = toDraft([{ name: 'P', subButtons: [{ name: 's', kind: 'click', key: 'k' }] }])
    removeAt(pulled, { i: 0, j: 0 })
    expect(pulled[0]!.kind).toBe('click')

    expect(removeAt(buttons, { i: 2 })).toEqual({ i: 1 })
    expect(removeAt(buttons, { i: 0 })).toEqual({ i: 0 })
    expect(removeAt(buttons, { i: 0 })).toBeNull()
  })

  it('moves a button among its siblings only, never past either end', () => {
    const buttons = [
      click('a'),
      { name: 'p', subButtons: [click('x'), click('y'), click('z')] },
      click('c'),
    ]
    expect(moveBy(buttons, { i: 0 }, 1)).toEqual({ i: 1 })
    expect(buttons.map((b) => b.name)).toEqual(['p', 'a', 'c'])
    expect(canMove(buttons, { i: 2 }, 1)).toBe(false)
    expect(moveBy(buttons, { i: 2 }, 1)).toEqual({ i: 2 })

    expect(moveBy(buttons, { i: 0, j: 2 }, -1)).toEqual({ i: 0, j: 1 })
    expect(buttons[0]!.subButtons!.map((b) => b.name)).toEqual(['x', 'z', 'y'])
    expect(canMove(buttons, { i: 0, j: 0 }, -1)).toBe(false)
    expect(moveBy(buttons, { i: 0, j: 0 }, -1)).toEqual({ i: 0, j: 0 })
    expect(buttons.map((b) => b.name)).toEqual(['p', 'a', 'c'])
  })

  it('sends only the fields of the kind; a blank one is missing, not empty', () => {
    const b: DraftButton = { name: 'Go', kind: 'view', url: 'https://example.com/', key: 'old' }
    expect(toButtons([b])).toEqual([{ name: 'Go', kind: 'view', url: 'https://example.com/' }])
    b.kind = 'miniprogram'
    b.appId = 'wx0123456789abcdef'
    b.pagePath = ''
    expect(toButtons([b])).toEqual([
      { name: 'Go', kind: 'miniprogram', url: 'https://example.com/', appId: 'wx0123456789abcdef' },
    ])
    const issues = wxoaMenuCreate.safeParse({
      accountId: 1,
      menuKind: 'default',
      label: 'M',
      buttons: toButtons([b]),
    }).error!.issues
    expect(issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['buttons.0.pagePath', 'validation.required'],
    ])
    expect(issueSlot(issues[0]!.path)).toEqual({ slot: { i: 0 }, prop: 'pagePath' })
    expect(issueSlot(['buttons', 1, 'subButtons', 3, 'name'])).toEqual({
      slot: { i: 1, j: 3 },
      prop: 'name',
    })
    expect(issueSlot(['label'])).toBeNull()
  })

  it('counts name bytes as the shared schema does (trimmed UTF-8)', () => {
    expect(nameBytes({ name: ` ${cjk(5)} ` })).toBe(15)
    expect(nameBytes({ name: cjk(6) })).toBe(utf8Bytes(cjk(6)))
    expect(nameBytes({ name: '😀' })).toBe(4)
  })

  it('a retired-kind button: kept or moved passes, changed or given sub-buttons does not', () => {
    const stored: WxoaButton[] = [
      { name: 'Old', kind: 'media_id', mediaId: 'MID' },
      { name: 'New', kind: 'click', key: 'k' },
    ]
    const schema = wxoaMenuUpdateFor({ menuKind: 'default', buttons: stored })
    const put = (buttons: DraftButton[]) =>
      schema.safeParse({ label: 'M', buttons: toButtons(buttons) }).success

    const draft = toDraft(stored)
    expect(put(draft)).toBe(true)
    moveBy(draft, { i: 0 }, 1)
    expect(put(draft)).toBe(true)
    expect(canAddSub(draft[1]!)).toBe(false)
    expect(addSub(draft, 1)).toBeNull()
    draft[1]!.name = 'Renamed'
    expect(put(draft)).toBe(false)
    expect(put([draft[0]!])).toBe(true)
  })
})

const AT = '2026-10-06T01:00:00.000Z'
const OPTIONS: WxoaAccountOption[] = [
  { id: 5, label: 'Shop', accountKind: 'service', verified: true, enabled: true },
]
const menuRow = (p: Partial<WxoaMenuVo> & Pick<WxoaMenuVo, 'id'>): WxoaMenuVo => ({
  accountId: 5,
  menuKind: 'default',
  label: 'Main',
  matchTagId: null,
  matchPlatform: null,
  buttons: [{ name: 'Hello', kind: 'click', key: 'hello' }],
  wxMenuId: null,
  publishedAt: AT,
  unpublished: false,
  createdAt: AT,
  updatedAt: AT,
  ...p,
})
const entries = (...pairs: [string, string][]) =>
  ok({ version: 1, entries: pairs.map(([value, label]) => ({ value, label, labelI18n: null })) })
const BASE: Record<string, Route> = {
  'GET /wxoa/accounts/options': ok(OPTIONS),
  'GET /settings/dicts/wxoa.account_kind/entries': entries(['service', 'Service account']),
  'GET /settings/dicts/wxoa.button_kind/entries': entries(
    ['click', 'Click event'],
    ['view', 'Open a web page'],
    ['media_id', 'Material message (retired)'],
  ),
  'GET /settings/dicts/wxoa.client_platform/entries': entries(['ios', 'iOS']),
  'GET /wxoa/tags': ok([{ id: 1, accountId: 5, tagId: 100, name: 'VIP', fanCount: 3 }]),
}
const body = (c: { data?: unknown } | undefined) =>
  JSON.parse(String(c?.data)) as Record<string, unknown>
const sent = <C extends { method?: string; url?: string }>(
  calls: C[],
  method: string,
  url: string,
) => calls.filter((c) => c.method === method && c.url === url)

let w: VueWrapper
async function show(component: object, props: Record<string, unknown> = {}) {
  w = mount(component, {
    props,
    global: {
      plugins: [
        ElementPlus,
        i18n,
        createRouter({
          history: createMemoryHistory(),
          routes: [{ path: '/', component: { render: () => null } }],
        }),
      ],
      directives: { perm: vPerm },
    },
    attachTo: document.body,
  })
  await flushPromises()
}
const item = (label: string) =>
  w.findAll('.el-form-item').find((i) => i.find('.el-form-item__label').text() === label)
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
const tops = () => w.findAll('.phone__top:not(.phone__add)')
async function press(text: string) {
  await button(text)!.trigger('click')
  await flushPromises()
}
let confirm: Mock<() => Promise<string>>

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  localStorage.clear()
  useAuthStore().me = me(['*'])
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
  confirm = vi.fn<() => Promise<string>>().mockResolvedValue('confirm')
  vi.spyOn(ElMessageBox, 'confirm').mockImplementation(confirm as never)
})
afterEach(() => {
  w?.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('menu page', () => {
  it('3 × 5 in the phone preview; a name over its bytes is counted and blocks the save', async () => {
    const calls = mockApi({ ...BASE, 'GET /wxoa/menus': ok([]) })
    await show(MenuPage)
    expect(sent(calls, 'get', '/wxoa/menus')[0]?.params).toEqual({ accountId: 5 })
    expect(w.find('.empty-state').text()).toContain('No menus yet')

    await press('Add the default menu')
    for (let n = 0; n < 3; n++) await w.find('[aria-label="Add a button"]').trigger('click')
    expect(tops()).toHaveLength(3)
    expect(w.find('[aria-label="Add a button"]').exists()).toBe(false)
    for (let n = 0; n < 5; n++) await w.find('[aria-label="Add a sub-button"]').trigger('click')
    expect(w.findAll('.phone__subs .phone__btn')).toHaveLength(5)

    await tops()[0]!.trigger('click')
    const name = item('Button name')!
    await name.find('input').setValue(cjk(6))
    expect(name.find('.bytes').text()).toBe('18/16 bytes')
    expect(name.find('.bytes').classes()).toContain('is-over')
    await name.find('input').setValue(cjk(5))
    expect(name.find('.bytes').text()).toBe('15/16 bytes')
    expect(name.find('.bytes').classes()).not.toContain('is-over')
    await name.find('input').setValue(cjk(6))

    await press('Save')
    expect(sent(calls, 'post', '/wxoa/menus')).toHaveLength(0)
    expect(ElMessage.error).toHaveBeenCalledWith('Please fix the marked problems first')
    // el-form-item shows an error after a short debounce
    await vi.waitFor(() =>
      expect(item('Button name')!.text()).toContain('Button name must be at most 16 bytes'),
    )
    expect(tops()[0]!.classes()).toContain('is-invalid')
    // the selected and the faulty button are told to screen readers too
    expect(tops().map((b) => b.attributes('aria-current'))).toEqual(['true', undefined, undefined])
    expect(tops()[0]!.attributes('aria-invalid')).toBe('true')
    expect(tops()[0]!.find('.phone__problem').text()).toBe('(has a problem)')

    // the same on a sub-button (the five were added under the third button); once one is
    // selected no top button is the current one
    const subs = () => w.findAll('.phone__subs .phone__btn:not(.phone__add)')
    await tops()[2]!.trigger('click')
    await subs()[0]!.trigger('click')
    await item('Button name')!.find('input').setValue('Fine')
    await item('Button key')!.find('input').setValue('fine')
    await subs()[1]!.trigger('click')
    await item('Button name')!.find('input').setValue(cjk(21))
    expect(tops().map((b) => b.attributes('aria-current'))).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(subs().map((s) => s.attributes('aria-current'))).toEqual([
      undefined,
      'true',
      undefined,
      undefined,
      undefined,
    ])
    expect(subs()[0]!.attributes('aria-invalid')).toBeUndefined()
    expect(subs()[1]!.attributes('aria-invalid')).toBe('true')
    expect(subs()[0]!.find('.phone__problem').exists()).toBe(false)
    expect(subs()[1]!.find('.phone__problem').text()).toBe('(has a problem)')
  })

  it('a new default menu posts the account and kind; the saved one opens', async () => {
    let saved: WxoaMenuVo[] = []
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/menus': () => ok(saved),
      'POST /wxoa/menus': () => {
        saved = [menuRow({ id: 11, publishedAt: null, unpublished: true })]
        return ok({ id: 11 })
      },
    })
    await show(MenuPage)
    await press('Add the default menu')
    await w.find('[aria-label="Add a button"]').trigger('click')
    await item('Button name')!.find('input').setValue(' Hello ')
    await item('Button key')!.find('input').setValue('hello')
    await press('Save')

    expect(body(sent(calls, 'post', '/wxoa/menus')[0])).toEqual({
      accountId: 5,
      menuKind: 'default',
      label: 'Default menu',
      matchTagId: null,
      matchPlatform: null,
      buttons: [{ name: 'Hello', kind: 'click', key: 'hello' }],
    })
    expect(w.text()).toContain('Not published yet')
    expect(button('Publish')!.attributes('disabled')).toBeUndefined()
  })

  it('edit: a PUT without account or kind; publishing waits for the save and is confirmed', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/menus': ok([menuRow({ id: 3 })]),
      'PUT /wxoa/menus/3': ok(null),
      'POST /wxoa/menus/3/publish': ok(null),
    })
    await show(MenuPage)
    expect(w.text()).toContain('Published at')

    await item('Button key')!.find('input').setValue('hi')
    expect(w.text()).toContain('There are unsaved changes')
    expect(button('Publish')!.attributes('disabled')).toBeDefined()
    await press('Save')
    expect(body(sent(calls, 'put', '/wxoa/menus/3')[0])).toEqual({
      label: 'Main',
      matchTagId: null,
      matchPlatform: null,
      buttons: [{ name: 'Hello', kind: 'click', key: 'hi' }],
    })

    await press('Publish')
    expect(confirm).toHaveBeenCalledOnce()
    expect(sent(calls, 'post', '/wxoa/menus/3/publish')).toHaveLength(1)
    expect(ElMessage.success).toHaveBeenCalledWith('Published')
  })

  it('shows unpublished changes; a declined confirm sends nothing', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/menus': ok([menuRow({ id: 3, unpublished: true })]),
    })
    await show(MenuPage)
    expect(w.text()).toContain('There are unpublished changes')
    expect(w.find('.menu-item__state').text()).toBe('Unpublished changes')

    confirm.mockRejectedValue('cancel')
    await press('Publish')
    await press('Pull from WeChat')
    await press('Clear live menus')
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
  })

  it('a retired-kind button is shown read-only and can be removed', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/menus': ok([
        menuRow({
          id: 3,
          buttons: [
            { name: 'Old', kind: 'media_id', mediaId: 'MID' },
            { name: 'Hello', kind: 'click', key: 'hello' },
          ],
        }),
      ]),
      'PUT /wxoa/menus/3': ok(null),
    })
    await show(MenuPage)
    expect(tops()[0]!.classes()).toContain('is-legacy')
    expect(w.text()).toContain('This button kind is retired')
    expect(item('Button name')!.find('input').exists()).toBe(false)
    expect(item('Material media_id')!.text()).toContain('MID')
    // no sub-button for it, and the kind list offers no retired kind
    expect(w.find('[aria-label="Add a sub-button"]').exists()).toBe(false)

    // kept and moved: saved as it was
    await press('Move later')
    await press('Save')
    expect(body(sent(calls, 'put', '/wxoa/menus/3')[0]).buttons).toEqual([
      { name: 'Hello', kind: 'click', key: 'hello' },
      { name: 'Old', kind: 'media_id', mediaId: 'MID' },
    ])

    // reloaded in the stored order: the retired one first
    await tops()[0]!.trigger('click')
    await press('Remove button')
    expect(tops().map((b) => b.text())).toEqual(['Hello'])
  })

  it('conditional menus: listed with their match; one without a match is not saved', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/menus': ok([
        menuRow({ id: 3 }),
        menuRow({
          id: 4,
          menuKind: 'conditional',
          label: 'VIPs',
          matchTagId: 100,
          matchPlatform: 'ios',
          wxMenuId: '401',
        }),
      ]),
    })
    await show(MenuPage)
    expect(w.findAll('.menu-item')[1]!.text()).toContain('Tag: VIP · Platform: iOS')
    expect(w.findAll('.menu-item').map((m) => m.attributes('aria-current'))).toEqual([
      'true',
      undefined,
    ])
    await w.findAll('.menu-item')[1]!.trigger('click')
    await flushPromises()
    expect(w.findAll('.menu-item').map((m) => m.attributes('aria-current'))).toEqual([
      undefined,
      'true',
    ])

    await press('Add a conditional menu')
    await item('Menu name')!.find('input').setValue('Android')
    await w.find('[aria-label="Add a button"]').trigger('click')
    await item('Button name')!.find('input').setValue('Hi')
    await item('Button key')!.find('input').setValue('hi')
    await press('Save')
    expect(sent(calls, 'post', '/wxoa/menus')).toHaveLength(0)
    await vi.waitFor(() =>
      expect(item('Matched tag')!.text()).toContain(
        'A conditional menu needs a tag or a client platform to match',
      ),
    )

    // leaving it asks first
    confirm.mockRejectedValueOnce('cancel')
    await w.findAll('.menu-item')[0]!.trigger('click')
    await flushPromises()
    expect(item('Menu name')!.find('input').element.value).toBe('Android')
  })

  it('switching the account with unsaved changes asks first and stays when declined', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/accounts/options': ok([
        ...OPTIONS,
        { id: 6, label: 'News', accountKind: 'service', verified: true, enabled: true },
      ]),
      'GET /wxoa/menus': (c) => ok([menuRow({ id: c.params.accountId === 6 ? 8 : 3 })]),
    })
    await show(MenuPage)
    const state = useWxoaAccount()
    await item('Button key')!.find('input').setValue('changed')

    confirm.mockRejectedValueOnce('cancel')
    state.accountId.value = 6
    await flushPromises()
    expect(state.accountId.value).toBe(5)
    expect(item('Button key')!.find('input').element.value).toBe('changed')
    expect(calls.filter((c) => c.url === '/wxoa/menus').map((c) => c.params)).toEqual([
      { accountId: 5 },
    ])

    state.accountId.value = 6
    await flushPromises()
    expect(state.accountId.value).toBe(6)
    expect(item('Button key')!.find('input').element.value).toBe('hello')
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('an account whose menus fail to load shows none of the previous account', async () => {
    mockApi({
      ...BASE,
      'GET /wxoa/accounts/options': ok([
        ...OPTIONS,
        { id: 6, label: 'News', accountKind: 'service', verified: true, enabled: true },
      ]),
      'GET /wxoa/menus': (c) =>
        c.params.accountId === 6 ? fail(422, 'B6011') : ok([menuRow({ id: 3 })]),
    })
    await show(MenuPage)
    expect(w.findAll('.menu-item')).toHaveLength(1)
    useWxoaAccount().accountId.value = 6
    await flushPromises()
    expect(w.findAll('.menu-item')).toHaveLength(0)
    expect(w.find('.menu-editor').exists()).toBe(false)
    expect(w.find('.phone__btn').exists()).toBe(false)
  })

  it('clearing with unsaved changes asks to discard them first and keeps them when declined', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/menus': ok([menuRow({ id: 3 })]),
      'POST /wxoa/menus/clear': ok(null),
    })
    await show(MenuPage)
    await item('Button key')!.find('input').setValue('changed')
    confirm.mockRejectedValueOnce('cancel')
    await press('Clear live menus')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(
      'The custom menu “Main” has unsaved changes. Discard them?',
      expect.anything(),
      expect.anything(),
    )
    expect(sent(calls, 'post', '/wxoa/menus/clear')).toHaveLength(0)
    expect(item('Button key')!.find('input').element.value).toBe('changed')
  })

  it('an account switched while the page is kept in the background is followed once it shows again', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/accounts/options': ok([
        ...OPTIONS,
        { id: 6, label: 'News', accountKind: 'service', verified: true, enabled: true },
      ]),
      'GET /wxoa/menus': (c) => ok([menuRow({ id: c.params.accountId === 6 ? 8 : 3 })]),
    })
    const Other = defineComponent({ name: 'OtherPage', render: () => h('div') })
    const Host = defineComponent({
      props: { on: Boolean },
      setup: (p) => () => h(KeepAlive, null, [h(p.on ? MenuPage : Other)]),
    })
    await show(Host, { on: true })
    const state = useWxoaAccount()
    const loads = () => calls.filter((c) => c.url === '/wxoa/menus').map((c) => c.params)
    const before = loads().length
    await item('Button key')!.find('input').setValue('changed')

    await w.setProps({ on: false })
    state.accountId.value = 6
    await flushPromises()
    expect(confirm).not.toHaveBeenCalled()
    expect(state.accountId.value).toBe(6)

    confirm.mockRejectedValueOnce('cancel')
    await w.setProps({ on: true })
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(
      'The custom menu “Main” has unsaved changes. Discard them?',
      expect.anything(),
      expect.anything(),
    )
    expect(state.accountId.value).toBe(5)
    expect(item('Button key')!.find('input').element.value).toBe('changed')
    expect(loads()).toHaveLength(before)

    await w.setProps({ on: false })
    state.accountId.value = 6
    await w.setProps({ on: true })
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(item('Button key')!.find('input').element.value).toBe('hello')
    expect(loads().slice(before)).toEqual([{ accountId: 6 }])
  })

  it('without the tag permission a conditional menu matches a platform and says why', async () => {
    useAuthStore().me = me(['wxoa.menu.browse', 'wxoa.menu.modify'])
    const calls = mockApi({ ...BASE, 'GET /wxoa/menus': ok([menuRow({ id: 3 })]) })
    await show(MenuPage)
    await press('Add a conditional menu')
    expect(sent(calls, 'get', '/wxoa/tags')).toHaveLength(0)
    expect(w.text()).toContain('Matching a tag also needs the permission to view tags')
  })

  it('deleting a published conditional menu, which deletes it on WeChat, takes the publish permission', async () => {
    const rows = [
      menuRow({ id: 3 }),
      menuRow({ id: 4, menuKind: 'conditional', label: 'VIPs', matchTagId: 100, wxMenuId: '401' }),
      menuRow({
        id: 5,
        menuKind: 'conditional',
        label: 'Drafts',
        matchTagId: 100,
        publishedAt: null,
      }),
    ]
    const deletable = async () => {
      mockApi({ ...BASE, 'GET /wxoa/menus': ok(rows) })
      await show(MenuPage)
      const out = []
      for (const m of w.findAll('.menu-item')) {
        await m.trigger('click')
        await flushPromises()
        out.push(button('Delete') !== undefined)
      }
      w.unmount()
      return out
    }
    useAuthStore().me = me(['wxoa.menu.browse', 'wxoa.menu.modify'])
    expect(await deletable()).toEqual([true, false, true])
    useAuthStore().me = me(['wxoa.menu.browse', 'wxoa.menu.modify', 'wxoa.menu.publish'])
    expect(await deletable()).toEqual([true, true, true])
  })

  it('pull reports the menus it skipped by reason; clear sends the account', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/menus': ok([menuRow({ id: 3 })]),
      'POST /wxoa/menus/pull': ok(
        wxoaMenuPullResult.parse({
          menus: [menuRow({ id: 3 })],
          skipped: [
            { menuKind: 'conditional', wxMenuId: '9', reason: 'no_match' },
            { menuKind: 'conditional', wxMenuId: '10', reason: 'no_match' },
            { menuKind: 'default', wxMenuId: null, reason: 'invalid' },
          ],
        }),
      ),
      'POST /wxoa/menus/clear': ok(null),
    })
    await show(MenuPage)
    await press('Pull from WeChat')
    expect(body(sent(calls, 'post', '/wxoa/menus/pull')[0])).toEqual({ accountId: 5 })
    expect(
      vi.mocked(ElMessage.warning).mock.calls.map(([o]) => (o as { message: string }).message),
    ).toEqual([
      'Pulled; 2 conditional menu(s) matching neither a tag nor a platform could not be imported',
      'Pulled; 1 menu(s) with buttons or a match rule this system cannot hold could not be imported',
    ])
    expect(ElMessage.success).not.toHaveBeenCalledWith('Pulled')
    await press('Clear live menus')
    expect(body(sent(calls, 'post', '/wxoa/menus/clear')[0])).toEqual({ accountId: 5 })
    expect(ElMessage.success).toHaveBeenCalledWith('Live menus cleared')
  })

  it('without the modify and publish permissions: a read-only preview', async () => {
    useAuthStore().me = me(['wxoa.menu.browse'])
    mockApi({ ...BASE, 'GET /wxoa/menus': ok([menuRow({ id: 3 })]) })
    await show(MenuPage)
    expect(tops()).toHaveLength(1)
    expect(w.find('[aria-label="Add a button"]').exists()).toBe(false)
    for (const text of ['Save', 'Publish', 'Delete', 'Pull from WeChat', 'Clear live menus'])
      expect(button(text)).toBeUndefined()
    expect(item('Button name')!.find('input').attributes('disabled')).toBeDefined()
    expect(button('Test matching')).toBeDefined()
  })

  it('test matching shows the menu WeChat picks for the fan', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /wxoa/menus/try-match': ok(
        wxoaMenuTryMatchVo.parse({
          buttons: [{ name: 'VIP', subButtons: [{ name: 'Deals', kind: 'click', key: 'd' }] }],
        }),
      ),
    })
    await show(TryMatch, { accountId: 5 })
    await w.find('input').setValue('o-fan-1')
    await press('Test')
    expect(body(sent(calls, 'post', '/wxoa/menus/try-match')[0])).toEqual({
      accountId: 5,
      userId: 'o-fan-1',
    })
    await w.find('.phone__top').trigger('click')
    expect(w.find('.phone__subs').text()).toBe('Deals')
  })

  it('test matching says so when no menu matches the fan', async () => {
    mockApi({
      ...BASE,
      'POST /wxoa/menus/try-match': ok(wxoaMenuTryMatchVo.parse({ buttons: [] })),
    })
    await show(TryMatch, { accountId: 5 })
    await w.find('input').setValue('o-fan-2')
    await press('Test')
    expect(w.find('.phone__top').exists()).toBe(false)
    expect(w.find('.empty-state').text()).toContain('No menu matches this fan')
  })
})
