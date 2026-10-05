<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WfUserOption } from '@qiwu/shared'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import IconButton from './IconButton.vue'
import UserPicker from './UserPicker.vue'

/**
 * One user as a form or search field (generated `user-picker` columns; see docs/design-notes.md#codegen): `v-model` = the user
 * id, `null` once cleared; the button opens `UserPicker` (`source` passed on: `wf` in process dialogs).
 * Shows the user picked here by name (and username, from the iam source); an id that came with the row by
 * `label` (a joined name, a hand-written extension), else as `#<id>`. `disabled` locks the pick and the clear.
 */
defineOptions({ name: 'UserSelect' })
const model = defineModel<number | null | undefined>()
const {
  label,
  source = 'iam',
  disabled = false,
} = defineProps<{ label?: string | null; source?: 'iam' | 'wf'; disabled?: boolean }>()
const { t } = useI18n()

type Picked = WfUserOption & { username?: string }
const picked = shallowRef<Picked>()
const text = computed(() => {
  if (model.value == null) return ''
  const u = picked.value
  if (u?.id === model.value) return u.username ? `${u.displayName} (${u.username})` : u.displayName
  return !u && label ? label : `#${model.value}`
})

async function pick() {
  const users = await openDialog<Picked[]>(
    UserPicker,
    { selected: picked.value ? [picked.value] : [], source },
    { title: () => t('picker.user.title'), width: 880 },
  )
  if (!users?.[0]) return
  picked.value = users[0]
  model.value = users[0].id
}
</script>

<template>
  <el-input :model-value="text" readonly :disabled :placeholder="t('picker.user.placeholder')">
    <template v-if="model != null && !disabled" #suffix>
      <IconButton
        class="user-select__clear"
        icon="lucide:x"
        :label="t('picker.user.unpick')"
        @click="model = null"
      />
    </template>
    <template #append>
      <el-button :aria-label="t('picker.user.title')" :disabled @click="pick">
        <el-icon><Icon icon="lucide:user-search" /></el-icon>
      </el-button>
    </template>
  </el-input>
</template>

<style scoped>
/* the clear button fits the input's suffix */
.user-select__clear {
  width: 24px;
  height: 24px;
}
</style>
