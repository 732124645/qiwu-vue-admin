import { Injectable } from '@nestjs/common'
import { userPerms } from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { z } from 'zod'
import { currentLocale } from '../../../../core/i18n/locale.js'
import { McpTool } from '../../../../core/mcp/mcp-tool.js'
import { UserService } from './user.service.js'

const searchInput = z.object({
  keyword: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe('part of the username, display name, mobile or email'),
  deptId: z.number().int().positive().optional().describe('only users of this department'),
  enabled: z.boolean().optional().describe('only enabled (true) or disabled (false) users'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
})

const searchOutput = z.object({
  total: z.number().int(),
  items: z.array(
    z.object({
      id: z.number().int(),
      username: z.string(),
      displayName: z.string(),
      deptName: z.string().nullable(),
      mobile: z.string().nullable(),
      email: z.string().nullable(),
      enabled: z.boolean(),
      lastLoginAt: z.string().nullable(),
    }),
  ),
})

/** 用户相关的 MCP 示例工具（see docs/mcp.md）。 */
@Injectable()
export class UserMcpTools {
  constructor(
    private readonly users: UserService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * 按条件查用户：与用户列表接口走同一个查询，所以数据权限、租户与手机号 / 邮箱的遮蔽完全一致
   * （没有 `iam.user.modify` 的调用者看到遮蔽后的值）。
   */
  @McpTool({
    name: 'iam.user.search',
    title: 'Search users',
    description:
      'Searches the users the caller may see (their data scope applies) by keyword, department or ' +
      'state; returns one page (at most 50) with the total. Mobile and email are masked unless the ' +
      'caller may edit users.',
    perm: userPerms.browse,
    kind: 'read',
    input: searchInput,
    output: searchOutput,
  })
  async search(input: z.output<typeof searchInput>): Promise<z.input<typeof searchOutput>> {
    const { items, total } = await this.users.list({
      page: input.page,
      pageSize: input.pageSize,
      keyword: input.keyword,
      deptId: input.deptId,
      enabled: input.enabled,
    })
    const lang = currentLocale()
    return {
      total,
      items: items.map((u) => ({
        ...u,
        // 预置部门名是 i18n 键：按调用者语言翻译，智能体拿到的是可读文字
        deptName: u.deptName?.startsWith('seed.')
          ? String(this.i18n.translate(u.deptName, { lang }))
          : u.deptName,
      })),
    }
  }
}
