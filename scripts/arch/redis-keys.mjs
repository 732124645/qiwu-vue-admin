// Redis keys are built only by apps/server/src/core/redis/cache-namespaces.ts (prefix `qw:`,
// the only keys the Redis ACL user may touch). Flags a call on a redis-named receiver whose first
// argument is a string/template literal: redis.get('dict:x'), this.redis.set(`param:${k}`, v).
// Event methods take event names, not keys; Lua's redis.call/pcall take a command name. Receiver-name heuristic; a client stored under
// another name, sendCommand([...]) or multi() chains are not seen (the ACL still rejects non-qw: keys).
const CALL = /\b\w*redis\w*\s*\.\s*(\w+)\s*\(\s*['"`]/gi
const NOT_KEYS = new Set([
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'emit',
  'call',
  'pcall',
])

export default function ({ lines }) {
  const out = []
  for (const { file, n, line } of lines('apps/server/src/**/*.ts')) {
    if (file.endsWith('core/redis/cache-namespaces.ts')) continue
    for (const m of line.matchAll(CALL))
      if (!NOT_KEYS.has(m[1]))
        out.push(
          `${file}:${n} literal Redis key in .${m[1]}(); build it with redisKey() (cache-namespaces.ts)`,
        )
  }
  return out
}
