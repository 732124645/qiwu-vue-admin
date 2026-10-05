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

      DB_HOST: z.string().default('127.0.0.1'),
      DB_PORT: port.default(3306),
      DB_USER: z.string(),
      DB_PASSWORD: z.string().optional(),
      DB_NAME: z.string(),

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
