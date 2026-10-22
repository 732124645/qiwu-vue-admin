import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { type AgentMemoryVo, agentMemoryQuery, Err, type Page } from '@qiwu/shared'
import { In, MoreThanOrEqual, Not } from 'typeorm'
import type { z } from 'zod'
import type { Principal } from '../../auth/principal.js'
import { contains, paginate } from '../../db/page.js'
import { BizError } from '../../http/biz-error.js'
import { maskSecrets } from '../../redact.js'
import { AgentMemory } from '../entities/agent-memory.entity.js'
import { num } from '../threads/thread-vo.js'

/** 每人最多这么多条记忆：满了要本人先清理（智能体被告知请用户去“我的记忆”删掉一些）。 */
export const MEMORY_MAX = 200
/** 一条记忆最多这么多字符（与表的列宽一致）。 */
export const MEMORY_CONTENT_MAX = 1000

/**
 * 记忆保存前的遮蔽（对话中保存、后台提炼、手工新增与修改都经过它）：`core/redact` 的 `maskSecrets`（密钥、
 * 令牌、证件号、卡号、手机号等换成 `***`），再把换行与连续空白压成一个空格（一条记忆一行，进上下文时
 * 不会被当成多条）。记忆会进以后每次对话的上下文，这些内容不能留在里面。
 */
export function maskMemory(text: string): string {
  return maskSecrets(text).replace(/\s+/g, ' ').trim().slice(0, MEMORY_CONTENT_MAX)
}

/** 比较是否同一条记忆用的规整形式：去掉首尾空白、合并空白、不分大小写。 */
const sameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** 挑选相关记忆用的词：拉丁字母与数字按词，中日韩文字按相邻两字。 */
export function memoryTerms(text: string): string[] {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) out.add(w)
  for (const run of text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  ) ?? [])
    if (run.length === 1) out.add(run)
    else for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2))
  return [...out]
}

/** 加一条记忆的结果：新加的、已有同样内容的，或记忆已满（什么也没加）。 */
export type MemoryAdd =
  | { status: 'added'; row: AgentMemory }
  | { status: 'duplicate'; row: AgentMemory }
  | { status: 'full' }

export const memoryVo = (r: AgentMemory): AgentMemoryVo => ({
  id: num(r.id),
  content: r.content,
  source: r.source,
  sourceThreadId: r.sourceThreadId == null ? null : num(r.sourceThreadId),
  lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
  createdAt: new Date(r.createdAt).toISOString(),
})

/**
 * 记忆库（see docs/agent.md）：每人一个，只本人可见、可改（别人的与别的租户的一律 404，ORM 加租户条件，
 * 这里加本人条件）。删除是物理删除：忘记的个人信息不留在库里。
 */
@Injectable()
export class AgentMemoryService {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>) {}

  private get repo() {
    return this.txHost.tx.getRepository(AgentMemory)
  }

  /** 本人的记忆分页，关键词匹配内容；默认新的在前。 */
  async page(p: Principal, q: z.infer<typeof agentMemoryQuery>): Promise<Page<AgentMemoryVo>> {
    const qb = this.repo.createQueryBuilder('m').where('m.userId = :uid', { uid: p.userId })
    if (q.keyword) qb.andWhere('m.content LIKE :kw', { kw: contains(q.keyword) })
    const page = await paginate(qb, {
      ...q,
      sort: q.sort ?? [{ field: 'createdAt', order: 'DESC' }],
    })
    return { items: page.items.map(memoryVo), total: page.total }
  }

  /**
   * 加一条记忆（已遮蔽的内容）：先锁住本人的记忆行（同一人的并发保存串行，不会多出重复或超出上限），
   * 同样的内容已有就不再加，满了不加。
   */
  async add(
    userId: number,
    content: string,
    source: AgentMemory['source'],
    threadId: number | null,
  ): Promise<MemoryAdd> {
    return this.txHost.withTransaction(async () => {
      const rows = await this.repo.find({
        where: { userId },
        select: { id: true, content: true },
        lock: { mode: 'pessimistic_write' },
      })
      const key = sameKey(content)
      const same = rows.find((r) => sameKey(r.content) === key)
      if (same)
        return { status: 'duplicate', row: await this.repo.findOneByOrFail({ id: same.id }) }
      if (rows.length >= MEMORY_MAX) return { status: 'full' }
      const row = await this.repo.save(
        this.repo.create({ userId, content, source, sourceThreadId: threadId, lastUsedAt: null }),
      )
      return { status: 'added', row }
    })
  }

  /** 手工新增：遮蔽后保存；同样的内容已有 409（重复），记忆已满 409。 */
  async create(p: Principal, content: string): Promise<AgentMemoryVo> {
    const masked = maskMemory(content)
    if (!masked) throw new BizError(Err.VALIDATION_FAILED)
    const r = await this.add(p.userId, masked, 'manual', null)
    if (r.status === 'duplicate') throw new BizError(Err.DUPLICATE, { name: masked.slice(0, 40) })
    if (r.status === 'full') throw new BizError(Err.CONFLICT)
    return memoryVo(r.row)
  }

  /** 本人的一条记忆，锁行；别人的、别的租户的、不存在的 404。 */
  private async own(p: Principal, id: number): Promise<AgentMemory> {
    const row = await this.repo.findOne({
      where: { id, userId: p.userId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!row) throw new NotFoundException()
    return row
  }

  /** 修改内容（遮蔽后）；与本人另一条相同时 409。 */
  async update(p: Principal, id: number, content: string): Promise<AgentMemoryVo> {
    const masked = maskMemory(content)
    if (!masked) throw new BizError(Err.VALIDATION_FAILED)
    return this.txHost.withTransaction(async () => {
      await this.own(p, id)
      const others = await this.repo.find({
        where: { userId: p.userId, id: Not(id) },
        select: { id: true, content: true },
      })
      if (others.some((r) => sameKey(r.content) === sameKey(masked)))
        throw new BizError(Err.DUPLICATE, { name: masked.slice(0, 40) })
      await this.repo.update(id, { content: masked })
      return memoryVo(await this.repo.findOneByOrFail({ id }))
    })
  }

  /** 删除一条（物理删除）。 */
  async remove(p: Principal, id: number): Promise<null> {
    await this.txHost.withTransaction(async () => {
      await this.own(p, id)
      await this.repo.delete({ id, userId: p.userId })
    })
    return null
  }

  /** 全部忘记（调用方已核对当前密码）：本人的记忆全部物理删除，返回删掉的条数。 */
  async forgetAll(p: Principal): Promise<{ removed: number }> {
    const r = await this.repo.delete({ userId: p.userId })
    return { removed: r.affected ?? 0 }
  }

  /**
   * 挑出与这句话最相关的至多 `n` 条：按命中的词数（{@link memoryTerms}），同分的按最近使用、再按新建时间；
   * 没有这句话时取最近的。每人至多 {@link MEMORY_MAX} 条，在内存里排序足够。
   */
  async relevant(userId: number, text: string | null, n: number): Promise<AgentMemory[]> {
    if (n <= 0) return []
    const rows = await this.repo.find({ where: { userId } })
    const terms = text ? memoryTerms(text) : []
    const score = (r: AgentMemory) => {
      const c = r.content.toLowerCase()
      return terms.reduce((s, t) => s + (c.includes(t) ? 1 : 0), 0)
    }
    const at = (d: Date | null) => (d ? new Date(d).getTime() : 0)
    return rows
      .map((r) => ({ r, s: score(r) }))
      .sort(
        (a, b) =>
          b.s - a.s ||
          at(b.r.lastUsedAt) - at(a.r.lastUsedAt) ||
          at(b.r.createdAt) - at(a.r.createdAt),
      )
      .slice(0, n)
      .map(({ r }) => r)
  }

  /** 记下这些记忆刚放进了一轮的上下文。 */
  async touch(userId: number, ids: number[]): Promise<void> {
    if (ids.length) await this.repo.update({ id: In(ids), userId }, { lastUsedAt: new Date() })
  }

  /** 本人的记忆条数。 */
  count(userId: number): Promise<number> {
    return this.repo.countBy({ userId })
  }

  /** 本人今天（UTC）由后台提炼加上的条数（每日上限用）。 */
  extractedToday(userId: number): Promise<number> {
    const day = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
    return this.repo.countBy({ userId, source: 'extract', createdAt: MoreThanOrEqual(day) })
  }
}
