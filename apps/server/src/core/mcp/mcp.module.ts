import { Module } from '@nestjs/common'
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
import { McpService } from './mcp.service.js'
import { ToolHostModule } from './tool-host.js'

/**
 * 智能体接入（see docs/mcp.md），只在 `APP_MCP` 打开时加载：关闭时 `/api/mcp`、发现文档与全部管理接口
 * 都不存在（404）。工具本身由各模块的 provider 用 `@McpTool` 声明，由共用的 ToolHostModule 启动时扫描
 * （后台智能体 `APP_AGENT` 也导入它）。需要全局的 CoreAuthModule（AuthService、TokenService…）、
 * CoreSettingsModule、CoreAuditModule 与节流存储。
 */
@Module({
  imports: [ToolHostModule, TypeOrmModule.forFeature([AccessToken, McpToolSwitch])],
  controllers: [
    McpController,
    McpWellKnownController,
    McpToolController,
    McpMyTokenController,
    McpMyToolController,
    McpTokenController,
  ],
  providers: [AccessTokenService, McpAuth, McpService],
})
export class McpModule {}
