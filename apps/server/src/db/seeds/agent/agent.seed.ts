// In-app agent seed (see docs/agent.md): the top-level 智能体 menu group with its hidden chat route,
// 技能管理, 智能体设置 (a platform page, PLATFORM_ONLY_ROUTES), 智能体用量 and 自动化, one action row per
// permission, plus the hidden batch review page under the chat page. Seeded whatever APP_AGENT says: while it is off the group (and so its pages) is hidden by
// core/auth/menu-features.ts (side menu and grant trees). Root sees every menu; other roles get the pages
// granted in 角色管理, tenants through their package. The agent's params (stop switch, limits) are settings
// params (db/seeds/settings). Names are i18n keys (menu.json in the web locales).
import { agentAutomationPerms, agentPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { upsertTemplates } from '../messaging/templates.js'
import { findRow, upsert } from '../upsert.js'

interface PageSeed {
  /** `agent-<page>`; the view is `platform/agent/<page>/index` */
  page: string
  path: string
  componentName: string
  icon: string
  actions: [perms: string, name: string][]
}

const { chat, batch, skill, instruction, setting, usage, restriction } = agentPerms

const PAGES: PageSeed[] = [
  {
    page: 'chat',
    path: '/agent/chat',
    componentName: 'AgentChat',
    icon: 'lucide:bot-message-square',
    actions: [[chat.use, 'menu.action.use']],
  },
  {
    page: 'skill',
    path: '/agent/skills',
    componentName: 'AgentSkill',
    icon: 'lucide:book-open-check',
    actions: [
      [skill.browse, 'menu.action.browse'],
      [skill.create, 'menu.action.create'],
      [skill.modify, 'menu.action.modify'],
      [skill.remove, 'menu.action.remove'],
      [instruction.modify, 'menu.action.instructionModify'],
      [restriction.browse, 'menu.action.restrictionBrowse'],
      [restriction.modify, 'menu.action.restrictionModify'],
    ],
  },
  {
    page: 'setting',
    path: '/agent/settings',
    componentName: 'AgentSetting',
    icon: 'lucide:sliders-horizontal',
    actions: [
      [setting.browse, 'menu.action.browse'],
      [setting.modify, 'menu.action.modify'],
    ],
  },
  {
    page: 'usage',
    path: '/agent/usage',
    componentName: 'AgentUsage',
    icon: 'lucide:chart-column',
    actions: [[usage.browse, 'menu.action.browse']],
  },
  {
    page: 'automation',
    path: '/agent/automations',
    componentName: 'AgentAutomation',
    icon: 'lucide:alarm-clock-check',
    actions: [
      [agentAutomationPerms.use, 'menu.action.use'],
      [agentAutomationPerms.share, 'menu.action.share'],
    ],
  },
]

export async function seedAgent(q: EntityManager): Promise<string[]> {
  // 管理入口紧跟首页；业务对话由页面右侧悬浮入口打开。
  const groupId = await upsert(
    q,
    'iam_menu',
    { route_name: 'agent' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.agent.title',
      route_path: '/agent',
      icon: 'lucide:sparkles',
      sort_no: 3,
    },
  )
  let chatId = 0
  for (const [i, p] of PAGES.entries()) {
    const pageId = await upsert(
      q,
      'iam_menu',
      { route_name: `agent-${p.page}` },
      {
        parent_id: groupId,
        kind: 'page',
        name: `menu.agent.${p.page}`,
        route_path: p.path,
        component: `platform/agent/${p.page}/index`,
        component_name: p.componentName,
        keep_alive: 1,
        // 保留授权、通知与分享的旧链接；聊天本身从悬浮入口打开，不占侧栏菜单。
        ...(p.page === 'chat' ? { visible: 0 } : {}),
        icon: p.icon,
        sort_no: (i + 1) * 10,
      },
    )
    for (const [j, [perms, name]] of p.actions.entries()) {
      const fresh = !(await findRow(q, 'iam_menu', { kind: 'action', perms }))
      const actionId = await upsert(
        q,
        'iam_menu',
        { kind: 'action', perms },
        { parent_id: pageId, name, sort_no: (j + 1) * 10 },
      )
      // 套餐按菜单 id 保存：新版本第一次建出的动作行补进已经含有这一页的套餐（只在新建时补一次，之后 root
      // 从套餐里去掉的不会被再次加回）
      if (fresh)
        await q.query(
          `INSERT IGNORE INTO iam_tenant_package_menus (package_id, menu_id)
            SELECT package_id, ? FROM iam_tenant_package_menus WHERE menu_id = ? AND deleted_at IS NULL`,
          [actionId, pageId],
        )
    }
    if (p.page === 'chat') chatId = pageId
  }
  // 批次审批页（visible 0，从示例客户列表的“让智能体补齐”打开，`?id=<批次>`）：批量执行的权限挂在它下面，
  // 授予该权限即带出这条路由
  const batchId = await upsert(
    q,
    'iam_menu',
    { route_name: 'agent-batch' },
    {
      parent_id: chatId,
      kind: 'page',
      name: 'menu.agent.batch',
      route_path: '/agent/batch',
      component: 'platform/agent/batch/index',
      component_name: 'AgentBatch',
      visible: 0,
      keep_alive: 0,
      icon: 'lucide:list-checks',
      sort_no: 90,
    },
  )
  await upsert(
    q,
    'iam_menu',
    { kind: 'action', perms: batch.run },
    { parent_id: batchId, name: 'menu.action.batchRun', sort_no: 10 },
  )
  // 站内提醒：一轮停下等确认或回答，以及耗时较长的一轮完成（runtime/turn-runner.ts 的 AGENT_NOTICE）。
  // 提醒不带会话标题（标题由模型或本人的话生成，可能含业务内容，邮件会离开本系统），只给通用文字与对话页的路由
  const inbox = {
    category: 'business',
    sender_label: null,
    enabled: 1,
    param_names: ['threadId'],
  }
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'agent.turn.waiting',
    {
      'zh-CN': {
        title: '智能助手在等你',
        body: '智能助手的一个会话需要你确认操作或回答问题，打开这个会话继续：/agent/chat?thread={threadId}',
      },
      'en-US': {
        title: 'The assistant is waiting for you',
        body: 'A conversation with the assistant needs you to confirm an action or answer a question. Open it to continue: /agent/chat?thread={threadId}',
      },
    },
    { ...inbox, name: 'seed.agentTemplate.turnWaiting' },
  )
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'agent.turn.completed',
    {
      'zh-CN': {
        title: '智能助手已完成任务',
        body: '智能助手的一个会话里的任务已完成，打开这个会话查看结果：/agent/chat?thread={threadId}',
      },
      'en-US': {
        title: 'The assistant finished a task',
        body: 'A task in a conversation with the assistant is done. Open it to see the result: /agent/chat?thread={threadId}',
      },
    },
    { ...inbox, name: 'seed.agentTemplate.turnCompleted' },
  )
  // 同样两类提醒的邮件：本人在通知设置里打开邮件时才发（core/agent/runtime/notify-settings.ts）
  const mail = {
    account_id: null,
    sender_label: null,
    enabled: 1,
    param_names: ['threadId'],
  }
  await upsertTemplates(
    q,
    'msg_mail_template',
    'agent.turn.waiting',
    {
      'zh-CN': {
        subject: '智能助手在等你',
        body: '<p>智能助手的一个会话需要你确认操作或回答问题。</p><p>请登录系统，打开这个会话继续：/agent/chat?thread={threadId}</p>',
      },
      'en-US': {
        subject: 'The assistant is waiting for you',
        body: '<p>A conversation with the assistant needs you to confirm an action or answer a question.</p><p>Sign in and open it to continue: /agent/chat?thread={threadId}</p>',
      },
    },
    { ...mail, name: 'seed.agentTemplate.turnWaiting' },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'agent.turn.completed',
    {
      'zh-CN': {
        subject: '智能助手已完成任务',
        body: '<p>智能助手的一个会话里的任务已完成。</p><p>请登录系统，打开这个会话查看结果：/agent/chat?thread={threadId}</p>',
      },
      'en-US': {
        subject: 'The assistant finished a task',
        body: '<p>A task in a conversation with the assistant is done.</p><p>Sign in and open it to see the result: /agent/chat?thread={threadId}</p>',
      },
    },
    { ...mail, name: 'seed.agentTemplate.turnCompleted' },
  )
  // 自动化的结果提醒（core/agent/automation/automation-runner.ts 的 AUTOMATION_NOTICE）：站内信按自动化的通知方式，
  // 邮件在自动化或本人的通知设置开了邮件时才发；只带自动化名称（本人起的名字），不带回答内容
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'agent.automation.result',
    {
      'zh-CN': {
        title: '自动化已运行：{title}',
        body: '自动化「{title}」运行结束，打开“自动化”页的运行历史查看结果。',
      },
      'en-US': {
        title: 'Automation ran: {title}',
        body: 'The automation "{title}" has finished. Open its run history on the Automations page to see the result.',
      },
    },
    { ...inbox, param_names: ['title', 'threadId'], name: 'seed.agentTemplate.automationResult' },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'agent.automation.result',
    {
      'zh-CN': {
        subject: '自动化已运行：{title}',
        body: '<p>自动化「{title}」运行结束。</p><p>请登录系统，在“自动化”页的运行历史里查看结果。</p>',
      },
      'en-US': {
        subject: 'Automation ran: {title}',
        body: '<p>The automation "{title}" has finished.</p><p>Sign in and open its run history on the Automations page to see the result.</p>',
      },
    },
    { ...mail, param_names: ['title', 'threadId'], name: 'seed.agentTemplate.automationResult' },
  )
  // 创建人不能再运行它（被停用、删除或失去权限）时自动停用，告诉创建人（只发站内信）
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'agent.automation.stopped',
    {
      'zh-CN': {
        title: '自动化已停用：{title}',
        body: '自动化「{title}」的创建人现在不能运行它（账号被停用或缺少权限），它已被停用。恢复权限后可在“自动化”页重新启用。',
      },
      'en-US': {
        title: 'Automation switched off: {title}',
        body: 'The owner of the automation "{title}" can no longer run it (the account is disabled or lacks permissions), so it was switched off. Once the permissions are back it can be switched on again on the Automations page.',
      },
    },
    { ...inbox, param_names: ['title'], name: 'seed.agentTemplate.automationStopped' },
  )
  return []
}
