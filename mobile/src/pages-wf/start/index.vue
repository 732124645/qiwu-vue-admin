<template>
  <view class="qw-detail qw-stack">
    <view v-for="g in groups" :key="g.code" class="qw-start__group">
      <view class="qw-sec">
        <text class="qw-sec__title qw-start__category">{{ g.label }}</text>
      </view>
      <view class="qw-group">
        <view
          v-for="m in g.models"
          :key="m.modelKey"
          class="qw-row qw-start__model"
          role="link"
          @click="start(m)"
        >
          <view class="qw-tile qw-tile--brand" aria-hidden="true">
            <QwIcon :name="modelIcon(m)" size="40rpx" />
          </view>
          <view class="qw-row__main">
            <text class="qw-row__title">{{ tx(m.name) }}</text>
            <text v-if="m.description" class="qw-row__body">{{ tx(m.description) }}</text>
          </view>
          <QwIcon name="chevron-right" size="36rpx" />
        </view>
      </view>
    </view>
    <QwEmpty v-if="loaded && !models.length" :title="t('approval.start.none')" />
    <wd-popup v-model="visible" position="bottom" round safe-area-inset-bottom root-portal>
      <view class="qw-decide qw-start">
        <text class="qw-decide__title">{{ picking ? tx(picking.name) : '' }}</text>
        <wd-loading v-if="loading" />
        <text v-else class="qw-form__hint">
          {{ t(picks.length ? 'approval.start.picksHint' : 'approval.start.confirm') }}
        </text>
        <view v-for="p in picks" :key="p.id" class="qw-decide__user qw-start__pick">
          <QwUserPicker
            v-model="picked[p.id]"
            multiple
            :label="`${tx(p.name)} · ${t(`approval.start.pick.${p.type}`)}`"
            required
          />
          <text v-if="errors[p.id]" class="qw-field__error">{{ errors[p.id] }}</text>
        </view>
        <text v-if="error" class="qw-form__error" role="alert">{{ error }}</text>
        <wd-button
          custom-class="qw-btn qw-btn--primary qw-start__submit"
          type="primary"
          block
          :loading="submitting"
          :disabled="submitting || loading"
          @click="submit"
        >
          {{ t('approval.start.submit') }}
        </wd-button>
      </view>
    </wd-popup>
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import type { DictPayload, WfStartableVo, WfStartInfoVo } from '@qiwu/shared'
import {
  createPage,
  loadStartable,
  modelIcon,
  loadStartInfo,
  picksMissing,
  startGroups,
  startModel,
  type Picked,
} from '@/core/approvals'
import QwEmpty from '@/core/components/QwEmpty.vue'
import QwIcon from '@/core/components/QwIcon.vue'
import QwUserPicker from '@/core/components/QwUserPicker.vue'
import { t, tx } from '@/core/i18n'
import { loadDict } from '@/core/pickers'
import { ApiError, errorText } from '@/core/request'

/**
 * 发起审批 (subpackage pages-wf), as the web's start page: the models the caller may start (startable-models, sign-in only) by category in the dict's order, seeded names through tx(). A custom-form
 * model opens its mobile create page (core/views.ts), else it is started on the desktop; a dynamic one with a
 * form opens its form page (start/form), one without starts in a sheet asking the users of its
 * initiatorPicks steps (QwUserPicker, each at least one), then its detail opens. Section titles, rows
 * with the model's icon (core/views.ts).
 */
const models = shallowRef<WfStartableVo[]>([])
const loaded = ref(false)
const category = shallowRef<DictPayload>()
loadDict('wf.category').then(
  (d) => (category.value = d),
  () => {}, // shown by the request layer; codes show instead
)
const groups = computed(() => startGroups(models.value, category.value))

onLoad(() => {
  uni.setNavigationBarTitle({ title: t('home.shortcut.start') })
  loadStartable()
    .then((list) => (models.value = list))
    .catch(() => {}) // shown by the request layer
    .finally(() => (loaded.value = true))
})

const visible = ref(false)
const picking = shallowRef<WfStartableVo>()
const picks = shallowRef<WfStartInfoVo['picks']>([])
const picked = reactive<Picked>({})
const loading = ref(false)
const tried = ref(false)
const error = ref('')
const submitting = ref(false)
/** once a start was tried, the steps still without anybody (following the picks) */
const errors = computed(() => (tried.value ? picksMissing(picks.value, picked) : {}))
let seq = 0

function start(m: WfStartableVo) {
  if (m.formKind === 'custom') {
    const page = createPage(m)
    if (page) uni.navigateTo({ url: page })
    else uni.showToast({ title: t('approval.start.desktopOnly'), icon: 'none' })
    return
  }
  const mine = ++seq
  picking.value = m
  picks.value = []
  for (const k of Object.keys(picked)) delete picked[k]
  tried.value = false
  error.value = ''
  loading.value = true
  visible.value = true
  loadStartInfo(m.modelKey)
    .then(
      (info) => {
        if (mine !== seq) return
        if (info.schema) {
          visible.value = false
          const q = `key=${encodeURIComponent(m.modelKey)}&name=${encodeURIComponent(m.name)}`
          return void uni.navigateTo({ url: `/pages-wf/start/form?${q}` })
        }
        for (const p of info.picks) picked[p.id] = []
        picks.value = info.picks
      },
      (e: unknown) => mine === seq && (error.value = errorText(e)),
    )
    .finally(() => mine === seq && (loading.value = false))
}
watch(visible, (open) => open || seq++)

async function submit() {
  if (submitting.value || loading.value || !picking.value) return
  tried.value = true
  if (Object.keys(errors.value).length) return
  submitting.value = true
  error.value = ''
  try {
    const started = await startModel(picking.value.modelKey, picked)
    visible.value = false
    uni.showToast({ title: t('approval.start.started'), icon: 'none' })
    uni.navigateTo({ url: `/pages-wf/detail/index?id=${started.id}` })
  } catch (e) {
    // a 400 (a picked user disabled meanwhile, the form values) or 404 (the model is gone) belongs here
    if (e instanceof ApiError && (e.status === 400 || e.status === 404)) error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<style>
.qw-start__group > .qw-sec {
  margin-top: 0;
}

/* the chevron in the auxiliary colour; the texts keep theirs */
.qw-start__model {
  align-items: center;
  color: var(--qw-text-3);
}
</style>
