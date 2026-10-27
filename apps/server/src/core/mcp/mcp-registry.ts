import { Injectable, type OnModuleInit } from '@nestjs/common'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import * as shared from '@qiwu/shared'
import { MCP_TOOL_NAME } from '@qiwu/shared'
import { z } from 'zod'
import {
  MCP_CONFIRMATION_REVISION,
  MCP_TIMEOUT_MAX_MS,
  MCP_TIMEOUT_MS,
  MCP_TOOL,
  type McpToolMeta,
  type ToolExecutionContext,
} from './mcp-tool.js'

/** A registered tool: its declaration, the JSON Schemas the agent sees and the bound method. */
export interface RegisteredTool extends McpToolMeta {
  timeoutMs: number
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  run: (input: unknown, context?: ToolExecutionContext) => unknown
  /** the bound `preview` method, when the tool names one */
  runPreview?: (input: unknown) => unknown
}

/** Every string under the shared `*Perms` constants (`userPerms`, `bookPerms`, a project's own…). */
export function knownPerms(source: Record<string, unknown> = shared): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.add(v)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  for (const [name, value] of Object.entries(source))
    if (name.endsWith('Perms') && value && typeof value === 'object' && !Array.isArray(value))
      walk(value)
  return out
}

/** The JSON Schema of a tool's object schema, without the `$schema` line clients do not need. */
function jsonSchemaOf(
  schema: z.ZodObject,
  io: 'input' | 'output',
  stripDefaultAnnotations = false,
): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    override: ({ jsonSchema }) => {
      // default 是注解；动态工厂的启动样本不作为跨实例契约，其语义由 confirmationRevision 维护。
      // 公开回调仅处理 schema 节点，不会删除 properties 下真正名为 default 的业务字段。
      if (stripDefaultAnnotations) delete jsonSchema.default
    },
  }) as Record<string, unknown>
  return rest
}

/**
 * 工具注册表：启动时扫描所有 provider 上的 `@McpTool` 方法（see docs/mcp.md）。名称不合规范、重复、
 * 权限点不在共享常量里、输入不是对象 schema 或超时越界都让启动失败，免得一个写错的工具在运行时
 * 绕过权限或被重名覆盖。
 */
@Injectable()
export class McpRegistry implements OnModuleInit {
  private readonly tools = new Map<string, RegisteredTool>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** 扫描并校验全部工具；任何声明错误直接抛出，阻止启动。 */
  onModuleInit(): void {
    const perms = knownPerms()
    for (const { instance } of this.discovery.getProviders()) {
      if (!instance || typeof instance !== 'object') continue
      const target = instance as Record<string, unknown>
      for (const method of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const fn = target[method]
        if (typeof fn !== 'function') continue
        const meta = this.reflector.get<McpToolMeta | undefined>(MCP_TOOL, fn)
        if (!meta) continue
        const pv = meta.preview === undefined ? undefined : target[meta.preview]
        if (meta.preview !== undefined && typeof pv !== 'function')
          throw new Error(`@McpTool('${meta.name}'): preview method '${meta.preview}' not found`)
        this.add(
          meta,
          fn.bind(instance) as RegisteredTool['run'],
          perms,
          typeof pv === 'function'
            ? ((pv as (input: unknown) => unknown).bind(instance) as RegisteredTool['runPreview'])
            : undefined,
        )
      }
    }
  }

  /** 校验一个声明后登记；也供测试直接调用。`preview` 是工具声明的预览方法（已绑定）。 */
  add(
    meta: McpToolMeta,
    run: RegisteredTool['run'],
    perms = knownPerms(),
    preview?: RegisteredTool['runPreview'],
  ): void {
    const where = `@McpTool('${meta.name}')`
    if (!MCP_TOOL_NAME.test(meta.name) || meta.name.length > 96)
      throw new Error(`${where}: the name is not <domain>.<resource>.<verb>`)
    if (this.tools.has(meta.name)) throw new Error(`${where} registered twice`)
    if (meta.perm !== null && !perms.has(meta.perm))
      throw new Error(`${where}: perm '${meta.perm}' is no shared permission code`)
    if (
      !(meta.input instanceof z.ZodObject) ||
      (meta.output && !(meta.output instanceof z.ZodObject))
    )
      throw new Error(`${where}: input and output must be zod object schemas`)
    if (
      meta.perCallConfirmation !== undefined &&
      (meta.perCallConfirmation !== true || meta.kind !== 'write' || !meta.preview || !preview)
    )
      throw new Error(`${where}: per-call confirmation requires a write tool with a preview method`)
    if (
      meta.perCallConfirmation &&
      (typeof meta.confirmationRevision !== 'string' ||
        !MCP_CONFIRMATION_REVISION.test(meta.confirmationRevision))
    )
      throw new Error(
        `${where}: per-call confirmation requires a stable confirmationRevision (1-64 ASCII letters, digits, dots, underscores or hyphens)`,
      )
    if (meta.highRisk !== undefined && (meta.highRisk !== true || meta.kind !== 'write'))
      throw new Error(`${where}: highRisk is only for write tools`)
    const timeoutMs = meta.timeoutMs ?? MCP_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MCP_TIMEOUT_MAX_MS)
      throw new Error(`${where}: timeoutMs must be 1 … ${MCP_TIMEOUT_MAX_MS}`)
    this.tools.set(meta.name, {
      ...meta,
      timeoutMs,
      inputSchema: jsonSchemaOf(meta.input, 'input', meta.perCallConfirmation === true),
      outputSchema: meta.output && jsonSchemaOf(meta.output, 'output'),
      run,
      ...(preview && { runPreview: preview }),
    })
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  /** 全部工具，按名称排序。 */
  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
