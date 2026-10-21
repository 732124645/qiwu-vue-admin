<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AGENT_MCP_AUTH_KINDS, agentMcpServerSave, type AgentMcpServerSave } from '@qiwu/shared'
import { agentMcpServerApi, dropEmpty } from '@/api/platform/agent-admin'
import { useCrudForm } from '@/core/composables/use-crud'
import { useAuthStore } from '@/core/stores/auth'

/**
 * 外部 MCP 服务器的新增 / 编辑表单（`openDialog(McpServerForm, { id })`）：名称、地址、鉴权方式与其只写字段
 * （请求头：名称与值；OAuth 客户端凭据：令牌地址、客户端 id、密钥、范围），留空则保留已保存的鉴权信息；
 * “允许内网地址”只有 root 能看到并勾选（服务端同样只认 root）。
 */
defineOptions({ name: 'AgentMcpServerForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const isRoot = computed(() => useAuthStore().platformRoot)
/** 每种鉴权方式要发送的字段；其余字段不发送 */
const AUTH_FIELDS = {
  none: [],
  header: ['name', 'value'],
  oauth: ['tokenUrl', 'clientId', 'clientSecret', 'scope'],
} as const
/** 这些字段输入时遮住 */
const SECRET = new Set(['value', 'clientSecret'])

/** 只发送当前鉴权方式的字段；全空（或不需要鉴权）时不发送 `auth`，服务端保留已保存的。 */
function body(dto: AgentMcpServerSave): AgentMcpServerSave {
  const keys: readonly string[] = AUTH_FIELDS[dto.authKind]
  const auth = Object.fromEntries(keys.map((k) => [k, dto.auth?.[k] ?? '']))
  return dropEmpty({ ...dto, auth }, 'auth')
}

const { model, row, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: agentMcpServerApi.get,
    create: (dto: AgentMcpServerSave) => agentMcpServerApi.create(body(dto)),
    update: (sid: number, dto: AgentMcpServerSave) => agentMcpServerApi.update(sid, body(dto)),
  },
  schema: agentMcpServerSave,
  emptyModel: () => ({
    name: '',
    url: '',
    authKind: 'none' as const,
    auth: { name: '', value: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '' },
    allowPrivate: false,
    enabled: true,
  }),
  id,
  emit,
})
</script>

<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.agent.mcpServer.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.agent.mcpServer.url')" prop="url">
      <el-input v-model="model.url" maxlength="512" placeholder="https://mcp.example.com/mcp" />
    </el-form-item>
    <el-form-item :label="t('field.agent.mcpServer.authKind')" prop="authKind">
      <el-radio-group v-model="model.authKind">
        <el-radio v-for="k in AGENT_MCP_AUTH_KINDS" :key="k" :value="k">
          {{ t(`agent.admin.mcp.auth.${k}`) }}
        </el-radio>
      </el-radio-group>
      <el-tag v-if="row?.hasAuth" class="mcp-form__stored" size="small" type="success">
        {{ t('agent.admin.keyStored') }}
      </el-tag>
    </el-form-item>
    <el-form-item
      v-for="k in AUTH_FIELDS[model.authKind]"
      :key="k"
      :label="t(`agent.admin.mcp.field.${k}`)"
    >
      <el-input
        v-model="model.auth![k]"
        :type="SECRET.has(k) ? 'password' : 'text'"
        :show-password="SECRET.has(k)"
        autocomplete="new-password"
        maxlength="2048"
        :placeholder="row?.hasAuth ? t('crud.placeholder.secretKeep') : ''"
      />
    </el-form-item>
    <el-form-item
      v-if="isRoot"
      :label="t('field.agent.mcpServer.allowPrivate')"
      prop="allowPrivate"
    >
      <el-switch v-model="model.allowPrivate" />
      <div class="mcp-form__hint">{{ t('agent.admin.mcp.allowPrivateHint') }}</div>
    </el-form-item>
    <el-form-item :label="t('field.agent.mcpServer.enabled')" prop="enabled">
      <el-switch v-model="model.enabled" />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.mcp-form__stored {
  margin-left: 8px;
}
.mcp-form__hint {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
</style>
