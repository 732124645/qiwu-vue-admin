<script setup lang="ts">
import { onMounted, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentOptionsVo, AgentProfileVo, AgentThreadVo } from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import { agentProfileApi } from '@/api/platform/agent-memory'
import IconButton from '@/core/components/IconButton.vue'
import { toastRest } from '@/core/composables/use-crud'
import { openDialog } from '@/core/dialog'
import MemoryPanel from './MemoryPanel.vue'
import ProfilePanel from './ProfilePanel.vue'

/** 新会话草稿的配置方案与记忆开关：`profileId` 为 undefined 时取默认方案，null 为不用方案。 */
export interface ProfileDraft {
  profileId: number | null | undefined
  memoryEnabled: boolean
}

/**
 * 对话页头部的“配置方案”与“记忆”：新会话草稿可选方案（默认选中本人的默认方案，选中后把方案的模型与模式
 * 带进输入框）与是否使用记忆；已有会话可逐会话开关记忆（临时会话不读不写记忆，不显示开关）。两个按钮打开
 * “配置方案”与“我的记忆”面板。
 */
defineOptions({ name: 'AgentProfileMemoryBar' })
const {
  thread = null,
  options = null,
  temporary = false,
} = defineProps<{
  thread?: AgentThreadVo | null
  options?: AgentOptionsVo | null
  /** 草稿是临时会话 */
  temporary?: boolean
}>()
const draft = defineModel<ProfileDraft>('draft', { required: true })
const emit = defineEmits<{
  /** 草稿选了方案（null：不用方案）：输入框换成它的模型与模式 */
  apply: [profile: AgentProfileVo | null]
  /** 会话的记忆开关已保存 */
  updated: [thread: AgentThreadVo]
}>()
const { t } = useI18n()
const profiles = shallowRef<AgentProfileVo[]>([])
const saving = shallowRef(false)

/** 读本人可用的方案；失败由请求层提示。 */
async function load() {
  try {
    profiles.value = await agentProfileApi.list()
    pickDefault()
  } catch (e) {
    toastRest(e)
  }
}

/** 草稿还没选过方案时选中默认方案（个人默认优先，与服务端同一规则）。 */
function pickDefault() {
  if (draft.value.profileId !== undefined) return
  const def =
    profiles.value.find((p) => p.isDefault && p.scope === 'user') ??
    profiles.value.find((p) => p.isDefault)
  if (!def) return
  draft.value = { ...draft.value, profileId: def.id }
  emit('apply', def)
}
// 新草稿（对话页把 profileId 重置为 undefined）再选一次默认方案
watch(
  () => draft.value.profileId,
  (v) => v === undefined && pickDefault(),
)

/** 草稿里换方案：清空为不用方案。 */
function choose(id: number | null | undefined) {
  draft.value = { ...draft.value, profileId: id ?? null }
  emit('apply', profiles.value.find((p) => p.id === id) ?? null)
}

/** 记忆开关：已有会话立即保存，草稿只记下（建会话时带上）。 */
function onMemory(v: string | number | boolean) {
  if (thread) void setMemory(!!v)
  else draft.value = { ...draft.value, memoryEnabled: !!v }
}

/** 已有会话开关记忆：保存成功后交给对话页。 */
async function setMemory(on: boolean) {
  const th = thread
  if (!th || saving.value) return
  saving.value = true
  try {
    emit('updated', await agentApi.updateThread(th.id, { memoryEnabled: on }))
  } catch (e) {
    toastRest(e)
  } finally {
    saving.value = false
  }
}

async function openProfiles() {
  await openDialog(ProfilePanel, { options }, { title: () => t('agent.profile.title'), width: 860 })
  await load()
}

const openMemories = () =>
  openDialog(MemoryPanel, {}, { title: () => t('agent.memory.title'), width: 860 })

onMounted(load)
</script>

<template>
  <el-select
    v-if="!thread && profiles.length"
    class="agent-profile-bar__pick"
    :model-value="draft.profileId ?? undefined"
    clearable
    size="small"
    :placeholder="t('agent.profile.none')"
    :aria-label="t('agent.profile.pick')"
    @update:model-value="choose"
  >
    <el-option v-for="p in profiles" :key="p.id" :value="p.id" :label="p.name" />
  </el-select>
  <el-switch
    v-if="thread ? !thread.temporary : !temporary"
    :model-value="thread ? thread.memoryEnabled : draft.memoryEnabled"
    :loading="saving"
    :active-text="t('agent.memory.use')"
    :aria-label="t('agent.memory.use')"
    @update:model-value="onMemory"
  />
  <IconButton
    icon="lucide:sliders-vertical"
    :label="t('agent.profile.title')"
    @click="openProfiles"
  />
  <IconButton icon="lucide:brain" :label="t('agent.memory.title')" @click="openMemories" />
</template>

<style scoped>
.agent-profile-bar__pick {
  width: 140px;
}
</style>
