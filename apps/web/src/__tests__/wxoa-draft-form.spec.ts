// Draft editor and draft picker of an official account (see docs/design-notes.md#wxoa): the shared
// draft contract, the "unsynced changes" hint from the server's flag and local edits, the actions
// following the permissions, field errors from the shared schema, a retried sync after a created
// draft failed to sync, and the picker that only offers synced drafts.
import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { wxoaDraftArticle, wxoaDraftCreate, WXOA_CONTENT_MAX } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DraftForm from '@/views/platform/wxoa/draft/form.vue'
import DraftPicker from '@/views/platform/wxoa/draft/DraftPicker.vue'
import DraftList from '@/views/platform/wxoa/draft/index.vue'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import { fail, mockApi, ok } from './mock-api'
import { article, BASE, body, draftVo, sent, useContentPage } from './wxoa-content'

const page = useContentPage()

describe('wxoa draft contract', () => {
  it('accepts a bounded article and requires a permanent cover', () => {
    const a = article()
    expect(wxoaDraftArticle.safeParse(a).success).toBe(true)
    expect(wxoaDraftCreate.safeParse({ accountId: 2, articles: [a] }).success).toBe(true)
    expect(wxoaDraftArticle.safeParse({ ...a, thumbMediaId: '' }).success).toBe(false)
    expect(
      wxoaDraftArticle.safeParse({ ...a, content: 'x'.repeat(WXOA_CONTENT_MAX + 1) }).success,
    ).toBe(false)
  })
})

describe('draft editor', () => {
  const HINT = 'This draft has unsynced changes'

  it('the unsynced hint follows the server flag of a synced draft, and local edits', async () => {
    mockApi(BASE)
    let w = await page.show(DraftForm, { accountId: 2, draft: draftVo(5, { dirty: true }) })
    expect(w.text()).toContain(HINT)
    w.unmount()

    w = await page.show(DraftForm, { accountId: 2, draft: draftVo(6) })
    expect(w.text()).not.toContain(HINT)
    await w.find('input').setValue('Changed title')
    expect(w.text()).toContain(HINT)
    w.unmount()

    // never synced: nothing to warn about
    w = await page.show(DraftForm, { accountId: 2, draft: draftVo(7, { mediaId: null }) })
    await w.find('input').setValue('Changed title')
    expect(w.text()).not.toContain(HINT)
  })

  it('a pulled draft warns that its layout was lost; there is no separate draft title input', async () => {
    mockApi(BASE)
    const w = await page.show(DraftForm, { accountId: 2, draft: draftVo(5, { origin: 'pulled' }) })
    expect(w.text()).toContain('original layout styles were removed')
    expect(w.findAll('.el-form-item__label').map((l) => l.text())).not.toContain('Draft title')
  })

  it('save needs create (new) or modify (existing); sync needs the sync permission too', async () => {
    mockApi(BASE)
    page.perms(['wxoa.draft.browse', 'wxoa.draft.create'])
    let w = await page.show(DraftForm, { accountId: 2 })
    expect(page.buttons('Save')).toHaveLength(1)
    expect(page.buttons('Sync to WeChat')).toHaveLength(0)
    w.unmount()

    w = await page.show(DraftForm, { accountId: 2, draft: draftVo(5) })
    expect(page.buttons('Save')).toHaveLength(0)
    w.unmount()

    page.perms(['wxoa.draft.modify', 'wxoa.draft.sync'])
    await page.show(DraftForm, { accountId: 2, draft: draftVo(5) })
    expect(page.buttons('Save')).toHaveLength(1)
    expect(page.buttons('Sync to WeChat')).toHaveLength(1)
  })

  it('an empty title and no cover show field errors and send nothing', async () => {
    const calls = mockApi(BASE)
    const w = await page.show(DraftForm, { accountId: 2 })
    await page.buttons('Save')[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/drafts')).toHaveLength(0)
    const errors = () => w.findAll('.el-form-item__error').map((e) => e.text())
    await vi.waitFor(() => {
      expect(errors().some((e) => e.includes('Article title'))).toBe(true)
      expect(errors().some((e) => e.includes('Cover material'))).toBe(true)
    })
  })

  it('created but the sync failed: a retry syncs the same draft and never creates another', async () => {
    let syncs = 0
    const calls = mockApi({
      ...BASE,
      'POST /wxoa/drafts': ok(draftVo(9, { mediaId: null, dirty: false })),
      'POST /wxoa/drafts/9/sync': () =>
        ++syncs === 1
          ? fail(502, 'B6001')
          : ok({ draft: draftVo(9), unsyncedImages: [{ src: '/x.gif', reason: 'type' }] }),
    })
    const w = await page.show(DraftForm, { accountId: 2 })
    await w.find('input').setValue('First')
    await page.buttons('Choose cover')[0]!.trigger('click')
    expect(dialogs[0]!.props).toEqual({ accountId: 2, mediaKind: 'thumb' })
    dialogs[0]!.settle({ id: 4, mediaId: 'thumb-1', objectId: null, wxUrl: null })
    await flushPromises()
    await page.buttons('Sync to WeChat')[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/drafts')).toHaveLength(1)
    expect(body(sent(calls, 'post', '/wxoa/drafts')[0])).toMatchObject({ accountId: 2 })

    await page.buttons('Sync to WeChat')[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/drafts')).toHaveLength(1)
    expect(sent(calls, 'put', '/wxoa/drafts/9')).toHaveLength(0)
    expect(sent(calls, 'post', '/wxoa/drafts/9/sync')).toHaveLength(2)
    // images WeChat did not take stay listed (the editor stays open to show them)
    expect(w.text()).toContain('/x.gif')
    expect(w.emitted('done')).toBeUndefined()
  })

  it('save and sync disable each other while one is pending', async () => {
    let release = () => {}
    mockApi({
      ...BASE,
      'PUT /wxoa/drafts/5': () => new Promise((r) => (release = () => r(ok(draftVo(5))))),
    })
    const w = await page.show(DraftForm, { accountId: 2, draft: draftVo(5) })
    await w.find('input').setValue('Changed')
    await page.buttons('Save')[0]!.trigger('click')
    await flushPromises()
    expect(page.buttons('Sync to WeChat')[0]!.attributes('disabled')).toBeDefined()
    release()
    await flushPromises()
    expect(w.emitted('done')).toHaveLength(1)
  })
})

describe('draft picker', () => {
  it('lists the drafts and offers only the synced ones without local changes', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/drafts': ok({
        items: [
          draftVo(1),
          draftVo(2, { mediaId: null, title: 'Local only' }),
          draftVo(3, { dirty: true, title: 'Edited' }),
        ],
        total: 3,
      }),
    })
    const w = await page.show(DraftPicker, { accountId: 2 })
    expect(sent(calls, 'get', '/wxoa/drafts')[0]!.params).toMatchObject({ accountId: 2 })
    const items = w.findAll('.wxoa-draft-picker__item')
    expect(items.map((i) => i.attributes('disabled') != null)).toEqual([false, true, true])
    expect(items[1]!.text()).toContain('Not synced')
    expect(items[2]!.text()).toContain('Unsynced changes')
    await items[2]!.trigger('click')
    await items[0]!.trigger('click')
    expect(w.emitted('done')).toEqual([[draftVo(1)]])
  })
})

describe('draft list', () => {
  it('searches by title: the typed title goes to the server with the account', async () => {
    const calls = mockApi({ ...BASE, 'GET /wxoa/drafts': ok({ items: [draftVo(1)], total: 1 }) })
    useWxoaAccount().accountId.value = 2
    const w = await page.show(DraftList)
    await w.find('.qw-search-panel input').setValue('Spring')
    await w.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/drafts').at(-1)!.params).toMatchObject({
      accountId: 2,
      title: 'Spring',
    })
  })
})
