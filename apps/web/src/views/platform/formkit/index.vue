<script setup lang="ts">
import FormDesigner from './FormDesigner.vue'

/** 表单构建 (see docs/design-notes.md#workflow): the form-create designer page under 系统工具. */
defineOptions({ name: 'FormkitDesign' })
</script>

<template>
  <div class="qw-page">
    <FormDesigner />
  </div>
</template>
