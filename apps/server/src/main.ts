import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import { setupApp } from './app.setup.js'
import { AppConfigService } from './core/config/config.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  // SIGTERM/SIGINT run the shutdown hooks (Redis/DB connections close cleanly)
  app.enableShutdownHooks()
  setupApp(app)
  const cfg = app.get(AppConfigService)
  // loopback by default: the API is reached through the Vite proxy / reverse proxy, never directly
  // from the LAN (a future Docker setup sets HOST=0.0.0.0 inside the container network)
  await app.listen(cfg.get('PORT'), cfg.get('HOST'))
}

// No top-level await: keeps a CommonJS fallback a zero-change switch (see docs/adr/001-module-format.md).
void bootstrap()
