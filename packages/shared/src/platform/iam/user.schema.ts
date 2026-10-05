import { z } from 'zod'
import { blankAsNull } from '../../common/crud.js'
import { pageQuery, PAGE_SIZE_MAX } from '../../common/pagination.js'
import { passwordSchema, type PasswordPolicy } from '../../common/password-policy.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Users (`iam_user`), `/api/iam/users` (see docs/design-notes.md#api-envelope), the complex golden sample: same conventions as
 * `position.schema.ts` (docs/codegen-golden.md). Field labels `field.iam.user.<prop>`; username, mobile and
 * email are unique among undeleted users (409 `duplicate`). Every read and write goes through the caller's
 * data scope (`dept_id`, `own_rows` = the user themself; see docs/design-notes.md#data-scope); out of scope → 404.
 */

export const userPerms = {
  browse: 'iam.user.browse',
  view: 'iam.user.view',
  create: 'iam.user.create',
  modify: 'iam.user.modify',
  remove: 'iam.user.remove',
  export: 'iam.user.export',
  import: 'iam.user.import',
  'reset-password': 'iam.user.reset-password',
  'assign-roles': 'iam.user.assign-roles',
} as const

/** `cfg_param` (seeded, `is_secret`) used when a new user's password is left empty (create and import). */
export const USER_INITIAL_PASSWORD_PARAM = 'iam.user.initial_password'

/** Values of the dict `iam.gender`. */
export const USER_GENDERS = ['male', 'female', 'unknown'] as const
export type UserGender = (typeof USER_GENDERS)[number]

const id = z.number().int().positive()

/** The editable columns; DB defaults (`gender`, `enabled`) and the id lists may be left out. */
const userFields = z.object({
  /** sign-in name: ASCII letters, digits and `_ . @ -` */
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w.@-]+$/),
  displayName: z.string().trim().min(1).max(64),
  /** must lie in the caller's writable scope (404 otherwise) */
  deptId: id.nullish(),
  mobile: blankAsNull(
    z
      .string()
      .trim()
      .max(32)
      .regex(/^\+?\d[\d-]{4,30}$/),
  ),
  email: blankAsNull(z.string().trim().max(128).pipe(z.email())),
  gender: z.enum(USER_GENDERS).optional(),
  enabled: z.boolean().optional(),
  note: z.string().trim().max(500).nullish(),
  /** replaces the user's roles; each must pass `GrantPolicy.assertAssignableRoles` (403 `grant_exceeds_own`) */
  roleIds: z.array(id).max(PAGE_SIZE_MAX).optional(),
  /** replaces the user's positions */
  positionIds: z.array(id).max(PAGE_SIZE_MAX).optional(),
})

/**
 * POST body under the runtime password policy (`GET /api/auth/me` → `policy`), like `changePasswordBody`:
 * the server parses it in the service, Swagger documents `userCreate(DEFAULT_PASSWORD_POLICY)`. `password`
 * empty or left out → the initial password param ({@link USER_INITIAL_PASSWORD_PARAM}); either way the
 * user must change it at the first sign-in (`password_changed_at = null`).
 */
export function userCreate(policy: PasswordPolicy) {
  return userFields
    .extend({ password: blankAsNull(passwordSchema(policy)) })
    .register(fieldDomains, { domain: 'iam.user' })
}
export type UserCreate = z.infer<ReturnType<typeof userCreate>>

/** PUT body: the create fields without `password` (reset-password changes it); sent fields change, others stay. */
export const userUpdate = userFields.partial().register(fieldDomains, { domain: 'iam.user' })
export type UserUpdate = z.infer<typeof userUpdate>

/**
 * GET query: `deptId` = that department and its whole subtree; `keyword` = username or display name
 * contains; `username`/`mobile` contain (`mobile` only for callers who see it unmasked, i.e. hold
 * `iam.user.modify`; ignored otherwise); `enabled` equals; `createdAtFrom ≤ created_at ≤ createdAtTo`
 * (ISO-8601 with `Z` or an offset; the web kit sends `createdAtRange` as these two).
 */
export const userQuery = pageQuery(['username', 'displayName', 'lastLoginAt', 'createdAt', 'id'])
  .extend({
    deptId: z.coerce.number().int().positive().optional(),
    keyword: z.string().trim().max(64).optional(),
    username: z.string().trim().max(64).optional(),
    mobile: z.string().trim().max(32).optional(),
    enabled: z.stringbool().optional(),
    createdAtFrom: z.iso.datetime({ offset: true }).optional(),
    createdAtTo: z.iso.datetime({ offset: true }).optional(),
  })
  .register(fieldDomains, { domain: 'iam.user' })
export type UserQuery = z.output<typeof userQuery>

/** List row. */
export const userVo = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  deptId: z.number().int().nullable(),
  /** i18n key (seeded depts, `seed.dept.*`) or plain text: render with `tx()` */
  deptName: z.string().nullable(),
  /** masked (`masked.mobile` / `masked.email`) unless the caller holds `iam.user.modify`: whoever can edit sees the real values */
  mobile: z.string().nullable(),
  email: z.string().nullable(),
  /** true when `mobile`/`email` above are masked, so they must never be sent back */
  masked: z.boolean(),
  gender: z.enum(USER_GENDERS),
  avatarUrl: z.string().nullable(),
  enabled: z.boolean(),
  /** holds the built-in root role: cannot be disabled, deleted or given other roles */
  root: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  createdBy: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedBy: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
})
export type UserVo = z.infer<typeof userVo>

/** GET /:id (detail drawer and edit form): the row plus its role and position ids. */
export const userDetailVo = userVo.extend({
  roleIds: z.array(z.number().int()),
  /** the held roles named, disabled ones too (not in the role options); `name` is rendered with `tx()` */
  roles: z.array(z.object({ id: z.number().int(), name: z.string() })),
  positionIds: z.array(z.number().int()),
})
export type UserDetailVo = z.infer<typeof userDetailVo>

/**
 * GET /options (any signed-in user; `UserPicker`): enabled users in the caller's data scope, filtered like the
 * list (`deptId` with its subtree, `keyword`), by username, at most `PAGE_SIZE_MAX` rows.
 */
export const userOptionQuery = userQuery
  .pick({ deptId: true, keyword: true })
  .register(fieldDomains, { domain: 'iam.user' })
export type UserOptionQuery = z.output<typeof userOptionQuery>

export const userOptionVo = userVo.pick({
  id: true,
  username: true,
  displayName: true,
  deptName: true,
})
export type UserOption = z.infer<typeof userOptionVo>

/** PUT /:id/roles (`assign-roles`): replaces the roles; empty = none. Same grant rules as `userCreate.roleIds`. */
export const userAssignRolesBody = z
  .object({ roleIds: z.array(id).max(PAGE_SIZE_MAX) })
  .register(fieldDomains, { domain: 'iam.user' })
export type UserAssignRolesBody = z.infer<typeof userAssignRolesBody>

/** PUT /:id/password (`reset-password`) under the runtime policy: ends the user's sessions, forces a change at sign-in. */
export function userResetPasswordBody(policy: PasswordPolicy) {
  return z
    .object({ password: passwordSchema(policy) })
    .register(fieldDomains, { domain: 'iam.user' })
}
export type UserResetPasswordBody = z.infer<ReturnType<typeof userResetPasswordBody>>
