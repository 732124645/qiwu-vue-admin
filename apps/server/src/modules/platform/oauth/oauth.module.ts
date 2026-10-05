import { Module } from '@nestjs/common'
import { ClientModule } from './client/client.module.js'
import { ProviderModule } from './provider/provider.module.js'

/** OAuth2 (see docs/design-notes.md#auth-sessions): the provider (`/api/oauth2/*`) and the client pages join here. */
@Module({ imports: [ClientModule, ProviderModule] })
export class OauthModule {}
