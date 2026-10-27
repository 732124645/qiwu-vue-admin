<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { AgentProviderVo, AgentSearchProviderVo, ParameterVo } from '@qiwu/shared'
import { agentParamApi, agentProviderApi, agentSearchApi } from '@/api/platform/agent-admin'
import { useAuthStore } from '@/core/stores/auth'
import {
  guideComplete,
  guideSteps,
  guideStorageKey,
  noCreditCap,
  readGuide,
  unpricedModels,
  writeGuide,
  type GuideKey,
  type GuideMemo,
} from './setup-guide'

/**
 * 设置页顶部的“开始使用”引导：按顺序列出配置模型、联网搜索、工具审批、试用对话，每步一个按钮跳到对应
 * 标签或对话页；必需步骤都完成后可以收起。进度按“用户 + 浏览器”记在 localStorage。
 * 底部常驻两条提醒（收起后也显示）：有模型没配费率、三个积分额度都是 0；去设置的按钮只给 root，
 * 其他人改不了这些设置。
 */
defineOptions({ name: 'AgentSetupGuide' })
const { tab } = defineProps<{ tab: string }>()
const emit = defineEmits<{ open: [tab: GuideKey | 'params'] }>()
const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const CHAT = 'agent-chat'
const storageKey = computed(() => guideStorageKey(auth.me?.user.id))
const memo = ref<GuideMemo>(readGuide(storageKey.value))
const providers = shallowRef<AgentProviderVo[]>([])
const searches = shallowRef<AgentSearchProviderVo[]>([])
const params = shallowRef<Record<string, ParameterVo>>({})
const unpriced = computed(() => unpricedModels(providers.value))
const noCap = computed(() => noCreditCap(params.value))
const steps = computed(() => guideSteps(providers.value, searches.value, memo.value))
const complete = computed(() => guideComplete(steps.value))
/** 没有对话页（开关关闭或无权限）时“试一试”只给说明，不给按钮 */
const canChat = router.hasRoute(CHAT)

/** 重新读取模型服务、搜索服务与额度参数；失败时保持上次结果（对应标签会自己提示错误）。 */
async function load() {
  const [p, s, q] = await Promise.allSettled([
    agentProviderApi.list(),
    agentSearchApi.list(),
    agentParamApi.load(),
  ])
  if (p.status === 'fulfilled') providers.value = p.value
  if (s.status === 'fulfilled') searches.value = s.value
  if (q.status === 'fulfilled') params.value = q.value
}
/** 合并并保存进度。 */
function remember(patch: GuideMemo) {
  memo.value = { ...memo.value, ...patch }
  writeGuide(storageKey.value, memo.value)
}
// 切换标签时刷新完成状态：管理员可能刚在“模型”里加好了服务；打开过工具审批即记为已检查
watch(
  () => tab,
  (name) => {
    if (name === 'tools' && !memo.value.tools) remember({ tools: true })
    void load()
  },
  { immediate: true },
)

/** 某一步的按钮：对话页走路由并记下已试用，其余切到设置页对应标签。 */
function go(key: GuideKey) {
  if (key !== 'chat') return emit('open', key)
  remember({ chat: true })
  void router.push({ name: CHAT })
}
const stateOf = (s: { done: boolean; optional: boolean }) =>
  s.done ? 'done' : s.optional ? 'optional' : 'todo'
/** 状态标签的颜色；按钮：待完成用主要按钮，可选用次要按钮，已完成只留不显眼的“查看”链接 */
const TAG = { done: 'success', optional: 'info', todo: 'warning' } as const
</script>

<template>
  <el-card class="setup-guide" :data-complete="complete || undefined">
    <div v-if="memo.collapsed && complete" class="setup-guide__collapsed">
      <span>{{ t('agent.admin.guide.collapsedText') }}</span>
      <el-button link type="primary" @click="remember({ collapsed: false })">
        {{ t('agent.admin.guide.expand') }}
      </el-button>
    </div>
    <template v-else>
      <div class="setup-guide__head">
        <div>
          <h3 class="setup-guide__title">{{ t('agent.admin.guide.title') }}</h3>
          <p class="setup-guide__intro">
            {{ t(complete ? 'agent.admin.guide.allDone' : 'agent.admin.guide.intro') }}
          </p>
        </div>
        <el-button
          v-if="complete"
          class="setup-guide__collapse"
          @click="remember({ collapsed: true })"
        >
          {{ t('agent.admin.guide.collapse') }}
        </el-button>
      </div>
      <ol class="setup-guide__steps">
        <li v-for="(s, i) in steps" :key="s.key" class="setup-guide__step" :data-step="s.key">
          <div class="setup-guide__step-head">
            <span class="setup-guide__no">{{ i + 1 }}</span>
            <span class="setup-guide__name">{{ t(`agent.admin.guide.step.${s.key}.title`) }}</span>
            <el-tag :type="TAG[stateOf(s)]" size="small" disable-transitions>
              {{ t(`agent.admin.guide.state.${stateOf(s)}`) }}
            </el-tag>
          </div>
          <p class="setup-guide__desc">{{ t(`agent.admin.guide.step.${s.key}.desc`) }}</p>
          <el-button
            v-if="s.key !== 'chat' || canChat"
            size="small"
            :type="s.optional && !s.done ? 'default' : 'primary'"
            :link="s.done"
            :data-variant="stateOf(s)"
            @click="go(s.key)"
          >
            {{ t(s.done ? 'agent.admin.guide.view' : `agent.admin.guide.step.${s.key}.action`) }}
          </el-button>
          <span v-else class="setup-guide__desc">{{ t('agent.admin.guide.noChat') }}</span>
        </li>
      </ol>
    </template>
    <div v-if="unpriced.length || noCap" class="setup-guide__notices">
      <el-alert
        v-if="unpriced.length"
        class="setup-guide__unpriced"
        type="warning"
        show-icon
        :closable="false"
      >
        <div class="setup-guide__notice">
          <span>{{ t('agent.admin.guide.unpriced', { models: unpriced.join(', ') }) }}</span>
          <el-button
            v-if="auth.platformRoot"
            link
            type="primary"
            @click="emit('open', 'providers')"
          >
            {{ t('agent.admin.guide.setPricing') }}
          </el-button>
        </div>
      </el-alert>
      <el-alert v-if="noCap" class="setup-guide__no-cap" type="warning" show-icon :closable="false">
        <div class="setup-guide__notice">
          <span>{{ t('agent.admin.param.noCreditCap') }}</span>
          <el-button v-if="auth.platformRoot" link type="primary" @click="emit('open', 'params')">
            {{ t('agent.admin.param.setCreditCap') }}
          </el-button>
        </div>
      </el-alert>
    </div>
  </el-card>
</template>

<style scoped>
.setup-guide {
  margin-bottom: 16px;
}
.setup-guide__notices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}
.setup-guide__notice {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.setup-guide__collapsed {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 13px;
  color: var(--qw-text-2);
}
.setup-guide__head {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}
.setup-guide__title {
  margin: 0 0 4px;
  font-size: 16px;
  color: var(--qw-text);
}
.setup-guide__intro {
  margin: 0;
  font-size: 13px;
  color: var(--qw-text-2);
}
.setup-guide__steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.setup-guide__step {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 16px;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.setup-guide__step-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.setup-guide__no {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  font-size: 12px;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.setup-guide__name {
  font-weight: 600;
  color: var(--qw-text);
}
.setup-guide__desc {
  flex: 1;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
