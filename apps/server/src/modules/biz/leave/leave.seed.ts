// The OA leave sample (see docs/design-notes.md#workflow): five demo users holding the seeded role
// `staff` and process `leave` routing between them. Model, node and path names are seed.wf.* keys (shared
// seed.json); user names and routing made up for this project. Runs after the workflow menus (role staff).
import { randomBytes } from 'node:crypto'
import { compile, type WfBeginNode, type WfReviewNode } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import type { EntityManager } from 'typeorm'
import { demoMode } from '../../../core/config/demo-mode.js'
import { BCRYPT_COST } from '../../../core/auth/password-hash.js'
import { addLinks, type LinkTable } from '../../../core/db/links.js'
import { findId, findRow, insertRow } from '../../../db/seeds/upsert.js'
import { LEAVE_FIELDS, LEAVE_MODEL } from './leave-wf.handler.js'

const USER_ROLES: LinkTable = { table: 'iam_user_roles', owner: 'user_id', target: 'role_id' }

type Who = 'employee' | 'supervisor' | 'deputy' | 'director' | 'hr'
/** who → [username, display name, dept name key] */
export const LEAVE_DEMO_USERS: Record<Who, [username: string, name: string, dept: string]> = {
  employee: ['oa.employee', 'OA Employee', 'seed.dept.platform'],
  supervisor: ['oa.supervisor', 'OA Supervisor', 'seed.dept.platform'],
  // no step of their own: the supervisor hands tasks over to them (transfer, delegate)
  deputy: ['oa.deputy', 'OA Deputy', 'seed.dept.platform'],
  director: ['oa.director', 'OA Director', 'seed.dept.rd'],
  hr: ['oa.hr', 'OA HR', 'seed.dept.hq'],
}

const review = (id: string, name: string, userId: number): WfReviewNode => ({
  id,
  type: 'review',
  name,
  assignee: { kind: 'users', ids: [userId] },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'skip',
  onReject: 'finish',
})

/** supervisor → by days: > 5 → HR ∥ director; > 2 and ≤ 5 → director; otherwise done */
export const leaveTree = (u: Record<Who, number>): WfBeginNode => ({
  id: 'begin',
  type: 'begin',
  name: 'seed.wf.node.begin',
  next: {
    ...review('supervisor', 'seed.wf.node.supervisor', u.supervisor),
    next: {
      id: 'by-days',
      type: 'fork',
      name: 'seed.wf.node.byDays',
      mode: 'exclusive',
      paths: [
        {
          id: 'over-5',
          name: 'seed.wf.path.over5',
          when: [[{ field: 'days', op: 'gt', value: 5 }]],
          child: {
            id: 'hr-and-director',
            type: 'fork',
            name: 'seed.wf.node.hrAndDirector',
            mode: 'parallel',
            paths: [
              {
                id: 'to-hr',
                name: 'seed.wf.path.hr',
                when: [],
                child: review('hr', 'seed.wf.node.hr', u.hr),
              },
              {
                id: 'to-director',
                name: 'seed.wf.path.director',
                when: [],
                child: review('director-long', 'seed.wf.node.director', u.director),
              },
            ],
          },
        },
        {
          id: 'over-2',
          name: 'seed.wf.path.over2',
          when: [
            [
              { field: 'days', op: 'gt', value: 2 },
              { field: 'days', op: 'lte', value: 5 },
            ],
          ],
          child: review('director', 'seed.wf.node.director', u.director),
        },
        { id: 'otherwise', name: 'seed.wf.path.otherwise', fallback: true, when: [] },
      ],
    },
  },
})

// One random password per process (an install seeds once), hashed on first use: a cost-12 hash
// is ~0.5 s, and test suites seed empty tables many times in one process
let credentials: Promise<[password: string, hash: string]> | undefined
const demoCredentials = () =>
  (credentials ??= (async () => {
    const password = randomBytes(12).toString('base64url')
    return [password, await bcrypt.hash(password, BCRYPT_COST)]
  })())

/**
 * The demo users are created once (an existing one, or one an administrator deleted, is never touched) with
 * a random password, returned as a notice to print once; `password_changed_at` only in demo mode (a
 * read-only demo cannot change it), else the first sign-in must change it. Role staff is ensured on every run
 * (a link an administrator removed stays removed). Model `leave` and its version 1 are inserted once: an
 * administrator owns them afterwards.
 */
export async function seedLeave(q: EntityManager): Promise<string[]> {
  const staff = await findRow(q, 'iam_role', { code: 'staff' })
  let password: string | undefined
  let hash: string | undefined
  const created: string[] = []
  const ids = {} as Record<Who, number>
  for (const [who, [username, displayName, deptName]] of Object.entries(LEAVE_DEMO_USERS)) {
    let id = await findId(q, 'iam_user', { username })
    if (id === undefined) {
      const dept = await findRow(q, 'iam_dept', { name: deptName })
      if (!hash) [password, hash] = await demoCredentials()
      id = await insertRow(q, 'iam_user', {
        username,
        display_name: displayName,
        dept_id: dept && !dept.deleted ? dept.id : null,
        password_hash: hash,
        password_changed_at: demoMode() ? new Date() : null,
      })
      created.push(username)
    }
    if (staff && !staff.deleted) await addLinks(q, USER_ROLES, id, [staff.id], { revive: false })
    ids[who as Who] = id
  }
  await seedModel(q, ids)
  if (!password) return []
  const change = demoMode() ? '' : ', must be changed at first sign-in'
  return [
    `seed: password of OA demo users ${created.join(', ')} (shown once${change}): ${password}`,
  ]
}

async function seedModel(q: EntityManager, ids: Record<Who, number>): Promise<void> {
  if (await findRow(q, 'wf_model', { model_key: LEAVE_MODEL })) return
  const r = compile(leaveTree(ids), LEAVE_FIELDS)
  if (!r.ok) throw new Error(`seedLeave: the leave process does not compile: ${JSON.stringify(r)}`)
  const modelId = await insertRow(q, 'wf_model', {
    model_key: LEAVE_MODEL,
    name: 'seed.wf.leave',
    category: 'hr',
    icon: 'lucide:calendar-days',
    description: 'seed.wf.leaveDescription',
    form_kind: 'custom',
    create_route: '/biz/leave/new',
    view_component: 'biz/leave/view',
    draft_json: r.flow.root,
    sort_no: 10,
  })
  const versionId = await insertRow(q, 'wf_version', {
    model_id: modelId,
    model_key: LEAVE_MODEL,
    version: 1,
    tree_json: r.flow.root,
    form_snapshot: { fields: LEAVE_FIELDS },
  })
  await q.query('UPDATE wf_model SET current_version_id = ? WHERE id = ? AND deleted_at IS NULL', [
    versionId,
    modelId,
  ])
}
