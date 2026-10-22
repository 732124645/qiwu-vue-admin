<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import {
  accessTokenCreate,
  MCP_TOKEN_MAX_PER_USER,
  MCP_TOKEN_TTL_DAYS_MAX,
  type AccessTokenCreatedVo,
  type McpToolVo,
} from '@qiwu/shared'
import { myTokenApi, myToolApi } from '@/api/platform/mcp'
import { toolTitle } from '../platform/agent/tool-presentation'
import { toastRest } from '@/core/composables/use-crud'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'

/**
 * 新建个人访问令牌的弹框内容，`openDialog(AccessTokenForm)` 打开；`done` 带回服务端的应答（含只显示
 * 一次的完整令牌）。签发长期凭据要再输一次当前密码。
 */
defineOptions({ name: 'AccessTokenForm' })
const emit = defineEmits<{ done: [created: AccessTokenCreatedVo]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n

const model = reactive({
  name: '',
  tools: [] as string[],
  allowWrite: false,
  currentPassword: '',
})
const formRef = ref<FormInstance>()
const rules = zodRules(accessTokenCreate, i18n, model)
revalidateOnLocale(formRef)
const submitting = ref(false)

// 有效期选项：不超过服务端上限，0 表示永不过期
const EXPIRY = [7, 30, 90].filter((d) => d <= MCP_TOKEN_TTL_DAYS_MAX)
const expiry = ref(30)

/**
 * 可选的工具：本人此刻能用的（启用且有权限点），任何登录用户都能取；不选即全部工具（写入类仍须允许
 * 写入），与服务端对 `tools` 为空的处理一致。静默请求：拿不到时不列工具，也不打扰用户。
 */
const tools = shallowRef<McpToolVo[]>([])
myToolApi.list({ silent: true }).then(
  (list) => (tools.value = list),
  () => undefined,
)
const isWrite = computed(
  () => new Set(tools.value.filter((x) => x.kind === 'write').map((x) => x.name)),
)
// 不允许写入时去掉已选的写入类工具：服务端对“列出写入类工具却不允许写入”回 403
watch(
  () => model.allowWrite,
  (on) => {
    if (!on) model.tools = model.tools.filter((n) => !isWrite.value.has(n))
  },
)

/** 校验后提交；成功把应答交给调用方显示令牌，失败提示后留在表单。 */
async function submit() {
  if (submitting.value || !(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    const created = await myTokenApi.create({
      name: model.name,
      expiresInDays: expiry.value || null,
      tools: model.tools.length ? model.tools : null,
      allowWrite: model.allowWrite,
      currentPassword: model.currentPassword,
    })
    emit('done', created)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form
    ref="formRef"
    :model="model"
    :rules="rules"
    label-position="left"
    class="token-form"
    @submit.prevent="submit"
  >
    <el-form-item :label="t('field.mcp.token.name')" prop="name">
      <el-input v-model="model.name" name="name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.mcp.token.expiresInDays')">
      <el-radio-group v-model="expiry">
        <el-radio-button v-for="d in EXPIRY" :key="d" :value="d">
          {{ t('mcp.token.days', { n: d }) }}
        </el-radio-button>
        <el-radio-button :value="0">{{ t('mcp.token.never') }}</el-radio-button>
      </el-radio-group>
    </el-form-item>
    <el-form-item :label="t('field.mcp.token.allowWrite')">
      <el-switch v-model="model.allowWrite" :aria-label="t('field.mcp.token.allowWrite')" />
      <el-alert
        v-if="model.allowWrite"
        type="warning"
        :title="t('mcp.token.writeWarning')"
        :closable="false"
        show-icon
        class="token-form__alert"
      />
    </el-form-item>
    <el-form-item :label="t('field.mcp.token.tools')">
      <template v-if="tools.length">
        <el-select
          v-model="model.tools"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :aria-label="t('field.mcp.token.tools')"
          :placeholder="t('mcp.token.allTools')"
        >
          <el-option
            v-for="x in tools"
            :key="x.name"
            :label="toolTitle(x.name, x.title)"
            :value="x.name"
            :disabled="x.kind === 'write' && !model.allowWrite"
          />
        </el-select>
        <div class="token-form__note">{{ t('mcp.token.toolsHint') }}</div>
      </template>
      <div v-else class="token-form__note">{{ t('mcp.token.toolsAllHint') }}</div>
    </el-form-item>
    <el-form-item :label="t('field.mcp.token.currentPassword')" prop="currentPassword">
      <el-input
        v-model="model.currentPassword"
        name="currentPassword"
        type="password"
        show-password
        autocomplete="current-password"
      />
      <div class="token-form__note">
        {{
          t('mcp.token.limitHint', { max: MCP_TOKEN_MAX_PER_USER, days: MCP_TOKEN_TTL_DAYS_MAX })
        }}
      </div>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" :disabled="submitting" @click="submit">
      {{ t('mcp.token.create') }}
    </el-button>
  </div>
</template>

<style scoped>
.token-form__alert {
  margin-top: 8px;
}
.token-form__note {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
