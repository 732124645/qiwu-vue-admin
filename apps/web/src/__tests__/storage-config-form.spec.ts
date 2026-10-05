// Storage config form (see docs/design-notes.md#storage): fields by driver (local: no root), the S3 secret shown as
// "unchanged" and left out of an untouched save, the generic connection test; against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { STORAGE_SECRET_MASK, type StorageConfigVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import DriverForm from '@/views/platform/storage/config/driver-form.vue'
import { mockApi, ok, type Route } from './mock-api'

const S3: StorageConfigVo = {
  id: 5,
  name: 'oss',
  driver: 's3',
  isPrimary: false,
  enabled: true,
  note: null,
  createdAt: '2026-09-28T01:00:00.000Z',
  updatedAt: '2026-09-28T01:00:00.000Z',
  endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
  region: 'cn-hangzhou',
  bucket: 'qw-files',
  accessKey: 'AKID',
  secretKey: STORAGE_SECRET_MASK,
  forcePathStyle: false,
  publicDomain: null,
}

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'POST /storage/configs': ok({ ...S3, id: 9 }),
    'GET /storage/configs/5': ok(S3),
    'PUT /storage/configs/5': ok(S3),
    ...extra,
  })
}
const body = (c: { data?: unknown } | undefined) => JSON.parse(String(c?.data)) as unknown

let form: VueWrapper
async function mountForm(id?: number) {
  form = mount(DriverForm, {
    props: { id },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  await flushPromises()
}
const labels = () => form.findAll('.el-form-item__label').map((l) => l.text())
const input = (label: string) =>
  form
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text() === label)!
    .find('input')
const button = (text: string) => form.findAll('button').find((b) => b.text() === text)
async function save() {
  await button('Save')!.trigger('click')
  await flushPromises()
}

let success: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  form.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('storage config form', () => {
  it('adds a local storage: no root field, only its own fields are sent', async () => {
    const calls = backend()
    await mountForm()
    expect(labels()).toContain('Public URL prefix')
    expect(labels().some((l) => /root/i.test(l))).toBe(false)
    expect(labels()).not.toContain('Endpoint')
    expect(form.text()).toContain('STORAGE_LOCAL_ROOT')
    // adding: no connection test (it tests saved settings)
    expect(button('Test connection')).toBeUndefined()

    await form.find('.el-form-item input').setValue('disk-2')
    await input('Public URL prefix').setValue('https://cdn.example.com/f')
    await save()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['post /storage/configs'])
    expect(body(calls[0])).toEqual({
      name: 'disk-2',
      enabled: true,
      note: null,
      driver: 'local',
      publicPrefix: 'https://cdn.example.com/f',
    })
    expect(form.emitted('done')?.[0]?.[0]).toMatchObject({ id: 9 })
  })

  it('adds an S3 storage: its fields show, are required as the contract says, and only they are sent', async () => {
    const calls = backend()
    await mountForm()
    await form
      .findAll('.el-radio')
      .find((r) => r.text() === 'S3-compatible')!
      .find('input')
      .setValue(true)
    expect(labels()).toEqual(
      expect.arrayContaining([
        'Endpoint',
        'Region',
        'Bucket',
        'Access key ID',
        'Secret access key',
        'Path-style access',
        'Public domain',
      ]),
    )
    expect(labels()).not.toContain('Public URL prefix')

    await form.find('.el-form-item input').setValue('oss')
    await save()
    expect(calls).toHaveLength(0)
    // el-form-item shows errors after a 100 ms debounce
    await vi.waitFor(() =>
      expect(form.findAll('.el-form-item__error').map((e) => e.text())).toContain(
        'Secret access key is required',
      ),
    )

    await input('Endpoint').setValue('https://oss-cn-hangzhou.aliyuncs.com')
    await input('Region').setValue('cn-hangzhou')
    await input('Bucket').setValue('qw-files')
    await input('Access key ID').setValue('AKID')
    await input('Secret access key').setValue('SECRET')
    await save()
    expect(body(calls[0])).toEqual({
      name: 'oss',
      enabled: true,
      note: null,
      driver: 's3',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      region: 'cn-hangzhou',
      bucket: 'qw-files',
      accessKey: 'AKID',
      secretKey: 'SECRET',
      forcePathStyle: false,
      publicDomain: null,
    })
  })

  it('edits an S3 storage: the secret shows blank as unchanged and stays out of the save until typed', async () => {
    const calls = backend()
    await mountForm(5)
    const secret = input('Secret access key')
    expect((secret.element as HTMLInputElement).value).toBe('')
    expect(secret.attributes('placeholder')).toBe('Unchanged: type a new key to replace it')
    expect(form.text()).not.toContain(STORAGE_SECRET_MASK)
    // the driver is set when adding
    expect(form.findAll('.el-radio input').every((r) => r.attributes('disabled') != null)).toBe(
      true,
    )

    // Other settings do not change the connection target or require a replacement secret.
    await input('Region').setValue('us-east-1')
    await input('Public domain').setValue('https://cdn.example.com')
    expect(secret.attributes('placeholder')).toBe('Unchanged: type a new key to replace it')
    await save()
    const put = calls.find((c) => c.method === 'put')
    expect(put?.url).toBe('/storage/configs/5')
    expect(body(put)).not.toHaveProperty('secretKey')
    expect(body(put)).toMatchObject({ driver: 's3', bucket: 'qw-files', accessKey: 'AKID' })
    expect(success).toHaveBeenCalledWith('Saved')

    await secret.setValue('NEW-SECRET')
    await save()
    expect(body(calls.findLast((c) => c.method === 'put'))).toMatchObject({
      secretKey: 'NEW-SECRET',
    })
  })

  it.each([
    ['Endpoint', 'endpoint', 'https://s3.example.com'],
    ['Bucket', 'bucket', 'other-files'],
    ['Access key ID', 'accessKey', 'NEW-AKID'],
  ] as const)(
    'requires a new secret when editing %s, but permits blank after restoring it',
    async (label, key, value) => {
      const calls = backend()
      await mountForm(5)
      const secret = input('Secret access key')
      const hint = 'Re-enter the secret key after changing the storage connection settings.'
      await input(label).setValue(value)
      expect(secret.attributes('placeholder')).toBe(hint)
      expect(secret.element.closest('.el-form-item')?.classList.contains('is-required')).toBe(true)

      for (const emptySecret of ['', '   ', STORAGE_SECRET_MASK]) {
        await secret.setValue(emptySecret)
        await save()
        expect(calls.some((c) => c.method === 'put')).toBe(false)
        await vi.waitFor(() => expect(form.find('.el-form-item__error').text()).toBe(hint))
      }

      await input(label).setValue(S3[key])
      await secret.setValue('')
      expect(secret.attributes('placeholder')).toBe('Unchanged: type a new key to replace it')
      expect(secret.element.closest('.el-form-item')?.classList.contains('is-required')).toBe(false)
      await save()
      expect(body(calls.find((c) => c.method === 'put'))).not.toHaveProperty('secretKey')

      await input(label).setValue(value)
      await secret.setValue('NEW-SECRET')
      await save()
      expect(body(calls.findLast((c) => c.method === 'put'))).toMatchObject({
        [key]: value,
        secretKey: 'NEW-SECRET',
      })
    },
  )

  it('tests the saved connection and shows only whether it worked', async () => {
    let answer = (_reply: ReturnType<typeof ok>) => {}
    const calls = backend({
      'POST /storage/configs/5/test': () => new Promise((r) => (answer = r)),
    })
    await mountForm(5)
    await button('Test connection')!.trigger('click')
    expect(button('Test connection')!.classes()).toContain('is-loading')
    answer(ok({ ok: false }))
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({ method: 'post', url: '/storage/configs/5/test' })
    expect(form.find('.el-alert').text()).toBe(
      'Connection failed. Check the endpoint, region, bucket and access keys.',
    )
    expect(form.find('.el-alert').classes()).toContain('el-alert--error')

    await button('Test connection')!.trigger('click')
    answer(ok({ ok: true }))
    await flushPromises()
    expect(form.find('.el-alert').text()).toBe('Connection succeeded')
    // testing saves nothing
    expect(calls.some((c) => c.method === 'put')).toBe(false)
  })
})
