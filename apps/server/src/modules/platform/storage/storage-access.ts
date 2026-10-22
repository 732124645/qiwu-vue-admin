import { Injectable } from '@nestjs/common'
import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import type { Principal } from '../../../core/auth/principal.js'
import { tenantId } from '../../../core/context/tenant.js'
import type { FsObject } from './fs-object.entity.js'

export type StorageAccessChecker = (obj: FsObject, principal: Principal) => Promise<boolean>

/** 受保护附件必须经过业务检查器；模块未加载时也不能回落到上传者或全局文件权限。 */
export const PROTECTED_ATTACHMENT_TAGS = ['wf.attachment', 'oa.attachment'] as const

/** 平台只登记业务检查函数，不依赖工作流或项目模块。 */
@Injectable()
export class StorageAccess {
  private readonly checkers = new Map<
    string,
    {
      check: StorageAccessChecker
      exclusive: boolean
      feature?: string
    }
  >()

  /** exclusive 标签强制业务授权，feature 沿用功能守卫的默认租户与代入租户语义。 */
  register(
    bizTag: string,
    check: StorageAccessChecker,
    options: { exclusive?: boolean; feature?: string } = {},
  ): void {
    if (this.checkers.has(bizTag))
      throw new Error(`StorageAccess: '${bizTag}' already has a checker`)
    this.checkers.set(bizTag, {
      check,
      exclusive: options.exclusive === true,
      feature: options.feature,
    })
  }

  /** 这些对象不进入全局文件目录，避免名称和业务引用绕过单据授权。 */
  protectedTags(): string[] {
    return [
      ...new Set<string>([
        ...PROTECTED_ATTACHMENT_TAGS,
        ...[...this.checkers].filter(([, c]) => c.exclusive).map(([tag]) => tag),
      ]),
    ]
  }

  requiresCheck(tag: string): boolean {
    return this.protectedTags().includes(tag)
  }

  /** 检查器不存在或功能不可用时拒绝；跨租户对象连 root 也不能读取。 */
  async allows(obj: FsObject, principal: Principal): Promise<boolean> {
    const checker = this.checkers.get(obj.bizTag)
    if (!checker) return false
    if (this.requiresCheck(obj.bizTag) && obj.tenantId !== tenantId()) return false
    if (checker.feature && principal.actingTenantId === undefined) {
      const features =
        principal.features ?? (principal.tenantId !== DEFAULT_TENANT_ID ? [] : undefined)
      if (features !== undefined && !features.includes(checker.feature)) return false
    }
    return checker.check(obj, principal)
  }
}
