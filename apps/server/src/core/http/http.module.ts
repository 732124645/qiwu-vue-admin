import { Module } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { EnvelopeInterceptor } from './envelope.interceptor.js'
import { HttpErrorFilter } from './http-error.filter.js'
import { ZodValidationPipe } from './validation.pipe.js'

/**
 * Global zod validation pipe (see docs/adr/003-validation.md), success envelope interceptor and error envelope filter
 * (see docs/design-notes.md#api-envelope). Needs CoreI18nModule (global).
 */
@Module({
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class CoreHttpModule {}
