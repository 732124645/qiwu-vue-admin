<template>
  <view class="qw-user-picker">
    <wd-cell
      :title="label"
      :value="text"
      :placeholder="placeholder || t('picker.user.placeholder')"
      :required="required"
      is-link
      @click="show"
    />
    <wd-popup v-model="visible" position="bottom" round safe-area-inset-bottom root-portal>
      <view class="qw-picker qw-user-picker__sheet">
        <view class="qw-picker__head">
          <text class="qw-picker__title">{{ label || t('picker.user.title') }}</text>
          <wd-button v-if="multiple" size="small" type="primary" @click="confirm">
            {{ t('picker.confirmCount', { count: picked.size }) }}
          </wd-button>
        </view>
        <wd-search
          v-model="keyword"
          hide-cancel
          placeholder-left
          :placeholder="t(source === 'wf' ? 'picker.user.nameKeyword' : 'picker.user.keyword')"
        />
        <view v-if="source === 'iam'" class="qw-picker__crumbs">
          <text class="qw-picker__crumb" @click="back(0)">{{ t('picker.user.allDepts') }}</text>
          <text
            v-for="(d, i) in path"
            :key="d.id"
            class="qw-picker__crumb"
            @click="back(i + 1)"
          >
            / {{ tx(d.name) }}
          </text>
        </view>
        <scroll-view scroll-y class="qw-picker__body">
          <wd-cell
            v-for="d in subDepts"
            :key="`d${d.id}`"
            :title="tx(d.name)"
            prefix-icon="folder"
            is-link
            custom-class="qw-user-picker__dept"
            @click="enter(d)"
          />
          <wd-cell
            v-for="u in rows"
            :key="u.id"
            :title="u.displayName"
            :label="u.deptName ? tx(u.deptName) : ''"
            clickable
            center
            custom-class="qw-user-picker__user"
            @click="tap(u)"
          >
            <wd-icon v-if="picked.has(u.id)" name="check" custom-class="qw-picker__check" />
          </wd-cell>
          <view v-if="loading" class="qw-picker__loading"><wd-loading /></view>
          <QwEmpty v-else-if="!rows.length && !subDepts.length" :title="t('picker.empty')" />
        </scroll-view>
      </view>
    </wd-popup>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import QwEmpty from '@/core/components/QwEmpty.vue'
import { t, tx } from '@/core/i18n'
import { joinNames, useUserPicker, type PickedUser, type UserSource } from '@/core/pickers'

/**
 * Pick users: a cell with the picked names that opens a bottom sheet: a keyword search, with source
 * `iam` the dept tree to drill into, and the users. `v-model` = the picked users (id, display name, dept);
 * single: a tap picks and closes; `multiple`: taps toggle, the button confirms (none = cleared). Approval
 * pickers use `source="wf"` (the default: every enabled user).
 * `<QwUserPicker v-model="ccUsers" multiple :label="t('…')" />`, then send `ccUsers.map((u) => u.id)`.
 */
defineOptions({ options: { virtualHost: true } })
const model = defineModel<PickedUser[]>({ default: () => [] })
const props = withDefaults(
  defineProps<{
    source?: UserSource
    multiple?: boolean
    label?: string
    placeholder?: string
    required?: boolean
  }>(),
  { source: 'wf', multiple: false, label: '', placeholder: '', required: false },
)
const { keyword, path, subDepts, rows, loading, picked, open, enter, back, toggle } =
  useUserPicker(props.source, props.multiple)

const visible = ref(false)
const text = computed(() => joinNames(model.value.map((u) => u.displayName)))

function show() {
  open(model.value)
  visible.value = true
}
function confirm() {
  model.value = [...picked.values()]
  visible.value = false
}
function tap(u: PickedUser) {
  toggle(u)
  if (!props.multiple) confirm()
}
</script>

<style scoped>
.qw-picker {
  display: flex;
  flex-direction: column;
  height: 75vh;
  background: var(--qw-surface);
}

.qw-picker__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64rpx;
  padding: 28rpx 32rpx 12rpx;
}

.qw-picker__title {
  font-size: var(--qw-fs-title);
  font-weight: 600;
  color: var(--qw-text);
}

.qw-picker__crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8rpx;
  padding: 8rpx 32rpx 16rpx;
  font-size: var(--qw-fs-caption);
}

.qw-picker__crumb {
  color: var(--qw-brand-text);
}

.qw-picker__crumb:last-child {
  color: var(--qw-text-2);
}

/* the rest of the sheet; a scroll-view needs a height (0 + flex) on mp-weixin */
.qw-picker__body {
  flex: 1;
  height: 0;
}

.qw-picker__loading {
  display: flex;
  justify-content: center;
  padding: 40rpx 0;
}

:deep(.qw-picker__check) {
  font-size: 36rpx;
  color: var(--qw-brand);
}
</style>
