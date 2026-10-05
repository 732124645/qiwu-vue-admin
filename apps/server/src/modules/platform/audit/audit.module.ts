import { Module } from '@nestjs/common'
import { ActionLogModule } from './action-log/action-log.module.js'
import { HttpFaultModule } from './http-fault/http-fault.module.js'
import { HttpTraceModule } from './http-trace/http-trace.module.js'
import { SigninLogModule } from './signin-log/signin-log.module.js'

/** The audit log pages (API logs); the logs are written by core/audit (AuditWriter). */
@Module({ imports: [ActionLogModule, SigninLogModule, HttpTraceModule, HttpFaultModule] })
export class AuditModule {}
