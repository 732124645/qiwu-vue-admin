import { join } from 'node:path'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ModulesContainer } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import cookieParser from 'cookie-parser'
import type { NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import { AppConfigService } from './core/config/config.module.js'
import { uploadRoot } from './core/paths.js'
import { RedisIoAdapter } from './core/realtime/redis-io.adapter.js'

export const DOCS_PATH = 'api/docs'

/**
 * HTTP-level setup shared by `main.ts` and e2e specs (see docs/design-notes.md#layering, #security): `/api` prefix, `trust proxy`,
 * helmet, cookie-parser, public files at `/files` and, when `SWAGGER_ENABLED`, Swagger UI at `/api/docs`
 * (JSON at `/api/docs-json`).
 */
export function setupApp(app: NestExpressApplication): NestExpressApplication {
  const cfg = app.get(AppConfigService)
  // HTTP-only test modules do not import CoreRealtimeModule.
  if ([...app.get(ModulesContainer).values()].some((mod) => mod.providers.has(RedisIoAdapter))) {
    const adapter = app.get(RedisIoAdapter)
    adapter.bindApp(app)
    app.useWebSocketAdapter(adapter)
  }
  // only the real reverse proxy may set X-Forwarded-For (throttler, IP locks and blacklist use req.ip)
  app.set('trust proxy', cfg.get('TRUST_PROXY'))
  app.setGlobalPrefix('api')

  // helmet defaults everywhere; the Swagger UI page drops `upgrade-insecure-requests`, which would
  // turn its same-origin asset URLs into https:// ones on a plain-http dev/intranet host
  const strict = helmet()
  const docs = helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } })
  const docsUi = `/${DOCS_PATH}`
  app.use((req: Request, res: Response, next: NextFunction) =>
    (req.path === docsUi || req.path.startsWith(`${docsUi}/`) ? docs : strict)(req, res, next),
  )
  app.use(cookieParser())
  // public objects of the local storage (see docs/design-notes.md#storage): only <root>/public, no listing, no dotfiles,
  // nosniff (helmet); anything the static handler refuses (traversal, missing) falls through to 404
  app.useStaticAssets(join(uploadRoot(), 'public'), {
    prefix: '/files',
    index: false,
    redirect: false,
    dotfiles: 'deny',
    fallthrough: true,
  })

  if (cfg.get('SWAGGER_ENABLED'))
    SwaggerModule.setup(DOCS_PATH, app, () =>
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('Qiwu API')
          .addBearerAuth()
          // every route needs the access token unless @Public() (AuthGuard is global)
          .addSecurityRequirements('bearer')
          .build(),
      ),
    )
  return app
}
