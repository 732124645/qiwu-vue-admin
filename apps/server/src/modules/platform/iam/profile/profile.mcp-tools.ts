import { Injectable } from '@nestjs/common'
import { I18nService } from 'nestjs-i18n'
import { z } from 'zod'
import { currentLocale } from '../../../../core/i18n/locale.js'
import { McpTool } from '../../../../core/mcp/mcp-tool.js'
import { myId } from './profile.controller.js'
import { ProfileService } from './profile.service.js'

const meOutput = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  deptName: z.string().nullable(),
  roleNames: z.array(z.string()),
  positionNames: z.array(z.string()),
  locale: z.string().nullable(),
})

/** 个人信息的 MCP 示例工具（see docs/mcp.md）。 */
@Injectable()
export class ProfileMcpTools {
  constructor(
    private readonly profile: ProfileService,
    private readonly i18n: I18nService,
  ) {}

  /** 令牌所属用户本人的资料（不含手机号、邮箱与头像）：任何登录用户都能读自己的，不需要权限点。 */
  @McpTool({
    name: 'iam.me.get',
    title: 'Current user',
    description:
      'Returns the user this token acts for: username, display name, department, roles, positions ' +
      'and language.',
    perm: null,
    kind: 'read',
    input: z.object({}),
    output: meOutput,
  })
  async me(): Promise<z.input<typeof meOutput>> {
    const p = await this.profile.get(myId())
    const lang = currentLocale()
    // 预置的部门、角色、岗位名是 i18n 键：翻成调用者的语言
    const text = (s: string) =>
      s.startsWith('seed.') ? String(this.i18n.translate(s, { lang })) : s
    return {
      ...p,
      deptName: p.deptName === null ? null : text(p.deptName),
      roleNames: p.roleNames.map(text),
      positionNames: p.positionNames.map(text),
    }
  }
}
