import { Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AccessTokenService } from './access-token.service.js'
import {
  McpMyTokenController,
  McpMyToolController,
  McpTokenController,
  McpToolController,
} from './mcp-admin.controller.js'
import { McpAuth } from './mcp-auth.js'
import { McpController, McpWellKnownController } from './mcp.controller.js'
import { AccessToken, McpToolSwitch } from './mcp.entity.js'
import { McpRegistry } from './mcp-registry.js'
import { McpService } from './mcp.service.js'

/**
 * 智能体接入（see docs/mcp.md），只在 `APP_MCP` 打开时加载：关闭时 `/api/mcp`、发现文档与全部管理接口
 * 都不存在（404），工具不注册。工具本身由各模块的 provider 用 `@McpTool` 声明，这里启动时扫描。
 * 需要全局的 CoreAuthModule（AuthService、TokenService…）、CoreSettingsModule、CoreAuditModule 与
 * 节流存储。
 */
@Module({
  imports: [DiscoveryModule, TypeOrmModule.forFeature([AccessToken, McpToolSwitch])],
  controllers: [
    McpController,
    McpWellKnownController,
    McpToolController,
    McpMyTokenController,
    McpMyToolController,
    McpTokenController,
  ],
  providers: [McpRegistry, AccessTokenService, McpAuth, McpService],
})
export class McpModule {}
