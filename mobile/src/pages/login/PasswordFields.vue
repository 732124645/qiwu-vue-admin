<template>
  <view class="qw-login__fields">
    <view :class="['qw-field qw-login__username', { 'is-focus': focus === 'username' }]">
      <wd-input
        v-model="form.username"
        :placeholder="t('field.auth.username')"
        :maxlength="64"
        clearable
        clear-trigger="focus"
        :adjust-position="false"
        :error="!!errors.username"
        @focus="focus = 'username'"
        @blur="focus = ''"
      >
        <template #prefix>
          <QwIcon class="qw-login__icon" name="user" size="37rpx" />
        </template>
      </wd-input>
      <text v-if="errors.username" class="qw-field__error">{{ errors.username }}</text>
    </view>
    <view
      :class="[
        'qw-field qw-field--own-eye qw-login__password',
        { 'is-focus': focus === 'password' },
      ]"
    >
      <wd-input
        v-model="form.password"
        :placeholder="t('field.auth.password')"
        :maxlength="128"
        :show-password="!shown"
        :adjust-position="false"
        :error="!!errors.password"
        @focus="focus = 'password'"
        @blur="focus = ''"
        @confirm="emit('confirm')"
      >
        <template #prefix>
          <QwIcon class="qw-login__icon" name="lock" size="37rpx" />
        </template>
        <template #suffix>
          <view
            class="qw-login__eye"
            role="button"
            :aria-label="t('login.showPassword')"
            :aria-pressed="shown"
            @click.stop="shown = !shown"
          >
            <QwIcon :name="shown ? 'eye' : 'eye-off'" size="37rpx" />
          </view>
        </template>
      </wd-input>
      <text v-if="errors.password" class="qw-field__error">{{ errors.password }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { t } from '@/core/i18n'

/**
 * Username and password with their icons (the sign-in page and the WeChat bind page): fills the caller's
 * `form`; `errors` are the caller's field messages. Show password is our own eye: while shown the input is a
 * plain one (wd-input's own toggle is hidden), so it stays masked whenever the eye is closed.
 */
defineProps<{
  form: { username: string; password: string }
  errors: Record<string, string>
}>()
const emit = defineEmits<{ confirm: [] }>()

const focus = ref('')
const shown = ref(false)
</script>

<style>
.qw-login__fields {
  display: flex;
  flex-direction: column;
  gap: 26rpx;
}

.qw-login__fields .qw-field .wd-input {
  padding: 0 28rpx;
}

.qw-login__icon {
  margin-right: 4rpx;
  color: var(--qw-text-3);
  transition: color 150ms;
}

.qw-field.is-focus .qw-login__icon {
  color: var(--qw-brand-text);
}

/* the eye: 44 square at the field's right edge */
.qw-login__fields .qw-login__password .wd-input {
  padding-right: 8rpx;
}

.qw-login__eye {
  display: flex;
  align-items: center;
  justify-content: center;
  width: max(82rpx, 44px);
  height: max(82rpx, 44px);
  color: var(--qw-text-3);
}
</style>
