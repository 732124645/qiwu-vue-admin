import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/core/i18n'
import { toolTitle, toolDescription, toolPermission } from '@/views/platform/mcp/tool-presentation'

afterEach(() => setLocale('zh-CN'))

describe('tool presentation', () => {
  it('localizes known tool metadata and permissions while keeping identifiers stable', () => {
    const tool = { name: 'demo.customer.update', title: 'Fill in customer details' }
    setLocale('zh-CN')
    expect(toolTitle(tool.name, tool.title)).toBe('补充客户资料')
    expect(toolDescription(tool.name, 'English description')).toContain('更新可访问客户')
    expect(toolPermission('demo.customer.modify')).toBe('示例客户 · 修改')
    expect(tool.name).toBe('demo.customer.update')
    expect(tool.title).toBe('Fill in customer details')
    setLocale('en-US')
    expect(toolTitle(tool.name, tool.title)).toBe('Fill in customer details')
    expect(toolPermission('demo.customer.modify')).not.toContain('demo.customer')
  })

  it('keeps unknown metadata intact and never exposes a missing translation key', () => {
    expect(toolTitle('biz.crm.lookup', 'CRM lookup')).toBe('CRM lookup')
    expect(toolTitle('biz.crm.lookup')).toBe('biz.crm.lookup')
    expect(toolDescription('biz.crm.lookup', 'Provider description')).toBe('Provider description')
    expect(toolPermission('biz.crm.operate')).toBe('biz.crm.operate')
  })
})
