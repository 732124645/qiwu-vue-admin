<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEventListener } from '@vueuse/core'
import {
  comboLabel,
  comboOf,
  conflictOf,
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type Shortcuts,
} from './shortcuts'

/**
 * 对话页“会话设置”里的“快捷键”一页：点某个动作后按下新的组合键即改；冲突（页面已占用、缺少修饰键、
 * 已被另一个动作使用）时不改并在该行提示。录入非“停止”的动作时 Esc 取消录入；Tab 不截下，键盘用户可以
 * 照常移走焦点。改动通过 v-model 交给页面保存。
 */
defineOptions({ name: 'AgentShortcutSettings' })
const model = defineModel<Shortcuts>({ required: true })
const { escapeCloses = false } = defineProps<{ escapeCloses?: boolean }>()
const { t } = useI18n()

/** 正在录入的动作 */
const recording = ref<ShortcutAction | null>(null)
/** 最近一次录入被拒的原因，按动作 */
const problem = ref<Partial<Record<ShortcutAction, string>>>({})

function record(a: ShortcutAction) {
  recording.value = recording.value === a ? null : a
  problem.value = {}
}

// 录入时截下按键（捕获阶段，不让页面的快捷键同时生效）
useEventListener(
  window,
  'keydown',
  (e: KeyboardEvent) => {
    const a = recording.value
    if (!a) return
    const combo = comboOf(e)
    // Tab / Shift+Tab 放行：录入中也要能用键盘移走焦点
    if (!combo || combo === 'Tab' || combo === 'Shift+Tab') return
    e.preventDefault()
    e.stopPropagation()
    recording.value = null
    // 只有“停止”能用单独的 Esc；其他动作按 Esc 就是放弃这次录入
    if (combo === 'Escape' && a !== 'stop') {
      problem.value = {}
      return
    }
    const clash = conflictOf(model.value, a, combo)
    if (clash === null) {
      problem.value = {}
      model.value = { ...model.value, [a]: combo }
    } else
      problem.value = {
        [a]:
          clash === 'reserved' || clash === 'modifier'
            ? t(`agent.chat.shortcut.conflict.${clash}`, { key: comboLabel(combo) })
            : t('agent.chat.shortcut.conflict.action', {
                key: comboLabel(combo),
                action: t(`agent.chat.shortcut.action.${clash}`),
              }),
      }
  },
  { capture: true },
)

function reset() {
  recording.value = null
  problem.value = {}
  model.value = { ...DEFAULT_SHORTCUTS }
}
</script>

<template>
  <div class="agent-shortcuts">
    <p class="agent-shortcuts__title">{{ t('agent.chat.shortcut.title') }}</p>
    <div v-for="a in SHORTCUT_ACTIONS" :key="a" class="agent-shortcuts__row">
      <span class="agent-shortcuts__name">{{ t(`agent.chat.shortcut.action.${a}`) }}</span>
      <el-button
        size="small"
        :type="recording === a ? 'primary' : undefined"
        :data-action="a"
        @click="record(a)"
      >
        {{ recording === a ? t('agent.chat.shortcut.press') : comboLabel(model[a]) }}
      </el-button>
      <p v-if="problem[a]" role="alert" class="agent-shortcuts__problem">{{ problem[a] }}</p>
    </div>
    <p class="agent-shortcuts__hint">
      {{ t(escapeCloses ? 'agent.chat.dock.escapeHint' : 'agent.chat.shortcut.stopHint') }}
    </p>
    <el-button size="small" link type="primary" @click="reset">
      {{ t('agent.chat.shortcut.reset') }}
    </el-button>
  </div>
</template>

<style scoped>
.agent-shortcuts__title {
  margin: 0 0 8px;
  font-weight: 600;
  color: var(--qw-text);
}
.agent-shortcuts__row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}
.agent-shortcuts__name {
  color: var(--qw-text-2);
}
.agent-shortcuts__problem {
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
  color: var(--qw-danger);
}
.agent-shortcuts__hint {
  margin: 8px 0 4px;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
