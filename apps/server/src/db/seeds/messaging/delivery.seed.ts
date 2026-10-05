import type { EntityManager } from 'typeorm'
import { upsertDicts } from '../settings/settings.seed.js'
import { upsert } from '../upsert.js'
import { upsertTemplates } from './templates.js'

/** Delivery settings shared by mail and later SMS modules. */
export async function seedDelivery(q: EntityManager): Promise<string[]> {
  await upsertDicts(q, [
    {
      code: 'messaging.mail_security',
      nameI18n: { 'zh-CN': '邮件连接安全', 'en-US': 'Mail connection security' },
      entries: [
        { value: 'ssl', labelI18n: { 'zh-CN': 'SSL', 'en-US': 'SSL' } },
        {
          value: 'starttls',
          labelI18n: { 'zh-CN': 'STARTTLS', 'en-US': 'STARTTLS' },
          isDefault: true,
        },
        { value: 'none', labelI18n: { 'zh-CN': '无加密', 'en-US': 'No encryption' } },
      ],
    },
    {
      code: 'messaging.mail_record_status',
      nameI18n: { 'zh-CN': '邮件发送状态', 'en-US': 'Mail delivery status' },
      entries: [
        { value: 'pending', labelI18n: { 'zh-CN': '待发送', 'en-US': 'Pending' }, tagType: 'info' },
        {
          value: 'sending',
          labelI18n: { 'zh-CN': '发送中', 'en-US': 'Sending' },
          tagType: 'warning',
        },
        { value: 'sent', labelI18n: { 'zh-CN': '已发送', 'en-US': 'Sent' }, tagType: 'success' },
        {
          value: 'failed',
          labelI18n: { 'zh-CN': '发送失败', 'en-US': 'Failed' },
          tagType: 'danger',
        },
        { value: 'skipped', labelI18n: { 'zh-CN': '已跳过', 'en-US': 'Skipped' }, tagType: 'info' },
      ],
    },
    {
      code: 'messaging.sms_driver',
      nameI18n: { 'zh-CN': '短信渠道驱动', 'en-US': 'SMS provider' },
      entries: [
        { value: 'aliyun', labelI18n: { 'zh-CN': '阿里云', 'en-US': 'Alibaba Cloud' } },
        { value: 'tencent', labelI18n: { 'zh-CN': '腾讯云', 'en-US': 'Tencent Cloud' } },
        { value: 'debug', labelI18n: { 'zh-CN': '调试（写日志）', 'en-US': 'Debug (log only)' } },
      ],
    },
    {
      code: 'messaging.sms_purpose',
      nameI18n: { 'zh-CN': '短信用途', 'en-US': 'SMS purpose' },
      entries: [
        { value: 'otp', labelI18n: { 'zh-CN': '验证码', 'en-US': 'Verification code' } },
        { value: 'notice', labelI18n: { 'zh-CN': '通知', 'en-US': 'Notice' } },
        { value: 'promo', labelI18n: { 'zh-CN': '推广', 'en-US': 'Promotion' } },
      ],
    },
    {
      code: 'messaging.sms_record_status',
      nameI18n: { 'zh-CN': '短信发送状态', 'en-US': 'SMS delivery status' },
      entries: [
        { value: 'pending', labelI18n: { 'zh-CN': '待发送', 'en-US': 'Pending' }, tagType: 'info' },
        {
          value: 'sending',
          labelI18n: { 'zh-CN': '发送中', 'en-US': 'Sending' },
          tagType: 'warning',
        },
        { value: 'sent', labelI18n: { 'zh-CN': '已发送', 'en-US': 'Sent' }, tagType: 'success' },
        {
          value: 'failed',
          labelI18n: { 'zh-CN': '发送失败', 'en-US': 'Failed' },
          tagType: 'danger',
        },
        { value: 'skipped', labelI18n: { 'zh-CN': '已跳过', 'en-US': 'Skipped' }, tagType: 'info' },
      ],
    },
    {
      code: 'messaging.sms_receipt_status',
      nameI18n: { 'zh-CN': '短信回执状态', 'en-US': 'SMS receipt status' },
      entries: [
        {
          value: 'delivered',
          labelI18n: { 'zh-CN': '已送达', 'en-US': 'Delivered' },
          tagType: 'success',
        },
        {
          value: 'failed',
          labelI18n: { 'zh-CN': '送达失败', 'en-US': 'Not delivered' },
          tagType: 'danger',
        },
      ],
    },
  ])
  const limits = [
    {
      key: 'sms.otp.cooldown_sec',
      value: '60',
      nameI18n: { 'zh-CN': '发送冷却时间（秒）', 'en-US': 'OTP cooldown (seconds)' },
    },
    {
      key: 'sms.otp.mobile_daily_max',
      value: '10',
      nameI18n: { 'zh-CN': '单手机号每日发送上限', 'en-US': 'Daily OTP cap per mobile' },
    },
    {
      key: 'sms.otp.ip_daily_max',
      value: '20',
      nameI18n: { 'zh-CN': '单 IP 每日发送上限', 'en-US': 'Daily OTP cap per IP' },
    },
    {
      key: 'sms.otp.user_daily_max',
      value: '5',
      nameI18n: {
        'zh-CN': '单用户每日绑定验证码上限',
        'en-US': 'Daily bind-code cap per user',
      },
    },
    {
      key: 'sms.otp.global_daily_max',
      value: '1000',
      nameI18n: { 'zh-CN': '全站每日发送上限', 'en-US': 'Global daily OTP cap' },
    },
  ] as const
  for (const p of limits)
    await upsert(
      q,
      'cfg_param',
      { param_key: p.key },
      {
        name: p.nameI18n['zh-CN'],
        name_i18n: p.nameI18n,
        group_code: 'sms',
        is_builtin: 1,
        is_public: 0,
      },
      { param_value: p.value },
    )
  await upsertTemplates(
    q,
    'msg_sms_template',
    'auth.sms_code',
    {
      'zh-CN': { body: '您的验证码为 {code}，5 分钟内有效。' },
      'en-US': { body: 'Your verification code is {code}. It expires in 5 minutes.' },
    },
    { name: 'seed.smsTemplate.authCode', purpose: 'otp', param_names: ['code'] },
  )
  return []
}
