<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { WfUserOption } from '@qiwu/shared'
import IconButton from '@/core/components/IconButton.vue'
import UserPicker from '@/core/components/UserPicker.vue'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { useUserNames } from './user-names'

/**
 * User ids as tags (picking order) plus a button that opens UserPicker; `v-model` = the ids. `reorder` adds
 * move buttons to the tags (the order matters, e.g. a review's `ordered` sign). `source` goes to UserPicker
 * (`wf`: the process dialogs, every enabled user) and names the ids from the same list. `disabled`: shown only.
 */
defineOptions({ name: 'WfUserIds' })
const ids = defineModel<number[]>({ required: true })
const {
  reorder = false,
  source = 'iam',
  disabled = false,
} = defineProps<{
  reorder?: boolean
  source?: 'iam' | 'wf'
  disabled?: boolean
}>()
const { t } = useI18n()

const names = useUserNames(() => ids.value, source)
const nameOf = (id: number) => names.get(id) ?? `#${id}`

function move(i: number, delta: -1 | 1) {
  const next = [...ids.value]
  ;[next[i], next[i + delta]] = [next[i + delta]!, next[i]!]
  ids.value = next
}

async function pick() {
  const selected: WfUserOption[] = ids.value.map((id) => ({
    id,
    displayName: nameOf(id),
    deptName: null,
  }))
  const users = await openDialog<WfUserOption[]>(
    UserPicker,
    { multiple: true, selected, source },
    { title: () => t('picker.user.title'), width: 880 },
  )
  if (!users) return
  for (const u of users) names.set(u.id, u.displayName)
  ids.value = users.map((u) => u.id)
}
</script>

<template>
  <div class="wf-user-ids">
    <el-tag
      v-for="(id, i) in ids"
      :key="id"
      :closable="!disabled"
      disable-transitions
      @close="ids = ids.filter((x) => x !== id)"
    >
      <IconButton
        v-if="reorder && !disabled && i > 0"
        icon="lucide:chevron-left"
        class="wf-user-ids__move"
        :label="t('wf.designer.assignee.earlier')"
        @click="move(i, -1)"
      />
      {{ nameOf(id) }}
      <IconButton
        v-if="reorder && !disabled && i < ids.length - 1"
        icon="lucide:chevron-right"
        class="wf-user-ids__move"
        :label="t('wf.designer.assignee.later')"
        @click="move(i, 1)"
      />
    </el-tag>
    <el-button size="small" :disabled @click="pick">
      <Icon icon="lucide:user-plus" class="wf-user-ids__icon" />
      {{ t('wf.designer.assignee.pickUsers') }}
    </el-button>
  </div>
</template>

<style scoped>
.wf-user-ids {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.wf-user-ids__icon {
  margin-right: 4px;
}
.wf-user-ids .wf-user-ids__move {
  width: 16px;
  height: 16px;
  color: inherit;
  vertical-align: middle;
}
</style>
