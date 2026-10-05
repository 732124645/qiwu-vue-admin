import { onUnmounted, ref } from 'vue'
import type { SmsCodeBody, SmsCodeVo } from '@qiwu/shared'
import { authExtraApi } from '@/api/auth-extra'
import { withCaptcha } from '@/core/captcha'

/**
 * Sending an SMS code: a public `scene` goes through the `sms_send` captcha (only its ticket
 * is sent); a signed-in `request` (the profile's bind code) is sent as is. Then a countdown from the
 * server's `cooldownSec`. `send` resolves true when sent, false when the
 * captcha was closed; server errors (429 limits, 400) are thrown for the form to show. The answer is the
 * same whether the number has an account or not, and so is what the forms show.
 */
export function useSmsCode(
  source: SmsCodeBody['scene'] | ((mobile: string) => Promise<SmsCodeVo>),
) {
  const cooldown = ref(0)
  const sending = ref(false)
  let timer: ReturnType<typeof setInterval> | undefined
  let unmounted = false
  onUnmounted(() => {
    unmounted = true
    clearInterval(timer)
  })

  async function send(mobile: string) {
    if (sending.value || cooldown.value) return
    sending.value = true
    try {
      const answer =
        typeof source === 'function'
          ? await source(mobile)
          : await withCaptcha('sms_send', (ticket) =>
              authExtraApi.smsCode({
                mobile,
                scene: source,
                ...(ticket ? { captchaTicket: ticket } : {}),
              }),
            )
      if (answer === undefined) return false
      cooldown.value = answer.cooldownSec
      clearInterval(timer)
      if (cooldown.value && !unmounted)
        timer = setInterval(() => {
          if (--cooldown.value <= 0) clearInterval(timer)
        }, 1000)
      return true
    } finally {
      sending.value = false
    }
  }

  return { cooldown, sending, send }
}
