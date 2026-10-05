import { Controller, Get, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type GeoAreaNode,
  geoAreaNodeVo,
  type GeoByIpQuery,
  geoByIpQuery,
  type GeoIpVo,
  geoIpVo,
  geoPerms,
} from '@qiwu/shared'
import { useCascaderAreaData } from '@vant/area-data'
import { z } from 'zod'
import { ipLocator } from '../../../core/audit/ip-location.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'

interface CascaderOption {
  text: string
  value: string
  children?: CascaderOption[]
}

const toNode = ({ text, value, children }: CascaderOption): GeoAreaNode =>
  children
    ? { code: value, name: text, children: children.map(toNode) }
    : { code: value, name: text }

let tree: GeoAreaNode[] | undefined
/** Built once, kept in memory (≈ 3,900 static nodes). */
const areaTree = () => (tree ??= useCascaderAreaData().map(toNode))

/** Divisions and IP locations (platform/geo). */
@ApiTags('geo')
@Controller('geo/areas')
export class GeoController {
  /** Any signed-in user (AreaCascader in forms), so no permission is checked. */
  @Get('tree')
  @ApiOperation({ summary: 'Province → city → county tree (@vant/area-data, Chinese names)' })
  @ApiEnvelope(z.array(geoAreaNodeVo))
  tree(): GeoAreaNode[] {
    return areaTree()
  }

  @Get('by-ip')
  @RequirePerm(geoPerms.browse)
  @ApiOperation({ summary: 'Location of an IP (ip2region; all null = unknown)' })
  @ApiEnvelope(geoIpVo)
  async byIp(@Query({ schema: geoByIpQuery }) { ip }: GeoByIpQuery): Promise<GeoIpVo> {
    return { ip, ...(await ipLocator.locate(ip)) }
  }
}
