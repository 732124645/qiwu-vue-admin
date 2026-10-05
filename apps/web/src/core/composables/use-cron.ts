import { ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import { watchDebounced } from '@vueuse/core'
import cronstrue from 'cronstrue'
import 'cronstrue/locales/zh_CN'
import { CRON_PATTERN, type Locale } from '@qiwu/shared'
import { jobApi } from '@/api/platform/scheduler/job'
import { currentLocale, i18n } from '@/core/i18n'
import { ApiError } from '@/core/request/http'

// Cron text and fire times for CronEditor and the task detail.

const CRONSTRUE: Record<Locale, string> = { 'zh-CN': 'zh_CN', 'en-US': 'en' }

/**
 * A cron in words in the current locale (cronstrue: 6 fields = seconds first; weekday 0 = Sunday and
 * months 1–12, as the server's cron reads them); '' for one the server would not take (`CRON_PATTERN`).
 */
export function describeCron(expr: string): string {
  const cron = expr.trim()
  if (!CRON_PATTERN.test(cron)) return ''
  try {
    return cronstrue.toString(cron, {
      locale: CRONSTRUE[currentLocale()],
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    })
  } catch {
    return ''
  }
}

/**
 * The next fire times of `cron` as the server computes them (`GET /scheduler/tasks/next-fire-times`),
 * reloaded `debounce` ms after it changes; an answer to an older cron is dropped. `error` = why the server
 * refused it (its translated 400 message), or that the times could not be loaded; nothing is asked for a
 * cron that fails `CRON_PATTERN` (the form's rule says why).
 */
export function useNextFireTimes(cron: MaybeRefOrGetter<string>, debounce = 400) {
  const times = shallowRef<string[]>([])
  const error = ref('')
  const loading = ref(false)
  let seq = 0

  async function load() {
    const mine = ++seq
    const expr = toValue(cron).trim()
    times.value = []
    error.value = ''
    loading.value = CRON_PATTERN.test(expr)
    if (!loading.value) return
    try {
      const next = await jobApi.nextFireTimes(expr)
      if (mine === seq) times.value = next.times
    } catch (e) {
      if (mine === seq)
        error.value =
          e instanceof ApiError && e.status === 400
            ? (e.errors?.[0]?.msg ?? e.message)
            : i18n.global.t('cron.nextFailed')
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  watchDebounced(() => toValue(cron), load, { debounce, immediate: true })
  return { times, error, loading }
}
