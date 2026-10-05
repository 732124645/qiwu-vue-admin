<script setup lang="ts">
import { toValue, watch } from 'vue'
import { useRoute } from 'vue-router'
import { dialogs, type DialogEntry } from '.'

/**
 * Renders the `openDialog` stack; mounted once in App.vue inside the providers. Later dialogs stack on top
 * (append-to-body), ESC closes the top one (unless it opted out); the overlay does not close a dialog (no
 * lost form input).
 */
defineOptions({ name: 'DialogHost' })
const route = useRoute()
watch(
  () => route.path,
  () => dialogs.forEach((d) => d.closeOnRouteChange !== false && d.settle()),
)
function remove(d: DialogEntry) {
  const i = dialogs.indexOf(d)
  if (i >= 0) dialogs.splice(i, 1)
}
</script>

<template>
  <el-dialog
    v-for="d in dialogs"
    :key="d.id"
    :model-value="d.visible"
    :title="toValue(d.title)"
    :width="d.width ?? '520px'"
    :close-on-click-modal="false"
    :close-on-press-escape="d.closeOnPressEscape !== false"
    :top="d.top"
    append-to-body
    @close="d.settle()"
    @closed="remove(d)"
  >
    <component :is="d.component" v-bind="d.props" @done="d.settle" @cancel="d.settle()" />
  </el-dialog>
</template>

<style>
/* the button row a dialog content component ends with (inside the dialog body) */
.qw-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
</style>
