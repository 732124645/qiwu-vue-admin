import { onActivated, watch } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { useCrudList } from '@/core/composables/use-crud'
import { currentLocale } from '@/core/i18n'

/** a list time cell (blank while unset) */
export const at = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '')

/**
 * An approval center list (see docs/design-notes.md#workflow): the CRUD kit's list that also reloads when its
 * kept-alive page shows again (processes move on elsewhere meanwhile) and when the language switches (the
 * server builds the titles in the reader's language). `open(id)`: the instance detail.
 */
export function useCenterList<T extends object, F extends object = Record<string, unknown>>(
  options: Parameters<typeof useCrudList<T, F>>[0],
) {
  const list = useCrudList<T, F>(options)
  let mounted = false
  onActivated(() => {
    if (mounted) void list.refresh()
    mounted = true
  })
  watch(currentLocale, () => void list.refresh())
  const router = useRouter()
  const open = (instanceId: number) => router.push(`/workflow/instances/${instanceId}`)
  return { ...list, open }
}
