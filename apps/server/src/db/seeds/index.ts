import type { DataSource, EntityManager } from 'typeorm'
import { allTenants, DEFAULT_TENANT_ID, withTenant } from '../../core/context/tenant.js'
import { softDeleteWhere } from '../../core/db/references.js'
import { seedLeave, seedTenantLeave } from '../../modules/biz/leave/leave.seed.js'
import { seedBook } from '../../modules/demo/book/book.seed.js'
import { seedCustomer } from '../../modules/demo/customer/customer.seed.js'
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
import { syncPlatformOnly } from '../../modules/platform/iam/menu/platform-only.js'
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
import { seedAgent } from './agent/agent.seed.js'
import { seedAudit } from './audit/audit.seed.js'
import { seedCodegen } from './codegen/codegen.seed.js'
import { seedCustomerSamples } from './demo/customer-sample.seed.js'
import { seedDemo } from './demo/demo.seed.js'
import { seedIam } from './iam/iam.seed.js'
import { seedTenant } from './iam/tenant.seed.js'
import { seedTenantDemo } from './iam/tenant-demo.seed.js'
import { seedTenantMenus } from './iam/tenant-menus.seed.js'
import { seedMcp } from './mcp/mcp.seed.js'
import { seedMessaging } from './messaging/messaging.seed.js'
import { seedDelivery } from './messaging/delivery.seed.js'
import { seedMonitorGroup } from './monitor/monitor.seed.js'
import { seedOauth } from './oauth/oauth.seed.js'
import { seedProjectActionVerbs } from './project/action-verbs.seed.js'
import { seedProjectMenuGroups } from './project/menu-groups.seed.js'
import { PROJECT_TENANT_SEEDS, type TenantSeed } from './project/tenant.seed.js'
import { seedScheduler } from './scheduler/scheduler.seed.js'
import { seedSettings } from './settings/settings.seed.js'
import { seedStorage } from './storage/storage.seed.js'
import { seedWorkflowMenus } from './workflow/menu.seed.js'
import { seedProcessTemplates } from './workflow/process-templates.seed.js'
import { seedWorkflowTemplates } from './workflow/templates.seed.js'
import { seedWorkflow } from './workflow/workflow.seed.js'
import { seedWxoa } from './wxoa/wxoa.seed.js'
import { seedWxoaDemo } from './wxoa/wxoa-demo.seed.js'

type Seed = (q: EntityManager) => Promise<string[]>

/** Domain seeds in run order (each module seeds only its own rows and menus). */
const SEEDS: Record<string, Seed[]> = {
  // the tenant management pages close the system group (whatever APP_MULTI_TENANT says)
  iam: [seedIam, seedUser, seedRole, seedMenu, seedDept, seedPosition, seedTenantMenus],
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
  wxoa: [seedWxoa, seedWxoaDemo],
  audit: [seedAudit, seedActionLog, seedSigninLog, seedHttpTrace, seedHttpFault],
  storage: [seedStorage, seedStorageObject, seedStorageConfig],
  monitor: [seedMonitorGroup, seedSession, seedMonitor],
  // the built-in console client and the consent param; the client pages hang under system
  oauth: [seedOauth, seedClient],
  // the MCP tool and access token pages hang under system too
  mcp: [seedMcp],
  // the in-app agent's top-level group with its pages
  agent: [seedAgent],
  scheduler: [seedScheduler, seedTask, seedRun],
  // before demo: its menu group holds the demo group
  codegen: [seedCodegen],
  demo: [
    seedDemo,
    seedBook,
    seedTopic,
    seedInvoice,
    seedCustomer,
    seedCustomerSamples,
    seedDemoRealtime,
  ],
  // approval processes and their OA leave sample; the staff role with its menus; the wf notification
  // templates; the leave process with its demo users (they hold role staff); the built-in process templates
  workflow: [
    seedWorkflow,
    seedWorkflowMenus,
    seedWorkflowTemplates,
    seedLeave,
    seedProcessTemplates,
  ],
  // the project's generated modules (the samples stay in demo, the leave sample with its
  // workflow), after the project menu groups they hang under and the project's action verbs
  project: [seedProjectMenuGroups, seedProjectActionVerbs],
  // last: the other tenants' own seeds (the project's need its menus and verbs)
  tenant: [seedTenants],
  // the demo site's sample tenants (APP_DEMO_MODE and APP_MULTI_TENANT both on), opened with their own seeds
  tenantDemo: [seedTenantDemo],
}

/**
 * The seeds of every tenant but the default one (see docs/design-notes.md#tenancy), in order: its root dept
 * and builtin `tenant_admin` role, the process templates, its leave model, then the project's
 * (`PROJECT_TENANT_SEEDS`). Run when a tenant is opened and for every existing tenant by SEEDS.tenant; never
 * for the default tenant, whose people and demo data the seeds above own. Each is insert-only and revives
 * nothing the tenant deleted.
 */
export const TENANT_SEEDS: readonly TenantSeed[] = [
  seedTenant,
  seedProcessTemplates,
  seedTenantLeave,
  ...PROJECT_TENANT_SEEDS,
]

/** Runs TENANT_SEEDS in tenant `tid` (not the default tenant) on `q`; returns their notices. */
export async function runTenantSeeds(q: EntityManager, tid: number): Promise<string[]> {
  if (tid === DEFAULT_TENANT_ID) throw new Error('runTenantSeeds: not for the default tenant')
  const notices: string[] = []
  // qw:cross-tenant a tenant's own seeds run in it
  await withTenant(tid, async () => {
    for (const seed of TENANT_SEEDS) notices.push(...(await seed(q, tid)))
  })
  return notices
}

/**
 * SEEDS.tenant: TENANT_SEEDS for every tenant but the default one, disabled and expired ones too (a tenant
 * is never deleted: enabled again or renewed, it is usable at once), so a release adding a tenant seed fills
 * the tenants opened before it. Opening a tenant also makes its administrator; this does not.
 */
async function seedTenants(q: EntityManager): Promise<string[]> {
  const tenants = await q.query<{ id: number }[]>(
    'SELECT id FROM iam_tenant WHERE id <> ? AND deleted_at IS NULL ORDER BY id',
    [DEFAULT_TENANT_ID],
  )
  const notices: string[] = []
  for (const t of tenants) notices.push(...(await runTenantSeeds(q, Number(t.id))))
  return notices
}

/** Menu groups of the layout before the regroup (系统管理 / 系统监控 / 系统工具) and where their pages went. */
const OBSOLETE_GROUPS: Record<string, string> = {
  iam: 'system',
  settings: 'system',
  scheduler: 'monitor',
}

/**
 * Existing databases: once the domain seeds have moved their pages, an obsolete group without live
 * children is soft-deleted with the role grants of every tenant. One that still has children (an --only
 * run that skipped its pages, or an admin's own page) stays. Stored generator configs naming it as parent
 * follow its pages. Nothing to do on a fresh database; safe to repeat.
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
    // qw:cross-tenant a platform menu leaves no grant behind in any tenant
    await allTenants(() => softDeleteWhere(q, 'iam_role_menus', 'menu_id', [group.id]))
    await softDeleteWhere(q, 'iam_menu', 'id', [group.id])
  }
}

/**
 * Runs the seeds (all, or the `only` domains) in one transaction, in the default tenant (the command
 * line and the test setup call it outside any request); SEEDS.tenant runs TENANT_SEEDS in each other
 * tenant (runTenantSeeds). Returns one-time notices for the operator, e.g.
 * a generated admin password; the CLI prints them.
 */
export async function runSeeds(ds: DataSource, only?: string[]): Promise<string[]> {
  const unknown = only?.filter((d) => !Object.hasOwn(SEEDS, d)) ?? []
  if (unknown.length)
    throw new Error(`unknown seed domain(s): ${unknown} (known: ${Object.keys(SEEDS)})`)
  const notices: string[] = []
  // qw:cross-tenant the seeds are the default tenant's
  await withTenant(DEFAULT_TENANT_ID, () =>
    ds.transaction(async (q) => {
      for (const [domain, seeds] of Object.entries(SEEDS))
        if (!only || only.includes(domain))
          for (const seed of seeds) notices.push(...(await seed(q)))
      await dropObsoleteGroups(q)
      // the platform-only flags follow the menus as the seeds (and admins) left them
      await syncPlatformOnly(q)
    }),
  )
  return notices
}
