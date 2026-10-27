<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentOptionsVo, AgentProfileVo, AgentThreadVo } from '@qiwu/shared'
import { agentApi } from '@/api/platform/agent'
import { agentProfileApi } from '@/api/platform/agent-memory'
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
 * 对话页“会话设置”里的“配置方案”与“记忆”两行：新会话草稿可选方案（默认选中本人的默认方案，选中后把方案的
 * 模型与模式带进输入框）与是否使用记忆；已有会话可逐会话开关记忆（临时会话不读不写记忆，不显示开关）。
 * 两行各有一个文字按钮打开“配置方案”与“我的记忆”面板。组件常驻页面（弹层隐藏时也挂载），默认方案才能及时带进草稿。
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
  const profileId = id == null || id === NO_PROFILE ? null : id
  draft.value = { ...draft.value, profileId }
  emit('apply', profiles.value.find((p) => p.id === profileId) ?? null)
}

/** 选择框里“不使用方案”的取值（方案 id 都是正整数） */
const NO_PROFILE = 0
/**
 * 选择框显示的方案：已有会话显示它用的方案（只读，方案只能在新会话选）；草稿显示所选方案；
 * 还没有任何方案时为空，显示“还没有方案”的提示。
 */
const picked = computed(() => {
  if (!profiles.value.length) return undefined
  const id = thread ? thread.profileId : draft.value.profileId
  return id ?? NO_PROFILE
})

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
  <div class="agent-settings__row">
    <span class="agent-settings__name">{{ t('agent.profile.title') }}</span>
    <el-select
      class="agent-profile-bar__pick"
      :model-value="picked"
      size="small"
      :teleported="false"
      :disabled="!!thread || !profiles.length"
      :title="thread ? t('agent.chat.settings.profileLocked') : undefined"
      :placeholder="t('agent.chat.settings.noProfiles')"
      :aria-label="t('agent.profile.pick')"
      @update:model-value="choose"
    >
      <el-option :value="NO_PROFILE" :label="t('agent.profile.none')" />
      <el-option v-for="p in profiles" :key="p.id" :value="p.id" :label="p.name" />
    </el-select>
    <el-button size="small" link type="primary" @click="openProfiles">
      {{ t('agent.chat.settings.manage') }}
    </el-button>
  </div>
  <div class="agent-settings__row">
    <span class="agent-settings__name">{{ t('agent.memory.use') }}</span>
    <el-switch
      v-if="thread ? !thread.temporary : !temporary"
      :model-value="thread ? thread.memoryEnabled : draft.memoryEnabled"
      :loading="saving"
      :aria-label="t('agent.memory.use')"
      @update:model-value="onMemory"
    />
    <span v-else class="agent-settings__hint">{{ t('agent.chat.settings.noMemory') }}</span>
    <el-button size="small" link type="primary" @click="openMemories">
      {{ t('agent.memory.title') }}
    </el-button>
  </div>
</template>

<style scoped>
.agent-profile-bar__pick {
  width: 160px;
}
</style>
