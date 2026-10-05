<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon, LUCIDE_ICONS } from '@/core/icons'
import IconButton from './IconButton.vue'

/**
 * A menu icon field (`IconPicker`; see docs/design-notes.md#layering): `v-model` = `lucide:<name>` from the bundled Lucide set (offline,
 * `@iconify-json/lucide`), `null` once cleared. The popover lists the icons matching what is typed; only the
 * first `LIMIT` render (the set has well over a thousand), typing narrows them down.
 */
defineOptions({ name: 'IconPicker' })
const model = defineModel<string | null | undefined>()
const { t } = useI18n()

const LIMIT = 96
const open = ref(false)
const keyword = ref('')
const matches = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return k ? LUCIDE_ICONS.filter((i) => i.slice(7).includes(k)) : LUCIDE_ICONS
})

function pick(icon: string) {
  model.value = icon
  open.value = false
}
</script>

<template>
  <el-popover v-model:visible="open" trigger="click" placement="bottom-start" :width="376">
    <template #reference>
      <el-input
        :model-value="model ?? ''"
        readonly
        :placeholder="t('picker.icon.placeholder')"
        class="icon-picker__field"
      >
        <template #prefix>
          <Icon v-if="model" :icon="model" class="icon-picker__current" />
        </template>
        <template v-if="model" #suffix>
          <IconButton
            class="icon-picker__clear"
            icon="lucide:x"
            :label="t('picker.icon.clear')"
            @click.stop="model = null"
          />
        </template>
      </el-input>
    </template>
    <el-input
      v-model="keyword"
      clearable
      :placeholder="t('picker.icon.search')"
      :aria-label="t('picker.icon.search')"
    />
    <div v-if="matches.length" class="icon-picker__grid" role="listbox">
      <button
        v-for="icon in matches.slice(0, LIMIT)"
        :key="icon"
        type="button"
        role="option"
        class="icon-picker__option"
        :class="{ 'is-active': icon === model }"
        :aria-selected="icon === model"
        :aria-label="icon.slice(7)"
        :title="icon.slice(7)"
        @click="pick(icon)"
      >
        <Icon :icon />
      </button>
    </div>
    <p v-else class="icon-picker__hint">{{ t('picker.icon.none') }}</p>
    <p v-if="matches.length > LIMIT" class="icon-picker__hint">
      {{ t('picker.icon.more', { count: matches.length - LIMIT }) }}
    </p>
  </el-popover>
</template>

<style scoped>
.icon-picker__field {
  cursor: pointer;
}
.icon-picker__current {
  width: 16px;
  height: 16px;
  color: var(--qw-text);
}
/* the clear button fits the input's suffix */
.icon-picker__clear {
  width: 24px;
  height: 24px;
}
.icon-picker__grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 4px;
  max-height: 264px;
  margin-top: 8px;
  overflow-y: auto;
}
.icon-picker__option {
  display: grid;
  place-items: center;
  height: 36px;
  padding: 0;
  font-size: 18px;
  color: var(--qw-text-2);
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--qw-radius-sm);
  transition:
    color 0.15s,
    background-color 0.15s;
}
.icon-picker__option:hover {
  color: var(--qw-text);
  background: var(--qw-surface-2);
}
.icon-picker__option.is-active {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-color: var(--qw-brand-text);
}
.icon-picker__hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
