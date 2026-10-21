<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { agentPerms, type AgentSkillVo } from '@qiwu/shared'
import { agentPlatformSkillApi, agentSkillApi } from '@/api/platform/agent-admin'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import { saveBlob } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useList } from '../setting/use-list'
import SkillForm from './SkillForm.vue'
import SkillImport from './SkillImport.vue'

/**
 * 技能列表：技能管理页（`platform` 为否：本人、本租户与平台技能，按范围标注）与智能体设置的“平台技能”
 * （`platform`：只有平台技能，修改要 root 且有 `agent.setting.modify`）共用。新增、导入 SKILL.md、导出、启停、删除；
 * 能否改一行看服务端给的 `editable`，租户范围的再看本人有没有 `agent.skill.*` 对应权限。
 * 地址带 `?edit=<id>`（会话“存成技能”生成的草稿）时直接打开它的编辑框。
 */
defineOptions({ name: 'AgentSkillList' })
const { platform = false } = defineProps<{ platform?: boolean }>()
const { t } = useI18n()
const perm = usePerm()
const api = platform ? agentPlatformSkillApi : agentSkillApi
const tableId = platform ? 'agent.platformSkill' : 'agent.skill'
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.agent.skill.name', width: 180, showOverflowTooltip: true },
  ...(platform ? [] : [{ prop: 'scope', label: 'field.agent.skill.scope', width: 100 }]),
  { prop: 'enabled', label: 'field.agent.skill.enabled', width: 90 },
  {
    prop: 'description',
    label: 'field.agent.skill.description',
    minWidth: 240,
    showOverflowTooltip: true,
  },
]

/** 平台技能只有持设置权限的 root 能改（服务端同样只许 root），其他人只读。 */
const auth = useAuthStore()
const platformEditable = computed(() => auth.platformRoot && perm.has(agentPerms.setting.modify))
/** 新增技能的范围：技能管理页可建个人技能，有 `agent.skill.create` 时还能建租户技能。 */
const canTenant = computed(() => perm.has(agentPerms.skill.create))
const canCreate = computed(() =>
  platform ? platformEditable.value : perm.has(agentPerms.chat.use) || canTenant.value,
)
/** 一行能否修改 / 删除：平台页看 root 与设置权限；其余看 `editable`，租户范围的另需对应技能权限。 */
function can(row: AgentSkillVo, verb: 'modify' | 'remove') {
  if (platform) return platformEditable.value
  return row.editable && (row.scope !== 'tenant' || perm.has(agentPerms.skill[verb]))
}

const { rows, loading, refresh, remove: confirmRemove } = useList(() => api.list())

// 从会话“存成技能”跳来（`?edit=<id>`）：打开这个新草稿，并从地址里去掉参数，刷新时不再弹出
const route = useRoute()
const router = useRouter()
if (!platform) {
  const draft = Number(route.query.edit)
  if (Number.isInteger(draft) && draft > 0) {
    const query = { ...route.query }
    delete query.edit
    void router.replace({ query })
    void openForm(draft)
  }
}

/** 新增（无 id）或编辑技能，保存后重新载入。 */
async function openForm(id?: number) {
  const name = () => t('agent.admin.skill.entity')
  const saved = await openDialog(
    SkillForm,
    { id, platform, canTenant: canTenant.value },
    {
      title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }),
      width: 860,
    },
  )
  if (saved) await refresh()
}

/** 导入 SKILL.md，成功后重新载入。 */
async function openImport() {
  const saved = await openDialog(
    SkillImport,
    { platform, canTenant: canTenant.value },
    { title: () => t('agent.admin.skill.importTitle'), width: 640 },
  )
  if (saved) await refresh()
}

/** 正在处理的行（导出 / 启停）：按钮与开关在请求期间加载并禁用。 */
const busy = ref<number>()

/** 导出为 SKILL.md 文件（服务端生成文本，页面存成文件）。 */
async function exportSkill(row: AgentSkillVo) {
  if (busy.value) return
  busy.value = row.id
  try {
    const { text } = await api.exportText(row.id)
    saveBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), 'SKILL.md')
  } catch (e) {
    toastRest(e)
  } finally {
    busy.value = undefined
  }
}

/** 启用 / 停用：按保存接口整条提交，完成后以服务端为准重新载入。 */
async function setEnabled(row: AgentSkillVo, enabled: boolean) {
  if (busy.value) return
  busy.value = row.id
  try {
    await api.update(row.id, {
      scope: row.scope === 'tenant' ? 'tenant' : 'user',
      name: row.name,
      description: row.description,
      body: row.body,
      tools: row.tools,
      enabled,
    })
  } catch (e) {
    toastRest(e)
  } finally {
    await refresh()
    busy.value = undefined
  }
}

/** 确认后删除一个技能并重新载入。 */
const remove = (row: AgentSkillVo) => confirmRemove(() => api.remove(row.id))
</script>

<template>
  <div>
    <p v-if="platform && !platformEditable" class="skill-list__hint">
      {{ t('agent.admin.rootOnly') }}
    </p>
    <TableToolbar :table-id="tableId" :columns="columns" :searchable="false" @refresh="refresh">
      <el-button v-if="canCreate" type="primary" @click="openForm()">
        {{ t('crud.action.create') }}
      </el-button>
      <el-button v-if="canCreate" @click="openImport">{{ t('crud.action.import') }}</el-button>
    </TableToolbar>
    <QwTable :table-id="tableId" :columns="columns" :data="rows" :loading="loading" row-key="id">
      <template #cell-name="{ row }">
        <code class="skill-list__mono">${{ row.name }}</code>
      </template>
      <template #cell-scope="{ row }">
        <el-tag size="small" :type="row.scope === 'user' ? 'info' : 'primary'" disable-transitions>
          {{ t(`agent.admin.scope.${row.scope}`) }}
        </el-tag>
      </template>
      <template #cell-enabled="{ row }">
        <el-switch
          v-if="can(row, 'modify')"
          size="small"
          :model-value="row.enabled"
          :loading="busy === row.id"
          :disabled="busy != null"
          :aria-label="`${t('field.agent.skill.enabled')} ${row.name}`"
          @change="setEnabled(row, $event as boolean)"
        />
        <el-tag v-else size="small" :type="row.enabled ? 'success' : 'info'" disable-transitions>
          {{ t(row.enabled ? 'agent.admin.on' : 'agent.admin.off') }}
        </el-tag>
      </template>
      <template #actions="{ row }">
        <el-button v-if="can(row, 'modify')" link type="primary" @click="openForm(row.id)">
          {{ t('crud.action.edit') }}
        </el-button>
        <el-button
          link
          type="primary"
          :loading="busy === row.id"
          :disabled="busy != null"
          @click="exportSkill(row)"
        >
          {{ t('crud.action.export') }}
        </el-button>
        <el-button v-if="can(row, 'remove')" link type="danger" @click="remove(row)">
          {{ t('crud.action.delete') }}
        </el-button>
      </template>
    </QwTable>
  </div>
</template>

<style scoped>
.skill-list__hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--qw-text-3);
}
.skill-list__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
