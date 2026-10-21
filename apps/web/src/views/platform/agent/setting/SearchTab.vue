<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AGENT_WEB_DOMAINS_PARAM,
  AGENT_WEB_MODE_PARAM,
  AGENT_WEB_MODES,
  agentPerms,
} from '@qiwu/shared'
import { agentSearchApi } from '@/api/platform/agent-admin'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import SearchForm from './SearchForm.vue'
import { useList } from './use-list'
import { useAgentParams } from './use-params'

/**
 * “联网搜索”标签：联网模式（实时 / 关闭）与可直接读取的域名（系统参数，只有 root 能改，
 * 模式切换即保存），以及搜索提供方列表（博查、Tavily；密钥只显示是否已保存，同样只有 root 能改）。
 */
defineOptions({ name: 'AgentSearchTab' })
const { t } = useI18n()
const modify = agentPerms.setting.modify
const { rows, loading, refresh, remove } = useList(agentSearchApi.list)
const { isRoot, params, loading: paramsLoading, saving, save } = useAgentParams()
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.agent.search.name', minWidth: 160, showOverflowTooltip: true },
  { prop: 'kind', label: 'field.agent.search.kind', width: 100 },
  { prop: 'hasKey', label: 'field.agent.search.apiKey', width: 100 },
  { prop: 'enabled', label: 'field.agent.search.enabled', width: 90 },
  { prop: 'isDefault', label: 'field.agent.search.isDefault', width: 90 },
]
/** 域名输入框的内容：跟随载入的参数值，保存前可编辑 */
const domains = ref('')
watch(
  () => params.value[AGENT_WEB_DOMAINS_PARAM]?.paramValue,
  (v) => (domains.value = v ?? ''),
)

/** 新增（无 id）或编辑提供方，保存后重新载入。 */
async function openForm(id?: number) {
  const name = () => t('agent.admin.search.entity')
  const saved = await openDialog(
    SearchForm,
    { id },
    { title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }) },
  )
  if (saved) await refresh()
}
</script>

<template>
  <div>
    <section v-loading="paramsLoading" class="search-tab__web">
      <el-form label-position="left" @submit.prevent>
        <el-form-item :label="t('agent.admin.web.mode')">
          <el-radio-group
            :model-value="params[AGENT_WEB_MODE_PARAM]?.paramValue"
            :disabled="!isRoot || saving != null"
            @change="save({ [AGENT_WEB_MODE_PARAM]: String($event) })"
          >
            <el-radio v-for="m in AGENT_WEB_MODES" :key="m" :value="m">
              {{ t(`agent.admin.web.${m}`) }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('agent.admin.web.domains')">
          <div class="search-tab__domains">
            <el-input
              v-model="domains"
              :readonly="!isRoot"
              maxlength="4000"
              :placeholder="t('agent.admin.web.domainsHint')"
            />
            <el-button
              v-if="isRoot"
              :loading="saving === AGENT_WEB_DOMAINS_PARAM"
              :disabled="saving != null"
              @click="save({ [AGENT_WEB_DOMAINS_PARAM]: domains.trim() })"
            >
              {{ t('crud.action.save') }}
            </el-button>
          </div>
        </el-form-item>
      </el-form>
      <p v-if="!isRoot" class="search-tab__hint">{{ t('agent.admin.rootOnly') }}</p>
    </section>

    <TableToolbar table-id="agent.search" :columns="columns" :searchable="false" @refresh="refresh">
      <el-button v-if="isRoot" v-perm="modify" type="primary" @click="openForm()">
        {{ t('crud.action.create') }}
      </el-button>
    </TableToolbar>
    <QwTable
      table-id="agent.search"
      :columns="columns"
      :data="rows"
      :loading="loading"
      row-key="id"
    >
      <template #cell-kind="{ row }">{{ t(`agent.admin.search.kind.${row.kind}`) }}</template>
      <template #cell-hasKey="{ row }">
        <el-tag size="small" :type="row.hasKey ? 'success' : 'warning'" disable-transitions>
          {{ t(row.hasKey ? 'agent.admin.keyStored' : 'agent.admin.keyMissing') }}
        </el-tag>
      </template>
      <template #cell-enabled="{ row }">
        <el-tag size="small" :type="row.enabled ? 'success' : 'info'" disable-transitions>
          {{ t(row.enabled ? 'agent.admin.on' : 'agent.admin.off') }}
        </el-tag>
      </template>
      <template #cell-isDefault="{ row }">
        <el-tag v-if="row.isDefault" size="small" disable-transitions>
          {{ t('agent.admin.default') }}
        </el-tag>
      </template>
      <template #actions="{ row }">
        <el-button v-if="isRoot" v-perm="modify" link type="primary" @click="openForm(row.id)">
          {{ t('crud.action.edit') }}
        </el-button>
        <el-button
          v-if="isRoot"
          v-perm="modify"
          link
          type="danger"
          @click="remove(() => agentSearchApi.remove(row.id))"
        >
          {{ t('crud.action.delete') }}
        </el-button>
      </template>
    </QwTable>
  </div>
</template>

<style scoped>
.search-tab__web {
  max-width: 720px;
  margin-bottom: 16px;
}
.search-tab__domains {
  display: flex;
  gap: 8px;
  width: 100%;
}
.search-tab__hint {
  margin: 0;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
