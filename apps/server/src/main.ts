import 'reflect-metadata'
import { Logger as NestLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import { setupApp } from './app.setup.js'
import { AppConfigService } from './core/config/config.module.js'
import type { Env } from './core/config/env.schema.js'
import { effectiveConfigLine, envFileConflicts } from './core/config/env-report.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  const log = new NestLogger('Bootstrap')
  // .env 高于 .env.local：两边写了不同值时只提示键名，避免 .env.local 里的改动静默失效
  const conflicts = envFileConflicts()
  if (conflicts) log.warn(conflicts)
  // SIGTERM/SIGINT run the shutdown hooks (Redis/DB connections close cleanly)
  app.enableShutdownHooks()
  setupApp(app)
  const cfg = app.get(AppConfigService)
  // loopback by default: the API is reached through the Vite proxy / reverse proxy, never directly
  // from the LAN (a future Docker setup sets HOST=0.0.0.0 inside the container network)
  await app.listen(cfg.get('PORT'), cfg.get('HOST'))
  log.log(effectiveConfigLine((key) => cfg.get(key as keyof Env)))
  // 开发父进程据此确认端口已就绪，不能把编译结束或进程创建当作服务恢复。
  if (process.env.QW_DEV === '1' && cfg.get('NODE_ENV') === 'development' && process.send)
    process.send({ type: 'qw:dev-ready', url: await app.getUrl() })
}

// No top-level await: keeps a CommonJS fallback a zero-change switch (see docs/adr/001-module-format.md).
void bootstrap()
