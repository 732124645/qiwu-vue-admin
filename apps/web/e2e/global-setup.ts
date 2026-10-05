// Runs after the web servers are up (the server command already reset the e2e DB_NAME, qiwu_e2e by default): adds the extra
// users (and the positions roles) and the extra menu page specs need through the compiled seed helpers, and drops the previous
// run's `qw:*` keys from the e2e REDIS_DB (sign-in failure locks, sessions, caches outlive the DB reset),
// in a child process with the server's env and cwd.
import { spawnSync } from 'node:child_process'
import type { FullConfig } from '@playwright/test'
import { OA_USERS, serverDir, serverEnv, USERS } from './env.ts'

const SCRIPT = `
import bcrypt from 'bcryptjs'
import { createClient } from 'redis'
import { DataSource } from 'typeorm'
import { keyPattern } from './dist/core/redis/cache-namespaces.js'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
import { findId, upsert } from './dist/db/seeds/upsert.js'
const [limited, reader, modifier, profile, tree, scoped, granter, operator, rt, staff, wfAdmin, wfViewer, ...mustChange] = JSON.parse(process.env.E2E_USERS)
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    await seedLimitedUser(q, limited.username, limited.password)
    // positions roles: the browse action alone (read-only; users too: masked contacts), browse +
    // modify without view (the page comes with its ancestors); the user list of "own dept and below"
    // (org.spec: it follows a dept move); the user list of every dept until org.spec's data-scope dialog
    // narrows it; a non-root role editor (org.spec: its data-scope dialog offers no \`all\`); a non-root
    // process admin over its own dept that may not act, and one that views instances (wf-admin.spec)
    for (const [user, code, perms, scope] of [
      [reader, 'e2e_reader', ['iam.position.browse', 'iam.user.browse'], 'own_dept'],
      [modifier, 'e2e_modifier', ['iam.position.browse', 'iam.position.modify'], 'own_dept'],
      [tree, 'e2e_tree', ['iam.user.browse'], 'own_dept_tree'],
      [scoped, 'e2e_scoped', ['iam.user.browse'], 'all'],
      [granter, 'e2e_granter', ['iam.role.browse', 'iam.role.grant'], 'own_dept'],
      [operator, 'e2e_operator', ['scheduler.task.browse', 'scheduler.task.create', 'scheduler.task.run', 'scheduler.task.remove'], 'own_dept'],
      [wfAdmin, 'e2e_wf_ops', ['wf.instance.browse', 'wf.task.browse'], 'own_dept'],
      [wfViewer, 'e2e_wf_viewer', ['wf.instance.browse', 'wf.instance.view'], 'own_dept'],
    ]) {
      const userId = await seedLimitedUser(q, user.username, user.password)
      const roleId = await upsert(q, 'iam_role', { code }, { name: code, data_scope: scope })
      for (const perm of perms) {
        const menuId = await findId(q, 'iam_menu', { perms: perm })
        await q.query('INSERT IGNORE INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [roleId, menuId])
      }
      await q.query('INSERT IGNORE INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [userId, roleId])
    }
    // the realtime demo's receiver: the page row alone (it has no browse action), so no send form
    const rtId = await seedLimitedUser(q, rt.username, rt.password)
    const rtRoleId = await upsert(q, 'iam_role', { code: 'e2e_rt' }, { name: 'e2e_rt', data_scope: 'own_dept' })
    await q.query('INSERT IGNORE INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      rtRoleId, await findId(q, 'iam_menu', { route_name: 'demo-realtime' }),
    ])
    await q.query('INSERT IGNORE INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [rtId, rtRoleId])
    // the personal center shows a position too
    const profileId = await seedLimitedUser(q, profile.username, profile.password)
    await q.query('INSERT IGNORE INTO iam_user_positions (user_id, position_id) VALUES (?, ?)', [
      profileId, await findId(q, 'iam_position', { code: 'support' }),
    ])
    // the approval center's user: the seeded role staff alone (own rows, like the OA users; dept support),
    // instead of demo
    const staffId = await seedLimitedUser(q, staff.username, staff.password)
    await q.query('DELETE FROM iam_user_roles WHERE user_id = ?', [staffId])
    await q.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [
      staffId, await findId(q, 'iam_role', { code: 'staff' }),
    ])
    // wf-center-start.spec: a published custom-form model (no business handler in this server to publish
    // it through the API), opening a page every signed-in user has; sorted after the spec's own models
    // (its category still comes first: the page groups in the dict's order)
    const modelId = await upsert(q, 'wf_model', { model_key: 'e2e-start-custom' }, {
      name: 'menu.biz.leave', category: 'hr', icon: 'lucide:calendar-days', form_kind: 'custom',
      create_route: '/profile', view_component: 'profile/index', sort_no: 100,
    })
    const versionId = await upsert(q, 'wf_version', { model_key: 'e2e-start-custom', version: 1 }, {
      model_id: modelId, tree_json: JSON.stringify({ id: 'begin', type: 'begin', name: 'Begin' }),
      form_snapshot: JSON.stringify({ fields: {} }),
    })
    await q.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [versionId, modelId])
    for (const u of mustChange) {
      const id = await seedLimitedUser(q, u.username, u.password)
      await q.query('UPDATE iam_user SET password_changed_at = NULL WHERE id = ?', [id])
    }
    // the seeded OA demo users (leave specs): a known password, counted as changed
    for (const u of JSON.parse(process.env.E2E_OA_USERS)) {
      const hash = await bcrypt.hash(u.password, 4)
      await q.query('UPDATE iam_user SET password_hash = ?, password_changed_at = NOW(3) WHERE username = ?', [hash, u.username])
    }
    // a third page (plain-text name, no keep-alive) so tag specs can close others / left / right
    await upsert(q, 'iam_menu', { route_name: 'e2e-page' }, {
      parent_id: 0, kind: 'page', name: 'E2E page', route_path: '/e2e/page',
      component: 'home/index', icon: 'lucide:file-text', sort_no: 50,
    })
  })
} finally {
  await ds.destroy()
}
const { REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD, REDIS_DB } = process.env
const redis = createClient({
  socket: { host: REDIS_HOST, port: Number(REDIS_PORT) },
  username: REDIS_USERNAME,
  password: REDIS_PASSWORD,
  database: Number(REDIS_DB),
})
await redis.connect()
try {
  // the ACL user may not FLUSHDB/KEYS: SCAN + UNLINK
  for await (const keys of redis.scanIterator({ MATCH: keyPattern(), COUNT: 500 }))
    if (keys.length) await redis.unlink(keys)
} finally {
  await redis.close()
}
`

export default function globalSetup(config: FullConfig) {
  const channel = config.projects[0]?.use.channel
  console.log(`playwright browser: ${channel ? `channel ${channel}` : 'bundled chromium'}`)
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: serverDir,
    env: {
      ...process.env,
      ...serverEnv,
      E2E_USERS: JSON.stringify([
        USERS.limited,
        USERS.reader,
        USERS.modifier,
        USERS.profile,
        USERS.tree,
        USERS.scoped,
        USERS.granter,
        USERS.operator,
        USERS.rt,
        USERS.staff,
        USERS.wfAdmin,
        USERS.wfViewer,
        USERS.fresh,
        USERS.changer,
      ]),
      E2E_OA_USERS: JSON.stringify(OA_USERS.map((k) => USERS[k])),
    },
    encoding: 'utf8',
  })
  if (r.status !== 0)
    throw new Error(`e2e user seeding failed (${r.status ?? r.signal}):\n${r.stderr}`)
}
