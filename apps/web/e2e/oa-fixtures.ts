import { spawnSync } from 'node:child_process'
import type { APIRequestContext, APIResponse, Page } from '@playwright/test'

export const OFFICE_PASSWORD = 'Office-E2e@2026'
export type OfficeUser = { username: string; password: string; id: number }
export type OfficeFixture = {
  tid: number
  role: number
  users: Record<'owner' | 'boss' | 'other', OfficeUser>
  models: Record<string, unknown>[]
  versions: number[]
}
export type ScriptRunner = (script: string, env?: Record<string, string>) => string

/** 只有显式调用才接触数据库；--list 导入本模块不会创建账号、改模型或启动进程。 */
export const desktopScript =
  (serverDir: string, serverEnv: Record<string, string>): ScriptRunner =>
  (script, env = {}) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: serverDir,
      env: { ...process.env, ...serverEnv, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.status !== 0) throw new Error(`Office fixture failed: ${result.stderr}`)
    return result.stdout
  }

const SETUP = `
import bcrypt from 'bcryptjs'
import { DataSource } from 'typeorm'
import { withTenant } from './dist/core/context/tenant.js'
import { dataSourceOptions } from './dist/db/data-source.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const input = JSON.parse(process.env.OFFICE_INPUT)
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
 const tid = input.code ? Number((await ds.query('SELECT id FROM iam_tenant WHERE code = ? AND deleted_at IS NULL', [input.code]))[0].id) : 1
 const result = await withTenant(tid, () => ds.transaction(async q => {
  const role = await insertRow(q, 'iam_role', {code: input.tag, name: input.tag, data_scope: 'own_rows'})
  const menus = await q.query("SELECT id FROM iam_menu WHERE deleted_at IS NULL AND (route_name IN ('home','oa','workflow') OR route_path IN ('/oa/office','/oa/trip','/oa/trip/new','/oa/trip/:id','/oa/expense','/oa/expense/new','/oa/expense/:id','/oa/seal','/oa/seal/new','/oa/seal/:id','/biz/leave','/biz/leave/new','/biz/leave/:id','/workflow/todo','/workflow/done','/workflow/mine','/workflow/cc','/workflow/instances/:id') OR perms IN ('biz.leave.browse','biz.leave.create','biz.leave.modify','oa.trip.browse','oa.trip.view','oa.trip.create','oa.trip.modify','oa.expense.browse','oa.expense.view','oa.expense.create','oa.expense.modify','oa.seal.browse','oa.seal.view','oa.seal.create','oa.seal.modify'))")
  for (const menu of menus) await insertRow(q, 'iam_role_menus', {role_id: role, menu_id: menu.id})
  const hash = await bcrypt.hash(input.password, 4)
  const users = {}
  for (const who of ['owner','boss','other']) {
   const username = input.tag + '_' + who
   const id = await insertRow(q, 'iam_user', {username, display_name: username, password_hash: hash, password_changed_at: new Date()})
   await insertRow(q, 'iam_user_roles', {user_id: id, role_id: role})
   users[who] = {username, password: input.password, id}
  }
  const models = await q.query("SELECT id, draft_json, initiator_scope, manager_user_ids, enabled, current_version_id FROM wf_model WHERE tenant_id = ? AND model_key IN ('leave','oa-trip','oa-expense','oa-seal','oa-generic') AND deleted_at IS NULL ORDER BY id", [tid])
  if(models.length !== 5) throw new Error('Five installed office models are required')
  const versions=[]
  for(const model of models) {
   const [current] = await q.query('SELECT model_key, form_snapshot FROM wf_version WHERE tenant_id = ? AND id = ?', [tid, model.current_version_id])
   if(!current) throw new Error('An installed office model has no published form')
   const [latest] = await q.query('SELECT MAX(version) AS n FROM wf_version WHERE tenant_id = ? AND model_id = ?', [tid, model.id])
   const tree={id:'begin',type:'begin',name:'seed.wf.node.begin',next:{id:'review',type:'review',name:'seed.oa.reviewer',assignee:{kind:'users',ids:[users.boss.id]},sign:'any',whenNobody:'toManager',whenInitiatorIsReviewer:'self',onReject:'finish'}}
   const version=await insertRow(q,'wf_version',{model_id:model.id,model_key:current.model_key,version:Number(latest.n)+1,tree_json:tree,form_snapshot:current.form_snapshot})
   versions.push(version)
   await q.query('UPDATE wf_model SET draft_json=?,current_version_id=?,enabled=1,initiator_scope=?,manager_user_ids=NULL WHERE tenant_id=? AND id=?',[JSON.stringify(tree),version,JSON.stringify({userIds:[users.owner.id],deptIds:[],roleIds:[]}),tid,model.id])
  }
  return {tid,role,users,models,versions}
 }))
 console.log(JSON.stringify(result))
} finally { await ds.destroy() }
`

const CLEANUP = `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { LocalStorage } from './dist/modules/platform/storage/local-storage.js'
const f=JSON.parse(process.env.OFFICE_FIXTURE), ids=Object.values(f.users).map(u=>u.id)
const ds=await new DataSource(dataSourceOptions()).initialize()
try { await ds.transaction(async q=>{
 const instances=(await q.query('SELECT id FROM wf_instance WHERE tenant_id=? AND initiator_id IN (?)',[f.tid,ids])).map(x=>x.id)
 if(instances.length) {
  for(const table of ['wf_event','wf_task','wf_cc']) await q.query('DELETE FROM '+table+' WHERE tenant_id=? AND instance_id IN (?)',[f.tid,instances])
  await q.query('DELETE FROM wf_instance WHERE tenant_id=? AND id IN (?)',[f.tid,instances])
 }
 await q.query('DELETE FROM oa_expense_item WHERE tenant_id=? AND claim_id IN (SELECT id FROM oa_expense_claim WHERE tenant_id=? AND user_id IN (?))',[f.tid,f.tid,ids])
 for(const table of ['biz_leave_request','oa_trip_request','oa_expense_claim','oa_seal_request']) await q.query('DELETE FROM '+table+' WHERE tenant_id=? AND user_id IN (?)',[f.tid,ids])
 const files=await q.query('SELECT object_key,is_public FROM fs_object WHERE tenant_id=? AND uploader_id IN (?)',[f.tid,ids])
 for(const file of files) await new LocalStorage().remove(file.object_key,!!file.is_public)
 await q.query('DELETE FROM fs_object WHERE tenant_id=? AND uploader_id IN (?)',[f.tid,ids])
 for(const model of f.models) await q.query('UPDATE wf_model SET draft_json=?,initiator_scope=?,manager_user_ids=?,enabled=?,current_version_id=? WHERE tenant_id=? AND id=?',[model.draft_json==null?null:JSON.stringify(model.draft_json),model.initiator_scope==null?null:JSON.stringify(model.initiator_scope),model.manager_user_ids==null?null:JSON.stringify(model.manager_user_ids),model.enabled,model.current_version_id,f.tid,model.id])
 await q.query('DELETE FROM wf_version WHERE tenant_id=? AND id IN (?)',[f.tid,f.versions])
 await q.query('DELETE FROM msg_inbox WHERE tenant_id=? AND user_id IN (?)',[f.tid,ids])
 for(const table of ['iam_user_roles','iam_user_positions']) await q.query('DELETE FROM '+table+' WHERE tenant_id=? AND user_id IN (?)',[f.tid,ids])
 await q.query('DELETE FROM iam_role_menus WHERE tenant_id=? AND role_id=?',[f.tid,f.role])
 await q.query('DELETE FROM iam_user WHERE tenant_id=? AND id IN (?)',[f.tid,ids])
 await q.query('DELETE FROM iam_role WHERE tenant_id=? AND id=?',[f.tid,f.role])
}) } finally {await ds.destroy()}
`

/** 只种独立账号、最小页面授权和审批配置，不直接生成申请、任务或审批结果。 */
export function seedOffice(
  run: ScriptRunner,
  tag: string,
  options: { code?: string } = {},
): OfficeFixture {
  const output = run(SETUP, {
    OFFICE_INPUT: JSON.stringify({ tag, password: OFFICE_PASSWORD, ...options }),
  })
  return JSON.parse(output.trim().split('\n').at(-1)!) as OfficeFixture
}
/** 先清本组真实申请与文件，再恢复原模型指针与规则，最后删除本组账号和角色。 */
export function restoreOffice(run: ScriptRunner, fixture: OfficeFixture | undefined) {
  if (fixture) run(CLEANUP, { OFFICE_FIXTURE: JSON.stringify(fixture) })
}

let loginSequence = 0
/** 每个会话使用独立测试来源地址，避免跨文件共享登录频控影响业务验收。 */
export async function officeToken(
  request: APIRequestContext,
  user: OfficeUser,
  tenantCode?: string,
) {
  const res = await request.post('/api/auth/login', {
    data: {
      username: user.username,
      password: user.password,
      ...(tenantCode ? { tenantCode } : {}),
    },
    headers: { 'X-Forwarded-For': `203.0.113.${(++loginSequence % 240) + 1}` },
  })
  if (!res.ok()) throw new Error(`Office sign-in failed (${res.status()}): ${await res.text()}`)
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` }
}
export async function officeSignIn(page: Page, user: OfficeUser, path: string, code?: string) {
  const headers = await officeToken(page.request, user, code)
  await officeData(
    page.request.put('/api/iam/profile/locale', { headers, data: { locale: 'zh-CN' } }),
  )
  await page.goto('/login')
  await page.evaluate(() => localStorage.setItem('qw.auth.session', '1'))
  await page.goto(path)
}
export async function officeData<T>(promise: Promise<APIResponse>): Promise<T> {
  const res = await promise
  if (!res.ok()) throw new Error(`Office request failed (${res.status()}): ${await res.text()}`)
  return (await res.json()).data as T
}
export const receipt = {
  name: 'office-receipt.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'),
}
export async function uploadOffice(request: APIRequestContext, headers: Record<string, string>) {
  const file = await officeData<{ id: number }>(
    request.post('/api/storage/objects', {
      headers,
      multipart: {
        bizTag: 'oa.attachment',
        file: { name: receipt.name, mimeType: receipt.mimeType, buffer: receipt.buffer },
      },
    }),
  )
  return file.id
}

export const officeEndpoints = {
  leave: '/biz/leaves',
  trip: '/oa/trips',
  expense: '/oa/expense-claims',
  seal: '/oa/seal-requests',
  generic: '/wf/instances',
} as const
export type OfficeKind = keyof typeof officeEndpoints
/** 从产品真实写入口创建申请；审批状态只能由引擎办理后回写。 */
export async function createOfficeRequest(
  request: APIRequestContext,
  headers: Record<string, string>,
  kind: OfficeKind,
  extra: object = {},
) {
  const bodies = {
    leave: {
      leaveKind: 'personal',
      startAt: '2026-12-07T01:00:00Z',
      endAt: '2026-12-07T10:00:00Z',
      days: 1,
      reason: 'Office leave request',
    },
    trip: {
      destination: 'North office',
      startAt: '2026-12-07T01:00:00Z',
      endAt: '2026-12-08T10:00:00Z',
      reason: 'Office trip request',
      estimatedAmount: '0.30',
    },
    expense: {
      reason: 'Office travel costs',
      items: [
        {
          expenseDate: '2026-12-07',
          expenseKind: 'transport',
          amount: '0.10',
          description: 'First receipt',
        },
        {
          expenseDate: '2026-12-07',
          expenseKind: 'meal',
          amount: '0.20',
          description: 'Last meal receipt',
        },
      ],
    },
    seal: {
      sealKind: 'company',
      documentName: 'Office agreement',
      purpose: 'Office seal request',
      copies: 2,
      expectedDate: '2026-12-07',
    },
    generic: {
      modelKey: 'oa-generic',
      formValues: {
        title: 'Office equipment',
        description: 'Replace the shared equipment',
        expectedDate: '2026-12-07',
        attachments: [],
      },
    },
  }
  const result = await officeData<{ id: number; instanceId?: number }>(
    request.post(`/api${officeEndpoints[kind]}`, { headers, data: { ...bodies[kind], ...extra } }),
  )
  return { id: result.id, instanceId: result.instanceId ?? result.id }
}
