import { type CanActivate, Injectable } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import { clsGet } from '../../../core/context/cls.js'
import { BizError } from '../../../core/http/biz-error.js'

/**
 * 聊天只给内部员工（`iam_user.user_type = 'admin'` 的会话）：其它身份 403 B5001。挂在每个聊天控制器上，
 * 在全局 AuthGuard 之后运行；root 通配权限不改变它，也越不过成员、角色与附件的边界。
 */
@Injectable()
export class ImStaffGuard implements CanActivate {
  canActivate(): boolean {
    if (clsGet('principal')?.userType !== 'admin') throw new BizError(Err.IM_STAFF_ONLY)
    return true
  }
}
