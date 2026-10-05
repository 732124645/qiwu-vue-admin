<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { DataScopeCode, DeptTreeNode } from '@qiwu/shared'
import { deptApi } from '@/api/platform/iam/dept'
import { roleApi } from '@/api/platform/iam/role'
import { useDict } from '@/core/composables/use-dict'
import { tx } from '@/core/i18n'
import { useAuthStore } from '@/core/stores/auth'
import GrantTree from './grant-tree.vue'

/**
 * The data scope of a role (`iam.role.grant`; see docs/design-notes.md#data-scope), dialog content opened from the role
 * list: the scope (dict `iam.data_scope`; `all` only for a root editor, the server refuses it to others)
 * and, for `picked_depts`, the depts as a checkbox tree of the editor's own depts (GET /api/iam/depts/tree)
 * with the role's `dept_link` switch. Picked depts the editor cannot see are sent back unchanged. Saving
 * (PUT /:id/data-scope) applies from the holders' next request.
 */
defineOptions({ name: 'IamRoleDataScope' })
const { id } = defineProps<{ id: number }>()
const emit = defineEmits<{ done: [saved: true]; cancel: [] }>()
const { t } = useI18n()
const auth = useAuthStore()

const scopes = useDict('iam.data_scope')
const offered = computed(() =>
  scopes.options.value.filter((o) => o.value !== 'all' || auth.roles.includes('root')),
)
const scope = ref<DataScopeCode>()
const link = ref(true)
const depts = shallowRef<DeptTreeNode[]>([])
const stored = shallowRef<number[]>([])
const loading = ref(true)
/** both answers arrived: a save without them would clear what the role has */
const loaded = ref(false)
const saving = ref(false)
const tree = useTemplateRef<{ picked(): number[] }>('tree')

Promise.all([deptApi.tree(), roleApi.dataScope(id)])
  .then(([forest, current]) => {
    depts.value = forest
    scope.value = current.dataScope
    link.value = current.deptLink
    stored.value = current.deptIds
    loaded.value = true
  })
  .catch(() => undefined) // the request layer showed it (403, 404)
  .finally(() => (loading.value = false))

const all = (nodes: DeptTreeNode[]): number[] => nodes.flatMap((n) => [n.id, ...all(n.children)])
/** picked depts outside the editor's tree (out of its scope or disabled): kept as they are */
const kept = computed(() => {
  const shown = new Set(all(depts.value))
  return stored.value.filter((d) => !shown.has(d))
})

async function save() {
  if (saving.value || !loaded.value || !scope.value) return
  const picked = scope.value === 'picked_depts'
  saving.value = true
  try {
    await roleApi.setDataScope(id, {
      dataScope: scope.value,
      deptLink: link.value,
      deptIds: picked ? [...(tree.value?.picked() ?? []), ...kept.value] : [],
    })
    ElMessage.success(t('iam.role.dataScope.done'))
    emit('done', true)
  } catch {
    // toasted by the request layer (403 grant_exceeds_own, 404, 422)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-form v-loading="loading" label-position="left" @submit.prevent>
    <el-form-item :label="t('field.iam.role.dataScope')">
      <el-select v-model="scope" :aria-label="t('field.iam.role.dataScope')">
        <el-option v-for="o in offered" :key="o.value" :value="o.value" :label="o.label" />
      </el-select>
    </el-form-item>
    <!-- v-show: switching the scope back and forth keeps the ticks -->
    <el-form-item v-show="scope === 'picked_depts'" :label="t('field.iam.role.deptIds')">
      <GrantTree
        ref="tree"
        v-model:link="link"
        class="data-scope__tree"
        :data="depts"
        :stored
        :label="(d: DeptTreeNode) => tx(d.name)"
        :expanded="all(depts)"
        :tree-label="t('field.iam.role.deptIds')"
      />
      <p v-if="kept.length" class="data-scope__kept">
        {{ t('iam.role.dataScope.kept', { count: kept.length }) }}
      </p>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="saving" :disabled="!loaded" @click="save">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.data-scope__tree {
  width: 100%;
}
.data-scope__kept {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--qw-text-3);
}
</style>
