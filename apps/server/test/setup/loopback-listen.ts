// Vitest setupFiles：supertest 对未监听的应用服务器调用 `listen(0)`（通配地址 ::），再去连 127.0.0.1:<端口>。
// macOS 按顺序分配临时端口，而且在 SO_REUSEADDR 下会把一个已被别的进程只绑在 127.0.0.1 上的端口照样分给通配
// 监听；连 127.0.0.1 时更具体的那个绑定胜出，请求落到别的进程上，测试偶发收到与本应用无关的 404 / 401。
// 这里把不带主机的 0 端口监听改为同步绑定 127.0.0.1：内核会跳过回环上已被占用的端口，请求一定回到本进程。
import { Server } from 'node:net'

type LegacyListen = (address: string, port: number, addressType: number) => void
const listen = Server.prototype.listen

/**
 * 只改写 `listen(0)` / `listen(0, 回调)`，其余调用原样转发。supertest 在 `listen(0)` 返回后立刻读
 * `address()`，而带主机的公开写法要先异步解析地址，所以走 Node 自己在非集群进程里同步绑定所用的
 * `_listen2`（setupListenHandle 的旧别名）；失败时照常发出 `error` 事件。
 */
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  if (args[0] !== 0 || args.length > 2 || (args.length === 2 && typeof args[1] !== 'function'))
    return listen.apply(this, args as Parameters<typeof listen>)
  if (typeof args[1] === 'function') this.once('listening', args[1] as () => void)
  ;(this as unknown as { _listen2: LegacyListen })._listen2('127.0.0.1', 0, 4)
  return this
} as typeof listen
