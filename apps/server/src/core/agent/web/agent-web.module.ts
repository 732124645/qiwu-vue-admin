import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
} from '@nestjs/common'
import { AppConfigService } from '../../config/config.module.js'
import { SafeFetcher } from './safe-fetcher.js'
import { SEARCH_CONFIG_SOURCE, type SearchConfigSource, WebSearch } from './web-search.js'
import { WebTools } from './web-tools.js'

export interface AgentWebModuleOptions {
  /** modules that provide {@link searchConfig} */
  imports?: ModuleMetadata['imports']
  /** the provider (class or token) implementing {@link SearchConfigSource} */
  searchConfig: InjectionToken
}

/**
 * The agent's built-in web tools: {@link SafeFetcher} (also for external MCP servers), {@link WebSearch}
 * and the `web.search` / `web.fetch` executors {@link WebTools}. `AgentWebModule.register({ imports,
 * searchConfig })` binds where the search provider's kind and key come from.
 */
@Module({})
export class AgentWebModule {
  static register(opts: AgentWebModuleOptions): DynamicModule {
    return {
      module: AgentWebModule,
      imports: opts.imports ?? [],
      providers: [
        { provide: SEARCH_CONFIG_SOURCE, useExisting: opts.searchConfig },
        {
          provide: SafeFetcher,
          // ALLOW_PRIVATE_ENDPOINTS（只用于测试与开发）放开地址检查，同其他出站目标
          useFactory: (cfg: AppConfigService) =>
            new SafeFetcher({ allowPrivate: cfg.get('ALLOW_PRIVATE_ENDPOINTS') }),
          inject: [AppConfigService],
        },
        {
          provide: WebSearch,
          useFactory: (source: SearchConfigSource) => new WebSearch(source),
          inject: [SEARCH_CONFIG_SOURCE],
        },
        {
          provide: WebTools,
          useFactory: (fetcher: SafeFetcher, search: WebSearch) => new WebTools(fetcher, search),
          inject: [SafeFetcher, WebSearch],
        },
      ],
      exports: [SafeFetcher, WebSearch, WebTools],
    }
  }
}
