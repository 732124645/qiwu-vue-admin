import { Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import { SessionRevoker } from '../../../core/auth/session-revoker.js'
import { allTenants, withTenant } from '../../../core/context/tenant.js'
import { RedisLock } from '../../../core/guard/redis-lock.js'
import { redisKey } from '../../../core/redis/cache-namespaces.js'
import { IM_CALL_ENTITIES } from './entities/im-call.entity.js'
import { IM_ENTITIES } from './entities/im.entity.js'
import { awaitImCallStage, ImCallsService } from './im-calls.service.js'
import { ImMediaGateway } from './im-media-gateway.js'

/** 与菜单开关及实例角色无关的持续清理；短批次和最老检查优先避免未知创建饿死其它通话。 */
@Injectable()
export class ImCallMaintenance implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImCallMaintenance.name)
  private running = false

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly calls: ImCallsService,
    private readonly gateway: ImMediaGateway,
    private readonly locks: RedisLock,
    private readonly revoker: SessionRevoker,
  ) {}

  /** 有未结控制意图时拒绝静默丢掉凭据；空存量的默认关闭部署不外呼。 */
  async onApplicationBootstrap(): Promise<void> {
    this.revoker.onSessionEnded((sid) => this.calls.sessionEnded(sid))
    // qw:cross-tenant 启动恢复检查涵盖每个租户的未终局媒体记录，含停用租户。
    const [row] = await allTenants(() =>
      this.ds.query<{ count: string }[]>(
        // qw:cross-tenant 启动扫描包含停用租户的未终局通话，随后只做凭据完整性检查。
        "SELECT COUNT(*) AS count FROM im_call WHERE deleted_at IS NULL AND state_code <> 'ended'",
      ),
    )
    if (Number(row?.count) && !this.gateway.configured())
      throw new Error(
        'LiveKit control credentials are required to drain existing calls before removal',
      )
  }

  /** 全局续租锁仅保护有限批次，SQL 状态仍保证调用认领与终局幂等。 */
  @Interval('im-call-maintenance', 5000)
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const lost = new AbortController()
    const signal = AbortSignal.any([lost.signal, AbortSignal.timeout(4000)])
    let lease: Awaited<ReturnType<RedisLock['acquire']>> = null
    let released: Promise<boolean> | undefined
    const release = () => {
      // release 先停止续租；不因某个实例的慢 DB/认证无限阻塞其他健康实例。
      if (lease && !released) released = lease.release().catch(() => false)
      return released
    }
    const abort = () => {
      void release()
    }
    const leaseLost = () => lost.abort(lease?.lost.reason)
    signal.addEventListener('abort', abort, { once: true })
    const work = (async () => {
      try {
        lease = await this.locks.acquire(redisKey('lock', 'im-call-maintenance'), 10_000)
        signal.throwIfAborted()
        if (!lease) return
        lease.lost.addEventListener('abort', leaseLost, { once: true })
        if (lease.lost.aborted) leaseLost()
        signal.throwIfAborted()
        // qw:cross-tenant 所有实例恢复同一份存量，后续每次写入回到该行自己的租户。
        const rows = await allTenants(() =>
          this.ds.query<{ id: number; tenant_id: number }[]>(
            // qw:cross-tenant 扫描所有租户的待处理编号，每项写入前回到自己的 withTenant。
            "SELECT id,tenant_id FROM im_call WHERE deleted_at IS NULL AND state_code <> 'ended' ORDER BY checked_at,id LIMIT 20",
          ),
        )
        signal.throwIfAborted()
        for (const row of rows) {
          if (signal.aborted || !lease.held) break
          try {
            // qw:cross-tenant 巡检只处理扫描行对应租户，不使用请求或其它行的身份。
            await withTenant(Number(row.tenant_id), () =>
              this.calls.reconcile(Number(row.id), signal),
            )
            signal.throwIfAborted()
          } catch {
            if (signal.aborted) break
            this.logger.warn(
              'Call cleanup will be retried; business and media state remain separate',
            )
          }
        }
      } finally {
        lease?.lost.removeEventListener('abort', leaseLost)
        await release()
      }
    })().finally(() => {
      this.running = false
    })
    try {
      // 预算到时只停止等待。不可取消的底层工作仍持 running，且内部检查阻止迟到写阶段。
      await awaitImCallStage(work, signal)
    } catch {
      if (!signal.aborted)
        this.logger.warn('Call maintenance batch could not complete; pending records are retained')
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

/** 无 controller，必须始终由主应用加载；关闭聊天不能关闭遗留媒体的清理。 */
@Module({
  imports: [TypeOrmModule.forFeature([...IM_CALL_ENTITIES, ...IM_ENTITIES])],
  providers: [ImCallsService, ImMediaGateway, ImCallMaintenance, RedisLock],
  exports: [ImCallsService, ImMediaGateway],
})
export class ImCallMaintenanceModule {}
