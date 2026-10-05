<script setup lang="ts">
import { ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { wfPerms, type WfModelVo, type WfVersionVo } from '@qiwu/shared'
import { wfModelApi } from '@/api/workflow/model'
import { toastRest } from '@/core/composables/use-crud'
import { Icon } from '@/core/icons'
import { ApiError, saveBlob } from '@/core/request/http'
import { at } from '../center/use-center-list'
import { useUserNames } from '../designer/user-names'
import { exportJson, importBody } from './model-list'

/**
 * 版本列表 of 模型管理: the model's published versions, newest first, the current one marked.
 * A version exported as JSON (its tree and fields), a JSON imported as the next version through
 * the publish endpoint (the server's `compile`, as for a designed tree); `published` tells the list. A BPMN
 * model's version is exported as its `.bpmn` too, and nothing is imported here: its designer imports.
 */
defineOptions({ name: 'WfModelVersions' })
const { model } = defineProps<{ model: WfModelVo }>()
const emit = defineEmits<{ published: [] }>()
const { t } = useI18n()

const rows = shallowRef<WfVersionVo[]>([])
const current = ref(model.currentVersionId)
const loading = ref(true)
function load() {
  loading.value = true
  return wfModelApi
    .versions(model.id)
    .then((list) => (rows.value = list))
    .catch(toastRest)
    .finally(() => (loading.value = false))
}
void load()
const names = useUserNames(() =>
  rows.value.flatMap((v) => (v.publishedBy == null ? [] : [v.publishedBy])),
)
const publisher = (v: WfVersionVo) =>
  v.publishedBy == null
    ? t('wf.model.versions.seeded')
    : (names.get(v.publishedBy) ?? `#${v.publishedBy}`)

const bpmn = model.flowKind === 'bpmn'
/** `<version id>.<json | bpmn>` being exported */
const exporting = ref<string>()
/** the version's JSON (its tree and fields), or a BPMN one's diagram */
async function exportVersion(v: WfVersionVo, as: 'json' | 'bpmn') {
  exporting.value = `${v.id}.${as}`
  const name = `${model.modelKey}-v${v.version}.${as}`
  try {
    const detail = await wfModelApi.version(model.id, v.id)
    if (as === 'json')
      saveBlob(new Blob([exportJson(model.modelKey, detail)], { type: 'application/json' }), name)
    else if (detail.bpmnXml) saveBlob(new Blob([detail.bpmnXml], { type: 'application/xml' }), name)
  } catch (e) {
    toastRest(e)
  } finally {
    exporting.value = undefined
  }
}

const file = useTemplateRef<HTMLInputElement>('file')
const importing = ref(false)
async function importFile() {
  const picked = file.value?.files?.[0]
  if (!picked || importing.value) return
  // the same file can be picked again after a fix
  file.value!.value = ''
  const body = importBody(model, await picked.text())
  if (!body) {
    ElMessage.error(t('wf.model.versions.badJson'))
    return
  }
  const version = (rows.value[0]?.version ?? 0) + 1
  try {
    await ElMessageBox.confirm(
      t('wf.model.design.publishConfirm', { version }),
      t('wf.model.versions.importTitle'),
      {
        type: 'warning',
        confirmButtonText: t('wf.model.design.publish'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  importing.value = true
  try {
    const v = await wfModelApi.publish(model.id, body)
    ElMessage.success(t('wf.model.design.published', { version: v.version }))
    current.value = v.id
    emit('published')
    await load()
  } catch (e) {
    // no designer here to mark the nodes: the check's own words (the step's name)
    if (e instanceof ApiError && e.status === 400 && e.errors?.length)
      ElMessage.error(e.errors[0]!.msg)
    else toastRest(e)
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="wf-versions">
    <div v-if="!bpmn" v-perm="wfPerms.model.publish" class="wf-versions__bar">
      <input
        ref="file"
        type="file"
        accept=".json,application/json"
        hidden
        :aria-label="t('wf.model.versions.importJson')"
        @change="importFile"
      />
      <el-button :loading="importing" :disabled="loading" @click="file?.click()">
        <el-icon class="el-icon--left"><Icon icon="lucide:upload" /></el-icon>
        {{ t('wf.model.versions.importJson') }}
      </el-button>
    </div>
    <el-table v-loading="loading" :data="rows" row-key="id" max-height="420">
      <el-table-column :label="t('wf.model.versions.version')" width="120">
        <template #default="{ row }">
          v{{ row.version }}
          <el-tag v-if="row.id === current" size="small" type="success" disable-transitions>
            {{ t('wf.model.versions.current') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('wf.model.versions.publishedAt')" width="170">
        <template #default="{ row }">{{ at(row.publishedAt) }}</template>
      </el-table-column>
      <el-table-column :label="t('wf.model.versions.publishedBy')" width="140">
        <template #default="{ row }">{{ publisher(row) }}</template>
      </el-table-column>
      <el-table-column :label="t('field.wf.model.fields')" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{
          Object.keys(row.formSnapshot.fields).join(', ')
        }}</template>
      </el-table-column>
      <el-table-column :label="t('crud.action.operations')" :width="bpmn ? 200 : 110">
        <template #default="{ row }">
          <el-button
            link
            type="primary"
            :loading="exporting === `${row.id}.json`"
            @click="exportVersion(row, 'json')"
          >
            {{ t('wf.model.versions.exportJson') }}
          </el-button>
          <el-button
            v-if="bpmn"
            link
            type="primary"
            :loading="exporting === `${row.id}.bpmn`"
            @click="exportVersion(row, 'bpmn')"
          >
            {{ t('wf.model.versions.exportBpmn') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>{{ t('wf.model.versions.none') }}</template>
    </el-table>
  </div>
</template>

<style scoped>
.wf-versions__bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
</style>
