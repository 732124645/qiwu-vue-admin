import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AccessTokenVo } from '@qiwu/shared'
import { toastRest } from '@/core/composables/use-crud'
import { i18n } from '@/core/i18n'

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)

/** 令牌列表里的时间，按浏览器时区显示到分钟。 */
export const tokenTime = (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm')

/**
 * 吊销前确认（吊销立即生效且不可恢复），确认后执行 `revoke`；成功返回 `true`。
 * 403/409/422/429/5xx 由请求层提示，400/404 在这里提示。
 */
export async function revokeToken(
  token: Pick<AccessTokenVo, 'name'>,
  revoke: () => Promise<unknown>,
): Promise<boolean> {
  const go = await ElMessageBox.confirm(
    t('mcp.token.revokeConfirm', { name: token.name }),
    t('crud.confirm.title'),
    {
      type: 'warning',
      confirmButtonText: t('menu.action.revoke'),
      cancelButtonText: t('common.action.cancel'),
    },
  ).catch(() => false)
  if (!go) return false
  try {
    await revoke()
  } catch (e) {
    toastRest(e)
    return false
  }
  ElMessage.success(t('mcp.token.revoked'))
  return true
}
