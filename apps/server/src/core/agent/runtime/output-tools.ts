import { Inject, Injectable, Optional } from '@nestjs/common'
import { type AgentChartSpec, agentChartSpec, Err } from '@qiwu/shared'
import { z } from 'zod'
import { BizError } from '../../http/biz-error.js'
import {
  AGENT_IMAGE_STORE,
  AgentBuiltinTool,
  type AgentImageStore,
  type AgentToolContext,
} from '../agent-ports.js'
import { IMAGE_SIZES } from '../provider/chat-model.js'
import { ProviderRegistry, usageTarget } from '../provider/provider-registry.js'
import { InvocationLeaseLost } from './usage-book.js'
import { LeaseLost, TurnStop } from './turn-runner.js'
import { TurnQueue } from './turn-queue.js'
import { CHART_TOOL, IMAGE_TOOL, REPORT_TOOL } from './turn-tools.js'

/** At most this many images per turn (each one costs money). */
export const IMAGES_PER_TURN = 4

export const reportInput = z.object({
  title: z.string().trim().min(1).max(200),
  /** Markdown; cite sources as [1], [2] … in the order of `citations` */
  text: z.string().trim().min(1).max(100_000),
  citations: z
    .array(z.object({ title: z.string().max(300), url: z.string().max(2000) }))
    .max(100)
    .default([]),
})

export const imageInput = z.object({
  prompt: z.string().trim().min(1).max(4000),
  size: z.enum(IMAGE_SIZES).optional(),
})

/** 柱、线、饼图的每个系列都对着类别：数据点不能多于类别；饼图只画一个系列。返回不合格的原因。 */
export function chartProblem(spec: AgentChartSpec): string | null {
  if (spec.kind === 'pie' && spec.series.length !== 1) return 'a pie chart has exactly one series'
  if (spec.series.some((s) => s.data.length > spec.categories.length))
    return 'a series has more values than there are categories'
  return null
}

/**
 * 可视化与产出的内置工具（see docs/agent.md#图表图片与导出）：图表、研究报告与图片。三个都是只读工具，
 * 写的是本轮的界面条目（经 `ctx.items.add`，按调用去重，重做时替换而不是多出一条）。页面按声明式配置渲染
 * 图表，从不执行代码或拼 HTML；报告的引用只保留本轮可读的链接；生成图片按调用幂等（存进文件存储时带调用键，
 * 重做时找回那张图，不再花一次钱）。
 */
@Injectable()
export class AgentOutputTools {
  constructor(
    readonly providers: ProviderRegistry,
    private readonly queue: TurnQueue,
    @Optional() @Inject(AGENT_IMAGE_STORE) readonly images?: AgentImageStore,
  ) {}

  /** 图表或表格：按声明式配置校验后写一个 chart 条目。 */
  @AgentBuiltinTool({
    name: CHART_TOOL,
    title: 'Show a chart',
    description:
      'Shows the user a bar, line or pie chart, or a table, from plain values (at most 12 series of 200 ' +
      'values). For bar, line and pie charts every series has one value per category (a pie chart has one ' +
      'series); for a table the categories are the column headers and each series is one row. The user can ' +
      'export it as xlsx.',
    kind: 'read',
    input: agentChartSpec,
  })
  async chart(spec: AgentChartSpec, ctx: AgentToolContext) {
    const problem = chartProblem(spec)
    if (problem) return ctx.fail(Err.VALIDATION_FAILED, problem)
    await ctx.items.add('chart', spec)
    return { ok: true, content: 'The chart is shown to the user.' }
  }

  /**
   * 研究报告：写一个 report 条目（标题、Markdown 正文、引用）。引用只认本轮可读的链接（用户给的、搜索带回的，
   * 与 `web.fetch` 同一份）：别的链接可能是模型编的或网页诱导的，保留位置（编号不乱）但去掉链接，页面标为
   * 未核实，并告诉模型。
   */
  @AgentBuiltinTool({
    name: REPORT_TOOL,
    title: 'Write a report',
    description:
      'Shows the user a research report: a title, a Markdown text citing sources as [1], [2] … and the ' +
      'citations in that order. Cite only pages you read in this turn; other links are marked unverified. ' +
      'Tables in the text can be exported as xlsx, the report as Markdown or PDF. Call it once at the end.',
    kind: 'read',
    input: reportInput,
  })
  async report({ title, text, citations }: z.output<typeof reportInput>, ctx: AgentToolContext) {
    const urls = await ctx.readableUrls()
    const dropped: string[] = []
    const kept = citations.map((c) => {
      if (urls.allows(c.url)) return c
      dropped.push(c.url)
      return { title: c.title || c.url, url: '' }
    })
    await ctx.items.add('report', { title, text, citations: kept })
    return {
      ok: true,
      content:
        `The report is shown to the user with ${kept.length - dropped.length} verified citations.` +
        (dropped.length
          ? ` These were not read in this turn and are shown as unverified: ${dropped.join(', ').slice(0, 2000)}`
          : ''),
    }
  }

  /**
   * 生成图片：只在有提供方模型标了图片能力、存储模块提供了图片存放处时提供。按调用键（会话与调用 id）先找
   * 已存的图片——调用重做时复用，不再生成；没有才在急停、单轮与每日额度允许时调用图片接口（提供方客户端，
   * 不另开出站请求），记用量，存成本人名下的私有文件，再写 image 条目。
   */
  @AgentBuiltinTool({
    name: IMAGE_TOOL,
    title: 'Generate an image',
    description:
      'Generates one image from a detailed description and shows it to the user (stored as their file). ' +
      'Each call costs money: call it only when the user wants a picture.',
    kind: 'read',
    input: imageInput,
    available: async (_ctx, self) => {
      const tools = self as AgentOutputTools
      return tools.images !== undefined && (await tools.providers.resolveImage()) !== null
    },
  })
  async image({ prompt, size }: z.output<typeof imageInput>, ctx: AgentToolContext) {
    if (!this.images) return ctx.fail(Err.NOT_FOUND)
    const key = `${ctx.thread.id}:${ctx.callId}`
    let file = await this.images.find(ctx.principal, key)
    if (!file) {
      // 每轮张数有上限：模型被网页带偏、反复要图时不至于一轮花掉很多钱（重做的调用已找回文件，不算新的一张）
      if (ctx.items.list('image').length >= IMAGES_PER_TURN) {
        const message = `At most ${IMAGES_PER_TURN} images per turn; no more were generated.`
        return { ok: false, content: message, error: { code: Err.AGENT_LIMIT.code, message } }
      }
      // 和每一步之前的检查一样：急停或额度用完时这一轮停下
      if (await this.queue.paused()) throw new TurnStop(Err.AGENT_PAUSED)
      const over = await ctx.overBudget()
      if (over) throw new TurnStop(Err.AGENT_LIMIT, { which: over })
      const m = await this.providers.resolveImage()
      if (!m?.chat.image) return ctx.fail(Err.AGENT_NOT_CONFIGURED)
      const target = usageTarget(m, 'image')
      let attempted = false
      const r = await ctx
        .invokeModel(
          target,
          (receipt) => {
            attempted = true
            return m.chat.image!({
              model: m.model.id,
              prompt,
              size,
              ...receipt,
            })
          },
          ctx.signal,
        )
        .catch(async (error: unknown) => {
          if (
            attempted &&
            !ctx.signal.aborted &&
            !(error instanceof InvocationLeaseLost || error instanceof LeaseLost)
          )
            await ctx.requireRecovery(
              error instanceof BizError ? ctx.fail(error.err).error : undefined,
            )
          throw error
        })
      file = await this.images
        .save(ctx.principal, key, { data: r.data, name: 'image' })
        .catch(async (error: unknown) => {
          if (
            !ctx.signal.aborted &&
            !(error instanceof InvocationLeaseLost || error instanceof LeaseLost)
          )
            await ctx.requireRecovery(
              error instanceof BizError ? ctx.fail(error.err).error : undefined,
            )
          throw error
        })
    }
    await ctx.items.add('image', { fileId: file.fileId, prompt, ...file.size })
    return { ok: true, content: `The image is shown to the user (file ${file.fileId}).` }
  }
}
