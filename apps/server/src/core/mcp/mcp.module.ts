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
 * 外部 AI 客户端接入（see docs/mcp.md），只在 `APP_MCP` 打开时加载：关闭时 `/api/mcp`、发现文档与全部
 * 管理接口都不存在（404）。工具本身由各模块的 provider 用 `@McpTool` 声明，由 ToolHostModule 启动时扫描。
 * 需要全局的 CoreAuthModule（AuthService、TokenService…）、CoreSettingsModule、CoreAuditModule 与节流存储。
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
