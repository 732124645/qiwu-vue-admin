import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { clsGet, clsSet } from '../context/cls.js'
import { type PermRequirement, REQUIRE_PERM, REQUIRE_ROLE } from './decorators.js'
import { ROOT_ROLE } from './principal.js'

/**
 * Global, after AuthGuard (see docs/design-notes.md#permissions): `@RequirePerm` (any of; `.all()` every one) and
 * `@RequireRole` (any of) against the CLS principal; root (`Principal.root`, never a `*` perm) passes
 * both, and only root satisfies `@RequireRole('root')`. Callers without a user
 * (public routes, client_credentials tokens) never pass. CLS `checkedPerm` gets what data scope must
 * honour: `.all()` → every required perm; any-of → every listed perm the caller holds (not just the
 * first: the scope must not depend on declaration order).
 */
@Injectable()
export class PermGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()]
    const need = this.reflector.getAllAndOverride<PermRequirement | undefined>(
      REQUIRE_PERM,
      targets,
    )
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRE_ROLE, targets)
    if (!need && !roles) return true
    const p = clsGet('principal')
    if (!p) throw new ForbiddenException()
    const root = p.root === true
    if (roles && !root && !p.roles.some((r) => r.code !== ROOT_ROLE && roles.includes(r.code)))
      throw new ForbiddenException()
    if (need) {
      const has = (perm: string) => root || p.perms.includes(perm)
      const held = need.all ? (need.perms.every(has) ? need.perms : []) : need.perms.filter(has)
      if (!held.length) throw new ForbiddenException()
      clsSet('checkedPerm', { perms: held, all: need.all })
    }
    return true
  }
}
