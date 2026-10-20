import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err, type WxoaPublishCreate, type WxoaPublishQuery, wxoaImageUrl } from '@qiwu/shared'
import { LessThan, type SelectQueryBuilder } from 'typeorm'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { sanitizeRichText } from '../../../../core/sanitize.js'
import { WxoaDraft, WxoaPublish } from '../core/wxoa.entity.js'
import { WxoaGateway, type WxoaCaller, type WxoaJson } from '../core/wxoa-gateway.js'
import { WxoaInboundHub, type WxoaInbound } from '../core/wxoa-inbound-hub.js'
import { draftDigest, jsonObject, textOf, activeAccount } from '../core/wxoa-util.js'

/** freepublish/batchget 每页最多 20 条。 */
const PULL_PAGE = 20
// 上限：拉取最多 50 页（1000 条发表记录），更多时再改成分批拉取
const PULL_PAGES_MAX = 50
/** getarticle 一次返回该次发表的全部篇（最多 8 篇、每篇正文上限 1 MB）。 */
const ARTICLE_ANSWER_MAX = 10 * 1024 * 1024
/** 发布中超过这么久仍无回执的，打开列表时用 freepublish/get 补查一次。 */
const STALE_MS = 2 * 60 * 1000

/**
 * 发布状态码（freepublish/get 与 PUBLISHJOBFINISH）：0 成功，1 发布中，2–4 失败（原创、常规、审核），
 * 5–6 成功后被用户删除或被系统封禁。
 */
const stateOf = (status: string, failed: boolean): WxoaPublish['publishState'] =>
  status === '1'
    ? 'publishing'
    : status === '5' || status === '6'
      ? 'removed'
      : status === '0' && !failed
        ? 'succeeded'
        : 'failed'

/** 上游给的链接只保留 http(s) 的，其余（`javascript:`、`data:` 等）记为 null，页面与接口都不转发。 */
const httpUrl = (v: unknown): string | null => {
  const url = textOf(v).trim()
  return /^https?:\/\//i.test(url) ? url : null
}
const httpUrls = (values: unknown[]): string[] =>
  values.map(httpUrl).filter((url): url is string => url !== null)

/** 发表结果的公共字段（回执与补查同一结构）：article_id、失败篇序号、各篇永久链接。 */
function resultOf(info: WxoaJson) {
  const status = textOf(info.publish_status ?? info.PublishStatus)
  const failValues = info.fail_idx ?? info.FailIdx
  const fail = (Array.isArray(failValues) ? failValues : textOf(failValues) ? [failValues] : [])
    .map((v) => Number(textOf(v)))
    .filter(Number.isInteger)
  const detail = jsonObject(info.article_detail)
  const list = Array.isArray(detail.item) ? detail.item : detail.item ? [detail.item] : []
  const articleUrls = httpUrls(list.map((entry) => jsonObject(entry).article_url))
  // 发布中时微信也可能先给出 fail_idx，只有结束状态才按它判失败
  const publishState = stateOf(status, status !== '1' && fail.length > 0)
  return {
    publishState,
    articleId: textOf(info.article_id ?? info.ArticleId) || null,
    failIdx: fail.length && publishState !== 'publishing' ? fail : null,
    articleUrls: articleUrls.length ? articleUrls : null,
  }
}

@Injectable()
export class WxoaPublishService extends BaseCrudService<WxoaPublish> implements OnModuleInit {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly hub: WxoaInboundHub,
  ) {
    super(txHost, WxoaPublish)
  }
  onModuleInit() {
    this.hub.on((row) => this.receipt(row))
  }
  /** 列表只含所查账号的行（同租户的其它账号不混入）。 */
  protected override filter(
    qb: SelectQueryBuilder<WxoaPublish>,
    q: WxoaPublishQuery,
  ): SelectQueryBuilder<WxoaPublish> {
    qb.andWhere('t.accountId = :accountId', { accountId: q.accountId })
    return qb
  }
  /**
   * 发表记录分页：本账号超过 2 分钟仍在发布中的记录先用 freepublish/get 各补查一次
   * （回执可能丢失；不建定时任务），补查失败不影响列表。
   */
  async list(q: WxoaPublishQuery) {
    const account = await activeAccount(this.txHost, q.accountId)
    const stale = await this.repo.find({
      where: {
        accountId: account.id,
        publishState: 'publishing',
        createdAt: LessThan(new Date(Date.now() - STALE_MS)),
      },
      take: 20,
    })
    for (const row of stale) {
      if (!row.publishId) continue
      try {
        const answer = await this.gateway.json(account, '/cgi-bin/freepublish/get', {
          body: { publish_id: row.publishId },
        })
        const result = resultOf(answer)
        if (result.publishState !== 'publishing')
          await this.update(row.id, { ...result, finishedAt: new Date() })
      } catch {
        // 补查只是尽力而为，失败的下次打开列表再查
      }
    }
    return this.page(q)
  }
  /** 发表详情：有 article_id 时用 getarticle 取各篇，只回传白名单字段，正文经清洗。 */
  async one(id: number) {
    const row = await this.get(id)
    if (!row.articleId) return { ...row, articles: null }
    const account = await activeAccount(this.txHost, row.accountId)
    const answer = await this.gateway.json(account, '/cgi-bin/freepublish/getarticle', {
      body: { article_id: row.articleId },
      maxBytes: ARTICLE_ANSWER_MAX,
    })
    const items = Array.isArray(answer.news_item) ? answer.news_item.map(jsonObject) : []
    return {
      ...row,
      articles: items.map((a) => ({
        title: textOf(a.title),
        author: textOf(a.author),
        digest: textOf(a.digest),
        content: sanitizeRichText(textOf(a.content)),
        contentSourceUrl: httpUrl(a.content_source_url),
        thumbUrl: wxoaImageUrl(textOf(a.thumb_url)),
        url: httpUrl(a.url),
        isDeleted: a.is_deleted === true,
      })),
    }
  }
  /** 提交发布：草稿须属本账号（否则 404）且已同步、无未同步修改（否则 409 B6101）。 */
  async submit(dto: WxoaPublishCreate) {
    const account = await activeAccount(this.txHost, dto.accountId)
    const draft = await this.txHost.tx
      .getRepository(WxoaDraft)
      .findOne({ where: { id: dto.draftId, accountId: account.id } })
    if (!draft) throw new NotFoundException()
    if (!draft.mediaId || draft.syncedDigest !== draftDigest(draft.articles))
      throw new BizError(Err.WXOA_DRAFT_UNSYNCED)
    const answer = await this.gateway.json(account, '/cgi-bin/freepublish/submit', {
      body: { media_id: draft.mediaId },
    })
    const publishId = textOf(answer.publish_id)
    if (!publishId) throw new BizError(Err.WXOA_UPSTREAM)
    return this.create({
      accountId: account.id,
      draftId: draft.id,
      publishId,
      articleId: null,
      title: draft.title,
      publishState: 'publishing',
      failIdx: null,
      articleUrls: null,
      finishedAt: null,
    })
  }
  /**
   * 拉取发表记录（含在公众号后台发表的）：batchget 带 no_content=1 分页，本地只存标题、链接与状态；
   * 标题与链接取首篇 `content.news_item[0]`。
   */
  async pull(accountId: number) {
    const account = await activeAccount(this.txHost, accountId)
    const items: WxoaPublish[] = []
    for (let page = 0, offset = 0; page < PULL_PAGES_MAX; page++) {
      const answer = await this.gateway.json(account, '/cgi-bin/freepublish/batchget', {
        body: { offset, count: PULL_PAGE, no_content: 1 },
      })
      const list = Array.isArray(answer.item) ? answer.item.map(jsonObject) : []
      for (const raw of list) items.push(...(await this.pullOne(account, raw)))
      offset += list.length
      if (!list.length || !(offset < Number(textOf(answer.total_count)))) break
    }
    return { items }
  }

  /** 一条拉取到的发表记录入库：同 article_id 的更新标题与状态，新的建为后台发表记录。 */
  private async pullOne(account: WxoaCaller, raw: WxoaJson): Promise<WxoaPublish[]> {
    const articleId = textOf(raw.article_id)
    if (!articleId) return []
    const news = Array.isArray(jsonObject(raw.content).news_item)
      ? (jsonObject(raw.content).news_item as unknown[]).map(jsonObject)
      : []
    const title = (textOf(news[0]?.title) || articleId).slice(0, 64)
    const urls = httpUrls(news.map((n) => n.url))
    const publishState =
      news.length && news.every((n) => n.is_deleted === true) ? 'removed' : 'succeeded'
    const existing = await this.repo.findOne({ where: { accountId: account.id, articleId } })
    if (existing) {
      await this.update(existing.id, {
        title,
        publishState,
        ...(urls.length ? { articleUrls: urls } : {}),
      })
      return [await this.get(existing.id)]
    }
    return [
      await this.create({
        accountId: account.id,
        draftId: null,
        publishId: null,
        articleId,
        title,
        publishState,
        failIdx: null,
        articleUrls: urls.length ? urls : null,
        finishedAt: new Date(),
      }),
    ]
  }
  /** 删除已发表文章（不可恢复）：`index` 从 1 开始，不填删除全部并把记录标为 removed。 */
  async drop(id: number, index?: number) {
    const row = await this.get(id)
    if (row.articleId) {
      await this.gateway.json(
        await activeAccount(this.txHost, row.accountId),
        '/cgi-bin/freepublish/delete',
        { body: { article_id: row.articleId, index: index ?? 0 } },
      )
    }
    if (!index) await this.update(id, { publishState: 'removed', finishedAt: new Date() })
  }
  /** PUBLISHJOBFINISH 回执：微信把结果放在 PublishEventInfo 里，按 publish_id 更新本地记录。 */
  private async receipt(row: WxoaInbound) {
    if (row.eventKind !== 'PUBLISHJOBFINISH') return
    const info = jsonObject(row.payload.PublishEventInfo)
    const publishId = textOf(info.publish_id)
    if (!publishId) return
    const item = await this.repo.findOne({ where: { accountId: row.accountId, publishId } })
    if (!item) return
    await this.update(item.id, { ...resultOf(info), finishedAt: new Date() })
  }
}
