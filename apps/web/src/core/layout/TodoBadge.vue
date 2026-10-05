<script setup lang="ts">
import { useTodoCount } from './todo-count'

/** The pending-task count on the side menu's 我的待办 (`useTodoCount`; see docs/design-notes.md#workflow). */
defineOptions({ name: 'TodoBadge' })
const count = useTodoCount()
</script>

<template>
  <el-badge :value="count ?? 0" :max="99" :hidden="!count" class="todo-badge" />
</template>

<style scoped>
.todo-badge {
  margin-left: auto;
  line-height: 1;
}
</style>
