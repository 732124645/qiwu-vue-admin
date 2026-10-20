import { expect, msg, signIn, test } from './fixtures.ts'
import { ok, pickAccount, wxoaAccount } from './wxoa.ts'

// Draft editor: the local article list and rich editor are exercised in the browser, while
// WeChat, storage and material management are mocked at the page boundary. The server-side draft
// and image safety rules are covered by the API tests; this spec checks the user-facing flow.

const article = (title: string, content: string) => ({
  title,
  author: '',
  digest: '',
  content,
  contentSourceUrl: '',
  thumbMediaId: 'thumb-e2e',
  needOpenComment: true,
  onlyFansCanComment: false,
})

test('draft editor: two articles and image → overlong content is blocked → save → sync', async ({
  page,
  request,
}) => {
  const account = await wxoaAccount(request, 'e2e-wxoa-draft')
  const saved = article('E2E first article', '<p>E2E first body</p>')
  let draft = {
    id: 9001,
    accountId: account.id,
    title: saved.title,
    articles: [saved],
    mediaId: null as string | null,
    origin: 'local' as const,
    syncedAt: null as string | null,
    syncedDigest: null as string | null,
    dirty: false,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  }
  let creates = 0
  let updates = 0
  let syncs = 0

  await page.route('**/api/wxoa/drafts**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'GET' && url.pathname.endsWith('/wxoa/drafts'))
      return route.fulfill(ok({ items: creates ? [draft] : [], total: creates ? 1 : 0 }))
    if (req.method() === 'POST' && url.pathname.endsWith('/wxoa/drafts/pull'))
      return route.fulfill(ok({ items: [], failed: [] }))
    if (req.method() === 'POST' && url.pathname.endsWith('/wxoa/drafts')) {
      creates++
      const body = req.postDataJSON() as { articles: Array<typeof saved> }
      draft = {
        ...draft,
        title: body.articles[0]!.title,
        articles: body.articles,
        updatedAt: new Date().toISOString(),
      }
      return route.fulfill(ok(draft))
    }
    if (req.method() === 'PUT' && /\/wxoa\/drafts\/\d+$/.test(url.pathname)) {
      updates++
      const body = req.postDataJSON() as { articles: Array<typeof saved> }
      draft = {
        ...draft,
        title: body.articles[0]!.title,
        articles: body.articles,
        updatedAt: new Date().toISOString(),
      }
      return route.fulfill(ok(draft))
    }
    if (req.method() === 'POST' && /\/wxoa\/drafts\/\d+\/sync$/.test(url.pathname)) {
      syncs++
      draft = {
        ...draft,
        mediaId: 'media-e2e',
        syncedAt: new Date().toISOString(),
        syncedDigest: JSON.stringify(draft.articles),
      }
      return route.fulfill(ok({ draft, unsyncedImages: [] }))
    }
    return route.fallback()
  })

  // The cover picker and RichEditor upload are local UI dependencies. Neither call is allowed to
  // reach the real storage/WeChat gateway in a browser acceptance test.
  await page.route('**/api/wxoa/materials**', (route) =>
    route.fulfill(
      ok({
        items: [
          {
            id: 9101,
            accountId: account.id,
            mediaKind: 'thumb',
            mediaId: 'thumb-e2e',
            title: 'E2E cover',
            fileName: 'e2e-cover.png',
            objectId: 9102,
            wxUrl: 'https://mmbiz.qpic.cn/e2e-cover.png',
            createdAt: '2026-10-18T00:00:00.000Z',
          },
        ],
        total: 1,
      }),
    ),
  )
  await page.route('**/api/storage/objects', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    return route.fulfill(ok({ id: 9201, url: '/files/e2e-richtext.png', originalName: 'e2e.png' }))
  })

  await signIn(page, 'admin', '/wxoa/drafts')
  await pickAccount(page, account.label)
  await page.getByRole('button', { name: msg('wxoa.draft.create'), exact: true }).click()
  const editor = page.getByRole('dialog', { name: msg('wxoa.draft.create') })
  await editor.getByRole('textbox', { name: msg('wxoa.draft.articleTitle') }).fill(saved.title)
  await editor.getByRole('button', { name: msg('wxoa.draft.chooseCover'), exact: true }).click()
  await page.getByRole('button', { name: 'E2E cover' }).click()
  await editor.locator('.rich-editor [contenteditable="true"]').fill('E2E first body')

  // Insert one local image through the existing RichEditor upload button. The actual object upload
  // is mocked above, so the test only asserts the editor receives the public URL.
  const upload = editor.locator('.rich-editor [data-menu-key="uploadImage"]')
  const chooser = page.waitForEvent('filechooser')
  await upload.click()
  await (
    await chooser
  ).setFiles({
    name: 'e2e-richtext.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(editor.locator('.rich-editor [contenteditable="true"] img')).toHaveAttribute(
    'src',
    '/files/e2e-richtext.png',
  )

  // Add a second article and make sure it is part of the save payload.
  await editor.getByRole('button', { name: /添加文章/ }).click()
  await editor
    .getByRole('textbox', { name: msg('wxoa.draft.articleTitle') })
    .last()
    .fill('E2E second article')
  await editor
    .getByRole('button', { name: msg('wxoa.draft.chooseCover'), exact: true })
    .last()
    .click()
  await page.getByRole('button', { name: 'E2E cover' }).click()
  await editor.locator('.rich-editor [contenteditable="true"]').last().fill('E2E second body')

  // The client gives immediate feedback for the hard 20,000-character limit and must not send a
  // half-valid draft to the server.
  const body = editor.locator('.rich-editor [contenteditable="true"]').last()
  await body.fill('x'.repeat(20_001))
  await expect(editor.locator('.wxoa-draft-form__counter.is-over')).toContainText('/20000')
  await editor.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  expect(creates + updates).toBe(0)
  await expect(
    page.getByText(
      msg('validation.too_big.string', 'zh-CN', {
        field: msg('wxoa.draft.content'),
        maximum: 20_000,
      }),
    ),
  ).toBeVisible()

  await body.fill('E2E second body')
  await editor.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(editor).toBeHidden()
  expect(creates).toBe(1)
  expect(draft.articles).toHaveLength(2)
  expect(draft.articles[0]!.content).toContain('e2e-richtext.png')

  // Reopen the saved draft and exercise the separate sync action: nothing changed, so it is not
  // saved again before it is pushed.
  const row = page.getByRole('row').filter({ hasText: 'E2E first article' })
  await row.getByRole('button', { name: msg('crud.action.edit'), exact: true }).click()
  const reopened = page.getByRole('dialog', { name: msg('wxoa.draft.edit') })
  await reopened.getByRole('button', { name: msg('wxoa.draft.sync.action'), exact: true }).click()
  await expect(reopened).toBeHidden()
  expect(updates).toBe(0)
  expect(syncs).toBe(1)
})
