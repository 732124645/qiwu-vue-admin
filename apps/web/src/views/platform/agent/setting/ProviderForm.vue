<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormItemRule } from 'element-plus'
import {
  AGENT_REASONING,
  agentCreditAmount,
  agentProviderSave,
  type AgentModelPricing,
  type AgentProviderModelsVo,
  type AgentProviderSave,
} from '@qiwu/shared'
import { agentProviderApi, dropEmpty } from '@/api/platform/agent-admin'
import QwEditTable from '@/core/components/QwEditTable.vue'
import { toastRest, useCrudForm } from '@/core/composables/use-crud'
import { zodRules } from '@/core/form/zod-rules'

/**
 * 模型提供方的新增 / 编辑表单（`openDialog(ProviderForm, { id })`）：名称、兼容 OpenAI 的接口地址、
 * 只写的密钥（已保存时显示“已保存”，留空则保留原密钥，从不读回）、模型清单（每行模型 id、显示名、
 * 推理强度、看图、快速档、上下文窗口）、启用、默认。
 */
defineOptions({ name: 'AgentProviderForm' })
type Model = AgentProviderSave['models'][number]
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const newModel = (): Model => ({
  id: '',
  label: '',
  reasoning: false,
  vision: false,
  fast: false,
  contextWindow: 64_000,
  image: false,
  pricing: null,
  reasoningDefault: 'provider',
  reasoningStyle: 'standard',
})
const { model, row, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: agentProviderApi.get,
    // 密钥只写：空串不发送，服务端保留已保存的密钥
    create: (dto: AgentProviderSave) =>
      agentProviderApi.create(dropEmpty(agentProviderSave.parse(dto), 'apiKey')),
    update: (pid: number, dto: AgentProviderSave) =>
      agentProviderApi.update(pid, dropEmpty(agentProviderSave.parse(dto), 'apiKey')),
  },
  schema: agentProviderSave,
  emptyModel: () => ({
    name: '',
    baseUrl: '',
    apiKey: '',
    models: [newModel()],
    enabled: true,
    isDefault: false,
    sort: 0,
  }),
  id,
  emit,
})
// 每个模型行的单元格按行 schema 的对应字段校验；整张清单只查“至少一个模型”，
// 不再用整表规则（那会把各行的错误在清单下方重复一遍）
delete rules.models
const modelsRule: FormItemRule = {
  validator: (_r, value: Model[], cb) =>
    value.length ? cb() : cb(new Error(t('agent.admin.model.required'))),
}
const modelRules = zodRules(agentProviderSave.shape.models.element, useI18n())
const modelColumns = [
  { prop: 'id', label: 'agent.admin.model.id', minWidth: 160, required: true },
  { prop: 'label', label: 'agent.admin.model.label', minWidth: 120 },
  { prop: 'reasoning', label: 'agent.admin.model.reasoning', width: 80 },
  { prop: 'vision', label: 'agent.admin.model.vision', width: 80 },
  { prop: 'fast', label: 'agent.admin.model.fast', width: 80 },
  { prop: 'image', label: 'agent.admin.model.image', width: 80 },
  { prop: 'contextWindow', label: 'agent.admin.model.contextWindow', width: 170 },
]

// ---- 从服务加载模型 ----
const loadingModels = ref(false)
const upstream = ref<AgentProviderModelsVo['items'] | null>(null)
const picked = ref<string[]>([])
// 有地址即可加载：不需要密钥的本地服务不带密钥；改了地址又没填新密钥时由服务端拒绝，不会带出已保存的密钥
const canLoad = computed(() => !!model.baseUrl)
const added = (mid: string) => model.models.some((m) => m.id === mid)
/** 读取服务的模型清单；失败时提示翻译后的错误（地址不合法的 400、提供方已删除的 404 请求层不提示） */
async function loadModels() {
  loadingModels.value = true
  try {
    const { items } = await agentProviderApi.models({
      ...(id !== undefined && { id }),
      baseUrl: model.baseUrl,
      ...(model.apiKey && { apiKey: model.apiKey }),
    })
    upstream.value = items
    picked.value = []
    if (!items.length) ElMessage.info(t('agent.admin.model.noneLoaded'))
  } catch (e) {
    toastRest(e)
  } finally {
    loadingModels.value = false
  }
}
/** 把勾选的模型加成普通的模型行（其他字段取默认、不配费率）；已在清单里的跳过，空白行让位 */
function addPicked() {
  const fresh = picked.value.filter((mid) => !added(mid))
  if (fresh.length) {
    model.models = [
      ...model.models.filter((m) => m.id.trim()),
      ...fresh.map((mid) => ({ ...newModel(), id: mid })),
    ]
  }
  picked.value = []
}

const rates = ['input', 'output', 'cacheRead', 'cacheWrite', 'imageCredits'] as const
const rateLabel = (key: (typeof rates)[number]) =>
  `agent.admin.model.${key === 'imageCredits' ? key : `${key}Credits`}`
/** 未配置与免费分开；可选费率留空才继承，明确的0保持原样。 */
function setRate(pricing: AgentModelPricing, key: (typeof rates)[number], value: string) {
  if (key === 'input' || key === 'output') pricing[key] = value
  else pricing[key] = value || null
}
const rateRule = (required: boolean): FormItemRule => ({
  validator: (_rule, value, done) =>
    done(
      (!required && value == null) || agentCreditAmount.safeParse(value).success
        ? undefined
        : new Error(t('agent.admin.param.creditInvalid')),
    ),
})
/** 切换到开关协议时不再保留虚假的低/高等级。 */
function setReasoningStyle(m: Model, value: 'standard' | 'vllm') {
  m.reasoningStyle = value
  if (value === 'vllm' && ['low', 'high'].includes(m.reasoningDefault ?? ''))
    m.reasoningDefault = 'medium'
}
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="top">
    <el-form-item :label="t('field.agent.provider.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.agent.provider.baseUrl')" prop="baseUrl">
      <el-input v-model="model.baseUrl" maxlength="512" placeholder="https://api.example.com/v1" />
    </el-form-item>
    <el-form-item :label="t('field.agent.provider.apiKey')" prop="apiKey">
      <el-input
        v-model="model.apiKey"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="512"
        :placeholder="row?.hasKey ? t('crud.placeholder.secretKeep') : ''"
      />
      <el-tag v-if="row?.hasKey" class="provider-form__stored" size="small" type="success">
        {{ t('agent.admin.keyStored') }}
      </el-tag>
    </el-form-item>
    <QwEditTable
      v-model="model.models"
      label="field.agent.provider.models"
      :columns="modelColumns"
      :create="newModel"
    >
      <template #cell-id="{ row: m, index }">
        <el-form-item :prop="`models.${index}.id`" :rules="modelRules.id">
          <el-input v-model="m.id" maxlength="128" :aria-label="t('agent.admin.model.id')" />
        </el-form-item>
      </template>
      <template #cell-label="{ row: m, index }">
        <el-form-item :prop="`models.${index}.label`" :rules="modelRules.label">
          <el-input v-model="m.label" maxlength="128" :aria-label="t('agent.admin.model.label')" />
        </el-form-item>
      </template>
      <template #cell-reasoning="{ row: m }">
        <el-checkbox v-model="m.reasoning" :aria-label="t('agent.admin.model.reasoning')" />
      </template>
      <template #cell-vision="{ row: m }">
        <el-checkbox v-model="m.vision" :aria-label="t('agent.admin.model.vision')" />
      </template>
      <template #cell-fast="{ row: m }">
        <el-checkbox v-model="m.fast" :aria-label="t('agent.admin.model.fast')" />
      </template>
      <template #cell-image="{ row: m }">
        <el-checkbox v-model="m.image" :aria-label="t('agent.admin.model.image')" />
      </template>
      <template #cell-contextWindow="{ row: m, index }">
        <el-form-item :prop="`models.${index}.contextWindow`" :rules="modelRules.contextWindow">
          <el-input-number
            v-model="m.contextWindow"
            :min="1024"
            :max="10_000_000"
            :step="1024"
            controls-position="right"
            :aria-label="t('agent.admin.model.contextWindow')"
          />
        </el-form-item>
      </template>
    </QwEditTable>
    <div class="provider-form__load">
      <el-button :loading="loadingModels" :disabled="!canLoad || loadingModels" @click="loadModels">
        {{ t('agent.admin.model.loadFromService') }}
      </el-button>
      <template v-if="upstream?.length">
        <el-select
          v-model="picked"
          class="provider-form__pick"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :placeholder="t('agent.admin.model.pickLoaded')"
          :aria-label="t('agent.admin.model.pickLoaded')"
        >
          <el-option
            v-for="m in upstream"
            :key="m.id"
            :value="m.id"
            :label="m.id"
            :disabled="added(m.id)"
          >
            {{ m.id }}
            <span v-if="added(m.id)" class="provider-form__added">
              {{ t('agent.admin.model.alreadyAdded') }}
            </span>
            <span v-else-if="m.ownedBy" class="provider-form__added">{{ m.ownedBy }}</span>
          </el-option>
        </el-select>
        <el-button type="primary" :disabled="!picked.length" @click="addPicked">
          {{ t('agent.admin.model.addPicked') }}
        </el-button>
      </template>
    </div>
    <p v-if="!canLoad" class="provider-form__hint">{{ t('agent.admin.model.loadHint') }}</p>
    <!-- the list itself (at least one model) reports here -->
    <el-form-item class="provider-form__models" prop="models" :rules="modelsRule" />
    <el-collapse class="provider-form__config">
      <el-collapse-item v-for="(m, index) in model.models" :key="index" :name="index">
        <template #title>
          {{ m.label || m.id || t('agent.admin.model.id') }} ·
          {{ t('agent.admin.model.configure') }}
          <el-tag size="small" :type="m.pricing ? 'success' : 'warning'">
            {{
              t(
                m.pricing
                  ? 'agent.admin.model.pricingConfigured'
                  : 'agent.admin.model.pricingMissing',
              )
            }}
          </el-tag>
        </template>
        <el-checkbox
          :model-value="!!m.pricing"
          :disabled="submitting"
          @change="
            m.pricing = $event
              ? { input: '', output: '', cacheRead: null, cacheWrite: null, imageCredits: null }
              : null
          "
        >
          {{ t('agent.admin.model.pricingEnabled') }}
        </el-checkbox>
        <p class="provider-form__hint">{{ t('agent.admin.model.pricingHint') }}</p>
        <div v-if="m.pricing" class="provider-form__rates">
          <el-form-item
            v-for="rate in rates"
            :key="rate"
            :label="t(rateLabel(rate))"
            :prop="`models.${index}.pricing.${rate}`"
            :rules="rateRule(rate === 'input' || rate === 'output')"
          >
            <el-input
              :model-value="m.pricing[rate] ?? ''"
              inputmode="decimal"
              maxlength="19"
              :disabled="submitting"
              :aria-label="t(rateLabel(rate))"
              :placeholder="
                rate === 'cacheRead' || rate === 'cacheWrite'
                  ? t('agent.admin.model.cacheFallback')
                  : ''
              "
              @update:model-value="setRate(m.pricing!, rate, $event)"
            />
          </el-form-item>
        </div>
        <p v-if="m.pricing" class="provider-form__hint">
          {{ t('agent.admin.model.imageFallback') }}
        </p>
        <p class="provider-form__hint">{{ t('agent.admin.model.reasoningHint') }}</p>
        <div class="provider-form__rates">
          <el-form-item :label="t('agent.admin.model.reasoningStyle')">
            <el-select
              :model-value="m.reasoningStyle ?? 'standard'"
              :disabled="!m.reasoning || submitting"
              :aria-label="t('agent.admin.model.reasoningStyle')"
              @change="setReasoningStyle(m, $event)"
            >
              <el-option value="standard" :label="t('agent.admin.model.reasoningStandard')" />
              <el-option value="vllm" :label="t('agent.admin.model.reasoningVllm')" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('agent.admin.model.reasoningDefault')">
            <el-select
              :model-value="m.reasoningDefault ?? 'provider'"
              @update:model-value="m.reasoningDefault = $event"
              :disabled="!m.reasoning || submitting"
              :aria-label="t('agent.admin.model.reasoningDefault')"
            >
              <el-option value="provider" :label="t('agent.admin.model.reasoningProvider')" />
              <el-option
                v-for="value in m.reasoningStyle === 'vllm' ? ['off', 'medium'] : AGENT_REASONING"
                :key="value"
                :value="value"
                :label="
                  m.reasoningStyle === 'vllm' && value === 'medium'
                    ? t('agent.admin.model.reasoningOn')
                    : t(`agent.chat.reasoning.${value}`)
                "
              />
            </el-select>
          </el-form-item>
        </div>
        <p class="provider-form__hint">
          {{
            t(
              m.reasoningStyle === 'vllm'
                ? 'agent.admin.model.vllmHint'
                : 'agent.admin.model.standardOffHint',
            )
          }}
        </p>
      </el-collapse-item>
    </el-collapse>
    <el-form-item :label="t('field.agent.provider.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
    <el-form-item :label="t('field.agent.provider.isDefault')" prop="isDefault">
      <el-switch v-model="model.isDefault" />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" :disabled="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.provider-form__stored {
  margin-left: 8px;
}
.provider-form__config {
  margin: 16px 0;
}
.provider-form__load {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
.provider-form__pick {
  flex: 1;
}
.provider-form__added {
  margin-left: 8px;
  color: var(--qw-text-3);
  font-size: 12px;
}
.provider-form__config :deep(.el-tag) {
  margin: 0 8px;
}
.provider-form__rates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 0 16px;
}
.provider-form__hint {
  margin: 8px 0;
  color: var(--qw-text-3);
  font-size: 12px;
  line-height: 1.5;
}
</style>
