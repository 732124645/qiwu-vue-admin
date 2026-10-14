import { Module } from '@nestjs/common'
import { CacheMonitorService } from './cache.service.js'
import { MonitorController } from './monitor.controller.js'
import { MonitorService } from './monitor.service.js'
import { QueueMonitorController } from './queue-monitor.controller.js'
import { QueueMonitorService } from './queue-monitor.service.js'

/** Monitor pages: server, Redis, cache, MySQL, queues. */
@Module({
  controllers: [MonitorController, QueueMonitorController],
  providers: [MonitorService, CacheMonitorService, QueueMonitorService],
})
export class MonitorModule {}
