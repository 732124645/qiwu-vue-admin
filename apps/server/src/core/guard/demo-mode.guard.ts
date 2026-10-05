import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import type { Request } from 'express'
import { AppConfigService } from '../config/config.module.js'
import { BizError } from '../http/biz-error.js'

const DEMO_WRITES: ReadonlySet<string> = new Set([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/refresh',
  'POST /api/auth/verify-password',
  'POST /api/auth/captcha/check',
  'PUT /api/iam/profile/locale',
  'PUT /api/iam/profile/prefs/:key',
  'DELETE /api/iam/profile/prefs/:key',
  'POST /api/messaging/bulletins/feed/read-all',
  'POST /api/messaging/bulletins/feed/:id/read',
  'POST /api/messaging/inboxes/mine/read-all',
  'POST /api/messaging/inboxes/mine/:id/read',
  'POST /api/wf/ccs/:id/read',
])

/** Runs before authentication: public routes and root users obey the same demo restrictions. */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(private readonly cfg: AppConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http' || !this.cfg.get('APP_DEMO_MODE')) return true
    const req = ctx.switchToHttp().getRequest<Request>()
    if (req.method === 'GET' || req.method === 'HEAD') return true
    if (DEMO_WRITES.has(`${req.method} ${(req.route as { path?: string })?.path}`)) return true
    throw new BizError(Err.DEMO_READ_ONLY)
  }
}
