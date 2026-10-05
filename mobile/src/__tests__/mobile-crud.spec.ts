// core/crud.ts, what the generated uni-app pages share: the CRUD / tree calls, the form's fill, dict
// labels, the user picker's value, the date picker and its conversions.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import type { DictPayload } from '@qiwu/shared'
import {
  crudApi,
  dateOf,
  fillForm,
  findNode,
  isoOf,
  metaLine,
  msOf,
  numOf,
  treeApi,
  useDatePicker,
  useDicts,
  userId,
  usersOf,
  type TreeRow,
} from '@/core/crud'
import { setSession } from '@/core/request'

type Req = UniApp.RequestOptions
const calls: Req[] = []
const flush = () => new Promise((r) => setTimeout(r))
const ok = (o: Req, data: unknown) =>
  o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data } } as never)
const sent = () => calls.map((o) => [o.method ?? 'GET', o.url.replace(/^.*\/api/, ''), o.data])
/** answer every call at once (else the spec answers) */
let auto = true

beforeEach(() => {
  setSession({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800 })
  calls.length = 0
  auto = true
  vi.mocked(uni.request).mockImplementation((o) => {
    calls.push(o)
    if (auto) ok(o, { items: [], total: 0 })
    return {} as UniApp.RequestTask
  })
})

describe('calls', () => {
  it('crudApi: page, one row, create, update and delete one row under the base', async () => {
    const books = crudApi<{ id: number }, { title: string }>('/demo/books')
    await books.page({ page: 2, pageSize: 20, sort: '-createdAt', title: 'x' })
    await books.get(7)
    await books.create({ title: 'a' })
    await books.update(7, { title: 'b' })
    await books.remove(7)
    expect(sent()).toEqual([
      ['GET', '/demo/books', { page: 2, pageSize: 20, sort: '-createdAt', title: 'x' }],
      ['GET', '/demo/books/7', undefined],
      ['POST', '/demo/books', { title: 'a' }],
      ['PUT', '/demo/books/7', { title: 'b' }],
      ['DELETE', '/demo/books/7', undefined],
    ])
  })

  it('treeApi: the whole forest (no paging) and the one-row calls; findNode searches depth first', async () => {
    const topics = treeApi<{ id: number; title: string }>('/demo/topics')
    await topics.list()
    await topics.remove(3)
    expect(sent()).toEqual([
      ['GET', '/demo/topics', {}],
      ['DELETE', '/demo/topics/3', undefined],
    ])
    const node = (id: number, children: TreeRow<{ id: number }>[] = []) => ({ id, children })
    const forest = [node(1, [node(2, [node(4)])]), node(3)]
    expect(findNode(forest, 4)).toBe(forest[0]!.children[0]!.children[0])
    expect(findNode(forest, 3)).toBe(forest[1])
    expect(findNode(forest, 9)).toBeUndefined()
  })
})

describe('form', () => {
  it('fillForm copies the row values of the form’s own fields only', () => {
    const form = reactive({
      title: '',
      author: '' as string | null,
      lines: [] as { item: string }[],
    })
    fillForm(form, { id: 7, title: 'T', author: null, lines: [{ item: 'x' }], createdAt: 'now' })
    expect({ ...form }).toEqual({ title: 'T', author: null, lines: [{ item: 'x' }] })
    expect(form).not.toHaveProperty('id')
  })

  it('metaLine joins the values that are there', () => {
    expect(metaLine('a', null, '', undefined, 0, 'b')).toBe('a · 0 · b')
    expect(metaLine()).toBe('')
  })

  it('numOf: wd-input-number’s emptied value → null, its formatted text → the number', () => {
    expect(numOf('')).toBeNull()
    expect(numOf('0.00')).toBe(0)
    expect(numOf('12.50')).toBe(12.5)
    expect(numOf(3)).toBe(3)
  })

  it('a user column: its id until picked, the picked user’s name after; none → null', () => {
    expect(usersOf(null)).toEqual([])
    expect(usersOf(41)).toEqual([{ id: 41, displayName: '41', deptName: null }])
    const ann = { id: 41, displayName: 'Ann', deptName: 'seed.dept.rd' }
    expect(userId([ann])).toBe(41)
    expect(usersOf(41)).toEqual([ann])
    expect(userId([])).toBeNull()
  })
})

describe('dicts', () => {
  it('labels and tag styles once the dict is there (values as they are before); booleans by their text', async () => {
    auto = false
    const { dictText, dictTag } = useDicts(['core.enabled'])
    expect(dictText('core.enabled', true)).toBe('true')
    const payload: DictPayload = {
      version: 1,
      entries: [
        {
          value: 'true',
          label: 'x',
          labelI18n: { 'zh-CN': '启用', 'en-US': 'Enabled' },
          tagType: 'success',
        },
        {
          value: 'false',
          label: 'y',
          labelI18n: { 'zh-CN': '停用', 'en-US': 'Disabled' },
          tagType: 'info',
        },
      ],
    } as DictPayload
    ok(calls.at(-1)!, payload)
    await flush()
    expect(sent().at(-1)).toEqual(['GET', '/settings/dicts/core.enabled/entries', undefined])
    expect(dictText('core.enabled', true)).toBe('启用')
    expect(dictTag('core.enabled', false)).toEqual({ label: '停用', type: 'info' })
    expect(dictText('core.enabled', null)).toBe('')
  })
})

describe('dates', () => {
  it('a date is that local day, an instant its ISO; none → 0', () => {
    const ms = msOf('2024-05-01')
    expect(new Date(ms).getHours()).toBe(0)
    expect(dateOf(ms)).toBe('2024-05-01')
    expect(msOf('2024-05-01T08:30:00.000Z')).toBe(Date.UTC(2024, 4, 1, 8, 30))
    expect(isoOf(Date.UTC(2024, 4, 1, 8, 30))).toBe('2024-05-01T08:30:00.000Z')
    expect([msOf(null), msOf(''), msOf(undefined)]).toEqual([0, 0, 0])
  })

  it('one picker for every field: opens at the field’s value (else now), writes the API’s form into its object', () => {
    const form = reactive({
      publishedOn: '2024-05-01' as string | null,
      lines: [{ at: null as string | null }],
    })
    const p = useDatePicker()
    p.open(form, 'publishedOn', 'date', 'Published on')
    expect(p.value.value).toBe(msOf('2024-05-01'))
    expect(p.picking.value?.title).toBe('Published on')
    p.pick({ value: new Date(2025, 0, 2, 13, 5).getTime() })
    expect(form.publishedOn).toBe('2025-01-02')
    p.closed(false)
    expect(p.picking.value).toBeNull()

    const now = Date.now()
    p.open(form.lines[0]!, 'at', 'datetime', 'At')
    expect(p.value.value).toBeGreaterThanOrEqual(now)
    p.pick({ value: Date.UTC(2025, 0, 2, 5, 6) })
    expect(form.lines[0]!.at).toBe('2025-01-02T05:06:00.000Z')
    p.closed(true)
    expect(p.picking.value).not.toBeNull()
  })
})
