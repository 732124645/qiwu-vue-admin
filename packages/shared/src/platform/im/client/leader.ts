/**
 * 多标签页选主（`navigator.locks`）：成为/不再是主标签页时回调；返回释放函数。持锁的标签页关闭时浏览器
 * 自动放锁，排队的下一个标签页成为主标签页。没有 Web Locks 的环境（App、旧浏览器）当自己是主标签页。
 */
export function electLeader(name: string, onChange: (leader: boolean) => void): () => void {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) {
    onChange(true)
    return () => onChange(false)
  }
  const abort = new AbortController()
  let release: (() => void) | null = null
  let leader = false
  locks
    .request(name, { signal: abort.signal }, () => {
      leader = true
      onChange(true)
      // 一直持锁，直到释放函数被调用或标签页关闭
      return new Promise<void>((resolve) => (release = resolve))
    })
    .catch(() => undefined)
  return () => {
    abort.abort()
    release?.()
    if (leader) onChange(false)
    leader = false
  }
}
