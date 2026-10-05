<script lang="ts">
// The server slider background must be 300x220, matching go-captcha-vue default geometry.
export const SLIDER_WIDTH = 300
export const SLIDER_HEIGHT = 220
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Slide } from 'go-captcha-vue'
import 'go-captcha-vue/dist/style.css'
import type { CaptchaChallengeVo, CaptchaCheckBody, CaptchaScene } from '@qiwu/shared'
import { captchaApi } from '@/api/auth-extra'
import IconButton from '@/core/components/IconButton.vue'
import { ApiError } from '@/core/request/http'

/**
 * Dialog content for `openDialog`: loads a challenge of `scene` and renders it by its `kind` (the
 * server picks it from `captcha.mode`): the image question with an answer box, or the go-captcha-vue slider
 * (its title follows the locale). Every check consumes the challenge, so a wrong answer loads a new one.
 * Emits `done` with only the `captchaTicket`, `cancel` when closed.
 */
defineOptions({ name: 'CaptchaDialog' })
const props = defineProps<{ scene: CaptchaScene }>()
const emit = defineEmits<{ done: [captchaTicket: string]; cancel: [] }>()
const { t } = useI18n()

const sliderConfig = computed(() => ({
  width: SLIDER_WIDTH,
  height: SLIDER_HEIGHT,
  title: t('captcha.slider.title'),
  showTheme: true,
}))
const challenge = ref<CaptchaChallengeVo>()
const sliderData = computed(() => {
  const value = challenge.value
  if (value?.kind !== 'slider') return undefined
  const { image, thumb, thumbX, thumbY, thumbWidth, thumbHeight } = value
  return { image, thumb, thumbX, thumbY, thumbWidth, thumbHeight }
})
const answer = ref('')
const loading = ref(false)
const checking = ref(false)
const error = ref('')
const loadFailed = ref(false)

async function load(clearError = true) {
  if (loading.value) return
  loading.value = true
  challenge.value = undefined
  answer.value = ''
  loadFailed.value = false
  if (clearError) error.value = ''
  try {
    challenge.value = await captchaApi.challenge(props.scene)
  } catch {
    loadFailed.value = true
    error.value = t('captcha.loadFailed')
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

async function check(value: CaptchaCheckBody['answer']) {
  if (!challenge.value || checking.value) return
  checking.value = true
  error.value = ''
  try {
    const { captchaTicket } = await captchaApi.check({ id: challenge.value.id, answer: value })
    emit('done', captchaTicket)
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('common.error.network')
    answer.value = ''
    await load(false)
  } finally {
    checking.value = false
  }
}
function submitImage() {
  const value = answer.value.trim()
  if (value) void check(value)
}
const sliderEvents = {
  confirm: (point: { x: number; y: number }) => void check(point),
  refresh: () => void load(),
  close: () => emit('cancel'),
}
</script>

<template>
  <div class="captcha-dialog" aria-live="polite">
    <p v-if="loading" v-loading="loading" class="captcha-dialog__loading" />
    <template v-else-if="loadFailed">
      <el-alert :title="error" type="error" :closable="false" show-icon />
      <el-button class="captcha-dialog__retry" @click="load()">{{ t('captcha.retry') }}</el-button>
    </template>
    <template v-else-if="challenge?.kind === 'image'">
      <div class="captcha-dialog__image-row">
        <img :src="challenge.image" :alt="t('captcha.image.alt')" />
        <IconButton icon="lucide:refresh-cw" :label="t('captcha.image.newImage')" @click="load()" />
      </div>
      <label class="captcha-dialog__label" for="captcha-answer">{{
        t('captcha.image.answer')
      }}</label>
      <el-input
        id="captcha-answer"
        v-model="answer"
        autofocus
        maxlength="8"
        :placeholder="t('captcha.image.placeholder')"
        :disabled="checking"
        @keyup.enter="submitImage"
      />
      <el-alert
        v-if="error"
        class="captcha-dialog__error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
      <div class="qw-dialog-footer">
        <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="checking"
          :disabled="checking || !answer.trim()"
          @click="submitImage"
        >
          {{ t('captcha.confirm') }}
        </el-button>
      </div>
    </template>
    <template v-else-if="sliderData">
      <Slide :data="sliderData" :config="sliderConfig" :events="sliderEvents" />
      <el-alert
        v-if="error"
        class="captcha-dialog__error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
    </template>
  </div>
</template>

<style scoped>
.captcha-dialog {
  --go-captcha-theme-text-color: var(--qw-text);
  --go-captcha-theme-bg-color: var(--qw-surface);
  --go-captcha-theme-body-bg-color: var(--qw-surface-2);
  --go-captcha-theme-border-color: var(--qw-border);
  --go-captcha-theme-icon-color: var(--qw-text-2);
  --go-captcha-theme-active-color: var(--qw-brand);
  --go-captcha-theme-drag-bg-color: var(--qw-brand);
  --go-captcha-theme-btn-bg-color: var(--qw-brand);
  --go-captcha-theme-btn-border-color: var(--qw-brand);
  --go-captcha-theme-btn-color: var(--qw-on-brand);
  --go-captcha-theme-loading-icon-color: var(--qw-brand);
}
.captcha-dialog__loading {
  min-height: 60px;
}
.captcha-dialog__image-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.captcha-dialog__image-row img {
  width: 240px;
  max-width: 100%;
  height: auto;
}
.captcha-dialog__label {
  display: block;
  margin-bottom: 8px;
  color: var(--qw-text);
}
.captcha-dialog__error,
.captcha-dialog__retry {
  margin-top: 16px;
}
</style>
