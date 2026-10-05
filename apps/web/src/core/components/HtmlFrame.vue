<script setup lang="ts">
withDefaults(defineProps<{ html: string; title: string; height?: number }>(), { height: 360 })
</script>

<template>
  <iframe
    sandbox=""
    :srcdoc="html"
    :title="title"
    referrerpolicy="no-referrer"
    :style="{ height: `${height}px` }"
  />
</template>

<style scoped>
iframe {
  display: block;
  width: 100%;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
</style>
