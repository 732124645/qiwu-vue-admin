import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const range = (days: number) => (): [Date, Date] => {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - days + 1)
  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)
  return [start, end]
}

export const DATE_RANGE_SHORTCUTS = [
  { labelKey: 'common.dateRange.today', value: range(1) },
  { labelKey: 'common.dateRange.last7Days', value: range(7) },
  { labelKey: 'common.dateRange.last30Days', value: range(30) },
] as const

/** Keep labels reactive and calculate the local days only when a shortcut is clicked. */
export function useDateRangeShortcuts() {
  const { t } = useI18n()
  return computed(() =>
    DATE_RANGE_SHORTCUTS.map(({ labelKey, value }) => ({ text: t(labelKey), value })),
  )
}
