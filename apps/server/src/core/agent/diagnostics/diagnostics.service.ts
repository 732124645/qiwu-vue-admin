import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { type AgentDiagnosticsVo, Err } from '@qiwu/shared'
import { DataSource, MoreThanOrEqual } from 'typeorm'
import { allTenants } from '../../context/tenant.js'
import { BizError } from '../../http/biz-error.js'
import { QueueService } from '../../queue/queue.service.js'
import { AgentTurn } from '../entities/agent-thread.entity.js'
import { McpConnectFailure, McpConnector } from '../mcp-client/mcp-connector.js'
import { AgentMcpServerService } from '../mcp-client/mcp-server.service.js'
import { ProviderRegistry } from '../provider/provider-registry.js'
import {
  ProviderSettingsService,
  SearchProviderSettingsService,
} from '../provider/provider-settings.service.js'
import { AGENT_TURN_QUEUE } from '../runtime/turn-queue.js'
import { type AgentSearchKind, SEARCH_ENDPOINTS, WebSearch } from '../web/web-search.js'
import { AgentSweepStats } from './sweep-stats.js'

/** The answer of a connectivity test: how long it took, and a short reason code when it failed. */
export interface AgentProbeResult {
  ok: boolean
  ms: number
  error?: string
}

/** Most failed turns the page lists, and the longest error text shown for each. */
const RECENT_FAILURES = 20
const MESSAGE_MAX = 200
/** Longest a connectivity test of a model or search provider may take. */
export const PROBE_TIMEOUT_MS = 15_000
/** what a reason code may look like (anything else is reported as `failed`) */
const REASON = /^[\w.:-]{1,64}$/

/**
 * 失败原因只取简短的原因码（`timeout`、`network`、`http_401`、`auth`…）：上游的报错正文可能回显密钥或
 * 请求内容，不能出现在诊断结果里；形状不像原因码的一律报 `failed`。
 */
function reasonOf(e: unknown): string {
  let reason: unknown
  if (e instanceof BizError)
    // 搜索服务商的非 2xx 只带原因 `status` 与状态码：合成 `http_<code>`，与模型提供方的写法一致
    reason =
      e.params.reason === 'status' && Number.isInteger(e.params.status)
        ? `http_${String(e.params.status)}`
        : e.params.reason
  else if (e instanceof McpConnectFailure) reason = e.reason
  else if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
    reason = 'timeout'
  return typeof reason === 'string' && REASON.test(reason) ? reason : 'failed'
}

/**
 * 平台页“智能体设置 · 诊断”：模型、搜索与外部 MCP 的配置概况（不含密钥）、轮次队列积压、所有租户里
 * 进行中与今天失败的轮次数、最近失败的轮次（只有编号、租户、原因码与截短的说明，不含会话内容）、孤儿
 * 清理统计；以及三种连通测试（只给 root），测试不改任何设置与状态。
 */
@Injectable()
export class AgentDiagnosticsService {
  private readonly logger = new Logger(AgentDiagnosticsService.name)
  /** 测试的超时上限；测试里可调小 */
  timeoutMs = PROBE_TIMEOUT_MS
  /** 搜索服务商的接口地址；测试里指向本地假服务 */
  searchEndpoints: Record<AgentSearchKind, string> = SEARCH_ENDPOINTS

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly providers: ProviderSettingsService,
    private readonly searches: SearchProviderSettingsService,
    private readonly registry: ProviderRegistry,
    private readonly mcp: AgentMcpServerService,
    private readonly connector: McpConnector,
    private readonly queues: QueueService,
    private readonly sweeps: AgentSweepStats,
  ) {}

  /** 诊断概况：只读，一次请求汇总配置、队列、轮次计数、最近失败与清理统计。 */
  async overview(): Promise<AgentDiagnosticsVo> {
    const [providers, search, servers, queue, turns, recentFailures, sweeps] = await Promise.all([
      this.providers.list(),
      this.searches.list(),
      this.mcp.list(),
      this.queueCounts(),
      this.turnCounts(),
      this.recentFailures(),
      this.sweeps.read(),
    ])
    return {
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        hasKey: p.hasKey,
      })),
      search: search.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled })),
      mcpServers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        lastError: s.lastError,
      })),
      queue,
      turns,
      recentFailures,
      sweeps,
    }
  }

  /** 轮次队列的积压：一个队列装着所有租户的任务，这里只取计数。 */
  private async queueCounts(): Promise<AgentDiagnosticsVo['queue']> {
    const q = this.queues.queues().get(AGENT_TURN_QUEUE)
    const c = q ? await q.getJobCounts('waiting', 'active', 'failed', 'delayed') : {}
    return {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      failed: c.failed ?? 0,
      delayed: c.delayed ?? 0,
    }
  }

  /** 所有租户里运行中、等人中与今天（UTC）失败的轮次数。 */
  private turnCounts(): Promise<AgentDiagnosticsVo['turns']> {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    // qw:cross-tenant the platform diagnostics page counts turns of every tenant; only numbers leave here
    return allTenants(async () => {
      const repo = this.ds.getRepository(AgentTurn)
      const [running, waiting, failedToday] = await Promise.all([
        repo.countBy({ status: 'running' }),
        repo.countBy({ status: 'waiting' }),
        repo.countBy({ status: 'failed', endedAt: MoreThanOrEqual(today) }),
      ])
      return { running, waiting, failedToday }
    })
  }

  /** 最近失败的轮次：编号、租户、原因码、截短的说明与时间，不读会话与条目。 */
  private async recentFailures(): Promise<AgentDiagnosticsVo['recentFailures']> {
    // qw:cross-tenant the platform diagnostics page lists failures of every tenant; no thread content is read
    const rows = await allTenants(() =>
      this.ds.getRepository(AgentTurn).find({
        where: { status: 'failed' },
        select: {
          id: true,
          tenantId: true,
          errorCode: true,
          errorMsg: true,
          endedAt: true,
          startedAt: true,
        },
        order: { id: 'DESC' },
        take: RECENT_FAILURES,
      }),
    )
    return rows.map((r) => ({
      turnId: Number(r.id),
      tenantId: Number(r.tenantId),
      code: r.errorCode ?? '',
      message: (r.errorMsg ?? '').slice(0, MESSAGE_MAX),
      at: (r.endedAt ?? r.startedAt).toISOString(),
    }))
  }

  /** 计时执行一次测试；失败只回原因码，并记一条只有原因码的日志。 */
  private async timed(kind: string, fn: () => Promise<unknown>): Promise<AgentProbeResult> {
    const started = performance.now()
    const ms = () => Math.round(performance.now() - started)
    try {
      await fn()
      return { ok: true, ms: ms() }
    } catch (e) {
      const error = reasonOf(e)
      this.logger.warn(`agent ${kind} test failed: ${error}`)
      return { ok: false, ms: ms(), error }
    }
  }

  /**
   * 测一个模型提供方（停用的也能测，便于启用前确认）：用它的第一个模型做一次极短的补全，不重试、
   * 有总超时。不存在 404。
   */
  async testProvider(id: number): Promise<AgentProbeResult> {
    const row = (await this.providers.rows()).find((r) => Number(r.id) === id)
    if (!row) throw new BizError(Err.NOT_FOUND)
    return this.timed('provider', async () => {
      const model = row.models[0]
      if (!model) throw new BizError(Err.AGENT_NOT_CONFIGURED, { reason: 'no_model' })
      const chat = this.registry.connect({
        baseUrl: row.baseUrl,
        apiKey: this.providers.openKey(row),
        models: row.models,
        timeoutMs: this.timeoutMs,
        retries: 0,
      })
      await chat.complete({
        model: model.id,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 8,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    })
  }

  /** 测一个搜索服务商：搜一次、只要一条结果。不存在 404。 */
  async testSearch(id: number): Promise<AgentProbeResult> {
    const row = (await this.searches.rows()).find((r) => Number(r.id) === id)
    if (!row) throw new BizError(Err.NOT_FOUND)
    return this.timed('search', async () => {
      const apiKey = this.searches.openKey(row)
      const search = new WebSearch(
        { current: async () => (apiKey ? { kind: row.kind, apiKey } : null) },
        this.searchEndpoints,
        this.timeoutMs,
      )
      await search.search('ping', { count: 1 })
    })
  }

  /** 测一个外部 MCP 服务器：连接并列出工具，不同步、不改状态（同步仍走设置页）。不存在 404。 */
  async testMcp(id: number): Promise<AgentProbeResult> {
    const row = await this.mcp.rowWithSecret(id)
    return this.timed('mcp', () => this.connector.listTools(this.mcp.target(row)))
  }
}
