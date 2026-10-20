<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@/core/icons'
import {
  canAddSub,
  canAddTop,
  isLegacy,
  sameSlot,
  type DraftButton,
  type Slot,
} from './menu-layout'

/**
 * A phone-style preview of a menu: up to 3 buttons on the bottom bar, the selected one's sub-menu (up to
 * 5) above it, as the WeChat client shows them. Clicking a button selects it; `editable` adds the "+"
 * places while there is room. `invalid` marks buttons with a problem (`"i"` / `"i.j"`); the selected one
 * is `aria-current`, one with a problem `aria-invalid` with a hidden "has a problem" for screen readers.
 */
defineOptions({ name: 'WxoaMenuPhone' })
const {
  buttons,
  selected = null,
  editable = false,
  invalid = new Set<string>(),
} = defineProps<{
  buttons: DraftButton[]
  selected?: Slot | null
  editable?: boolean
  invalid?: Set<string>
}>()
const emit = defineEmits<{ select: [slot: Slot]; addTop: []; addSub: [i: number] }>()
const { t } = useI18n()

const bad = (slot: Slot) => invalid.has(slot.j === undefined ? `${slot.i}` : `${slot.i}.${slot.j}`)
const classes = (b: DraftButton, slot: Slot) => ({
  'is-selected': sameSlot(selected, slot),
  'is-invalid': bad(slot),
  'is-legacy': isLegacy(b),
})
/** the sub-menu shows above the selected button (or above the button of the selected sub-button) */
const open = (i: number) => selected?.i === i
</script>

<template>
  <div class="phone">
    <div class="phone__screen">
      <slot />
    </div>
    <div class="phone__bar">
      <span class="phone__keyboard"><Icon icon="lucide:keyboard" /></span>
      <div class="phone__cols">
        <div v-for="(b, i) in buttons" :key="i" class="phone__col">
          <ul
            v-if="open(i) && (b.subButtons?.length || (editable && canAddSub(b)))"
            class="phone__subs"
          >
            <li v-for="(s, j) in b.subButtons" :key="j">
              <button
                type="button"
                class="phone__btn"
                :class="classes(s, { i, j })"
                :aria-current="sameSlot(selected, { i, j }) || undefined"
                :aria-invalid="bad({ i, j }) || undefined"
                @click="emit('select', { i, j })"
              >
                {{ s.name.trim() || t('wxoa.menu.untitled') }}
                <span v-if="bad({ i, j })" class="phone__problem">{{
                  t('wxoa.menu.hasProblem')
                }}</span>
              </button>
            </li>
            <li v-if="editable && canAddSub(b)">
              <button
                type="button"
                class="phone__btn phone__add"
                :aria-label="t('wxoa.menu.addSub')"
                :title="t('wxoa.menu.addSub')"
                @click="emit('addSub', i)"
              >
                <Icon icon="lucide:plus" />
              </button>
            </li>
          </ul>
          <button
            type="button"
            class="phone__btn phone__top"
            :class="classes(b, { i })"
            :aria-current="sameSlot(selected, { i }) || undefined"
            :aria-invalid="bad({ i }) || undefined"
            @click="emit('select', { i })"
          >
            <Icon v-if="b.subButtons?.length" icon="lucide:menu" class="phone__mark" />
            {{ b.name.trim() || t('wxoa.menu.untitled') }}
            <span v-if="bad({ i })" class="phone__problem">{{ t('wxoa.menu.hasProblem') }}</span>
          </button>
        </div>
        <div v-if="editable && canAddTop(buttons)" class="phone__col">
          <button
            type="button"
            class="phone__btn phone__top phone__add"
            :aria-label="t('wxoa.menu.addButton')"
            :title="t('wxoa.menu.addButton')"
            @click="emit('addTop')"
          >
            <Icon icon="lucide:plus" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.phone {
  display: flex;
  flex-direction: column;
  width: 320px;
  height: 540px;
  overflow: hidden;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-lg);
  box-shadow: var(--qw-shadow-1);
}
.phone__screen {
  flex: 1;
  padding: 12px;
  overflow: auto;
}
.phone__bar {
  display: flex;
  align-items: stretch;
  height: 48px;
  background: var(--qw-surface);
  border-top: 1px solid var(--qw-border);
}
.phone__keyboard {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  color: var(--qw-text-3);
  border-right: 1px solid var(--qw-border);
}
.phone__cols {
  display: flex;
  flex: 1;
}
.phone__col {
  position: relative;
  display: flex;
  flex: 1 1 0;
  min-width: 0;
}
.phone__col + .phone__col {
  border-left: 1px solid var(--qw-border);
}
.phone__subs {
  position: absolute;
  right: 4px;
  bottom: calc(100% + 8px);
  left: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
  box-shadow: var(--qw-shadow-2);
}
.phone__subs li + li {
  border-top: 1px solid var(--qw-border);
}
.phone__btn {
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 40px;
  padding: 4px 6px;
  overflow: hidden;
  font: inherit;
  font-size: 13px;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--qw-radius-sm);
}
.phone__top {
  height: 100%;
}
.phone__btn:hover {
  background: var(--qw-neutral-weak);
}
.phone__btn.is-legacy {
  color: var(--qw-text-3);
  border-style: dashed;
  border-color: var(--qw-border);
}
.phone__btn.is-selected {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-color: var(--qw-brand);
}
.phone__btn.is-invalid {
  color: var(--qw-danger);
  border-color: var(--qw-danger);
}
.phone__add {
  color: var(--qw-text-3);
}
.phone__mark {
  flex: none;
  color: var(--qw-text-3);
}
/* the problem is shown by colour and border; this says it to screen readers */
.phone__problem {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
