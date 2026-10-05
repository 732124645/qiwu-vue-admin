// The upload field's size limit, as on the web: the server's public param `storage.max_size_mb`,
// read once per app run (here 50 MB); an explicit `maxSize` still wins.
import { expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { FsObjectVo } from '@qiwu/shared'
import { useUpload } from '@/core/pickers'

const MB = 1024 * 1024
const flush = () => new Promise((r) => setTimeout(r))

it('reads the server’s limit once; files above it are refused before sending, an explicit maxSize wins', async () => {
  const urls: string[] = []
  vi.mocked(uni.request).mockImplementation((o) => {
    urls.push(o.url)
    o.success?.({
      statusCode: 200,
      data: { code: 0, msg: 'ok', data: { key: 'storage.max_size_mb', value: '50' } },
    } as never)
    return {} as UniApp.RequestTask
  })
  vi.mocked(uni.uploadFile).mockImplementation(() => ({}) as UniApp.UploadTask)
  const field = (maxSize?: number) =>
    useUpload({
      model: ref<FsObjectVo[]>([]),
      bizTag: () => 'attachment',
      limit: () => 5,
      maxSize: () => maxSize,
    })
  const server = field()
  const own = field(10 * MB)
  await flush()
  expect(urls).toEqual(['/api/settings/params/public/storage.max_size_mb'])
  expect(server.maxSize()).toBe(50 * MB)
  expect(own.maxSize()).toBe(10 * MB)

  void server.add([
    { path: 'tmp://a.pdf', name: 'a.pdf', size: 30 * MB },
    { path: 'tmp://b.pdf', name: 'b.pdf', size: 50 * MB + 1 },
  ])
  expect(uni.uploadFile).toHaveBeenCalledTimes(1)
  expect(uni.showToast).toHaveBeenCalledWith({ title: 'b.pdf 超过 50 MB，未上传', icon: 'none' })
})
