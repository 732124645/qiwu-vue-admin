import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { ImDirectory } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { tenantId } from '../../../core/context/tenant.js'

/**
 * 聊天通讯录（see docs/im.md）：本租户启用部门与启用、未删除的内部员工全量，不含手机号、邮箱与登录名；
 * 对全体员工开放，不套用管理数据范围。
 */
@Injectable()
export class DirectoryService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * 一条部门查询 + 一条用户查询，全量返回；每次都查库，ETag 只省传输（数千员工规模可接受）。用户所在
   * 部门停用或已删除时 `deptId` 为 null，客户端把他放在未分组里。
   */
  async directory(): Promise<ImDirectory> {
    const tid = tenantId()
    const depts = await this.ds.query<
      { id: number; parent_id: number; name: string; sort_no: number }[]
    >(
      // qw:no-data-scope 聊天通讯录对全体员工开放，不套用管理数据范围
      `SELECT d.id, d.parent_id, d.name, d.sort_no FROM iam_dept d
        WHERE d.tenant_id = ? AND d.enabled = 1 AND d.deleted_at IS NULL
        ORDER BY d.parent_id, d.sort_no, d.id`,
      [tid],
    )
    const users = await this.ds.query<
      { id: number; display_name: string; avatar_url: string | null; dept_id: number | null }[]
    >(
      // qw:no-data-scope 聊天通讯录对全体员工开放，不套用管理数据范围
      `SELECT u.id, u.display_name, u.avatar_url, d.id AS dept_id FROM iam_user u
         LEFT JOIN iam_dept d ON d.id = u.dept_id AND d.tenant_id = ? AND d.enabled = 1
          AND d.deleted_at IS NULL
        WHERE u.tenant_id = ? AND u.enabled = 1 AND u.user_type = 'admin' AND u.deleted_at IS NULL
        ORDER BY u.id`,
      [tid, tid],
    )
    return {
      depts: depts.map((d) => ({
        id: Number(d.id),
        parentId: Number(d.parent_id),
        name: d.name,
        sortNo: Number(d.sort_no),
      })),
      users: users.map((u) => ({
        id: Number(u.id),
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        deptId: u.dept_id === null ? null : Number(u.dept_id),
      })),
    }
  }
}
