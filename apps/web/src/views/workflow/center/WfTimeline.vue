<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { WfInstanceDetailVo } from '@qiwu/shared'
import DictTag from '@/core/components/DictTag.vue'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { at } from './use-center-list'

/**
 * An instance's timeline (`wf_event`, oldest first; see docs/design-notes.md#workflow): who did what on which step, to whom, with
 * which comment. Seeded step names are `seed.wf.*` keys (`tx()`); a system move (a copy step, an auto-pass)
 * has no actor.
 */
const { events } = defineProps<{ events: WfInstanceDetailVo['timeline'] }>()
const { t } = useI18n()
</script>

<template>
  <el-timeline class="wf-timeline">
    <el-timeline-item v-for="e in events" :key="e.id">
      <div class="wf-timeline__head">
        <span class="wf-timeline__actor">{{
          e.actor?.name ?? t('wf.center.timeline.system')
        }}</span>
        <DictTag code="wf.action" :value="e.action" />
        <span v-if="e.nodeName" class="wf-timeline__node">{{ tx(e.nodeName) }}</span>
        <time class="wf-timeline__time" :datetime="e.createdAt">{{ at(e.createdAt) }}</time>
      </div>
      <div v-if="e.targets.length" class="wf-timeline__targets">
        <Icon icon="lucide:corner-down-right" aria-hidden="true" />
        <span v-for="to in e.targets" :key="to.id" class="wf-timeline__target">
          {{ to.name ? tx(to.name) : to.id }}
        </span>
      </div>
      <p v-if="e.comment" class="wf-timeline__comment">{{ e.comment }}</p>
    </el-timeline-item>
  </el-timeline>
</template>

<style scoped>
.wf-timeline {
  padding: 0;
  margin: 0;
}
.wf-timeline__head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  line-height: 22px;
}
.wf-timeline__actor {
  font-weight: 600;
  color: var(--qw-text);
}
.wf-timeline__node {
  color: var(--qw-text-2);
}
.wf-timeline__time {
  margin-left: auto;
  font-size: 12px;
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}
.wf-timeline__targets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
  font-size: 13px;
  color: var(--qw-text-2);
}
.wf-timeline__target {
  padding: 0 8px;
  line-height: 22px;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.wf-timeline__comment {
  padding: 8px 12px;
  margin: 8px 0 0;
  color: var(--qw-text-2);
  white-space: pre-line;
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
</style>
