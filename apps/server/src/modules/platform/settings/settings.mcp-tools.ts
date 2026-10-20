import { Injectable } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import { z } from 'zod'
import { BizError } from '../../../core/http/biz-error.js'
import { currentLocale } from '../../../core/i18n/locale.js'
import { McpTool } from '../../../core/mcp/mcp-tool.js'
import { DictService } from '../../../core/settings/dict.service.js'

const optionsOutput = z.object({
  code: z.string(),
  entries: z.array(z.object({ value: z.string(), label: z.string(), isDefault: z.boolean() })),
})

/** 字典的 MCP 示例工具（see docs/mcp.md）。 */
@Injectable()
export class SettingsMcpTools {
  constructor(private readonly dicts: DictService) {}

  /**
   * 一个已启用字典的选项（值与按调用者语言的标签）：字典标签每个页面都要显示，任何登录用户都能读，
   * 与 `GET /api/settings/dicts/:code/entries` 一致，不需要权限点。
   */
  @McpTool({
    name: 'cfg.dict.options',
    title: 'Dictionary options',
    description:
      'Returns the enabled options of a dictionary by its code (for example iam.gender or ' +
      'core.enabled): each value with its label in the caller’s language. Use it to turn codes in ' +
      'other tools’ answers into words, or to pick valid values for their arguments.',
    perm: null,
    kind: 'read',
    input: z.object({
      code: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe('the dictionary code, dotted like iam.gender'),
    }),
    output: optionsOutput,
  })
  async options({ code }: { code: string }): Promise<z.input<typeof optionsOutput>> {
    const payload = await this.dicts.entries(code)
    if (!payload) throw new BizError(Err.NOT_FOUND)
    const lang = currentLocale()
    return {
      code,
      entries: payload.entries.map((e) => ({
        value: e.value,
        label: e.labelI18n?.[lang] ?? e.label,
        isDefault: e.isDefault,
      })),
    }
  }
}
