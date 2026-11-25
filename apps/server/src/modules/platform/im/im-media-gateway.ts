import http from 'node:http'
import https from 'node:https'
import { Injectable, type OnModuleDestroy } from '@nestjs/common'
import type { ImCallMode } from '@qiwu/shared'
import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk'
import { AppConfigService } from '../../../core/config/config.module.js'
import { guardedAgents, outboundRule } from '../../../core/net/net-guard.js'

/** 控制结果不明不能当成未创建；异常不携带上游正文、地址或凭据。 */
export class ImMediaGatewayError extends Error {
  constructor(readonly mayHaveCreated = true) {
    super('media control request failed')
  }
}

/** 官方 SDK 负责签名；固定 Twirp 方法复用出站防护，限制重定向、时间和响应大小。 */
@Injectable()
export class ImMediaGateway implements OnModuleDestroy {
  private readonly agents

  constructor(private readonly cfg: AppConfigService) {
    this.agents = guardedAgents({
      ...outboundRule(cfg, 'livekit'),
      timeoutMs: 2000,
    })
  }

  /** 未配置时语音仍可用，任何通话控制都不会外呼。 */
  configured(): boolean {
    return this.settings() !== null
  }

  /** 创建只由持久化意图的认领者调用一次，未知结果由房间查询收敛。 */
  async createRoom(room: string, signal?: AbortSignal): Promise<void> {
    const data = await this.request(
      'CreateRoom',
      { name: room, maxParticipants: 8, emptyTimeout: 60 },
      { roomCreate: true },
      signal,
    )
    if (data.name !== room) throw new ImMediaGatewayError()
  }

  /** 只查询一个永不复用的媒体名字，不能用全量房间列表作为应用授权。 */
  async hasRoom(room: string, signal?: AbortSignal): Promise<boolean> {
    const data = await this.request('ListRooms', { names: [room] }, { roomList: true }, signal)
    // protobuf JSON 可以省略空 repeated 字段；成功的空响应表示这次观察中没有房间。
    if (data.rooms === undefined) return false
    if (!Array.isArray(data.rooms)) throw new ImMediaGatewayError()
    return data.rooms.some(
      (item: unknown) =>
        !!item && typeof item === 'object' && (item as { name?: unknown }).name === room,
    )
  }

  /** 删除成功或已不存在仅证明当前观察；调用者仍须核对是否有在途创建。 */
  async deleteRoom(room: string, signal?: AbortSignal): Promise<void> {
    await this.request('DeleteRoom', { room }, { roomAdmin: true, room }, signal, true)
  }

  /** 入场票据只在运行时返回，不能创建房间、管理房间或发布屏幕轨道。 */
  async grant(
    room: string,
    identity: string,
    name: string,
    mode: ImCallMode,
  ): Promise<{ url: string; token: string; identity: string; expiresAt: string }> {
    const settings = this.settings()
    if (!settings) throw new ImMediaGatewayError(false)
    const token = new AccessToken(settings.key, settings.secret, { identity, name, ttl: 60 })
    token.addGrant({
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources:
        mode === 'video' ? [TrackSource.MICROPHONE, TrackSource.CAMERA] : [TrackSource.MICROPHONE],
    })
    return {
      url: settings.client,
      token: await token.toJwt(),
      identity,
      expiresAt: new Date((Math.floor(Date.now() / 1000) + 60) * 1000).toISOString(),
    }
  }

  /** 只接受无用户信息、查询或片段的固定 origin；私有本机服务由环境显式启用。 */
  private settings(): { api: URL; client: string; key: string; secret: string } | null {
    const key = this.cfg.get('IM_LIVEKIT_API_KEY').trim()
    const secret = this.cfg.get('IM_LIVEKIT_API_SECRET').trim()
    if (!key || !secret) return null
    try {
      const api = new URL(this.cfg.get('IM_LIVEKIT_API_URL'))
      const client = new URL(this.cfg.get('IM_LIVEKIT_URL'))
      const bare = (u: URL) =>
        !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'
      const local = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      const development =
        this.cfg.get('NODE_ENV') !== 'production' && this.cfg.get('ALLOW_PRIVATE_ENDPOINTS')
      if (
        !bare(api) ||
        !bare(client) ||
        !(api.protocol === 'https:' || (development && api.protocol === 'http:' && local(api))) ||
        !(client.protocol === 'wss:' || (development && client.protocol === 'ws:' && local(client)))
      )
        return null
      return { api, client: client.origin, key, secret }
    } catch {
      return null
    }
  }

  /** 不跟重定向；总时限涵盖签名后的网络等待和慢速响应，超限立即终止请求。 */
  private async request(
    method: string,
    body: object,
    grant: VideoGrant,
    signal?: AbortSignal,
    missingOk = false,
  ): Promise<Record<string, unknown>> {
    const settings = this.settings()
    if (!settings || signal?.aborted) throw new ImMediaGatewayError(false)
    const token = new AccessToken(settings.key, settings.secret, { ttl: 60 })
    token.addGrant(grant)
    const authorization = await token.toJwt()
    if (signal?.aborted) throw new ImMediaGatewayError(false)
    const bytes = Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = () => {
        if (!settled) {
          settled = true
          reject(new ImMediaGatewayError())
        }
      }
      const target = new URL(`/twirp/livekit.RoomService/${method}`, settings.api)
      const transport = target.protocol === 'https:' ? https : http
      const request = transport.request(
        target,
        {
          method: 'POST',
          agent: target.protocol === 'https:' ? this.agents.httpsAgent : this.agents.httpAgent,
          headers: {
            Authorization: `Bearer ${authorization}`,
            'Content-Type': 'application/json',
            'Content-Length': bytes.length,
          },
          signal,
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 1024 * 1024) {
              response.destroy()
              request.destroy()
              fail()
            } else chunks.push(chunk)
          })
          response.on('error', fail)
          response.on('end', () => {
            if (settled) return
            let data: unknown
            try {
              data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch {
              fail()
              return
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
              fail()
              return
            }
            if (
              (response.statusCode ?? 500) !== 200 &&
              !(
                missingOk &&
                response.statusCode === 404 &&
                (data as { code?: unknown }).code === 'not_found'
              )
            ) {
              fail()
              return
            }
            settled = true
            resolve(data as Record<string, unknown>)
          })
        },
      )
      const timer = setTimeout(() => {
        request.destroy()
        fail()
      }, 2000)
      request.once('error', fail)
      request.once('close', () => clearTimeout(timer))
      request.end(bytes)
    })
  }

  /** 模块关闭释放保持连接的 socket，不留下测试或进程退出后的连接。 */
  onModuleDestroy(): void {
    this.agents.httpAgent.destroy()
    this.agents.httpsAgent.destroy()
  }
}
