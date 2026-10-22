import { i18n } from '@/core/i18n'

/** 只翻译本系统登记的工具；外部工具的同名声明与未知文字保持原样。 */
export function toolTitle(name: string, fallback?: string) {
  const key = `agent.tools.${name.replaceAll('.', '_')}.title`
  return !name.startsWith('mcp.') && i18n.global.te(key) ? i18n.global.t(key) : fallback || name
}

/** 页面说明使用本地译文，不改变发给模型或客户端的工具协议。 */
export function toolDescription(name: string, fallback: string) {
  const key = `agent.tools.${name.replaceAll('.', '_')}.description`
  return !name.startsWith('mcp.') && i18n.global.te(key) ? i18n.global.t(key) : fallback
}

/** 已知菜单和动作组合成权限名称；无法识别时保留权限码供管理员核对。 */
export function toolPermission(perm: string) {
  const at = perm.lastIndexOf('.')
  const resource = `menu.${perm.slice(0, at)}`
  const action = `menu.action.${perm.slice(at + 1)}`
  return i18n.global.te(resource) && i18n.global.te(action)
    ? `${i18n.global.t(resource)} · ${i18n.global.t(action)}`
    : perm
}
