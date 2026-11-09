import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { SchedulerRegistry } from '@nestjs/schedule'
import { getDataSourceToken } from '@nestjs/typeorm'
import { imParams } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { ImMediaGateway } from '../../src/modules/platform/im/im-media-gateway.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { ImCallsService } from '../../src/modules/platform/im/im-calls.service.js'
import { bearer } from '../setup/auth.js'
import {
  addUser,
  bootApp,
  createTenant,
  signInDirect,
  type PeopledTenant,
} from '../setup/tenants.js'

export const MEDIA_FIXTURE_KEY = 'integration-key'
export const MEDIA_FIXTURE_SECRET = 'integration-secret-not-a-production-credential'

/** 合成静音 PCM 测试数据，不把编码器或录音实现带进生产路径。 */
export function pcmVoice(seconds = 0.1, rate = 16000, channels = 1, bits = 16, codec = 1): Buffer {
  const data = Buffer.alloc(Math.round((seconds * rate * channels * bits) / 8))
  const head = Buffer.alloc(44)
  head.write('RIFF')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(codec, 20)
  head.writeUInt16LE(channels, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE((rate * channels * bits) / 8, 28)
  head.writeUInt16LE((channels * bits) / 8, 32)
  head.writeUInt16LE(bits, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** 每个规格独立创建用户和房间，真实业务/数据库/授权保持，只替换远端房间控制。 */
export class ImMediaKit {
  app: NestExpressApplication
  ds: DataSource
  other: PeopledTenant
  gateway: ImMediaGateway
  readonly remote = new Set<string>()
  readonly users: number[] = []
  readonly rooms: number[] = []
  private readonly tokens = new Map<number, string>()
  private readonly prefix = `im-media-${randomUUID().slice(0, 8)}`
  private initialEnabled: string | null = null

  async boot(): Promise<void> {
    this.app = await bootApp({
      multiTenant: true,
      env: {
        APP_IM: 'true',
        IM_LIVEKIT_URL: 'wss://media.example.test',
        IM_LIVEKIT_API_URL: 'https://media.example.test',
        IM_LIVEKIT_API_KEY: MEDIA_FIXTURE_KEY,
        IM_LIVEKIT_API_SECRET: MEDIA_FIXTURE_SECRET,
      },
    })
    this.ds = this.app.get<DataSource>(getDataSourceToken())
    this.gateway = this.app.get(ImMediaGateway)
    // 端点用例显式驱动 reconcile/tick，防止后台周期碰巧替代待验证的 sid 钩子或请求守卫。
    this.app.get(SchedulerRegistry).deleteInterval('im-call-maintenance')
    this.other = await createTenant(this.app, { users: true })
    this.initialEnabled = await this.app.get(ParamService).get(imParams.callEnabled)
    await this.param(imParams.callEnabled, 'true')
    this.provider()
  }

  /** 恢复远端端口的可控响应；未知创建用例可在本次基础上覆盖。 */
  provider(): void {
    vi.spyOn(this.gateway, 'configured').mockReturnValue(true)
    vi.spyOn(this.gateway, 'createRoom').mockImplementation(async (room) => {
      this.remote.add(room)
    })
    vi.spyOn(this.gateway, 'hasRoom').mockImplementation(async (room) => this.remote.has(room))
    vi.spyOn(this.gateway, 'deleteRoom').mockImplementation(async (room) => {
      this.remote.delete(room)
    })
  }

  async param(key: string, value: string): Promise<void> {
    await this.ds.query('UPDATE cfg_param SET param_value=? WHERE param_key=?', [value, key])
    await this.app.get(ParamService).invalidate(key)
  }

  async person(label = 'person'): Promise<number> {
    const id = await addUser(this.app, 1, `${this.prefix}-${label}-${this.users.length}`)
    this.users.push(id)
    return id
  }

  async token(userId: number, fresh = false): Promise<string> {
    if (fresh || !this.tokens.has(userId)) {
      const answer = await signInDirect(this.app, userId)
      this.tokens.set(userId, answer!.accessToken)
    }
    return this.tokens.get(userId)!
  }

  async call(
    method: 'get' | 'post' | 'delete',
    path: string,
    userId: number,
    body?: object,
    token?: string,
  ): Promise<request.Response> {
    const req = request(this.app.getHttpServer())
      [method](`/api/im${path}`)
      .set(bearer(token ?? (await this.token(userId))))
    return body === undefined ? req : req.send(body)
  }

  async group(owner: number, others: number[]): Promise<number> {
    const res = await this.call('post', '/rooms/groups', owner, {
      label: 'media group',
      userIds: others,
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    this.rooms.push(res.body.data.roomId)
    return res.body.data.roomId as number
  }

  async direct(owner: number, peer: number): Promise<number> {
    const res = await this.call('post', '/rooms/directs', owner, { peerId: peer })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    this.rooms.push(res.body.data.roomId)
    return res.body.data.roomId as number
  }

  async create(
    room: number,
    caller: number,
    users?: number[],
    mode = 'audio',
    clientCallId = randomUUID(),
  ): Promise<number> {
    const res = await this.call('post', `/rooms/${room}/calls`, caller, {
      mode,
      clientCallId,
      ...(users && { userIds: users }),
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return res.body.data.id as number
  }

  async clearThrottle(): Promise<void> {
    const redis = this.app.get<Redis>(REDIS)
    for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 100 }))
      if (keys.length) await redis.unlink(keys)
  }

  /** 领域幂等另行验证；显式清掉三秒防连点键，模拟稍后使用相同业务编号重试。 */
  async clearDuplicateGuard(): Promise<void> {
    const redis = this.app.get<Redis>(REDIS)
    for await (const keys of redis.scanIterator({ MATCH: keyPattern('idem'), COUNT: 100 }))
      if (keys.length) await redis.unlink(keys)
  }

  async reconcile(id: number): Promise<void> {
    // qw:cross-tenant 规格的默认数据明确属于租户 1，不能依赖测试进程残留的请求上下文。
    await withTenant(1, () => this.app.get(ImCallsService).reconcile(id))
  }

  async close(): Promise<void> {
    if (!this.ds) return
    vi.restoreAllMocks()
    await this.param(imParams.callEnabled, this.initialEnabled ?? 'false')
    if (this.rooms.length) {
      await this.ds.query(
        'DELETE FROM im_call_member WHERE call_id IN (SELECT id FROM im_call WHERE tenant_id=1 AND room_id IN (?))',
        [this.rooms],
      )
      await this.ds.query('DELETE FROM im_call WHERE tenant_id=1 AND room_id IN (?)', [this.rooms])
      await this.ds.query('DELETE FROM im_entry WHERE tenant_id=1 AND room_id IN (?)', [this.rooms])
      await this.ds.query('DELETE FROM im_roster WHERE tenant_id=1 AND room_id IN (?)', [
        this.rooms,
      ])
      await this.ds.query('DELETE FROM im_room WHERE tenant_id=1 AND id IN (?)', [this.rooms])
    }
    if (this.users.length) {
      await this.ds.query('DELETE FROM fs_object WHERE tenant_id=1 AND uploader_id IN (?)', [
        this.users,
      ])
      await this.ds.query('DELETE FROM iam_user WHERE tenant_id=1 AND id IN (?)', [this.users])
    }
    await this.other?.dispose()
    await this.app.close()
  }
}
