<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  tenantPackageCreate,
  type RoleMenuNode,
  type TenantPackageCreate,
  type TenantPackageUpdate,
} from '@qiwu/shared'
import { tenantPackageApi } from '@/api/platform/iam/tenant-package'
import { useCrudForm } from '@/core/composables/use-crud'
import { localized } from '@/core/i18n'
import GrantTree from '../role/grant-tree.vue'

/**
 * Add / edit form of the package list, opened with `openDialog(PackageForm, { id })`. The menus come as the
 * role grant tree over the menus open to tenants (GET /menu-tree, no platform-only ones); saving sends the
 * picked ones with their ancestors, replacing what the package held; an edit sends them only when they
 * changed (new menus make every session reload its permissions). Enabling and disabling is the list's
 * (confirmed there): an add starts enabled, an edit never sends `enabled`.
 */
defineOptions({ name: 'IamTenantPackageForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [saved: TenantPackageCreate & { id: number }]; cancel: [] }>()
const { t } = useI18n()
const sameIds = (a: number[], b: number[]) => {
  const x = new Set(a)
  return x.size === new Set(b).size && b.every((i) => x.has(i))
}
const { model, formRef, rules, loading, submitting, submit, row } = useCrudForm({
  api: {
    ...tenantPackageApi,
    update: (pid: number, { menuIds, ...dto }: TenantPackageUpdate): Promise<unknown> =>
      tenantPackageApi.update(
        pid,
        menuIds && row.value && sameIds(menuIds, row.value.menuIds) ? dto : { ...dto, menuIds },
      ),
  },
  schema: tenantPackageCreate,
  emptyModel: () => ({
    name: '',
    note: '',
    menuIds: [] as number[],
    ...(id == null && { enabled: true }),
  }),
  id,
  emit,
})

const menus = shallowRef<RoleMenuNode[]>([])
const link = ref(true)
const treeLoading = ref(true)
/** the tree arrived: a save without it would clear what the package holds */
const treeLoaded = ref(false)
const tree = useTemplateRef<{ picked(): number[] }>('tree')
tenantPackageApi
  .menuTree()
  .then((forest) => {
    menus.value = forest
    treeLoaded.value = true
  })
  .catch(() => undefined) // the request layer showed it
  .finally(() => (treeLoading.value = false))

const name = (n: RoleMenuNode) => localized(n.nameI18n, n.name)
// one array per tree: a new one on every render would expand the groups the user folded again
const expanded = computed(() => menus.value.map((m) => m.id))

function save() {
  if (!treeLoaded.value || !tree.value) return
  model.menuIds = tree.value.picked()
  return submit()
}
</script>

<template>
  <el-form
    ref="formRef"
    v-loading="loading || treeLoading"
    :model="model"
    :rules="rules"
    label-position="left"
  >
    <el-form-item :label="t('field.iam.tenantPackage.name')" prop="name">
      <el-input v-model="model.name" maxlength="64" />
    </el-form-item>
    <el-form-item :label="t('field.iam.tenantPackage.note')" prop="note">
      <el-input v-model="model.note" type="textarea" :rows="2" maxlength="500" show-word-limit />
    </el-form-item>
    <el-form-item :label="t('field.iam.tenantPackage.menuIds')" prop="menuIds">
      <div class="package-menus">
        <p class="package-menus__hint">{{ t('iam.tenantPackage.menusHint') }}</p>
        <GrantTree
          ref="tree"
          v-model:link="link"
          :data="menus"
          :stored="model.menuIds"
          :label="name"
          :expanded="expanded"
          :tree-label="t('iam.tenantPackage.tree')"
        >
          <template #default="{ node }: { node: RoleMenuNode }">
            <span class="package-menus__node">
              <span>{{ name(node) }}</span>
              <span v-if="node.perms" class="package-menus__perms">{{ node.perms }}</span>
            </span>
          </template>
        </GrantTree>
      </div>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" :disabled="!treeLoaded" @click="save">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.package-menus {
  width: 100%;
}
.package-menus__hint {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--qw-text-3);
}
.package-menus__node {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}
.package-menus__perms {
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
