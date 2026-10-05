import { shallowReactive, type Component, type MaybeRefOrGetter } from 'vue'

// Functional dialogs: `const saved = await openDialog(PositionForm, { id }, { title })`.

export interface DialogOptions {
  /** a getter follows locale switches while the dialog is open */
  title?: MaybeRefOrGetter<string>
  /** el-dialog width; default 520px */
  width?: string | number
  /** close (resolving `undefined`) when the route path changes; default true */
  closeOnRouteChange?: boolean
  /** ESC closes it (resolving `undefined`); default true. Off where work done in it would be lost */
  closeOnPressEscape?: boolean
  /** el-dialog `top` (its margin above); default 15vh. A tall one starts higher to fit a small screen */
  top?: string
}

/** The events a dialog content component ends with: `defineEmits<{ done: [result: R]; cancel: [] }>()`. */
export interface DialogEmit<R> {
  (e: 'done', result: R): void
  (e: 'cancel'): void
}

export interface DialogEntry extends DialogOptions {
  id: number
  component: Component
  props: Record<string, unknown>
  visible: boolean
  /** closes the dialog and resolves its promise (first call wins) */
  settle: (result?: unknown) => void
}

/** Open dialogs, oldest first; `<DialogHost />` renders them and drops each after its close animation. */
export const dialogs = shallowReactive<DialogEntry[]>([])
let seq = 0

/**
 * Opens `component` in an el-dialog rendered by `<DialogHost />` (so it has the app's i18n, router, pinia
 * and Element Plus config) with `props`. Resolves with the result the content emits as `done(result)`,
 * or `undefined` on its `cancel`, the close button, ESC (unless `closeOnPressEscape: false`) or a route
 * change. Dialogs may open dialogs.
 */
export function openDialog<R = unknown>(
  component: Component,
  props: Record<string, unknown> = {},
  options: DialogOptions = {},
): Promise<R | undefined> {
  return new Promise((resolve) => {
    let open = true
    // shallow: the component and its props stay as given, `visible` drives the el-dialog
    const entry: DialogEntry = shallowReactive({
      ...options,
      id: ++seq,
      component,
      props,
      visible: true,
      settle: (result?: unknown) => {
        if (!open) return
        open = false
        entry.visible = false
        resolve(result as R | undefined)
      },
    })
    dialogs.push(entry)
  })
}
