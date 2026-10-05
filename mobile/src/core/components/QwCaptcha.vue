<template>
  <wd-popup v-model="open" position="bottom" round safe-area-inset-bottom>
    <view class="qw-captcha" aria-live="polite">
      <text class="qw-captcha__title">{{ t('captcha.title') }}</text>
      <view v-if="loading" class="qw-captcha__loading"><wd-loading /></view>
      <template v-else-if="loadFailed">
        <text class="qw-captcha__error">{{ error }}</text>
        <wd-button block variant="plain" @click="load()">{{ t('captcha.retry') }}</wd-button>
      </template>
      <template v-else-if="challenge?.kind === 'image'">
        <view class="qw-captcha__image-row">
          <image
            class="qw-captcha__image"
            :src="challenge.image"
            mode="widthFix"
            :aria-label="t('captcha.image.alt')"
          />
          <wd-button variant="text" @click="load()">{{ t('captcha.image.newImage') }}</wd-button>
        </view>
        <view class="qw-field qw-captcha__answer">
          <wd-input
            v-model="answer"
            :placeholder="t('captcha.image.placeholder')"
            :maxlength="8"
            :disabled="checking"
            @confirm="submitImage"
          />
        </view>
        <text v-if="error" class="qw-captcha__error">{{ error }}</text>
        <view class="qw-captcha__actions">
          <wd-button variant="plain" @click="open = false">{{
            t('common.action.cancel')
          }}</wd-button>
          <wd-button
            type="primary"
            :loading="checking"
            :disabled="checking || !answer.trim()"
            @click="submitImage"
          >
            {{ t('captcha.confirm') }}
          </wd-button>
        </view>
      </template>
      <template v-else-if="challenge?.kind === 'slider'">
        <view class="qw-captcha__slider">
          <Slide
            :data="sliderData(challenge)"
            :config="sliderConfig"
            :theme="SLIDER_THEME"
            @event-confirm="check"
            @event-refresh="load()"
            @event-close="open = false"
          />
        </view>
        <text v-if="error" class="qw-captcha__error">{{ error }}</text>
      </template>
    </view>
  </wd-popup>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CaptchaChallengeVo, CaptchaCheckBody, CaptchaScene } from '@qiwu/shared'
import Slide from 'go-captcha-uni/components/slide/index.vue'
import { captchaApi } from '@/core/captcha'
import { t } from '@/core/i18n'
import { errorText } from '@/core/request'

/**
 * The captcha popup: `ask(scene)` opens it with a challenge of the server's kind (`captcha.mode`): the
 * image question as a PNG with an answer box, or the go-captcha-uni slider over the server's slider data (its
 * 300×220 geometry, as the web's go-captcha-vue). Every check consumes the challenge, so a wrong answer loads a
 * new one. Resolves with the single-use ticket, or `undefined` when closed.
 */
defineOptions({ options: { virtualHost: true } })

const sliderConfig = computed(() => ({
  width: 300,
  height: 220,
  title: t('captcha.slider.title'),
  showTheme: true,
}))
// go-captcha-uni sets these as inline colors: the tokens, never raw values
const SLIDER_THEME = {
  textColor: 'var(--qw-text)',
  iconColor: 'var(--qw-text-2)',
  bodyBgColor: 'var(--qw-surface-2)',
  loadingIconColor: 'var(--qw-brand)',
}
type Slider = Extract<CaptchaChallengeVo, { kind: 'slider' }>
const sliderData = ({ image, thumb, thumbX, thumbY, thumbWidth, thumbHeight }: Slider) => ({
  image,
  thumb,
  thumbX,
  thumbY,
  thumbWidth,
  thumbHeight,
})

const open = ref(false)
const scene = ref<CaptchaScene>('signin')
const challenge = ref<CaptchaChallengeVo>()
const answer = ref('')
const loading = ref(false)
const checking = ref(false)
const error = ref('')
const loadFailed = ref(false)
let settle: ((ticket?: string) => void) | undefined

/** Resolves the pending `ask` (a ticket, or closed) and closes the popup. */
function finish(ticket?: string) {
  settle?.(ticket)
  settle = undefined
  open.value = false
}
// closed by the mask, the slider's close icon or cancel
watch(open, (value) => value || finish())

async function load(clearError = true) {
  if (loading.value) return
  loading.value = true
  challenge.value = undefined
  answer.value = ''
  loadFailed.value = false
  if (clearError) error.value = ''
  try {
    challenge.value = await captchaApi.challenge(scene.value)
  } catch {
    loadFailed.value = true
    error.value = t('captcha.loadFailed')
  } finally {
    loading.value = false
  }
}

async function check(value: CaptchaCheckBody['answer']) {
  if (!challenge.value || checking.value) return
  checking.value = true
  error.value = ''
  try {
    const { captchaTicket } = await captchaApi.check({ id: challenge.value.id, answer: value })
    finish(captchaTicket)
  } catch (cause) {
    error.value = errorText(cause)
    await load(false)
  } finally {
    checking.value = false
  }
}

function submitImage() {
  const value = answer.value.trim()
  if (value) void check(value)
}

defineExpose({
  ask(next: CaptchaScene): Promise<string | undefined> {
    settle?.()
    scene.value = next
    open.value = true
    void load()
    return new Promise((resolve) => (settle = resolve))
  },
})
</script>

<style scoped>
.qw-captcha {
  display: flex;
  flex-direction: column;
  gap: 24rpx;
  padding: 32rpx;
  background: var(--qw-surface);
}

.qw-captcha__title {
  font-size: 34rpx;
  font-weight: 600;
  color: var(--qw-text);
}

.qw-captcha__loading {
  display: flex;
  justify-content: center;
  padding: 80rpx 0;
}

.qw-captcha__image-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.qw-captcha__image {
  width: 400rpx;
}

.qw-captcha__error {
  font-size: 26rpx;
  color: var(--qw-danger);
}

.qw-captcha__actions {
  display: flex;
  justify-content: flex-end;
  gap: 16rpx;
}

.qw-captcha__slider {
  display: flex;
  justify-content: center;
}

/* the slider's own colors (fixed in its stylesheet) follow the tokens */
.qw-captcha__slider :deep(.gc-drag-block) {
  background-color: var(--qw-brand);
  border-color: var(--qw-brand);
  color: var(--qw-on-brand);
}

.qw-captcha__slider :deep(.gc-theme) {
  border-color: var(--qw-border);
  box-shadow: none;
}
</style>
