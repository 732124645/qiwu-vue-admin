<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { WfStartableVo, WfStartVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import EmptyState from '@/core/components/EmptyState.vue'
import { toastRest } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import WfStartForm from './WfStartForm.vue'

/**
 * 发起申请 (see docs/design-notes.md#workflow): a card per model the caller may start, grouped by category (dict
 * `wf.category`, in its order). A custom-form model opens its business page (`create_route`); a dynamic one
 * starts in `WfStartForm`. Seeded names are `seed.wf.*` keys (`tx()`).
 */
defineOptions({ name: 'WfStart' })
const { t } = useI18n()
const router = useRouter()
const category = useDict('wf.category')

const models = shallowRef<WfStartableVo[]>([])
const loading = ref(true)
wfCenterApi
  .startable()
  .then((list) => (models.value = list))
  .catch(toastRest)
  .finally(() => (loading.value = false))

/** [category, its models] in the dict's order; a category the dict lacks comes last */
const groups = computed(() => {
  const by = new Map<string, WfStartableVo[]>()
  for (const m of models.value) by.set(m.category, [...(by.get(m.category) ?? []), m])
  const order = category.options.value.map((o) => o.value)
  const rank = (c: string) => order.indexOf(c) + 1 || order.length + 1
  return [...by].sort(([a], [b]) => rank(a) - rank(b))
})

async function start(m: WfStartableVo) {
  if (m.formKind === 'custom' && m.createRoute) return router.push(m.createRoute)
  const started = await openDialog<WfStartVo>(
    WfStartForm,
    { modelKey: m.modelKey },
    { title: () => t('wf.center.start.title', { name: tx(m.name) }), width: 600 },
  )
  if (started) ElMessage.success(t('wf.center.start.started'))
}
</script>

<template>
  <div v-loading="loading" class="qw-page wf-start">
    <section
      v-for="[code, list] in groups"
      :key="code"
      class="wf-start__group"
      :aria-labelledby="`wf-start-${code}`"
    >
      <h2 :id="`wf-start-${code}`" class="wf-start__title">{{ category.label(code) }}</h2>
      <ul class="wf-start__grid">
        <li v-for="m in list" :key="m.modelKey">
          <button type="button" class="wf-start-card" @click="start(m)">
            <span class="wf-start-card__icon"><Icon :icon="m.icon || 'lucide:file-text'" /></span>
            <span class="wf-start-card__text">
              <span class="wf-start-card__name">{{ tx(m.name) }}</span>
              <span v-if="m.description" class="wf-start-card__desc" :title="tx(m.description)">
                {{ tx(m.description) }}
              </span>
            </span>
            <Icon icon="lucide:arrow-right" class="wf-start-card__go" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
    <div v-if="!loading && !models.length" class="wf-start__empty">
      <EmptyState :title="t('wf.center.start.none')" :description="t('wf.center.start.noneHint')" />
    </div>
  </div>
</template>

<style scoped>
.wf-start {
  gap: 24px;
  min-height: 120px;
}
.wf-start__title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 650;
  line-height: 24px;
  color: var(--qw-text);
}
.wf-start__grid {
  /* up to 4 columns, never narrower than 260px (as the home page's entries) */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(max(260px, calc((100% - 48px) / 4)), 1fr));
  gap: 16px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.wf-start-card {
  display: flex;
  gap: 14px;
  align-items: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 16px 18px 16px 16px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s var(--qw-ease-enter);
}
.wf-start-card:hover {
  border-color: color-mix(in srgb, var(--qw-brand) 40%, var(--qw-border));
  box-shadow: var(--qw-shadow-1);
  transform: translateY(-1px);
}
.wf-start-card:focus-visible {
  outline: 2px solid var(--qw-brand-text);
  outline-offset: 2px;
}
.wf-start-card__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 40px;
  height: 40px;
  font-size: 20px;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: var(--qw-radius-sm);
}
.wf-start-card__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.wf-start-card__name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-start-card__desc {
  display: -webkit-box;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.wf-start-card__go {
  flex: none;
  font-size: 16px;
  color: var(--qw-text-3);
  transition:
    color 0.15s,
    transform 0.15s var(--qw-ease-enter);
}
.wf-start-card:hover .wf-start-card__go {
  color: var(--qw-brand-text);
  transform: translateX(2px);
}
.wf-start__empty {
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
</style>
