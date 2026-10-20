// WeChat Official Account seed (see docs/design-notes.md#wxoa): the 公众号 menu group with its nine
// pages and one action per permission, the wxoa dicts, the two params and the two built-in tasks
// (message purge, nightly fan sync: off until switched on). Pages by route_name, actions by perms, dicts
// by code, params by key, tasks by handler + name; what admins own after the first seed (param values,
// task schedules and switches) is written on insert only. Names are i18n keys (menu.json in the web
// locales, seed.task.* in the shared seed.json).
import { WXOA_RETENTION_DAYS_DEFAULT, wxoaParams, wxoaPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { type DictSeed, upsertDicts } from '../settings/settings.seed.js'
import { upsert } from '../upsert.js'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })
const entries = (...list: [value: string, zh: string, en: string, tagType?: string][]) =>
  list.map(([value, zh, en, tagType]) => ({ value, labelI18n: both(zh, en), tagType }))

const DICTS: DictSeed[] = [
  {
    code: 'wxoa.account_kind',
    nameI18n: both('公众号类型', 'Account kind'),
    entries: entries(
      ['service', '服务号', 'Service account', 'primary'],
      ['subscription', '公众号（原订阅号）', 'Subscription account', 'success'],
      ['sandbox', '测试号', 'Sandbox account', 'info'],
    ),
  },
  {
    code: 'wxoa.crypto_mode',
    nameI18n: both('消息加密方式', 'Message encryption'),
    entries: entries(
      ['plain', '明文模式', 'Plaintext', 'warning'],
      ['compat', '兼容模式', 'Compatible'],
      ['secure', '安全模式', 'Secure', 'success'],
    ),
  },
  {
    code: 'wxoa.channel',
    nameI18n: both('消息渠道', 'Message channel'),
    entries: entries(
      ['push', '推送', 'Push'],
      ['passive', '被动回复', 'Passive reply'],
      ['cs', '客服消息', 'Customer service message'],
      ['template', '模板消息', 'Template message'],
      ['preview', '预览', 'Preview'],
      ['notice', '订阅通知', 'Subscription notice'],
    ),
  },
  {
    code: 'wxoa.msg_kind',
    nameI18n: both('消息类型', 'Message kind'),
    entries: entries(
      ['text', '文本', 'Text'],
      ['image', '图片', 'Image'],
      ['voice', '语音', 'Voice'],
      ['video', '视频', 'Video'],
      ['shortvideo', '小视频', 'Short video'],
      ['location', '位置', 'Location'],
      ['link', '链接', 'Link'],
      ['event', '事件', 'Event'],
      ['music', '音乐', 'Music'],
      ['news', '图文', 'Article'],
      ['template', '模板消息', 'Template message'],
    ),
  },
  {
    code: 'wxoa.reply_trigger',
    nameI18n: both('回复触发方式', 'Reply trigger'),
    entries: entries(
      ['subscribe', '关注', 'Follow'],
      ['keyword', '关键词', 'Keyword'],
      ['default', '默认回复', 'Default reply'],
      ['click', '菜单点击', 'Menu click'],
      ['scan', '扫码', 'QR code scan'],
    ),
  },
  {
    code: 'wxoa.match_mode',
    nameI18n: both('关键词匹配方式', 'Keyword match'),
    entries: entries(['exact', '精确匹配', 'Exact'], ['contains', '包含', 'Contains']),
  },
  {
    code: 'wxoa.reply_kind',
    nameI18n: both('回复类型', 'Reply kind'),
    entries: entries(
      ['text', '文本', 'Text'],
      ['image', '图片', 'Image'],
      ['voice', '语音', 'Voice'],
      ['video', '视频', 'Video'],
      ['music', '音乐', 'Music'],
      ['news', '图文', 'Article'],
    ),
  },
  {
    code: 'wxoa.button_kind',
    nameI18n: both('菜单按钮类型', 'Menu button kind'),
    entries: entries(
      ['click', '点击推事件', 'Click event'],
      ['view', '跳转网页', 'Open a web page'],
      ['miniprogram', '打开小程序', 'Open a mini program'],
      ['scancode_push', '扫码推事件', 'Scan a code'],
      ['scancode_waitmsg', '扫码推事件并等待消息', 'Scan a code and wait for a message'],
      ['pic_sysphoto', '拍照发图', 'Take a photo'],
      ['pic_photo_or_album', '拍照或相册发图', 'Photo or album'],
      ['pic_weixin', '微信相册发图', 'WeChat album'],
      ['location_select', '发送位置', 'Send a location'],
      ['article_id', '发布的图文', 'Published article'],
      ['article_view_limited', '发布的图文（仅查看）', 'Published article (view only)'],
      ['media_id', '素材消息（已停用）', 'Material message (retired)', 'info'],
      ['view_limited', '图文链接（已停用）', 'Article link (retired)', 'info'],
    ),
  },
  {
    code: 'wxoa.client_platform',
    nameI18n: both('客户端平台', 'Client platform'),
    entries: entries(
      ['ios', 'iOS', 'iOS'],
      ['android', 'Android', 'Android'],
      ['other', '其他', 'Other'],
    ),
  },
  {
    code: 'wxoa.media_kind',
    nameI18n: both('素材类型', 'Material kind'),
    entries: entries(
      ['image', '图片', 'Image'],
      ['voice', '语音', 'Voice'],
      ['video', '视频', 'Video'],
      ['thumb', '缩略图', 'Thumbnail'],
    ),
  },
  {
    code: 'wxoa.qr_kind',
    nameI18n: both('二维码类型', 'QR code kind'),
    entries: entries(
      ['temporary', '临时二维码', 'Temporary', 'warning'],
      ['permanent', '永久二维码', 'Permanent', 'primary'],
    ),
  },
  {
    code: 'wxoa.publish_state',
    nameI18n: both('发表状态', 'Publish state'),
    entries: entries(
      ['publishing', '发表中', 'Publishing', 'info'],
      ['succeeded', '已发表', 'Published', 'success'],
      ['failed', '失败', 'Failed', 'danger'],
      ['removed', '已删除', 'Removed', 'warning'],
    ),
  },
  {
    code: 'wxoa.mass_target',
    nameI18n: both('群发对象', 'Mass target'),
    entries: entries(
      ['all', '全部粉丝', 'All fans'],
      ['tag', '标签粉丝', 'Fans by tag'],
      ['openids', '指定粉丝', 'Selected fans'],
    ),
  },
  {
    code: 'wxoa.mass_state',
    nameI18n: both('群发状态', 'Mass state'),
    entries: entries(
      ['submitted', '已提交', 'Submitted', 'info'],
      ['succeeded', '已完成', 'Succeeded', 'success'],
      ['failed', '失败', 'Failed', 'danger'],
      ['removed', '已删除', 'Removed', 'warning'],
    ),
  },
  {
    code: 'wxoa.send_state',
    nameI18n: both('发送状态', 'Send state'),
    entries: entries(
      ['pending', '待发送', 'Pending', 'info'],
      ['sent', '已发送', 'Sent', 'primary'],
      ['delivered', '已送达', 'Delivered', 'success'],
      ['failed', '发送失败', 'Failed', 'danger'],
      ['user_blocked', '用户拒收', 'Refused by the user', 'warning'],
    ),
  },
]

const PARAMS = [
  {
    key: wxoaParams.retentionDays,
    value: String(WXOA_RETENTION_DAYS_DEFAULT),
    nameI18n: both(
      '公众号消息记录保留天数（0 为永久）',
      'Official Account message log retention in days (0 = forever)',
    ),
  },
  {
    key: wxoaParams.copyInbound,
    value: 'true',
    nameI18n: both(
      '公众号收到的图片、语音和视频缩略图保存到本地',
      'Keep local copies of images, voice and video thumbnails sent to Official Accounts',
    ),
  },
]

const TASKS = [
  {
    // daily; like notify.dispatch off in unit/e2e test runs (specs invoke the handler themselves)
    name: 'seed.task.wxoaMessagePurge',
    handler: 'wxoa.message.purge',
    onInsert: {
      cron: '0 40 3 * * *',
      misfire: 'run_once',
      timeout_ms: 600_000,
      enabled: process.env.NODE_ENV === 'test' ? 0 : 1,
    },
  },
  {
    // nightly full sync of every account's fans: off until an administrator switches it on
    name: 'seed.task.wxoaFanSync',
    handler: 'wxoa.fan.sync',
    onInsert: { cron: '0 30 2 * * *', misfire: 'skip', timeout_ms: 3_600_000, enabled: 0 },
  },
]

interface PageSeed {
  /** `wxoa-<page>`; the view is `platform/wxoa/<page>/index` */
  page: string
  name: string
  path: string
  componentName: string
  icon: string
  actions: [perms: string, name: string][]
}

const {
  account,
  message,
  reply,
  menu,
  fan,
  tag,
  material,
  template,
  qrcode,
  draft,
  publish,
  comment,
  mass,
  stat,
  notice,
} = wxoaPerms

// a permission is one action row: the chat page holds sending, the message log page reading
const PAGES: PageSeed[] = [
  {
    page: 'account',
    name: 'menu.wxoa.account',
    path: '/wxoa/accounts',
    componentName: 'WxoaAccount',
    icon: 'lucide:user-cog',
    actions: [
      [account.browse, 'menu.action.browse'],
      [account.create, 'menu.action.create'],
      [account.modify, 'menu.action.modify'],
      [account.remove, 'menu.action.remove'],
      [account['clear-quota'], 'menu.action.clearQuota'],
    ],
  },
  {
    page: 'chat',
    name: 'menu.wxoa.chat',
    path: '/wxoa/chat',
    componentName: 'WxoaChat',
    icon: 'lucide:messages-square',
    actions: [[message.send, 'menu.action.send']],
  },
  {
    page: 'message',
    name: 'menu.wxoa.message',
    path: '/wxoa/messages',
    componentName: 'WxoaMessage',
    icon: 'lucide:message-square-text',
    actions: [[message.browse, 'menu.action.browse']],
  },
  {
    page: 'reply',
    name: 'menu.wxoa.reply',
    path: '/wxoa/reply-rules',
    componentName: 'WxoaReply',
    icon: 'lucide:reply',
    actions: [
      [reply.browse, 'menu.action.browse'],
      [reply.create, 'menu.action.create'],
      [reply.modify, 'menu.action.modify'],
      [reply.remove, 'menu.action.remove'],
    ],
  },
  {
    page: 'menu',
    name: 'menu.wxoa.menu',
    path: '/wxoa/menus',
    componentName: 'WxoaMenu',
    icon: 'lucide:square-menu',
    actions: [
      [menu.browse, 'menu.action.browse'],
      [menu.modify, 'menu.action.modify'],
      [menu.publish, 'menu.action.publish'],
    ],
  },
  {
    page: 'fan',
    name: 'menu.wxoa.fan',
    path: '/wxoa/fans',
    componentName: 'WxoaFan',
    icon: 'lucide:users',
    actions: [
      [fan.browse, 'menu.action.browse'],
      [fan.modify, 'menu.action.modify'],
      [fan.sync, 'menu.action.sync'],
      [fan.export, 'menu.action.export'],
      [tag.browse, 'menu.action.tagBrowse'],
      [tag.create, 'menu.action.tagCreate'],
      [tag.modify, 'menu.action.tagModify'],
      [tag.remove, 'menu.action.tagRemove'],
    ],
  },
  {
    page: 'material',
    name: 'menu.wxoa.material',
    path: '/wxoa/materials',
    componentName: 'WxoaMaterial',
    icon: 'lucide:images',
    actions: [
      [material.browse, 'menu.action.browse'],
      [material.create, 'menu.action.create'],
      [material.remove, 'menu.action.remove'],
      [material.sync, 'menu.action.sync'],
    ],
  },
  {
    page: 'template',
    name: 'menu.wxoa.template',
    path: '/wxoa/templates',
    componentName: 'WxoaTemplate',
    icon: 'lucide:file-text',
    actions: [
      [template.browse, 'menu.action.browse'],
      [template.remove, 'menu.action.remove'],
      [template.send, 'menu.action.send'],
    ],
  },
  {
    page: 'qrcode',
    name: 'menu.wxoa.qrcode',
    path: '/wxoa/qrcodes',
    componentName: 'WxoaQrcode',
    icon: 'lucide:qr-code',
    actions: [
      [qrcode.browse, 'menu.action.browse'],
      [qrcode.create, 'menu.action.create'],
      [qrcode.modify, 'menu.action.modify'],
      [qrcode.remove, 'menu.action.remove'],
    ],
  },
  {
    page: 'draft',
    name: 'menu.wxoa.draft',
    path: '/wxoa/drafts',
    componentName: 'WxoaDraft',
    icon: 'lucide:file-pen-line',
    actions: [
      [draft.browse, 'menu.action.browse'],
      [draft.create, 'menu.action.create'],
      [draft.modify, 'menu.action.modify'],
      [draft.remove, 'menu.action.remove'],
      [draft.sync, 'menu.action.sync'],
    ],
  },
  {
    page: 'publish',
    name: 'menu.wxoa.publish',
    path: '/wxoa/publishes',
    componentName: 'WxoaPublish',
    icon: 'lucide:send',
    actions: [
      [publish.browse, 'menu.action.browse'],
      [publish.create, 'menu.action.create'],
      [publish.remove, 'menu.action.remove'],
    ],
  },
  {
    page: 'mass',
    name: 'menu.wxoa.mass',
    path: '/wxoa/mass',
    componentName: 'WxoaMass',
    icon: 'lucide:megaphone',
    actions: [
      [mass.browse, 'menu.action.browse'],
      [mass.send, 'menu.action.send'],
      [mass.remove, 'menu.action.remove'],
      // 文章留言按群发返回的 msg_data_id 定位，在群发页打开
      [comment.browse, 'menu.action.commentBrowse'],
      [comment.modify, 'menu.action.modify'],
      [comment.send, 'menu.action.send'],
      [comment.remove, 'menu.action.remove'],
    ],
  },
  {
    page: 'stat',
    name: 'menu.wxoa.stat',
    path: '/wxoa/stats',
    componentName: 'WxoaStat',
    icon: 'lucide:chart-no-axes-combined',
    actions: [[stat.browse, 'menu.action.browse']],
  },
  {
    page: 'notice',
    name: 'menu.wxoa.notice',
    path: '/wxoa/notices',
    componentName: 'WxoaNotice',
    icon: 'lucide:bell-ring',
    actions: [
      [notice.browse, 'menu.action.browse'],
      [notice.modify, 'menu.action.modify'],
      [notice.send, 'menu.action.send'],
    ],
  },
]

export async function seedWxoa(q: EntityManager): Promise<string[]> {
  await upsertDicts(q, DICTS)
  for (const p of PARAMS)
    await upsert(
      q,
      'cfg_param',
      { param_key: p.key },
      {
        name: p.nameI18n['zh-CN'],
        name_i18n: p.nameI18n,
        group_code: 'wxoa',
        is_builtin: 1,
        is_public: 0,
      },
      { param_value: p.value },
    )
  for (const t of TASKS)
    await upsert(
      q,
      'job_task',
      { handler: t.handler, name: t.name },
      {},
      { group_code: 'system', ...t.onInsert },
    )
  // top level, between 流程审批 / 业务管理 and 系统管理
  const groupId = await upsert(
    q,
    'iam_menu',
    { route_name: 'wxoa' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.wxoa.title',
      route_path: '/wxoa',
      icon: 'lucide:message-circle',
      sort_no: 8,
    },
  )
  for (const [i, p] of PAGES.entries()) {
    const pageId = await upsert(
      q,
      'iam_menu',
      { route_name: `wxoa-${p.page}` },
      {
        parent_id: groupId,
        kind: 'page',
        name: p.name,
        route_path: p.path,
        component: `platform/wxoa/${p.page}/index`,
        component_name: p.componentName,
        keep_alive: 1,
        icon: p.icon,
        sort_no: (i + 1) * 10,
      },
    )
    for (const [j, [perms, name]] of p.actions.entries())
      await upsert(
        q,
        'iam_menu',
        { kind: 'action', perms },
        { parent_id: pageId, name, sort_no: (j + 1) * 10 },
      )
  }
  return []
}
