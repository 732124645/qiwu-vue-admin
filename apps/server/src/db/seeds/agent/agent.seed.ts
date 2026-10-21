// In-app agent seed (see docs/agent.md): the top-level 智能体 menu group with its pages 智能助手 (chat),
// 技能管理, 智能体设置 (a platform page, PLATFORM_ONLY_ROUTES) and 智能体用量, one action row per
// permission, plus the hidden batch review page under the chat page. Seeded whatever APP_AGENT says: while it is off the group (and so its pages) is hidden by
// core/auth/menu-features.ts (side menu and grant trees). Root sees every menu; other roles get the pages
// granted in 角色管理, tenants through their package. The agent's params (stop switch, limits) are settings
// params (db/seeds/settings). Names are i18n keys (menu.json in the web locales).
import { agentPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { upsertTemplates } from '../messaging/templates.js'
import { upsert } from '../upsert.js'

interface PageSeed {
  /** `agent-<page>`; the view is `platform/agent/<page>/index` */
  page: string
  path: string
  componentName: string
  icon: string
  actions: [perms: string, name: string][]
}

const { chat, batch, skill, instruction, setting, usage } = agentPerms

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
]

export async function seedAgent(q: EntityManager): Promise<string[]> {
  // top level, right after 首页: the chat page is the one most users open
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
  // 站内提醒：一轮停下等确认或回答，以及耗时较长的一轮完成（runtime/turn-runner.ts 的 AGENT_NOTICE）
  const inbox = {
    category: 'business',
    sender_label: null,
    enabled: 1,
    param_names: ['title', 'threadId'],
  }
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'agent.turn.waiting',
    {
      'zh-CN': {
        title: '智能助手在等你：{title}',
        body: '会话「{title}」需要你确认操作或回答问题，打开智能助手继续。',
      },
      'en-US': {
        title: 'The assistant is waiting: {title}',
        body: 'The chat "{title}" needs you to confirm an action or answer a question. Open the assistant to continue.',
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
        title: '智能助手已完成：{title}',
        body: '会话「{title}」的任务已完成，打开智能助手查看结果。',
      },
      'en-US': {
        title: 'The assistant finished: {title}',
        body: 'The task in the chat "{title}" is done. Open the assistant to see the result.',
      },
    },
    { ...inbox, name: 'seed.agentTemplate.turnCompleted' },
  )
  return []
}
