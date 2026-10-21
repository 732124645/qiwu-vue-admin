import { ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { toastRest } from '@/core/composables/use-crud'
import { i18n } from '@/core/i18n'

const t = (key: string) => i18n.global.t(key)

/**
 * 不分页列表（智能体设置与技能页各标签）的状态：`rows` / `loading`、`refresh()` 重新载入（立即载入一次），
 * `remove(del)` 确认后删除再重新载入。失败由请求层提示，另补请求层不提示的 400 / 404。
 */
export function useList<T>(load: () => Promise<T[]>) {
  const rows = shallowRef<T[]>([])
  const loading = ref(false)

  async function refresh() {
    loading.value = true
    try {
      rows.value = await load()
    } catch (e) {
      toastRest(e)
    } finally {
      loading.value = false
    }
  }

  /** 确认后执行 `del`，成功提示；无论成败都以服务端为准重新载入。 */
  async function remove(del: () => Promise<unknown>) {
    try {
      await ElMessageBox.confirm(t('crud.confirm.delete'), t('crud.confirm.title'), {
        type: 'warning',
        confirmButtonText: t('crud.action.delete'),
        cancelButtonText: t('common.action.cancel'),
      })
    } catch {
      return
    }
    try {
      await del()
      ElMessage.success(t('crud.msg.deleted'))
    } catch (e) {
      toastRest(e)
    }
    await refresh()
  }

  void refresh()
  return { rows, loading, refresh, remove }
}
