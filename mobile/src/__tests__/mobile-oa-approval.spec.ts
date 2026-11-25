import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { formUploadIds, type FsObjectVo } from '@qiwu/shared'
import {
  createPage,
  decide,
  decisionAllowed,
  editPage,
  formPage,
  loadSummary,
} from '@/core/approvals'
import {
  ATTACHMENT_PREVIEW_MAX,
  attachmentMetadata,
  attachmentPreviewable,
  loadAttachments,
  localAttachmentPath,
  openAttachment,
  openAttachmentWithFeedback,
} from '@/core/attachments'
import { setLocale } from '@/core/i18n'
import { ApiError, downloadStorageContent, setSession } from '@/core/request'
import { decisionFormRules, processForm, uploadAttachments } from '../pages-wf/form/process-form'
import {
  availableActions,
  dynamicAttachmentsController,
  submitDecision,
} from '../pages-wf/detail/decision-controller'

const time = '2026-10-22T01:00:00.000Z'
const base = {
  id: 4,
  userId: 1,
  deptId: 2,
  state: 'in_review',
  instanceId: 20,
  attachmentIds: [7],
  createdBy: 1,
  createdAt: time,
  updatedBy: 1,
  updatedAt: time,
}
const trip = {
  ...base,
  destination: 'Branch office',
  startAt: time,
  endAt: '2026-10-23T01:00:00.000Z',
  reason: 'Supplier visit',
  estimatedAmount: '123.45',
}
const seal = {
  ...base,
  sealKind: 'company',
  documentName: 'Contract',
  purpose: 'Supplier agreement',
  copies: 3,
  expectedDate: '2026-10-23',
}
const expense = {
  ...base,
  reason: 'Trip expenses',
  tripId: 9,
  totalAmount: '0.30',
  currency: 'CNY',
  items: [
    {
      id: 10,
      claimId: 4,
      expenseDate: '2026-10-21',
      expenseKind: 'transport',
      amount: '0.10',
      description: 'Bus',
      attachmentIds: [8],
      sortNo: 0,
    },
    {
      id: 11,
      claimId: 4,
      expenseDate: '2026-10-22',
      expenseKind: 'meal',
      amount: '0.20',
      description: 'Meal',
      attachmentIds: [9],
      sortNo: 1,
    },
  ],
}
const leave = {
  ...base,
  leaveKind: 'annual',
  startAt: time,
  endAt: '2026-10-23T01:00:00.000Z',
  days: 1,
  reason: 'Appointment',
}
const file = (id = 7, over: Partial<FsObjectVo> = {}): FsObjectVo => ({
  id,
  originalName: `File ${id}.pdf`,
  mime: 'application/pdf',
  size: 100,
  url: null,
  isPublic: false,
  bizTag: 'oa.attachment',
  createdAt: time,
  ...over,
})
const instance = (kind: 'leave' | 'trip' | 'expense' | 'seal') => ({
  formKind: 'custom' as const,
  viewComponent: kind === 'leave' ? 'biz/leave/view' : `oa/${kind}/view`,
  businessKey: '4',
  id: 20,
  initiator: { id: 1, name: 'Applicant' },
})
const calls: UniApp.RequestOptions[] = []
let routes: Record<string, { status?: number; data?: unknown }>

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  setLocale('en-US')
  setSession({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800 })
  calls.length = 0
  routes = {
    '/biz/leaves/4': { data: leave },
    '/oa/trips/4': { data: trip },
    '/oa/expense-claims/4': { data: expense },
    '/oa/seal-requests/4': { data: seal },
    '/storage/objects/7/metadata': { data: file(7) },
    '/storage/objects/8/metadata': { data: file(8) },
    '/storage/objects/9/metadata': { data: file(9) },
  }
  vi.mocked(uni.request).mockImplementation((options) => {
    calls.push(options)
    const path = options.url.replace(/^\/api/, '')
    const reply = path.startsWith('/settings/dicts/')
      ? { data: { version: 1, entries: [] } }
      : (routes[path] ?? { status: 404 })
    options.success?.({
      statusCode: reply.status ?? 200,
      data: {
        code: reply.status ?? 0,
        msg: reply.status ? 'Unavailable' : 'ok',
        data: reply.data ?? null,
      },
    } as never)
    return {} as UniApp.RequestTask
  })
  vi.mocked(uni.downloadFile).mockImplementation((options) => {
    options.success?.({ statusCode: 200, tempFilePath: 'wxfile://tmp/document' } as never)
    return {} as UniApp.DownloadTask
  })
  vi.mocked(uni.openDocument).mockImplementation((options) =>
    options.success?.({ errMsg: 'openDocument:ok' }),
  )
  vi.mocked(uni.previewImage).mockImplementation((options) =>
    options.success?.({ errMsg: 'previewImage:ok' }),
  )
})

describe('mobile office approval documents', () => {
  it('maps fixed business views without adding new phone create or edit pages', () => {
    for (const kind of ['trip', 'expense', 'seal'] as const) {
      expect(formPage(instance(kind))).toBe(`/pages-biz/oa-${kind}/view?id=4&readonly=1`)
      expect(editPage(instance(kind), 3)).toBeNull()
      expect(createPage({ createRoute: `/oa/${kind}/new` })).toBeNull()
    }
    expect(formPage(instance('leave'))).toBe('/pages-biz/leave/view?id=4&readonly=1')
    expect(formPage({ ...instance('trip'), viewComponent: 'constructor' })).toBeNull()
  })

  it.each(['leave', 'trip', 'seal'] as const)(
    'loads the complete %s head and authorized private attachment metadata',
    async (kind) => {
      const summary = await loadSummary(instance(kind))
      expect(summary?.ready).toBe(true)
      expect(summary?.problem).toBeNull()
      expect(summary?.rows).toContainEqual({ label: 'Applicant', value: 'Applicant' })
      expect(summary?.attachments.map((item) => item.id)).toEqual([7])
      const values = summary!.rows.map((row) => row.value)
      if (kind === 'trip')
        expect(values).toEqual(
          expect.arrayContaining(['Branch office', 'Supplier visit', '123.45 CNY']),
        )
      if (kind === 'seal')
        expect(values).toEqual(
          expect.arrayContaining(['Contract', 'Supplier agreement', '3', '2026-10-23']),
        )
      if (kind === 'leave')
        expect(values).toEqual(expect.arrayContaining(['annual', '1', 'Appointment']))
      expect(calls.filter((call) => call.url.includes('/storage/'))[0].url).toBe(
        '/api/storage/objects/7/metadata',
      )
    },
  )

  it('shows every expense item and its own attachments with exact decimal amounts', async () => {
    const summary = await loadSummary(instance('expense'))
    expect(summary?.ready).toBe(true)
    expect(summary?.rows.map((row) => row.value)).toContain('0.30 CNY')
    expect(summary?.items).toHaveLength(2)
    expect(summary?.items[0].rows.map((row) => row.value)).toEqual([
      '2026-10-21',
      'transport',
      '0.10 CNY',
      'Bus',
    ])
    expect(summary?.items[1].rows.map((row) => row.value)).toEqual([
      '2026-10-22',
      'meal',
      '0.20 CNY',
      'Meal',
    ])
    expect(
      summary?.items.map((item) => item.attachments.map((attachment) => attachment.id)),
    ).toEqual([[8], [9]])
  })

  it('blocks malformed or mismatched business documents instead of approving a partial summary', async () => {
    for (const bad of [
      { ...expense, items: [] },
      { ...expense, totalAmount: '9.00' },
      { ...expense, totalAmount: '0.10', items: [{ ...expense.items[0], claimId: 99 }] },
      { ...expense, items: [expense.items[0], { ...expense.items[1], id: expense.items[0].id }] },
      { ...expense, id: 5 },
    ]) {
      routes['/oa/expense-claims/4'] = { data: bad }
      expect(await loadSummary(instance('expense'))).toBeNull()
    }
    expect(await loadSummary({ ...instance('trip'), id: 21 })).toBeNull()
    expect(
      await loadSummary({ ...instance('trip'), initiator: { id: 99, name: 'Other' } }),
    ).toBeNull()
    expect(await loadSummary({ ...instance('trip'), businessKey: '4/../../5' })).toBeNull()
  })

  it.each([403, 404])(
    'fails closed on a business or attachment %s without requesting global storage pages',
    async (status) => {
      routes['/oa/trips/4'] = { status }
      expect(await loadSummary(instance('trip'))).toBeNull()
      routes['/oa/trips/4'] = { data: trip }
      routes['/storage/objects/7/metadata'] = { status }
      const summary = await loadSummary(instance('trip'))
      expect(summary?.ready).toBe(false)
      expect(summary?.problem).toBeTruthy()
      expect(decisionAllowed('approve', !!summary?.ready)).toBe(false)
      expect(calls.some((call) => call.url === '/api/storage/objects')).toBe(false)
    },
  )

  it('renders the full supported expense row limit and refuses the next row without dropping it', async () => {
    const items = Array.from({ length: 500 }, (_, index) => ({
      ...expense.items[0],
      id: 1000 + index,
      amount: '0.01',
      attachmentIds: [],
    }))
    routes['/oa/expense-claims/4'] = { data: { ...expense, totalAmount: '5.00', items } }
    expect((await loadSummary(instance('expense')))?.items).toHaveLength(500)
    routes['/oa/expense-claims/4'] = {
      data: { ...expense, totalAmount: '5.01', items: [...items, { ...items[0], id: 2000 }] },
    }
    expect(await loadSummary(instance('expense'))).toBeNull()
  })

  it('keeps comments, cancellation and reminders while refusing blind business decisions', () => {
    for (const action of [
      'approve',
      'reject',
      'sendBack',
      'transfer',
      'delegate',
      'addSign',
      'removeSign',
      'withdraw',
      'resubmit',
      'cc',
    ] as const)
      expect(decisionAllowed(action, false)).toBe(false)
    for (const action of ['comment', 'cancel', 'urge'] as const)
      expect(decisionAllowed(action, false)).toBe(true)
    expect(decisionAllowed('approve', true)).toBe(true)
  })

  it('rejects unauthorized bindings, unsupported formats and oversized phone previews', async () => {
    for (const over of [
      { bizTag: 'wf.attachment' },
      { isPublic: true, url: null },
      { isPublic: false, url: 'https://untrusted.invalid/file' },
      { size: ATTACHMENT_PREVIEW_MAX + 1 },
      { mime: 'text/html' },
    ]) {
      routes['/storage/objects/7/metadata'] = { data: file(7, over) }
      const summary = await loadSummary(instance('trip'))
      expect(summary?.ready).toBe(false)
    }
    expect(attachmentPreviewable(file(7, { size: ATTACHMENT_PREVIEW_MAX }))).toBe(true)
    calls.length = 0
    vi.mocked(uni.request).mockImplementation((options) => {
      calls.push(options)
      const id = Number(/objects\/(\d+)\/metadata/.exec(options.url)?.[1])
      options.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data: file(id) } } as never)
      return {} as UniApp.RequestTask
    })
    await expect(
      loadAttachments(Array.from({ length: 101 }, (_, index) => index + 1)),
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
    expect(
      await loadAttachments(Array.from({ length: 100 }, (_, index) => index + 1)),
    ).toHaveLength(100)
  })

  it('reloads once after a conflicting action without automatically submitting again', async () => {
    routes['/wf/tasks/3/approve'] = { status: 409 }
    const reload = vi.fn(async () => {
      await loadSummary(instance('trip'))
    })
    await expect(decide(3, 'approve', {}, reload)).rejects.toMatchObject({ status: 409 })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(calls.filter((call) => call.url.endsWith('/wf/tasks/3/approve'))).toHaveLength(1)
  })

  it('keeps validation failures in place instead of reloading and dropping the entered comment', async () => {
    routes['/wf/tasks/3/approve'] = { status: 400 }
    const reload = vi.fn()
    await expect(decide(3, 'approve', {}, reload)).rejects.toMatchObject({ status: 400 })
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not request hidden dynamic attachments and refuses fields the phone cannot render', async () => {
    const schema = {
      rule: [
        { type: 'qw-upload', field: 'visible', title: 'Visible' },
        { type: 'qw-upload', field: 'hidden', title: 'Hidden' },
      ],
      option: {},
    }
    const rules = decisionFormRules(schema, { visible: 'read', hidden: 'hide' })!
    expect(rules.map((rule) => rule.field)).toEqual(['visible'])
    routes['/storage/objects/7/metadata'] = { data: file(7, { bizTag: 'wf.attachment' }) }
    await loadAttachments(
      formUploadIds(rules, { visible: '7/a.pdf', hidden: '999/secret.pdf' }),
      'wf.attachment',
    )
    expect(calls.filter((call) => call.url.includes('/metadata')).map((call) => call.url)).toEqual([
      '/api/storage/objects/7/metadata',
    ])
    const unsupported = {
      rule: [
        { type: 'cascader', field: 'many', title: 'Many', props: { props: { multiple: true } } },
      ],
      option: {},
    }
    expect(processForm(unsupported, {})).not.toBeNull()
    expect(decisionFormRules(unsupported, {})).toBeNull()
    expect(decisionFormRules({ rule: [{ type: 'script', field: 'bad' }] }, {})).toBeNull()
  })

  it('opens only authorized first-party content with a local runtime path, never a name or metadata URL', async () => {
    routes['/storage/objects/7/metadata'] = {
      data: file(7, { originalName: '../../evil.exe', url: 'https://untrusted.invalid/track' }),
    }
    await openAttachment(7)
    expect(vi.mocked(uni.downloadFile).mock.calls[0][0]).toMatchObject({
      url: '/api/storage/objects/7/content',
      header: { Authorization: 'Bearer a1', 'X-Client-Id': 'mobile' },
    })
    expect(vi.mocked(uni.openDocument).mock.calls[0][0]).toMatchObject({
      filePath: 'wxfile://tmp/document',
      fileType: 'pdf',
    })
    expect(localAttachmentPath('https://untrusted.invalid/file')).toBe(false)
    expect(localAttachmentPath('/tmp/../private')).toBe(false)
    expect(localAttachmentPath('//untrusted.invalid/file')).toBe(false)
    expect(localAttachmentPath('file://untrusted.invalid/share.pdf')).toBe(false)
    expect(localAttachmentPath('file:///tmp/document.pdf')).toBe(true)
  })

  it('uses an isolated local Blob download on H5 instead of relying on an asynchronous popup', async () => {
    const platform = process.env.UNI_PLATFORM
    const prior = globalThis.document
    const link = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() }
    process.env.UNI_PLATFORM = 'h5'
    vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } })
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:https://app.invalid/file-7')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    routes['/storage/objects/7/content'] = { data: new ArrayBuffer(10) }
    const normal = vi.mocked(uni.request).getMockImplementation()!
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.responseType === 'arraybuffer') {
        expect(options.url).toBe('/api/storage/objects/7/content')
        expect(options.header?.Authorization).toBe('Bearer a1')
        options.success?.({ statusCode: 200, data: new ArrayBuffer(10) } as never)
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    try {
      await openAttachment(7)
      expect(link.href).toBe('blob:https://app.invalid/file-7')
      expect(link.download).toBe('attachment-7.pdf')
      expect(link.rel).toBe('noopener noreferrer')
      expect(link.click).toHaveBeenCalledTimes(1)
      expect(uni.openDocument).not.toHaveBeenCalled()
      expect(uni.downloadFile).not.toHaveBeenCalled()
      expect(createUrl).toHaveBeenCalledTimes(1)
      setSession(null)
      expect(revoke).toHaveBeenCalledWith(link.href)
    } finally {
      createUrl.mockRestore()
      revoke.mockRestore()
      if (platform === undefined) delete process.env.UNI_PLATFORM
      else process.env.UNI_PLATFORM = platform
      vi.stubGlobal('document', prior)
    }
  })

  it('does not download forbidden metadata or display a wrong object', async () => {
    routes['/storage/objects/7/metadata'] = { status: 404 }
    await expect(openAttachment(7)).rejects.toBeInstanceOf(ApiError)
    expect(uni.downloadFile).not.toHaveBeenCalled()
    routes['/storage/objects/7/metadata'] = { data: file(8) }
    await expect(attachmentMetadata(7)).rejects.toThrow()
    await expect(openAttachment(-1)).rejects.toThrow()
  })

  it('never hands an unsupported file or remote runtime path to the native document viewer', async () => {
    routes['/storage/objects/7/metadata'] = { data: file(7, { mime: 'text/html' }) }
    await expect(openAttachment(7)).rejects.toThrow()
    expect(uni.downloadFile).not.toHaveBeenCalled()
    routes['/storage/objects/7/metadata'] = { data: file(7) }
    vi.mocked(uni.downloadFile).mockImplementation((options) => {
      options.success?.({
        statusCode: 200,
        tempFilePath: 'https://untrusted.invalid/file.pdf',
      } as never)
      return {} as UniApp.DownloadTask
    })
    await expect(openAttachment(7)).rejects.toThrow()
    expect(uni.openDocument).not.toHaveBeenCalled()
  })

  it('refreshes the content request once without sending tokens to a third-party URL', async () => {
    routes['/auth/refresh'] = { data: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 1800 } }
    let sent = 0
    vi.mocked(uni.downloadFile).mockImplementation((options) => {
      options.success?.({
        statusCode: ++sent === 1 ? 401 : 200,
        tempFilePath: 'wxfile://tmp/document',
      } as never)
      return {} as UniApp.DownloadTask
    })
    await openAttachment(7)
    expect(uni.downloadFile).toHaveBeenCalledTimes(2)
    expect(vi.mocked(uni.downloadFile).mock.calls[1][0].header?.Authorization).toBe('Bearer a2')
    expect(
      vi
        .mocked(uni.downloadFile)
        .mock.calls.every(([options]) => options.url === '/api/storage/objects/7/content'),
    ).toBe(true)
  })

  it('discards a content download and business result after the account changes', async () => {
    vi.mocked(uni.downloadFile).mockImplementation((options) => {
      setSession({ accessToken: 'other', refreshToken: 'other-r', expiresIn: 1800 })
      options.success?.({ statusCode: 200, tempFilePath: 'wxfile://tmp/document' } as never)
      return {} as UniApp.DownloadTask
    })
    await expect(openAttachment(7)).rejects.toMatchObject({ status: 401 })
    expect(uni.openDocument).not.toHaveBeenCalled()
    vi.mocked(uni.request).mockImplementation((options) => {
      setSession({ accessToken: 'next', refreshToken: 'next-r', expiresIn: 1800 })
      options.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data: trip } } as never)
      return {} as UniApp.RequestTask
    })
    expect(await loadSummary(instance('trip'))).toBeNull()
  })

  it.each(['trip', 'seal'] as const)(
    'refuses an otherwise valid %s with the wrong document ID',
    async (kind) => {
      routes[kind === 'trip' ? '/oa/trips/4' : '/oa/seal-requests/4'] = {
        data: { ...(kind === 'trip' ? trip : seal), id: 5 },
      }
      expect(await loadSummary(instance(kind))).toBeNull()
    },
  )

  it('limits actual pending metadata requests to four', async () => {
    const pending: UniApp.RequestOptions[] = []
    let active = 0
    let peak = 0
    vi.mocked(uni.request).mockImplementation((options) => {
      active++
      peak = Math.max(peak, active)
      pending.push(options)
      return {} as UniApp.RequestTask
    })
    const result = loadAttachments(Array.from({ length: 11 }, (_, index) => index + 1))
    for (const size of [4, 4, 3]) {
      await vi.waitFor(() => expect(pending).toHaveLength(size))
      for (const options of pending.splice(0)) {
        active--
        const id = Number(/objects\/(\d+)/.exec(options.url)?.[1])
        options.success?.({ statusCode: 200, data: { code: 0, data: file(id) } } as never)
      }
    }
    expect(await result).toHaveLength(11)
    expect(peak).toBe(4)
  })

  it('rejects a metadata-stage account switch before downloading or displaying the old file', async () => {
    let pending: UniApp.RequestOptions | undefined
    vi.mocked(uni.request).mockImplementation((options) => {
      pending = options
      return {} as UniApp.RequestTask
    })
    const result = openAttachment(7)
    setSession({ accessToken: 'new', refreshToken: 'new-r', expiresIn: 1800 })
    pending!.success?.({ statusCode: 200, data: { code: 0, data: file(7) } } as never)
    // content 的正常桩仍会返回 200，旧身份的 metadata 也不能用于新身份下载。
    await expect(result).rejects.toThrow('Session changed')
    expect(uni.downloadFile).not.toHaveBeenCalled()
    expect(uni.openDocument).not.toHaveBeenCalled()
    expect(uni.previewImage).not.toHaveBeenCalled()
  })

  it('rejects direct late metadata results after an account switch', async () => {
    let pending: UniApp.RequestOptions | undefined
    vi.mocked(uni.request).mockImplementation((options) => {
      pending = options
      return {} as UniApp.RequestTask
    })
    const result = loadAttachments([7])
    setSession(null)
    pending!.success?.({ statusCode: 200, data: { code: 0, data: file(7) } } as never)
    await expect(result).rejects.toThrow('Session changed')
  })

  it('checks readiness at sheet submission before validating or sending any body', async () => {
    const body = vi.fn(() => ({}))
    const unavailable = vi.fn()
    const close = vi.fn()
    const done = vi.fn()
    await submitDecision({
      on: { action: 'approve', id: 3, node: '', commentRequired: false },
      ready: false,
      body,
      unavailable,
      close,
      done,
      conflict: vi.fn(),
    })
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(body).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('filters the actual detail actions when attachment feedback blocks business decisions', async () => {
    const current = {
      id: 20,
      myTasks: [
        {
          id: 3,
          nodeId: 'review',
          nodeName: 'Review',
          commentRequired: false,
          type: 'review' as const,
          child: false,
        },
      ],
      signs: [],
      withdrawable: null,
      canCancel: true,
      canUrge: true,
    }
    expect(availableActions(current, true).map((item) => item.action)).toContain('approve')
    let ready = true
    let message = ''
    const unavailable = vi.fn(() => {
      ready = false
    })
    routes['/storage/objects/7/metadata'] = { status: 404 }
    await openAttachmentWithFeedback(7, {
      error: (text) => {
        message = text
      },
      unavailable,
    })
    expect(message).toBe('Unavailable')
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(availableActions(current, ready).map((item) => item.action)).toEqual([
      'comment',
      'urge',
      'cancel',
    ])
  })

  it('closes the actual sheet before its conflict reload callback and never resubmits', async () => {
    routes['/wf/tasks/3/approve'] = { status: 409 }
    let visible = true
    const close = vi.fn(() => {
      visible = false
    })
    const conflict = vi.fn(() => {
      expect(visible).toBe(false)
    })
    const done = vi.fn()
    await expect(
      submitDecision({
        on: { action: 'approve', id: 3, node: '', commentRequired: false },
        ready: true,
        body: () => ({ comment: 'Reviewed' }),
        unavailable: vi.fn(),
        close,
        done,
        conflict,
      }),
    ).rejects.toMatchObject({ status: 409 })
    expect(close).toHaveBeenCalledTimes(1)
    expect(conflict).toHaveBeenCalledTimes(1)
    expect(done).not.toHaveBeenCalled()
    expect(calls.filter((item) => item.url.endsWith('/approve'))).toHaveLength(1)
    routes['/wf/tasks/3/approve'] = { data: {} }
    await submitDecision({
      on: { action: 'approve', id: 3, node: '', commentRequired: false },
      ready: true,
      body: () => ({}),
      unavailable: vi.fn(),
      close,
      done,
      conflict,
    })
    expect(done).toHaveBeenCalledTimes(1)
    expect(conflict).toHaveBeenCalledTimes(1)
  })

  it('rechecks current visible editable uploads, blocks immediately and discards older batches', async () => {
    const schema = processForm(
      {
        rule: [
          { type: 'qw-upload', field: 'files', title: 'Files' },
          { type: 'qw-upload', field: 'hidden', title: 'Hidden' },
        ],
        option: {},
      },
      {},
    )!
    const access = { files: 'edit', hidden: 'hide' } as const
    const pending: UniApp.RequestOptions[] = []
    vi.mocked(uni.request).mockImplementation((options) => {
      pending.push(options)
      return {} as UniApp.RequestTask
    })
    let files: FsObjectVo[] = []
    let ready = true
    const changed = vi.fn((next: FsObjectVo[], readable: boolean) => {
      files = next
      ready = readable
    })
    const controller = dynamicAttachmentsController(changed)
    const first = controller.refresh(schema, access, {
      files: '7/old.pdf',
      hidden: '999/private.pdf',
    })
    expect(ready).toBe(false)
    const second = controller.refresh(schema, access, { files: '8/new.pdf' })
    expect(pending.map((item) => item.url)).toEqual([
      '/api/storage/objects/7/metadata',
      '/api/storage/objects/8/metadata',
    ])
    pending[1].success?.({
      statusCode: 200,
      data: { code: 0, data: file(8, { bizTag: 'wf.attachment' }) },
    } as never)
    await second
    expect(ready).toBe(true)
    expect(files.map((item) => item.id)).toEqual([8])
    pending[0].success?.({
      statusCode: 200,
      data: { code: 0, data: file(7, { bizTag: 'wf.attachment' }) },
    } as never)
    await first
    expect(files.map((item) => item.id)).toEqual([8])
    const unsupported = controller.refresh(schema, access, { files: '9/new.html' })
    expect(ready).toBe(false)
    pending[2].success?.({
      statusCode: 200,
      data: { code: 0, data: file(9, { bizTag: 'wf.attachment', mime: 'text/html' }) },
    } as never)
    await unsupported
    expect(ready).toBe(false)
    await controller.refresh(schema, access, { files: null })
    expect(ready).toBe(true)
    expect(files).toEqual([])
    await controller.refresh(schema, access, { files: 'invalid-reference' })
    expect(ready).toBe(false)
    expect(pending).toHaveLength(3)
    const stale = controller.refresh(schema, access, { files: '7/a.pdf' })
    setSession(null)
    pending[3].success?.({
      statusCode: 200,
      data: { code: 0, data: file(7, { bizTag: 'wf.attachment' }) },
    } as never)
    await stale
    expect(ready).toBe(false)
    expect(files).toEqual([])
  })

  it('bounds owned H5 blobs and clears replaced previews, failed opens, downloads and sessions', async () => {
    const platform = process.env.UNI_PLATFORM
    const prior = globalThis.document
    process.env.UNI_PLATFORM = 'h5'
    vi.useFakeTimers()
    let serial = 0
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => `blob:owned-${++serial}`)
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const link = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', { createElement: () => link, body: { appendChild: vi.fn() } })
    const normal = vi.mocked(uni.request).getMockImplementation()!
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.responseType === 'arraybuffer') {
        options.success?.({ statusCode: 200, data: new ArrayBuffer(4) } as never)
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    try {
      for (let index = 0; index < 4; index++) await downloadStorageContent(7)
      expect(revoke).toHaveBeenCalledWith('blob:owned-1')
      setSession({ accessToken: 'same', refreshToken: 'r2', expiresIn: 1800 })
      expect(revoke).toHaveBeenCalledTimes(4)
      routes['/storage/objects/7/metadata'] = { data: file(7, { mime: 'image/png' }) }
      await openAttachment(7)
      await openAttachment(7)
      expect(revoke).toHaveBeenCalledWith('blob:owned-5')
      vi.mocked(uni.previewImage).mockImplementationOnce((options) =>
        options.fail?.({ errMsg: 'unavailable' }),
      )
      await expect(openAttachment(7)).rejects.toThrow()
      expect(revoke).toHaveBeenCalledWith('blob:owned-7')
      routes['/storage/objects/7/metadata'] = { data: file(7) }
      await openAttachment(7)
      expect(revoke).not.toHaveBeenCalledWith('blob:owned-8')
      vi.advanceTimersByTime(60_000)
      expect(revoke).toHaveBeenCalledWith('blob:owned-8')
      vi.advanceTimersByTime(5 * 60_000)
      expect(revoke).toHaveBeenCalledWith('blob:owned-6')
      expect(uni.downloadFile).not.toHaveBeenCalled()
    } finally {
      setSession(null)
      vi.useRealTimers()
      createUrl.mockRestore()
      revoke.mockRestore()
      vi.stubGlobal('document', prior)
      if (platform === undefined) delete process.env.UNI_PLATFORM
      else process.env.UNI_PLATFORM = platform
    }
  })

  it('opens current editable upload metadata through the same authorized attachment entry as read-only fields', async () => {
    const visible = uploadAttachments('7/edited.pdf', [file(7), file(8)])
    expect(visible.map((item) => item.id)).toEqual([7])
    const unavailable = vi.fn()
    await openAttachmentWithFeedback(visible[0].id, { error: vi.fn(), unavailable })
    expect(uni.openDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'wxfile://tmp/document', fileType: 'pdf' }),
    )
    expect(unavailable).not.toHaveBeenCalled()
    expect(uploadAttachments(null, [file(7)])).toEqual([])
  })
})
