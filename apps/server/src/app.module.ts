import { Module } from '@nestjs/common'
import { ConditionalModule } from '@nestjs/config'
import { TerminusModule } from '@nestjs/terminus'
import { CoreAuditModule } from './core/audit/audit.module.js'
import { AgentModule } from './core/agent/agent.module.js'
import { CoreAuthModule } from './core/auth/auth.module.js'
import { CoreCaptchaModule } from './core/captcha/captcha.module.js'
import { agentOn } from './core/config/agent-switch.js'
import { CoreConfigModule } from './core/config/config.module.js'
import { mcpOn } from './core/config/mcp-switch.js'
import { wxoaOn } from './core/config/wxoa-switch.js'
import { CoreContextModule } from './core/context/context.module.js'
import { CoreCryptoModule } from './core/crypto/secret-box.js'
import { CoreDbModule } from './core/db/db.module.js'
import { CoreExcelModule } from './core/excel/excel.module.js'
import { CoreThrottlerModule } from './core/guard/throttler.module.js'
import { HealthController } from './core/health/health.controller.js'
import { CoreHttpModule } from './core/http/http.module.js'
import { CoreI18nModule } from './core/i18n/i18n.module.js'
import { CoreLoggerModule } from './core/logger/logger.module.js'
import { CoreMonitorModule } from './core/monitor/event-loop.js'
import { McpModule } from './core/mcp/mcp.module.js'
import { CoreMcpTokenModule } from './core/mcp/token-revocation.js'
import { CoreNotifyModule } from './core/notify/notify.js'
import { CoreQueueModule } from './core/queue/queue.module.js'
import { CoreRealtimeModule } from './core/realtime/realtime.module.js'
import { CoreRedisModule } from './core/redis/redis.module.js'
import { CoreSettingsModule } from './core/settings/settings.module.js'
import { AuditModule } from './modules/platform/audit/audit.module.js'
import { CodegenModule } from './modules/platform/codegen/codegen.module.js'
import { GeoModule } from './modules/platform/geo/geo.module.js'
import { IamModule } from './modules/platform/iam/iam.module.js'
import { MessagingModule } from './modules/platform/messaging/messaging.module.js'
import { MonitorModule } from './modules/platform/monitor/monitor.module.js'
import { OauthModule } from './modules/platform/oauth/oauth.module.js'
import { SchedulerModule } from './modules/platform/scheduler/scheduler.module.js'
import { SettingsModule } from './modules/platform/settings/settings.module.js'
import { AgentAttachmentsModule } from './modules/platform/storage/agent-attachments.js'
import { StorageModule } from './modules/platform/storage/storage.module.js'
import { WxoaModule } from './modules/platform/wxoa/wxoa.module.js'
import { ProjectModule } from './modules/project.module.js'
import { WorkflowModule } from './modules/workflow/workflow.module.js'

@Module({
  imports: [
    // first: validates env before anything reads it
    CoreConfigModule.forRoot(),
    CoreContextModule,
    // SecretBox (third-party secrets at rest, from APP_SECRET)
    CoreCryptoModule,
    // TypeORM DataSource + @Transactional() (CLS plugin): after CoreContextModule
    CoreDbModule,
    CoreRedisModule,
    // BullMQ job queues on the shared Redis client (workers run on every instance but APP_ROLE=api ones)
    CoreQueueModule,
    // AuditWriter (sign-in log, @ActionLog): needs the DataSource
    CoreAuditModule,
    // dict/param reads with Redis caches (core: Excel, notifications and auth need them too)
    CoreSettingsModule,
    // exports, import templates and imports (dict labels, params, i18n headers)
    CoreExcelModule,
    // global AuthGuard → PermGuard; iam supplies the UserLookup port (see docs/design-notes.md#layering)
    CoreAuthModule.forRoot(IamModule),
    // Socket.IO pushes; SessionRevoker ends the sockets of revoked sessions through it
    CoreRealtimeModule,
    // Outbox notification ports for messaging channels
    CoreNotifyModule,
    // Single-use captcha ticket verifier for auth and SMS
    CoreCaptchaModule,
    CoreLoggerModule,
    CoreMonitorModule,
    CoreI18nModule,
    CoreThrottlerModule,
    CoreHttpModule,
    // HealthController's DB/Redis checks
    TerminusModule,
    SettingsModule,
    StorageModule,
    // 智能体消息附件的读取（全局令牌 ATTACHMENT_SOURCE）；智能体关闭时无人注入，不影响别的
    AgentAttachmentsModule,
    // 公众号模块只在 APP_WXOA 打开时加载：关闭时不注册路由、任务与回调，也不访问微信；
    // 条件在 ConfigModule 把环境文件写入 process.env 之后才读取
    ConditionalModule.registerWhen(WxoaModule, (env) => wxoaOn(env), { debug: false }),
    // access tokens end with their user's or tenant's sessions whatever APP_MCP says
    CoreMcpTokenModule,
    // 智能体接入只在 APP_MCP 打开时加载：关闭时 /api/mcp 与其管理接口不存在，工具不注册
    ConditionalModule.registerWhen(McpModule, (env) => mcpOn(env), { debug: false }),
    // 后台智能体只在 APP_AGENT 打开时加载：与 MCP 共用工具注册表与护栏，但 APP_MCP 关着时 /api/mcp 仍不存在
    ConditionalModule.registerWhen(AgentModule, (env) => agentOn(env), { debug: false }),
    SchedulerModule,
    MessagingModule,
    AuditModule,
    MonitorModule,
    CodegenModule,
    GeoModule,
    OauthModule,
    WorkflowModule,
    ProjectModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
