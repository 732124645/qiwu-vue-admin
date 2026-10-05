import { Module } from '@nestjs/common'
import { BulletinModule } from './bulletin/bulletin.module.js'
import { InboxModule } from './inbox/inbox.module.js'
import { InboxTemplateModule } from './inbox-template/inbox-template.module.js'
import { MailAccountModule } from './mail-account/mail-account.module.js'
import { MailTemplateModule } from './mail-template/mail-template.module.js'
import { MailRecordModule } from './mail-record/mail-record.module.js'
import { SmsChannelModule } from './sms-channel/sms-channel.module.js'
import { SmsTemplateModule } from './sms-template/sms-template.module.js'
import { SmsRecordModule } from './sms-record/sms-record.module.js'
import { SmsOtpModule } from './sms-otp/sms-otp.module.js'

/** Messages to users: bulletins, inbox, mail and SMS. */
@Module({
  imports: [
    BulletinModule,
    InboxTemplateModule,
    InboxModule,
    MailAccountModule,
    MailTemplateModule,
    MailRecordModule,
    SmsChannelModule,
    SmsTemplateModule,
    SmsRecordModule,
    SmsOtpModule,
  ],
})
export class MessagingModule {}
