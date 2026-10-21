import { Injectable, Module } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { TypeOrmModule } from '@nestjs/typeorm'
import { customerPerms, DEMO_CUSTOMER_TARGET } from '@qiwu/shared'
import { z } from 'zod'
import {
  AgentBatchTarget,
  type AgentBatchTargetProvider,
} from '../../../core/agent/batch/batch-targets.js'
import { contains } from '../../../core/db/page.js'
import { McpTool } from '../../../core/mcp/mcp-tool.js'
import { Customer } from './customer.entity.js'
import { CustomerService } from './customer.service.js'

/** The fields the agent may fill in (name and department stay the user's). */
export const ENRICHABLE = [
  'website',
  'industry',
  'city',
  'scale',
  'phone',
  'address',
  'intro',
] as const
type Enrichable = (typeof ENRICHABLE)[number]

const searchInput = z.object({
  keyword: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('part of the customer name; leave out to list the customers'),
  limit: z.number().int().min(1).max(50).default(20),
})

const searchOutput = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      /** the enrichable fields still empty */
      empty: z.array(z.string()),
    }),
  ),
})

const getInput = z.object({ id: z.number().int().positive() })

const customerOutput = z.object({
  id: z.number().int(),
  name: z.string(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  city: z.string().nullable(),
  scale: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  intro: z.string().nullable(),
})

// bounded like the columns (and the shared customerCreate)
const updateInput = z.object({
  id: z.number().int().positive(),
  website: z
    .url({ protocol: /^https?$/ })
    .max(512)
    .optional()
    .describe('the official website, http(s) URL'),
  industry: z.string().trim().min(1).max(64).optional(),
  city: z.string().trim().min(1).max(64).optional(),
  scale: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .optional()
    .describe('headcount or size band, e.g. "10000+ employees"'),
  phone: z.string().trim().min(1).max(32).optional(),
  address: z.string().trim().min(1).max(255).optional(),
  intro: z.string().trim().min(1).max(2000).optional(),
  onlyEmpty: z
    .boolean()
    .default(true)
    .describe('true (default): only fill fields that are empty now; false overwrites filled ones'),
})
type UpdateInput = z.output<typeof updateInput>

const updateOutput = z.object({
  id: z.number().int(),
  updated: z.array(z.string()),
  /** fields given but kept, because they were filled already (onlyEmpty) or unchanged */
  kept: z.array(z.string()),
})

const isEmpty = (v: unknown) => v === null || v === undefined || String(v).trim() === ''
const emptyOf = (c: Customer) => ENRICHABLE.filter((f) => isEmpty(c[f]))

/** 本次调用会改的字段：给了值、与现值不同，且 `onlyEmpty` 时只改现在为空的。 */
function changesOf(
  c: Customer,
  dto: UpdateInput,
): { field: Enrichable; from: unknown; to: string }[] {
  const out: { field: Enrichable; from: unknown; to: string }[] = []
  for (const f of ENRICHABLE) {
    const to = dto[f]
    if (to === undefined || to === c[f]) continue
    if (dto.onlyEmpty && !isEmpty(c[f])) continue
    out.push({ field: f, from: c[f], to })
  }
  return out
}

/**
 * 示例客户的智能体工具（see docs/agent.md）：查找、读取、补齐资料。都走 `CustomerService` 的
 * `scopedQb` / `get` / `lockScopedIds`，所以数据权限（部门）与租户和列表页一致；写入默认只填空字段，
 * 智能体要覆盖已有值必须显式传 `onlyEmpty: false`（审批卡片照样列出旧值 → 新值）。同时登记为批量执行的
 * 目标 `demo.customer`。
 */
@Injectable()
@AgentBatchTarget({
  target: DEMO_CUSTOMER_TARGET,
  perm: customerPerms.browse,
  tools: ['demo.customer.update'],
})
export class CustomerMcpTools implements AgentBatchTargetProvider {
  constructor(
    private readonly customers: CustomerService,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
  ) {}

  @McpTool({
    name: 'demo.customer.search',
    title: 'Search customers',
    description:
      'Finds sample customers by part of their name. Returns id, name and which of the fields ' +
      `${ENRICHABLE.join(', ')} are still empty.`,
    perm: customerPerms.browse,
    kind: 'read',
    input: searchInput,
    output: searchOutput,
  })
  async search({ keyword, limit }: z.output<typeof searchInput>) {
    const qb = this.customers.scopedQb('t').orderBy('t.id', 'ASC').take(limit)
    if (keyword) qb.andWhere('t.name LIKE :kw', { kw: contains(keyword) })
    const rows = await qb.getMany()
    return { items: rows.map((c) => ({ id: Number(c.id), name: c.name, empty: emptyOf(c) })) }
  }

  @McpTool({
    name: 'demo.customer.get',
    title: 'Read a customer',
    description: 'One sample customer with all its fields (empty ones are null).',
    perm: customerPerms.view,
    kind: 'read',
    input: getInput,
    output: customerOutput,
  })
  async get({ id }: z.output<typeof getInput>) {
    const c = await this.customers.get(id)
    return { ...c, id: Number(c.id) }
  }

  @McpTool({
    name: 'demo.customer.update',
    title: 'Fill in customer details',
    description:
      'Sets the website, industry, city, scale, phone, address or intro of a sample customer. By ' +
      'default only empty fields are filled; a field that already has a value is kept unless ' +
      'onlyEmpty is false. Cite the sources of the values in your answer.',
    perm: customerPerms.modify,
    kind: 'write',
    input: updateInput,
    output: updateOutput,
    preview: 'previewUpdate',
  })
  update(dto: UpdateInput) {
    // 锁住这一行再比较：审批之后别人刚填上的字段不会被覆盖
    return this.txHost.withTransaction(async () => {
      await this.customers.lockScopedIds([dto.id])
      const c = await this.customers.get(dto.id)
      const changes = changesOf(c, dto)
      if (changes.length)
        await this.customers.update(dto.id, Object.fromEntries(changes.map((x) => [x.field, x.to])))
      const updated = changes.map((x) => x.field)
      const kept = ENRICHABLE.filter((f) => dto[f] !== undefined && !updated.includes(f))
      return { id: dto.id, updated, kept }
    })
  }

  /** 审批卡片：会改哪个客户、每个字段的旧值 → 新值（同样的数据权限，读不到的 404）。 */
  async previewUpdate(dto: UpdateInput) {
    const c = await this.customers.get(dto.id)
    return { target: `${c.name} (#${dto.id})`, fields: changesOf(c, dto) }
  }

  /** 批量执行的记录名：调用者能看到的客户 id → 名称。 */
  async batchLabels(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map()
    const rows = await this.customers
      .scopedQb('t')
      .select(['t.id', 't.name'])
      .andWhere('t.id IN (:...ids)', { ids })
      .getMany()
    return new Map(rows.map((r) => [Number(r.id), r.name]))
  }
}

/** 生成的客户模块之外单独装配（生成文件保持与生成器一致）：自带一个 CustomerService 实例。 */
@Module({
  imports: [TypeOrmModule.forFeature([Customer])],
  providers: [CustomerService, CustomerMcpTools],
})
export class CustomerMcpModule {}
