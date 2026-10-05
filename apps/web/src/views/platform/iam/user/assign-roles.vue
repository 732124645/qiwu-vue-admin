<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type TableInstance } from 'element-plus'
import type { RoleOption, UserDetailVo } from '@qiwu/shared'
import { roleApi } from '@/api/platform/iam/role'
import { userApi } from '@/api/platform/iam/user'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { useTagsStore } from '@/core/stores/tags'

/**
 * Assign roles (hidden page `/iam/users/:id/roles`, the `visible = 0` menu row delivered with the
 * `iam.user.assign-roles` action): the user's roles ticked among the roles the caller may assign
 * (GET /api/iam/roles/options); saving replaces them (PUT /:id/roles, the server's grant policy) and applies
 * from the user's next request. Roles the user holds that are not offered (disabled, or root for a
 * non-root caller) are sent back unchanged.
 */
defineOptions({ name: 'IamUserAssignRoles' })
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tags = useTagsStore()
const id = Number(route.params.id)

const user = shallowRef<UserDetailVo>()
const roles = shallowRef<RoleOption[]>([])
const picked = ref<number[]>([])
const tableRef = ref<TableInstance>()
const loading = ref(true)
const saving = ref(false)

const offered = computed(() => new Set(roles.value.map((r) => r.id)))
/** held roles the list does not offer: kept as they are */
const kept = computed(() => user.value?.roleIds.filter((r) => !offered.value.has(r)) ?? [])

async function load() {
  try {
    const [u, r] = await Promise.all([userApi.get(id), roleApi.options()])
    user.value = u
    roles.value = r
    await nextTick()
    for (const role of r)
      if (u.roleIds.includes(role.id)) tableRef.value?.toggleRowSelection(role, true)
  } catch {
    // the request layer showed it (404: not in the caller's scope)
  } finally {
    loading.value = false
  }
}
void load()

const onSelect = (rows: RoleOption[]) => (picked.value = rows.map((r) => r.id))

function back() {
  tags.close((tag) => tag.path === route.path)
  return router.push('/iam/users')
}

async function save() {
  if (!user.value || saving.value) return
  saving.value = true
  try {
    await userApi.assignRoles(id, [...picked.value, ...kept.value])
    ElMessage.success(t('iam.user.assignRoles.done'))
    await back()
  } catch {
    // toasted by the request layer (403 grant_exceeds_own, 404, 422)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <el-button @click="back">
        <el-icon class="el-icon--left"><Icon icon="lucide:arrow-left" /></el-icon>
        {{ t('iam.user.assignRoles.back') }}
      </el-button>
    </div>

    <el-card v-loading="loading" class="assign-roles__user">
      <el-descriptions v-if="user" :title="t('iam.user.assignRoles.user')" :column="3">
        <el-descriptions-item :label="t('field.iam.user.username')">
          {{ user.username }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.displayName')">
          {{ user.displayName }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.user.deptName')">
          {{ user.deptName ? tx(user.deptName) : '' }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="qw-table-panel">
      <div class="assign-roles__head">
        <span class="assign-roles__title">{{ t('iam.user.assignRoles.roles') }}</span>
        <span v-if="kept.length" class="assign-roles__kept">
          {{ t('iam.user.assignRoles.kept', { count: kept.length }) }}
        </span>
      </div>
      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="roles"
        row-key="id"
        :aria-label="t('iam.user.assignRoles.roles')"
        @selection-change="onSelect"
      >
        <el-table-column type="selection" width="48" />
        <el-table-column :label="t('iam.user.assignRoles.roleName')" min-width="200">
          <template #default="{ row }">{{ tx(row.name) }}</template>
        </el-table-column>
        <el-table-column prop="code" :label="t('iam.user.assignRoles.roleCode')" min-width="200" />
      </el-table>
      <div class="assign-roles__footer">
        <el-button @click="back">{{ t('common.action.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" :disabled="!user" @click="save">
          {{ t('crud.action.save') }}
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.assign-roles__user :deep(.el-descriptions__header) {
  margin-bottom: 12px;
}
.assign-roles__head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  align-items: baseline;
  padding: 16px;
}
.assign-roles__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--qw-text);
}
.assign-roles__kept {
  font-size: 13px;
  color: var(--qw-text-3);
}
.assign-roles__footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 16px;
  border-top: 1px solid var(--qw-border);
}
.assign-roles__footer > .el-button + .el-button {
  margin-left: 0;
}
</style>
