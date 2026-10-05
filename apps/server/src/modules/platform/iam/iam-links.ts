import type { LinkTable } from '../../../core/db/links.js'

/** The iam join tables as seen from the side a write edits; written via core/db/links.ts. */
export const USER_ROLES: LinkTable = {
  table: 'iam_user_roles',
  owner: 'user_id',
  target: 'role_id',
}
export const ROLE_USERS: LinkTable = {
  table: 'iam_user_roles',
  owner: 'role_id',
  target: 'user_id',
}
export const USER_POSITIONS: LinkTable = {
  table: 'iam_user_positions',
  owner: 'user_id',
  target: 'position_id',
}
export const ROLE_MENUS: LinkTable = {
  table: 'iam_role_menus',
  owner: 'role_id',
  target: 'menu_id',
}
export const ROLE_DEPTS: LinkTable = {
  table: 'iam_role_depts',
  owner: 'role_id',
  target: 'dept_id',
}
