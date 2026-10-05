// Workflow menus and the `staff` role (access model; see docs/design-notes.md#workflow). Top-level group 流程审批
// (`workflow`, sort 5, after home) holds the approval center, the OA leave pages and the 流程管理 sub-group
// (`wf-admin`). Names are i18n keys (menu.json in the web locales; seed.role.* in shared seed.json).
//
// The workflow views (apps/web/src/views/<component>.vue, SFC name = componentName):
//   workflow/center/{start,todo,done,mine,cc}  the center lists and the start page
//   workflow/center/detail                     instance detail, /workflow/instances/:id (hidden)
//   workflow/admin/{model,form,instance,task}  admin pages
//   workflow/admin/model-design                /wf/models/:id/design (hidden, under the model page)
//   workflow/admin/wizard/index                /wf/wizard (新建审批) and /wf/wizard/:id (hidden)
//   workflow/center/detail                     also /wf/instances/:id (hidden, under the instance page:
//                                              wf.instance.view opens it)
//   biz/leave/index                            my leave requests (the generator's module path:
//                                              <domain>/<biz> of biz_leave_request)
//   biz/leave/new                              the leave model's create_route /biz/leave/new (hidden)
//   biz/leave/view                             /biz/leave/:id (hidden) and the model's view_component
// Center and leave rows (plus home) are granted to `staff` on every run (an administrator's removal
// stays: revive false) and to `member` only when the row is first inserted. Admin rows are
// root's (perms `*`).
import { leavePerms, wfPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { addLinks, type LinkTable } from '../../../core/db/links.js'
import { findId, findRow, type Row, upsert } from '../upsert.js'

const ROLE_MENUS: LinkTable = { table: 'iam_role_menus', owner: 'role_id', target: 'menu_id' }

interface MenuSeed {
  routeName: string
  kind: 'group' | 'page'
  name: string
  path: string
  icon: string
  component?: string
  componentName?: string
  /** a sub-page opened from a list (visible 0, not kept alive; see docs/design-notes.md#layering) */
  hidden?: boolean
  /** false: a menu page not kept alive either */
  keepAlive?: boolean
  actions?: [perms: string, name: string][]
  children?: MenuSeed[]
}

const page = (
  routeName: string,
  name: string,
  path: string,
  component: string,
  componentName: string,
  icon: string,
  more: Partial<MenuSeed> = {},
): MenuSeed => ({ routeName, kind: 'page', name, path, component, componentName, icon, ...more })

/** Login-only pages over the caller's own data: granted to staff and member. */
const CENTER: MenuSeed[] = [
  page(
    'wf-start',
    'menu.workflow.start',
    '/workflow/start',
    'workflow/center/start',
    'WfStart',
    'lucide:send',
  ),
  page(
    'wf-todo',
    'menu.workflow.todo',
    '/workflow/todo',
    'workflow/center/todo',
    'WfTodo',
    'lucide:list-todo',
  ),
  page(
    'wf-done',
    'menu.workflow.done',
    '/workflow/done',
    'workflow/center/done',
    'WfDone',
    'lucide:list-checks',
  ),
  page(
    'wf-mine',
    'menu.workflow.mine',
    '/workflow/mine',
    'workflow/center/mine',
    'WfMine',
    'lucide:file-clock',
  ),
  page(
    'wf-cc',
    'menu.workflow.cc',
    '/workflow/cc',
    'workflow/center/cc',
    'WfCc',
    'lucide:mail-open',
  ),
  page(
    'biz-leave',
    'menu.biz.leave',
    '/biz/leave',
    'biz/leave/index',
    'BizLeave',
    'lucide:calendar-days',
    {
      // the leave module's perms (no generated menu seed: it would hang under a `biz` group)
      actions: [
        [leavePerms.browse, 'menu.action.browse'],
        [leavePerms.create, 'menu.action.create'],
        [leavePerms.modify, 'menu.action.modify'],
      ],
      children: [
        page(
          'biz-leave-new',
          'menu.biz.leaveNew',
          '/biz/leave/new',
          'biz/leave/new',
          'BizLeaveNew',
          'lucide:calendar-plus',
          { hidden: true },
        ),
        page(
          'biz-leave-view',
          'menu.biz.leaveView',
          '/biz/leave/:id',
          'biz/leave/view',
          'BizLeaveView',
          'lucide:calendar-check',
          { hidden: true },
        ),
      ],
    },
  ),
  page(
    'wf-instance-detail',
    'menu.workflow.detail',
    '/workflow/instances/:id',
    'workflow/center/detail',
    'WfInstanceDetail',
    'lucide:file-text',
    { hidden: true },
  ),
]

/** Admin pages behind wfPerms: root only. */
const ADMIN: MenuSeed = {
  routeName: 'wf-admin',
  kind: 'group',
  name: 'menu.wf.title',
  path: '/wf',
  icon: 'lucide:settings-2',
  children: [
    // the new-approval wizard: a dynamic model, its form and flow over the model / form perms;
    // 模型管理's 向导 reopens a dynamic model in it
    page(
      'wf-wizard',
      'menu.wf.wizard',
      '/wf/wizard',
      'workflow/admin/wizard/index',
      'WfWizard',
      'lucide:wand-sparkles',
      {
        // the embedded designer listens on the document while mounted (as formkit-design)
        keepAlive: false,
        children: [
          page(
            'wf-wizard-edit',
            'menu.wf.wizardEdit',
            '/wf/wizard/:id',
            'workflow/admin/wizard/index',
            'WfWizard',
            'lucide:wand-sparkles',
            { hidden: true },
          ),
        ],
      },
    ),
    page(
      'wf-model',
      'menu.wf.model',
      '/wf/models',
      'workflow/admin/model',
      'WfModel',
      'lucide:git-fork',
      {
        actions: [
          [wfPerms.model.browse, 'menu.action.browse'],
          [wfPerms.model.view, 'menu.action.view'],
          [wfPerms.model.create, 'menu.action.create'],
          [wfPerms.model.modify, 'menu.action.modify'],
          [wfPerms.model.remove, 'menu.action.remove'],
          // process managers see every field of the approval data: root only by default
          [wfPerms.model.managers, 'menu.action.managers'],
        ],
        // 设计 opens the designer: the hidden page holds publish (its holders get the route)
        children: [
          page(
            'wf-model-design',
            'menu.wf.modelDesign',
            '/wf/models/:id/design',
            'workflow/admin/model-design',
            'WfModelDesign',
            'lucide:workflow',
            { hidden: true, actions: [[wfPerms.model.publish, 'menu.action.publish']] },
          ),
        ],
      },
    ),
    page(
      'wf-form',
      'menu.wf.form',
      '/wf/forms',
      'workflow/admin/form',
      'WfForm',
      'lucide:file-pen-line',
      {
        // create / modify are admin-level: a form-create schema is code (see docs/design-notes.md#workflow)
        actions: [
          [wfPerms.form.browse, 'menu.action.browse'],
          [wfPerms.form.view, 'menu.action.view'],
          [wfPerms.form.create, 'menu.action.create'],
          [wfPerms.form.modify, 'menu.action.modify'],
          [wfPerms.form.remove, 'menu.action.remove'],
        ],
      },
    ),
    page(
      'wf-instance',
      'menu.wf.instance',
      '/wf/instances',
      'workflow/admin/instance',
      'WfInstance',
      'lucide:layers-3',
      {
        actions: [[wfPerms.instance.browse, 'menu.action.browse']],
        // 查看 opens the instance detail: the hidden page holds the action, so its holders get the route
        // (an admin without the center pages would land on the 404 page otherwise)
        children: [
          page(
            'wf-instance-view',
            'menu.workflow.detail',
            '/wf/instances/:id',
            'workflow/center/detail',
            'WfInstanceDetail',
            'lucide:file-text',
            { hidden: true, actions: [[wfPerms.instance.view, 'menu.action.view']] },
          ),
        ],
      },
    ),
    page(
      'wf-task',
      'menu.wf.task',
      '/wf/tasks',
      'workflow/admin/task',
      'WfTask',
      'lucide:clipboard-list',
      {
        actions: [
          [wfPerms.task.browse, 'menu.action.browse'],
          [wfPerms.task.manage, 'menu.action.manage'],
        ],
      },
    ),
    // a model's instances by its form fields
    page('wf-data', 'menu.wf.data', '/wf/data', 'workflow/admin/data', 'WfData', 'lucide:table-2', {
      actions: [
        [wfPerms.data.browse, 'menu.action.browse'],
        [wfPerms.data.export, 'menu.action.export'],
      ],
    }),
  ],
}

export async function seedWorkflowMenus(q: EntityManager): Promise<string[]> {
  const inserted = new Set<number>()
  const put = async (key: Row, values: Row): Promise<number> => {
    const found = await findRow(q, 'iam_menu', key)
    const id = await upsert(q, 'iam_menu', key, values)
    if (!found) inserted.add(id)
    return id
  }
  /** Upserts `m`, its actions and children; returns the ids of the whole subtree. */
  const seedNode = async (m: MenuSeed, parentId: number, sortNo: number): Promise<number[]> => {
    const id = await put(
      { route_name: m.routeName },
      {
        parent_id: parentId,
        kind: m.kind,
        name: m.name,
        route_path: m.path,
        icon: m.icon,
        sort_no: sortNo,
        ...(m.kind === 'page' && {
          component: m.component,
          component_name: m.componentName,
          keep_alive: m.hidden || m.keepAlive === false ? 0 : 1,
        }),
        ...(m.hidden && { visible: 0 }),
      },
    )
    const ids = [id]
    for (const [i, [perms, name]] of (m.actions ?? []).entries())
      ids.push(await put({ kind: 'action', perms }, { parent_id: id, name, sort_no: (i + 1) * 10 }))
    for (const [i, c] of (m.children ?? []).entries())
      ids.push(...(await seedNode(c, id, (i + 1) * 10)))
    return ids
  }

  const groupId = await put(
    { route_name: 'workflow' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.workflow.title',
      route_path: '/workflow',
      icon: 'lucide:workflow',
      sort_no: 5,
    },
  )
  const granted: number[] = []
  for (const [i, m] of [...CENTER, ADMIN].entries()) {
    const ids = await seedNode(m, groupId, (i + 1) * 10)
    if (m !== ADMIN) granted.push(...ids)
  }

  // name, data scope and sort are the admin's after the insert (like member)
  await upsert(
    q,
    'iam_role',
    { code: 'staff' },
    { is_builtin: 0 },
    { name: 'seed.role.staff', data_scope: 'own_rows', sort_no: 120 },
  )
  // a role an administrator deleted gets no grant (a live link would block deleting the menu)
  const live = async (code: string) => {
    const role = await findRow(q, 'iam_role', { code })
    return role && !role.deleted ? role.id : undefined
  }
  // staff holds home too, like member; absent on an `--only workflow` run over an empty DB
  const homeId = await findId(q, 'iam_menu', { route_name: 'home' })
  const staffId = await live('staff')
  if (staffId)
    await addLinks(q, ROLE_MENUS, staffId, homeId ? [homeId, ...granted] : granted, {
      revive: false,
    })
  const memberId = await live('member')
  if (memberId)
    await addLinks(
      q,
      ROLE_MENUS,
      memberId,
      granted.filter((id) => inserted.has(id)),
      { revive: false },
    )
  return []
}
