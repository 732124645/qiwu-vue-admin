// 模型管理: the list grouped by category and moved within it, and the model form's body; a
// version's JSON export read back as the publish body of an import; drawn as a BPMN model's diagram.
import { describe, expect, it } from 'vitest'
import type { WfModelCreate, WfModelVo, WfVersionDetailVo } from '@qiwu/shared'
import { i18n } from '@/core/i18n'
import {
  byCategory,
  categorySpan,
  exportJson,
  importBody,
  jsonXml,
  moveInCategory,
  toBody,
  toForm,
} from '@/views/workflow/admin/model-list'

const row = (id: number, category: string) => ({ id, category })

describe('model list', () => {
  // as the server sends them: by sortNo across categories
  const rows = [
    row(1, 'x'),
    row(2, 'finance'),
    row(3, 'hr'),
    row(4, 'finance'),
    row(5, 'a'),
    row(6, 'x'),
  ]
  const grouped = byCategory(rows, ['hr', 'finance', 'other'])

  it('groups by the dict order, unknown categories last by code, each keeping its order', () => {
    expect(grouped.map((r) => r.id)).toEqual([3, 2, 4, 5, 1, 6])
  })

  it('spans the category cell over its group', () => {
    expect(grouped.map((_, i) => categorySpan(grouped, i))).toEqual([1, 2, 0, 1, 2, 0])
  })

  it('moves a row within its category, renumbering the category', () => {
    expect(moveInCategory(grouped, grouped[2]!, -1)).toEqual([
      { id: 4, sortNo: 10 },
      { id: 2, sortNo: 20 },
    ])
    // the row as el-table's slot gives it: a proxy, not the list's object
    expect(moveInCategory(grouped, { ...grouped[1]! }, 1)).toEqual([
      { id: 4, sortNo: 10 },
      { id: 2, sortNo: 20 },
    ])
    // the category's edges
    expect(moveInCategory(grouped, grouped[1]!, -1)).toBeNull()
    expect(moveInCategory(grouped, grouped[2]!, 1)).toBeNull()
    expect(moveInCategory(grouped, grouped[0]!, 1)).toBeNull()
  })
})

describe('model form', () => {
  it('edits a stored "everyone" as empty lists', () => {
    const m = toForm({ id: 1, initiatorScope: null, managerUserIds: null } as WfModelVo)
    expect(m.initiatorScope).toEqual({ userIds: [], deptIds: [], roleIds: [] })
    expect(m.managerUserIds).toEqual([])
  })

  it('sends the page paths of a custom model only, and never empty; the form of a dynamic one only', () => {
    const base = {
      modelKey: 'k',
      name: 'n',
      createRoute: '/a/new',
      viewComponent: 'a/view',
      formId: 4,
    }
    expect(toBody({ ...base, formKind: 'custom' } as WfModelCreate)).toMatchObject({
      formId: null,
      createRoute: '/a/new',
      viewComponent: 'a/view',
    })
    const dynamic = toBody({ ...base, formKind: 'dynamic' } as WfModelCreate)
    expect([dynamic.formId, dynamic.createRoute, dynamic.viewComponent]).toEqual([
      4,
      undefined,
      undefined,
    ])
    // cleared: unbound
    expect(toBody({ ...base, formKind: 'dynamic', formId: undefined }).formId).toBeNull()
    const cleared = toBody({ ...base, formKind: 'custom', createRoute: '' } as WfModelCreate)
    expect(cleared.createRoute).toBeUndefined()
  })

  it('sends the process managers only when the user may change them', () => {
    const m = { modelKey: 'k', name: 'n', formKind: 'dynamic', managerUserIds: [4] } as const
    expect(toBody({ ...m, managerUserIds: [4] }).managerUserIds).toEqual([4])
    expect(JSON.stringify(toBody({ ...m, managerUserIds: [4] }, false))).not.toContain(
      'managerUserIds',
    )
  })
})

describe('json export and import', () => {
  const tree = { id: 'begin', type: 'begin', name: 'Begin' }
  const version = {
    id: 7,
    version: 2,
    formSnapshot: { fields: { amount: 'number' } },
    publishedBy: 1,
    publishedAt: '2026-10-01T00:00:00.000Z',
    tree,
    bpmnXml: null,
  } as WfVersionDetailVo
  const dynamic = { formKind: 'dynamic' } as const
  const custom = { formKind: 'custom' } as const

  it('exports the tree with the fields it was published with, and imports it back', () => {
    const json = exportJson('leave', version)
    expect(JSON.parse(json)).toEqual({
      modelKey: 'leave',
      version: 2,
      tree,
      fields: { amount: 'number' },
    })
    expect(importBody(dynamic, json)).toEqual({ tree, fields: { amount: 'number' } })
    // a custom model's fields are its handler's: not sent
    expect(importBody(custom, json)).toEqual({ tree })
    expect(importBody(dynamic, JSON.stringify({ tree }))).toEqual({ tree })
  })

  it('refuses a file that is no JSON or has no tree object', () => {
    for (const text of ['', '{', 'null', '[]', '{"tree":[]}', '{"tree":"x"}', '{"fields":{}}'])
      expect(importBody(dynamic, text)).toBeNull()
  })
})

describe('json import into a BPMN model', () => {
  const review = (id: string, next?: object) => ({
    id,
    type: 'review',
    name: 'seed.wf.node.supervisor',
    assignee: { kind: 'initiator' },
    sign: 'any',
    whenNobody: 'toManager',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
    next,
  })
  // ids the tree takes but a diagram does not: a digit or `-` first, `__` first, a prototype name
  const tree = {
    id: 'begin',
    type: 'begin',
    name: 'seed.wf.node.begin',
    next: review('1st', {
      id: 'toString',
      type: 'fork',
      name: 'Amount',
      paths: [
        {
          id: '-big',
          name: 'Big',
          when: [[{ field: 'amount', op: 'gt', value: 1000 }]],
          child: { id: '__cc', type: 'notify', name: 'CC', assignee: { kind: 'initiator' } },
        },
        { id: 'ok_path', name: 'Else', fallback: true, when: [], child: review('ok-2') },
      ],
    }),
  }

  it('draws the tree: ids a diagram refuses renamed, seed keys as text in the app language', () => {
    const r = jsonXml(JSON.stringify({ modelKey: 'leave', version: 1, tree, fields: {} }))!
    expect(r.renamed).toEqual([
      ['1st', expect.stringMatching(/^review_[0-9a-f]{8}$/)],
      ['toString', expect.stringMatching(/^fork_[0-9a-f]{8}$/)],
      ['-big', expect.stringMatching(/^path_[0-9a-f]{8}$/)],
      ['__cc', expect.stringMatching(/^notify_[0-9a-f]{8}$/)],
    ])
    for (const [from, to] of r.renamed) {
      expect(r.xml).not.toContain(`id="${from}"`)
      expect(r.xml).toContain(`id="${to}"`)
    }
    // the ids a diagram takes stay
    for (const id of ['begin', 'ok_path', 'ok-2']) expect(r.xml).toContain(`id="${id}"`)
    expect(r.xml).toContain(`name="${i18n.global.t('seed.wf.node.begin')}"`)
    expect(r.xml).toContain(`name="${i18n.global.t('seed.wf.node.supervisor')}"`)
    expect(r.xml).not.toContain('seed.wf.')
    // nothing to rename: none
    expect(jsonXml(JSON.stringify({ tree: { ...tree, next: undefined } }))!.renamed).toEqual([])
  })

  it('refuses a file that is no JSON, has no begin node as its tree, or a tree of the wrong shape', () => {
    for (const text of [
      '',
      '<bpmn:definitions/>',
      'null',
      '{"tree":[]}',
      '{"tree":{"id":"x","type":"review"}}',
      '{"tree":{"id":"begin","type":"begin","next":{"id":"f","type":"fork","paths":5}}}',
    ])
      expect(jsonXml(text)).toBeNull()
  })
})
