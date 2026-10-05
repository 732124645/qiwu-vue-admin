import { Module } from '@nestjs/common'
import { GeoController } from './geo.controller.js'

/** Areas and IP location; the lookup itself is core (core/audit/ip-location.ts: the logs use it). */
@Module({ controllers: [GeoController] })
export class GeoModule {}
