import { type Directive, type Ref, ref, watchEffect } from 'vue'
import { useAuthStore } from '@/core/stores/auth'

/** Permission checks for scripts (see docs/design-notes.md#permissions): `has` = any of, `all` = every one; root's `*` passes. */
export function usePerm() {
  const auth = useAuthStore()
  return {
    has: (perm: string | string[]) => auth.hasPerm(perm),
    all: (perms: string[]) => perms.every((p) => auth.hasPerm(p)),
  }
}

const stops = new WeakMap<HTMLElement, { perm: Ref<string | string[]>; stop: () => void }>()

/**
 * `v-perm="'settings.dict.browse'"` (an array = any of): hides the element without the permission.
 * Display only — the server enforces every permission. Follows the perms as they reload: the
 * element shows up once granted and hides once revoked, without a new sign-in.
 */
export const vPerm: Directive<HTMLElement, string | string[]> = {
  mounted(el, { value }) {
    const auth = useAuthStore()
    const perm = ref(value)
    let hidden = false
    const stop = watchEffect(() => {
      if (!auth.hasPerm(perm.value)) {
        el.style.display = 'none'
        hidden = true
      } else if (hidden) {
        el.style.display = ''
        hidden = false
      }
    })
    stops.set(el, { perm, stop })
  },
  updated(el, { value }) {
    const state = stops.get(el)
    if (state) state.perm.value = value
  },
  unmounted(el) {
    stops.get(el)?.stop()
    stops.delete(el)
  },
}

declare module 'vue' {
  interface GlobalDirectives {
    vPerm: typeof vPerm
  }
}
