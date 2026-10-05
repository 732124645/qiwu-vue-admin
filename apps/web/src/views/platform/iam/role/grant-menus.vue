<script setup lang="ts">
import { ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { RoleMenuNode } from '@qiwu/shared'
import { roleApi } from '@/api/platform/iam/role'
import DictTag from '@/core/components/DictTag.vue'
import { localized } from '@/core/i18n'
import GrantTree from './grant-tree.vue'

/**
 * The menu grant of a role (`iam.role.grant`), dialog content opened from the role list: every
 * menu as a checkbox tree (GET /menu-tree), the role's menus and link switch (GET /:id/menus); saving
 * replaces them (PUT /:id/menus) and applies from the holders' next request. Disabled menus stay grantable
 * (they grant nothing while disabled).
 */
defineOptions({ name: 'IamRoleGrantMenus' })
const { id } = defineProps<{ id: number }>()
const emit = defineEmits<{ done: [saved: true]; cancel: [] }>()
const { t } = useI18n()

const menus = shallowRef<RoleMenuNode[]>([])
const stored = shallowRef<number[]>([])
const link = ref(true)
const loading = ref(true)
/** both answers arrived: a save without them would clear what the role has */
const loaded = ref(false)
const saving = ref(false)
const tree = useTemplateRef<{ picked(): number[] }>('tree')

Promise.all([roleApi.menuTree(), roleApi.menus(id)])
  .then(([forest, grant]) => {
    link.value = grant.menuLink
    menus.value = forest
    stored.value = grant.menuIds
    loaded.value = true
  })
  .catch(() => undefined) // the request layer showed it (403, 404)
  .finally(() => (loading.value = false))

const name = (n: RoleMenuNode) => localized(n.nameI18n, n.name)

async function save() {
  if (saving.value || !loaded.value || !tree.value) return
  saving.value = true
  try {
    await roleApi.setMenus(id, { menuLink: link.value, menuIds: tree.value.picked() })
    ElMessage.success(t('iam.role.grant.done'))
    emit('done', true)
  } catch {
    // toasted by the request layer (403 grant_exceeds_own, 404, 422)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-loading="loading">
    <p class="grant-menus__hint">{{ t('iam.role.grant.hint') }}</p>
    <GrantTree
      ref="tree"
      v-model:link="link"
      :data="menus"
      :stored
      :label="name"
      :expanded="menus.map((m) => m.id)"
      :tree-label="t('field.iam.role.menuIds')"
    >
      <template #default="{ node }: { node: RoleMenuNode }">
        <span class="grant-menus__node" :class="{ 'is-off': !node.enabled }">
          <span>{{ name(node) }}</span>
          <span v-if="node.perms" class="grant-menus__perms">{{ node.perms }}</span>
          <DictTag v-if="!node.enabled" code="core.enabled" :value="false" />
        </span>
      </template>
    </GrantTree>
  </div>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="saving" :disabled="!loaded" @click="save">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>

<style scoped>
.grant-menus__hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.grant-menus__node {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}
.grant-menus__node.is-off > span:first-child {
  color: var(--qw-text-3);
}
.grant-menus__perms {
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
