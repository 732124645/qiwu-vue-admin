import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  StandardSchemaValidationPipe,
} from '@nestjs/common'
import { fieldDomainOf } from '@qiwu/shared'
import type { z } from 'zod'

/** 400 carrying the raw zod issues; `HttpErrorFilter` translates them for the request language. */
export class ValidationException extends BadRequestException {
  /** Field-label domain of the failed schema (`field.<domain>.<prop>`), if it registered one. */
  domain?: string

  constructor(readonly issues: readonly z.core.$ZodIssue[]) {
    super('Validation failed')
  }
}

/**
 * `schema.parse` whose failure is the 400 of a request body (translated field messages): for values a
 * service checks itself (bodies under runtime settings, generator config, a row as a write leaves it).
 */
export function parseOr400<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  const e = new ValidationException(r.error.issues)
  e.domain = fieldDomainOf(schema)
  throw e
}

/**
 * Global pipe (see docs/adr/003-validation.md): validates `@Body/@Query/@Param({ schema })` with Nest's Standard Schema pipe and
 * returns the parsed value (coerced, defaulted, stripped). Params without a schema pass through unchanged.
 */
@Injectable()
export class ZodValidationPipe extends StandardSchemaValidationPipe {
  constructor() {
    // zod is the only schema vendor (see docs/adr/003-validation.md): its Standard Schema issues are full zod issues
    super({ exceptionFactory: (issues) => new ValidationException(issues as z.core.$ZodIssue[]) })
  }

  override async transform<T = unknown>(value: T, metadata: ArgumentMetadata): Promise<T> {
    try {
      return await super.transform(value, metadata)
    } catch (e) {
      if (e instanceof ValidationException) e.domain = fieldDomainOf(metadata.schema)
      throw e
    }
  }
}
