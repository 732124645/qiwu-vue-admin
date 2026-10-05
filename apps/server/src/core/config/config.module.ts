import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { envFiles } from '../paths.js'
import { EnvSchema, type Env } from './env.schema.js'

/** Typed, validated env (`EnvSchema` output: numbers and booleans already parsed). */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get<Env[K]>(key) as Env[K]
  }
}

@Global()
@Module({})
export class CoreConfigModule {
  /**
   * Loads the env files (`paths.envFiles()`: mode file, then `.env.local`; the process env wins) and
   * validates them with `EnvSchema`; a missing `APP_SECRET` or any invalid key rejects, so the app
   * never boots half-configured. Validated values are also written back to `process.env`.
   */
  static forRoot(): DynamicModule {
    return {
      module: CoreConfigModule,
      imports: [
        ConfigModule.forRoot({ envFilePath: envFiles(), validationSchema: EnvSchema, cache: true }),
      ],
      providers: [AppConfigService],
      exports: [AppConfigService],
    }
  }
}
