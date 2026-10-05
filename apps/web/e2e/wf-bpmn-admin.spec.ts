import { readFile } from 'node:fs/promises'
import type { APIRequestContext } from '@playwright/test'
import { treeToXml } from '@qiwu/shared'
import { bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// 模型管理 for BPMN models. The list's process type column; a
// BPMN model added in the dialog, its type fixed once added; no 向导 for it, and its wizard URL goes back to
// the list; its versions exported as .bpmn, no JSON imported there; its designer imports a version's JSON
// export (the leave model's: its labels in the app language; ids a diagram refuses renamed) and .bpmn files,
// and exports the canvas as .bpmn. Models are created through the API (root) unless the dialog is the test.

const field = (prop: string) => msg(`field.wf.model.${prop}`)
const body = (page: Page) => page.locator('.qw-table-panel .el-table__body')
const row = (page: Page, name: string) => body(page).locator('tr').filter({ hasText: name })
const canvas = (page: Page) => page.locator('.wf-bpmn')
const shape = (page: Page, id: string) =>
  canvas(page).locator(`.djs-shape[data-element-id="${id}"]`)
/** what the canvas draws: element and flow labels */
const drawn = async (page: Page) =>
  (await canvas(page).locator('.djs-container > svg').textContent()) ?? ''

/** BPMN a strict parse reads, without a diagram bpmn-js could draw */
const NO_DIAGRAM =
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="x"><bpmn:process id="p"/></bpmn:definitions>'

/** A dynamic model of `flowKind` (BPMN: v1 begin → end published when `publish`); its id. */
async function newModel(
  request: APIRequestContext,
  headers: Record<string, string>,
  key: string,
  flowKind: 'tree' | 'bpmn',
  publish = false,
) {
  const res = await request.post('/api/wf/models', {
    headers,
    data: { modelKey: key, name: key, formKind: 'dynamic', category: 'finance', flowKind },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const { id } = ((await res.json()) as { data: { id: number } }).data
  if (publish) {
    const xml = treeToXml({ id: 'begin', type: 'begin', name: 'Begin' })
    const v1 = await request.post(`/api/wf/models/${id}/versions`, {
      headers,
      data: { xml, fields: {} },
    })
    expect(v1.ok(), await v1.text()).toBe(true)
  }
  return id
}

test('list: the process type column; a BPMN model added in the dialog keeps its type; no wizard for it', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  await newModel(request, headers, 'e2e-bpmn-admin-tree', 'tree')
  await signIn(page, 'admin', '/wf/models')
  const tree = row(page, 'e2e-bpmn-admin-tree')
  await expect(tree).toContainText(msg('wf.model.flowKinds.tree'))
  await expect(tree.getByRole('button', { name: msg('wf.model.list.wizard') })).toBeVisible()

  // added as a BPMN model
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('wf.model.entity') }),
  })
  await expect(create).toContainText(msg('wf.model.form.flowKindHint'))
  await expect(create.getByRole('radio', { name: msg('wf.model.flowKinds.tree') })).toBeChecked()
  await create.getByRole('textbox', { name: field('modelKey') }).fill('e2e-bpmn-admin-added')
  await create.getByRole('textbox', { name: field('name') }).fill('e2e-bpmn-admin-added')
  await create.getByText(msg('wf.model.flowKinds.bpmn'), { exact: true }).click()
  const created = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/wf/models',
  )
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  expect((await created).postDataJSON()).toMatchObject({
    modelKey: 'e2e-bpmn-admin-added',
    formKind: 'dynamic',
    flowKind: 'bpmn',
  })
  await expect(create).toBeHidden()

  // listed as BPMN, without 向导
  const added = row(page, 'e2e-bpmn-admin-added')
  await expect(added).toContainText(msg('wf.model.flowKinds.bpmn'))
  await expect(added.getByRole('button', { name: msg('wf.model.list.design') })).toBeVisible()
  await expect(added.getByRole('button', { name: msg('wf.model.list.wizard') })).toHaveCount(0)

  // the type is fixed once added
  await added.getByRole('button', { name: msg('crud.action.edit') }).click()
  const edit = page.getByRole('dialog', {
    name: msg('crud.title.edit', 'zh-CN', { name: msg('wf.model.entity') }),
  })
  const bpmn = edit.getByRole('radio', { name: msg('wf.model.flowKinds.bpmn') })
  await expect(bpmn).toBeChecked()
  await expect(bpmn).toBeDisabled()
  await expect(edit.getByRole('radio', { name: msg('wf.model.flowKinds.tree') })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(edit).toBeHidden()

  // its wizard URL: told why, back on the list
  const list = (await (
    await request.get('/api/wf/models?modelKey=e2e-bpmn-admin-added', { headers })
  ).json()) as { data: { items: { id: number }[] } }
  await page.goto(`/wf/wizard/${list.data.items[0]!.id}`)
  await expect(page.getByText(msg('wf.model.list.wizardTreeOnly'))).toBeVisible()
  await expect(page).toHaveURL(/\/wf\/models$/)
})

test('versions: a BPMN model’s version exported as .bpmn and as JSON; no JSON imported there', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  await newModel(request, headers, 'e2e-bpmn-admin-versions', 'bpmn', true)
  await signIn(page, 'admin', '/wf/models')
  await row(page, 'e2e-bpmn-admin-versions')
    .getByRole('button', { name: msg('wf.model.list.versions') })
    .click()
  const versions = page.getByRole('dialog', {
    name: msg('wf.model.versions.title', 'zh-CN', { name: 'e2e-bpmn-admin-versions' }),
  })
  const v1 = versions.locator('.el-table__body tr')
  await expect(v1).toHaveCount(1)
  await expect(
    versions.getByRole('button', { name: msg('wf.model.versions.importJson') }),
  ).toHaveCount(0)
  await expect(versions.locator('input[type=file]')).toHaveCount(0)

  // the stored (normalized) diagram
  let downloading = page.waitForEvent('download')
  await v1.getByRole('button', { name: msg('wf.model.versions.exportBpmn') }).click()
  let file = await downloading
  expect(file.suggestedFilename()).toBe('e2e-bpmn-admin-versions-v1.bpmn')
  const xml = await readFile(await file.path(), 'utf8')
  expect(xml).toMatch(/<bpmn:startEvent id="begin"/)

  // the tree it was compiled to, as for a tree model's version
  downloading = page.waitForEvent('download')
  await v1.getByRole('button', { name: msg('wf.model.versions.exportJson') }).click()
  file = await downloading
  expect(file.suggestedFilename()).toBe('e2e-bpmn-admin-versions-v1.json')
  expect(JSON.parse(await readFile(await file.path(), 'utf8'))).toMatchObject({
    modelKey: 'e2e-bpmn-admin-versions',
    tree: { id: 'begin', type: 'begin' },
  })
})

/** The seeded leave model's current version as 版本列表 exports it (its names seed keys). */
async function leaveJson(request: APIRequestContext, headers: Record<string, string>) {
  const list = (await (await request.get('/api/wf/models?modelKey=leave', { headers })).json()) as {
    data: { items: { id: number; modelKey: string; currentVersionId: number }[] }
  }
  const leave = list.data.items.find((m) => m.modelKey === 'leave')!
  const res = await request.get(`/api/wf/models/${leave.id}/versions/${leave.currentVersionId}`, {
    headers,
  })
  const v = (
    (await res.json()) as {
      data: { version: number; tree: object; formSnapshot: { fields: object } }
    }
  ).data
  return { modelKey: 'leave', version: v.version, tree: v.tree, fields: v.formSnapshot.fields }
}

test('design: the leave model’s JSON drawn in the app language, odd ids renamed; the canvas as .bpmn out and back in', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const leave = JSON.stringify(await leaveJson(request, headers))
  expect(leave).toContain('"seed.wf.node.supervisor"')
  const id = await newModel(request, headers, 'e2e-bpmn-admin-design', 'bpmn')
  await signIn(page, 'admin', `/wf/models/${id}/design`)
  await expect(shape(page, 'begin')).toBeVisible()

  const input = page.locator('.wf-model-design input[type=file]')
  const pick = (name: string, text: string) =>
    input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) })
  const confirm = async (lang = 'zh-CN') => {
    const box = page.getByRole('dialog', { name: msg('wf.model.design.importTitle', lang) })
    await expect(box).toContainText(msg('wf.model.design.importHint', lang))
    await box.getByRole('button', { name: msg('wf.model.design.import', lang) }).click()
    await expect(box).toBeHidden()
  }

  // the leave model's version: its ids kept, its seed keys drawn as zh-CN text
  await pick('leave-v1.json', leave)
  await confirm()
  await expect(shape(page, 'supervisor')).toContainText(msg('seed.wf.node.supervisor'))
  await expect(shape(page, 'hr')).toContainText(msg('seed.wf.node.hr'))
  expect(await drawn(page)).toContain(msg('seed.wf.path.over5'))
  expect(await drawn(page)).not.toContain('seed.')

  // the canvas exported as it is
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: msg('wf.model.design.exportBpmn') }).click()
  const file = await downloading
  expect(file.suggestedFilename()).toBe('e2e-bpmn-admin-design-draft.bpmn')
  const exported = await readFile(await file.path(), 'utf8')
  expect(exported).toContain(
    `<bpmn:userTask id="supervisor" name="${msg('seed.wf.node.supervisor')}"`,
  )

  // in English: drawn in English
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await pick('leave-v1.json', leave)
  await confirm('en-US')
  await expect(shape(page, 'supervisor')).toContainText(msg('seed.wf.node.supervisor', 'en-US'))
  expect(await drawn(page)).not.toContain('seed.')

  // an id a diagram refuses gets a new one, and the page says so
  const odd = {
    tree: {
      id: 'begin',
      type: 'begin',
      name: 'Begin',
      next: {
        id: '1st',
        type: 'review',
        name: 'First',
        assignee: { kind: 'initiator' },
        sign: 'any',
        whenNobody: 'toManager',
        whenInitiatorIsReviewer: 'self',
        onReject: 'finish',
      },
    },
  }
  await pick('odd.json', JSON.stringify(odd))
  await confirm('en-US')
  const renamed = page.locator('.el-message').filter({ hasText: /1st → review_[0-9a-f]{8}/ })
  await expect(renamed).toBeVisible()
  await expect(shape(page, '1st')).toHaveCount(0)
  await expect(canvas(page).locator('.djs-shape').filter({ hasText: 'First' })).toBeVisible()
  await renamed.locator('.el-message__closeBtn').click()

  // the exported file read back
  await pick('e2e-bpmn-admin-design-draft.bpmn', exported)
  await confirm('en-US')
  await expect(shape(page, 'supervisor')).toContainText(msg('seed.wf.node.supervisor'))

  // refused before asking (a DOCTYPE), or no diagram: the canvas stays
  await pick('doctype.bpmn', '<!DOCTYPE x><x/>')
  await expect(page.getByText(msg('validation.wf.bpmn_doctype', 'en-US'))).toBeVisible()
  await expect(
    page.getByRole('dialog', { name: msg('wf.model.design.importTitle', 'en-US') }),
  ).toHaveCount(0)
  for (const broken of [
    'no diagram',
    // read, but nothing to draw: bpmn-js clears the canvas before it finds out
    NO_DIAGRAM,
  ]) {
    await pick('broken.bpmn', broken)
    await confirm('en-US')
    await expect(page.getByText(msg('wf.model.design.badFile', 'en-US')).first()).toBeVisible()
    await expect(shape(page, 'supervisor')).toBeVisible()
  }

  // an import is unsaved: leaving asks; saved as drawn
  await page.getByRole('button', { name: msg('wf.model.design.back', 'en-US') }).click()
  const leaving = page.getByRole('dialog', { name: msg('wf.model.design.leaveTitle', 'en-US') })
  await leaving.getByRole('button', { name: msg('common.action.cancel', 'en-US') }).click()
  await expect(leaving).toBeHidden()
  const put = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/wf/models/${id}/draft`),
  )
  await page.getByRole('button', { name: msg('wf.model.design.saveDraft', 'en-US') }).click()
  const saved = await put
  expect(saved.ok()).toBe(true)
  expect((saved.request().postDataJSON() as { xml: string }).xml).toContain('id="supervisor"')
})

test('design: a stored draft bpmn-js cannot draw gives way to the begin node’s diagram, said in a notice', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await newModel(request, headers, 'e2e-bpmn-admin-undrawn', 'bpmn')
  // a draft is checked only on publish: one without a diagram is stored
  const stored = await request.put(`/api/wf/models/${id}/draft`, {
    headers,
    data: { xml: NO_DIAGRAM },
  })
  expect(stored.ok(), await stored.text()).toBe(true)
  await signIn(page, 'admin', `/wf/models/${id}/design`)
  await expect(page.getByText(msg('wf.model.design.draftUnreadable'))).toBeVisible()
  await expect(shape(page, 'begin')).toBeVisible()
  await expect(page.getByRole('button', { name: msg('wf.model.design.import') })).toBeEnabled()
  // saved over the stored draft
  const put = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/wf/models/${id}/draft`),
  )
  await page.getByRole('button', { name: msg('wf.model.design.saveDraft') }).click()
  expect((await put).ok()).toBe(true)
  expect(((await put).request().postDataJSON() as { xml: string }).xml).toContain('id="begin"')
})
