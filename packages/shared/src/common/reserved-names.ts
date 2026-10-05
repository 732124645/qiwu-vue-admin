/**
 * Names a project domain never takes: a project domain is the first path
 * segment of its code (`modules/<domain>/`, `views/<domain>/`, `api/<domain>/`, shared `src/<domain>/`),
 * its API root (`/api/<domain>/…`), its route root and its locale namespace, so it must not be any of the
 * template's own. The generator derives `biz` for a table whose first name segment is one of these, and a
 * save / render of a project config with such a domain is refused (422 C3002).
 *
 * scripts/arch/reserved-names.mjs reads the lists below as text (keep each a plain backquoted list) and
 * checks them against the real tree: every controller root, locale namespace and top-level code directory
 * of the template is listed here, and every static route name of the web router (or its first segment).
 * scripts/arch/project-layers.mjs takes `layers` + `pages` as the directories that are no project domain
 * (platform and workflow must not import any other).
 */
export const RESERVED_NAME_LISTS = {
  /** code layers, shared top-level directories */
  layers: `core platform workflow common i18n validation`,
  /**
   * web top-level core page directories and static routes (`/sso`), and every static route name or its
   * first segment (`403`, `my-inbox` → `my`): a generated page's route name `<domain>-<business>` never
   * replaces one
   */
  pages: `home login profile error lock register redirect iframe password-change password-reset sso password my not 403 404 503`,
  /** built-in domains (platform, workflow) and the built-in project domains `biz` and `demo` */
  domains: `iam settings messaging audit storage scheduler oauth wf codegen monitor geo formkit apidocs demo biz im`,
  /** other API roots, and the paths the web server proxies or serves (`/api`, `/files`, `/assets`) */
  apiRoots: `auth health excel docs oauth2 api files assets`,
  /** locale namespaces beside the domains' */
  namespaces: `menu crud layout field seed picker upload captcha code cron notify signin`,
} as const

/** Every reserved name (the union of the lists). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(
  Object.values(RESERVED_NAME_LISTS).join(' ').split(/\s+/),
)

/**
 * The built-in project domains: `biz` (the "Business" group, tables without an own domain) and the
 * samples' `demo`; reserved, yet a project config may use them.
 */
export const PROJECT_BUILTIN_DOMAINS: readonly string[] = ['biz', 'demo']

/**
 * The web router's static route names (apps/web/src/core/router/index.ts `staticRoutes`, exactly: the arch
 * check reads both): a menu never takes one as its route name (400), or its route would replace the
 * built-in page (`router.addRoute` by name).
 */
export const WEB_STATIC_ROUTE_NAMES: readonly string[] = [
  'login',
  'register',
  'password-reset',
  'password-change',
  'lock',
  'sso',
  '403',
  '404',
  '503',
  'layout',
  'redirect',
  'profile',
  'my-inbox',
  'not-found',
]
