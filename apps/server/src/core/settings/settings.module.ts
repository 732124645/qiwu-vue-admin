import { Global, Module } from '@nestjs/common'
import { DictService } from './dict.service.js'
import { ParamService } from './param.service.js'

/** Read side of settings (dicts, params) for core and modules; needs CoreDbModule + CoreRedisModule. */
@Global()
@Module({ providers: [DictService, ParamService], exports: [DictService, ParamService] })
export class CoreSettingsModule {}
