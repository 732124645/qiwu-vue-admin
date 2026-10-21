import { computed, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import type { ParameterVo } from '@qiwu/shared'
import { agentParamApi } from '@/api/platform/agent-admin'
import { toastRest } from '@/core/composables/use-crud'
import { i18n } from '@/core/i18n'
import { useAuthStore } from '@/core/stores/auth'

/**
 * 智能体的系统参数（暂停、限额、信任模式、说明、联网）：只有 root 能改，其他人看不到编辑控件
 * （服务端同样只许 root 改）。`params` 按完整键取，`save({ 键: 值 })` 保存并以服务端为准重新载入，
 * `saving` 是正在保存的那一项（按钮据此加载并禁用）。
 */
export function useAgentParams() {
  const auth = useAuthStore()
  const isRoot = computed(() => auth.platformRoot)
  const params = shallowRef<Record<string, ParameterVo>>({})
  const loading = ref(false)
  const saving = ref<string>()

  async function load() {
    loading.value = true
    try {
      params.value = await agentParamApi.load()
    } catch (e) {
      toastRest(e)
    } finally {
      loading.value = false
    }
  }

  /**
   * 保存若干参数（键 → 新值），只发值有变化的；`tag` 标出是哪个按钮在保存（默认第一个键）。
   * 未初始化的参数跳过。全部成功提示一次，最后以服务端为准重新载入；返回是否全部保存。
   */
  async function save(values: Record<string, string>, tag = Object.keys(values)[0]) {
    if (saving.value) return false
    saving.value = tag
    try {
      for (const [key, value] of Object.entries(values)) {
        const row = params.value[key]
        if (row && row.paramValue !== value) await agentParamApi.save(row, value)
      }
      ElMessage.success(i18n.global.t('crud.msg.updated'))
      return true
    } catch (e) {
      toastRest(e)
      return false
    } finally {
      await load()
      saving.value = undefined
    }
  }

  void load()
  return { isRoot, params, loading, saving, save, load }
}
