// Imported first by main.ts, before anything reaches @qiwu/shared: zod v4 compiles object
// parsers with `new Function` unless jitless, and mp-weixin forbids eval. The app and shared use one zod
// (vite.config.ts alias), so this one switch covers both.
import { z } from 'zod'

z.config({ jitless: true })

// shared's form checks and calc (the dynamic form renderer) call Object.hasOwn, which the JS engine of
// iOS < 15.4 (mp-weixin, App) lacks and esbuild does not polyfill
if (typeof Object.hasOwn !== 'function')
  Object.hasOwn = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k)
