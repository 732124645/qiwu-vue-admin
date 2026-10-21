import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AgentProviderController, AgentSearchProviderController } from './provider.controller.js'
import { AgentProvider, AgentSearchProvider } from './provider.entity.js'
import { ProviderRegistry, ProviderSearchConfig } from './provider-registry.js'
import {
  ProviderSettingsService,
  SearchProviderSettingsService,
} from './provider-settings.service.js'

/**
 * 智能体的模型与搜索提供方：平台配置接口（密钥加密、只写不读）与运行时取模型的 `ProviderRegistry`。
 * 由 AgentModule 引入（随 `APP_AGENT` 开关加载）；只依赖全局的配置、事务、鉴权与审计模块。
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentProvider, AgentSearchProvider])],
  controllers: [AgentProviderController, AgentSearchProviderController],
  providers: [
    ProviderSettingsService,
    SearchProviderSettingsService,
    ProviderRegistry,
    ProviderSearchConfig,
  ],
  exports: [
    ProviderRegistry,
    ProviderSettingsService,
    SearchProviderSettingsService,
    ProviderSearchConfig,
  ],
})
export class AgentProviderModule {}
