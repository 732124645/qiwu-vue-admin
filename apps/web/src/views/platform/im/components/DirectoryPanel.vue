<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { imGroupCreate, type ImDirectoryDept } from '@qiwu/shared'
import { imApi } from '@/api/platform/im'
import { localized } from '@/core/i18n'
import { useImStore } from '@/core/im/im-store'
import { useAuthStore } from '@/core/stores/auth'
import { deptName, initialOf } from './im-view'

/**
 * 通讯录：本地保存的全量员工与部门（打开聊天时才取、带 ETag 复验），按姓名子串与部门子树在本地筛选；
 * 点人即取或建私聊，也可勾选多人发起群聊。
 */
defineOptions({ name: 'ImDirectoryPanel' })
const emit = defineEmits<{ open: [roomId: number] }>()
const { t } = useI18n()
const im = useImStore()
const auth = useAuthStore()
const keyword = ref('')
const dept = ref<number | null>(null)
const opening = ref<number | null>(null)
const creating = ref(false)
const dialog = ref(false)
const groupLabel = ref('')
const picked = ref<number[]>([])

type DeptNode = { value: number; label: string; children: DeptNode[] }
/** 部门树（el-tree-select 的数据）。 */
const tree = computed(() => {
  const depts = im.directory?.depts ?? []
  const byParent = new Map<number, ImDirectoryDept[]>()
  for (const d of depts) byParent.set(d.parentId, [...(byParent.get(d.parentId) ?? []), d])
  const ids = new Set(depts.map((d) => d.id))
  const build = (parent: number): DeptNode[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.sortNo - b.sortNo)
      .map((d) => ({
        value: d.id,
        label: localized(d.nameI18n ?? null, d.name),
        children: build(d.id),
      }))
  // 根：父部门不在列表里的（停用的父部门不出现）
  return depts
    .filter((d) => !ids.has(d.parentId))
    .sort((a, b) => a.sortNo - b.sortNo)
    .map((d) => ({
      value: d.id,
      label: localized(d.nameI18n ?? null, d.name),
      children: build(d.id),
    }))
})

/** 选中部门及其全部下级。 */
const subtree = computed(() => {
  if (dept.value === null) return null
  const depts = im.directory?.depts ?? []
  const out = new Set([dept.value])
  let grew = true
  while (grew) {
    grew = false
    for (const d of depts)
      if (out.has(d.parentId) && !out.has(d.id)) {
        out.add(d.id)
        grew = true
      }
  }
  return out
})

const people = computed(() => {
  const me = auth.me?.user.id
  const k = keyword.value.trim().toLowerCase()
  const scope = subtree.value
  return (im.directory?.users ?? []).filter(
    (u) =>
      u.id !== me &&
      (!k || u.displayName.toLowerCase().includes(k)) &&
      (!scope || (u.deptId !== null && scope.has(u.deptId))),
  )
})
const others = computed(() => (im.directory?.users ?? []).filter((u) => u.id !== auth.me?.user.id))

async function openDirect(peerId: number) {
  if (opening.value !== null) return
  opening.value = peerId
  try {
    const detail = await imApi.openDirect(peerId)
    await im.applyDetail(detail)
    emit('open', detail.roomId)
  } catch {
    // 接口错误已提示
  } finally {
    opening.value = null
  }
}

const groupValid = computed(
  () => imGroupCreate.safeParse({ label: groupLabel.value, userIds: picked.value }).success,
)

async function createGroup() {
  if (!groupValid.value || creating.value) return
  creating.value = true
  try {
    const detail = await imApi.createGroup(groupLabel.value.trim(), picked.value)
    await im.applyDetail(detail)
    dialog.value = false
    groupLabel.value = ''
    picked.value = []
    emit('open', detail.roomId)
  } catch {
    // 接口错误已提示
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="im-dir">
    <div class="im-dir__filters">
      <el-input
        v-model="keyword"
        clearable
        :placeholder="t('im.directory.search')"
        :aria-label="t('im.directory.search')"
      />
      <el-tree-select
        v-model="dept"
        :data="tree"
        clearable
        check-strictly
        :placeholder="t('im.directory.allDepts')"
        :aria-label="t('im.directory.dept')"
      />
      <el-button type="primary" plain @click="dialog = true">{{
        t('im.directory.createGroup')
      }}</el-button>
    </div>
    <ul class="im-dir__list" :aria-label="t('im.directory.label')">
      <li v-for="u in people" :key="u.id">
        <button
          type="button"
          class="im-dir__item"
          :disabled="opening !== null"
          :aria-label="t('im.directory.chatWith', { name: u.displayName })"
          @click="openDirect(u.id)"
        >
          <span class="im-dir__avatar" aria-hidden="true">
            <img v-if="u.avatarUrl" :src="u.avatarUrl" alt="" />
            <template v-else>{{ initialOf(u.displayName) }}</template>
          </span>
          <span class="im-dir__name">{{ u.displayName }}</span>
          <span class="im-dir__dept">{{ deptName(im.directory, u.deptId) }}</span>
        </button>
      </li>
      <li v-if="!people.length" class="im-dir__empty">{{ t('im.directory.empty') }}</li>
    </ul>
    <el-dialog v-model="dialog" :title="t('im.directory.createGroup')" width="480px" append-to-body>
      <el-form label-position="top" @submit.prevent="createGroup">
        <el-form-item :label="t('im.group.name')">
          <el-input v-model="groupLabel" maxlength="80" show-word-limit />
        </el-form-item>
        <el-form-item :label="t('im.group.pickMembers')">
          <el-select
            v-model="picked"
            multiple
            filterable
            :placeholder="t('im.group.pickMembers')"
            :aria-label="t('im.group.pickMembers')"
          >
            <el-option v-for="u in others" :key="u.id" :label="u.displayName" :value="u.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ t('common.action.cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="creating"
          :disabled="!groupValid || creating"
          @click="createGroup"
          >{{ t('im.group.create') }}</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.im-dir {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.im-dir__filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px;
}
.im-dir__list {
  flex: 1;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  list-style: none;
}
.im-dir__item {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 8px 12px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--qw-radius-sm);
}
.im-dir__item:hover {
  background: var(--qw-surface-2);
}
.im-dir__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.im-dir__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.im-dir__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.im-dir__dept {
  font-size: 12px;
  color: var(--qw-text-3);
}
.im-dir__empty {
  padding: 24px 12px;
  color: var(--qw-text-3);
  text-align: center;
}
</style>
