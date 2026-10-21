import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { MCP_TOOL_KINDS } from '../mcp/mcp.schema.js'

/**
 * The in-app agent (see docs/agent.md), only while the server runs with `APP_AGENT=true` (otherwise every
 * route below answers 404 and the menus are hidden). A thread holds turns, a turn holds items; a turn runs
 * in the job queue and streams `agent:event` envelopes to its owner. Field labels `field.agent.<resource>.<prop>`.
 *
 * Chat page (`agent.chat.use`; every thread route acts on the caller's own threads only, another's is 404):
 * - `GET /api/agent/options?<agentOptionsQuery>` → `AgentOptionsVo` (models, skills, modes, starters for the
 *   page the user came from)
 * - `GET /api/agent/threads?<agentThreadQuery>` → `{ items: AgentThreadVo[], total }`
 * - `POST /api/agent/threads` `agentThreadCreate` → `AgentThreadVo`
 * - `PATCH /api/agent/threads/:id` `agentThreadUpdate` → `AgentThreadVo`; `DELETE /api/agent/threads/:id` → null
 * - `POST /api/agent/threads/:id/fork` `agentThreadFork` → `AgentThreadVo` (items up to `seq` copied)
 * - `GET /api/agent/threads/:id/items?afterSeq=<n>` → `AgentThreadDetailVo`
 * - `POST /api/agent/threads/:id/messages` `agentMessageSend` → `AgentTurnVo` (while a turn runs the text is
 *   queued after its current step and the running turn is returned)
 * - `POST /api/agent/threads/:id/cancel` → null; `POST /api/agent/threads/:id/compact` → null
 * - `POST /api/agent/threads/:id/read` `agentThreadRead` → null (marks items up to `seq` read);
 *   `POST /api/agent/threads/read-all` → null (every own thread read)
 * - `POST /api/agent/threads/:id/revert` → null (removes the latest turn and its items; writes it made stay)
 * - `GET /api/agent/threads/:id/export` → `{ name, text }` (Markdown)
 * - `GET /api/agent/threads/:id/status` → `AgentStatusVo` (context use, this turn's and today's usage, limits)
 * - `POST /api/agent/threads/:id/share` → `{ token }`; `DELETE /api/agent/threads/:id/share` → null;
 *   `GET /api/agent/shared/:token` → `AgentThreadDetailVo` (same tenant only, read-only; tool results are
 *   shown only when the viewer may call that tool)
 * - `POST /api/agent/feedback` `agentFeedbackSave` → null
 * - prompt templates: `GET /api/agent/prompts` → `AgentPromptVo[]`; `POST /api/agent/prompts`,
 *   `PUT|DELETE /api/agent/prompts/:id` (`agentPromptSave`; tenant-wide ones need `agent.skill.modify`)
 * - `POST /api/agent/skills/from-thread/:id` `{ name?, description? }` → `AgentSkillVo` (a draft personal skill
 *   written by the model from the thread, saved disabled for review)
 * - `POST /api/agent/approvals/:itemId` `agentApprovalDecide` → null (only the thread's owner; 409 when the
 *   approval is no longer pending)
 * - `POST /api/agent/questions/:itemId` `agentQuestionAnswer` → null (the agent asked the owner with
 *   `ask.user`, or an external MCP server asked for input; only the owner; 409 when no longer pending)
 * Skills and instructions (`agent.chat.use` for the caller's own; tenant-wide ones need `agent.skill.*` /
 * `agent.instruction.modify`):
 * - `GET /api/agent/skills` → `AgentSkillVo[]` (platform, tenant and own, enabled or not for the managers)
 * - `POST /api/agent/skills` `agentSkillSave` → `AgentSkillVo`; `PUT /api/agent/skills/:id` → `AgentSkillVo`;
 *   `DELETE /api/agent/skills/:id` → null; `POST /api/agent/skills/import` `agentSkillImport` → `AgentSkillVo`;
 *   `GET /api/agent/skills/:id/export` → `{ name, text }` (`SKILL.md`)
 * - `GET|PUT /api/agent/instructions/me` `agentInstructionSave` → `{ body, tone }`;
 *   `GET|PUT /api/agent/instructions/tenant` (PUT `agent.instruction.modify`) → `{ body }`
 * Batches (`agent.batch.run`): `POST /api/agent/batches` `agentBatchCreate` → `AgentBatchVo`;
 * `GET /api/agent/batches/:id` → `AgentBatchDetailVo`; `POST /api/agent/batches/:id/decide`
 * `agentBatchDecide` → `{ decided, skipped }` (every pending approval of the batch at once, except approvals
 * whose target is not the row's own record: those stay pending and must be decided one by one).
 * Platform settings (`agent.setting.browse` / `agent.setting.modify`, platform pages):
 * - `GET|POST /api/agent/providers`, `PUT|DELETE /api/agent/providers/:id` (`agentProviderSave`) → `AgentProviderVo`
 * - `GET|POST /api/agent/search-providers`, `PUT|DELETE /api/agent/search-providers/:id` (`agentSearchProviderSave`)
 * - `GET|POST /api/agent/mcp-servers`, `PUT|DELETE /api/agent/mcp-servers/:id` (`agentMcpServerSave`);
 *   `POST /api/agent/mcp-servers/:id/sync` → `AgentMcpServerVo`;
 *   `PUT /api/agent/mcp-servers/:id/tools/:toolId` `agentExternalToolUpdate` → `AgentExternalToolVo`
 * - `GET /api/agent/tools` → `AgentToolVo[]`; `PUT /api/agent/tools/:name/policy` `agentToolPolicyUpdate` → null
 * - platform skills: `GET|POST /api/agent/platform-skills`, `PUT|DELETE /api/agent/platform-skills/:id` (`agentSkillSave`)
 *   ; `GET /api/agent/platform-skills/:id/export` → `{ name, text }`; `POST /api/agent/platform-skills/import`
 *   `agentSkillImport` (scope ignored) → `AgentSkillVo`
 * Usage (`agent.usage.browse`): `GET /api/agent/usage?<agentUsageQuery>` → `AgentUsageRowVo[]`.
 */

export const agentPerms = {
  chat: { use: 'agent.chat.use' },
  batch: { run: 'agent.batch.run' },
  skill: {
    browse: 'agent.skill.browse',
    create: 'agent.skill.create',
    modify: 'agent.skill.modify',
    remove: 'agent.skill.remove',
  },
  instruction: { modify: 'agent.instruction.modify' },
  setting: { browse: 'agent.setting.browse', modify: 'agent.setting.modify' },
  usage: { browse: 'agent.usage.browse' },
} as const

/** Emergency stop (root only): `true` refuses every new turn and tool call at once; running turns stop. */
export const AGENT_PAUSED_PARAM = 'agent.paused'
/** System parameters (numbers) bounding the work: per turn, per user per day, per tenant per day. */
export const AGENT_LIMIT_PARAMS = {
  turnSteps: 'agent.limit.turn_steps',
  turnSeconds: 'agent.limit.turn_seconds',
  turnTokens: 'agent.limit.turn_tokens',
  userDailyTokens: 'agent.limit.user_daily_tokens',
  tenantDailyTokens: 'agent.limit.tenant_daily_tokens',
  userConcurrentTurns: 'agent.limit.user_concurrent_turns',
} as const
/** `false` (default `true`): the "trust this thread" approval mode is not offered. */
export const AGENT_TRUST_MODE_PARAM = 'agent.trust_mode'
/** The platform instructions (text) put first into every system prompt. */
export const AGENT_INSTRUCTIONS_PARAM = 'agent.instructions'

/**
 * How a tool is offered to the agent: `auto` runs at once, `ask` stops the turn for the owner's decision,
 * `deny` keeps it away from the agent. A write tool is only ever `ask` or `deny`.
 */
export const AGENT_TOOL_POLICIES = ['auto', 'ask', 'deny'] as const
export type AgentToolPolicy = (typeof AGENT_TOOL_POLICIES)[number]

/**
 * Per thread: `read_only` offers only read tools; `ask` (default) asks before each write; `trust` asks once
 * per tool and target in this thread (a write still never runs before a first confirmation).
 */
export const AGENT_APPROVAL_MODES = ['read_only', 'ask', 'trust'] as const
export type AgentApprovalMode = (typeof AGENT_APPROVAL_MODES)[number]

export const AGENT_THREAD_STATUSES = ['active', 'archived'] as const
export const AGENT_TURN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const
export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number]
export const AGENT_ITEM_KINDS = [
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'approval',
  'question',
  'plan',
  'reasoning',
  'compaction',
  'error',
] as const
export type AgentItemKind = (typeof AGENT_ITEM_KINDS)[number]
/** Where a tool comes from: this system's `@McpTool`s, the built-in web tools, an external MCP server. */
export const AGENT_TOOL_SOURCES = ['local', 'web', 'mcp'] as const
export const AGENT_SKILL_SCOPES = ['platform', 'tenant', 'user'] as const
export type AgentSkillScope = (typeof AGENT_SKILL_SCOPES)[number]
export const AGENT_SEARCH_KINDS = ['bocha', 'tavily'] as const
export const AGENT_MCP_AUTH_KINDS = ['none', 'header', 'oauth'] as const
export const AGENT_REASONING = ['low', 'medium', 'high'] as const

/** A skill name: what `$name` in the composer calls (letters, digits, `-`, CJK allowed). */
export const AGENT_SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,63}$/u
/** The longest message the composer sends, and the longest skill body. */
export const AGENT_MESSAGE_MAX = 8000
export const AGENT_SKILL_BODY_MAX = 20000

// ---- chat ----

export const agentModelVo = z.object({
  id: z.string(),
  label: z.string(),
  /** the model takes a reasoning effort */
  reasoning: z.boolean(),
  /** the model reads images */
  vision: z.boolean(),
  /** offered as the "fast" choice */
  fast: z.boolean(),
  contextWindow: z.number().int(),
})
export type AgentModelVo = z.infer<typeof agentModelVo>

export const agentOptionsVo = z.object({
  providers: z.array(
    z.object({ id: z.number().int(), name: z.string(), models: z.array(agentModelVo) }),
  ),
  /** the default provider and model; null while none is configured (the page says so) */
  defaults: z.object({ providerId: z.number().int(), model: z.string() }).nullable(),
  skills: z.array(
    z.object({ name: z.string(), description: z.string(), scope: z.enum(AGENT_SKILL_SCOPES) }),
  ),
  approvalModes: z.array(z.enum(AGENT_APPROVAL_MODES)),
  /** web search is configured and not switched off */
  webSearch: z.boolean(),
  paused: z.boolean(),
  /** starter prompts for the empty state (platform defaults, then the tenant's) */
  starters: z.array(z.string()),
  prompts: z.array(z.object({ id: z.number().int(), name: z.string(), body: z.string() })),
  /** "approve for this thread" is offered (system parameter agent.trust_mode) */
  trustSession: z.boolean(),
  /** the external MCP servers the agent may use now (for `@` mentions) */
  servers: z.array(z.object({ name: z.string() })),
  /** the caller's tone preset */
  tone: z.enum(['default', 'concise', 'detailed', 'friendly', 'formal']),
})
export type AgentOptionsVo = z.infer<typeof agentOptionsVo>

/** Where the user started from (a page and the records selected there), given to the agent as context. */
export const agentContext = z.object({
  route: z.string().max(200),
  title: z.string().max(200).optional(),
  /** a target type such as `demo.customer` and the selected ids */
  target: z.string().max(64).optional(),
  ids: z.array(z.number().int().positive()).max(200).optional(),
})
export type AgentContext = z.infer<typeof agentContext>

export const agentThreadVo = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(AGENT_THREAD_STATUSES),
  providerId: z.number().int().nullable(),
  model: z.string().nullable(),
  reasoning: z.enum(AGENT_REASONING).nullable(),
  approvalMode: z.enum(AGENT_APPROVAL_MODES),
  planMode: z.boolean(),
  pinned: z.boolean(),
  temporary: z.boolean(),
  /** items the owner has not read yet */
  unread: z.number().int(),
  shared: z.boolean(),
  forkedFromId: z.number().int().nullable(),
  batchId: z.number().int().nullable(),
  /** the status of the latest turn, null before the first */
  turnStatus: z.enum(AGENT_TURN_STATUSES).nullable(),
  lastActiveAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AgentThreadVo = z.infer<typeof agentThreadVo>

export const agentThreadQuery = pageQuery(['lastActiveAt', 'createdAt']).extend({
  /** matches titles and message text */
  keyword: z.string().trim().max(100).optional(),
  status: z.enum(AGENT_THREAD_STATUSES).optional(),
  /** `active`: a turn running or waiting for the owner; `unread`: unread items */
  view: z.enum(['all', 'active', 'unread', 'pinned']).default('all'),
})
export type AgentThreadQuery = z.infer<typeof agentThreadQuery>

export const agentThreadCreate = z
  .object({
    title: z.string().trim().max(200).optional(),
    providerId: z.number().int().positive().optional(),
    model: z.string().max(128).optional(),
    reasoning: z.enum(AGENT_REASONING).optional(),
    approvalMode: z.enum(AGENT_APPROVAL_MODES).default('ask'),
    planMode: z.boolean().default(false),
    /** kept out of the list, deleted when closed */
    temporary: z.boolean().default(false),
    context: agentContext.optional(),
  })
  .register(fieldDomains, { domain: 'agent.thread' })
export type AgentThreadCreate = z.infer<typeof agentThreadCreate>

export const agentThreadUpdate = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(AGENT_THREAD_STATUSES).optional(),
    providerId: z.number().int().positive().optional(),
    model: z.string().max(128).optional(),
    reasoning: z.enum(AGENT_REASONING).nullable().optional(),
    approvalMode: z.enum(AGENT_APPROVAL_MODES).optional(),
    planMode: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .register(fieldDomains, { domain: 'agent.thread' })
export type AgentThreadUpdate = z.infer<typeof agentThreadUpdate>

export const agentThreadFork = z.object({ seq: z.number().int().min(0) })
export const agentThreadRead = z.object({ seq: z.number().int().min(0) })
/** `route`: the page the chat was opened from, for starters that fit it */
export const agentOptionsQuery = z.object({ route: z.string().max(200).optional() })

export const agentMessageSend = z
  .object({
    text: z.string().trim().min(1).max(AGENT_MESSAGE_MAX),
    /** `$name` picked in the composer: the skill's body is loaded for this turn */
    skill: z.string().regex(AGENT_SKILL_NAME).optional(),
    /** files already uploaded to the storage module (the caller must be able to read them) */
    fileIds: z.array(z.number().int().positive()).max(10).optional(),
    /** while a turn runs: `steer` (default) joins it after the current step, `queue` waits for the next turn */
    mode: z.enum(['steer', 'queue']).default('steer'),
  })
  .register(fieldDomains, { domain: 'agent.message' })
export type AgentMessageSend = z.infer<typeof agentMessageSend>

export const agentApprovalDecide = z
  .object({
    /** `approve_session`: also approve this tool on this target for the rest of the thread; `cancel` stops the turn */
    decision: z.enum(['approve', 'approve_session', 'reject', 'cancel']),
    note: z.string().trim().max(500).optional(),
  })
  .register(fieldDomains, { domain: 'agent.approval' })
export type AgentApprovalDecide = z.infer<typeof agentApprovalDecide>

/** Answers to a `question` item, one entry per question (by header); `other` is the free-text choice. */
export const agentQuestionAnswer = z
  .object({
    answers: z
      .array(
        z.object({
          header: z.string().max(40),
          selected: z.array(z.string().max(200)).max(10),
          other: z.string().trim().max(1000).optional(),
        }),
      )
      .max(4)
      .default([]),
    /** the values of an elicitation form */
    form: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
    /** declined: the agent is told the user did not answer */
    decline: z.boolean().optional(),
  })
  .register(fieldDomains, { domain: 'agent.question' })
export type AgentQuestionAnswer = z.infer<typeof agentQuestionAnswer>

export interface AgentAttachment {
  fileId: number
  name: string
  mime: string
  size: number
}

/** A web source the agent read this turn (listed on approval cards). */
export const agentSource = z.object({ title: z.string(), url: z.string() })
export type AgentSource = z.infer<typeof agentSource>

/** Item payloads by kind; text is plain Markdown (the page sanitizes it), tool content is untrusted. */
export interface AgentItemPayloads {
  user: {
    text: string
    skill?: string
    context?: AgentContext
    /** files from the storage module: text files are read into the context, images go to vision models */
    attachments?: AgentAttachment[]
    /** sent while the turn ran: `steer` joined the running turn, `queue` waited for the next one */
    mode?: 'steer' | 'queue'
  }
  /** `citations`: the web sources behind the answer; `suggestions`: 0–3 follow-up prompts */
  assistant: { text: string; citations?: AgentSource[]; suggestions?: string[] }
  /** the model's reasoning summary, when the provider streams one (collapsed on the page) */
  reasoning: { text: string }
  /** earlier items up to `upToSeq` were summarized to save context (auto or `/compact`) */
  compaction: { upToSeq: number; auto: boolean }
  tool_call: {
    callId: string
    tool: string
    title: string
    source: (typeof AGENT_TOOL_SOURCES)[number]
    kind: (typeof MCP_TOOL_KINDS)[number]
    args: unknown
  }
  tool_result: {
    callId: string
    ok: boolean
    /** shortened content shown on the page; the model got the full (capped) content */
    preview: string
    /** content from outside the system (web, external MCP): the model was told not to follow it */
    untrusted: boolean
    error?: { code: string; message: string }
  }
  approval: {
    callId: string
    tool: string
    title: string
    args: unknown
    /** what changes: the record and each field's current → proposed value, when the tool can tell */
    changes?: { target: string; fields: { field: string; from: unknown; to: unknown }[] }
    sources: AgentSource[]
    decidedBy?: number
    decidedAt?: string
    note?: string
    /** how it was decided: once, for the rest of this thread (same tool and target), rejected, cancelled */
    decision?: 'approve' | 'approve_session' | 'reject' | 'cancel'
    /** why the agent cannot do it, when a permission or the thread's mode blocks the tool (recovery hint) */
    blocked?: { reason: 'permission' | 'mode' | 'policy'; perm?: string }
  }
  /**
   * the agent (built-in `ask.user`) or an external MCP server (elicitation) asks the owner; the turn waits
   * like for an approval. `answers` are the picked option labels and/or the free text once answered.
   */
  question: {
    callId: string
    /** `agent` or the external server's name */
    from: string
    questions: {
      /** short chip text, e.g. "公司" */
      header: string
      question: string
      options: { label: string; description?: string }[]
      multiSelect: boolean
    }[]
    /**
     * an external server's elicitation may ask for a form instead (a flat JSON Schema object of string,
     * number, boolean and enum fields); answered with `agentQuestionAnswer.form`
     */
    form?: { title?: string; schema: Record<string, unknown> }
    answers?: { header: string; selected: string[]; other?: string }[]
  }
  plan: { steps: { text: string; status: 'pending' | 'doing' | 'done' }[] }
  error: { code: string; message: string }
}

export const AGENT_ITEM_STATUSES = [
  'pending',
  'running',
  'done',
  'failed',
  'approved',
  'rejected',
  'answered',
  'expired',
] as const

export type AgentItemVo = {
  [K in AgentItemKind]: {
    id: number
    seq: number
    turnId: number | null
    kind: K
    status: (typeof AGENT_ITEM_STATUSES)[number] | null
    payload: AgentItemPayloads[K]
    createdAt: string
  }
}[AgentItemKind]

export const agentTurnVo = z.object({
  id: z.number().int(),
  threadId: z.number().int(),
  status: z.enum(AGENT_TURN_STATUSES),
  steps: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
})
export type AgentTurnVo = z.infer<typeof agentTurnVo>

export interface AgentThreadDetailVo {
  thread: AgentThreadVo
  /** items after `afterSeq` (all when absent), in seq order */
  items: AgentItemVo[]
  /** the latest turn, null before the first */
  turn: AgentTurnVo | null
}

/**
 * `agent:event` payload, to the thread owner's sockets only: an item was added or changed (full item), text
 * was streamed into an assistant item (`delta` appended to its text), or the turn's status changed.
 */
export type AgentEvent =
  | { threadId: number; type: 'item'; item: AgentItemVo }
  | { threadId: number; type: 'delta'; itemId: number; delta: string }
  | { threadId: number; type: 'turn'; turn: AgentTurnVo }

// ---- skills & instructions ----

export const agentSkillVo = z.object({
  id: z.number().int(),
  scope: z.enum(AGENT_SKILL_SCOPES),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  /** the tools it may use; null = any the thread may use */
  tools: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  /** the caller may edit it */
  editable: z.boolean(),
  updatedAt: z.string(),
})
export type AgentSkillVo = z.infer<typeof agentSkillVo>

export const agentSkillSave = z
  .object({
    /** `user` (own) or `tenant` (needs `agent.skill.create`/`modify`); ignored for platform skills */
    scope: z.enum(['tenant', 'user']).default('user'),
    name: z.string().trim().regex(AGENT_SKILL_NAME),
    description: z.string().trim().min(1).max(512),
    body: z.string().trim().min(1).max(AGENT_SKILL_BODY_MAX),
    tools: z.array(z.string().max(160)).max(100).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .register(fieldDomains, { domain: 'agent.skill' })
export type AgentSkillSave = z.infer<typeof agentSkillSave>

/** A `SKILL.md`: YAML front matter `name`, `description`, optional `tools`, then the body. */
export const agentSkillImport = z
  .object({
    scope: z.enum(['tenant', 'user']).default('user'),
    text: z
      .string()
      .min(1)
      .max(AGENT_SKILL_BODY_MAX + 2000),
  })
  .register(fieldDomains, { domain: 'agent.skill' })
export type AgentSkillImport = z.infer<typeof agentSkillImport>

export const AGENT_TONES = ['default', 'concise', 'detailed', 'friendly', 'formal'] as const
export const agentInstructionSave = z
  .object({
    body: z.string().max(AGENT_SKILL_BODY_MAX),
    /** personal instructions only */
    tone: z.enum(AGENT_TONES).optional(),
  })
  .register(fieldDomains, { domain: 'agent.instruction' })
export type AgentInstructionSave = z.infer<typeof agentInstructionSave>

// ---- batches ----

export const agentBatchCreate = z
  .object({
    skill: z.string().regex(AGENT_SKILL_NAME),
    /** a target type that registered batch support, such as `demo.customer` */
    target: z.string().max(64),
    ids: z.array(z.number().int().positive()).min(1).max(200),
  })
  .register(fieldDomains, { domain: 'agent.batch' })
export type AgentBatchCreate = z.infer<typeof agentBatchCreate>

export const agentBatchVo = z.object({
  id: z.number().int(),
  skill: z.string(),
  target: z.string(),
  status: z.enum(['running', 'completed', 'cancelled']),
  total: z.number().int(),
  finished: z.number().int(),
  failed: z.number().int(),
  createdAt: z.string(),
})
export type AgentBatchVo = z.infer<typeof agentBatchVo>

export interface AgentBatchDetailVo {
  batch: AgentBatchVo
  rows: {
    targetId: number
    /** the record's display name (the batch target's label) */
    label: string
    threadId: number
    turnStatus: AgentTurnStatus | null
    /** the approvals waiting in this row's thread */
    pending: Extract<AgentItemVo, { kind: 'approval' }>[]
  }[]
}

export const agentBatchDecide = z.object({ decision: z.enum(['approve', 'reject']) })

// ---- platform settings ----

export const agentProviderSave = z
  .object({
    name: z.string().trim().min(1).max(64),
    baseUrl: z.url({ protocol: /^https?$/ }).max(512),
    /** write-only: absent or empty keeps the stored key */
    apiKey: z.string().max(512).optional(),
    models: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(128),
          label: z.string().trim().max(128).optional(),
          reasoning: z.boolean().default(false),
          vision: z.boolean().default(false),
          fast: z.boolean().default(false),
          contextWindow: z.number().int().min(1024).max(10_000_000).default(64_000),
        }),
      )
      .min(1)
      .max(50),
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    sort: z.number().int().default(0),
  })
  .register(fieldDomains, { domain: 'agent.provider' })
export type AgentProviderSave = z.infer<typeof agentProviderSave>

export const agentProviderVo = z.object({
  id: z.number().int(),
  name: z.string(),
  baseUrl: z.string(),
  /** a key is stored (never the key itself) */
  hasKey: z.boolean(),
  models: z.array(agentModelVo),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  sort: z.number().int(),
})
export type AgentProviderVo = z.infer<typeof agentProviderVo>

export const agentSearchProviderSave = z
  .object({
    kind: z.enum(AGENT_SEARCH_KINDS),
    name: z.string().trim().min(1).max(64),
    apiKey: z.string().max(512).optional(),
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  })
  .register(fieldDomains, { domain: 'agent.search' })
export type AgentSearchProviderSave = z.infer<typeof agentSearchProviderSave>

export const agentSearchProviderVo = z.object({
  id: z.number().int(),
  kind: z.enum(AGENT_SEARCH_KINDS),
  name: z.string(),
  hasKey: z.boolean(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
})
export type AgentSearchProviderVo = z.infer<typeof agentSearchProviderVo>

export const agentMcpServerSave = z
  .object({
    name: z.string().trim().min(1).max(64),
    url: z.url({ protocol: /^https?$/ }).max(512),
    authKind: z.enum(AGENT_MCP_AUTH_KINDS).default('none'),
    /**
     * write-only; `header`: `{ name, value }` sent on every request; `oauth`: client credentials
     * `{ tokenUrl, clientId, clientSecret, scope? }`. Absent keeps the stored one.
     */
    auth: z.record(z.string(), z.string().max(2048)).optional(),
    /** may point at a private address (root only, explicit) */
    allowPrivate: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .register(fieldDomains, { domain: 'agent.mcpServer' })
export type AgentMcpServerSave = z.infer<typeof agentMcpServerSave>

export const agentExternalToolVo = z.object({
  id: z.number().int(),
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** what the server claims; untrusted */
  readOnlyHint: z.boolean(),
  enabled: z.boolean(),
  policy: z.enum(AGENT_TOOL_POLICIES),
})
export type AgentExternalToolVo = z.infer<typeof agentExternalToolVo>

export const agentMcpServerVo = z.object({
  id: z.number().int(),
  name: z.string(),
  url: z.string(),
  authKind: z.enum(AGENT_MCP_AUTH_KINDS),
  hasAuth: z.boolean(),
  allowPrivate: z.boolean(),
  enabled: z.boolean(),
  status: z.enum(['unknown', 'ok', 'error']),
  lastError: z.string().nullable(),
  syncedAt: z.string().nullable(),
  tools: z.array(agentExternalToolVo),
})
export type AgentMcpServerVo = z.infer<typeof agentMcpServerVo>

export const agentExternalToolUpdate = z.object({
  enabled: z.boolean().optional(),
  policy: z.enum(AGENT_TOOL_POLICIES).optional(),
})

/** One of this system's tools as the agent settings page lists it. */
export const agentToolVo = z.object({
  name: z.string(),
  title: z.string(),
  kind: z.enum(MCP_TOOL_KINDS),
  source: z.enum(['local', 'web']),
  perm: z.string().nullable(),
  policy: z.enum(AGENT_TOOL_POLICIES),
  /** the policy is the kind's default (no explicit setting) */
  defaulted: z.boolean(),
})
export type AgentToolVo = z.infer<typeof agentToolVo>

export const agentToolPolicyUpdate = z.object({
  /** null: back to the kind's default (read `auto`, write `ask`); a write tool takes only `ask` or `deny` */
  policy: z.enum(AGENT_TOOL_POLICIES).nullable(),
})

// ---- usage ----

export const agentUsageQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(['day', 'user', 'model']).default('day'),
})
export type AgentUsageQuery = z.infer<typeof agentUsageQuery>

export const agentUsageRowVo = z.object({
  key: z.string(),
  label: z.string(),
  calls: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
})
export type AgentUsageRowVo = z.infer<typeof agentUsageRowVo>

// ---- status, feedback, prompt templates ----

export const agentStatusVo = z.object({
  threadId: z.number().int(),
  model: z.string().nullable(),
  /** tokens the next model call would send, and the model's window */
  contextUsed: z.number().int(),
  contextWindow: z.number().int(),
  turn: agentTurnVo.nullable(),
  today: z.object({
    userTokens: z.number().int(),
    userLimit: z.number().int(),
    tenantTokens: z.number().int(),
    tenantLimit: z.number().int(),
  }),
})
export type AgentStatusVo = z.infer<typeof agentStatusVo>

export const agentFeedbackSave = z
  .object({
    itemId: z.number().int().positive(),
    rating: z.union([z.literal(1), z.literal(-1)]),
    comment: z.string().trim().max(1000).optional(),
  })
  .register(fieldDomains, { domain: 'agent.feedback' })
export type AgentFeedbackSave = z.infer<typeof agentFeedbackSave>

export const agentPromptSave = z
  .object({
    scope: z.enum(['tenant', 'user']).default('user'),
    name: z.string().trim().min(1).max(64),
    body: z.string().trim().min(1).max(AGENT_MESSAGE_MAX),
  })
  .register(fieldDomains, { domain: 'agent.prompt' })
export type AgentPromptSave = z.infer<typeof agentPromptSave>

export const agentPromptVo = z.object({
  id: z.number().int(),
  scope: z.enum(['tenant', 'user']),
  name: z.string(),
  body: z.string(),
  editable: z.boolean(),
})
export type AgentPromptVo = z.infer<typeof agentPromptVo>

/** Web search settings (system parameters, root): `live` searches now, `off` hides the web tools. */
export const AGENT_WEB_MODE_PARAM = 'agent.web.mode'
export const AGENT_WEB_MODES = ['live', 'off'] as const
/** Comma-separated domains `web.fetch` may read besides search results; empty = only results and user links. */
export const AGENT_WEB_DOMAINS_PARAM = 'agent.web.allowed_domains'
