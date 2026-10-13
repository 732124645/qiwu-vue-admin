// What the session's tenant package includes (`/me.features`, only while multi-tenancy is on; see
// docs/design-notes.md#tenancy): the app hides what is missing, the server enforces it itself.
import { useAuthStore } from './stores/auth'

/** The top-level menu groups (route names) the app's own screens belong to. */
export const FEATURE = {
  /** the approval tab, starting a process, the to-do and running counts */
  workflow: 'workflow',
  /** the bulletin feed: its pages' group (messaging) sits under system */
  bulletin: 'system',
} as const

export type Tab = 'home' | 'approval' | 'message' | 'mine'
/** The tab bar's tabs, in order. */
export const TABS: readonly Tab[] = ['home', 'approval', 'message', 'mine']

/** Whether the session may use `group`: always without `/me.features` (multi-tenancy off, or no `/me` yet). */
export function hasFeature(group: string): boolean {
  const features = useAuthStore().me?.features
  return !features || features.includes(group)
}

/** The tabs the bar shows: approvals only with the workflow feature. */
export const visibleTabs = (): Tab[] =>
  TABS.filter((tab) => tab !== 'approval' || hasFeature(FEATURE.workflow))

/** The workbench's entries (shortcuts and counters, by name) shown only with a feature of the package. */
const HOME_FEATURES: Readonly<Record<string, string>> = {
  start: FEATURE.workflow,
  todo: FEATURE.workflow,
  running: FEATURE.workflow,
  bulletin: FEATURE.bulletin,
}

/**
 * The workbench's shortcuts and counters the session may use: its `perm` held (when it has one) and its
 * feature in the package (display only: the server enforces both).
 */
export function visibleShortcuts<T extends { name: string; perm?: string }>(list: readonly T[]): T[] {
  const auth = useAuthStore()
  return list.filter((entry) => {
    const feature = HOME_FEATURES[entry.name]
    return (!entry.perm || auth.hasPerm(entry.perm)) && (!feature || hasFeature(feature))
  })
}
