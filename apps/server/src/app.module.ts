import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { CoreAuditModule } from './core/audit/audit.module.js'
import { CoreAuthModule } from './core/auth/auth.module.js'
import { CoreCaptchaModule } from './core/captcha/captcha.module.js'
import { CoreConfigModule } from './core/config/config.module.js'
import { CoreContextModule } from './core/context/context.module.js'
import { CoreCryptoModule } from './core/crypto/secret-box.js'
import { CoreDbModule } from './core/db/db.module.js'
import { CoreExcelModule } from './core/excel/excel.module.js'
import { CoreThrottlerModule } from './core/guard/throttler.module.js'
import { HealthController } from './core/health/health.controller.js'
import { CoreHttpModule } from './core/http/http.module.js'
import { CoreI18nModule } from './core/i18n/i18n.module.js'
import { CoreLoggerModule } from './core/logger/logger.module.js'
import { CoreNotifyModule } from './core/notify/notify.js'
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
import { StorageModule } from './modules/platform/storage/storage.module.js'
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
    CoreI18nModule,
    CoreThrottlerModule,
    CoreHttpModule,
    // HealthController's DB/Redis checks
    TerminusModule,
    SettingsModule,
    StorageModule,
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
