/**
 * Business error codes (see docs/design-notes.md#api-envelope). Every code has an HTTP status and an i18n key
 * `error.<domain>.<name>` translated by the server; clients branch on `code`, never on `msg`.
 * Ranges: A0xxx common · A1xxx auth · B1xxx iam · B2xxx settings · B3xxx messaging · B4xxx oauth ·
 * C1xxx storage · C2xxx scheduler · C3xxx codegen · D1xxx workflow · E1xxx+ biz.
 * Modules add their own codes later; codes are never renumbered.
 */
export interface ErrorDef {
  readonly code: string
  readonly status: number
  readonly key: string
}

const def = (code: string, status: number, key: string): ErrorDef => ({ code, status, key })

export const Err = {
  BAD_REQUEST: def('A0400', 400, 'error.common.bad_request'),
  VALIDATION_FAILED: def('A0401', 400, 'error.common.validation_failed'),
  UNAUTHENTICATED: def('A0410', 401, 'error.common.unauthenticated'),
  FORBIDDEN: def('A0430', 403, 'error.common.forbidden'),
  DEMO_READ_ONLY: def('A0431', 403, 'error.common.demo_read_only'),
  NOT_FOUND: def('A0440', 404, 'error.common.not_found'),
  CONFLICT: def('A0490', 409, 'error.common.conflict'),
  DUPLICATE: def('A0491', 409, 'error.common.duplicate'),
  IN_USE: def('A0492', 409, 'error.common.in_use'),
  PAYLOAD_TOO_LARGE: def('A0413', 413, 'error.common.payload_too_large'),
  UNPROCESSABLE: def('A0422', 422, 'error.common.unprocessable'),
  TOO_MANY_REQUESTS: def('A0429', 429, 'error.common.too_many_requests'),
  INTERNAL: def('A0500', 500, 'error.common.internal'),

  /** Excel import (core/excel; see docs/design-notes.md#security): not a readable .xlsx */
  EXCEL_INVALID: def('A0450', 400, 'error.excel.invalid'),
  /** macros (vbaProject) or external links: refused unread */
  EXCEL_UNSAFE: def('A0451', 400, 'error.excel.unsafe'),
  /** params `{ max }` */
  EXCEL_TOO_MANY_ROWS: def('A0452', 413, 'error.excel.too_many_rows'),
  /** params `{ max }` */
  EXCEL_TOO_MANY_COLUMNS: def('A0453', 413, 'error.excel.too_many_columns'),
  /** the header row names none of the template's columns */
  EXCEL_NO_COLUMNS: def('A0454', 400, 'error.excel.no_columns'),

  /** Tree tables (core/db BaseTreeService): the new parent is the node itself or below it */
  TREE_PARENT_INVALID: def('A0460', 422, 'error.tree.parent_invalid'),
  /** nothing is added or moved under a disabled parent */
  TREE_PARENT_DISABLED: def('A0461', 422, 'error.tree.parent_disabled'),
  /** a node with an enabled child cannot be disabled */
  TREE_CHILD_ENABLED: def('A0462', 422, 'error.tree.child_enabled'),
  /** a node with children cannot be deleted (unless they are deleted with it) */
  TREE_HAS_CHILDREN: def('A0463', 409, 'error.tree.has_children'),
  TREE_PATH_TOO_LONG: def('A0464', 422, 'error.tree.path_too_long'),

  AUTH_BAD_CREDENTIALS: def('A1001', 401, 'error.auth.bad_credentials'),
  AUTH_LOCKED: def('A1002', 429, 'error.auth.locked'),
  AUTH_IP_BLOCKED: def('A1003', 403, 'error.auth.ip_blocked'),
  /** POST /api/auth/signup while `auth.signup.enabled` is off, or its default role is unusable */
  AUTH_SIGNUP_DISABLED: def('A1022', 403, 'error.auth.signup_disabled'),
  /** SMS sign-in / reset: wrong, used or expired code, or no usable account behind it */
  AUTH_SMS_CODE_INVALID: def('A1023', 400, 'error.auth.sms_code_invalid'),
  AUTH_PASSWORD_CHANGE_REQUIRED: def('A1004', 403, 'error.auth.password_change_required'),
  AUTH_SESSION_EXPIRED: def('A1005', 401, 'error.auth.session_expired'),
  AUTH_REFRESH_REJECTED: def('A1006', 401, 'error.auth.refresh_rejected'),
  AUTH_ORIGIN_REJECTED: def('A1007', 403, 'error.auth.origin_rejected'),
  AUTH_OLD_PASSWORD_WRONG: def('A1008', 400, 'error.auth.old_password_wrong'),
  AUTH_PASSWORD_UNCHANGED: def('A1009', 400, 'error.auth.password_unchanged'),
  /** lock screen (POST /api/auth/verify-password): a 400, so clients do not treat it as an ended session */
  AUTH_PASSWORD_WRONG: def('A1010', 400, 'error.auth.password_wrong'),
  /** Check rejected an unknown, expired or used challenge id, or a wrong answer. */
  AUTH_CAPTCHA_INVALID: def('A1020', 400, 'error.auth.captcha_invalid'),
  /** A route needing a ticket got none, or received a spent or foreign ticket. */
  AUTH_CAPTCHA_REQUIRED: def('A1021', 403, 'error.auth.captcha_required'),
  /** WeChat mini program sign-in: a used or rejected `uni.login` code */
  AUTH_WX_MP_CODE_INVALID: def('A1030', 400, 'error.auth.wx_mp_code_invalid'),
  /** bind: an unknown, used or expired bind ticket, or one issued to another IP */
  AUTH_WX_MP_TICKET_INVALID: def('A1031', 400, 'error.auth.wx_mp_ticket_invalid'),
  /** bind: this WeChat account is bound to a user already */
  AUTH_WX_MP_BOUND: def('A1032', 409, 'error.auth.wx_mp_bound'),
  /** bind: the user has a WeChat binding for this mini program already (unbind it first) */
  AUTH_WX_MP_USER_BOUND: def('A1033', 409, 'error.auth.wx_mp_user_bound'),
  /** WeChat sign-in of a bound account that is disabled */
  AUTH_WX_MP_REFUSED: def('A1034', 403, 'error.auth.wx_mp_refused'),
  /** WeChat's code2Session could not be reached or failed (nothing of its answer is echoed) */
  AUTH_WX_MP_UPSTREAM: def('A1035', 502, 'error.auth.wx_mp_upstream'),

  /**
   * GrantPolicy (see docs/design-notes.md#permissions): a non-root caller gave a role holding perms they lack, a role whose data
   * scope is wider than theirs (`all`, picked or relative depts outside their scope), or the root role
   */
  IAM_GRANT_EXCEEDS_OWN: def('B1001', 403, 'error.iam.grant_exceeds_own'),
  /** users cannot delete or disable their own account */
  IAM_USER_SELF: def('B1002', 422, 'error.iam.user_self'),
  /** a user holding the builtin root role: never deleted, disabled or stripped of it; non-root callers leave it alone */
  IAM_USER_PROTECTED: def('B1003', 422, 'error.iam.user_protected'),
  /** a new user without a password while the `iam.user.initial_password` param is unset or fails the policy */
  IAM_INITIAL_PASSWORD_UNSET: def('B1004', 422, 'error.iam.initial_password_unset'),
  /** a dept that users belong to cannot be deleted */
  IAM_DEPT_HAS_USERS: def('B1005', 409, 'error.iam.dept_has_users'),
  /** a menu under a parent that does not hold its kind (actions only under pages, nothing under actions) */
  IAM_MENU_PARENT_KIND: def('B1006', 422, 'error.iam.menu_parent_kind'),
  /** a menu granted to a role cannot be deleted (take it out of the roles first) */
  IAM_MENU_GRANTED: def('B1007', 409, 'error.iam.menu_granted'),
  /**
   * builtin roles keep their code and are never deleted; the root role is also never disabled, given
   * menus or a data scope (it holds `*` and `all`), and only a root caller edits it
   */
  IAM_ROLE_BUILTIN: def('B1008', 422, 'error.iam.role_builtin'),
  /** a role that users hold cannot be deleted (take them out of it first) */
  IAM_ROLE_HAS_USERS: def('B1009', 409, 'error.iam.role_has_users'),
  IAM_OWN_MOBILE_IN_PROFILE: def('B1010', 422, 'error.iam.own_mobile_in_profile'),
  IAM_MOBILE_CHANGE_UNAVAILABLE: def('B1011', 422, 'error.iam.mobile_change_unavailable'),
  /**
   * a group menu keeps its route name once saved: the natural key seeds and generated pages
   * find it by (one outside the group format may still be corrected)
   */
  IAM_MENU_ROUTE_NAME_FIXED: def('B1012', 422, 'error.iam.menu_route_name_fixed'),

  /** builtin params (seeded) are never deleted and keep whether they are public */
  SETTINGS_PARAM_BUILTIN: def('B2001', 422, 'error.settings.param_builtin'),
  /** a secret param is never readable before sign-in */
  SETTINGS_PARAM_SECRET_PUBLIC: def('B2002', 422, 'error.settings.param_secret_public'),

  MAIL_HOST_REFUSED: def('B3101', 422, 'error.messaging.mail_host_refused'),
  MAIL_PASSWORD_REQUIRED: def('B3102', 422, 'error.messaging.mail_password_required'),
  SMS_CHANNEL_INCOMPLETE: def('B3201', 422, 'error.messaging.sms_channel_incomplete'),
  SMS_TOO_FREQUENT: def('B3211', 429, 'error.messaging.sms_too_frequent'),

  /**
   * OAuth2 authorization request: unknown, disabled or first-party client, no
   * authorization_code grant, or a `redirect_uri` it has not registered (exact match)
   */
  OAUTH_CLIENT_INVALID: def('B4001', 400, 'error.oauth.client_invalid'),
  /** OAuth2 authorization request: `response_type` ≠ `code`, or a scope outside the client's (none left) */
  OAUTH_REQUEST_INVALID: def('B4002', 400, 'error.oauth.request_invalid'),
  /** userinfo with a token acting for no user (client_credentials) */
  OAUTH_INSUFFICIENT_SCOPE: def('B4003', 403, 'error.oauth.insufficient_scope'),
  /** a built-in client (`console`) is read-only: change, enable/disable, reset secret, delete */
  OAUTH_CLIENT_BUILTIN: def('B4010', 422, 'error.oauth.client_builtin'),

  /** upload without a `file` part */
  STORAGE_FILE_REQUIRED: def('C1001', 400, 'error.storage.file_required'),
  /** extension not allowed, or the content (magic number) is not what the extension says; params `{ ext }` */
  STORAGE_TYPE_REJECTED: def('C1002', 422, 'error.storage.type_rejected'),
  /** public business tags (avatar, richtext, cover) take png/jpeg/gif/webp images only */
  STORAGE_PUBLIC_IMAGE_ONLY: def('C1003', 422, 'error.storage.public_image_only'),
  /**
   * an S3 endpoint on an internal address or an unregistered port (core/net; see docs/design-notes.md#security); names are
   * checked when connecting (test connection → `{ok: false}`)
   */
  STORAGE_ENDPOINT_REFUSED: def('C1004', 422, 'error.storage.endpoint_refused'),
  /** the primary storage is never disabled or deleted; a disabled storage never becomes primary */
  STORAGE_PRIMARY_LOCKED: def('C1005', 422, 'error.storage.primary_locked'),
  /** a storage keeps the driver it was added with */
  STORAGE_DRIVER_FIXED: def('C1006', 422, 'error.storage.driver_fixed'),
  /** direct upload (presign) while the primary storage is not S3 */
  STORAGE_DIRECT_UNAVAILABLE: def('C1007', 422, 'error.storage.direct_unavailable'),
  /** confirm: the stored object's size or sniffed type is not what was presigned (it is deleted) */
  STORAGE_UPLOAD_MISMATCH: def('C1008', 422, 'error.storage.upload_mismatch'),
  /** a referenced file is not the caller's own, still unbound upload of the expected tag (`bindRefs`) */
  STORAGE_REF_INVALID: def('C1009', 400, 'error.storage.ref_invalid'),
  STORAGE_SECRET_REQUIRED: def('C1010', 422, 'error.storage.secret_required'),

  /**
   * codegen import / sync: the table is not a base table of this database, is a framework table
   * (meta_, test_, cg_) or is already imported; params `{ table }`
   */
  CODEGEN_TABLE_UNAVAILABLE: def('C3001', 422, 'error.codegen.table_unavailable'),
  /**
   * a table or column name outside the generator's identifier whitelist (see docs/design-notes.md#codegen), a class / field
   * name the generated code uses already (`CG_RESERVED`) or a reserved name as a project domain
   * (`cgDomainAllowed`); params `{ name }`
   */
  CODEGEN_IDENTIFIER_INVALID: def('C3002', 422, 'error.codegen.identifier_invalid'),
  /** `withOptions` on a table without a label column (a name / title or any text column); params `{ table }` */
  CODEGEN_OPTIONS_LABEL_MISSING: def('C3003', 422, 'error.codegen.options_label_missing'),
  /**
   * the `tree` template on a table without `parent_id` + `tree_path` (as `parentId` / `treePath`) or a
   * text label column; params `{ table }`
   */
  CODEGEN_TREE_COLUMNS: def('C3004', 422, 'error.codegen.tree_columns'),
  /** `POST /api/codegen/tables/write` where the server does not run with NODE_ENV=development + CODEGEN_WRITE=true */
  CODEGEN_WRITE_DISABLED: def('C3005', 422, 'error.codegen.write_disabled'),
  /** two configs of one download / write render the same file (same group, domain and business); params `{ path }` */
  CODEGEN_PATH_CONFLICT: def('C3006', 422, 'error.codegen.path_conflict'),
  /**
   * the `master_sub` template on a table without a sub-table config pointing at it, or a sub-table config
   * whose master is missing / itself or whose `sub_fk_col` is no integer column of its own; params `{ table }`
   */
  CODEGEN_SUB_TABLES: def('C3007', 422, 'error.codegen.sub_tables'),
  /** a config's parent menu is no group menu with that route name; params `{ name }` */
  CODEGEN_PARENT_MENU: def('C3008', 422, 'error.codegen.parent_menu'),
  /**
   * a config's `referencedBy` names a column that is not in this database, or one of a table without
   * `deleted_at` (the reference check reads live rows); params `{ table, column }`
   */
  CODEGEN_REFERENCE: def('C3009', 422, 'error.codegen.reference'),
  /**
   * a table without `deleted_at` (every generated entity soft-deletes): on import (the whole batch),
   * the defaults of a table not imported, render / preview / download / write and sync; params `{ table }`
   */
  CODEGEN_NO_DELETED_AT: def('C3010', 422, 'error.codegen.no_deleted_at'),
  /**
   * a config's class name (its exported identifiers) or module (domain + business) is another config's,
   * also after the domain went in front of the class name; params `{ table }` (the other)
   */
  CODEGEN_NAME_CONFLICT: def('C3011', 422, 'error.codegen.name_conflict'),
  /**
   * a config's page route name (`<domain>-<business>`) is a group's or an action's (live or deleted) or one
   * of its parent chain (its seed would take that menu over); params `{ name }`
   */
  CODEGEN_ROUTE_NAME_CLASH: def('C3012', 422, 'error.codegen.route_name_clash'),

  /** a task naming a handler outside the `@JobHandler` registry (whitelist); params `{ handler }` */
  SCHEDULER_HANDLER_UNKNOWN: def('C2001', 422, 'error.scheduler.handler_unknown'),

  /**
   * a review node resolved to nobody and its `whenNobody` target (the process managers / the fallback user)
   * is nobody enabled either; params `{ node }` (the node name; a seeded model's names are `seed.` i18n
   * keys, which the error filter translates into the request language, like every `seed.` param)
   */
  WF_NO_ASSIGNEE: def('D1001', 422, 'error.wf.no_assignee'),
  /** publishing a `custom` model whose `model_key` has no `WfBusinessHandler` (no fields to compile against); params `{ modelKey }` */
  WF_HANDLER_MISSING: def('D1002', 422, 'error.wf.handler_missing'),
  /**
   * transfer / delegate / add-sign, reassign / 改派: no target, or one that is no enabled
   * user or already holds an open task on the step (the task's holder included)
   */
  WF_BAD_TARGET: def('D1101', 422, 'error.wf.bad_target'),
  /** approve / reject on a step with `commentRequired` without a comment */
  WF_COMMENT_REQUIRED: def('D1102', 422, 'error.wf.comment_required'),
} as const satisfies Record<string, ErrorDef>

export type ErrName = keyof typeof Err
