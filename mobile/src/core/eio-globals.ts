// engine.io-client's browser globals (`build/esm/globals.js`, same exports: mobile-realtime.spec compares them)
// without its last fallback `Function("return this")()`: the mini program has neither `self` nor `window` and
// forbids Function / eval (core/jitless.ts), and that line ran when the vendor chunk loaded, before any app
// code. vite.config.ts puts this module in place of engine.io-client's `globals.node.js` in every uni build;
// scripts/mp-size.mjs fails an mp build that still carries the fallback.

export const nextTick = (cb: () => void) => Promise.resolve().then(cb)

/**
 * What engine.io reads from the global object: the timers (WebSocket / XMLHttpRequest only for its own
 * transports, which realtime.ts does not use). Without `self` / `window` (mini program, App service layer)
 * the timers by scope lookup: a mini program's globals need not be properties of `globalThis`.
 */
export const globalThisShim =
  typeof self !== 'undefined'
    ? self
    : typeof window !== 'undefined'
      ? window
      : {
          setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
          clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
        }

export const defaultBinaryType = 'arraybuffer'

export function createCookieJar() {}
