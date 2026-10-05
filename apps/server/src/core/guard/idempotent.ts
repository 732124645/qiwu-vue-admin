import { createHash, randomUUID } from 'node:crypto'
import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Err } from '@qiwu/shared'
import type { Request } from 'express'
import { tap } from 'rxjs'
import { clsGet } from '../context/cls.js'
import { BizError } from '../http/biz-error.js'
import type { UploadedFileData } from '../http/upload.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'

const IDEMPOTENT_TTL = 'qw:guard:idempotent'

/** Deletes KEYS[1] only while it still holds this request's token ARGV[1] (compare-and-delete). */
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

/** JSON with object keys sorted at every level: `{b,a}` and `{a,b}` are the same submission. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value ?? null, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  )

/**
 * Duplicate-submit guard (see docs/design-notes.md#security): the first request takes
 * `idem:{sid}:{sha256(method + url + canonical body)}` with SET NX PX ttl; the same request again within
 * ttl → 429 `too_many_requests`. A failed request releases its key, so a retry is not a duplicate; the
 * key holds a random owner token and is released only while it still holds it, so a request that fails
 * after its ttl never frees the key a later request took.
 * Runs after the guards (so `sid` is known) and before validation; callers without a session are
 * keyed by IP. On an upload route put it above `@UploadFile` so multer has parsed the body and the file
 * (name + content) is part of the key.
 */
@Injectable()
export class IdempotentInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const ttl = this.reflector.get<number | undefined>(IDEMPOTENT_TTL, ctx.getHandler())
    if (!ttl || ctx.getType() !== 'http') return next.handle()
    const req = ctx.switchToHttp().getRequest<Request & { file?: UploadedFileData }>()
    // one digest over url + body (+ an uploaded file): a secret in the query string never becomes
    // part of a key name, and two different files are two different submissions
    const digest = createHash('sha256').update(
      `${req.method} ${req.originalUrl}\n${canonicalJson(req.body)}`,
    )
    if (req.file) digest.update(`\n${req.file.originalname}\n`).update(req.file.buffer)
    const key = redisKey(
      'idem',
      clsGet('principal')?.sid ?? `ip-${req.ip ?? ''}`,
      digest.digest('hex'),
    )
    const owner = randomUUID()
    const taken = await this.redis.set(key, owner, {
      condition: 'NX',
      expiration: { type: 'PX', value: ttl },
    })
    if (taken === null) throw new BizError(Err.TOO_MANY_REQUESTS)
    const release = () =>
      void this.redis.eval(RELEASE, { keys: [key], arguments: [owner] }).catch(() => 0)
    return next.handle().pipe(tap({ error: release }))
  }
}

/**
 * `@Idempotent()` / `@Idempotent({ ttl: 5000 })` (ms, default 3000) on a write route. Clients also
 * disable the submit button while the request is pending (see docs/design-notes.md#crud-kit).
 */
export const Idempotent = ({ ttl = 3000 }: { ttl?: number } = {}) =>
  applyDecorators(SetMetadata(IDEMPOTENT_TTL, ttl), UseInterceptors(IdempotentInterceptor))
