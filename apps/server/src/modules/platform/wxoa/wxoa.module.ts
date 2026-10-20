import { Module, type OnModuleInit } from '@nestjs/common'
import { WXOA_MEDIA_TAG, wxoaPerms } from '@qiwu/shared'
import { StorageAccess } from '../storage/storage-access.js'
import { StorageModule } from '../storage/storage.module.js'
import { WxoaAccountModule } from './account/account.module.js'
import { WxoaCallbackModule } from './callback/callback.module.js'
import { WxoaCoreModule } from './core/wxoa-core.module.js'
import { WxoaFanModule } from './fan/fan.module.js'
import { WxoaMaterialModule } from './material/material.module.js'
import { WxoaMenuModule } from './menu/menu.module.js'
import { WxoaMessageModule } from './message/message.module.js'
import { WxoaQrcodeModule } from './qrcode/qrcode.module.js'
import { WxoaReplyModule } from './reply/reply.module.js'
import { WxoaTemplateModule } from './template/template.module.js'
import { WxoaDraftModule } from './draft/draft.module.js'
import { WxoaPublishModule } from './publish/publish.module.js'
import { WxoaMassModule } from './mass/mass.module.js'
import { WxoaStatModule } from './stat/stat.module.js'
import { WxoaCommentModule } from './comment/comment.module.js'
import { WxoaNoticeModule } from './notice/notice.module.js'

/** Any one of these reads an account's media copies (inbound media, materials, QR code images). */
const MEDIA_READERS: readonly string[] = [
  wxoaPerms.message.browse,
  wxoaPerms.material.browse,
  wxoaPerms.qrcode.browse,
]
const MEDIA_REF = /^wxoa:\d+$/

/**
 * WeChat Official Account management (see docs/design-notes.md#wxoa): shared parts in `core/`, one
 * submodule per feature. Media copies are private `wxoa.media` objects (`biz_ref = wxoa:<accountId>`)
 * written only through StorageService's internal entry; besides their uploader and
 * `storage.object.view`, holders of a wxoa browse permission over messages, materials or QR codes
 * download them.
 */
@Module({
  imports: [
    StorageModule,
    WxoaCoreModule,
    WxoaAccountModule,
    WxoaCallbackModule,
    WxoaMessageModule,
    WxoaReplyModule,
    WxoaMenuModule,
    WxoaFanModule,
    WxoaMaterialModule,
    WxoaTemplateModule,
    WxoaQrcodeModule,
    WxoaDraftModule,
    WxoaPublishModule,
    WxoaMassModule,
    WxoaStatModule,
    WxoaCommentModule,
    WxoaNoticeModule,
  ],
})
export class WxoaModule implements OnModuleInit {
  constructor(private readonly access: StorageAccess) {}

  onModuleInit(): void {
    this.access.register(
      WXOA_MEDIA_TAG,
      async (obj, p) =>
        MEDIA_REF.test(obj.bizRef ?? '') && MEDIA_READERS.some((perm) => p.perms.includes(perm)),
    )
  }
}
