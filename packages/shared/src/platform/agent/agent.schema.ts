import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { MCP_TOOL_KINDS } from '../mcp/mcp.schema.js'
import { agentCreditAmount, agentModelPricing, agentTokenUsage } from './agent-billing.schema.js'

/**
 * The in-app agent (see docs/agent.md), only while the server runs with `APP_AGENT=true` (otherwise every
 * route below answers 404 and the menus are hidden). A thread holds turns, a turn holds items; a turn runs
 * in the job queue and streams `agent:event` envelopes to its owner. Field labels `field.agent.<resource>.<prop>`.
 *
 * Chat page (`agent.chat.use`; every thread route acts on the caller's own threads only, another's is 404):
 * - `GET /api/agent/options?<agentOptionsQuery>` → `AgentOptionsVo` (models, skills, modes, starters for the
 *   page the user came from)
 * - `GET /api/agent/my-tools` → `AgentMyToolVo[]` (the tools the caller may list in a profile; answers whether
 *   `APP_MCP` is on or off)
 * - `GET /api/agent/threads?<agentThreadQuery>` → `{ items: AgentThreadVo[], total }`
 * - `POST /api/agent/threads` `agentThreadCreate` → `AgentThreadVo`
 * - `PATCH /api/agent/threads/:id` `agentThreadUpdate` → `AgentThreadVo`; `DELETE /api/agent/threads/:id` → null
 * - `POST /api/agent/threads/:id/fork` `agentThreadFork` → `AgentThreadVo` (items up to `seq` copied)
 * - `DELETE /api/agent/threads/:id/allowed-tools/:tool` → `AgentThreadVo` (the tool, URL-encoded, asks again
 *   in this thread; see `allowedTools`)
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
 *   `ask.user`, or an external MCP server asked for input; only the owner; 409 when no longer pending; 400 for
 *   a plan card)
 * - `POST /api/agent/plans/:itemId` `agentPlanDecide` → null (the owner's choice on a plan card of
 *   `plan.propose`: approve and run in `auto_review` (400 when the platform offers no review) or `ask`, or
 *   keep refining with optional feedback; only the owner; 409 when no longer pending)
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
 * - `GET|POST /api/agent/providers`, `PUT|DELETE /api/agent/providers/:id` (`agentProviderSave`) → `AgentProviderVo`;
 *   `POST /api/agent/providers/models` (`agentProviderModelsQuery`) → `AgentProviderModelsVo` (the upstream's model list)
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
  turnCredits: 'agent.limit.turn_credits',
  userDailyCredits: 'agent.limit.user_daily_credits',
  tenantDailyCredits: 'agent.limit.tenant_daily_credits',
  userConcurrentTurns: 'agent.limit.user_concurrent_turns',
} as const
/** The platform instructions (text) put first into every system prompt. */
export const AGENT_INSTRUCTIONS_PARAM = 'agent.instructions'

/**
 * How a tool is offered to the agent: `auto` runs at once, `deny` keeps it away from the agent. A read tool
 * is `auto` (default), `ask` (an administrator's explicit choice, e.g. paid image generation: the owner
 * confirms each call in every mode; never reviewed, may be allowed for the thread) or `deny`. A write tool is `ask` (needs a confirmation, which the review model may give
 * in the auto-review mode; the default), `human` (only the owner confirms it, one call at a time: never
 * reviewed, never allowed for the whole thread; the default of high-risk tools) or `deny`.
 */
export const AGENT_TOOL_POLICIES = ['auto', 'ask', 'human', 'deny'] as const
export type AgentToolPolicy = (typeof AGENT_TOOL_POLICIES)[number]

/**
 * The thread's mode: `read_only` offers only read tools; `plan` too, and the agent ends with a plan card
 * (`plan.propose`) the owner approves (switching to `ask` or `auto_review`) or sends back; `ask` (default) asks before each write; `auto_review` lets the review model decide each
 * write of an `ask` tool first (when it is unsure or finds a risk, the owner decides). Read tools
 * ask only when an administrator set them to `ask`.
 */
export const AGENT_APPROVAL_MODES = ['read_only', 'plan', 'ask', 'auto_review'] as const
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
  'chart',
  'image',
  'report',
  'subagent',
  'error',
] as const
export type AgentItemKind = (typeof AGENT_ITEM_KINDS)[number]
/** Where a tool comes from: this system's `@McpTool`s, the built-in web tools, an external MCP server. */
export const AGENT_TOOL_SOURCES = ['local', 'web', 'mcp'] as const
export const AGENT_SKILL_SCOPES = ['platform', 'tenant', 'user'] as const
export type AgentSkillScope = (typeof AGENT_SKILL_SCOPES)[number]
export const AGENT_SEARCH_KINDS = ['bocha', 'tavily'] as const
export const AGENT_MCP_AUTH_KINDS = ['none', 'header', 'oauth'] as const
export const AGENT_REASONING = ['off', 'low', 'medium', 'high'] as const

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
  /** the model generates images (`image.generate`, OpenAI-compatible images API) */
  image: z.boolean().optional(),
  pricing: agentModelPricing.nullable().optional(),
  reasoningDefault: z.enum(['provider', ...AGENT_REASONING]).optional(),
  reasoningStyle: z.enum(['standard', 'vllm']).optional(),
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
  recoveryRequired: z.boolean().optional(),
  recoveryRevision: z.number().int().nonnegative().optional(),
  /** tools the owner chose not to be asked about again in this thread (`approve_session`) */
  allowedTools: z.array(z.string()),
  profileId: z.number().int().nullable(),
  memoryEnabled: z.boolean(),
  /** a subagent's thread (hidden from the list) */
  parentThreadId: z.number().int().nullable(),
  /** a thread an automation run started (hidden from the list) */
  automationRunId: z.number().int().nullable(),
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
    clientDraftId: z.uuid().optional(),
    title: z.string().trim().max(200).optional(),
    providerId: z.number().int().positive().optional(),
    model: z.string().max(128).optional(),
    reasoning: z.enum(AGENT_REASONING).optional(),
    /** left out: the profile's mode, else `ask` */
    approvalMode: z.enum(AGENT_APPROVAL_MODES).optional(),
    /**
     * a profile's model, mode, tools and instructions apply (fields given here win); left out: the caller's
     * default profile; null: no profile at all
     */
    profileId: z.number().int().positive().nullable().optional(),
    memoryEnabled: z.boolean().default(true),
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
    pinned: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    profileId: z.number().int().positive().nullable().optional(),
  })
  .register(fieldDomains, { domain: 'agent.thread' })
export type AgentThreadUpdate = z.infer<typeof agentThreadUpdate>

export const agentThreadFork = z.object({
  seq: z.number().int().min(0),
  clientDraftId: z.uuid().optional(),
})
export const agentThreadRead = z.object({ seq: z.number().int().min(0) })
/** `route`: the page the chat was opened from, for starters that fit it */
export const agentOptionsQuery = z.object({ route: z.string().max(200).optional() })

export const agentMessageSend = z
  .object({
    clientMessageId: z.uuid().optional(),
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
    /**
     * `approve_session`: also don't ask again for this tool in this thread (only when the card offers it,
     * `sessionAllow`; else 400); `cancel` stops the turn
     */
    decision: z.enum(['approve', 'approve_session', 'reject', 'cancel']),
    confirmationToken: z.string().uuid().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .register(fieldDomains, { domain: 'agent.approval' })
export type AgentApprovalDecide = z.infer<typeof agentApprovalDecide>

/**
 * The owner's choice on a plan card: approve and execute with the automatic review (`auto_review`) or with a
 * confirmation per write (`ask`) — the thread switches to that mode and a new turn runs the plan — or keep
 * refining it in plan mode (`refine`, the feedback becomes the next user message).
 */
export const AGENT_PLAN_DECISIONS = ['auto_review', 'ask', 'refine'] as const
export const agentPlanDecide = z
  .object({
    decision: z.enum(AGENT_PLAN_DECISIONS),
    feedback: z.string().trim().max(2000).optional(),
  })
  .register(fieldDomains, { domain: 'agent.plan' })
export type AgentPlanDecide = z.infer<typeof agentPlanDecide>

/** A plan the agent proposes in plan mode (`plan.propose`); every text is the agent's own. */
export interface AgentPlanProposal {
  title: string
  summary: string
  steps: string[]
  /** the data it expects to change */
  changes?: string
  assumptions?: string[]
}

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
    /** written by the runtime: the plan card (item id) whose approval started this turn; the text carries the plan */
    fromPlan?: number
  }
  /** `citations`: the web sources behind the answer; `suggestions`: 0–3 follow-up prompts */
  assistant: { text: string; citations?: AgentSource[]; suggestions?: string[] }
  /** the model's reasoning summary, when the provider streams one (collapsed on the page) */
  reasoning: { text: string }
  /** earlier items up to `upToSeq` were summarized to save context (auto or `/compact`) */
  compaction: { upToSeq: number; auto: boolean }
  /** a declarative chart or table the page renders (`chart.render`); never code */
  chart: AgentChartSpec
  /** a generated image stored in the file storage (`image.generate`) */
  image: { fileId: number; prompt: string; width?: number; height?: number }
  /** a research report (Markdown with numbered citations), exportable */
  report: { title: string; text: string; citations: AgentSource[] }
  /** delegated subtasks (`agent.delegate`): one entry per child thread with its status and summary */
  subagent: {
    callId: string
    tasks: {
      title: string
      threadId: number
      status: AgentTurnStatus | 'queued'
      summary?: string
    }[]
  }
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
    /** 每次都须单卡人工确认；token 只代表当前展示的预览版本。 */
    perCallConfirmation?: true
    /** the tool's policy was `human` when the card was made: only the owner confirms it, one card at a time */
    human?: true
    confirmationToken?: string
    decidedBy?: number
    decidedAt?: string
    note?: string
    /** how it was decided: once, for the rest of this thread (this tool), rejected, cancelled */
    decision?: 'approve' | 'approve_session' | 'reject' | 'cancel'
    /** the card may offer "don't ask again for this tool in this conversation" (`approve_session`) */
    sessionAllow?: boolean
    /** ran without asking because the owner allowed this tool for the thread before */
    allowedBy?: 'session'
    /**
     * decided by the review model (auto-review mode) or by the automation's pre-approval, with its reason; a
     * pending card with verdict `reject` or `escalate` waits for the owner, who may still approve it
     */
    auto?: {
      by: 'review' | 'pre_approved'
      verdict: 'approve' | 'reject' | 'escalate'
      reason: string
    }
    /**
     * the thread is in the auto-review mode but this call waits for the owner without a review, and why:
     * the tool's policy is `human` (`policy`; `read` for a read tool set to `ask`, which is never reviewed), it needs the owner's own confirmation each time (`personal`),
     * the thread is read-only or in plan mode (`mode`), the agent is paused (`paused`), or no review model is
     * set (`no_model`)
     */
    unreviewed?: 'policy' | 'read' | 'personal' | 'mode' | 'paused' | 'no_model'
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
    /**
     * a plan card instead (`plan.propose` in plan mode, `questions` empty): waits for the owner's choice
     * (`agentPlanDecide`); the model cannot leave plan mode by itself
     */
    proposal?: AgentPlanProposal
    /** the owner's choice on a plan card, once decided (a message sent while it waited counts as `refine`) */
    choice?: {
      decision: (typeof AGENT_PLAN_DECISIONS)[number]
      decidedBy: number
      decidedAt: string
      feedback?: string
    }
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
    /** 缺省只用于兼容旧服务器；新快照总携带版本。 */
    revision?: number
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
  credits: z.string(),
  unpricedCalls: z.number().int(),
  unreportedCalls: z.number().int(),
  legacyUsage: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
})
export type AgentTurnVo = z.infer<typeof agentTurnVo>

export const agentDraftReceiptVo = z.object({
  clientDraftId: z.uuid(),
  threadId: z.number().int(),
  status: z.enum(['accepted', 'removed']),
  thread: agentThreadVo.nullable(),
})
export type AgentDraftReceiptVo = z.infer<typeof agentDraftReceiptVo>

export const agentMessageReceiptVo = z.object({
  clientMessageId: z.uuid(),
  threadId: z.number().int(),
  itemId: z.number().int(),
  turnId: z.number().int(),
  status: z.enum(['accepted', 'removed']),
  turn: agentTurnVo.nullable(),
})
export type AgentMessageReceiptVo = z.infer<typeof agentMessageReceiptVo>

export const agentRecoveryAcknowledge = z
  .object({ revision: z.number().int().nonnegative() })
  .register(fieldDomains, { domain: 'agent.thread' })
export type AgentRecoveryAcknowledge = z.infer<typeof agentRecoveryAcknowledge>

export const agentClientDraftParams = z.object({ clientDraftId: z.uuid() })
export const agentMessageReceiptParams = z.object({
  id: z.coerce.number().int().positive(),
  clientMessageId: z.uuid(),
})

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
  | {
      threadId: number
      type: 'delta'
      itemId: number
      delta: string
      /** 已提交的快照版本，以及本段开始的 UTF-16 字符偏移。 */
      revision?: number
      offset?: number
    }
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
          /** an image model: offered to the agent as `image.generate` */
          image: z.boolean().default(false),
          pricing: agentModelPricing.nullable().default(null),
          reasoningDefault: z.enum(['provider', ...AGENT_REASONING]).default('provider'),
          reasoningStyle: z.enum(['standard', 'vllm']).default('standard'),
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

/**
 * Load the models an OpenAI-compatible service offers (`GET {baseUrl}/models`). The key is the given
 * `apiKey`, else the stored key of provider `id` only while `baseUrl` is still its stored address.
 */
export const agentProviderModelsQuery = z
  .object({
    id: z.number().int().positive().optional(),
    baseUrl: agentProviderSave.shape.baseUrl,
    apiKey: z.string().max(512).optional(),
  })
  .register(fieldDomains, { domain: 'agent.provider' })
export type AgentProviderModelsQuery = z.infer<typeof agentProviderModelsQuery>

/** at most this many models come back, sorted by id */
export const AGENT_PROVIDER_MODELS_MAX = 500

export const agentProviderModelsVo = z.object({
  items: z.array(z.object({ id: z.string(), ownedBy: z.string().optional() })),
})
export type AgentProviderModelsVo = z.infer<typeof agentProviderModelsVo>

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
  /** `builtin`: a tool of the agent runtime itself (plan, questions, skills, memory and the like) */
  source: z.enum(['local', 'web', 'builtin']),
  perm: z.string().nullable(),
  policy: z.enum(AGENT_TOOL_POLICIES),
  /** the policy is the kind's default (no explicit setting) */
  defaulted: z.boolean(),
  /** the platform switch (`cfg_mcp_tool.enabled`); off: the agent never gets the tool */
  enabled: z.boolean(),
  /** a built-in tool only the owner confirms: its policy is only `human` or `deny` */
  humanOnly: z.literal(true).optional(),
})
export type AgentToolVo = z.infer<typeof agentToolVo>

/**
 * A tool the caller may put into a profile's tool list (`GET /api/agent/my-tools`): this system's tools the
 * caller reaches (`local`), the web tools, the built-in tools and the enabled tools of external MCP servers
 * (`mcp`, named `ext.<server>.<tool>`); tools switched off or denied in the agent are left out. `kind` of an
 * external tool: `read` when its policy is `auto`, else `write`.
 */
export const agentMyToolVo = z.object({
  name: z.string(),
  title: z.string(),
  kind: z.enum(MCP_TOOL_KINDS),
  origin: z.enum(['local', 'web', 'builtin', 'mcp']),
})
export type AgentMyToolVo = z.infer<typeof agentMyToolVo>

/** Switches a built-in tool on or off for the agent (this system's other tools: the MCP tool page). */
export const agentToolEnabledUpdate = z.object({ enabled: z.boolean() })

export const agentToolPolicyUpdate = z.object({
  /**
   * null: back to the default (read `auto`, write `ask`, a high-risk write `human`); a read tool takes only
   * `auto`, `ask` or `deny`, a write tool only `ask`, `human` or `deny` (else 400)
   */
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
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheWriteTokens: z.number().int().nullable(),
  reasoningTokens: z.number().int().nullable(),
  credits: z.string(),
  unpricedCalls: z.number().int(),
  unreportedCalls: z.number().int(),
  legacyCalls: z.number().int(),
})
export type AgentUsageRowVo = z.infer<typeof agentUsageRowVo>

export const agentUsageEntriesQuery = pageQuery(['createdAt', 'id']).extend({
  from: z.iso.date(),
  to: z.iso.date(),
})
export type AgentUsageEntriesQuery = z.infer<typeof agentUsageEntriesQuery>

export const agentUsageEntryVo = z.object({
  id: z.number().int(),
  status: z.enum(['pending', 'complete', 'unknown']).optional(),
  userId: z.number().int(),
  providerId: z.number().int(),
  providerName: z.string(),
  model: z.string(),
  threadId: z.number().int().nullable(),
  turnId: z.number().int().nullable(),
  kind: z.enum(['chat', 'image']),
  usage: agentTokenUsage.nullable(),
  pricing: agentModelPricing.nullable(),
  credits: z.string().nullable(),
  usageReported: z.boolean(),
  createdAt: z.string(),
})
export type AgentUsageEntryVo = z.infer<typeof agentUsageEntryVo>

// ---- status, feedback, prompt templates ----

export const agentStatusVo = z.object({
  threadId: z.number().int(),
  model: z.string().nullable(),
  /** tokens the next model call would send, and the model's window */
  contextUsed: z.number().int(),
  contextWindow: z.number().int(),
  turn: agentTurnVo.nullable(),
  today: z.object({
    userTokens: z.number().int().nullable(),
    userLimit: agentCreditAmount,
    tenantTokens: z.number().int().nullable(),
    tenantLimit: agentCreditAmount,
    userCredits: z.string(),
    tenantCredits: z.string(),
    userUnpricedCalls: z.number().int(),
    tenantUnpricedCalls: z.number().int(),
    userLegacyCalls: z.number().int().optional(),
    tenantLegacyCalls: z.number().int().optional(),
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

// ---- charts, profiles, memories, automations, notifications, diagnostics ----
/*
 * Routes (all owner-only unless noted; `agent.chat.use`):
 * - profiles: `GET /api/agent/profiles` → `AgentProfileVo[]`; `POST /api/agent/profiles`, `PUT|DELETE
 *   /api/agent/profiles/:id` (`agentProfileSave`; tenant-wide ones need `agent.skill.modify`)
 * - memories: `GET /api/agent/memories?<agentMemoryQuery>` → `{ items: AgentMemoryVo[], total }`;
 *   `POST /api/agent/memories` / `PUT /api/agent/memories/:id` (`agentMemorySave`); `DELETE /api/agent/memories/:id`;
 *   `POST /api/agent/memories/forget-all` `{ currentPassword }` → `{ removed }`
 * - automations (`agent.automation.use`; shared ones `agent.automation.share`): `GET /api/agent/automations`
 *   → `AgentAutomationVo[]`; `POST`, `PUT|DELETE /api/agent/automations/:id` (`agentAutomationSave`);
 *   `POST /api/agent/automations/:id/run` → `AgentAutomationRunVo`; `POST /api/agent/automations/:id/enabled`
 *   `{ enabled }`; `GET /api/agent/automations/:id/runs?<pageQuery>` → `{ items: AgentAutomationRunVo[], total }`;
 *   `GET /api/agent/automation-events` → `AgentAutomationEventVo[]` (the action-log actions an automation may
 *   listen to, those the caller may browse)
 * - notification settings: `GET|PUT /api/agent/notify-settings` (`agentNotifySettings`)
 * - exports: `GET /api/agent/items/:itemId/xlsx` (a chart's or report table's data as xlsx, owner only)
 * - diagnostics (`agent.setting.browse`, platform): `GET /api/agent/diagnostics` → `AgentDiagnosticsVo`;
 *   `POST /api/agent/diagnostics/test-provider/:id`, `POST /api/agent/diagnostics/test-search/:id`,
 *   `POST /api/agent/diagnostics/test-mcp/:id` → `{ ok, ms, error? }` (root)
 */

export const agentAutomationPerms = {
  use: 'agent.automation.use',
  share: 'agent.automation.share',
} as const

/** System parameters of the second part (root only where they bound cost or safety). */
export const AGENT2_PARAMS = {
  /** `true`: a background job distils memories from idle threads (default false) */
  memoryExtract: 'agent.memory.extract',
  /** memories put into one turn at most */
  memoryPerTurn: 'agent.memory.per_turn',
  /** the review model for auto-review: `<providerId>:<model>`; empty = auto-review unavailable */
  reviewModel: 'agent.review.model',
  /** step and time limits of a research turn */
  researchSteps: 'agent.limit.research_steps',
  researchSeconds: 'agent.limit.research_seconds',
  /** automations one user may own, and runs per automation per day */
  automationsPerUser: 'agent.limit.automations_per_user',
  automationRunsPerDay: 'agent.limit.automation_runs_per_day',
} as const

export const AGENT_CHART_KINDS = ['bar', 'line', 'pie', 'table'] as const
/** At most 12 series × 200 points, plain values only. */
export const agentChartSpec = z.object({
  kind: z.enum(AGENT_CHART_KINDS),
  title: z.string().max(120),
  /** category labels (x axis, pie slices or table columns for `table`) */
  categories: z.array(z.string().max(80)).max(200),
  series: z
    .array(
      z.object({
        name: z.string().max(80),
        data: z.array(z.union([z.number(), z.string().max(200), z.null()])).max(200),
      }),
    )
    .min(1)
    .max(12),
  unit: z.string().max(20).optional(),
})
export type AgentChartSpec = z.infer<typeof agentChartSpec>

export const agentProfileVo = z.object({
  id: z.number().int(),
  scope: z.enum(['tenant', 'user']),
  name: z.string(),
  providerId: z.number().int().nullable(),
  model: z.string().nullable(),
  reasoning: z.enum(AGENT_REASONING).nullable(),
  approvalMode: z.enum(AGENT_APPROVAL_MODES),
  tools: z.array(z.string()).nullable(),
  instructions: z.string().nullable(),
  isDefault: z.boolean(),
  editable: z.boolean(),
})
export type AgentProfileVo = z.infer<typeof agentProfileVo>

export const agentProfileSave = z
  .object({
    scope: z.enum(['tenant', 'user']).default('user'),
    name: z.string().trim().min(1).max(64),
    providerId: z.number().int().positive().nullable().default(null),
    model: z.string().max(128).nullable().default(null),
    reasoning: z.enum(AGENT_REASONING).nullable().default(null),
    approvalMode: z.enum(AGENT_APPROVAL_MODES).default('ask'),
    tools: z.array(z.string().max(160)).max(100).nullable().default(null),
    instructions: z.string().max(AGENT_SKILL_BODY_MAX).nullable().default(null),
    isDefault: z.boolean().default(false),
  })
  .register(fieldDomains, { domain: 'agent.profile' })
export type AgentProfileSave = z.infer<typeof agentProfileSave>

export const agentMemoryVo = z.object({
  id: z.number().int(),
  content: z.string(),
  source: z.enum(['chat', 'extract', 'manual']),
  sourceThreadId: z.number().int().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AgentMemoryVo = z.infer<typeof agentMemoryVo>

export const agentMemoryQuery = pageQuery(['createdAt', 'lastUsedAt']).extend({
  keyword: z.string().trim().max(100).optional(),
})
export const agentMemorySave = z
  .object({ content: z.string().trim().min(1).max(1000) })
  .register(fieldDomains, { domain: 'agent.memory' })
export type AgentMemorySave = z.infer<typeof agentMemorySave>
export const agentMemoryForgetAll = z
  .object({ currentPassword: z.string().min(1).max(128) })
  .register(fieldDomains, { domain: 'agent.memory' })

export const AGENT_AUTOMATION_TRIGGERS = ['schedule', 'event', 'manual'] as const
export const AGENT_AUTOMATION_WRITE_MODES = [
  'read_only',
  'ask',
  'pre_approved',
  'auto_review',
] as const
export const AGENT_AUTOMATION_RUN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'skipped',
] as const

/** An action-log action an event automation listens to (`domain` + `verb`, optionally the resource). */
export const agentAutomationEvent = z.object({
  domain: z.string().max(40),
  verb: z.string().max(40),
  resource: z.string().max(60).optional(),
})
export type AgentAutomationEvent = z.infer<typeof agentAutomationEvent>

export const agentAutomationVo = z.object({
  id: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  shared: z.boolean(),
  ownerName: z.string(),
  trigger: z.enum(AGENT_AUTOMATION_TRIGGERS),
  cron: z.string().nullable(),
  timezone: z.string().nullable(),
  event: agentAutomationEvent.nullable(),
  skill: z.string().nullable(),
  prompt: z.string().nullable(),
  profileId: z.number().int().nullable(),
  writeMode: z.enum(AGENT_AUTOMATION_WRITE_MODES),
  /** write tools the owner pre-approved (still valid) */
  preApproved: z.array(z.string()),
  /** pre-approved write tools that no longer hold (the facts they were given on changed): approve again */
  stalePreApproved: z.array(z.string()),
  notify: z.object({ inbox: z.boolean(), mail: z.boolean() }),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  editable: z.boolean(),
})
export type AgentAutomationVo = z.infer<typeof agentAutomationVo>

export const agentAutomationSave = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    shared: z.boolean().default(false),
    trigger: z.enum(AGENT_AUTOMATION_TRIGGERS),
    /** 5-field cron, at most once per 5 minutes; with `timezone` (IANA) */
    cron: z.string().trim().max(64).nullable().default(null),
    timezone: z.string().max(64).nullable().default(null),
    event: agentAutomationEvent.nullable().default(null),
    /** a skill, a prompt, or both (the prompt then goes with the skill) */
    skill: z.string().regex(AGENT_SKILL_NAME).nullable().default(null),
    prompt: z.string().trim().max(AGENT_MESSAGE_MAX).nullable().default(null),
    profileId: z.number().int().positive().nullable().default(null),
    writeMode: z.enum(AGENT_AUTOMATION_WRITE_MODES).default('read_only'),
    /** write tools to pre-approve (`pre_approved`); changing the list needs `currentPassword` */
    preApproved: z.array(z.string().max(160)).max(20).default([]),
    currentPassword: z.string().min(1).max(128).optional(),
    notify: z
      .object({ inbox: z.boolean().default(true), mail: z.boolean().default(false) })
      .default({ inbox: true, mail: false }),
  })
  .register(fieldDomains, { domain: 'agent.automation' })
export type AgentAutomationSave = z.infer<typeof agentAutomationSave>

export const agentAutomationRunVo = z.object({
  id: z.number().int(),
  automationId: z.number().int(),
  threadId: z.number().int().nullable(),
  trigger: z.enum(AGENT_AUTOMATION_TRIGGERS),
  status: z.enum(AGENT_AUTOMATION_RUN_STATUSES),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
})
export type AgentAutomationRunVo = z.infer<typeof agentAutomationRunVo>

export const agentAutomationEventVo = agentAutomationEvent.extend({ label: z.string() })
export type AgentAutomationEventVo = z.infer<typeof agentAutomationEventVo>

/** Where agent notices go besides the inbox (which always gets them; the mobile app reads the inbox). */
export const agentNotifySettings = z
  .object({
    turnDone: z.object({ mail: z.boolean() }),
    waiting: z.object({ mail: z.boolean() }),
    automation: z.object({ mail: z.boolean() }),
  })
  .register(fieldDomains, { domain: 'agent.notify' })
export type AgentNotifySettings = z.infer<typeof agentNotifySettings>

export const agentDiagnosticsVo = z.object({
  providers: z.array(
    z.object({ id: z.number().int(), name: z.string(), enabled: z.boolean(), hasKey: z.boolean() }),
  ),
  search: z.array(z.object({ id: z.number().int(), name: z.string(), enabled: z.boolean() })),
  mcpServers: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      lastError: z.string().nullable(),
    }),
  ),
  queue: z.object({
    waiting: z.number().int(),
    active: z.number().int(),
    failed: z.number().int(),
    delayed: z.number().int(),
  }),
  turns: z.object({
    running: z.number().int(),
    waiting: z.number().int(),
    failedToday: z.number().int(),
  }),
  recentFailures: z.array(
    z.object({
      turnId: z.number().int(),
      tenantId: z.number().int(),
      code: z.string(),
      message: z.string(),
      at: z.string(),
    }),
  ),
  sweeps: z.object({
    lastAt: z.string().nullable(),
    requeued: z.number().int(),
    failed: z.number().int(),
  }),
})
export type AgentDiagnosticsVo = z.infer<typeof agentDiagnosticsVo>

// ---- automations: tools to pre-approve, schedule presets, run reasons ----
/*
 * - `GET /api/agent/automation-tools` → `AgentAutomationToolVo[]` (`agent.automation.use`): the system write
 *   tools the caller may pre-approve for an automation now (reachable, switched on, policy not `deny`).
 * - `GET /api/agent/automations/:id/runs`: only the automation's owner (others 404); a shared automation is
 *   listed for everyone of the tenant holding `agent.automation.use`, `editable` only for its owner, and only
 *   the owner may run, switch, change or delete it.
 */

/** A scheduled automation fires at most this often (minutes). */
export const AGENT_AUTOMATION_MIN_INTERVAL_MIN = 5

/** Schedule presets the page offers (5-field cron; label `agent.automation.preset.<id>`). */
export const AGENT_AUTOMATION_CRON_PRESETS = [
  { id: 'every30m', cron: '*/30 * * * *' },
  { id: 'hourly', cron: '0 * * * *' },
  { id: 'daily9', cron: '0 9 * * *' },
  { id: 'weekdays9', cron: '0 9 * * 1-5' },
  { id: 'monday9', cron: '0 9 * * 1' },
  { id: 'monthly1', cron: '0 9 1 * *' },
] as const

/** Why a run was skipped or failed before or outside its turn (`AgentAutomationRunVo.error`). */
export const AGENT_AUTOMATION_RUN_ERRORS = [
  'paused',
  'owner_inactive',
  'owner_forbidden',
  'daily_limit',
  'not_configured',
  'thread_gone',
  'turn_failed',
  'mode_unavailable',
  /** a note on a run that did run: its profile was gone, so it ran with the defaults */
  'profile_missing',
  /** the automation's previous run had not ended yet (running or waiting for a person) */
  'overlap',
] as const

export const agentAutomationToolVo = z.object({ name: z.string(), title: z.string() })
export type AgentAutomationToolVo = z.infer<typeof agentAutomationToolVo>

// ---- subagents, research, outputs ----

/**
 * The platform skill that runs a turn in research mode (higher step and time limits, `AGENT2_PARAMS`); its
 * description is the seed key `seed.agentSkill.deepResearch` (each language in seed.json).
 */
export const AGENT_RESEARCH_SKILL = 'deep-research'

/** `GET /api/agent/items/:itemId/xlsx?<agentXlsxQuery>`: `table` picks a report's Markdown table (0-based). */
export const agentXlsxQuery = z.object({ table: z.coerce.number().int().min(0).max(99).optional() })
export type AgentXlsxQuery = z.infer<typeof agentXlsxQuery>

const MD_FENCE = /^\s*`{3}/
const MD_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const mdCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

/**
 * The GFM tables of a Markdown text, by the chat page's rules (a header line with `|`, a delimiter line,
 * rows up to the first blank line or line without `|`; code blocks skipped): each as rows of cell texts,
 * the header first, every row as wide as the header. A report's table `n` is exported by this index.
 */
export function markdownTables(text: string): string[][][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[][][] = []
  for (let i = 0; i < lines.length; i++) {
    if (MD_FENCE.test(lines[i]!)) {
      for (i++; i < lines.length && !MD_FENCE.test(lines[i]!); i++);
      continue
    }
    const next = lines[i + 1] ?? ''
    if (!lines[i]!.includes('|') || !MD_TABLE_SEP.test(next) || !next.includes('-')) continue
    const head = mdCells(lines[i]!)
    const rows = [head]
    for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) {
      const r = mdCells(lines[i]!)
      rows.push(head.map((_, k) => r[k] ?? ''))
    }
    i--
    out.push(rows)
  }
  return out
}
