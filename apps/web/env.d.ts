/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE?: string
}

// the form designer's locale texts, read from its source like the designer itself (see docs/adr/004-form-create.md)
declare module '@form-create/designer/src/locale/*.js' {
  const locale: Record<string, unknown> & {
    name: string
    menu: Record<string, string>
    com: Record<string, unknown>
  }
  export default locale
}

// its built-in components (the drag rules of its component list), read to hide the ones the whitelist refuses
declare module '@form-create/designer/src/config/index.js' {
  import type { DragRule } from '@form-create/designer'
  const ruleList: DragRule[]
  export default ruleList
}
