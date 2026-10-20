import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  WXOA_CONTENT_MAX,
  WXOA_ARTICLE_MAX,
  type WxoaDraftCreate,
  type WxoaDraftQuery,
  type WxoaDraftUpdate,
} from '@qiwu/shared'
import { In, type SelectQueryBuilder } from 'typeorm'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { contains } from '../../../../core/db/page.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { ValidationException } from '../../../../core/http/validation.pipe.js'
import { sanitizeRichText } from '../../../../core/sanitize.js'
import { StorageService } from '../../storage/storage.service.js'
import { FsObject } from '../../storage/fs-object.entity.js'
import { WxoaDraft, WxoaInlineImage, WxoaMaterial } from '../core/wxoa.entity.js'
import { WxoaGateway } from '../core/wxoa-gateway.js'
import { draftDigest, jsonObject, textOf, activeAccount } from '../core/wxoa-util.js'

const MMBIZ = new Set(['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'])
const MAX_IMAGE = 1024 * 1024
/** draft/batchget 每页最多 20 条。 */
const PULL_PAGE = 20
// 上限：拉取最多 50 页（1000 条草稿），草稿箱更大时再改成分批拉取
const PULL_PAGES_MAX = 50
/** 单条 draft/get 的应答上限：最多 8 篇、每篇正文官方上限 1 MB。 */
const DRAFT_ANSWER_MAX = 10 * 1024 * 1024
const mediaId = (x: unknown) => (typeof x === 'string' && x.length <= 128 ? x : null)
const flag = (v: unknown) => v === 1 || v === '1' || v === true

/** 正文超长的 400：与请求校验同样的字段路径和提示（`articles.<i>.content`）。 */
function tooLong(i: number): ValidationException {
  const e = new ValidationException([
    {
      code: 'custom',
      path: ['articles', i, 'content'],
      message: 'validation.too_big.string',
      params: { maximum: WXOA_CONTENT_MAX },
      input: '',
    },
  ])
  e.domain = 'wxoa.draft'
  return e
}

/** 草稿的接口视图：`dirty` 表示本地有尚未同步到草稿箱的修改（或从未同步过）。 */
const vo = (row: WxoaDraft) => ({
  ...row,
  dirty: !row.mediaId || row.syncedDigest !== draftDigest(row.articles),
})

/** 本地文章（驼峰）→ 草稿箱接口的字段（下划线，开关用 0/1），只做图文 news。 */
const toWx = (a: Record<string, unknown>) => ({
  article_type: 'news',
  title: textOf(a.title),
  author: textOf(a.author),
  digest: textOf(a.digest),
  content: textOf(a.content),
  content_source_url: textOf(a.contentSourceUrl),
  thumb_media_id: textOf(a.thumbMediaId),
  need_open_comment: a.needOpenComment === false ? 0 : 1,
  only_fans_can_comment: a.onlyFansCanComment === true ? 1 : 0,
})

@Injectable()
export class WxoaDraftService extends BaseCrudService<WxoaDraft> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly storage: StorageService,
  ) {
    super(txHost, WxoaDraft)
  }

  /** 列表只含所查账号的行（同租户的其它账号不混入），可按首篇标题模糊搜索。 */
  protected override filter(
    qb: SelectQueryBuilder<WxoaDraft>,
    q: WxoaDraftQuery,
  ): SelectQueryBuilder<WxoaDraft> {
    qb.andWhere('t.accountId = :accountId', { accountId: q.accountId })
    if (q.title) qb.andWhere('t.title LIKE :title', { title: contains(q.title) })
    return qb
  }
  /** 本账号草稿分页，每行带 `dirty`。 */
  async list(query: WxoaDraftQuery) {
    await activeAccount(this.txHost, query.accountId)
    const page = await this.page(query)
    return { ...page, items: page.items.map(vo) }
  }
  /** 草稿详情。 */
  async one(id: number) {
    return vo(await this.get(id))
  }
  /** 新建本地草稿：正文清洗、长度与封面校验后入库，尚未同步。 */
  async add(dto: WxoaDraftCreate) {
    const account = await activeAccount(this.txHost, dto.accountId)
    const articles = await this.normalizeArticles(account.id, dto.articles)
    const row = await this.create({
      accountId: account.id,
      title: textOf(articles[0]!.title),
      articles: articles as never,
      mediaId: null,
      origin: 'local',
      syncedAt: null,
      syncedDigest: null,
    })
    return vo(await this.get(row.id))
  }
  /** 修改本地草稿；之后与草稿箱不一致（dirty），发布或群发前须重新同步。 */
  async change(id: number, dto: WxoaDraftUpdate) {
    const row = await this.get(id)
    const articles = await this.normalizeArticles(row.accountId, dto.articles)
    await this.update(id, {
      title: textOf(articles[0]!.title),
      articles: articles as never,
    } as never)
    return vo(await this.get(id))
  }
  /** 删除本地草稿；已同步过的顺带删掉草稿箱里的那份（失败不影响本地删除）。 */
  async drop(id: number) {
    const row = await this.get(id)
    await this.remove([id])
    if (row.mediaId)
      await this.gateway
        .json(await activeAccount(this.txHost, row.accountId), '/cgi-bin/draft/delete', {
          body: { media_id: row.mediaId },
        })
        .catch(() => undefined)
  }

  /**
   * 推到草稿箱：正文图片按本站对象改写后 draft/add，记下新 media_id 与内容摘要；
   * 重新同步时旧的那份草稿顺带删除，避免草稿箱里留下孤儿。
   */
  async sync(id: number) {
    const row = await this.get(id)
    const account = await activeAccount(this.txHost, row.accountId)
    const { articles, unsyncedImages } = await this.rewriteImages(account.id, account, row.articles)
    const answer = await this.gateway.json(account, '/cgi-bin/draft/add', {
      body: { articles: articles.map(toWx) },
    })
    const mid = mediaId(answer.media_id)
    if (!mid) throw new BizError(Err.WXOA_UPSTREAM)
    await this.update(id, {
      mediaId: mid,
      articles: articles as never,
      syncedAt: new Date(),
      syncedDigest: draftDigest(articles),
    } as never)
    if (row.mediaId && row.mediaId !== mid)
      await this.gateway
        .json(account, '/cgi-bin/draft/delete', { body: { media_id: row.mediaId } })
        .catch(() => undefined)
    return { draft: vo(await this.get(id)), unsyncedImages }
  }

  /**
   * 拉取草稿箱：batchget 带 no_content=1 分页列出全部草稿，再逐条 draft/get 取正文清洗入库；
   * 已有的同 media_id 草稿覆盖并刷新同步摘要。清洗后仍超长或取不到的列入 `failed`，其余照常入库。
   */
  async pull(accountId: number) {
    const account = await activeAccount(this.txHost, accountId)
    const saved: ReturnType<typeof vo>[] = []
    const failed: { mediaId: string; title: string | null; reason: string }[] = []
    for (let page = 0, offset = 0; page < PULL_PAGES_MAX; page++) {
      const answer = await this.gateway.json(account, '/cgi-bin/draft/batchget', {
        body: { offset, count: PULL_PAGE, no_content: 1 },
      })
      const items = Array.isArray(answer.item) ? answer.item.map(jsonObject) : []
      for (const item of items) {
        const mid = mediaId(item.media_id)
        if (!mid) continue
        try {
          saved.push(await this.pullOne(account, mid))
        } catch (err) {
          const first = jsonObject(
            (jsonObject(item.content).news_item as unknown[] | undefined)?.[0],
          )
          failed.push({
            mediaId: mid,
            title: textOf(first.title) || null,
            reason:
              err instanceof ValidationException
                ? 'too_long'
                : err instanceof BizError
                  ? err.err.code
                  : 'invalid',
          })
        }
      }
      offset += items.length
      const total = Number(textOf(answer.total_count))
      if (!items.length || !(offset < total)) break
    }
    return { items: saved, failed }
  }

  /** 取一条草稿的正文（单条应答上限 10 MiB）清洗后入库：同 media_id 的覆盖，新的建为 pulled。 */
  private async pullOne(account: Awaited<ReturnType<typeof activeAccount>>, mid: string) {
    const full = await this.gateway.json(account, '/cgi-bin/draft/get', {
      body: { media_id: mid },
      maxBytes: DRAFT_ANSWER_MAX,
    })
    const raw = Array.isArray(full.news_item) ? full.news_item : []
    // 封面来自本账号自己的草稿箱，不要求已同步到本地素材表
    const articles = await this.normalizeArticles(
      account.id,
      raw.map((a) => this.articleFromWx(a)),
      false,
    )
    const fields = {
      title: textOf(articles[0]!.title).slice(0, 64),
      articles: articles as never,
      origin: 'pulled' as const,
      syncedAt: new Date(),
      syncedDigest: draftDigest(articles),
    }
    const row = await this.repo.findOne({ where: { accountId: account.id, mediaId: mid } })
    if (row) await this.update(row.id, fields as never)
    const id = row?.id ?? (await this.create({ accountId: account.id, mediaId: mid, ...fields })).id
    return vo(await this.get(id))
  }

  /** 草稿箱的一篇（下划线字段、开关 0/1）→ 本地文章结构。 */
  private articleFromWx(raw: unknown): Record<string, unknown> {
    const a = jsonObject(raw)
    return {
      title: textOf(a.title),
      author: textOf(a.author),
      digest: textOf(a.digest),
      content: textOf(a.content),
      contentSourceUrl: textOf(a.content_source_url),
      thumbMediaId: textOf(a.thumb_media_id),
      needOpenComment: flag(a.need_open_comment),
      onlyFansCanComment: flag(a.only_fans_can_comment),
    }
  }

  /**
   * 清洗正文并校验：1–8 篇、清洗后每篇 ≤ 20000 字符（超出 400）；`checkCover` 时封面须是本账号
   * 的素材（别的账号的或不存在的 404），且是图片或缩略图类型（否则 B6102）。
   */
  private async normalizeArticles(
    accountId: number,
    input: readonly Record<string, unknown>[],
    checkCover = true,
  ): Promise<Record<string, unknown>[]> {
    if (!input.length || input.length > WXOA_ARTICLE_MAX) throw new BizError(Err.UNPROCESSABLE)
    const out: Record<string, unknown>[] = input.map((a) => ({
      ...a,
      content: sanitizeRichText(textOf(a.content)),
    }))
    for (const [i, a] of out.entries())
      if (textOf(a.content).length > WXOA_CONTENT_MAX) throw tooLong(i)
    if (!checkCover) return out
    const mids = out.map((a) => mediaId(a.thumbMediaId)).filter((v): v is string => !!v)
    const mats = mids.length
      ? await this.repo.manager
          .getRepository(WxoaMaterial)
          .find({ where: { accountId, mediaId: In(mids) } })
      : []
    for (const a of out) {
      const m = mats.find((x) => x.mediaId === mediaId(a.thumbMediaId))
      if (!m) throw new NotFoundException()
      if (!['image', 'thumb'].includes(m.mediaKind)) throw new BizError(Err.WXOA_COVER_UNAVAILABLE)
    }
    return out
  }

  /**
   * 正文图片改写（只认本站对象，绝不按 src 发请求）：mmbiz 地址保留并改 https；本站 richtext
   * 公共对象里的 jpg/png（< 1 MB）经 uploadimg 换成微信地址（同一对象只上传一次）；其余删除并
   * 列入未同步图片。每处只改动匹配到的那个 `<img>`（按位置替换，不用字符串模式），改写后再校验长度。
   */
  private async rewriteImages(
    accountId: number,
    account: Awaited<ReturnType<typeof activeAccount>>,
    articles: readonly Record<string, unknown>[],
  ) {
    const unsyncedImages: { src: string; reason: string }[] = []
    const out: Record<string, unknown>[] = []
    for (const article of articles) {
      const html = textOf(article.content)
      const edits: { start: number; end: number; text: string }[] = []
      // 引号写成 \x22 / \x27：带 d 标志取各组位置，只改动匹配到的那一处
      for (const match of html.matchAll(/<img\b[^>]*\bsrc=([\x22\x27])(.*?)\1[^>]*>/dgi)) {
        const [tagStart, tagEnd] = match.indices![0]!
        const [srcStart, srcEnd] = match.indices![2]!
        const src = match[2]!
        const drop = (reason: string) => {
          unsyncedImages.push({ src, reason })
          edits.push({ start: tagStart, end: tagEnd, text: '' })
        }
        const replace = (url: string) =>
          edits.push({ start: srcStart, end: srcEnd, text: url.replaceAll('"', '%22') })
        let url: URL | null = null
        try {
          url = new URL(src.replaceAll('&amp;', '&'))
        } catch {
          // 不是绝对地址：按查不到处理
        }
        if (url && MMBIZ.has(url.hostname) && !url.port && !url.username && !url.password) {
          url.protocol = 'https:'
          replace(url.href)
          continue
        }
        let object: FsObject | null = null
        if (url && (url.protocol === 'http:' || url.protocol === 'https:'))
          object = await this.repo.manager
            .getRepository(FsObject)
            .findOne({ where: { publicUrl: url.href, bizTag: 'richtext', isPublic: true } })
        if (!object) {
          drop('not_local')
          continue
        }
        if (object.size >= MAX_IMAGE) {
          drop('too_large')
          continue
        }
        if (!/^image\/(jpeg|png)$/.test(object.mime)) {
          drop('unsupported')
          continue
        }
        const inline = await this.repo.manager
          .getRepository(WxoaInlineImage)
          .findOne({ where: { accountId, objectId: object.id } })
        if (inline) {
          replace(inline.wxUrl)
          continue
        }
        const file = await this.storage.readInternal(object.id, {
          bizTag: 'richtext',
          publicOnly: true,
          maxBytes: MAX_IMAGE,
        })
        const answer = await this.gateway.upload(account, '/cgi-bin/media/uploadimg', {
          name: object.originalName,
          mime: object.mime,
          data: file.data,
        })
        const wx = textOf(answer.url)
        if (!wx) {
          drop('upstream')
          continue
        }
        const wxUrl = wx.startsWith('http:') ? `https:${wx.slice(5)}` : wx
        await this.repo.manager
          .getRepository(WxoaInlineImage)
          .insert({ accountId, objectId: object.id, wxUrl } as never)
        replace(wxUrl)
      }
      let next = html
      for (const e of edits.sort((a, b) => b.start - a.start))
        next = next.slice(0, e.start) + e.text + next.slice(e.end)
      out.push({ ...article, content: sanitizeRichText(next) })
    }
    for (const [i, a] of out.entries())
      if (textOf(a.content).length > WXOA_CONTENT_MAX) throw tooLong(i)
    return { articles: out, unsyncedImages }
  }
}
