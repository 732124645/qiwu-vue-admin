import { Module } from '@nestjs/common'
import { referencedBy } from '../../../../core/db/references.js'
import { IamModule } from '../../iam/iam.module.js'
import { ProviderController } from './provider.controller.js'
import { OAuthProvider } from './provider.service.js'

// a user's or a client's remembered consents go with it (`oauth_consent.client_id` is
// `oauth_client.id`, so a client registered again under a deleted one's client_id inherits none)
referencedBy('iam_user', { table: 'oauth_consent', column: 'user_id', cascade: true })
referencedBy('oauth_client', { table: 'oauth_consent', column: 'client_id', cascade: true })

/**
 * OAuth2 provider: `/api/oauth2/*`. TokenService, SessionRevoker, PermVersion, ParamService are
 * global; iam provides `USER_LOOKUP` (userinfo).
 */
@Module({ imports: [IamModule], controllers: [ProviderController], providers: [OAuthProvider] })
export class ProviderModule {}
