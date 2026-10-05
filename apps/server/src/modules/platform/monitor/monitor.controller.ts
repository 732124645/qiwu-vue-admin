import { Controller, Delete, Get, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type CacheClearQuery,
  cacheClearQuery,
  cacheClearVo,
  type CacheKeysQuery,
  cacheKeysQuery,
  cacheKeysVo,
  cacheNamespaceVo,
  type CacheValueQuery,
  cacheValueQuery,
  cacheValueVo,
  monitorMysqlVo,
  monitorPerms,
  monitorRedisVo,
  monitorServerVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { z } from 'zod'
import { ActionLog } from '../../../core/audit/action-log.js'
import { SkipHttpTrace } from '../../../core/audit/http-trace.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { CacheMonitorService } from './cache.service.js'
import { MonitorService } from './monitor.service.js'

/** The cleared namespace or key (query), for the action log. */
const clearedBizId = (req: Request) => req.query.ns ?? req.query.key

/**
 * Monitor pages: server, Redis, cache, MySQL; read-only but for the cache clean-up. The
 * reads are polled (every 5 s while a page is visible): `@SkipHttpTrace`, or the access log in mode
 * `all` would fill with them; the clean-ups keep their access and action log rows.
 */
@ApiTags('monitor')
@Controller('monitor')
export class MonitorController {
  constructor(
    private readonly monitor: MonitorService,
    private readonly cache: CacheMonitorService,
  ) {}

  @Get('server')
  @SkipHttpTrace()
  @RequirePerm(monitorPerms.server)
  @ApiOperation({ summary: 'Host and Node.js process: CPU, memory, disks, OS, runtime' })
  @ApiEnvelope(monitorServerVo)
  server() {
    return this.monitor.server()
  }

  @Get('redis')
  @SkipHttpTrace()
  @RequirePerm(monitorPerms.redis)
  @ApiOperation({ summary: 'Redis INFO sections, command statistics and the own keyspace' })
  @ApiEnvelope(monitorRedisVo)
  redis() {
    return this.monitor.redisInfo()
  }

  @Get('mysql')
  @SkipHttpTrace()
  @RequirePerm(monitorPerms.mysql)
  @ApiOperation({ summary: 'Whitelisted MySQL status and variables, the connection pool' })
  @ApiEnvelope(monitorMysqlVo)
  mysql() {
    return this.monitor.mysql()
  }

  @Get('cache/namespaces')
  @SkipHttpTrace()
  @RequirePerm(monitorPerms.cache)
  @ApiOperation({ summary: 'The registered cache namespaces' })
  @ApiEnvelope(z.array(cacheNamespaceVo))
  namespaces() {
    return this.cache.namespaces()
  }

  @Get('cache/keys')
  @SkipHttpTrace()
  @RequirePerm(monitorPerms.cache)
  @ApiOperation({ summary: 'Keys of one registered namespace (SCAN, capped)' })
  @ApiEnvelope(cacheKeysVo)
  keys(@Query({ schema: cacheKeysQuery }) { ns }: CacheKeysQuery) {
    return this.cache.keys(ns)
  }

  @Get('cache/value')
  @SkipHttpTrace()
  @RequirePerm(monitorPerms.cache)
  @ApiOperation({ summary: 'Type, TTL and value of one key (masked namespaces: no value)' })
  @ApiEnvelope(cacheValueVo)
  value(@Query({ schema: cacheValueQuery }) { key }: CacheValueQuery) {
    return this.cache.value(key)
  }

  @Delete('cache/keys')
  @RequirePerm(monitorPerms.cacheClear)
  @ActionLog({ domain: 'monitor.cache', verb: 'remove', bizId: clearedBizId })
  @ApiOperation({ summary: 'Delete a clearable namespace (ns) or one key of one (key)' })
  @ApiEnvelope(cacheClearVo)
  clear(@Query({ schema: cacheClearQuery }) query: CacheClearQuery) {
    return this.cache.clear(query)
  }

  @Delete('cache/all-registered')
  @RequirePerm(monitorPerms.cacheClear)
  @ActionLog({ domain: 'monitor.cache', verb: 'clean' })
  @ApiOperation({ summary: 'Delete the keys of every clearable namespace' })
  @ApiEnvelope(cacheClearVo)
  clearAll() {
    return this.cache.clearAll()
  }
}
