<script setup lang="ts">
import { loadColor } from './format'

/**
 * A monitor card: a usage dashboard (0–100, colored by load) beside a few facts. Attributes such as
 * `data-gauge` go to the card.
 */
defineOptions({ name: 'MonitorGaugeCard' })
const {
  title,
  value,
  facts,
  plain = false,
} = defineProps<{
  title: string
  /** percentage 0–100 */
  value: number
  facts: [label: string, value: string][]
  /** always the brand color: a high value is no warning here */
  plain?: boolean
}>()
const text = (p: number) => `${p.toFixed(1)}%`
</script>

<template>
  <el-card class="monitor-gauge">
    <h2 class="monitor-gauge__title">{{ title }}</h2>
    <div class="monitor-gauge__body">
      <el-progress
        type="dashboard"
        :percentage="value"
        :color="plain ? 'var(--qw-brand)' : loadColor"
        :width="132"
        :stroke-width="10"
        :format="text"
        :aria-label="title"
      />
      <dl class="monitor-gauge__facts">
        <div v-for="[label, fact] in facts" :key="label" class="monitor-gauge__fact">
          <dt>{{ label }}</dt>
          <dd :title="fact">{{ fact }}</dd>
        </div>
      </dl>
    </div>
  </el-card>
</template>

<style scoped>
.monitor-gauge__title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.monitor-gauge__body {
  display: flex;
  gap: 20px;
  align-items: center;
}
.monitor-gauge__facts {
  display: grid;
  flex: 1;
  gap: 8px;
  min-width: 0;
  margin: 0;
}
.monitor-gauge__fact {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.monitor-gauge__fact dt {
  font-size: 12px;
  color: var(--qw-text-3);
}
.monitor-gauge__fact dd {
  margin: 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
