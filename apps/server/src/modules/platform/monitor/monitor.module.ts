import { Module } from '@nestjs/common'
import { CacheMonitorService } from './cache.service.js'
import { MonitorController } from './monitor.controller.js'
import { MonitorService } from './monitor.service.js'

/** Monitor pages: server, Redis, cache, MySQL. */
@Module({ controllers: [MonitorController], providers: [MonitorService, CacheMonitorService] })
export class MonitorModule {}
