<script setup lang="ts">
/** A card of key figures (label over a large value), as many a row as fit; each tile has `data-stat`. */
defineOptions({ name: 'MonitorStats' })
const { items } = defineProps<{ items: { key: string; label: string; value: string }[] }>()
</script>

<template>
  <el-card>
    <dl class="monitor-stats">
      <div v-for="s in items" :key="s.key" class="monitor-stats__item" :data-stat="s.key">
        <dt class="monitor-stats__label">{{ s.label }}</dt>
        <dd class="monitor-stats__value" :title="s.value">{{ s.value }}</dd>
      </div>
    </dl>
  </el-card>
</template>

<style scoped>
.monitor-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px 24px;
  margin: 0;
}
.monitor-stats__item {
  min-width: 0;
}
.monitor-stats__label {
  font-size: 12px;
  color: var(--qw-text-3);
}
.monitor-stats__value {
  margin: 4px 0 0;
  overflow: hidden;
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
