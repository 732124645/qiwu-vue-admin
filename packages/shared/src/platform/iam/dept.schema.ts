import { z } from 'zod'
import { blankAsNull } from '../../common/crud.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Departments (`iam_dept`), `/api/iam/depts` (see docs/design-notes.md#api-envelope), the tree golden sample
 * (docs/codegen-golden.md "Tree"): a tree table (`parent_id`, 0 = top level, + `tree_path`) listed whole as
 * a forest, never paged. Field labels `field.iam.dept.<prop>`; sibling names are unique among undeleted depts
 * (409 `duplicate`). Every read and write stays in the caller's data scope (a dept is scoped by
 * its own id; see docs/design-notes.md#data-scope); out of scope → 404.
 */

export const deptPerms = {
  browse: 'iam.dept.browse',
  view: 'iam.dept.view',
  create: 'iam.dept.create',
  modify: 'iam.dept.modify',
  remove: 'iam.dept.remove',
} as const

/**
 * POST body; columns with a DB default may be left out, nullable ones may be null. `parentId`: 0 = top level,
 * else an enabled dept of the caller's scope (404 / 422 `tree.parent_disabled`); changing it moves the dept
 * with its whole subtree, never below itself (422 `tree.parent_invalid`).
 */
export const deptCreate = z
  .object({
    parentId: z.number().int().min(0),
    name: z.string().trim().min(1).max(64),
    sortNo: z.number().int().min(0).max(999_999).optional(),
    /** the dept head: a user of the caller's data scope (UserPicker), 404 otherwise */
    headUserId: z.number().int().positive().nullish(),
    phone: blankAsNull(
      z
        .string()
        .trim()
        .max(32)
        .regex(/^\+?\d[\d-]{4,30}$/),
    ),
    email: blankAsNull(z.string().trim().max(128).pipe(z.email())),
    /** off: no enabled child (422 `tree.child_enabled`); on: its disabled ancestors are enabled with it */
    enabled: z.boolean().optional(),
  })
  .register(fieldDomains, { domain: 'iam.dept' })
export type DeptCreate = z.infer<typeof deptCreate>

/** PUT body: the fields sent are changed, the others kept. */
export const deptUpdate = deptCreate.partial().register(fieldDomains, { domain: 'iam.dept' })
export type DeptUpdate = z.infer<typeof deptUpdate>

/**
 * GET query: the list filters (name contains, also the text of a seeded name; enabled equals). A matching
 * dept whose parent does not match is a root of the result.
 */
export const deptQuery = z
  .object({
    name: z.string().trim().max(64).optional(),
    enabled: z.stringbool().optional(),
  })
  .register(fieldDomains, { domain: 'iam.dept' })
export type DeptQuery = z.output<typeof deptQuery>

export const deptVo = z.object({
  id: z.number().int(),
  /** 0 = top level */
  parentId: z.number().int(),
  /** `/1/5/9/`: the ids of the ancestors and itself */
  treePath: z.string(),
  /** i18n key (seeded depts, `seed.dept.*`) or plain text: render with `tx()` */
  name: z.string(),
  sortNo: z.number().int(),
  headUserId: z.number().int().nullable(),
  /** display name of the head (null: none, or the user is deleted) */
  headUserName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  enabled: z.boolean(),
  createdBy: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedBy: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
})
export type DeptVo = z.infer<typeof deptVo>

export interface DeptNode extends DeptVo {
  children: DeptNode[]
}

/** GET / (browse): the caller's depts matching the filters as a forest, siblings by `sort_no, id`. */
export const deptNodeVo: z.ZodType<DeptNode> = deptVo.extend({
  get children() {
    return z.array(deptNodeVo)
  },
})

export interface DeptTreeNode {
  id: number
  /** 0 = top level */
  parentId: number
  /** i18n key (seeded depts, `seed.dept.*`) or plain text: render with `tx()` */
  name: string
  children: DeptTreeNode[]
}

/**
 * GET /tree (any signed-in user: dept filters and pickers): enabled depts in the caller's data scope, by
 * `sort_no, id`; a dept whose parent is not visible is a root, so the result is a forest.
 */
export const deptTreeNodeVo: z.ZodType<DeptTreeNode> = z.object({
  id: z.number().int(),
  parentId: z.number().int(),
  name: z.string(),
  get children() {
    return z.array(deptTreeNodeVo)
  },
})
