# 项目地图

> 本文件由 `pnpm ai:map` 生成，请勿手工编辑：源码变化后重新运行 `pnpm ai:map`（`pnpm verify` 会检查它是否过期）。
> 静态解析源码得到；服务端文件路径相对 `apps/server/src/`，`shared:` 开头的相对 `packages/shared/src/`。

## 领域与模块

领域是 `modules/` 下的第一级目录：`platform`、`workflow` 与项目领域（如 `biz`、`demo`）；项目模块在 `modules/project.module.ts` 登记。

| 目录（modules/ 下） | Nest 模块（文件） | 开关 |
| --- | --- | --- |
| biz/leave | `LeaveModule`（leave.module.ts） |  |
| demo/book | `BookMcpModule`（book.mcp-tools.ts）, `BookModule`（book.module.ts） |  |
| demo/customer | `CustomerMcpModule`（customer.mcp-tools.ts）, `CustomerModule`（customer.module.ts） |  |
| demo/invoice | `InvoiceModule`（invoice.module.ts） |  |
| demo/realtime | `DemoRealtimeModule`（realtime.module.ts） |  |
| demo/topic | `TopicModule`（topic.module.ts） |  |
| oa | `OaModule`（oa.module.ts） |  |
| oa/agent | `OaAgentModule`（oa-agent.module.ts） |  |
| oa/attachment | `OaAttachmentModule`（oa-attachment.module.ts） |  |
| oa/attendance | `AttendanceModule`（attendance.module.ts） |  |
| oa/expense | `ExpenseModule`（expense.module.ts） |  |
| oa/seal | `SealModule`（seal.module.ts） |  |
| oa/trip | `TripModule`（trip.module.ts） |  |
| platform/audit | `AuditModule`（audit.module.ts） |  |
| platform/audit/action-log | `ActionLogModule`（action-log.module.ts） |  |
| platform/audit/http-fault | `HttpFaultModule`（http-fault.module.ts） |  |
| platform/audit/http-trace | `HttpTraceModule`（http-trace.module.ts） |  |
| platform/audit/signin-log | `SigninLogModule`（signin-log.module.ts） |  |
| platform/codegen | `CodegenCliModule`（cli.ts）, `CodegenModule`（codegen.module.ts）, `CodegenServiceModule`（codegen.module.ts） |  |
| platform/geo | `GeoModule`（geo.module.ts） |  |
| platform/iam | `IamModule`（iam.module.ts） |  |
| platform/iam/dept | `DeptModule`（dept.module.ts） |  |
| platform/iam/menu | `MenuModule`（menu.module.ts） |  |
| platform/iam/position | `PositionModule`（position.module.ts） |  |
| platform/iam/role | `RoleModule`（role.module.ts） |  |
| platform/iam/session | `SessionModule`（session.module.ts） |  |
| platform/iam/tenant-package | `TenantPackageModule`（tenant-package.module.ts） |  |
| platform/iam/user | `UserModule`（user.module.ts） |  |
| platform/messaging | `MessagingModule`（messaging.module.ts） |  |
| platform/messaging/bulletin | `BulletinModule`（bulletin.module.ts） |  |
| platform/messaging/inbox | `InboxModule`（inbox.module.ts） |  |
| platform/messaging/inbox-template | `InboxTemplateModule`（inbox-template.module.ts） |  |
| platform/messaging/mail-account | `MailAccountModule`（mail-account.module.ts） |  |
| platform/messaging/mail-record | `MailRecordModule`（mail-record.module.ts） |  |
| platform/messaging/mail-template | `MailTemplateModule`（mail-template.module.ts） |  |
| platform/messaging/sms-channel | `SmsChannelModule`（sms-channel.module.ts） |  |
| platform/messaging/sms-otp | `SmsOtpModule`（sms-otp.module.ts） |  |
| platform/messaging/sms-record | `SmsRecordModule`（sms-record.module.ts） |  |
| platform/messaging/sms-template | `SmsTemplateModule`（sms-template.module.ts） |  |
| platform/monitor | `MonitorModule`（monitor.module.ts） |  |
| platform/oauth | `OauthModule`（oauth.module.ts） |  |
| platform/oauth/client | `ClientModule`（client.module.ts） |  |
| platform/oauth/provider | `ProviderModule`（provider.module.ts） |  |
| platform/scheduler | `JobSchedulerModule`（job-scheduler.module.ts）, `SchedulerModule`（scheduler.module.ts） |  |
| platform/scheduler/run | `RunModule`（run.module.ts） |  |
| platform/scheduler/task | `TaskModule`（task.module.ts） |  |
| platform/settings | `SettingsModule`（settings.module.ts） |  |
| platform/settings/app-version | `AppVersionModule`（app-version.module.ts） |  |
| platform/settings/dict | `DictModule`（dict.module.ts） |  |
| platform/settings/dict-entry | `DictEntryModule`（dict-entry.module.ts） |  |
| platform/settings/param | `ParameterModule`（param.module.ts） |  |
| platform/storage | `AgentAttachmentsModule`（agent-attachments.ts）, `StorageModule`（storage.module.ts） |  |
| platform/storage/config | `StorageConfigModule`（config.module.ts） |  |
| platform/wxoa | `WxoaModule`（wxoa.module.ts） | APP_WXOA |
| platform/wxoa/account | `WxoaAccountModule`（account.module.ts） | APP_WXOA |
| platform/wxoa/callback | `WxoaCallbackModule`（callback.module.ts） | APP_WXOA |
| platform/wxoa/comment | `WxoaCommentModule`（comment.module.ts） | APP_WXOA |
| platform/wxoa/core | `WxoaCoreModule`（wxoa-core.module.ts） | APP_WXOA |
| platform/wxoa/draft | `WxoaDraftModule`（draft.module.ts） | APP_WXOA |
| platform/wxoa/fan | `WxoaFanModule`（fan.module.ts） | APP_WXOA |
| platform/wxoa/mass | `WxoaMassModule`（mass.module.ts） | APP_WXOA |
| platform/wxoa/material | `WxoaMaterialModule`（material.module.ts） | APP_WXOA |
| platform/wxoa/menu | `WxoaMenuModule`（menu.module.ts） | APP_WXOA |
| platform/wxoa/message | `WxoaMessageModule`（message.module.ts） | APP_WXOA |
| platform/wxoa/notice | `WxoaNoticeModule`（notice.module.ts） | APP_WXOA |
| platform/wxoa/publish | `WxoaPublishModule`（publish.module.ts） | APP_WXOA |
| platform/wxoa/qrcode | `WxoaQrcodeModule`（qrcode.module.ts） | APP_WXOA |
| platform/wxoa/reply | `WxoaReplyModule`（reply.module.ts） | APP_WXOA |
| platform/wxoa/stat | `WxoaStatModule`（stat.module.ts） | APP_WXOA |
| platform/wxoa/template | `WxoaTemplateModule`（template.module.ts） | APP_WXOA |
| workflow | `WorkflowModule`（workflow.module.ts） |  |
| （项目登记） | `ProjectModule`（project.module.ts） |  |

### 功能开关

| 开关 | 只在开启时加载的模块 | 只在开启时显示的菜单（路由名） |
| --- | --- | --- |
| `APP_AGENT` | AgentModule（core/agent） | agent |
| `APP_MCP` | McpModule（core/mcp） | mcp-token, mcp-tool |
| `APP_MULTI_TENANT` |  | iam-tenant, iam-tenant-package |
| `APP_WXOA` | WxoaModule（modules/platform/wxoa） | wxoa |
| `SWAGGER_ENABLED` |  | devtools-api-docs |

## 表

租户表由 ORM 自动加租户条件；平台表登记在 `PLATFORM_TABLES` / `PROJECT_PLATFORM_TABLES`；软删除表删除时写 `deleted_at`。

| 表 | 实体 | 租户 | 软删除 | 文件 |
| --- | --- | --- | --- | --- |
| `agent_automation` | `AgentAutomation` | 租户 | 是 | core/agent/automation/automation.entity.ts |
| `agent_automation_run` | `AgentAutomationRun` | 租户 | 是 | core/agent/automation/automation.entity.ts |
| `agent_batch` | `AgentBatch` | 租户 | 是 | core/agent/entities/agent-thread.entity.ts |
| `agent_feedback` | `AgentFeedback` | 租户 | 是 | core/agent/entities/agent-thread.entity.ts |
| `agent_instruction` | `AgentInstruction` | 租户 | 是 | core/agent/entities/agent-skill.entity.ts |
| `agent_item` | `AgentItem` | 租户 | 是 | core/agent/entities/agent-thread.entity.ts |
| `agent_mcp_server` | `AgentMcpServer` | 平台 | 是 | core/agent/entities/agent-mcp.entity.ts |
| `agent_mcp_tool` | `AgentMcpTool` | 平台 | 是 | core/agent/entities/agent-mcp.entity.ts |
| `agent_memory` | `AgentMemory` | 租户 | 是 | core/agent/entities/agent-memory.entity.ts |
| `agent_platform_skill` | `AgentPlatformSkill` | 平台 | 是 | core/agent/entities/agent-skill.entity.ts |
| `agent_profile` | `AgentProfile` | 租户 | 是 | core/agent/entities/agent-memory.entity.ts |
| `agent_prompt` | `AgentPrompt` | 租户 | 是 | core/agent/entities/agent-skill.entity.ts |
| `agent_provider` | `AgentProvider` | 平台 | 是 | core/agent/provider/provider.entity.ts |
| `agent_search_provider` | `AgentSearchProvider` | 平台 | 是 | core/agent/provider/provider.entity.ts |
| `agent_skill` | `AgentSkill` | 租户 | 是 | core/agent/entities/agent-skill.entity.ts |
| `agent_thread` | `AgentThread` | 租户 | 是 | core/agent/entities/agent-thread.entity.ts |
| `agent_turn` | `AgentTurn` | 租户 | 是 | core/agent/entities/agent-thread.entity.ts |
| `agent_usage` | `AgentUsage` | 租户 | 是 | core/agent/entities/agent-usage.entity.ts |
| `aud_action_log` | `ActionLog` | 租户 | 是 | modules/platform/audit/action-log/action-log.entity.ts |
| `aud_http_fault` | `HttpFault` | 平台 | 是 | modules/platform/audit/http-fault/http-fault.entity.ts |
| `aud_http_trace` | `HttpTrace` | 平台 | 是 | modules/platform/audit/http-trace/http-trace.entity.ts |
| `aud_signin_log` | `SigninLog` | 租户 | 是 | modules/platform/audit/signin-log/signin-log.entity.ts |
| `biz_leave_request` | `Leave` | 租户 | 是 | modules/biz/leave/leave.entity.ts |
| `cfg_app_version` | `AppVersion` | 平台 | 是 | modules/platform/settings/app-version/app-version.entity.ts |
| `cfg_dict` | `Dict` | 平台 | 是 | modules/platform/settings/dict/dict.entity.ts |
| `cfg_dict_entry` | `DictEntry` | 平台 | 是 | modules/platform/settings/dict-entry/dict-entry.entity.ts |
| `cfg_mcp_tool` | `McpToolSwitch` | 平台 | 是 | core/mcp/mcp.entity.ts |
| `cfg_param` | `Parameter` | 平台 | 是 | modules/platform/settings/param/param.entity.ts |
| `cg_column` | `CgColumn` | 平台 | 是 | modules/platform/codegen/cg-column.entity.ts |
| `cg_table` | `CgTable` | 平台 | 是 | modules/platform/codegen/cg-table.entity.ts |
| `demo_book` | `Book` | 租户 | 是 | modules/demo/book/book.entity.ts |
| `demo_customer` | `Customer` | 租户 | 是 | modules/demo/customer/customer.entity.ts |
| `demo_invoice` | `Invoice` | 租户 | 是 | modules/demo/invoice/invoice.entity.ts |
| `demo_invoice_line` | `InvoiceLine` | 租户 | 是 | modules/demo/invoice/invoice-line.entity.ts |
| `demo_topic` | `Topic` | 租户 | 是 | modules/demo/topic/topic.entity.ts |
| `fs_object` | `FsObject` | 租户 | 是 | modules/platform/storage/fs-object.entity.ts |
| `fs_storage` | `StorageConfig` | 平台 | 是 | modules/platform/storage/config/config.entity.ts |
| `iam_access_token` | `AccessToken` | 租户 | 是 | core/mcp/mcp.entity.ts |
| `iam_dept` | `Dept` | 租户 | 是 | modules/platform/iam/dept/dept.entity.ts |
| `iam_menu` | `Menu` | 平台 | 是 | modules/platform/iam/menu/menu.entity.ts |
| `iam_position` | `Position` | 租户 | 是 | modules/platform/iam/position/position.entity.ts |
| `iam_role` | `Role` | 租户 | 是 | modules/platform/iam/role/role.entity.ts |
| `iam_tenant` | `Tenant` | 平台 | 是 | modules/platform/iam/tenant/tenant.entity.ts |
| `iam_tenant_package` | `TenantPackage` | 平台 | 是 | modules/platform/iam/tenant-package/tenant-package.entity.ts |
| `iam_user` | `User` | 租户 | 是 | modules/platform/iam/user/user.entity.ts |
| `iam_user_social` | `UserSocial` | 租户 | 是 | modules/platform/iam/social/user-social.entity.ts |
| `job_run` | `Run` | 平台 | 是 | modules/platform/scheduler/run/run.entity.ts |
| `job_task` | `Task` | 平台 | 是 | modules/platform/scheduler/task/task.entity.ts |
| `msg_bulletin` | `Bulletin` | 租户 | 是 | modules/platform/messaging/bulletin/bulletin.entity.ts |
| `msg_inbox` | `Inbox` | 租户 | 是 | modules/platform/messaging/inbox/inbox.entity.ts |
| `msg_inbox_template` | `InboxTemplate` | 平台 | 是 | modules/platform/messaging/inbox-template/inbox-template.entity.ts |
| `msg_mail_account` | `MailAccount` | 平台 | 是 | modules/platform/messaging/mail-account/mail-account.entity.ts |
| `msg_mail_record` | `MailRecord` | 租户 | 是 | modules/platform/messaging/mail-record/mail-record.entity.ts |
| `msg_mail_template` | `MailTemplate` | 平台 | 是 | modules/platform/messaging/mail-template/mail-template.entity.ts |
| `msg_sms_channel` | `SmsChannel` | 平台 | 是 | modules/platform/messaging/sms-channel/sms-channel.entity.ts |
| `msg_sms_otp` | `SmsOtp` | 租户 | 是 | modules/platform/messaging/sms-otp/sms-otp.entity.ts |
| `msg_sms_record` | `SmsRecord` | 租户 | 是 | modules/platform/messaging/sms-record/sms-record.entity.ts |
| `msg_sms_template` | `SmsTemplate` | 平台 | 是 | modules/platform/messaging/sms-template/sms-template.entity.ts |
| `oa_attendance_policy` | `AttendancePolicy` | 租户 | 是 | modules/oa/attendance/policy.entity.ts |
| `oa_attendance_site` | `AttendanceSite` | 租户 | 是 | modules/oa/attendance/site.entity.ts |
| `oa_clock_record` | `ClockRecord` | 租户 | 是 | modules/oa/attendance/clock-record.entity.ts |
| `oa_expense_claim` | `OaExpenseClaim` | 租户 | 是 | modules/oa/expense/expense.entity.ts |
| `oa_expense_item` | `OaExpenseItem` | 租户 | 是 | modules/oa/expense/expense-item.entity.ts |
| `oa_seal_request` | `OaSealRequest` | 租户 | 是 | modules/oa/seal/seal.entity.ts |
| `oa_trip_request` | `OaTripRequest` | 租户 | 是 | modules/oa/trip/trip.entity.ts |
| `oauth_client` | `Client` | 平台 | 是 | modules/platform/oauth/client/client.entity.ts |
| `wf_cc` | `WfCcRow` | 租户 | 是 | modules/workflow/runtime/wf-runtime.entity.ts |
| `wf_event` | `WfEventRow` | 租户 | 是 | modules/workflow/runtime/wf-runtime.entity.ts |
| `wf_form` | `WfForm` | 租户 | 是 | modules/workflow/form/wf-form.entity.ts |
| `wf_instance` | `WfInstanceRow` | 租户 | 是 | modules/workflow/runtime/wf-runtime.entity.ts |
| `wf_model` | `WfModel` | 租户 | 是 | modules/workflow/model/wf-model.entity.ts |
| `wf_task` | `WfTaskRow` | 租户 | 是 | modules/workflow/runtime/wf-runtime.entity.ts |
| `wf_version` | `WfVersion` | 租户 | 是 | modules/workflow/model/wf-model.entity.ts |
| `wxoa_account` | `WxoaAccount` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_draft` | `WxoaDraft` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_fan` | `WxoaFan` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_inline_image` | `WxoaInlineImage` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_mass_job` | `WxoaMassJob` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_material` | `WxoaMaterial` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_menu` | `WxoaMenu` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_message` | `WxoaMessage` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_publish` | `WxoaPublish` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_qrcode` | `WxoaQrcode` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_reply_rule` | `WxoaReplyRule` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |
| `wxoa_tag` | `WxoaTag` | 租户 | 是 | modules/platform/wxoa/core/wxoa.entity.ts |

## 接口

控制器写在它第一个接口的行上，“全部：”后的标记作用于它的每个接口；权限 `a / b` 任一即可，`a + b` 须全部具备，空白表示登录即可（标记 Public 的无需登录）。

| 控制器 | 方法 | 路径 | 权限 | 标记 |
| --- | --- | --- | --- | --- |
| `McpWellKnownController`（core/mcp/mcp.controller.ts） | GET | `/.well-known/oauth-protected-resource` |  | Public |
|  | GET | `/.well-known/oauth-protected-resource/api/mcp` |  | Public |
|  | GET | `/.well-known/oauth-authorization-server` |  | Public |
| `AgentAutomationController`（core/agent/automation/automation.controller.ts），全部：HomeTenant | GET | `/api/agent/automations` | agent.automation.use |  |
|  | POST | `/api/agent/automations` | agent.automation.use | Idempotent |
|  | PUT | `/api/agent/automations/:id` | agent.automation.use |  |
|  | DELETE | `/api/agent/automations/:id` | agent.automation.use |  |
|  | POST | `/api/agent/automations/:id/enabled` | agent.automation.use |  |
|  | POST | `/api/agent/automations/:id/run` | agent.automation.use | Idempotent |
|  | GET | `/api/agent/automations/:id/runs` | agent.automation.use |  |
|  | GET | `/api/agent/automation-events` | agent.automation.use |  |
|  | GET | `/api/agent/automation-tools` | agent.automation.use |  |
| `AgentChatController`（core/agent/threads/threads.controller.ts） | GET | `/api/agent/options` | agent.chat.use |  |
|  | GET | `/api/agent/shared/:token` | agent.chat.use |  |
|  | POST | `/api/agent/feedback` | agent.chat.use | Idempotent |
|  | GET | `/api/agent/prompts` | agent.chat.use |  |
|  | POST | `/api/agent/prompts` | agent.chat.use | Idempotent |
|  | PUT | `/api/agent/prompts/:id` | agent.chat.use |  |
|  | DELETE | `/api/agent/prompts/:id` | agent.chat.use |  |
|  | GET | `/api/agent/usage` | agent.usage.browse |  |
| `AgentTurnController`（core/agent/runtime/agent-turn.controller.ts） | POST | `/api/agent/threads/:id/messages` | agent.chat.use | Idempotent |
|  | POST | `/api/agent/threads/:id/cancel` | agent.chat.use |  |
|  | POST | `/api/agent/threads/:id/compact` | agent.chat.use |  |
|  | POST | `/api/agent/approvals/:itemId` | agent.chat.use |  |
|  | POST | `/api/agent/questions/:itemId` | agent.chat.use |  |
| `AgentBatchController`（core/agent/batch/batch.controller.ts） | POST | `/api/agent/batches` | agent.batch.run | Idempotent |
|  | GET | `/api/agent/batches/:id` | agent.batch.run |  |
|  | POST | `/api/agent/batches/:id/decide` | agent.batch.run |  |
| `AgentDiagnosticsController`（core/agent/diagnostics/diagnostics.controller.ts） | GET | `/api/agent/diagnostics` | agent.setting.browse | PlatformOnly(root) |
|  | POST | `/api/agent/diagnostics/test-provider/:id` | agent.setting.browse | PlatformOnly(root) |
|  | POST | `/api/agent/diagnostics/test-search/:id` | agent.setting.browse | PlatformOnly(root) |
|  | POST | `/api/agent/diagnostics/test-mcp/:id` | agent.setting.browse | PlatformOnly(root) |
| `AgentInstructionController`（core/agent/skills/skill.controller.ts） | GET | `/api/agent/instructions/me` | chat.use |  |
|  | PUT | `/api/agent/instructions/me` | chat.use |  |
|  | GET | `/api/agent/instructions/tenant` | chat.use / skill.browse / instruction.modify |  |
|  | PUT | `/api/agent/instructions/tenant` | instruction.modify |  |
| `AgentOutputController`（core/agent/runtime/output.controller.ts） | GET | `/api/agent/items/:itemId/xlsx` | agent.chat.use |  |
| `AgentMcpServerController`（core/agent/mcp-client/mcp-server.controller.ts） | GET | `/api/agent/mcp-servers` | agent.setting.browse | PlatformOnly |
|  | POST | `/api/agent/mcp-servers` | agent.setting.modify | PlatformOnly(root), Idempotent |
|  | PUT | `/api/agent/mcp-servers/:id` | agent.setting.modify | PlatformOnly(root) |
|  | DELETE | `/api/agent/mcp-servers/:id` | agent.setting.modify | PlatformOnly(root) |
|  | POST | `/api/agent/mcp-servers/:id/sync` | agent.setting.modify | PlatformOnly(root) |
|  | PUT | `/api/agent/mcp-servers/:id/tools/:toolId` | agent.setting.modify | PlatformOnly(root) |
| `AgentMemoryController`（core/agent/memory/memory.controller.ts），全部：HomeTenant | GET | `/api/agent/memories` | agent.chat.use |  |
|  | POST | `/api/agent/memories` | agent.chat.use | Idempotent |
|  | POST | `/api/agent/memories/forget-all` | agent.chat.use |  |
|  | PUT | `/api/agent/memories/:id` | agent.chat.use |  |
|  | DELETE | `/api/agent/memories/:id` | agent.chat.use |  |
| `AgentNotifySettingsController`（core/agent/runtime/notify-settings.ts），全部：HomeTenant | GET | `/api/agent/notify-settings` | agent.chat.use |  |
|  | PUT | `/api/agent/notify-settings` | agent.chat.use |  |
| `AgentPlatformSkillController`（core/agent/skills/skill.controller.ts） | GET | `/api/agent/platform-skills` | setting.browse | PlatformOnly |
|  | POST | `/api/agent/platform-skills` | setting.modify | PlatformOnly(root), Idempotent |
|  | PUT | `/api/agent/platform-skills/:id` | setting.modify | PlatformOnly(root) |
|  | DELETE | `/api/agent/platform-skills/:id` | setting.modify | PlatformOnly(root) |
|  | POST | `/api/agent/platform-skills/import` | setting.modify | PlatformOnly(root), Idempotent |
|  | GET | `/api/agent/platform-skills/:id/export` | setting.browse | PlatformOnly |
| `AgentProfileController`（core/agent/profiles/profile.controller.ts），全部：HomeTenant | GET | `/api/agent/profiles` | agent.chat.use |  |
|  | POST | `/api/agent/profiles` | agent.chat.use | Idempotent |
|  | PUT | `/api/agent/profiles/:id` | agent.chat.use |  |
|  | DELETE | `/api/agent/profiles/:id` | agent.chat.use |  |
| `AgentProviderController`（core/agent/provider/provider.controller.ts） | GET | `/api/agent/providers` | agent.setting.browse | PlatformOnly |
|  | POST | `/api/agent/providers` | agent.setting.modify | PlatformOnly(root), Idempotent |
|  | PUT | `/api/agent/providers/:id` | agent.setting.modify | PlatformOnly(root) |
|  | DELETE | `/api/agent/providers/:id` | agent.setting.modify | PlatformOnly(root) |
| `AgentSearchProviderController`（core/agent/provider/provider.controller.ts） | GET | `/api/agent/search-providers` | agent.setting.browse | PlatformOnly |
|  | POST | `/api/agent/search-providers` | agent.setting.modify | PlatformOnly(root), Idempotent |
|  | PUT | `/api/agent/search-providers/:id` | agent.setting.modify | PlatformOnly(root) |
|  | DELETE | `/api/agent/search-providers/:id` | agent.setting.modify | PlatformOnly(root) |
| `AgentSkillController`（core/agent/skills/skill.controller.ts） | GET | `/api/agent/skills` | chat.use / skill.browse |  |
|  | POST | `/api/agent/skills` | chat.use / skill.create | Idempotent |
|  | POST | `/api/agent/skills/import` | chat.use / skill.create | Idempotent |
|  | POST | `/api/agent/skills/from-thread/:id` | chat.use | Idempotent |
|  | PUT | `/api/agent/skills/:id` | chat.use / skill.modify |  |
|  | DELETE | `/api/agent/skills/:id` | chat.use / skill.remove |  |
|  | GET | `/api/agent/skills/:id/export` | chat.use / skill.browse |  |
| `AgentThreadController`（core/agent/threads/threads.controller.ts） | GET | `/api/agent/threads` | agent.chat.use |  |
|  | POST | `/api/agent/threads` | agent.chat.use | Idempotent |
|  | PATCH | `/api/agent/threads/:id` | agent.chat.use |  |
|  | DELETE | `/api/agent/threads/:id` | agent.chat.use |  |
|  | GET | `/api/agent/threads/:id/items` | agent.chat.use |  |
|  | POST | `/api/agent/threads/:id/fork` | agent.chat.use | Idempotent |
|  | POST | `/api/agent/threads/read-all` | agent.chat.use |  |
|  | POST | `/api/agent/threads/:id/read` | agent.chat.use |  |
|  | POST | `/api/agent/threads/:id/revert` | agent.chat.use |  |
|  | GET | `/api/agent/threads/:id/export` | agent.chat.use |  |
|  | GET | `/api/agent/threads/:id/status` | agent.chat.use |  |
|  | POST | `/api/agent/threads/:id/share` | agent.chat.use |  |
|  | DELETE | `/api/agent/threads/:id/share` | agent.chat.use |  |
| `AgentToolPolicyController`（core/agent/tools/tool-policy.ts） | GET | `/api/agent/tools` | agent.setting.browse | PlatformOnly |
|  | PUT | `/api/agent/tools/:name/policy` | agent.setting.modify | PlatformOnly(root) |
|  | PUT | `/api/agent/tools/:name/enabled` | agent.setting.modify | PlatformOnly(root) |
| `ActionLogController`（modules/platform/audit/action-log/action-log.controller.ts） | GET | `/api/audit/action-logs` | audit.actionLog.browse |  |
|  | GET | `/api/audit/action-logs/export` | audit.actionLog.export |  |
|  | GET | `/api/audit/action-logs/:id` | audit.actionLog.view |  |
|  | DELETE | `/api/audit/action-logs/:id` | audit.actionLog.remove |  |
|  | POST | `/api/audit/action-logs/batch-delete` | audit.actionLog.remove |  |
|  | POST | `/api/audit/action-logs/clean` | audit.actionLog.remove |  |
| `HttpFaultController`（modules/platform/audit/http-fault/http-fault.controller.ts），全部：PlatformOnly(root) | GET | `/api/audit/http-faults` | audit.httpFault.browse |  |
|  | GET | `/api/audit/http-faults/export` | audit.httpFault.export |  |
|  | GET | `/api/audit/http-faults/:id` | audit.httpFault.view |  |
|  | PUT | `/api/audit/http-faults/:id/state` | audit.httpFault.handle |  |
| `HttpTraceController`（modules/platform/audit/http-trace/http-trace.controller.ts），全部：PlatformOnly(root) | GET | `/api/audit/http-traces` | audit.httpTrace.browse |  |
|  | GET | `/api/audit/http-traces/export` | audit.httpTrace.export |  |
|  | GET | `/api/audit/http-traces/:id` | audit.httpTrace.view |  |
| `SigninLogController`（modules/platform/audit/signin-log/signin-log.controller.ts） | GET | `/api/audit/signin-logs` | audit.signinLog.browse |  |
|  | GET | `/api/audit/signin-logs/export` | audit.signinLog.export |  |
|  | GET | `/api/audit/signin-logs/:id` | audit.signinLog.view |  |
|  | DELETE | `/api/audit/signin-logs/:id` | audit.signinLog.remove |  |
|  | POST | `/api/audit/signin-logs/batch-delete` | audit.signinLog.remove |  |
|  | POST | `/api/audit/signin-logs/clean` | audit.signinLog.remove |  |
|  | POST | `/api/audit/signin-logs/unlock` | audit.signinLog.unlock |  |
| `AuthController`（core/auth/auth.controller.ts） | POST | `/api/auth/login` |  | Public |
|  | GET | `/api/auth/tenancy` |  | Public |
|  | POST | `/api/auth/refresh` |  | Public |
|  | POST | `/api/auth/logout` |  | HomeTenant |
|  | POST | `/api/auth/verify-password` |  | HomeTenant |
|  | GET | `/api/auth/me` |  | HomeTenant |
|  | GET | `/api/auth/menus` |  | HomeTenant |
| `CaptchaController`（core/captcha/captcha.controller.ts） | GET | `/api/auth/captcha` |  | Public |
|  | POST | `/api/auth/captcha/check` |  | Public |
| `SignupController`（modules/platform/iam/signup/signup.controller.ts） | POST | `/api/auth/signup` |  | Public, Idempotent |
| `SmsOtpController`（modules/platform/messaging/sms-otp/sms-otp.controller.ts） | POST | `/api/auth/sms/code` |  | Public |
|  | POST | `/api/auth/sms/login` |  | Public |
|  | POST | `/api/auth/password/reset-by-sms` |  | Public |
| `WxMpAuthController`（modules/platform/iam/social/wx-mp.controller.ts） | POST | `/api/auth/wx-mp/login` |  | Public |
|  | POST | `/api/auth/wx-mp/bind` |  | Public |
| `LeaveController`（modules/biz/leave/leave.controller.ts） | GET | `/api/biz/leaves` | biz.leave.browse |  |
|  | GET | `/api/biz/leaves/:id` |  | RequireFeature(workflow) |
|  | POST | `/api/biz/leaves` | biz.leave.create | Idempotent |
|  | PUT | `/api/biz/leaves/:id` | biz.leave.modify |  |
| `CodegenController`（modules/platform/codegen/codegen.controller.ts），全部：PlatformOnly | GET | `/api/codegen/tables` | codegen.table.browse |  |
|  | GET | `/api/codegen/tables/importable` | codegen.table.import |  |
|  | GET | `/api/codegen/tables/writable` | codegen.table.browse |  |
|  | GET | `/api/codegen/tables/parent-menus` | codegen.table.view |  |
|  | GET | `/api/codegen/tables/download` | codegen.table.generate |  |
|  | POST | `/api/codegen/tables/import` | codegen.table.import | Idempotent |
|  | POST | `/api/codegen/tables/write` | codegen.table.write | Idempotent |
|  | POST | `/api/codegen/tables/batch-delete` | codegen.table.remove |  |
|  | GET | `/api/codegen/tables/:id` | codegen.table.view |  |
|  | PUT | `/api/codegen/tables/:id` | codegen.table.modify |  |
|  | DELETE | `/api/codegen/tables/:id` | codegen.table.remove |  |
|  | POST | `/api/codegen/tables/:id/sync` | codegen.table.modify |  |
|  | GET | `/api/codegen/tables/:id/preview` | codegen.table.generate |  |
| `BookController`（modules/demo/book/book.controller.ts） | GET | `/api/demo/books` | demo.book.browse |  |
|  | GET | `/api/demo/books/export` | demo.book.export |  |
|  | GET | `/api/demo/books/import-template` | demo.book.import |  |
|  | POST | `/api/demo/books/import` | demo.book.import | Idempotent |
|  | GET | `/api/demo/books/:id` | demo.book.view |  |
|  | POST | `/api/demo/books` | demo.book.create | Idempotent |
|  | PUT | `/api/demo/books/:id` | demo.book.modify |  |
|  | PUT | `/api/demo/books/:id/enabled` | demo.book.modify |  |
|  | DELETE | `/api/demo/books/:id` | demo.book.remove |  |
|  | POST | `/api/demo/books/batch-delete` | demo.book.remove |  |
| `CustomerController`（modules/demo/customer/customer.controller.ts） | GET | `/api/demo/customers` | demo.customer.browse |  |
|  | GET | `/api/demo/customers/export` | demo.customer.export |  |
|  | GET | `/api/demo/customers/:id` | demo.customer.view |  |
|  | POST | `/api/demo/customers` | demo.customer.create | Idempotent |
|  | PUT | `/api/demo/customers/:id` | demo.customer.modify |  |
|  | DELETE | `/api/demo/customers/:id` | demo.customer.remove |  |
|  | POST | `/api/demo/customers/batch-delete` | demo.customer.remove |  |
| `InvoiceController`（modules/demo/invoice/invoice.controller.ts） | GET | `/api/demo/invoices` | demo.invoice.browse |  |
|  | GET | `/api/demo/invoices/:id` | demo.invoice.view |  |
|  | POST | `/api/demo/invoices` | demo.invoice.create | Idempotent |
|  | PUT | `/api/demo/invoices/:id` | demo.invoice.modify |  |
|  | DELETE | `/api/demo/invoices/:id` | demo.invoice.remove |  |
|  | POST | `/api/demo/invoices/batch-delete` | demo.invoice.remove |  |
| `DemoRealtimeController`（modules/demo/realtime/realtime.controller.ts） | POST | `/api/demo/realtime/send` | demo.realtime.send | Idempotent |
| `TopicController`（modules/demo/topic/topic.controller.ts） | GET | `/api/demo/topics` | demo.topic.browse |  |
|  | GET | `/api/demo/topics/:id` | demo.topic.view |  |
|  | POST | `/api/demo/topics` | demo.topic.create | Idempotent |
|  | PUT | `/api/demo/topics/:id` | demo.topic.modify |  |
|  | PUT | `/api/demo/topics/:id/enabled` | demo.topic.modify |  |
|  | DELETE | `/api/demo/topics/:id` | demo.topic.remove |  |
| `ExcelController`（core/excel/excel.controller.ts） | GET | `/api/excel/reports/:id` |  |  |
| `GeoController`（modules/platform/geo/geo.controller.ts） | GET | `/api/geo/areas/tree` |  |  |
|  | GET | `/api/geo/areas/by-ip` | geo.area.browse |  |
| `HealthController`（core/health/health.controller.ts），全部：Public | GET | `/api/health` |  |  |
| `DeptController`（modules/platform/iam/dept/dept.controller.ts） | GET | `/api/iam/depts` | iam.dept.browse |  |
|  | GET | `/api/iam/depts/tree` |  |  |
|  | GET | `/api/iam/depts/:id` | iam.dept.view |  |
|  | POST | `/api/iam/depts` | iam.dept.create | Idempotent |
|  | PUT | `/api/iam/depts/:id` | iam.dept.modify |  |
|  | PUT | `/api/iam/depts/:id/enabled` | iam.dept.modify |  |
|  | DELETE | `/api/iam/depts/:id` | iam.dept.remove |  |
| `MenuController`（modules/platform/iam/menu/menu.controller.ts），全部：PlatformOnly | GET | `/api/iam/menus` | iam.menu.browse |  |
|  | GET | `/api/iam/menus/:id` | iam.menu.view |  |
|  | POST | `/api/iam/menus` | iam.menu.create | Idempotent |
|  | PUT | `/api/iam/menus/sort` | iam.menu.modify |  |
|  | PUT | `/api/iam/menus/:id` | iam.menu.modify |  |
|  | PUT | `/api/iam/menus/:id/enabled` | iam.menu.modify |  |
|  | DELETE | `/api/iam/menus/:id` | iam.menu.remove |  |
| `PositionController`（modules/platform/iam/position/position.controller.ts） | GET | `/api/iam/positions` | iam.position.browse |  |
|  | GET | `/api/iam/positions/export` | iam.position.export |  |
|  | GET | `/api/iam/positions/options` |  |  |
|  | GET | `/api/iam/positions/:id` | iam.position.view |  |
|  | POST | `/api/iam/positions` | iam.position.create | Idempotent |
|  | PUT | `/api/iam/positions/:id` | iam.position.modify |  |
|  | PUT | `/api/iam/positions/:id/enabled` | iam.position.modify |  |
|  | DELETE | `/api/iam/positions/:id` | iam.position.remove |  |
|  | POST | `/api/iam/positions/batch-delete` | iam.position.remove |  |
| `ProfileController`（modules/platform/iam/profile/profile.controller.ts），全部：HomeTenant | GET | `/api/iam/profile` |  |  |
|  | PUT | `/api/iam/profile` |  |  |
|  | POST | `/api/iam/profile/mobile/code` |  |  |
|  | PUT | `/api/iam/profile/locale` |  |  |
|  | POST | `/api/iam/profile/avatar` |  | Idempotent |
|  | PUT | `/api/iam/profile/password` |  |  |
|  | GET | `/api/iam/profile/prefs/:key` |  |  |
|  | PUT | `/api/iam/profile/prefs/:key` |  |  |
|  | DELETE | `/api/iam/profile/prefs/:key` |  |  |
| `ProfileSocialController`（modules/platform/iam/social/wx-mp.controller.ts），全部：HomeTenant | GET | `/api/iam/profile/socials` |  |  |
|  | GET | `/api/iam/profile/socials/wx-mp/subscribe` |  |  |
|  | DELETE | `/api/iam/profile/socials/wx-mp` |  |  |
| `RoleController`（modules/platform/iam/role/role.controller.ts） | GET | `/api/iam/roles` | iam.role.browse |  |
|  | GET | `/api/iam/roles/export` | iam.role.export |  |
|  | GET | `/api/iam/roles/options` |  |  |
|  | GET | `/api/iam/roles/menu-tree` | iam.role.grant |  |
|  | GET | `/api/iam/roles/:id` | iam.role.view |  |
|  | POST | `/api/iam/roles` | iam.role.create | Idempotent |
|  | PUT | `/api/iam/roles/:id` | iam.role.modify |  |
|  | PUT | `/api/iam/roles/:id/enabled` | iam.role.modify |  |
|  | GET | `/api/iam/roles/:id/menus` | iam.role.grant |  |
|  | PUT | `/api/iam/roles/:id/menus` | iam.role.grant |  |
|  | GET | `/api/iam/roles/:id/data-scope` | iam.role.grant |  |
|  | PUT | `/api/iam/roles/:id/data-scope` | iam.role.grant |  |
|  | GET | `/api/iam/roles/:id/members` | iam.role.assign-users |  |
|  | POST | `/api/iam/roles/:id/members` | iam.role.assign-users |  |
|  | POST | `/api/iam/roles/:id/members/revoke` | iam.role.assign-users |  |
|  | DELETE | `/api/iam/roles/:id` | iam.role.remove |  |
|  | POST | `/api/iam/roles/batch-delete` | iam.role.remove |  |
| `SessionController`（modules/platform/iam/session/session.controller.ts） | GET | `/api/iam/sessions` | iam.session.browse |  |
|  | POST | `/api/iam/sessions/kick` | iam.session.kick |  |
|  | DELETE | `/api/iam/sessions/:sid` | iam.session.kick |  |
| `TenantPackageController`（modules/platform/iam/tenant-package/tenant-package.controller.ts），全部：PlatformOnly | GET | `/api/iam/tenant-packages` | iam.tenantPackage.browse |  |
|  | GET | `/api/iam/tenant-packages/options` | iam.tenantPackage.browse / iam.tenant.create / iam.tenant.modify |  |
|  | GET | `/api/iam/tenant-packages/menu-tree` | iam.tenantPackage.browse |  |
|  | GET | `/api/iam/tenant-packages/:id` | iam.tenantPackage.view |  |
|  | POST | `/api/iam/tenant-packages` | iam.tenantPackage.create | Idempotent |
|  | PUT | `/api/iam/tenant-packages/:id` | iam.tenantPackage.modify |  |
|  | DELETE | `/api/iam/tenant-packages/:id` | iam.tenantPackage.remove |  |
| `TenantController`（modules/platform/iam/tenant/tenant.controller.ts），全部：PlatformOnly | GET | `/api/iam/tenants` | iam.tenant.browse |  |
|  | GET | `/api/iam/tenants/options` | iam.tenant.browse |  |
|  | POST | `/api/iam/tenants/leave` |  |  |
|  | GET | `/api/iam/tenants/:id` | iam.tenant.view |  |
|  | POST | `/api/iam/tenants` | iam.tenant.create | Idempotent |
|  | PUT | `/api/iam/tenants/:id` | iam.tenant.modify |  |
|  | PUT | `/api/iam/tenants/:id/enabled` | iam.tenant.modify |  |
|  | POST | `/api/iam/tenants/:id/enter` | iam.tenant.enter |  |
|  | POST | `/api/iam/tenants/:id/initial-password` | iam.tenant.reset-password | Idempotent |
| `UserController`（modules/platform/iam/user/user.controller.ts） | GET | `/api/iam/users` | iam.user.browse |  |
|  | GET | `/api/iam/users/export` | iam.user.export |  |
|  | GET | `/api/iam/users/import-template` | iam.user.import |  |
|  | POST | `/api/iam/users/import` | iam.user.import | Idempotent |
|  | GET | `/api/iam/users/options` |  |  |
|  | GET | `/api/iam/users/:id` | iam.user.view |  |
|  | POST | `/api/iam/users` | iam.user.create | Idempotent |
|  | PUT | `/api/iam/users/:id` | iam.user.modify |  |
|  | PUT | `/api/iam/users/:id/enabled` | iam.user.modify |  |
|  | PUT | `/api/iam/users/:id/password` | iam.user.reset-password |  |
|  | PUT | `/api/iam/users/:id/roles` | iam.user.assign-roles |  |
|  | DELETE | `/api/iam/users/:id` | iam.user.remove |  |
|  | POST | `/api/iam/users/batch-delete` | iam.user.remove |  |
| `McpController`（core/mcp/mcp.controller.ts） | POST | `/api/mcp` |  | Public |
|  | GET | `/api/mcp` |  | Public |
|  | DELETE | `/api/mcp` |  | Public |
| `McpMyTokenController`（core/mcp/mcp-admin.controller.ts），全部：HomeTenant | GET | `/api/mcp/my-tokens` |  |  |
|  | POST | `/api/mcp/my-tokens` |  | Idempotent |
|  | POST | `/api/mcp/my-tokens/:id/revoke` |  |  |
| `McpMyToolController`（core/mcp/mcp-admin.controller.ts），全部：HomeTenant | GET | `/api/mcp/my-tools` |  |  |
| `McpTokenController`（core/mcp/mcp-admin.controller.ts） | GET | `/api/mcp/tokens` | mcp.token.browse |  |
|  | POST | `/api/mcp/tokens/:id/revoke` | mcp.token.revoke |  |
| `McpToolController`（core/mcp/mcp-admin.controller.ts） | GET | `/api/mcp/tools` | mcp.tool.browse | PlatformOnly |
|  | PUT | `/api/mcp/tools/:name/enabled` | mcp.tool.modify | PlatformOnly |
| `BulletinController`（modules/platform/messaging/bulletin/bulletin.controller.ts） | GET | `/api/messaging/bulletins` | messaging.bulletin.browse |  |
|  | GET | `/api/messaging/bulletins/:id` | messaging.bulletin.view |  |
|  | POST | `/api/messaging/bulletins` | messaging.bulletin.create | Idempotent |
|  | PUT | `/api/messaging/bulletins/:id` | messaging.bulletin.modify |  |
|  | PUT | `/api/messaging/bulletins/:id/published` | messaging.bulletin.publish |  |
|  | DELETE | `/api/messaging/bulletins/:id` | messaging.bulletin.remove |  |
|  | POST | `/api/messaging/bulletins/batch-delete` | messaging.bulletin.remove |  |
| `BulletinReceiptController`（modules/platform/messaging/bulletin/bulletin-receipt.controller.ts） | GET | `/api/messaging/bulletins/:id/receipts` | messaging.bulletin.view |  |
| `BulletinFeedController`（modules/platform/messaging/bulletin/bulletin-feed.controller.ts），全部：HomeTenant | GET | `/api/messaging/bulletins/feed` |  |  |
|  | POST | `/api/messaging/bulletins/feed/read-all` |  |  |
|  | GET | `/api/messaging/bulletins/feed/:id` |  |  |
|  | POST | `/api/messaging/bulletins/feed/:id/read` |  |  |
| `InboxTemplateController`（modules/platform/messaging/inbox-template/inbox-template.controller.ts），全部：PlatformOnly | GET | `/api/messaging/inbox-templates` | messaging.inboxTemplate.browse |  |
|  | GET | `/api/messaging/inbox-templates/:id` | messaging.inboxTemplate.view |  |
|  | POST | `/api/messaging/inbox-templates/:id/test` | messaging.inboxTemplate.modify |  |
|  | POST | `/api/messaging/inbox-templates` | messaging.inboxTemplate.create | Idempotent |
|  | PUT | `/api/messaging/inbox-templates/:id` | messaging.inboxTemplate.modify |  |
|  | PUT | `/api/messaging/inbox-templates/:id/enabled` | messaging.inboxTemplate.modify |  |
|  | DELETE | `/api/messaging/inbox-templates/:id` | messaging.inboxTemplate.remove |  |
|  | POST | `/api/messaging/inbox-templates/batch-delete` | messaging.inboxTemplate.remove |  |
| `InboxController`（modules/platform/messaging/inbox/inbox.controller.ts） | GET | `/api/messaging/inboxes` | messaging.inbox.browse |  |
|  | GET | `/api/messaging/inboxes/:id` | messaging.inbox.view |  |
| `MyInboxController`（modules/platform/messaging/inbox/my-inbox.controller.ts），全部：HomeTenant | GET | `/api/messaging/inboxes/mine` |  |  |
|  | GET | `/api/messaging/inboxes/mine/unread` |  |  |
|  | POST | `/api/messaging/inboxes/mine/read-all` |  |  |
|  | GET | `/api/messaging/inboxes/mine/:id` |  |  |
|  | POST | `/api/messaging/inboxes/mine/:id/read` |  |  |
| `MailAccountController`（modules/platform/messaging/mail-account/mail-account.controller.ts） | GET | `/api/messaging/mail-accounts` | messaging.mailAccount.browse | PlatformOnly |
|  | GET | `/api/messaging/mail-accounts/options` |  |  |
|  | GET | `/api/messaging/mail-accounts/:id` | messaging.mailAccount.view | PlatformOnly |
|  | POST | `/api/messaging/mail-accounts` | messaging.mailAccount.create | PlatformOnly, Idempotent |
|  | PUT | `/api/messaging/mail-accounts/:id` | messaging.mailAccount.modify | PlatformOnly |
|  | PUT | `/api/messaging/mail-accounts/:id/enabled` | messaging.mailAccount.modify | PlatformOnly |
|  | POST | `/api/messaging/mail-accounts/:id/test` | messaging.mailAccount.modify | PlatformOnly |
|  | DELETE | `/api/messaging/mail-accounts/:id` | messaging.mailAccount.remove | PlatformOnly |
|  | POST | `/api/messaging/mail-accounts/batch-delete` | messaging.mailAccount.remove | PlatformOnly |
| `MailRecordController`（modules/platform/messaging/mail-record/mail-record.controller.ts） | GET | `/api/messaging/mail-records` | messaging.mailRecord.browse |  |
|  | GET | `/api/messaging/mail-records/:id` | messaging.mailRecord.view |  |
| `MailTemplateController`（modules/platform/messaging/mail-template/mail-template.controller.ts），全部：PlatformOnly | GET | `/api/messaging/mail-templates` | messaging.mailTemplate.browse |  |
|  | GET | `/api/messaging/mail-templates/:id` | messaging.mailTemplate.view |  |
|  | POST | `/api/messaging/mail-templates/:id/test` | messaging.mailTemplate.modify | Idempotent |
|  | POST | `/api/messaging/mail-templates` | messaging.mailTemplate.create | Idempotent |
|  | PUT | `/api/messaging/mail-templates/:id` | messaging.mailTemplate.modify |  |
|  | PUT | `/api/messaging/mail-templates/:id/enabled` | messaging.mailTemplate.modify |  |
|  | DELETE | `/api/messaging/mail-templates/:id` | messaging.mailTemplate.remove |  |
|  | POST | `/api/messaging/mail-templates/batch-delete` | messaging.mailTemplate.remove |  |
| `SmsChannelController`（modules/platform/messaging/sms-channel/sms-channel.controller.ts） | GET | `/api/messaging/sms-channels` | messaging.smsChannel.browse | PlatformOnly |
|  | GET | `/api/messaging/sms-channels/options` |  |  |
|  | GET | `/api/messaging/sms-channels/:id` | messaging.smsChannel.view | PlatformOnly |
|  | POST | `/api/messaging/sms-channels` | messaging.smsChannel.create | PlatformOnly, Idempotent |
|  | PUT | `/api/messaging/sms-channels/:id` | messaging.smsChannel.modify | PlatformOnly |
|  | PUT | `/api/messaging/sms-channels/:id/enabled` | messaging.smsChannel.modify | PlatformOnly |
|  | POST | `/api/messaging/sms-channels/:id/test` | messaging.smsChannel.modify | PlatformOnly |
|  | DELETE | `/api/messaging/sms-channels/:id` | messaging.smsChannel.remove | PlatformOnly |
|  | POST | `/api/messaging/sms-channels/batch-delete` | messaging.smsChannel.remove | PlatformOnly |
| `SmsRecordController`（modules/platform/messaging/sms-record/sms-record.controller.ts） | GET | `/api/messaging/sms-records` | messaging.smsRecord.browse |  |
|  | GET | `/api/messaging/sms-records/:id` | messaging.smsRecord.view |  |
| `SmsTemplateController`（modules/platform/messaging/sms-template/sms-template.controller.ts），全部：PlatformOnly | GET | `/api/messaging/sms-templates` | messaging.smsTemplate.browse |  |
|  | GET | `/api/messaging/sms-templates/:id` | messaging.smsTemplate.view |  |
|  | POST | `/api/messaging/sms-templates/:id/test` | messaging.smsTemplate.modify | Idempotent |
|  | POST | `/api/messaging/sms-templates` | messaging.smsTemplate.create | Idempotent |
|  | PUT | `/api/messaging/sms-templates/:id` | messaging.smsTemplate.modify |  |
|  | PUT | `/api/messaging/sms-templates/:id/enabled` | messaging.smsTemplate.modify |  |
|  | DELETE | `/api/messaging/sms-templates/:id` | messaging.smsTemplate.remove |  |
|  | POST | `/api/messaging/sms-templates/batch-delete` | messaging.smsTemplate.remove |  |
| `SmsReceiptController`（modules/platform/messaging/sms-channel/sms-receipt.controller.ts） | POST | `/api/messaging/sms/receipt/:channel` |  | Public |
| `MonitorController`（modules/platform/monitor/monitor.controller.ts），全部：PlatformOnly | GET | `/api/monitor/server` | monitor.server.browse |  |
|  | GET | `/api/monitor/redis` | monitor.redis.browse |  |
|  | GET | `/api/monitor/mysql` | monitor.mysql.browse |  |
|  | GET | `/api/monitor/cache/namespaces` | monitor.cache.browse | PlatformOnly(root) |
|  | GET | `/api/monitor/cache/keys` | monitor.cache.browse | PlatformOnly(root) |
|  | GET | `/api/monitor/cache/value` | monitor.cache.browse | PlatformOnly(root) |
|  | DELETE | `/api/monitor/cache/keys` | monitor.cache.remove | PlatformOnly(root) |
|  | DELETE | `/api/monitor/cache/all-registered` | monitor.cache.remove | PlatformOnly(root) |
| `QueueMonitorController`（modules/platform/monitor/queue-monitor.controller.ts），全部：PlatformOnly(root) | GET | `/api/monitor/queues` | monitor.queue.browse |  |
|  | GET | `/api/monitor/queues/:name/jobs` | monitor.queue.browse |  |
|  | POST | `/api/monitor/queues/:name/jobs/:id/retry` | monitor.queue.retry |  |
|  | DELETE | `/api/monitor/queues/:name/jobs/:id` | monitor.queue.remove |  |
| `AttendancePolicyController`（modules/oa/attendance/attendance-policy.controller.ts），全部：RequireFeature(oa) | GET | `/api/oa/attendance-policies/current` | oa.attendance-policy.view |  |
|  | PUT | `/api/oa/attendance-policies/current` | oa.attendance-policy.modify |  |
| `AttendanceSiteController`（modules/oa/attendance/attendance-site.controller.ts），全部：RequireFeature(oa) | GET | `/api/oa/attendance-sites/options` |  |  |
|  | GET | `/api/oa/attendance-sites` | oa.attendance-site.browse |  |
|  | GET | `/api/oa/attendance-sites/:id` | oa.attendance-site.view |  |
|  | POST | `/api/oa/attendance-sites` | oa.attendance-site.create | Idempotent |
|  | PUT | `/api/oa/attendance-sites/:id` | oa.attendance-site.modify |  |
|  | DELETE | `/api/oa/attendance-sites/:id` | oa.attendance-site.remove |  |
| `ClockController`（modules/oa/attendance/clock.controller.ts），全部：RequireFeature(oa) | POST | `/api/oa/clock-records/punch` |  | Idempotent |
|  | GET | `/api/oa/clock-records/today` |  |  |
|  | GET | `/api/oa/clock-records/requests/:requestId` |  |  |
|  | GET | `/api/oa/clock-records/mine` |  |  |
| `ClockQueryController`（modules/oa/attendance/clock-query.controller.ts），全部：RequireFeature(oa) | GET | `/api/oa/clock-records/admin` | oa.clock.browse |  |
|  | GET | `/api/oa/clock-records/admin/:id` | oa.clock.view |  |
|  | GET | `/api/oa/clock-records/mine/:id` |  |  |
| `ClockSummaryController`（modules/oa/attendance/clock-query.controller.ts），全部：RequireFeature(oa) | GET | `/api/oa/clock-summaries/mine` |  |  |
|  | GET | `/api/oa/clock-summaries` | oa.clock.browse |  |
| `ExpenseController`（modules/oa/expense/expense.controller.ts），全部：RequireFeature(workflow) | GET | `/api/oa/expense-claims` | oa.expense.browse |  |
|  | GET | `/api/oa/expense-claims/:id` |  |  |
|  | POST | `/api/oa/expense-claims` | oa.expense.create | Idempotent |
|  | PUT | `/api/oa/expense-claims/:id` | oa.expense.modify |  |
| `SealController`（modules/oa/seal/seal.controller.ts），全部：RequireFeature(workflow) | GET | `/api/oa/seal-requests` | oa.seal.browse |  |
|  | GET | `/api/oa/seal-requests/:id` |  |  |
|  | POST | `/api/oa/seal-requests` | oa.seal.create | Idempotent |
|  | PUT | `/api/oa/seal-requests/:id` | oa.seal.modify |  |
| `TripController`（modules/oa/trip/trip.controller.ts），全部：RequireFeature(workflow) | GET | `/api/oa/trips` | oa.trip.browse |  |
|  | GET | `/api/oa/trips/:id` |  |  |
|  | POST | `/api/oa/trips` | oa.trip.create | Idempotent |
|  | PUT | `/api/oa/trips/:id` | oa.trip.modify |  |
| `ClientController`（modules/platform/oauth/client/client.controller.ts），全部：PlatformOnly | GET | `/api/oauth/clients` | oauth.client.browse |  |
|  | GET | `/api/oauth/clients/:id` | oauth.client.view |  |
|  | POST | `/api/oauth/clients` | oauth.client.create | Idempotent |
|  | PUT | `/api/oauth/clients/:id` | oauth.client.modify |  |
|  | PUT | `/api/oauth/clients/:id/enabled` | oauth.client.modify |  |
|  | POST | `/api/oauth/clients/:id/secret` | oauth.client.reset-secret | Idempotent |
|  | DELETE | `/api/oauth/clients/:id` | oauth.client.remove |  |
|  | POST | `/api/oauth/clients/batch-delete` | oauth.client.remove |  |
| `ProviderController`（modules/platform/oauth/provider/provider.controller.ts） | GET | `/api/oauth2/authorize` |  | HomeTenant |
|  | POST | `/api/oauth2/authorize` |  | HomeTenant |
|  | GET | `/api/oauth2/userinfo` |  | OAuthScope(user.read) |
|  | POST | `/api/oauth2/token` |  | Public |
|  | POST | `/api/oauth2/introspect` |  | Public |
|  | POST | `/api/oauth2/revoke` |  | Public |
| `RunController`（modules/platform/scheduler/run/run.controller.ts），全部：PlatformOnly | GET | `/api/scheduler/runs` | scheduler.run.browse |  |
|  | GET | `/api/scheduler/runs/export` | scheduler.run.export |  |
|  | GET | `/api/scheduler/runs/:id` | scheduler.run.view |  |
|  | DELETE | `/api/scheduler/runs/:id` | scheduler.run.remove |  |
|  | POST | `/api/scheduler/runs/batch-delete` | scheduler.run.remove |  |
|  | POST | `/api/scheduler/runs/clean` | scheduler.run.remove |  |
| `TaskController`（modules/platform/scheduler/task/task.controller.ts），全部：PlatformOnly | GET | `/api/scheduler/tasks` | scheduler.task.browse |  |
|  | GET | `/api/scheduler/tasks/export` | scheduler.task.export |  |
|  | GET | `/api/scheduler/tasks/handlers` | scheduler.task.browse |  |
|  | GET | `/api/scheduler/tasks/next-fire-times` | scheduler.task.browse |  |
|  | GET | `/api/scheduler/tasks/:id` | scheduler.task.view |  |
|  | POST | `/api/scheduler/tasks` | scheduler.task.create | Idempotent |
|  | PUT | `/api/scheduler/tasks/:id` | scheduler.task.modify |  |
|  | PUT | `/api/scheduler/tasks/:id/enabled` | scheduler.task.modify |  |
|  | POST | `/api/scheduler/tasks/:id/run` | scheduler.task.run | Idempotent |
|  | DELETE | `/api/scheduler/tasks/:id` | scheduler.task.remove |  |
|  | POST | `/api/scheduler/tasks/batch-delete` | scheduler.task.remove |  |
| `SettingsReadController`（modules/platform/settings/settings-read.controller.ts） | GET | `/api/settings/dicts/:code/entries` |  |  |
|  | GET | `/api/settings/params/public/:key` |  | Public |
| `AppVersionController`（modules/platform/settings/app-version/app-version.controller.ts） | GET | `/api/settings/app-versions` | settings.appVersion.browse | PlatformOnly |
|  | GET | `/api/settings/app-versions/latest` |  | Public |
|  | GET | `/api/settings/app-versions/:id` | settings.appVersion.view | PlatformOnly |
|  | POST | `/api/settings/app-versions` | settings.appVersion.create | PlatformOnly, Idempotent |
|  | PUT | `/api/settings/app-versions/:id` | settings.appVersion.modify | PlatformOnly |
|  | PUT | `/api/settings/app-versions/:id/enabled` | settings.appVersion.modify | PlatformOnly |
|  | DELETE | `/api/settings/app-versions/:id` | settings.appVersion.remove | PlatformOnly |
|  | POST | `/api/settings/app-versions/batch-delete` | settings.appVersion.remove | PlatformOnly |
| `DictEntryController`（modules/platform/settings/dict-entry/dict-entry.controller.ts），全部：PlatformOnly | GET | `/api/settings/dict-entries` | settings.dictEntry.browse |  |
|  | GET | `/api/settings/dict-entries/export` | settings.dictEntry.export |  |
|  | GET | `/api/settings/dict-entries/:id` | settings.dictEntry.view |  |
|  | POST | `/api/settings/dict-entries` | settings.dictEntry.create | Idempotent |
|  | PUT | `/api/settings/dict-entries/:id` | settings.dictEntry.modify |  |
|  | PUT | `/api/settings/dict-entries/:id/enabled` | settings.dictEntry.modify |  |
|  | DELETE | `/api/settings/dict-entries/:id` | settings.dictEntry.remove |  |
|  | POST | `/api/settings/dict-entries/batch-delete` | settings.dictEntry.remove |  |
| `DictController`（modules/platform/settings/dict/dict.controller.ts） | GET | `/api/settings/dicts` | settings.dict.browse | PlatformOnly |
|  | GET | `/api/settings/dicts/export` | settings.dict.export | PlatformOnly |
|  | GET | `/api/settings/dicts/options` |  |  |
|  | POST | `/api/settings/dicts/refresh-cache` | settings.dict.modify | PlatformOnly |
|  | GET | `/api/settings/dicts/:id` | settings.dict.view | PlatformOnly |
|  | POST | `/api/settings/dicts` | settings.dict.create | PlatformOnly, Idempotent |
|  | PUT | `/api/settings/dicts/:id` | settings.dict.modify | PlatformOnly |
|  | PUT | `/api/settings/dicts/:id/enabled` | settings.dict.modify | PlatformOnly |
|  | DELETE | `/api/settings/dicts/:id` | settings.dict.remove | PlatformOnly |
|  | POST | `/api/settings/dicts/batch-delete` | settings.dict.remove | PlatformOnly |
| `ParameterController`（modules/platform/settings/param/param.controller.ts），全部：PlatformOnly | GET | `/api/settings/params` | settings.param.browse |  |
|  | GET | `/api/settings/params/export` | settings.param.export |  |
|  | POST | `/api/settings/params/refresh-cache` | settings.param.modify |  |
|  | GET | `/api/settings/params/:id` | settings.param.view |  |
|  | POST | `/api/settings/params` | settings.param.create | Idempotent |
|  | PUT | `/api/settings/params/:id` | settings.param.modify |  |
|  | DELETE | `/api/settings/params/:id` | settings.param.remove |  |
|  | POST | `/api/settings/params/batch-delete` | settings.param.remove |  |
| `StorageConfigController`（modules/platform/storage/config/config.controller.ts），全部：PlatformOnly | GET | `/api/storage/configs` | storage.config.browse |  |
|  | GET | `/api/storage/configs/:id` | storage.config.view |  |
|  | POST | `/api/storage/configs` | storage.config.create | Idempotent |
|  | PUT | `/api/storage/configs/:id` | storage.config.modify |  |
|  | PUT | `/api/storage/configs/:id/enabled` | storage.config.modify |  |
|  | PUT | `/api/storage/configs/:id/primary` | storage.config.modify |  |
|  | POST | `/api/storage/configs/:id/test` | storage.config.modify |  |
|  | DELETE | `/api/storage/configs/:id` | storage.config.remove |  |
|  | POST | `/api/storage/configs/batch-delete` | storage.config.remove |  |
| `StorageController`（modules/platform/storage/storage.controller.ts） | GET | `/api/storage/objects` | storage.object.browse |  |
|  | GET | `/api/storage/objects/export` | storage.object.export |  |
|  | GET | `/api/storage/objects/:id/metadata` |  |  |
|  | GET | `/api/storage/objects/:id` | storage.object.view |  |
|  | POST | `/api/storage/objects` |  | Idempotent |
|  | POST | `/api/storage/objects/presign` |  |  |
|  | POST | `/api/storage/objects/confirm` |  |  |
|  | GET | `/api/storage/objects/:id/download` |  |  |
|  | GET | `/api/storage/objects/:id/content` |  |  |
|  | DELETE | `/api/storage/objects/:id` | storage.object.remove |  |
| `WfAdminController`（modules/workflow/admin/wf-admin.controller.ts） | GET | `/api/wf/instances` | wf.instance.browse |  |
|  | GET | `/api/wf/tasks` | wf.task.browse |  |
|  | POST | `/api/wf/instances/:id/terminate` | wf.task.manage |  |
|  | POST | `/api/wf/tasks/:id/reassign` | wf.task.manage |  |
| `WfCenterController`（modules/workflow/center/wf-center.controller.ts），全部：RequireFeature(workflow) | GET | `/api/wf/users/options` |  |  |
|  | GET | `/api/wf/depts/options` |  |  |
|  | GET | `/api/wf/startable-models` |  |  |
|  | GET | `/api/wf/models/:key/start-info` |  |  |
|  | POST | `/api/wf/instances` |  | Idempotent |
|  | GET | `/api/wf/instances/mine` |  | HomeTenant |
|  | GET | `/api/wf/tasks/todo` |  | HomeTenant |
|  | GET | `/api/wf/tasks/done` |  | HomeTenant |
|  | GET | `/api/wf/ccs/mine` |  | HomeTenant |
|  | POST | `/api/wf/ccs/:id/read` |  | HomeTenant |
|  | GET | `/api/wf/instances/:id` |  |  |
| `WfRoutingController`（modules/workflow/center/wf-routing.controller.ts），全部：HomeTenant, RequireFeature(workflow) | POST | `/api/wf/tasks/:id/transfer` |  |  |
|  | POST | `/api/wf/tasks/:id/delegate` |  |  |
|  | POST | `/api/wf/tasks/:id/add-sign` |  |  |
|  | POST | `/api/wf/tasks/:id/remove-sign` |  |  |
|  | POST | `/api/wf/tasks/:id/cc` |  | Idempotent |
|  | POST | `/api/wf/tasks/:id/comment` |  | Idempotent |
|  | POST | `/api/wf/tasks/:id/withdraw` |  |  |
|  | POST | `/api/wf/instances/:id/cancel` |  |  |
|  | POST | `/api/wf/instances/:id/urge` |  |  |
| `WfFormController`（modules/workflow/form/wf-form.controller.ts） | GET | `/api/wf/forms` | wf.form.browse |  |
|  | GET | `/api/wf/forms/:id` | wf.form.view |  |
|  | POST | `/api/wf/forms` | wf.form.create | Idempotent |
|  | PUT | `/api/wf/forms/:id` | wf.form.modify |  |
|  | PUT | `/api/wf/forms/:id/enabled` | wf.form.modify |  |
|  | DELETE | `/api/wf/forms/:id` | wf.form.remove |  |
|  | POST | `/api/wf/forms/batch-delete` | wf.form.remove |  |
| `WfDataController`（modules/workflow/admin/wf-data.controller.ts） | GET | `/api/wf/models/:key/data` | wf.data.browse |  |
|  | GET | `/api/wf/models/:key/data/export` | wf.data.export |  |
| `WfModelController`（modules/workflow/model/wf-model.controller.ts） | GET | `/api/wf/models` | wf.model.browse / wf.data.browse |  |
|  | GET | `/api/wf/models/:id` | wf.model.view |  |
|  | GET | `/api/wf/models/:id/versions` | wf.model.view |  |
|  | GET | `/api/wf/models/:id/versions/:versionId` | wf.model.view |  |
|  | POST | `/api/wf/models` | wf.model.create | Idempotent |
|  | PUT | `/api/wf/models/sort` | wf.model.modify |  |
|  | PUT | `/api/wf/models/:id` | wf.model.modify |  |
|  | PUT | `/api/wf/models/:id/draft` | wf.model.modify |  |
|  | PUT | `/api/wf/models/:id/enabled` | wf.model.modify |  |
|  | POST | `/api/wf/models/:id/versions` | wf.model.publish | Idempotent |
|  | DELETE | `/api/wf/models/:id` | wf.model.remove |  |
| `WfTaskController`（modules/workflow/center/wf-task.controller.ts），全部：HomeTenant, RequireFeature(workflow) | GET | `/api/wf/tasks/:id/back-targets` |  |  |
|  | POST | `/api/wf/tasks/:id/approve` |  |  |
|  | POST | `/api/wf/tasks/:id/reject` |  |  |
|  | POST | `/api/wf/tasks/:id/send-back` |  |  |
|  | POST | `/api/wf/tasks/:id/resubmit` |  |  |
| `WxoaAccountController`（modules/platform/wxoa/account/account.controller.ts） | GET | `/api/wxoa/accounts` | wxoa.account.browse |  |
|  | GET | `/api/wxoa/accounts/options` | wxoa.account.browse / wxoa.message.browse / wxoa.reply.browse / wxoa.menu.browse / wxoa.fan.browse / wxoa.tag.browse / wxoa.material.browse / wxoa.template.browse / wxoa.qrcode.browse / wxoa.draft.browse / wxoa.publish.browse / wxoa.comment.browse / wxoa.mass.browse / wxoa.stat.browse / wxoa.notice.browse |  |
|  | GET | `/api/wxoa/accounts/:id` | wxoa.account.browse |  |
|  | POST | `/api/wxoa/accounts` | wxoa.account.create | Idempotent |
|  | PUT | `/api/wxoa/accounts/:id` | wxoa.account.modify |  |
|  | DELETE | `/api/wxoa/accounts/:id` | wxoa.account.remove |  |
|  | POST | `/api/wxoa/accounts/:id/test` | wxoa.account.modify |  |
|  | GET | `/api/wxoa/accounts/:id/quota` | wxoa.account.browse |  |
|  | POST | `/api/wxoa/accounts/:id/quota/clear` | wxoa.account.clear-quota |  |
| `WxoaCallbackController`（modules/platform/wxoa/callback/callback.controller.ts） | GET | `/api/wxoa/callback/:key` |  | Public |
|  | POST | `/api/wxoa/callback/:key` |  | Public |
| `WxoaCommentController`（modules/platform/wxoa/comment/comment.controller.ts） | GET | `/api/wxoa/comments` | wxoa.comment.browse |  |
|  | POST | `/api/wxoa/comments/open` | wxoa.comment.modify |  |
|  | POST | `/api/wxoa/comments/close` | wxoa.comment.modify |  |
|  | POST | `/api/wxoa/comments/:commentId/elect` | wxoa.comment.modify |  |
|  | DELETE | `/api/wxoa/comments/:commentId/elect` | wxoa.comment.modify |  |
|  | DELETE | `/api/wxoa/comments/:commentId` | wxoa.comment.remove |  |
|  | POST | `/api/wxoa/comments/:commentId/reply` | wxoa.comment.send | Idempotent |
|  | DELETE | `/api/wxoa/comments/:commentId/reply` | wxoa.comment.remove |  |
| `WxoaConversationController`（modules/platform/wxoa/message/message.controller.ts） | GET | `/api/wxoa/conversations` | wxoa.message.browse |  |
|  | GET | `/api/wxoa/conversations/:fanId/messages` | wxoa.message.browse |  |
|  | GET | `/api/wxoa/conversations/:fanId/window` | wxoa.message.browse |  |
| `WxoaDraftController`（modules/platform/wxoa/draft/draft.controller.ts） | GET | `/api/wxoa/drafts` | wxoa.draft.browse |  |
|  | GET | `/api/wxoa/drafts/:id` | wxoa.draft.browse |  |
|  | POST | `/api/wxoa/drafts` | wxoa.draft.create | Idempotent |
|  | PUT | `/api/wxoa/drafts/:id` | wxoa.draft.modify |  |
|  | DELETE | `/api/wxoa/drafts/:id` | wxoa.draft.remove |  |
|  | POST | `/api/wxoa/drafts/:id/sync` | wxoa.draft.sync | Idempotent |
|  | POST | `/api/wxoa/drafts/pull` | wxoa.draft.sync |  |
| `WxoaFanController`（modules/platform/wxoa/fan/fan.controller.ts） | GET | `/api/wxoa/fans` | wxoa.fan.browse |  |
|  | GET | `/api/wxoa/fans/export` | wxoa.fan.export |  |
|  | GET | `/api/wxoa/fans/sync` | wxoa.fan.browse |  |
|  | POST | `/api/wxoa/fans/sync` | wxoa.fan.sync |  |
|  | POST | `/api/wxoa/fans/tagging` | wxoa.fan.modify |  |
|  | POST | `/api/wxoa/fans/blocking` | wxoa.fan.modify |  |
|  | GET | `/api/wxoa/fans/:id` | wxoa.fan.browse |  |
|  | PUT | `/api/wxoa/fans/:id/remark` | wxoa.fan.modify |  |
| `WxoaMassController`（modules/platform/wxoa/mass/mass.controller.ts） | GET | `/api/wxoa/mass-jobs` | wxoa.mass.browse |  |
|  | GET | `/api/wxoa/mass-jobs/:id` | wxoa.mass.browse |  |
|  | POST | `/api/wxoa/mass-jobs` | wxoa.mass.send | Idempotent |
|  | POST | `/api/wxoa/mass-jobs/preview` | wxoa.mass.send | Idempotent |
|  | POST | `/api/wxoa/mass-jobs/:id/retry` | wxoa.mass.send | Idempotent |
|  | DELETE | `/api/wxoa/mass-jobs/:id` | wxoa.mass.remove |  |
| `WxoaMaterialController`（modules/platform/wxoa/material/material.controller.ts） | GET | `/api/wxoa/materials` | wxoa.material.browse |  |
|  | GET | `/api/wxoa/materials/counts` | wxoa.material.browse |  |
|  | GET | `/api/wxoa/materials/sync` | wxoa.material.browse |  |
|  | POST | `/api/wxoa/materials/sync` | wxoa.material.sync |  |
|  | POST | `/api/wxoa/materials` | wxoa.material.create | Idempotent |
|  | DELETE | `/api/wxoa/materials/:id` | wxoa.material.remove |  |
| `WxoaMenuController`（modules/platform/wxoa/menu/menu.controller.ts） | GET | `/api/wxoa/menus` | wxoa.menu.browse |  |
|  | POST | `/api/wxoa/menus/pull` | wxoa.menu.modify |  |
|  | POST | `/api/wxoa/menus/clear` | wxoa.menu.publish |  |
|  | POST | `/api/wxoa/menus/try-match` | wxoa.menu.browse |  |
|  | GET | `/api/wxoa/menus/:id` | wxoa.menu.browse |  |
|  | POST | `/api/wxoa/menus` | wxoa.menu.modify | Idempotent |
|  | PUT | `/api/wxoa/menus/:id` | wxoa.menu.modify |  |
|  | DELETE | `/api/wxoa/menus/:id` | wxoa.menu.modify |  |
|  | POST | `/api/wxoa/menus/:id/publish` | wxoa.menu.publish |  |
| `WxoaMessageController`（modules/platform/wxoa/message/message.controller.ts） | GET | `/api/wxoa/messages` | wxoa.message.browse |  |
|  | POST | `/api/wxoa/messages` | wxoa.message.send | Idempotent |
| `WxoaNoticeController`（modules/platform/wxoa/notice/notice.controller.ts） | GET | `/api/wxoa/notice-templates` | wxoa.notice.browse |  |
|  | GET | `/api/wxoa/notice-templates/library` | wxoa.notice.browse |  |
|  | POST | `/api/wxoa/notice-templates` | wxoa.notice.modify | Idempotent |
|  | DELETE | `/api/wxoa/notice-templates/:priTmplId` | wxoa.notice.modify |  |
|  | POST | `/api/wxoa/notice-templates/:priTmplId/send` | wxoa.notice.send | Idempotent |
| `WxoaPublishController`（modules/platform/wxoa/publish/publish.controller.ts） | GET | `/api/wxoa/publishes` | wxoa.publish.browse |  |
|  | GET | `/api/wxoa/publishes/:id` | wxoa.publish.browse |  |
|  | POST | `/api/wxoa/publishes` | wxoa.publish.create | Idempotent |
|  | POST | `/api/wxoa/publishes/pull` | wxoa.publish.create |  |
|  | DELETE | `/api/wxoa/publishes/:id` | wxoa.publish.remove |  |
| `WxoaQrcodeController`（modules/platform/wxoa/qrcode/qrcode.controller.ts） | GET | `/api/wxoa/qrcodes` | wxoa.qrcode.browse |  |
|  | POST | `/api/wxoa/qrcodes` | wxoa.qrcode.create | Idempotent |
|  | PUT | `/api/wxoa/qrcodes/:id` | wxoa.qrcode.modify |  |
|  | DELETE | `/api/wxoa/qrcodes/:id` | wxoa.qrcode.remove |  |
|  | GET | `/api/wxoa/qrcodes/:id/stats` | wxoa.qrcode.browse |  |
| `WxoaReplyRuleController`（modules/platform/wxoa/reply/reply-rule.controller.ts） | GET | `/api/wxoa/reply-rules` | wxoa.reply.browse |  |
|  | GET | `/api/wxoa/reply-rules/:id` | wxoa.reply.browse |  |
|  | POST | `/api/wxoa/reply-rules` | wxoa.reply.create | Idempotent |
|  | PUT | `/api/wxoa/reply-rules/:id` | wxoa.reply.modify |  |
|  | DELETE | `/api/wxoa/reply-rules/:id` | wxoa.reply.remove |  |
| `WxoaStatController`（modules/platform/wxoa/stat/stat.controller.ts） | GET | `/api/wxoa/stats/users` | wxoa.stat.browse |  |
|  | GET | `/api/wxoa/stats/messages` | wxoa.stat.browse |  |
|  | GET | `/api/wxoa/stats/interfaces` | wxoa.stat.browse |  |
|  | GET | `/api/wxoa/stats/articles` | wxoa.stat.browse |  |
| `WxoaTagController`（modules/platform/wxoa/fan/tag.controller.ts） | GET | `/api/wxoa/tags` | wxoa.tag.browse |  |
|  | POST | `/api/wxoa/tags/sync` | wxoa.fan.sync |  |
|  | POST | `/api/wxoa/tags` | wxoa.tag.create | Idempotent |
|  | PUT | `/api/wxoa/tags/:id` | wxoa.tag.modify |  |
|  | DELETE | `/api/wxoa/tags/:id` | wxoa.tag.remove |  |
| `WxoaTemplateController`（modules/platform/wxoa/template/template.controller.ts） | GET | `/api/wxoa/templates` | wxoa.template.browse |  |
|  | GET | `/api/wxoa/templates/industry` | wxoa.template.browse |  |
|  | DELETE | `/api/wxoa/templates/:templateId` | wxoa.template.remove |  |
|  | POST | `/api/wxoa/templates/:templateId/send` | wxoa.template.send | Idempotent |

## 权限码

| 常量 | 权限码 | 文件 |
| --- | --- | --- |
| `actionLogPerms` | audit.actionLog.browse, audit.actionLog.view, audit.actionLog.export, audit.actionLog.remove | shared:platform/audit/action-log.schema.ts |
| `agentAutomationPerms` | agent.automation.use, agent.automation.share | shared:platform/agent/agent.schema.ts |
| `agentPerms` | agent.chat.use, agent.batch.run, agent.skill.browse, agent.skill.create, agent.skill.modify, agent.skill.remove, agent.instruction.modify, agent.setting.browse, agent.setting.modify, agent.usage.browse | shared:platform/agent/agent.schema.ts |
| `appVersionPerms` | settings.appVersion.browse, settings.appVersion.view, settings.appVersion.create, settings.appVersion.modify, settings.appVersion.remove | shared:platform/settings/app-version.schema.ts |
| `attendancePolicyPerms` | oa.attendance-policy.view, oa.attendance-policy.modify | shared:oa/attendance.schema.ts |
| `attendanceSitePerms` | oa.attendance-site.browse, oa.attendance-site.view, oa.attendance-site.create, oa.attendance-site.modify, oa.attendance-site.remove | shared:oa/attendance.schema.ts |
| `bookPerms` | demo.book.browse, demo.book.view, demo.book.create, demo.book.modify, demo.book.remove, demo.book.export, demo.book.import | shared:demo/book.schema.ts |
| `bulletinPerms` | messaging.bulletin.browse, messaging.bulletin.view, messaging.bulletin.create, messaging.bulletin.modify, messaging.bulletin.remove, messaging.bulletin.publish | shared:platform/messaging/bulletin.schema.ts |
| `clientPerms` | oauth.client.browse, oauth.client.view, oauth.client.create, oauth.client.modify, oauth.client.remove, oauth.client.reset-secret | shared:platform/oauth/client.schema.ts |
| `clockPerms` | oa.clock.browse, oa.clock.view | shared:oa/attendance.schema.ts |
| `codegenPerms` | codegen.table.browse, codegen.table.view, codegen.table.import, codegen.table.modify, codegen.table.remove, codegen.table.generate, codegen.table.write | shared:platform/codegen/codegen-api.schema.ts |
| `configPerms` | storage.config.browse, storage.config.view, storage.config.create, storage.config.modify, storage.config.remove | shared:platform/storage/config.schema.ts |
| `customerPerms` | demo.customer.browse, demo.customer.view, demo.customer.create, demo.customer.modify, demo.customer.remove, demo.customer.export | shared:demo/customer.schema.ts |
| `demoRealtimePerms` | demo.realtime.send, demo.realtime.broadcast | shared:demo/realtime.schema.ts |
| `deptPerms` | iam.dept.browse, iam.dept.view, iam.dept.create, iam.dept.modify, iam.dept.remove | shared:platform/iam/dept.schema.ts |
| `dictEntryPerms` | settings.dictEntry.browse, settings.dictEntry.view, settings.dictEntry.create, settings.dictEntry.modify, settings.dictEntry.remove, settings.dictEntry.export | shared:platform/settings/dict-entry.schema.ts |
| `dictPerms` | settings.dict.browse, settings.dict.view, settings.dict.create, settings.dict.modify, settings.dict.remove, settings.dict.export | shared:platform/settings/dict.schema.ts |
| `geoPerms` | geo.area.browse | shared:platform/geo/geo.schema.ts |
| `httpFaultPerms` | audit.httpFault.browse, audit.httpFault.view, audit.httpFault.export, audit.httpFault.handle | shared:platform/audit/http-fault.schema.ts |
| `httpTracePerms` | audit.httpTrace.browse, audit.httpTrace.view, audit.httpTrace.export | shared:platform/audit/http-trace.schema.ts |
| `inboxPerms` | messaging.inbox.browse, messaging.inbox.view | shared:platform/messaging/inbox.schema.ts |
| `inboxTemplatePerms` | messaging.inboxTemplate.browse, messaging.inboxTemplate.view, messaging.inboxTemplate.create, messaging.inboxTemplate.modify, messaging.inboxTemplate.remove | shared:platform/messaging/inbox-template.schema.ts |
| `invoicePerms` | demo.invoice.browse, demo.invoice.view, demo.invoice.create, demo.invoice.modify, demo.invoice.remove | shared:demo/invoice.schema.ts |
| `leavePerms` | biz.leave.browse, biz.leave.create, biz.leave.modify | shared:biz/leave.schema.ts |
| `mailAccountPerms` | messaging.mailAccount.browse, messaging.mailAccount.view, messaging.mailAccount.create, messaging.mailAccount.modify, messaging.mailAccount.remove | shared:platform/messaging/mail-account.schema.ts |
| `mailRecordPerms` | messaging.mailRecord.browse, messaging.mailRecord.view | shared:platform/messaging/mail-record.schema.ts |
| `mailTemplatePerms` | messaging.mailTemplate.browse, messaging.mailTemplate.view, messaging.mailTemplate.create, messaging.mailTemplate.modify, messaging.mailTemplate.remove | shared:platform/messaging/mail-template.schema.ts |
| `mcpPerms` | mcp.tool.browse, mcp.tool.modify, mcp.token.browse, mcp.token.revoke | shared:platform/mcp/mcp.schema.ts |
| `menuPerms` | iam.menu.browse, iam.menu.view, iam.menu.create, iam.menu.modify, iam.menu.remove | shared:platform/iam/menu.schema.ts |
| `monitorPerms` | monitor.server.browse, monitor.redis.browse, monitor.cache.browse, monitor.cache.remove, monitor.mysql.browse, monitor.queue.browse, monitor.queue.retry, monitor.queue.remove | shared:platform/monitor/monitor.schema.ts |
| `oaExpensePerms` | oa.expense.browse, oa.expense.view, oa.expense.create, oa.expense.modify | shared:oa/expense.schema.ts |
| `oaSealPerms` | oa.seal.browse, oa.seal.view, oa.seal.create, oa.seal.modify | shared:oa/seal.schema.ts |
| `oaTripPerms` | oa.trip.browse, oa.trip.view, oa.trip.create, oa.trip.modify | shared:oa/trip.schema.ts |
| `paramPerms` | settings.param.browse, settings.param.view, settings.param.create, settings.param.modify, settings.param.remove, settings.param.export | shared:platform/settings/param.schema.ts |
| `positionPerms` | iam.position.browse, iam.position.view, iam.position.create, iam.position.modify, iam.position.remove, iam.position.export | shared:platform/iam/position.schema.ts |
| `rolePerms` | iam.role.browse, iam.role.view, iam.role.create, iam.role.modify, iam.role.remove, iam.role.export, iam.role.grant, iam.role.assign-users | shared:platform/iam/role.schema.ts |
| `runPerms` | scheduler.run.browse, scheduler.run.view, scheduler.run.export, scheduler.run.remove | shared:platform/scheduler/run.schema.ts |
| `sessionPerms` | iam.session.browse, iam.session.kick | shared:platform/iam/session.schema.ts |
| `signinLogPerms` | audit.signinLog.browse, audit.signinLog.view, audit.signinLog.export, audit.signinLog.remove, audit.signinLog.unlock | shared:platform/audit/signin-log.schema.ts |
| `smsChannelPerms` | messaging.smsChannel.browse, messaging.smsChannel.view, messaging.smsChannel.create, messaging.smsChannel.modify, messaging.smsChannel.remove | shared:platform/messaging/sms-channel.schema.ts |
| `smsRecordPerms` | messaging.smsRecord.browse, messaging.smsRecord.view | shared:platform/messaging/sms-record.schema.ts |
| `smsTemplatePerms` | messaging.smsTemplate.browse, messaging.smsTemplate.view, messaging.smsTemplate.create, messaging.smsTemplate.modify, messaging.smsTemplate.remove | shared:platform/messaging/sms-template.schema.ts |
| `storageObjectPerms` | storage.object.browse, storage.object.view, storage.object.export, storage.object.remove | shared:platform/storage/storage.schema.ts |
| `taskPerms` | scheduler.task.browse, scheduler.task.view, scheduler.task.create, scheduler.task.modify, scheduler.task.remove, scheduler.task.export, scheduler.task.run | shared:platform/scheduler/task.schema.ts |
| `tenantPackagePerms` | iam.tenantPackage.browse, iam.tenantPackage.view, iam.tenantPackage.create, iam.tenantPackage.modify, iam.tenantPackage.remove | shared:platform/iam/tenant-package.schema.ts |
| `tenantPerms` | iam.tenant.browse, iam.tenant.view, iam.tenant.create, iam.tenant.modify, iam.tenant.enter, iam.tenant.reset-password | shared:platform/iam/tenant.schema.ts |
| `topicPerms` | demo.topic.browse, demo.topic.view, demo.topic.create, demo.topic.modify, demo.topic.remove | shared:demo/topic.schema.ts |
| `userPerms` | iam.user.browse, iam.user.view, iam.user.create, iam.user.modify, iam.user.remove, iam.user.export, iam.user.import, iam.user.reset-password, iam.user.assign-roles | shared:platform/iam/user.schema.ts |
| `wfPerms` | wf.model.browse, wf.model.view, wf.model.create, wf.model.modify, wf.model.remove, wf.model.publish, wf.model.managers, wf.form.browse, wf.form.view, wf.form.create, wf.form.modify, wf.form.remove, wf.instance.browse, wf.instance.view, wf.task.browse, wf.task.manage, wf.data.browse, wf.data.export | shared:workflow/wf.schema.ts |
| `wxoaPerms` | wxoa.account.browse, wxoa.account.create, wxoa.account.modify, wxoa.account.remove, wxoa.account.clear-quota, wxoa.message.browse, wxoa.message.send, wxoa.reply.browse, wxoa.reply.create, wxoa.reply.modify, wxoa.reply.remove, wxoa.menu.browse, wxoa.menu.modify, wxoa.menu.publish, wxoa.fan.browse, wxoa.fan.modify, wxoa.fan.sync, wxoa.fan.export, wxoa.tag.browse, wxoa.tag.create, wxoa.tag.modify, wxoa.tag.remove, wxoa.material.browse, wxoa.material.create, wxoa.material.remove, wxoa.material.sync, wxoa.template.browse, wxoa.template.remove, wxoa.template.send, wxoa.qrcode.browse, wxoa.qrcode.create, wxoa.qrcode.modify, wxoa.qrcode.remove, wxoa.draft.browse, wxoa.draft.create, wxoa.draft.modify, wxoa.draft.remove, wxoa.draft.sync, wxoa.publish.browse, wxoa.publish.create, wxoa.publish.remove, wxoa.comment.browse, wxoa.comment.modify, wxoa.comment.send, wxoa.comment.remove, wxoa.mass.browse, wxoa.mass.send, wxoa.mass.remove, wxoa.stat.browse, wxoa.notice.browse, wxoa.notice.modify, wxoa.notice.send | shared:platform/wxoa/wxoa.schema.ts |

## 菜单路由名

| 路由名 | 类型 | 开关 | 种子文件 |
| --- | --- | --- | --- |
| `agent` | group | APP_AGENT | db/seeds/agent/agent.seed.ts |
| `agent-automation` | page |  | db/seeds/agent/agent.seed.ts |
| `agent-batch` | page |  | db/seeds/agent/agent.seed.ts |
| `agent-chat` | page |  | db/seeds/agent/agent.seed.ts |
| `agent-setting` | page |  | db/seeds/agent/agent.seed.ts |
| `agent-skill` | page |  | db/seeds/agent/agent.seed.ts |
| `agent-usage` | page |  | db/seeds/agent/agent.seed.ts |
| `audit` | group |  | db/seeds/audit/audit.seed.ts |
| `audit-action-log` | page |  | modules/platform/audit/action-log/action-log.seed.ts |
| `audit-http-fault` | page |  | modules/platform/audit/http-fault/http-fault.seed.ts |
| `audit-http-trace` | page |  | modules/platform/audit/http-trace/http-trace.seed.ts |
| `audit-signin-log` | page |  | modules/platform/audit/signin-log/signin-log.seed.ts |
| `biz` | group |  | db/seeds/iam/iam.seed.ts |
| `biz-leave` | page |  | db/seeds/workflow/menu.seed.ts |
| `biz-leave-new` | page |  | db/seeds/workflow/menu.seed.ts |
| `biz-leave-view` | page |  | db/seeds/workflow/menu.seed.ts |
| `codegen-table` | page |  | db/seeds/codegen/codegen.seed.ts |
| `codegen-table-edit` | page |  | db/seeds/codegen/codegen.seed.ts |
| `demo` | group |  | db/seeds/demo/demo.seed.ts |
| `demo-book` | page |  | modules/demo/book/book.seed.ts |
| `demo-customer` | page |  | modules/demo/customer/customer.seed.ts |
| `demo-invoice` | page |  | modules/demo/invoice/invoice.seed.ts |
| `demo-realtime` | page |  | modules/demo/realtime/realtime.seed.ts |
| `demo-topic` | page |  | modules/demo/topic/topic.seed.ts |
| `devtools` | group |  | db/seeds/codegen/codegen.seed.ts |
| `devtools-api-docs` | page | SWAGGER_ENABLED | db/seeds/codegen/codegen.seed.ts |
| `formkit-design` | page |  | db/seeds/codegen/codegen.seed.ts |
| `geo-area` | page |  | modules/platform/geo/geo.seed.ts |
| `home` | page |  | db/seeds/iam/iam.seed.ts |
| `iam-dept` | page |  | modules/platform/iam/dept/dept.seed.ts |
| `iam-menu` | page |  | modules/platform/iam/menu/menu.seed.ts |
| `iam-position` | page |  | modules/platform/iam/position/position.seed.ts |
| `iam-role` | page |  | modules/platform/iam/role/role.seed.ts |
| `iam-role-users` | page |  | modules/platform/iam/role/role.seed.ts |
| `iam-session` | page |  | modules/platform/iam/session/session.seed.ts |
| `iam-tenant` | page | APP_MULTI_TENANT | db/seeds/iam/tenant-menus.seed.ts |
| `iam-tenant-package` | page | APP_MULTI_TENANT | db/seeds/iam/tenant-menus.seed.ts |
| `iam-user` | page |  | modules/platform/iam/user/user.seed.ts |
| `iam-user-roles` | page |  | modules/platform/iam/user/user.seed.ts |
| `mcp-token` | page | APP_MCP | db/seeds/mcp/mcp.seed.ts |
| `mcp-tool` | page | APP_MCP | db/seeds/mcp/mcp.seed.ts |
| `messaging` | group |  | db/seeds/messaging/messaging.seed.ts |
| `messaging-bulletin` | page |  | modules/platform/messaging/bulletin/bulletin.seed.ts |
| `messaging-inbox` | page |  | modules/platform/messaging/inbox/inbox.seed.ts |
| `messaging-inbox-template` | page |  | modules/platform/messaging/inbox-template/inbox-template.seed.ts |
| `messaging-mail-account` | page |  | modules/platform/messaging/mail-account/mail-account.seed.ts |
| `messaging-mail-record` | page |  | modules/platform/messaging/mail-record/mail-record.seed.ts |
| `messaging-mail-template` | page |  | modules/platform/messaging/mail-template/mail-template.seed.ts |
| `messaging-sms-channel` | page |  | modules/platform/messaging/sms-channel/sms-channel.seed.ts |
| `messaging-sms-record` | page |  | modules/platform/messaging/sms-record/sms-record.seed.ts |
| `messaging-sms-template` | page |  | modules/platform/messaging/sms-template/sms-template.seed.ts |
| `monitor` | group |  | db/seeds/monitor/monitor.seed.ts |
| `monitor-cache` | page |  | modules/platform/monitor/monitor.seed.ts |
| `monitor-mysql` | page |  | modules/platform/monitor/monitor.seed.ts |
| `monitor-queue` | page |  | modules/platform/monitor/monitor.seed.ts |
| `monitor-redis` | page |  | modules/platform/monitor/monitor.seed.ts |
| `monitor-server` | page |  | modules/platform/monitor/monitor.seed.ts |
| `oa` | group |  | db/seeds/project/menu-groups.seed.ts |
| `oa-attendance-policy` | page |  | db/seeds/project/oa-attendance-pages.seed.ts |
| `oa-attendance-sites` | page |  | db/seeds/project/oa-attendance-pages.seed.ts |
| `oa-clock-records` | page |  | db/seeds/project/oa-attendance-pages.seed.ts |
| `oauth-client` | page |  | modules/platform/oauth/client/client.seed.ts |
| `scheduler-run` | page |  | modules/platform/scheduler/run/run.seed.ts |
| `scheduler-task` | page |  | modules/platform/scheduler/task/task.seed.ts |
| `settings-app-version` | page |  | modules/platform/settings/app-version/app-version.seed.ts |
| `settings-dict` | page |  | modules/platform/settings/dict/dict.seed.ts |
| `settings-dict-entry` | page |  | modules/platform/settings/dict-entry/dict-entry.seed.ts |
| `settings-param` | page |  | modules/platform/settings/param/param.seed.ts |
| `storage` | group |  | db/seeds/storage/storage.seed.ts |
| `storage-config` | page |  | modules/platform/storage/config/config.seed.ts |
| `storage-object` | page |  | modules/platform/storage/object.seed.ts |
| `system` | group |  | db/seeds/iam/iam.seed.ts |
| `wf-admin` | group |  | db/seeds/workflow/menu.seed.ts |
| `wf-cc` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-data` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-done` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-form` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-instance` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-instance-detail` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-instance-view` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-mine` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-model` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-model-design` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-start` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-task` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-todo` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-wizard` | page |  | db/seeds/workflow/menu.seed.ts |
| `wf-wizard-edit` | page |  | db/seeds/workflow/menu.seed.ts |
| `workflow` | group |  | db/seeds/workflow/menu.seed.ts |
| `wxoa` | group | APP_WXOA | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-account` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-chat` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-draft` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-fan` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-mass` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-material` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-menu` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-message` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-notice` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-publish` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-qrcode` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-reply` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-stat` | page |  | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa-template` | page |  | db/seeds/wxoa/wxoa.seed.ts |

## 字典码

| 字典码 | 取值 | 种子文件 |
| --- | --- | --- |
| `audit.fault_state` | open, resolved, ignored | db/seeds/audit/audit.seed.ts |
| `audit.signin_kind` | password, sms, wx-mp, signout, kicked, refresh_reuse, locked | db/seeds/audit/audit.seed.ts |
| `audit.user_type` | admin, member | db/seeds/audit/audit.seed.ts |
| `audit.verb` | create, modify, remove, import, export, upload, grant, revoke, reset-password, reset-password-sms, reset-secret, signup, kick, change-password, change-avatar, unbind, refresh-cache, publish, clean, unlock, …（共 46 项） | db/seeds/audit/audit.seed.ts |
| `biz.leave_kind` | annual, personal, sick, compensatory, marriage, maternity, paternity, bereavement | db/seeds/workflow/workflow.seed.ts |
| `biz.leave_state` | draft, in_review, approved, rejected, canceled | db/seeds/workflow/workflow.seed.ts |
| `core.enabled` | true, false | db/seeds/settings/settings.seed.ts |
| `core.locale` | zh-CN, en-US | db/seeds/settings/settings.seed.ts |
| `core.yes_no` | true, false | db/seeds/settings/settings.seed.ts |
| `demo.genre` | fiction, science, history, technology, children | db/seeds/demo/demo.seed.ts |
| `demo.invoice_state` | draft, issued, void | db/seeds/demo/demo.seed.ts |
| `iam.data_scope` | all, picked_depts, own_dept, own_dept_tree, own_rows | db/seeds/settings/settings.seed.ts |
| `iam.gender` | male, female, unknown | db/seeds/settings/settings.seed.ts |
| `iam.menu_kind` | group, page, action | db/seeds/settings/settings.seed.ts |
| `iam.menu_link_type` | route, iframe, external | db/seeds/settings/settings.seed.ts |
| `messaging.bulletin_kind` | notice, announcement | db/seeds/messaging/messaging.seed.ts |
| `messaging.inbox_category` | system, business | db/seeds/messaging/messaging.seed.ts |
| `messaging.inbox_status` | pending, sending, delivered, failed | db/seeds/messaging/messaging.seed.ts |
| `messaging.mail_record_status` | pending, sending, sent, failed, skipped | db/seeds/messaging/delivery.seed.ts |
| `messaging.mail_security` | ssl, starttls, none | db/seeds/messaging/delivery.seed.ts |
| `messaging.sms_driver` | aliyun, tencent, debug | db/seeds/messaging/delivery.seed.ts |
| `messaging.sms_purpose` | otp, notice, promo | db/seeds/messaging/delivery.seed.ts |
| `messaging.sms_receipt_status` | delivered, failed | db/seeds/messaging/delivery.seed.ts |
| `messaging.sms_record_status` | pending, sending, sent, failed, skipped | db/seeds/messaging/delivery.seed.ts |
| `oa.expense_kind` | transport, lodging, meal, office, other | db/seeds/project/oa.seed.ts |
| `oa.request_state` | draft, in_review, approved, rejected, canceled | db/seeds/project/oa.seed.ts |
| `oa.seal_kind` | company, contract, finance, other | db/seeds/project/oa.seed.ts |
| `scheduler.job_group` | default, system | db/seeds/scheduler/scheduler.seed.ts |
| `scheduler.misfire` | skip, run_once | db/seeds/scheduler/scheduler.seed.ts |
| `scheduler.run_outcome` | ok, failed, skipped, timeout | db/seeds/scheduler/scheduler.seed.ts |
| `settings.app_package_kind` | wgt, full | db/seeds/settings/settings.seed.ts |
| `settings.app_platform` | android, ios | db/seeds/settings/settings.seed.ts |
| `settings.tag_type` | primary, success, info, warning, danger | db/seeds/settings/settings.seed.ts |
| `wf.action` | begin, resubmit, approve, reject, send_back, transfer, delegate, add_sign, remove_sign, cc, cancel, withdraw, terminate, reassign, comment, urge, timeout | db/seeds/workflow/workflow.seed.ts |
| `wf.category` | hr, finance, admin, other | db/seeds/workflow/workflow.seed.ts |
| `wf.instance_state` | running, approved, rejected, canceled, terminated | db/seeds/workflow/workflow.seed.ts |
| `wf.task_state` | waiting, pending, approved, rejected, transferred, delegated, canceled, sent_back, withdrawn | db/seeds/workflow/workflow.seed.ts |
| `wxoa.account_kind` | service, subscription, sandbox | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.button_kind` | click, view, miniprogram, scancode_push, scancode_waitmsg, pic_sysphoto, pic_photo_or_album, pic_weixin, location_select, article_id, article_view_limited, media_id, view_limited | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.channel` | push, passive, cs, template, preview, notice | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.client_platform` | ios, android, other | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.crypto_mode` | plain, compat, secure | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.mass_state` | submitted, succeeded, failed, removed | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.mass_target` | all, tag, openids | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.match_mode` | exact, contains | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.media_kind` | image, voice, video, thumb | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.msg_kind` | text, image, voice, video, shortvideo, location, link, event, music, news, template | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.publish_state` | publishing, succeeded, failed, removed | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.qr_kind` | temporary, permanent | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.reply_kind` | text, image, voice, video, music, news | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.reply_trigger` | subscribe, keyword, default, click, scan | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.send_state` | pending, sent, delivered, failed, user_blocked | db/seeds/wxoa/wxoa.seed.ts |

## 系统参数

| 参数键 | 种子文件 |
| --- | --- |
| `agent.instructions` | db/seeds/settings/settings.seed.ts |
| `agent.limit.automation_runs_per_day` | db/seeds/settings/settings.seed.ts |
| `agent.limit.automations_per_user` | db/seeds/settings/settings.seed.ts |
| `agent.limit.research_seconds` | db/seeds/settings/settings.seed.ts |
| `agent.limit.research_steps` | db/seeds/settings/settings.seed.ts |
| `agent.limit.tenant_daily_tokens` | db/seeds/settings/settings.seed.ts |
| `agent.limit.turn_seconds` | db/seeds/settings/settings.seed.ts |
| `agent.limit.turn_steps` | db/seeds/settings/settings.seed.ts |
| `agent.limit.turn_tokens` | db/seeds/settings/settings.seed.ts |
| `agent.limit.user_concurrent_turns` | db/seeds/settings/settings.seed.ts |
| `agent.limit.user_daily_tokens` | db/seeds/settings/settings.seed.ts |
| `agent.memory.extract` | db/seeds/settings/settings.seed.ts |
| `agent.memory.per_turn` | db/seeds/settings/settings.seed.ts |
| `agent.paused` | db/seeds/settings/settings.seed.ts |
| `agent.review.model` | db/seeds/settings/settings.seed.ts |
| `agent.trust_mode` | db/seeds/settings/settings.seed.ts |
| `agent.web.allowed_domains` | db/seeds/settings/settings.seed.ts |
| `agent.web.mode` | db/seeds/settings/settings.seed.ts |
| `app.update.enabled` | db/seeds/settings/settings.seed.ts |
| `app.update.review_version` | db/seeds/settings/settings.seed.ts |
| `audit.http_trace.exclude_paths` | db/seeds/settings/settings.seed.ts |
| `audit.http_trace.mode` | db/seeds/settings/settings.seed.ts |
| `audit.retention_days` | db/seeds/settings/settings.seed.ts |
| `auth.cross_ip_threshold` | db/seeds/settings/settings.seed.ts |
| `auth.ip_blacklist` | db/seeds/settings/settings.seed.ts |
| `auth.lock_minutes` | db/seeds/settings/settings.seed.ts |
| `auth.lock_threshold` | db/seeds/settings/settings.seed.ts |
| `auth.signup.default_dept_id` | db/seeds/settings/settings.seed.ts |
| `auth.signup.default_role_id` | db/seeds/settings/settings.seed.ts |
| `auth.signup.enabled` | db/seeds/settings/settings.seed.ts |
| `auth.wx_mp.enabled` | db/seeds/settings/settings.seed.ts |
| `captcha.image_type` | db/seeds/settings/settings.seed.ts |
| `captcha.mode` | db/seeds/settings/settings.seed.ts |
| `core.default_timezone` | db/seeds/settings/settings.seed.ts |
| `excel.import_max_columns` | db/seeds/settings/settings.seed.ts |
| `excel.import_max_mb` | db/seeds/settings/settings.seed.ts |
| `excel.import_max_rows` | db/seeds/settings/settings.seed.ts |
| `iam.password_char_classes` | db/seeds/settings/settings.seed.ts |
| `iam.password_expire_days` | db/seeds/settings/settings.seed.ts |
| `iam.password_min_length` | db/seeds/settings/settings.seed.ts |
| `iam.user.initial_password` | db/seeds/iam/iam.seed.ts |
| `mcp.paused` | db/seeds/settings/settings.seed.ts |
| `notify.wx_subscribe.enabled` | db/seeds/settings/settings.seed.ts |
| `notify.wx_subscribe.templates` | db/seeds/settings/settings.seed.ts |
| `oauth.consent_ttl_days` | db/seeds/oauth/oauth.seed.ts |
| `sms.otp.cooldown_sec` | db/seeds/messaging/delivery.seed.ts |
| `sms.otp.global_daily_max` | db/seeds/messaging/delivery.seed.ts |
| `sms.otp.ip_daily_max` | db/seeds/messaging/delivery.seed.ts |
| `sms.otp.mobile_daily_max` | db/seeds/messaging/delivery.seed.ts |
| `sms.otp.user_daily_max` | db/seeds/messaging/delivery.seed.ts |
| `storage.allowed_exts` | db/seeds/storage/storage.seed.ts |
| `storage.max_size_mb` | db/seeds/storage/storage.seed.ts |
| `wxoa.media.copy_inbound` | db/seeds/wxoa/wxoa.seed.ts |
| `wxoa.message.retention_days` | db/seeds/wxoa/wxoa.seed.ts |

## 队列

| 队列 | 登记位置 | 处理器 |
| --- | --- | --- |
| `agent-automation` | core/agent/agent.module.ts | AgentAutomationProcessor（core/agent/automation/automation.processor.ts） |
| `agent-cleanup` | core/agent/agent.module.ts | AgentCleanupProcessor（core/agent/runtime/turn.processor.ts） |
| `agent-memory` | core/agent/memory/agent-memory.module.ts | AgentMemoryProcessor（core/agent/memory/memory-extract.ts） |
| `agent-turn` | core/agent/agent.module.ts | AgentTurnProcessor（core/agent/runtime/turn.processor.ts） |

## 定时任务处理器

| 处理器名 | 方法 | 文件 |
| --- | --- | --- |
| `audit.purge` | BuiltinJobs.purge | modules/platform/scheduler/builtin-jobs.ts |
| `demo.echo` | BuiltinJobs.echo | modules/platform/scheduler/builtin-jobs.ts |
| `notify.dispatch` | NotifyDispatcher.dispatch | core/notify/notify.ts |
| `oa.clock.retention` | ClockRetentionJob.run | modules/oa/attendance/clock-retention.job.ts |
| `session.sweep` | BuiltinJobs.sweep | modules/platform/scheduler/builtin-jobs.ts |
| `wf.task.remind` | WfRemind.remind | modules/workflow/runtime/wf-remind.ts |
| `wxoa.fan.sync` | WxoaFanService.nightly | modules/platform/wxoa/fan/fan.service.ts |
| `wxoa.message.purge` | WxoaMessageService.purge | modules/platform/wxoa/message/message.service.ts |

## MCP 工具

| 工具名 | 类型 | 权限 | 方法 | 文件 |
| --- | --- | --- | --- | --- |
| `cfg.dict.options` | read | （只需登录） | SettingsMcpTools.options | modules/platform/settings/settings.mcp-tools.ts |
| `demo.book.create` | write | `demo.book.create` | BookMcpTools.create | modules/demo/book/book.mcp-tools.ts |
| `demo.customer.get` | read | `demo.customer.view` | CustomerMcpTools.get | modules/demo/customer/customer.mcp-tools.ts |
| `demo.customer.search` | read | `demo.customer.browse` | CustomerMcpTools.search | modules/demo/customer/customer.mcp-tools.ts |
| `demo.customer.update` | write | `demo.customer.modify` | CustomerMcpTools.update | modules/demo/customer/customer.mcp-tools.ts |
| `iam.me.get` | read | （只需登录） | ProfileMcpTools.me | modules/platform/iam/profile/profile.mcp-tools.ts |
| `iam.user.search` | read | `iam.user.browse` | UserMcpTools.search | modules/platform/iam/user/user.mcp-tools.ts |
| `oa.application.get` | read | （只需登录） | OaAgentTools.get | modules/oa/agent/oa-agent.tools.ts |
| `oa.application.options` | read | （只需登录） | OaAgentTools.options | modules/oa/agent/oa-agent.tools.ts |
| `oa.expense.apply` | write | `oa.expense.create` | OaAgentTools.expense | modules/oa/agent/oa-agent.tools.ts |
| `oa.generic.apply` | write | （只需登录） | OaAgentTools.generic | modules/oa/agent/oa-agent.tools.ts |
| `oa.leave.apply` | write | `biz.leave.create` | OaAgentTools.leave | modules/oa/agent/oa-agent.tools.ts |
| `oa.seal.apply` | write | `oa.seal.create` | OaAgentTools.seal | modules/oa/agent/oa-agent.tools.ts |
| `oa.task.todo` | read | （只需登录） | OaAgentTools.todo | modules/oa/agent/oa-agent.tools.ts |
| `oa.trip.apply` | write | `oa.trip.create` | OaAgentTools.trip | modules/oa/agent/oa-agent.tools.ts |
