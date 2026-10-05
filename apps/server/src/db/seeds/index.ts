import type { DataSource, EntityManager } from 'typeorm'
import { softDeleteWhere } from '../../core/db/references.js'
import { seedLeave } from '../../modules/biz/leave/leave.seed.js'
import { seedBook } from '../../modules/demo/book/book.seed.js'
import { seedInvoice } from '../../modules/demo/invoice/invoice.seed.js'
import { seedDemoRealtime } from '../../modules/demo/realtime/realtime.seed.js'
import { seedTopic } from '../../modules/demo/topic/topic.seed.js'
import { seedActionLog } from '../../modules/platform/audit/action-log/action-log.seed.js'
import { seedHttpFault } from '../../modules/platform/audit/http-fault/http-fault.seed.js'
import { seedHttpTrace } from '../../modules/platform/audit/http-trace/http-trace.seed.js'
import { seedSigninLog } from '../../modules/platform/audit/signin-log/signin-log.seed.js'
import { seedDept } from '../../modules/platform/iam/dept/dept.seed.js'
import { seedGeo } from '../../modules/platform/geo/geo.seed.js'
import { seedMenu } from '../../modules/platform/iam/menu/menu.seed.js'
import { seedPosition } from '../../modules/platform/iam/position/position.seed.js'
import { seedRole } from '../../modules/platform/iam/role/role.seed.js'
import { seedSession } from '../../modules/platform/iam/session/session.seed.js'
import { seedUser } from '../../modules/platform/iam/user/user.seed.js'
import { seedBulletin } from '../../modules/platform/messaging/bulletin/bulletin.seed.js'
import { seedInbox } from '../../modules/platform/messaging/inbox/inbox.seed.js'
import { seedInboxTemplate } from '../../modules/platform/messaging/inbox-template/inbox-template.seed.js'
import { seedMailAccount } from '../../modules/platform/messaging/mail-account/mail-account.seed.js'
import { seedMailTemplate } from '../../modules/platform/messaging/mail-template/mail-template.seed.js'
import { seedMailRecord } from '../../modules/platform/messaging/mail-record/mail-record.seed.js'
import { seedSmsChannel } from '../../modules/platform/messaging/sms-channel/sms-channel.seed.js'
import { seedSmsTemplate } from '../../modules/platform/messaging/sms-template/sms-template.seed.js'
import { seedSmsRecord } from '../../modules/platform/messaging/sms-record/sms-record.seed.js'
import { seedDictEntry } from '../../modules/platform/settings/dict-entry/dict-entry.seed.js'
import { seedDict } from '../../modules/platform/settings/dict/dict.seed.js'
import { seedMonitor } from '../../modules/platform/monitor/monitor.seed.js'
import { seedClient } from '../../modules/platform/oauth/client/client.seed.js'
import { seedRun } from '../../modules/platform/scheduler/run/run.seed.js'
import { seedTask } from '../../modules/platform/scheduler/task/task.seed.js'
import { seedParameter } from '../../modules/platform/settings/param/param.seed.js'
import { seedAppVersion } from '../../modules/platform/settings/app-version/app-version.seed.js'
import { seedStorageConfig } from '../../modules/platform/storage/config/config.seed.js'
import { seedStorageObject } from '../../modules/platform/storage/object.seed.js'
import { seedAudit } from './audit/audit.seed.js'
import { seedCodegen } from './codegen/codegen.seed.js'
import { seedDemo } from './demo/demo.seed.js'
import { seedIam } from './iam/iam.seed.js'
import { seedMessaging } from './messaging/messaging.seed.js'
import { seedDelivery } from './messaging/delivery.seed.js'
import { seedMonitorGroup } from './monitor/monitor.seed.js'
import { seedOauth } from './oauth/oauth.seed.js'
import { seedProjectActionVerbs } from './project/action-verbs.seed.js'
import { seedProjectMenuGroups } from './project/menu-groups.seed.js'
import { seedScheduler } from './scheduler/scheduler.seed.js'
import { seedSettings } from './settings/settings.seed.js'
import { seedStorage } from './storage/storage.seed.js'
import { seedWorkflowMenus } from './workflow/menu.seed.js'
import { seedProcessTemplates } from './workflow/process-templates.seed.js'
import { seedWorkflowTemplates } from './workflow/templates.seed.js'
import { seedWorkflow } from './workflow/workflow.seed.js'

type Seed = (q: EntityManager) => Promise<string[]>

/** Domain seeds in run order (each module seeds only its own rows and menus). */
const SEEDS: Record<string, Seed[]> = {
  iam: [seedIam, seedUser, seedRole, seedMenu, seedDept, seedPosition],
  settings: [seedSettings, seedDict, seedDictEntry, seedParameter, seedAppVersion],
  // its page sits in the system group
  geo: [seedGeo],
  messaging: [
    seedMessaging,
    seedDelivery,
    seedBulletin,
    seedInboxTemplate,
    seedInbox,
    seedMailAccount,
    seedMailTemplate,
    seedMailRecord,
    seedSmsChannel,
    seedSmsTemplate,
    seedSmsRecord,
  ],
  audit: [seedAudit, seedActionLog, seedSigninLog, seedHttpTrace, seedHttpFault],
  storage: [seedStorage, seedStorageObject, seedStorageConfig],
  monitor: [seedMonitorGroup, seedSession, seedMonitor],
  // the built-in console client and the consent param; the client pages hang under system
  oauth: [seedOauth, seedClient],
  scheduler: [seedScheduler, seedTask, seedRun],
  // before demo: its menu group holds the demo group
  codegen: [seedCodegen],
  demo: [seedDemo, seedBook, seedTopic, seedInvoice, seedDemoRealtime],
  // approval processes and their OA leave sample; the staff role with its menus; the wf notification
  // templates; the leave process with its demo users (they hold role staff); the built-in process templates
  workflow: [
    seedWorkflow,
    seedWorkflowMenus,
    seedWorkflowTemplates,
    seedLeave,
    seedProcessTemplates,
  ],
  // last: the project's generated modules (the samples stay in demo, the leave sample with
  // its workflow), after the project menu groups they hang under and the project's action
  // verbs
  project: [seedProjectMenuGroups, seedProjectActionVerbs],
}

/** Menu groups of the layout before the regroup (系统管理 / 系统监控 / 系统工具) and where their pages went. */
const OBSOLETE_GROUPS: Record<string, string> = {
  iam: 'system',
  settings: 'system',
  scheduler: 'monitor',
}

/**
 * Existing databases: once the domain seeds have moved their pages, an obsolete group without live
 * children is soft-deleted with its role grants. One that still has children (an --only run that
 * skipped its pages, or an admin's own page) stays. Stored generator configs naming it as parent follow
 * its pages. Nothing to do on a fresh database; safe to repeat.
 */
async function dropObsoleteGroups(q: EntityManager): Promise<void> {
  for (const [route, target] of Object.entries(OBSOLETE_GROUPS)) {
    await q.query(
      'UPDATE cg_table SET parent_menu_route_name = ? WHERE parent_menu_route_name = ? AND deleted_at IS NULL',
      [target, route],
    )
    const [group] = await q.query(
      `SELECT g.id FROM iam_menu g
        WHERE g.route_name = ? AND g.kind = 'group' AND g.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM iam_menu c WHERE c.parent_id = g.id AND c.deleted_at IS NULL)`,
      [route],
    )
    if (!group) continue
    await softDeleteWhere(q, 'iam_role_menus', 'menu_id', [group.id])
    await softDeleteWhere(q, 'iam_menu', 'id', [group.id])
  }
}

/**
 * Runs the seeds (all, or the `only` domains) in one transaction. Returns one-time notices for the
 * operator, e.g. a generated admin password; the CLI prints them.
 */
export async function runSeeds(ds: DataSource, only?: string[]): Promise<string[]> {
  const unknown = only?.filter((d) => !Object.hasOwn(SEEDS, d)) ?? []
  if (unknown.length)
    throw new Error(`unknown seed domain(s): ${unknown} (known: ${Object.keys(SEEDS)})`)
  const notices: string[] = []
  await ds.transaction(async (q) => {
    for (const [domain, seeds] of Object.entries(SEEDS))
      if (!only || only.includes(domain)) for (const seed of seeds) notices.push(...(await seed(q)))
    await dropObsoleteGroups(q)
  })
  return notices
}
