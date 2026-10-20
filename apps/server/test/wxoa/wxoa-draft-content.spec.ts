import { describe, expect, it, vi } from 'vitest'
import { WXOA_CONTENT_MAX } from '@qiwu/shared'
import { ValidationException } from '../../src/core/http/validation.pipe.js'
import { FsObject } from '../../src/modules/platform/storage/fs-object.entity.js'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
import { WxoaDraftService } from '../../src/modules/platform/wxoa/draft/draft.service.js'
import { WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { WxoaInlineImage, WxoaMaterial } from '../../src/modules/platform/wxoa/core/wxoa.entity.js'

/** A repository-shaped test double for the draft service's content pipeline. */
function draftService() {
  const materials: Record<string, unknown>[] = []
  const objects: Record<string, unknown>[] = []
  const inline = new Map<string, string>()
  const materialRepo = {
    find: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => materials),
  }
  const objectRepo = {
    findOne: vi.fn<
      (arg: {
        where: { publicUrl: string; bizTag?: string; isPublic?: boolean }
      }) => Promise<Record<string, unknown> | null>
    >(
      async ({ where }: { where: { publicUrl: string; bizTag?: string; isPublic?: boolean } }) =>
        objects.find(
          (object) =>
            object.publicUrl === where.publicUrl &&
            (!where.bizTag || object.bizTag === where.bizTag) &&
            (where.isPublic === undefined || object.isPublic === where.isPublic) &&
            !object.deletedAt,
        ) ?? null,
    ),
  }
  const inlineRepo = {
    findOne: vi.fn<
      (arg: { where: { accountId: number; objectId: number } }) => Promise<{ wxUrl: string } | null>
    >(async ({ where }: { where: { accountId: number; objectId: number } }) => {
      const wxUrl = inline.get(`${where.accountId}:${where.objectId}`)
      return wxUrl ? { wxUrl } : null
    }),
    insert: vi.fn<(row: { accountId: number; objectId: number; wxUrl: string }) => Promise<void>>(
      async (row: { accountId: number; objectId: number; wxUrl: string }) => {
        inline.set(`${row.accountId}:${row.objectId}`, row.wxUrl)
      },
    ),
  }
  const manager = {
    getRepository: vi.fn<(entity: unknown) => unknown>((entity: unknown) => {
      if (entity === WxoaMaterial) return materialRepo
      if (entity === FsObject) return objectRepo
      if (entity === WxoaInlineImage) return inlineRepo
      throw new Error(`unexpected repository: ${String(entity)}`)
    }),
  }
  const draftRepo = { manager }
  const txHost = {
    tx: { getRepository: vi.fn<() => typeof draftRepo>(() => draftRepo) },
  }
  const gateway = {
    json: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    upload: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  }
  const storage = { readInternal: vi.fn<(...args: unknown[]) => Promise<unknown>>() }
  const service = new WxoaDraftService(
    txHost as never,
    gateway as unknown as WxoaGateway,
    storage as unknown as StorageService,
  )
  return {
    service,
    materials,
    objects,
    inline,
    materialRepo,
    objectRepo,
    inlineRepo,
    gateway,
    storage,
  }
}

const account = { id: 7, appId: 'wx_test', accountKind: 'service' as const }
const cover = { mediaId: 'cover-1', mediaKind: 'image' }

describe('wxoa draft content pipeline', () => {
  it('sanitizes executable markup and enforces the stored content limit', async () => {
    const c = draftService()
    c.materials.push(cover)
    const normalize = (
      c.service as unknown as {
        normalizeArticles: (
          accountId: number,
          articles: Record<string, unknown>[],
        ) => Promise<Record<string, unknown>[]>
      }
    ).normalizeArticles.bind(c.service)
    const unsafe = await normalize(7, [
      {
        title: 'safe',
        content:
          '<p onclick="alert(1)" style="color:red">ok</p><script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)" data-x="1">',
        thumbMediaId: cover.mediaId,
      },
    ])
    expect(unsafe[0]!.content).toBe('<p>ok</p><img />')
    expect(unsafe[0]!.content).not.toMatch(/script|onclick|style=|javascript:|data-x|onerror/i)

    const exact = await normalize(7, [
      { title: 'exact', content: 'x'.repeat(WXOA_CONTENT_MAX), thumbMediaId: cover.mediaId },
    ])
    expect((exact[0]!.content as string).length).toBe(WXOA_CONTENT_MAX)
    await expect(
      normalize(7, [
        {
          title: 'too long',
          content: 'x'.repeat(WXOA_CONTENT_MAX + 1),
          thumbMediaId: cover.mediaId,
        },
      ]),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ValidationException &&
        err.issues[0]!.path.join('.') === 'articles.0.content',
    )
  })

  it('rewrites only exact local public rich-text images and reuses one upload', async () => {
    const c = draftService()
    const src = 'https://files.example/rich/a.jpg'
    c.objects.push({
      id: 11,
      publicUrl: src,
      bizTag: 'richtext',
      isPublic: true,
      size: 8,
      mime: 'image/jpeg',
      originalName: 'a.jpg',
    })
    c.storage.readInternal.mockResolvedValue({ data: Buffer.from('jpeg') })
    c.gateway.upload.mockResolvedValue({ url: 'http://mmbiz.qpic.cn/wx/a' })
    const rewrite = (
      c.service as unknown as {
        rewriteImages: (
          accountId: number,
          caller: typeof account,
          articles: Record<string, unknown>[],
        ) => Promise<unknown>
      }
    ).rewriteImages.bind(c.service)

    const result = (await rewrite(7, account, [
      { content: `<p><img src="${src}"><img src="${src}"></p>` },
    ])) as { articles: { content: string }[]; unsyncedImages: unknown[] }
    expect(result.articles[0]!.content).toBe(
      '<p><img src="https://mmbiz.qpic.cn/wx/a" /><img src="https://mmbiz.qpic.cn/wx/a" /></p>',
    )
    expect(result.unsyncedImages).toEqual([])
    expect(c.storage.readInternal).toHaveBeenCalledTimes(1)
    expect(c.gateway.upload).toHaveBeenCalledTimes(1)
    expect(c.inlineRepo.insert).toHaveBeenCalledTimes(1)

    const second = (await rewrite(7, account, [{ content: `<img src="${src}">` }])) as {
      articles: { content: string }[]
    }
    expect(second.articles[0]!.content).toBe('<img src="https://mmbiz.qpic.cn/wx/a" />')
    expect(c.storage.readInternal).toHaveBeenCalledTimes(1)
    expect(c.gateway.upload).toHaveBeenCalledTimes(1)
  })

  it('rewrites only the matched img and never expands replacement patterns', async () => {
    const c = draftService()
    const src = 'https://files.example/rich/b.jpg'
    c.objects.push({
      id: 31,
      publicUrl: src,
      bizTag: 'richtext',
      isPublic: true,
      size: 8,
      mime: 'image/jpeg',
      originalName: 'b.jpg',
    })
    c.storage.readInternal.mockResolvedValue({ data: Buffer.from('jpeg') })
    // 一个带 $& 与 $' 的上传地址：按字符串模式替换会把它们展开
    c.gateway.upload.mockResolvedValue({ url: "https://mmbiz.qpic.cn/wx/$&$'" })
    const rewrite = (
      c.service as unknown as {
        rewriteImages: (
          accountId: number,
          caller: typeof account,
          articles: Record<string, unknown>[],
        ) => Promise<{ articles: { content: string }[] }>
      }
    ).rewriteImages.bind(c.service)
    const result = await rewrite(7, account, [
      { content: `<p>${src}</p><img alt="${src}" src="${src}">` },
    ])
    expect(result.articles[0]!.content).toBe(
      `<p>${src}</p><img alt="${src}" src="https://mmbiz.qpic.cn/wx/$&amp;$'" />`,
    )
  })

  it('preserves approved mmbiz hosts and reports every unsupported image without fetching it', async () => {
    const c = draftService()
    c.objects.push({
      id: 12,
      publicUrl: 'https://files.example/rich/large.png',
      bizTag: 'richtext',
      isPublic: true,
      size: 1024 * 1024,
      mime: 'image/png',
      originalName: 'large.png',
    })
    const rewrite = (
      c.service as unknown as {
        rewriteImages: (
          accountId: number,
          caller: typeof account,
          articles: Record<string, unknown>[],
        ) => Promise<unknown>
      }
    ).rewriteImages.bind(c.service)
    const external = 'https://outside.example/a.jpg'
    const query = 'https://files.example/rich/a.jpg?cache=1'
    const traversal = 'https://files.example/files/../private.jpg'
    const result = (await rewrite(7, account, [
      {
        content: `<p><img src="http://mmbiz.qpic.cn/mmbiz/a"><img src="${external}"><img src="${query}"><img src="${traversal}"><img src="https://files.example/rich/large.png"><img src="https://outside.example/a.gif" srcset="${external} 2x"></p>`,
      },
    ])) as { articles: { content: string }[]; unsyncedImages: { src: string; reason: string }[] }
    expect(result.articles[0]!.content).toBe('<p><img src="https://mmbiz.qpic.cn/mmbiz/a" /></p>')
    expect(result.unsyncedImages).toEqual([
      { src: external, reason: 'not_local' },
      { src: query, reason: 'not_local' },
      { src: traversal, reason: 'not_local' },
      { src: 'https://files.example/rich/large.png', reason: 'too_large' },
      { src: 'https://outside.example/a.gif', reason: 'not_local' },
    ])
    expect(c.gateway.upload).not.toHaveBeenCalled()
    expect(c.storage.readInternal).not.toHaveBeenCalled()
  })

  it('does not turn a private, deleted, or non-rich-text object into a public image', async () => {
    const c = draftService()
    const rows = [
      {
        id: 21,
        publicUrl: 'https://files.example/private.jpg',
        bizTag: 'private',
        isPublic: true,
        size: 8,
        mime: 'image/jpeg',
        originalName: 'private.jpg',
      },
      {
        id: 22,
        publicUrl: 'https://files.example/hidden.jpg',
        bizTag: 'richtext',
        isPublic: false,
        size: 8,
        mime: 'image/jpeg',
        originalName: 'hidden.jpg',
      },
      {
        id: 23,
        publicUrl: 'https://files.example/deleted.jpg',
        bizTag: 'richtext',
        isPublic: true,
        deletedAt: new Date(),
        size: 8,
        mime: 'image/jpeg',
        originalName: 'deleted.jpg',
      },
    ]
    c.objects.push(...rows)
    const rewrite = (
      c.service as unknown as {
        rewriteImages: (
          accountId: number,
          caller: typeof account,
          articles: Record<string, unknown>[],
        ) => Promise<unknown>
      }
    ).rewriteImages.bind(c.service)
    const result = (await rewrite(7, account, [
      { content: rows.map((row) => `<img src="${row.publicUrl}">`).join('') },
    ])) as { articles: { content: string }[]; unsyncedImages: { src: string; reason: string }[] }
    expect(result.articles[0]!.content).toBe('')
    expect(result.unsyncedImages).toEqual(
      rows.map((row) => ({ src: row.publicUrl, reason: 'not_local' })),
    )
    expect(c.gateway.upload).not.toHaveBeenCalled()
    expect(c.storage.readInternal).not.toHaveBeenCalled()
  })

  it('checks the rewritten HTML length after a local URL becomes long', async () => {
    const c = draftService()
    const src = 'https://files.example/rich/a.png'
    c.objects.push({
      id: 13,
      publicUrl: src,
      bizTag: 'richtext',
      isPublic: true,
      size: 8,
      mime: 'image/png',
      originalName: 'a.png',
    })
    c.storage.readInternal.mockResolvedValue({ data: Buffer.from('png') })
    c.gateway.upload.mockResolvedValue({ url: `https://mmbiz.qpic.cn/${'x'.repeat(2000)}` })
    const rewrite = (
      c.service as unknown as {
        rewriteImages: (
          accountId: number,
          caller: typeof account,
          articles: Record<string, unknown>[],
        ) => Promise<unknown>
      }
    ).rewriteImages.bind(c.service)
    const image = `<img src="${src}">`
    const content = `<p>${'x'.repeat(WXOA_CONTENT_MAX - image.length - 3)}${image}</p>`
    await expect(rewrite(7, account, [{ content }])).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ValidationException &&
        err.issues[0]!.path.join('.') === 'articles.0.content',
    )
    expect(c.gateway.upload).toHaveBeenCalledTimes(1)
  })
})
