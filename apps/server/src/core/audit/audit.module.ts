import { Global, Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { AuditWriter } from './audit-writer.js'
import { HttpTraceInterceptor } from './http-trace.js'

/**
 * AuditWriter for every module (sign-in log, `@ActionLog`, the error filter's API error log) and the
 * global API access log (HttpTraceInterceptor); needs CoreDbModule and CoreSettingsModule (the mode).
 */
@Global()
@Module({
  providers: [AuditWriter, { provide: APP_INTERCEPTOR, useClass: HttpTraceInterceptor }],
  exports: [AuditWriter],
})
export class CoreAuditModule {}
