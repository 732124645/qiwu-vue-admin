# Changelog

中文说明：本文件按功能区域汇总栖梧 / Qiwu 的用户可见变化，正文使用英文。`1.0.0` 于 2026-10-05 发布，`1.0.3` 于 2026-10-06 发布（`1.0.1`、`1.0.2` 未发布，内容并入 `1.0.3`），`1.1.0`（多租户）、`1.2.0`（手写 SQL 的数据权限）、`1.2.1`（修复）与 `1.3.0`（任务队列）于 2026-10-14 发布，`1.3.1`（开发调试开关）与 `1.4.0`（安全审查修复）于 2026-10-15 发布，`1.4.1`（界面细节）、`1.5.0`（微信公众号管理，默认关闭）与 `1.6.0`（MCP 智能体接入，默认关闭；下游合并改进）于 2026-10-20 发布，`1.6.1`（后端连不上时停在原页面等待；README 更新）与 `1.7.0`（AI 编程友好：公开开发规则、任务配方、检查报错带修复提示、项目地图）于 2026-10-21 发布，`1.7.1`（列表操作列不再截断误点）、`1.8.0`（后台智能助手，默认关闭）与 `1.9.0`（智能助手：自动化、记忆、配置方案、自动审查、子智能体与深度研究）于 2026-10-22 发布，`1.10.0`（基础办公申请）于 2026-10-23 发布，`1.11.0`（助手积分额度与断线恢复）与 `1.12.0`（助手桌面工作区、用量与设置页；积分升级修复）于 2026-10-27 发布，`1.13.0`（助手会话模式、自动审查与方案批准，对标常见编程智能体的交互）于 2026-10-28 发布，`1.13.1`（修复：MCP 关闭时配置方案的工具列表、Windows 与 Docker Redis 下的测试）同日发布，`1.14.0`（助手运行中插话、原地回退与重新生成、状态行、租户收紧工具策略）于 2026-10-29 发布，`1.14.1`（修复：已登录时打开登录页不再要求重新登录）与 `1.15.0`（运维：进程角色拆分、连接池设置、卡顿诊断、模型提供方并发上限、配置可见性）于 2026-10-30 发布。

All notable product changes are recorded here in Keep a Changelog style. The initial release below summarizes the delivered features. Planned work is identified explicitly.

## [1.15.0] - 2026-10-30

### Added

- Process roles: `APP_ROLE=all|api|worker` (default `all`, as before). An `api` process serves HTTP and Socket.IO but runs no cron, no misfire catch-up and no queue worker; "Run once" is handed to a worker through a queue. A `worker` process runs cron and every queue worker and still pushes to browsers through the Redis adapter. The PM2 template adds an optional worker app (`QW_PM2_WORKER_INSTANCES`, default 0 keeps the single app) and the deploy script health-checks it.
- Database pool settings: `DB_POOL_SIZE` (default 10), `DB_POOL_ACQUIRE_TIMEOUT_MS` and `DB_POOL_QUEUE_LIMIT` (default 0 = unlimited, as before). A request that cannot get a connection in time fails with 503 "The service is busy" instead of waiting for the browser's timeout.
- Stall diagnostics: the server monitor shows event-loop delay (p50/p99/max) and utilization of the answering instance; `LOG_SLOW_REQUEST_MS` marks slow requests with `"slow":true` and the scheduled tasks running in that process; `LOG_EVENT_LOOP_INTERVAL_MS` / `LOG_EVENT_LOOP_WARN_MS` log event-loop delay periodically; the run log records the executing instance and the event-loop maximum during each run. All off by default.
- Model provider concurrency limit: a provider can set the maximum number of simultaneous calls across all instances and tenants (turn steps, subtasks, review, memory, titles, skills). Calls over the limit wait for a slot (stop, pause and the turn deadline still end the wait) and fail as "The model is busy" after 120 s; calls that never got a slot are not billed.
- Startup visibility: a warning lists keys set to different values in both `.env` and `.env.local` (names only; `.env` wins), and an `effective config` line logs the non-secret settings in effect (`EFFECTIVE_CONFIG_KEYS`, extendable).

### Changed

- Deploy guide: every `pm2` command is shown as the application user (`sudo -u qiwu -H pm2 …`) with a hint for "Process or Namespace not found"; the nginx example enables HTTP/2; a capacity note relates PM2 instances, pool size and MySQL `max_connections`.

### Upgrade notes

- Run migrations (two nullable columns: `job_run.instance` / `job_run.loop_max_ms`, `agent_provider.max_concurrency`). Nothing changes until the new settings are used. The queue monitor lists a new `scheduler-run` queue. See docs/upgrade.md before splitting processes with PM2.

## [1.14.1] - 2026-10-30

### Fixed

- Opening the sign-in page while still signed in (a bookmark, a link, the back button or a new tab) no longer asks for the password again: it goes straight to the page asked for, or home. A locked screen, a session that has ended and a session that failed to load still show the sign-in form.

## [1.14.0] - 2026-10-29

### Added

- In-place rewind: "Edit from here" on any sent message removes it and everything after it from the conversation and puts its text, attachments and skill back in the composer; "Regenerate" redoes the last turn; "Revert last turn" only removes. A confirmation lists the writes in the removed part that stay done or whose outcome is unknown (subtasks included); writes, extracted memories, mode changes and used credits are never undone. Another window's newer items make the request fail instead of removing what this page has not seen. Forking stays a separate action.
- Tenant tool restrictions: tenant admins can set a tool to human-only or disabled for their tenant ("Skills → Tool restrictions"); the stricter of the platform and the tenant setting applies, a tenant can never loosen one, and changes apply at the next call. They apply to the in-app assistant, not to personal-access-token MCP clients.
- A status line under the composer: mode, context use (the provider's reported input when available), credits this turn and today, and the number of tools allowed for the conversation. `/status` also lists the model, profile, allowed tools and, with reasons, the tools that ask and the tools that are unavailable.
- Approval cards say why they ask (needs confirmation, platform human-only, tenant restriction, read tool set to ask, personal confirmation); blocked cards distinguish permission, mode, platform policy, tenant restriction and skill/profile tool lists.

### Changed

- Enter while a turn runs steers it: the message reaches the same turn as soon as the current tool call ends, and later calls of that step that would ask or write are rejected with the message as the note. "Queue for next turn" (Alt+Enter) only queues, also while cards wait.
- Stop (Esc or the button) works with text in the composer and keeps the draft; queued messages are withdrawn and put back in the composer instead of starting.
- Queued or expired messages that never ran are no longer sent to the model or the review model.

### Upgrade notes

- Run migrations and seeds (new tenant table `agent_tool_restriction`; the two new actions are added once to packages that already hold the skills page). See docs/upgrade.md for the API changes: cancel response, rewind routes, `rewound` event, card reason codes and `/status` fields.

## [1.13.1] - 2026-10-28

### Fixed

- The assistant's profile form loads its tool choices from the assistant itself, so it works with MCP access turned off, and it lists built-in and external MCP tools as well as the caller's own tools.
- Migration fence tests write their temporary specs inside the server directory, so they also run on Windows.
- Tests that wait for the duplicate-submit window now wait until the keys are actually gone instead of sleeping for a fixed time, which was not enough on Docker Desktop Redis.
- MCP tool-call arguments are masked in HTTP request traces, so private business content passed to tools is not kept in the trace log.

## [1.13.0] - 2026-10-28

### Added

- Model services can list the provider's models (`GET {baseUrl}/models`) and add them from a searchable picker instead of typing identifiers. A stored key is only sent to the stored address, redirects are not followed and the response is capped. Root only.
- Plan cards: in plan mode the assistant explores read-only, asks structured questions when needed and ends with a plan (steps, expected data changes, assumptions). The person approves it with auto-review or step-by-step confirmation, or asks for changes; only the person leaves plan mode.
- "Don't ask again for this tool in this conversation" on approval cards, listed in the conversation settings and revocable one by one. It is re-checked against the current policy when recorded and before every use. Tools that need personal confirmation, tools set to human-only and external MCP tools never offer it.

### Changed

- One conversation mode replaces the approval dropdown, the plan switch and the trust mode: read only, plan, ask every time (default) and auto-review. Shift+Tab in the composer cycles through the available modes.
- Auto-review takes effect as soon as it is selected: every write that needs confirmation goes to the review model first, without per-tool opt-in. A review rejection stops for the person with the reviewer's reason instead of being returned to the model.
- Tool policies are `auto`, `ask`, `human` and `deny`. `human` (only a person confirms) is never reviewed or allowed for the conversation and is recommended for deleting, bulk changes, sending outside the system and money. Read tools run without asking unless root explicitly sets them to `ask`.
- Approval cards offer Allow once, Don't ask again for this tool (when available) and Reject with a note. Sending a message while cards wait rejects them, and the other calls of that step that would ask, with the message as the note, and the assistant continues at once. In auto-review mode a card says why a call was not reviewed.

### Removed

- The trust mode and the `agent.trust_mode` parameter. The per-tool `review` policy (now the same as `ask`).

### Upgrade notes

- Run migrations and seeds. Conversations in plan mode keep it; trust-mode conversations become ask-every-time and their per-record trust is cleared; `review` policies become `ask`; the trust parameter is removed. Before enabling auto-review, root should set tools that delete, change many records, send outside the system or move money to `human`.

## [1.12.0] - 2026-10-27

### Changed

- The assistant chat is a desktop workspace: the conversation list and side panel can be resized by dragging or with the keyboard (widths are kept per user and browser; double-click restores the default), and the list folds to a rail. The work panel and subtask details open in the main area, focus mode covers the application shell, and the header keeps three labelled buttons with the remaining options in a conversation settings popover and an actions menu. Message actions appear in one row on hover or focus, answers use a centred reading column and the composer shows its shortcuts on a hint line with plan mode as a switch.
- The usage page leads with key figures, shows credits with two decimals and thousands separators, lists business columns by default, explains data completeness only when it applies and draws a per-day chart with units and an empty state.
- The assistant settings open with a getting-started guide (model, web search, tool approval, first conversation) and order their tabs by setup step with plainer names.

### Fixed

- Models without credit rates keep working after an upgrade: their calls are recorded as unpriced and are neither charged nor limited. A priced model is always charged: unknown usage is estimated from the request and the streamed output, and reported usage without cache details or with inconsistent totals is charged conservatively. The usage page lists unpriced and estimated calls separately, and the settings page says when no credit limit is configured.
- A provider that rejects turning reasoning off returns a dedicated error instead of a generic upstream failure.
- The development server builds into its own output directory, so a production build no longer breaks a running `pnpm dev`; it retries once when the backend exits before it is ready.
- Server tests bind their temporary listeners to the loopback address and start every spec file with empty rate-limit buckets, so unrelated local services and earlier files no longer cause sporadic 401, 404 or 429 answers.

### Upgrade notes

- No new migrations. Existing models without rates resume working after the upgrade; configure rates and budgets where credits should apply. Add `dist-dev/` to the ignore list of a project derived from an older template.

## [1.11.0] - 2026-10-27

### Added

- Per-model credit rates for ordinary input, output, cache reads and cache writes, with separate per-turn, user-daily and tenant-daily budgets. Zero explicitly means unlimited. Usage retains provider, exact model identifier, input/output/cache/reasoning details and the original rate snapshot; missing usage stays unknown. Pending, completed and interrupted calls are distinguished in the ledger.
- Durable draft and message acceptance receipts. An uncertain response is checked by its stable identifier; reconnecting does not automatically resend the message. Saved streamed prefixes carry revisions and offsets so reconnects can fill gaps without duplicating text.
- Recovery barriers for uncertain writes and image generation, with an inbox entry even for short temporary tasks. The owner must check the actual effect before allowing future actions; active local work must end first. Affected automations stop and lose pre-approval. Existing queued messages and unknown operations are not automatically replayed.

### Changed

- The assistant opens from the floating button beside the current business page, with collapsible or expanded conversation space, readable subtask progress and a detail view. Existing conversation links remain available.
- Answers support richer safe Markdown, code copying and wrapping, raw-text viewing, expanded reading and Markdown download. Model-provided HTML remains text and remote images do not load automatically.
- Development rebuilds report changed files, elapsed time and restart results. Shared-package output is coordinated so a single change does not cause repeated backend restarts; failed compilation keeps the previous working server available. Locale edits preserve the current page.
- Graceful shutdown pauses new work and saves interrupted state before closing connections within a bounded wait. Forced process exits are detected through persistent invocation records and leases; reported usage and parent/subtask totals are settled once.

### Fixed

- Fully masked audit routes now suppress complete payloads, URL queries and free-form error text. Static data-scope checks also verify delegated locking paths and reject ambiguous service names.

- Restored page state and model selections survive asynchronous configuration loading without being replaced by late default options.
- Existing reported issues around development reloads and assistant controls are covered by the corresponding integration and page checks.

### Upgrade notes and limits

- Back up the database and keep Redis and `APP_SECRET`. Run migrations and seeds; never reset an existing database to upgrade. Configure rates for existing models before calling them; old Token budgets are retained only for history and are not converted to credits. Budgets check recorded spending before each call, so in-flight requests can cross a threshold.
- On the first upgrade from a release without recovery checkpoints, finish old tasks or manually reconcile their effects before stopping every old worker. Previously unsaved output and invocation starts cannot be reconstructed. Do not mix old workers with the new recovery barriers or roll back to code that ignores them.
- Recovery restores saved conversation and task state, not an upstream token stream. An interrupted model step may need regeneration and additional actual upstream charges. Browser storage keeps isolated delivery identifiers, not message bodies; a full refresh does not preserve an unsent text draft. Non-idempotent external operations still require verification in the external system.
- The public distribution now contains basic office requests and the existing approval engine only. Native attendance and office-application assistant tools were present in v1.10.0 and its history is preserved; they are outside the current public distribution. Its upgrade migration disables their old menus, grants and retention jobs while preserving historical business rows. Existing users must review their own dependencies and retain backups before upgrading.

## [1.10.0] - 2026-10-23

### Added

- Office requests on the existing workflow engine: leave, travel, expense claims, seal use and a general dynamic form, with one desktop entry and the existing personal requests, to-dos, handled tasks and CC lists. Saving a fixed request, its attachments and starting approval share a transaction; approval outcomes write back to the business record in the same transaction.
- Travel requests with optional estimated cost; CNY expense claims with complete line items and exact server-calculated totals, optionally referencing the requester's approved travel; seal requests with document, purpose, copies and expected date. Approval does not represent payment or actual seal use.
- Complete mobile decision information for fixed office requests and authenticated private attachments, alongside the existing dynamic forms and approval actions. Failed decision data or attachment loading blocks approval; a concurrent action refreshes the task instead of replaying the write. Existing mobile leave submission and editing remain available; travel, expense and seal creation/editing use desktop.
- Native mobile clock-in/out independent of DingTalk and the workflow capability: server time and tenant workday timezone, durable duplicate protection, personal records, optional foreground office-site location checks, policy and site administration, department-scoped original records and daily activity summaries with approved leave/travel intervals. Historical department and policy snapshots are preserved; raw employee coordinates are not stored and are masked in request logs.
- Assistant tools for personal to-dos, visible requests, published forms and the five request types. Every new request requires the user's own individual confirmation of its full contents, process version, attachments and reviewers. Conversation trust, automatic review, automation pre-approval, bulk approval and direct MCP/PAT cannot replace this click. Facts and effective permissions are rechecked under transaction locks before the original submission service runs.

### Changed

- Private office and workflow attachments require business and field access even for uploaders or global file administrators. Global file lists omit these attachments and cannot delete bound files. Mobile content uses a bounded same-origin endpoint without object-store redirects carrying the session token.
- Leave validates ordered times and positive bounded declared duration while keeping its existing API, data and published process configuration. New travel, expense, seal and general models are initialized only when missing, using the tenant's protected administrator role with explicit self-review and no silent missing-reviewer approval.
- The mobile workbench waits for known account features before querying approval counts, and discards old-account responses. Office tool names and purposes follow the existing localized tool presentation.

### Upgrade notes and limits

- Run migrations and the idempotent seeds before using the new pages; never reset an existing database to upgrade. First installation adds normal office-request and personal attendance access to the staff/member roles, without attendance or workflow management permissions. Later administrator changes, revoked links and disabled/deleted models remain intact.
- Leave keeps its original sample process, including its existing missing-approver and self-approval settings; review these before business use. Initial native attendance is enabled in Asia/Shanghai with no location check and 180-day retention. Site mode uses WGS84 coordinates and needs deployment-specific foreground location permissions.
- Daily summaries count active user/recorded-department pairs, not a complete employee roster. No absence, lateness, working-time or payroll judgement is inferred. Overnight or multiple shifts, scheduling, holidays, leave balances, corrections, offline clock uploads, hardware fraud protection and DingTalk integration are outside this release.
- H5 automation and app/mini-program builds were verified. Real app/mini-program location authorization and on-site clock-in/out remain unverified; successful builds are not device acceptance. SMTP and object-storage delivery also need acceptance in the deployment environment.

## [1.9.1] - 2026-10-22

### Fixed

- MCP and assistant tools show localized names, purposes and permission labels, with stable protocol identifiers kept as secondary information. Known system tools have Chinese descriptions; external tools retain the provider's text.
- Assistant configuration forms use aligned labels and responsive layouts. Profile tools can be selected from the user's available tools instead of requiring manually entered identifiers. Existing selections remain intact when tools cannot be loaded.
- Tool policies, token scopes, approval cards and automation tool choices share readable tool names. Tool availability is shown for every source, and known connection failures have translated explanations.

- Restored page tabs refresh their titles, icons and cache names from the currently authorized routes. Assistant tab headers and configuration content have consistent spacing, and the personal skills tab is labeled separately from platform skills.

## [1.9.0] - 2026-10-22

### Added

- Assistant automations (`agent.automation.use`; shared ones `agent.automation.share`): a skill or a prompt that runs on a 5-field schedule with a time zone (at most every 5 minutes), after a business action is logged (when the creator can see the record), or on demand, in a hidden conversation as its creator, re-checked on every run. Write modes: read only (default), ask (the cards wait in the inbox) and pre-approved write tools chosen one by one with the current password; a pre-approval holds only while the creator's permission, data scope, department, the tool's switch and the bound personal or platform skill and personal profile are unchanged, otherwise the write waits for a person. Run history, results in the inbox and optional mail; limits per user and per day; one run at a time per automation.
- Profiles: named sets of model, reasoning, approval mode, allowed tools and extra instructions, personal or tenant-wide (tenant-wide ones only read-only or ask), picked for a new conversation or as the default.
- Personal memory: “remember …” saves after the user confirms, an optional background distiller reads only the user's own messages; masked before saving, never in temporary conversations, off per conversation; list, edit, delete and forget all (current password).
- Automatic review: a write tool set to `review` and a conversation in auto-review mode let a review model (root parameter `agent.review.model`) approve, reject or hand over each write; anything unclear, truncated or failed goes to a person; at most 10 reviews per turn.
- Sub-agents (`agent.delegate`, 1–3 read-only tasks in parallel), a deep research platform skill with its own step and time limits and a cited report, charts (bar, line, pie, table), image generation for models marked `image`, and xlsx, Markdown and print exports.
- Diagnostics page (root): model, search and external MCP connectivity tests, turn counts, recent failures and orphan sweeps. Personal notification settings (inbox always, mail optional), custom chat shortcuts and opening a conversation in a new window.
- For projects: extension points for built-in tools, context contributors and approval reviewers; recipe `docs/ai/recipes/agent-extension.md` with its skill `qiwu-agent-extension`.

### Changed

- Agent notices no longer carry the conversation title; older inbox templates show the conversation number instead.
- Memory and message bodies are masked in the action log.

## [1.8.0] - 2026-10-22

### Added

- An in-app assistant (智能助手), off by default: set `APP_AGENT=true` in the server environment to load it (restart required; see `docs/agent.md`). Off, every `/api/agent/*` route answers 404 and the 智能体 menu group is hidden. It works on the existing job queue, Redis and Socket.IO; no new service is needed.
  - A chat page like a desktop chat app: a thread list (search, rename, pin, archive, delete, unread and in-progress views, temporary threads), streamed Markdown answers with collapsible tool calls, a reasoning summary, citations and follow-up suggestions; fork from any message, edit and resend, revert the last turn, share a read-only link within the tenant, export Markdown, copy and rate messages. While a turn runs a new message joins it after the current step or waits for the next turn; the turn can be stopped. Slash commands `/new`, `/compact`, `/model`, `/approvals`, `/plan`, `/skills`, `/prompts`, `/mcp`, `/status`, `/clear`; `$name` calls a skill; attachments from the file storage (text, the first sheet of an xlsx, images for vision models); a context gauge with automatic and manual compaction; an inbox notice when a turn waits for you or a long one finishes. A button in the corner of every page opens the chat with the current page and the selected rows.
  - The agent acts only through tools: the `@McpTool` methods of the modules (the same registry and guards as MCP), run in-process as the signed-in user with that user's permissions, data scope and tenant, plus built-in tools for a plan checklist (`plan.update`), questions with options (`ask.user`) and loading a skill. Approval modes per thread: read-only, ask (default) and trust this thread. A write tool never runs before a person confirms it: the approval card shows the tool, the record, each field's current and proposed value and the web sources the turn read. A plan mode lists the steps before anything changes.
  - Models through any OpenAI-compatible Chat Completions API (DeepSeek, Qwen, Kimi, Zhipu, Ollama, OpenAI…) with streaming, tool calls and reasoning effort; per-thread model choice. Web search through Bocha or Tavily and a page reader restricted to the turn's search results, the user's links and allowed domains, with public-address checks on every redirect; web pages and external output are handed to the model as untrusted content. External MCP servers over Streamable HTTP (header token or OAuth client credentials), their tools enabled one by one with an approval policy each, and form requests shown as a question card.
  - Skills at platform, tenant and personal scope (create, edit, enable, import and export as `SKILL.md`, drafted from a thread), loaded only when used; platform, tenant and personal instructions with a tone preset; prompt templates.
  - Platform settings (root): model providers, search providers, external MCP servers, tool policies (write tools only ask or deny), platform skills, instructions and limits — steps, time and tokens per turn, tokens per user and per tenant per day, concurrent turns per user — and the emergency stop `agent.paused`. Keys are sealed with a key derived from `APP_SECRET` and never returned. A usage page sums calls and tokens by day, user or model. Every tool call is in the action log.
  - Batch runs: run a skill on the rows selected in a list, one thread per record within the concurrency limit, and confirm the resulting changes one by one or all at once on a batch review page. Sample: 示例客户 with the platform skill 补齐客户信息 (fill in empty fields from the web, with sources) and the tools `demo.customer.search`, `demo.customer.get` and `demo.customer.update`.
  - For projects: write tools may declare a `preview` method for the approval card, `@AgentBatchTarget` makes a list's records batchable; a new recipe `docs/ai/recipes/agent-skill.md` with its skill `qiwu-agent-skill`.

## [1.7.1] - 2026-10-22

### Fixed

- List actions no longer clip into an ellipsis that silently clicked a hidden button: only the first buttons show inline (page setting "表格行内操作按钮数", default 2; per table `actions-visible`), the rest open from a More menu on hover, danger buttons always come last, buttons the user lacks the permission for take no place, and the column width is measured from the rendered buttons (an explicit `actions-width` still wins). Pages dropped their hand-tuned widths; the generated tree page no longer hard-codes one.

## [1.7.0] - 2026-10-21

### Added

- AI-assisted development (`docs/ai.md`): the repository now ships its development rules for AI coding tools and for people.
  - An agent rules file at the repository root: the conventions a project built on the template follows — layout and layering, naming, API, i18n, multi-tenancy and data scope, security defaults, the CRUD kit, migrations and seeds, generator first, tests and the definition of done, commands, and what each gate failure means — with entry points for the common coding tools (listed in `docs/ai.md`). A project keeps its own rules in `docs/project-rules.md` (not shipped, so template upgrades never conflict with it).
  - Step-by-step recipes in `docs/ai/recipes/` with their check commands: a new module through the generator, tables and migrations, permissions and menus, dicts and system parameters, data scope, tenant-aware SQL, queue and scheduled jobs, MCP tools, i18n strings and API tests; a matching skill for each recipe (`qiwu-*`).
  - `pnpm ai:map` writes `docs/ai/project-map.md` — modules and feature switches, tables, every API route with its permission and markers, permission codes, menus, dicts, system parameters, jobs and MCP tools — from a static parse of the code; `pnpm verify` fails when it is stale.
- Every failure of the arch checks, `i18n:check`, `originality:check` and `license:check` now ends with a `fix:` line (what to change) and a `see:` link to the doc that explains the rule; a check without a valid hint fails. A new arch check, `ai-docs`, keeps the scripts, paths, links and anchors named in the AI docs real (mentions of a removed mobile client or sample domain are allowed).

## [1.6.1] - 2026-10-21

### Changed

- When the API does not answer while the admin loads (a page refresh or a new tab during a restart, a deploy or a stopped server), the address stays on the requested page and a "connecting" screen waits until the server is back, then opens the page by itself; it no longer gives up after about 20 s for a separate 503 page with retry and sign-in buttons. The load's failures no longer show as error toasts; an API that answers with its own server error for about 20 s still leads to the sign-in page.
- README: a feature overview (multi-tenancy, WeChat Official Accounts, MCP, mobile client), screenshots and links to the queue, MCP and upgrade guides.

## [1.6.0] - 2026-10-20

### Added

- Agent access over MCP (Model Context Protocol), off by default: set `APP_MCP=true` in the server environment to load it (restart required; see `docs/mcp.md`). Off, `/api/mcp`, its discovery documents and every admin route answer 404 and the two pages are hidden.
  - A stateless Streamable HTTP endpoint `POST /api/mcp` (official SDK) serving `initialize`, `tools/list` and `tools/call`; tools are provider methods marked `@McpTool` (unique names, a shared permission code, zod input and optional output schemas), found at start-up.
  - Two ways in, both running as the token's user with that user's permissions, data scope and tenant: personal access tokens (made in the personal center with the current password, shown once, stored as a digest, expiry up to 90 days, allowed tools and an explicit write permission, revocable; they end for good when the user is disabled, deleted, changes or resets the password, is signed out by an administrator, or the tenant is disabled) and OAuth2 tokens of a registered client with the new scopes `mcp` / `mcp.write` (RFC 8707 resource indicator checked; protected resource and authorization server metadata at `/.well-known/`).
  - Guards for every call: the root-only emergency stop `mcp.paused`, a per-token rate limit, the platform's per-tool switch, the token's tool list and write permission, the tool's permission, argument validation, a time limit, masking of secret-named fields and a 64 KiB answer limit; one action log row per call (`mcp.tool` / `call`, marked as made by an agent, with the token and an argument digest).
  - Sample tools: `iam.me.get`, `iam.user.search` (the user list's data scope), `cfg.dict.options` and the write tool `demo.book.create`; `docs/mcp.md` shows how to add your own.

### Changed

- Projects built from the template merge new template releases with fewer conflicts: the template's server tests no longer hard-code the template's own structure (the migration list is read from `src/db/migrations`, table and column counts became rules), and a project registers its own platform tables and global unique keys in `apps/server/src/db/project-tables.ts` instead of editing the template's list. A new guide, `docs/upgrade.md`, walks through taking a template release into a project.
- Faster and clearer server tests: the migration round trip runs in one process (about twice as fast, more with many migrations); script timeouts are configurable with `QW_TEST_SCRIPT_TIMEOUT_MS` and a killed script fails at once with its name and time; `QW_TEST_REUSE_DB=1` reuses the test database locally while migrations, seeds and schema switches are unchanged (`pnpm ci:local` and CI always rebuild it).
- A new check refuses migration files with duplicate or malformed timestamps; use the real current time, seconds included, for new migrations.

### Upgrade notes

- The token and tool switch tables are created by the migrations whether or not the module is switched on. A reverse proxy that blocks dot paths must forward `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` to the server for OAuth2 clients (`docs/deploy.md`).

## [1.5.0] - 2026-10-20

### Added

- WeChat Official Account management, off by default: set `APP_WXOA=true` in the server environment to load it (restart required; see `docs/wxoa.md`). Off, the module is not loaded at all: every `/api/wxoa/*` route including the push callback answers 404, no job, token refresh or call to WeChat runs, and its menus are hidden from the side menu and role grants.
  - Access and interaction: several accounts per tenant with write-only secrets, the push callback (plain, compatible and safe mode, signature and replay checks), message history and conversations with service replies, auto replies including QR-scan replies, custom and conditional menus with a phone preview, fans, tags and blacklist with Excel export, permanent media, template messages and channel QR codes with automatic tagging. Verified on a WeChat test account.
  - Content and operations (WeChat requires a verified service account; verified so far against a simulated WeChat gateway only): article drafts, publishing and publish records, mass sends with retry inside WeChat's 24-hour de-duplication window, statistics charts, article comments and subscribe notices.
  - Multi-tenancy aware: each tenant manages its own accounts; one AppID can be connected to one tenant only (with multi-tenancy on, adding an account first proves the AppSecret); jobs run per active tenant; platform staff can look up which tenant holds an AppID.
- Server test runs refuse an unregistered database / Redis pair and hold a per-database run lock, so two checkouts can no longer wipe each other's test sessions.

### Upgrade notes

- The official account tables are created by the migrations whether or not the module is switched on; they stay empty while it is off.

## [1.4.1] - 2026-10-20

### Changed

- Dialog footers are a full-width band at the bottom of the dialog (light surface, top divider) with consistently spaced buttons that wrap on narrow screens; dialog padding is set through CSS variables.
- Tables show their real header row above the loading placeholders on first load; the loading text is kept for screen readers only.

## [1.4.0] - 2026-10-15

### Security

- Resetting another user's password, or setting their sign-in mobile, now needs the right to grant every role that user holds, like assigning those roles; otherwise 403 `B1001` with the message `iam.takeover_exceeds_own` (a user administrator could take over a better-privileged account). A tenant administrator is judged only on the permissions it holds and the platform-only ones, so permissions of disabled or out-of-package menus a role keeps do not block it. Helpdesk-style roles with only `iam.user.reset-password` can no longer reset users whose roles carry permissions or a data scope they lack.
- Moving a department is judged as a grant: the subtree must fit the caller's scope for every permission of the dept-subtree roles held above its new place (403 `iam.grant_exceeds_own`).
- Password and SMS sign-in refuse a foreign or `null` `Origin` (403 `auth.origin_rejected`), so another site can no longer plant its own session in the console (login CSRF). Requests without `Origin` (apps, scripts) and mobile sign-ins are unchanged. Upgrade note: behind a reverse proxy, `Host` and the scheme must reach the server as the browser sent them (or the console's origin be listed in `CORS_ORIGIN`), as the refresh already required; otherwise console sign-in answers 403 `A1007`.
- Sign-in usernames must use the stored syntax (letters, digits, `_ . @ -`; fullwidth forms are folded first); other spellings get 400 instead of revealing whether an account exists. Upgrade note: accounts whose stored username does not match that syntax (for example imported by SQL with Chinese names) must be renamed before upgrading, their sign-in answers 400. Parallel password guesses now reach the password check at most the lock threshold times.
- Excel imports are rebuilt from the file's central directory and every part's real size is counted before parsing, so a file lying about its sizes is refused (400 `excel.invalid`) instead of exhausting memory.
- Dictionary and parameter reads ignore codes outside the stored syntax (no cache entry per spelling); a user keeps at most 200 saved list settings (409 `iam.pref_keys_limit`); presigned download URLs are masked in request logs; `audit.retention_days` is root-only; disabled users get no WeChat reminders.
- The mobile H5 dev server serves only the app and shared sources, without CORS, and only to its own pages (`docs/mobile.md`).

### Fixed

- `DATE` columns (e.g. a book's publication date) no longer come back a day early when the server process runs west of UTC.

## [1.3.1] - 2026-10-15

### Added

- Breakpoint debugging of the server in development: `QW_INSPECT=1 pnpm dev` (PowerShell: `$env:QW_INSPECT=1; pnpm.cmd dev`) opens the Node inspector on `127.0.0.1:9229` for the server app process only, with source maps; a port number instead of `1` picks another port. `.vscode/launch.json` adds a server attach configuration that reattaches after every restart, and Edge / Chrome launch configurations for the Vite dev server. See `docs/getting-started.md`.

## [1.3.0] - 2026-10-14

### Added

- Job queues on the existing Redis (BullMQ, no separate message broker): modules declare a queue with `registerQueue` and a processor extending `TenantJobProcessor`, and add jobs with `QueueService.add`, which records the caller's tenant; each job runs in that tenant, and a job without one fails at once without retries. Defaults: 3 attempts with exponential backoff, the last 1000 completed and 5000 failed jobs kept. Every instance runs the workers, which finish their running jobs on shutdown; start-up warns when Redis `maxmemory-policy` is not `noeviction`. See `docs/queue.md`.
- Queue monitor page (System monitor → Queue monitor, platform only, root only with multi-tenancy on): job counts and paused state per queue, jobs by state with masked data, retrying failed jobs and removing jobs (permissions `monitor.queue.browse` / `retry` / `remove`, action-logged).

## [1.2.1] - 2026-10-14

### Fixed

- The last sign-in time shown after signing in (`GET /api/auth/me` `lastSignInAt`) no longer depends on the application and database clocks agreeing: sign-in log rows are timestamped by the application. Sessions started before the upgrade show the corrected time after their next sign-in.
- Three server tests no longer fail on Windows or on hosts whose clock is off the database's.

## [1.2.0] - 2026-10-14

### Added

- Data scope for hand-written SQL: `dataScopeSql(alias, columns)` / `dataScopeSqlFor(entity, alias)` return the same department/owner condition as the ORM path, as a parameterized `{ sql, params }` for raw queries. A new `pnpm verify` check reports raw SQL (and QueryBuilder table-name joins) on a data-scoped table that neither uses it nor states `qw:no-data-scope <reason>`. See `docs/data-scope.md`.

## [1.1.0] - 2026-10-14

Multi-tenancy: one deployment serves several companies from one MySQL database (a shared schema with a `tenant_id` column). It is off by default; with the switch off the system behaves as `1.0.x` and all data belongs to the built-in default tenant. See `docs/multi-tenancy.md`.

### Added

- Tenancy switch `APP_MULTI_TENANT` (server environment, read at start-up, default `false`); there is no runtime toggle, and a change is complete only after every instance has restarted.
- Data isolation: every tenant-owned row carries `tenant_id`; the ORM adds the tenant condition to reads and writes, raw SQL states its own, and static plus test-time checks reject raw SQL on tenant tables without it.
- Tenant management (a platform page): create a tenant in one step (root department, built-in `tenant_admin` role, workflow templates and an owner account with a one-time initial password), expiry date, user quota, several host names, brand name and logo, enable/disable and initial-password reset. Disabling or expiring a tenant ends its sessions at once; its data stays.
- Tenant packages: the menus a tenant may use, enforced on the server (permissions = role grants ∩ package). Routes of a feature group outside the package answer 404, and `GET /api/auth/me` lists the available `features`.
- Sign-in by bound host name or tenant code on web, H5, App and mini program; unknown, disabled and existing codes get identical responses. Lockout, SMS codes, password resets, OAuth consent and WeChat bindings are per tenant.
- Platform staff with `iam.tenant.enter` can enter a tenant for support with a required reason: a permanent banner, a two-hour limit, stale tabs reloaded through the `X-Tenant-Expect` header, and audit records for entering, leaving and every request made inside.
- Platform pages (menus, dictionaries, parameters, storage, templates, code generation, jobs, monitoring and more) belong to the default tenant; with the switch on, the API trace, API fault and cache list pages are limited to the platform root. Operation and sign-in logs show the actor's tenant.
- Code generator: tenant columns, `@TenantColumn()` and cross-tenant 404 cases in the generated end-to-end tests. `docs/multi-tenancy.md` explains how to write tenant-aware project code.
- Demo data: sample tenants with their own packages and brands, created only when both `APP_DEMO_MODE` and `APP_MULTI_TENANT` are on.

### Changed

- New tables are tenant tables by default. A platform table is registered in `PLATFORM_TABLES`, a globally unique key in `GLOBAL_UNIQUE` (`apps/server/src/core/db/tenant-tables.ts`).

### Upgrade notes

- This release's migrations only add columns and indexes and stay compatible with the previous code: upgrading with the switch off needs no downtime and can be rolled back.
- New installs may start with the switch on. An existing database is switched on in two deployments: first upgrade to `1.1.0` with the switch off and confirm it is healthy; then turn the switch on and deploy again. `db:migrate` then removes the default of the tenant columns (or run `tenancy-harden`); the server refuses to start with the switch on before that. Review the default tenant's roles that hold platform menus first. See `docs/deploy.md`.
- A database that has run with the switch on cannot go back to any version before `1.1.0`, including patch versions released from the `1.0` line.
- Tenants are never deleted, only disabled or expired. Before switching off, disable every tenant that should stop serving; `tenant-disable` handles ones missed while the switch is off.
- Known limits: a WeChat account binds to an account in one tenant only; on the main host name, one browser signs in to one tenant at a time; host-name changes take up to 60 seconds; package changes reload every session's permissions once.

## [1.0.3] - 2026-10-06

`1.0.1` and `1.0.2` were tagged but never released. The first CI run of `1.0.1` failed on a fresh checkout: the shared package was not built before `verify`. The run of `1.0.2` failed on Linux in a deploy-lock test that held the lock in the wrong process. This release contains their changes and the fixes.

### Added

- GitHub Actions for the public repository: pushes and pull requests to `main` run the full local gate (`pnpm ci:local` with MySQL 8.4 and Redis 8 service containers, web and mobile Playwright). A `vX.Y.Z` tag does not run the gate again: it requires a successful CI run of the same commit on `main`, publishes a GitHub Release from this changelog and, after approval in the `demo` environment, deploys the demo site over SSH.
- Server deploy kit (`scripts/deploy/`): one directory per release behind an atomic `current` link, shared env files, PM2 cluster reloads with health checks and automatic code rollback, a root-owned kit, and a deploy key that can only run the deploy command (kept in a root-owned keys file, outside the app user's home). See `docs/deploy.md`.

### Fixed

- `pnpm ci:local` builds the shared package before `verify`, so the full gate also passes on a fresh checkout (it relied on an earlier build); the mobile removal drill in `docs/mobile.md` gained the same step.
- Mobile: wot-ui component texts such as placeholders follow English in the dev server and from the first render after a restart.
- Mobile workbench: long English subtitles wrap beside the header illustration instead of running under it.

## [1.0.0] - 2026-10-05

### Added

#### Identity, organization and access

- Account/password login with safe return navigation, remembered usernames, optional persistent login, logout, lock screen, first-login password changes and password-expiry prompts. Optional registration, SMS login/password recovery, image and slider captchas, and WeChat mini-program account binding are available behind their configuration switches.
- User, role, menu, department and position management, including role assignment, menu grants, custom department scopes, enable/disable actions, password resets, department-tree filtering, details, and supported Excel import/export workflows. Profiles include avatar cropping, password changes and account information.
- Five data-scope modes: all rows, selected departments, the current department, its subtree, and own rows. Session management supports scoped browsing and individual/batch forced logout, including OAuth sessions.
- Dynamic menus support routes, iframes and external links, visibility, sorting, caching and single-child group display through `always_show`.

#### Desktop interface and localization

- Chinese and English interfaces, translated validation/errors, and multilingual menu, dictionary, parameter, template and seed display content. English locale proofreading and strict TODO checks are complete; the mobile English login motto is intentionally blank.
- Side, top and mixed navigation; persisted sidebar collapse and light/dark sidebar variants; light/dark app themes, theme color, layout settings, tags and their context menu, menu search, fullscreen, density controls, dynamic titles and optional username watermark.
- Shared CRUD tables and dialog forms with per-user column preferences, first-load skeletons, viewport-bounded dialogs, footer dividers and common today/7-day/30-day date shortcuts. JSON viewers use read-only syntax highlighting.
- A workbench with workflow tasks, started applications, unread messages, shortcuts and last-login information, plus permission/not-found pages and session-expiry handling. Temporary refresh failures retry before showing service-unavailable state.

#### Settings, audit and operations

- Dictionary types/entries with multilingual labels, tags, exports, cache refresh and a database-enforced single default entry per dictionary. Parameter settings include built-in protection, categories and sensitive-value masking.
- Rich-text bulletins with publication notifications, a latest-items feed, unread counts and read/read-all actions. Login/action logs support filtering, details, deletion, exports and account unlock where applicable; trusted user types are translated through the audit dictionary in pages and exports.
- Configurable HTTP access traces and HTTP fault records with processing states and trace IDs; MySQL status, Redis/cache and host/runtime monitoring; registered cache namespace browsing/clearing; region trees and IP location lookup; Swagger documentation with a deployment switch.
- Scheduled jobs with registered handlers, cron builder, enable/disable, run-once, concurrency controls, misfire policies, retries, timeout monitoring and execution logs.

#### Files, Excel and messaging

- Local and S3-compatible storage configuration, primary storage selection, connection checks, file browsing/upload/deletion/link copying/preview, authenticated private downloads and presigned direct uploads. Changing an S3 endpoint, bucket or access key requires a newly entered secret in both the form and API.
- Excel import/export with dictionary conversion, shared validation, row/archive limits and formula-injection escaping. Avatar uploads are cropped and normalized to WebP.
- Inbox templates, personal messages, unread counts and read actions; email accounts/templates/send records; SMS channels/templates/records, verification codes and callbacks. Delivery is recorded transactionally and dispatched after commit through the notification/outbox mechanism.
- Socket.IO authentication, user/user-type/broadcast targeting, reconnect/polling fallbacks and an original realtime demonstration page. Redis sharded adapters carry cross-instance pushes and forced disconnects; shared Redis rate limiting accumulates requests across service instances.

#### Code generation and project reuse

- Original single-table CRUD, tree and master-detail templates; table import and schema synchronization; column/form configuration, detail views, generated tests, previews, single/batch ZIP downloads and guarded workspace writes. The CLI and golden-output checks keep generated modules aligned with the template contract.
- Project domains derived from table prefixes, reproducible menu groups and project action verbs. Optional mobile CRUD output is generated when the mobile folder exists; `im` / `im_` are reserved for future chat work.
- A Node-only new-project setup script with interactive/CLI input, isolated database and Redis selections, app title configuration, ignored secret files and a no-write dry run. Documentation covers getting started, project setup, deployment, code generation, data scopes, localization, notifications, security and integration boundaries.

#### Workflow and forms

- A tree-based workflow engine with versioned models, drafts, publish/suspend/activate, start ranges and workflow administrators. Tree and BPMN designers coexist; supported BPMN diagrams compile to the same tree engine, with import/export and progress highlighting.
- Structured approver strategies covering users, roles, positions, departments, department leaders, initiators, initiator selection and form fields; any/all/sequential approval; exclusive, parallel and inclusive branches; department/role conditions and configurable empty-approver/rejection behavior.
- Approval, rejection, return/resubmission, transfer, delegation, pre/post add-sign, remove-sign, copy, withdraw, instance cancellation, comments and rate-limited reminders. Personal inboxes, instance timelines/printing, scoped instance administration, termination and reassignment are included, with an original leave-request example.
- Visual form design with JSON/Vue SFC export, business and dynamic form integration, field-access controls, attachment binding, a no-code approval wizard, built-in templates, approval data exports, server-computed day counts and detail totals.
- Timeout reminders and configured auto-approve/auto-reject/transfer-to-superior actions, recorded in the timeline and notifications. Timeout scanning uses natural hours and approximately five-minute scheduling precision under normal operation.

#### OAuth2 and SSO

- Confidential OAuth2 clients with authorization code + PKCE S256, refresh tokens and client credentials; authorization/consent, userinfo, introspection and revocation endpoints. Password and implicit grants are rejected.
- Client management with one-time secret display/reset, exact redirect matching, grant/scope validation, consent lifetimes and revocation when a client is disabled/deleted. The browser SSO entry supports consent, account switching and returning after login.

#### Optional employee mobile client

- An independent uni-app Vue 3 folder for employee login, workbench, workflow tasks/applications, inbox, bulletins and profiles, targeting WeChat mini-program, Android and iOS, with H5 builds for debugging. Desktop-only projects can remove it using the documented steps.
- Workflow actions and supported dynamic forms with field visibility/edit rules, a shared validation contract, server-side calculations and generated mobile CRUD examples.
- A consistent original visual system with brand assets, empty states, custom tab icons and light/dark themes; App/H5 appearance selection and mini-program system-following appearance.
- Realtime task/message refresh with reconnect and polling fallbacks, session-kick handling, opt-in WeChat subscription reminders and platform version/update checks. Native-device, real WeChat-send and store-release acceptance remains pending in the mobile release checklist.

### Security

- Shared Zod validation, parameterized SQL, permission/data-scope checks and transactional write locks guard reads, exports and writes. Soft-delete reference registration supports restrict/cascade behavior without database foreign keys.
- Session rotation, reuse detection, revocation, brute-force/IP controls, origin checks, password rules, Redis-backed throttling and idempotent create submissions are enabled by the relevant routes. Temporary Redis throttling failures return an error instead of allowing the request.
- Rich-text sanitization, form-schema behavior/function rejection, network/SSRF guards, upload magic/size/path validation, private-file ownership checks, Excel injection protection and restricted BPMN XML parsing are covered by security regressions.
- Production startup, migration and seed entry points reject secrets containing the case-insensitive `not-for-production` marker. Committed test administrator passwords carry that marker. This prevents fixture reuse; it does not certify arbitrary production passwords as strong.
- Demo mode rejects writes by default, with exact method/route exceptions for login, session maintenance, preferences and supported read markers. Its lock-screen failure threshold revokes only the current session, and audit/session responses and exports mask visitor network metadata while retaining the original stored evidence.
- Each instance rechecks the sessions of its local sockets every 60 seconds to recover from a lost disconnect broadcast. Production deployments must still satisfy the shared-state and proxy requirements in [scale-out.md](docs/scale-out.md).
- Dependency licensing, original identifier checks, strict localization and architecture checks run in the local gates. Production dependencies and third-party assets are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### Windows support

- Prepared native PowerShell 5.1 workflows through LF checkout rules, normalized paths, portable pnpm child-process calls, cross-platform golden comparisons, explicit guarded golden write-back, quoted CI commands, and serial-only Windows gates.
- Added PowerShell examples, `pnpm.cmd`/standalone `pnpm.exe` guidance and Windows-specific guards. Registered the approved sharp win32 license exceptions and checked the actual exception file and notice coverage in the license self-test.
- Native Windows 11 + Windows PowerShell 5.1 (including the cmd entry) is verified for development and the full local gate (`pnpm ci:local --serial`); symlink-protection tests skip without file-symlink privilege; server deployment and App / mini-program publishing on Windows are not verified. See the [Windows setup](docs/getting-started.md#windows原生-powershell-51).

### Known limitations

- Node 22 / pnpm 11.28.x are the runtime and package-manager baseline, with pnpm 11.28.3 pinned in both projects. See [the runtime decision](docs/adr/006-runtime-package-manager.md). pnpm 12 remains untested.
- The admin UI targets desktop browsers (1280–1920); drawer/dialog behavior on narrower screens does not constitute a mobile-admin product. The employee mobile client is separate, and native-device and publishing validation remains open. Some mobile dynamic form controls are read-only, and attachments show filenames without mobile open/download support.
- App offline push, permanent App sessions and single-App login are planned; basic chat and employee organization directory are planned after v1.0. Reserving names does not deliver those features. Audio/video calls are outside the first chat scope.
- Multi-tenancy is not implemented; the documented hooks and department scopes do not provide tenant isolation. The platform uses one MySQL data source, a monolithic service architecture and soft-delete reference rules, without PostgreSQL or database foreign keys.
- Multi-instance deployment requires Redis ≥ 7, identical deployment state/secrets, database-qualified channels, ready adapter subscriptions, a shared local storage volume or S3, and correctly configured WebSocket forwarding/`TRUST_PROXY`. Same-machine two-process tests do not validate multi-host routing, external storage, Redis failover or production capacity.
- Socket.IO sharded adapters do not support connection-state recovery or durable delivery. Reliable data must be stored and refetched via REST; broadcasts may be lost. RedisLock and shared throttling assume a single Redis node, session listings use one MGET followed by in-memory paging, and mail transports are cached per instance.
- BPMN is a supported structured modeling subset compiled to a tree, not a general BPMN execution engine. Loops, arbitrary routing/joins, scripts, expressions, listeners, subprocesses and unsupported elements are rejected. Timeout handling is not a strict real-time deadline service. The bpmn.io logo must remain visible, unmodified and unobscured, including with the optional application watermark.
- OAuth2 supports confidential clients only; public clients and OIDC are deferred. Demo installations block OAuth write endpoints and the realtime send demonstration; use a non-demo installation to exercise those flows.
- Generated numeric bigint inputs are limited to safe integers (`2^53 - 1`); default numeric decimal handling has a 15-significant-digit ceiling and cannot guarantee exact floating-point money arithmetic. Wider decimal/string paths and precision-sensitive businesses must follow the [codegen precision contract](docs/codegen.md#数值精度边界).
- External SMS/mail/S3/WeChat services and native App publishing need deployment-specific credentials and acceptance. PM2 is an optional globally installed operations tool, not a project dependency. Docker/compose and remote CI support are planned; real S3 deployment and browser behavior need validation in the target environment.
