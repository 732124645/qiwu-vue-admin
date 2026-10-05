// Pickers: dict options, the dept tree, the user picker's searches and picks, the upload field.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { DeptTreeNode, DictPayload, FsObjectVo } from '@qiwu/shared'
import { formatSize } from '@/core/format'
import { setLocale } from '@/core/i18n'
import {
  SEARCH_DEBOUNCE_MS,
  choiceText,
  deptChoices,
  deptPath,
  dictChoices,
  loadDepts,
  loadDict,
  useUpload,
  useUserPicker,
} from '@/core/pickers'
import { setSession } from '@/core/request'

type Req = UniApp.RequestOptions
/** the pending calls, answered by the spec */
const calls: Req[] = []
const flush = () => new Promise((r) => setTimeout(r))
const ok = (o: Req, data: unknown) =>
  o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data } } as never)
const fail = (o: Req, statusCode = 500) =>
  o.success?.({ statusCode, data: { code: 'X', msg: 'boom' } } as never)
const call = (i = 0) => calls[i]!
const query = (o: Req) => [o.url, o.data]

beforeEach(() => {
  setSession({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800 })
  calls.length = 0
  vi.mocked(uni.showToast).mockClear()
  vi.mocked(uni.request).mockImplementation((o) => {
    calls.push(o)
    return {} as UniApp.RequestTask
  })
})
afterEach(() => {
  vi.useRealTimers()
  setLocale('zh-CN')
})

const tree: DeptTreeNode[] = [
  {
    id: 1,
    parentId: 0,
    name: 'seed.dept.hq',
    children: [
      { id: 2, parentId: 1, name: 'seed.dept.rd', children: [] },
      { id: 3, parentId: 1, name: 'Sales', children: [] },
    ],
  },
]

describe('dicts', () => {
  const entry = (value: string, label: string, labelI18n: DictPayload['entries'][0]['labelI18n']) => ({
    value,
    label,
    labelI18n,
    tagType: null,
    cssClass: null,
    isDefault: false,
    sortNo: 0,
  })
  const dict: DictPayload = {
    version: 1,
    entries: [
      entry('annual', 'Annual', { 'zh-CN': '年假', 'en-US': 'Annual leave' }),
      entry('sick', 'seed.dept.rd', null),
      entry('other', '', null),
    ],
  }

  it('labels entries in the current language: labelI18n, else the (seeded) label, else the code', () => {
    const labels = () => dictChoices(dict).map((c) => c.label)
    expect(labels()).toEqual(['年假', '研发中心', 'other'])
    setLocale('en-US')
    expect(labels()).toEqual(['Annual leave', 'R&D Center', 'other'])
    expect(dictChoices(undefined)).toEqual([])
  })

  it('shows the labels of one or several codes; an unknown code as itself', () => {
    const choices = dictChoices(dict)
    expect(choiceText(choices, 'annual')).toBe('年假')
    expect(choiceText(choices, ['annual', 'gone'])).toBe('年假 · gone')
    expect(choiceText(choices, null)).toBe('')
  })

  it('loads a dict once; a failed load is asked again next time', async () => {
    const first = loadDict('biz.kind_a')
    expect(loadDict('biz.kind_a')).toBe(first)
    expect(calls.map(query)).toEqual([['/api/settings/dicts/biz.kind_a/entries', undefined]])
    fail(call())
    await expect(first).rejects.toMatchObject({ status: 500 })
    const again = loadDict('biz.kind_a')
    expect(calls).toHaveLength(2)
    ok(call(1), dict)
    await expect(again).resolves.toEqual(dict)
    expect(loadDict('biz.kind_a')).toBe(again)
    expect(calls).toHaveLength(2)
  })
})

describe('depts', () => {
  it('maps the tree to cascader options with localized names', () => {
    expect(deptChoices(tree)).toEqual([
      {
        value: 1,
        text: '总部',
        children: [
          { value: 2, text: '研发中心', children: [] },
          { value: 3, text: 'Sales', children: [] },
        ],
      },
    ])
  })

  it('loads the caller-scoped tree, or with `wf` every dept (a process form)', () => {
    void loadDepts()
    void loadDepts('wf')
    expect(calls.map((o) => [o.method, o.url])).toEqual([
      ['GET', '/api/iam/depts/tree'],
      ['GET', '/api/wf/depts/options'],
    ])
  })

  it('finds the path to a dept, empty when the tree lacks it', () => {
    expect(deptPath(tree, 3).map((d) => d.id)).toEqual([1, 3])
    expect(deptPath(tree, 1).map((d) => d.id)).toEqual([1])
    expect(deptPath(tree, 9)).toEqual([])
  })
})

describe('user picker', () => {
  const ann = { id: 5, displayName: 'Ann', deptName: 'seed.dept.rd' }
  const bob = { id: 6, displayName: 'Bob', deptName: null }

  it('wf: every enabled user, searched by name 300 ms after the last keystroke', async () => {
    vi.useFakeTimers()
    const p = useUserPicker('wf', false)
    p.open([])
    expect(calls.map(query)).toEqual([['/api/wf/users/options', {}]])
    ok(call(), [ann, bob])
    await vi.advanceTimersByTimeAsync(0)
    expect(p.rows.value).toEqual([ann, bob])
    expect(p.loading.value).toBe(false)

    p.keyword.value = 'a'
    await nextTick()
    p.keyword.value = ' an '
    await nextTick()
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map(query)[1]).toEqual(['/api/wf/users/options', { keyword: 'an' }])
    // reopening keeps the list and search; only the picks start from the field again
    p.open([bob])
    expect(calls).toHaveLength(2)
    expect([...p.picked.keys()]).toEqual([6])
  })

  it('drops the answer of an older search; a failed one empties the list', async () => {
    vi.useFakeTimers()
    const search = async (keyword: string) => {
      p.keyword.value = keyword
      await nextTick()
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    }
    const p = useUserPicker('wf', false)
    p.open([])
    await search('b')
    ok(call(1), [bob])
    ok(call(0), [ann, bob])
    await vi.advanceTimersByTimeAsync(0)
    expect(p.rows.value).toEqual([bob])
    // the request layer showed why
    await search('x')
    fail(call(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(p.rows.value).toEqual([])
    expect(p.loading.value).toBe(false)
  })

  it('single replaces the pick; multiple toggles and keeps picking order', () => {
    const single = useUserPicker('wf', false)
    single.open([ann])
    single.toggle(bob)
    single.toggle(bob)
    expect([...single.picked.keys()]).toEqual([6])

    const multi = useUserPicker('wf', true)
    multi.open([bob])
    multi.toggle(ann)
    expect([...multi.picked.values()]).toEqual([bob, ann])
    multi.toggle(bob)
    expect([...multi.picked.keys()]).toEqual([5])
  })

  it('iam: the caller-scoped users with the dept tree; a dept drilled into lists its subtree', async () => {
    const p = useUserPicker('iam', true)
    p.open([])
    expect(calls.map(query)).toEqual([
      ['/api/iam/users/options', {}],
      ['/api/iam/depts/tree', undefined],
    ])
    ok(call(1), tree)
    await flush()
    expect(p.subDepts.value.map((d) => d.id)).toEqual([1])

    p.enter(tree[0]!)
    expect(p.subDepts.value.map((d) => d.id)).toEqual([2, 3])
    p.enter(tree[0]!.children[0]!)
    expect(query(call(2))).toEqual(['/api/iam/users/options', { deptId: 1 }])
    expect(query(call(3))).toEqual(['/api/iam/users/options', { deptId: 2 }])
    expect(p.subDepts.value).toEqual([])

    p.back(2) // where it is: no reload
    expect(calls).toHaveLength(4)
    p.back(0)
    expect(p.path.value).toEqual([])
    expect(query(call(4))).toEqual(['/api/iam/users/options', {}])
  })
})

describe('upload', () => {
  const stored = (id: number) => ({ id, originalName: `f${id}.pdf`, size: 10 }) as FsObjectVo
  type Up = UniApp.UploadFileOption
  const uploads: Up[] = []
  const answer = async (i: number, statusCode: number, data: unknown) => {
    uploads[i]!.success?.({ statusCode, data: JSON.stringify(data) } as never)
    await flush()
  }

  beforeEach(() => {
    uploads.length = 0
    vi.mocked(uni.uploadFile).mockImplementation((o) => {
      uploads.push(o)
      return {} as UniApp.UploadTask
    })
  })

  const field = (list: FsObjectVo[] = [], limit = 3) => {
    const model = ref(list)
    const u = useUpload({
      model,
      bizTag: () => 'attachment',
      limit: () => limit,
      maxSize: () => 1024,
    })
    return { model, ...u }
  }

  it('uploads picked files one at a time through the backend, bizTag first, and appends each', async () => {
    const f = field([stored(1)])
    const done = f.add([
      { path: 'tmp://a.pdf', name: 'a.pdf', size: 100 },
      { path: 'tmp/dir/b.png' },
    ])
    expect(f.pending.value.map((p) => p.name)).toEqual(['a.pdf', 'b.png'])
    expect(f.remaining()).toBe(0)
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({
      url: '/api/storage/objects',
      filePath: 'tmp://a.pdf',
      name: 'file',
      formData: { bizTag: 'attachment' },
    })
    await answer(0, 201, { code: 0, msg: 'ok', data: stored(2) })
    expect(f.model.value.map((o) => o.id)).toEqual([1, 2])
    expect(uploads).toHaveLength(2)
    // a refused file (toasted by the request layer) leaves the list as it was
    await answer(1, 415, { code: 'S4150', msg: 'refused type' })
    await done
    expect(f.model.value.map((o) => o.id)).toEqual([1, 2])
    expect(f.pending.value).toEqual([])
    expect(uni.showToast).toHaveBeenCalledWith({ title: 'refused type', icon: 'none' })

    f.remove(f.model.value[0]!)
    expect(f.model.value.map((o) => o.id)).toEqual([2])
    expect(f.remaining()).toBe(2)
  })

  it('refuses files over the count or size limit before sending them', async () => {
    const f = field([stored(1)], 2)
    void f.add([
      { path: 'tmp://big.pdf', name: 'big.pdf', size: 2048 },
      { path: 'tmp://c.pdf', name: 'c.pdf', size: 10 },
    ])
    expect(uni.showToast).toHaveBeenCalledWith({ title: '最多上传 2 个文件', icon: 'none' })
    expect(uni.showToast).toHaveBeenCalledWith({ title: 'big.pdf 超过 1 KB，未上传', icon: 'none' })
    expect(uploads).toEqual([])
    expect(f.pending.value).toEqual([])
  })
})

it('formats sizes with one decimal', () => {
  expect([0, 1000, 1536, 20 * 1024 * 1024, 5 * 1024 ** 4].map(formatSize)).toEqual([
    '0 B',
    '1000 B',
    '1.5 KB',
    '20 MB',
    '5120 GB',
  ])
})
