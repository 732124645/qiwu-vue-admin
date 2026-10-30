import { z } from 'zod'
import { DEFAULT_UPLOAD_ROOT } from '../paths.js'
import { assertProductionSecrets } from './production-secrets.js'

const port = z.coerce.number().int().min(1).max(65535)
const seconds = z.coerce.number().int().positive()
// 'true'/'false' (also 1/0, yes/no, on/off); anything else fails validation
const flag = z.stringbool()
// decimal port numbers separated by commas or spaces (`9000, 8333`); any other entry (0x16, 1e3,
// 80.5, 0, 70000) fails validation
const portList = z
  .string()
  .transform((s) => s.split(/[\s,]+/).filter(Boolean))
  .pipe(
    z.array(
      z
        .string()
        .regex(/^[0-9]{1,5}$/)
        .transform(Number)
        .pipe(z.number().min(1).max(65535)),
    ),
  )

/**
 * MySQL pool sizing (see docs/deploy.md): every process holds its own pool. Defaults keep mysql2's
 * own (10 connections, unbounded wait queue, no acquire timeout). Shared with `dataSourceOptions()`,
 * which the `db:*` scripts call without the full schema.
 */
export const DbPoolEnvShape = {
  /** connections per process (TypeORM `poolSize` → mysql2 `connectionLimit`) */
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  /** wait for a free connection at most this long, then fail with 503; 0 = no limit */
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(0).default(0),
  /** at most this many requests wait for a connection, the next fails with 503; 0 = no limit */
  DB_POOL_QUEUE_LIMIT: z.coerce.number().int().min(0).default(0),
}

/**
 * Non-secret keys the server logs once after `listen` (`main.ts`): the values a deployer checks first.
 * A project appends its own non-secret keys; credentials (`*_PASSWORD`, `*_USER*`, `APP_SECRET`,
 * `WX_MP_*`) never go here. Keys outside `EnvSchema` are read from the process env.
 */
export const EFFECTIVE_CONFIG_KEYS: string[] = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'LOG_LEVEL',
  'APP_ROLE',
  'APP_MULTI_TENANT',
  'APP_WXOA',
  'APP_MCP',
  'APP_AGENT',
  'APP_DEMO_MODE',
  'SWAGGER_ENABLED',
  'DB_HOST',
  'DB_NAME',
  'DB_POOL_SIZE',
  'REDIS_DB',
  'REDIS_KEY_PREFIX',
  'NODE_APP_INSTANCE',
]

/**
 * Server env, validated once at startup by `@nestjs/config` (Standard Schema):
 * missing/invalid values stop the boot. Keys mirror `apps/server/.env.example` (the credentials only
 * as comments there: they belong in `.env.local`).
 */
export const EnvSchema = z.preprocess(
  // `KEY=` in an env file means "not set", so defaults and required checks apply to it
  (env) =>
    Object.fromEntries(Object.entries(env as Record<string, unknown>).filter(([, v]) => v !== '')),
  z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      /** bind address: loopback, only the reverse proxy / Vite proxy talks to the API */
      HOST: z.string().default('127.0.0.1'),
      PORT: port.default(3000),
      /** Express `trust proxy`: the real reverse-proxy address(es) only, never whole private ranges (see docs/design-notes.md#security) */
      TRUST_PROXY: z.string().default('loopback'),
      CORS_ORIGIN: z.string().optional(),
      SWAGGER_ENABLED: flag.default(false),
      LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
      /**
       * Stall diagnostics (see docs/scale-out.md), all 0 = off: a request line whose response took at
       * least LOG_SLOW_REQUEST_MS is marked `slow` with the jobs then running in the process (warn); every
       * LOG_EVENT_LOOP_INTERVAL_MS one event-loop line, at warn when its max reaches LOG_EVENT_LOOP_WARN_MS
       */
      LOG_SLOW_REQUEST_MS: z.coerce.number().int().min(0).default(0),
      LOG_EVENT_LOOP_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
      LOG_EVENT_LOOP_WARN_MS: z.coerce.number().int().min(0).default(0),

      DB_HOST: z.string().default('127.0.0.1'),
      DB_PORT: port.default(3306),
      DB_USER: z.string(),
      DB_PASSWORD: z.string().optional(),
      DB_NAME: z.string(),
      ...DbPoolEnvShape,

      REDIS_HOST: z.string().default('127.0.0.1'),
      REDIS_PORT: port.default(6379),
      REDIS_DB: z.coerce.number().int().min(0).default(0),
      REDIS_USERNAME: z.string().optional(),
      REDIS_PASSWORD: z.string().optional(),
      /** every key starts with it (cache-namespaces.ts); the Redis ACL user may only touch `qw:*` */
      REDIS_KEY_PREFIX: z
        .string()
        .regex(/^[\w-]+:$/)
        .default('qw:'),

      /** ≥ 32 chars, required: derives SecretBox keys (see docs/design-notes.md#security) */
      APP_SECRET: z.string().min(32),
      ACCESS_TTL_SEC: seconds.default(1800),
      REFRESH_TTL_SEC: seconds.default(604800),

      /** SSRF guard bypass for local S3/SMTP in tests only (see docs/design-notes.md#security) */
      ALLOW_PRIVATE_ENDPOINTS: flag.default(false),
      /**
       * Ports admin-configured targets may use besides the defaults (S3 80/443, SMTP 25/465/587; see docs/design-notes.md#security),
       * registered by the deployer: env only, never a cfg_param or a field of the storage/mail forms
       */
      OUTBOUND_S3_PORTS: portList.default([]),
      OUTBOUND_SMTP_PORTS: portList.default([]),
      CODEGEN_WRITE: flag.default(false),
      APP_DEMO_MODE: flag.default(false),
      /**
       * What this process runs (see docs/scale-out.md), read at startup only: `all` = HTTP, cron and every
       * queue worker; `api` = HTTP only (task writes still publish `job:sync`, "run once" is queued for a
       * worker, jobs are only added); `worker` = cron and every queue worker, still listening (health
       * checks, Socket.IO pushes through the Redis adapter). At least one `all` or `worker` instance is
       * required, or cron and queues stop.
       */
      APP_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
      /**
       * Multi-tenancy (see docs/design-notes.md#tenancy): read at startup only, every instance restarts
       * to switch it; off = the single default tenant
       */
      APP_MULTI_TENANT: flag.default(false),
      /**
       * WeChat Official Account management (see docs/design-notes.md#wxoa): read at startup only; off =
       * the module is not loaded (its routes 404, no jobs, no calls to WeChat), its menus hidden
       */
      APP_WXOA: flag.default(false),
      /**
       * Agent access over MCP (see docs/mcp.md): read at startup only; off = the module is not loaded
       * (/api/mcp and its admin routes 404), its menus hidden
       */
      APP_MCP: flag.default(false),
      /**
       * The in-app agent (see docs/agent.md): read at startup only; off = the module is not loaded
       * (/api/agent/* 404), its menus hidden. It shares the tool registry with APP_MCP but needs it not
       */
      APP_AGENT: flag.default(false),
      STORAGE_LOCAL_ROOT: z.string().default(DEFAULT_UPLOAD_ROOT),
      /**
       * WeChat mini program sign-in (also param `auth.wx_mp.enabled`): the AppID and its
       * AppSecret (the secret only in `.env.local`); either unset → the wx-mp routes answer 404
       */
      WX_MP_APPID: z.string().max(64).optional(),
      WX_MP_SECRET: z.string().max(128).optional(),
      /** unset → the seed prints a random admin password once and forces a change at first login */
      SEED_ADMIN_PASSWORD: z.string().optional(),
    })
    .superRefine((env, ctx) => {
      assertProductionSecrets(env, (field, message) =>
        ctx.addIssue({ code: 'custom', path: [field], message }),
      )
    }),
)

export type Env = z.output<typeof EnvSchema>
