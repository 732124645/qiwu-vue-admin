// settings seed (see docs/design-notes.md#i18n): the dictionaries and runtime parameters.
// Dict labels and param names are mode B (`*_i18n` JSON); the plain `label`/`name` column holds zh-CN.
import {
  APP_UPDATE_PARAMS,
  CAPTCHA_IMAGE_TYPE_PARAM,
  CAPTCHA_MODE_PARAM,
  DEFAULT_CAPTCHA_IMAGE_TYPE,
  DEFAULT_CAPTCHA_MODE,
  AUDIT_RETENTION_PARAM,
  DEFAULT_AUDIT_RETENTION_DAYS,
  DEFAULT_LOGIN_SECURITY,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_EXCEL_IMPORT_LIMITS,
  DEFAULT_HTTP_TRACE_EXCLUDE,
  DEFAULT_HTTP_TRACE_MODE,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_PARAM,
  excelImportParams,
  HTTP_TRACE_EXCLUDE_PARAM,
  HTTP_TRACE_MODE_PARAM,
  IP_BLACKLIST_PARAM,
  loginSecurityParams,
  passwordPolicyParams,
  signupParams,
  DEFAULT_SIGNUP,
  type Locale,
  WX_MP_ENABLED_PARAM,
  WX_SUBSCRIBE_ENABLED_PARAM,
  WX_SUBSCRIBE_TEMPLATES_PARAM,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { softDeleteWhere } from '../../../core/db/references.js'
import { findId, findRow, insertRow, type Row, upsert } from '../upsert.js'

/** Every language, always: the type requires both and i18n:check rule 5 checks the literals. */
type Texts = Record<Locale, string>

export interface DictSeed {
  code: string
  nameI18n: Texts
  entries: { value: string; labelI18n: Texts; tagType?: string; isDefault?: boolean }[]
}

/** Values are the API's string codes; booleans travel as 'true'/'false'. */
const DICTS: DictSeed[] = [
  {
    code: 'core.locale',
    nameI18n: { 'zh-CN': '语言', 'en-US': 'Language' },
    entries: [
      {
        value: 'zh-CN',
        labelI18n: { 'zh-CN': '简体中文', 'en-US': 'Simplified Chinese' },
        isDefault: true,
      },
      { value: 'en-US', labelI18n: { 'zh-CN': '英语', 'en-US': 'English' } },
    ],
  },
  {
    code: 'core.enabled',
    nameI18n: { 'zh-CN': '启用状态', 'en-US': 'Enabled status' },
    entries: [
      {
        value: 'true',
        labelI18n: { 'zh-CN': '启用', 'en-US': 'Enabled' },
        tagType: 'success',
        isDefault: true,
      },
      { value: 'false', labelI18n: { 'zh-CN': '停用', 'en-US': 'Disabled' }, tagType: 'info' },
    ],
  },
  {
    code: 'core.yes_no',
    nameI18n: { 'zh-CN': '是否', 'en-US': 'Yes or no' },
    entries: [
      { value: 'true', labelI18n: { 'zh-CN': '是', 'en-US': 'Yes' }, tagType: 'success' },
      { value: 'false', labelI18n: { 'zh-CN': '否', 'en-US': 'No' }, tagType: 'info' },
    ],
  },
  {
    // the tag styles of dict entries (`tag_type`): each shown in its own style
    code: 'settings.tag_type',
    nameI18n: { 'zh-CN': '标签样式', 'en-US': 'Tag style' },
    entries: [
      { value: 'primary', labelI18n: { 'zh-CN': '主要', 'en-US': 'Primary' }, tagType: 'primary' },
      { value: 'success', labelI18n: { 'zh-CN': '成功', 'en-US': 'Success' }, tagType: 'success' },
      { value: 'info', labelI18n: { 'zh-CN': '信息', 'en-US': 'Info' }, tagType: 'info' },
      { value: 'warning', labelI18n: { 'zh-CN': '警告', 'en-US': 'Warning' }, tagType: 'warning' },
      { value: 'danger', labelI18n: { 'zh-CN': '危险', 'en-US': 'Danger' }, tagType: 'danger' },
    ],
  },
  {
    code: 'settings.app_platform',
    nameI18n: { 'zh-CN': 'App 平台', 'en-US': 'App platform' },
    entries: [
      { value: 'android', labelI18n: { 'zh-CN': '安卓', 'en-US': 'Android' } },
      { value: 'ios', labelI18n: { 'zh-CN': 'iOS', 'en-US': 'iOS' } },
    ],
  },
  {
    code: 'settings.app_package_kind',
    nameI18n: { 'zh-CN': 'App 更新包类型', 'en-US': 'App package kind' },
    entries: [
      {
        value: 'wgt',
        labelI18n: { 'zh-CN': '资源热更新包', 'en-US': 'Resource package (hot update)' },
        tagType: 'primary',
      },
      {
        value: 'full',
        labelI18n: { 'zh-CN': '整包', 'en-US': 'Full package' },
        tagType: 'warning',
      },
    ],
  },
  {
    code: 'iam.gender',
    nameI18n: { 'zh-CN': '性别', 'en-US': 'Gender' },
    entries: [
      { value: 'male', labelI18n: { 'zh-CN': '男', 'en-US': 'Male' } },
      { value: 'female', labelI18n: { 'zh-CN': '女', 'en-US': 'Female' } },
      {
        value: 'unknown',
        labelI18n: { 'zh-CN': '未说明', 'en-US': 'Not specified' },
        isDefault: true,
      },
    ],
  },
  {
    code: 'iam.data_scope',
    nameI18n: { 'zh-CN': '数据范围', 'en-US': 'Data scope' },
    entries: [
      { value: 'all', labelI18n: { 'zh-CN': '全部数据', 'en-US': 'All data' } },
      {
        value: 'picked_depts',
        labelI18n: { 'zh-CN': '指定部门', 'en-US': 'Selected departments' },
      },
      { value: 'own_dept', labelI18n: { 'zh-CN': '本部门', 'en-US': 'Own department' } },
      {
        value: 'own_dept_tree',
        labelI18n: { 'zh-CN': '本部门及下级', 'en-US': 'Own department and below' },
      },
      { value: 'own_rows', labelI18n: { 'zh-CN': '仅本人', 'en-US': 'Own records only' } },
    ],
  },
  {
    code: 'iam.menu_kind',
    nameI18n: { 'zh-CN': '菜单类型', 'en-US': 'Menu kind' },
    entries: [
      { value: 'group', labelI18n: { 'zh-CN': '目录', 'en-US': 'Group' } },
      { value: 'page', labelI18n: { 'zh-CN': '页面', 'en-US': 'Page' } },
      { value: 'action', labelI18n: { 'zh-CN': '操作', 'en-US': 'Action' } },
    ],
  },
  {
    code: 'iam.menu_link_type',
    nameI18n: { 'zh-CN': '菜单链接方式', 'en-US': 'Menu link type' },
    entries: [
      { value: 'route', labelI18n: { 'zh-CN': '页面路由', 'en-US': 'Route' } },
      { value: 'iframe', labelI18n: { 'zh-CN': '内嵌网页', 'en-US': 'Embedded page' } },
      { value: 'external', labelI18n: { 'zh-CN': '外部链接', 'en-US': 'External link' } },
    ],
  },
]

interface ParamSeed {
  key: string
  value: string | number
  nameI18n: Texts
  isPublic?: boolean
}

const PARAMS: ParamSeed[] = [
  {
    key: CAPTCHA_MODE_PARAM,
    // Test and e2e databases run NODE_ENV=test; captcha specs enable it locally.
    value: process.env.NODE_ENV === 'test' ? 'off' : DEFAULT_CAPTCHA_MODE,
    nameI18n: {
      'zh-CN': '验证码模式（off 关闭 / image 图形 / slider 滑块）',
      'en-US': 'Captcha mode (off / image / slider)',
    },
    isPublic: true,
  },
  {
    key: CAPTCHA_IMAGE_TYPE_PARAM,
    value: DEFAULT_CAPTCHA_IMAGE_TYPE,
    nameI18n: {
      'zh-CN': '图形验证码题型（math 算术 / chars 字符）',
      'en-US': 'Image captcha type (math / chars)',
    },
  },
  {
    key: loginSecurityParams.lockThreshold,
    value: DEFAULT_LOGIN_SECURITY.lockThreshold,
    nameI18n: { 'zh-CN': '登录失败锁定次数', 'en-US': 'Failed sign-ins before lock' },
  },
  {
    key: loginSecurityParams.lockMinutes,
    value: DEFAULT_LOGIN_SECURITY.lockMinutes,
    nameI18n: { 'zh-CN': '登录锁定时长（分钟）', 'en-US': 'Sign-in lock duration (minutes)' },
  },
  {
    key: loginSecurityParams.crossIpThreshold,
    value: DEFAULT_LOGIN_SECURITY.crossIpThreshold,
    nameI18n: {
      'zh-CN': '跨 IP 登录失败阈值（每小时）',
      'en-US': 'Failed sign-ins across IPs per hour',
    },
  },
  {
    key: IP_BLACKLIST_PARAM,
    value: '',
    nameI18n: { 'zh-CN': '登录 IP 黑名单', 'en-US': 'Sign-in IP blacklist' },
  },
  {
    key: signupParams.enabled,
    value: String(DEFAULT_SIGNUP.enabled),
    nameI18n: { 'zh-CN': '开放注册', 'en-US': 'Allow sign-up' },
    isPublic: true,
  },
  {
    key: WX_MP_ENABLED_PARAM,
    value: 'false',
    nameI18n: { 'zh-CN': '微信小程序登录', 'en-US': 'WeChat mini program sign-in' },
    isPublic: true,
  },
  {
    key: WX_SUBSCRIBE_ENABLED_PARAM,
    value: 'false',
    nameI18n: { 'zh-CN': '微信订阅消息提醒', 'en-US': 'WeChat subscribe-message reminders' },
  },
  {
    // WeChat subscribe messages: copy the id and the field keys of the template picked in the mini program admin
    key: WX_SUBSCRIBE_TEMPLATES_PARAM,
    value: JSON.stringify({
      'wf.task.assigned': {
        id: '',
        page: 'pages-wf/detail/index?id={instanceId}',
        data: { thing1: '{title}', time2: '{time}' },
      },
    }),
    nameI18n: {
      'zh-CN': '微信订阅消息模板（按通知编码）',
      'en-US': 'WeChat subscribe templates by notification code',
    },
  },
  {
    // App updates: GET /api/settings/app-versions/latest answers null while off
    key: APP_UPDATE_PARAMS.enabled,
    value: 'false',
    nameI18n: { 'zh-CN': 'App 热更新与版本提示', 'en-US': 'App update prompts' },
  },
  {
    // set before submitting a native version to a store, cleared once approved: it gets no wgt meanwhile
    key: APP_UPDATE_PARAMS.reviewVersion,
    value: '',
    nameI18n: { 'zh-CN': '审核中的原生版本', 'en-US': 'Native version in store review' },
  },
  {
    key: signupParams.defaultRoleId,
    value: '',
    nameI18n: { 'zh-CN': '注册默认角色 ID', 'en-US': 'Default sign-up role ID' },
  },
  {
    key: signupParams.defaultDeptId,
    value: '',
    nameI18n: { 'zh-CN': '注册默认部门 ID', 'en-US': 'Default sign-up department ID' },
  },
  {
    key: passwordPolicyParams.minLength,
    value: DEFAULT_PASSWORD_POLICY.minLength,
    nameI18n: { 'zh-CN': '密码最小长度', 'en-US': 'Minimum password length' },
    isPublic: true,
  },
  {
    key: passwordPolicyParams.charClasses,
    value: DEFAULT_PASSWORD_POLICY.charClasses,
    nameI18n: { 'zh-CN': '密码最少字符类别数', 'en-US': 'Minimum password character classes' },
    isPublic: true,
  },
  {
    key: passwordPolicyParams.expireDays,
    value: DEFAULT_PASSWORD_POLICY.expireDays,
    nameI18n: {
      'zh-CN': '密码有效天数（0 为不过期）',
      'en-US': 'Password validity in days (0 = never expires)',
    },
  },
  {
    key: DEFAULT_TIMEZONE_PARAM,
    value: DEFAULT_TIMEZONE,
    nameI18n: { 'zh-CN': '默认时区', 'en-US': 'Default time zone' },
    isPublic: true,
  },
  {
    key: excelImportParams.maxMb,
    value: DEFAULT_EXCEL_IMPORT_LIMITS.maxMb,
    nameI18n: { 'zh-CN': 'Excel 导入文件上限（MB）', 'en-US': 'Excel import file limit (MB)' },
  },
  {
    key: excelImportParams.maxRows,
    value: DEFAULT_EXCEL_IMPORT_LIMITS.maxRows,
    nameI18n: { 'zh-CN': 'Excel 导入行数上限', 'en-US': 'Excel import row limit' },
  },
  {
    key: excelImportParams.maxColumns,
    value: DEFAULT_EXCEL_IMPORT_LIMITS.maxColumns,
    nameI18n: { 'zh-CN': 'Excel 导入列数上限', 'en-US': 'Excel import column limit' },
  },
  {
    key: AUDIT_RETENTION_PARAM,
    value: DEFAULT_AUDIT_RETENTION_DAYS,
    nameI18n: {
      'zh-CN': '日志与记录保留天数（操作/登录/API/任务日志、消息记录、短信验证码、已删除文件）',
      'en-US':
        'Retention in days (action, sign-in, API and job logs, message records, SMS codes, deleted files)',
    },
  },
  {
    key: HTTP_TRACE_MODE_PARAM,
    value: DEFAULT_HTTP_TRACE_MODE,
    nameI18n: {
      'zh-CN': 'API 访问日志（off 关闭 / write 写操作 / all 全部）',
      'en-US': 'API access log (off / write: writes only / all)',
    },
  },
  {
    key: HTTP_TRACE_EXCLUDE_PARAM,
    value: DEFAULT_HTTP_TRACE_EXCLUDE,
    nameI18n: {
      'zh-CN': 'API 访问日志排除路径（[方法] 路径前缀，逗号或换行分隔）',
      'en-US': 'API access log excluded paths ([method] path prefix, by comma or line)',
    },
  },
]

/**
 * Dicts by code and their entries by code + value (sort_no in list order); `label`/`name` hold zh-CN.
 * What the dict pages edit (names, labels, sort, tag style, default) is written on insert only: a re-seed
 * keeps an admin's edits and only adds the languages a row lacks (a release with
 * a new language); missing dicts and entries are inserted, deleted ones stay deleted.
 */
export async function upsertDicts(q: EntityManager, dicts: DictSeed[]): Promise<void> {
  for (const dict of dicts) {
    await seedDictRow(
      q,
      'cfg_dict',
      { code: dict.code },
      { name: dict.nameI18n['zh-CN'] },
      'name_i18n',
      dict.nameI18n,
    )
    for (const [i, e] of dict.entries.entries())
      await seedDictRow(
        q,
        'cfg_dict_entry',
        { dict_code: dict.code, value: e.value },
        {
          label: e.labelI18n['zh-CN'],
          sort_no: (i + 1) * 10,
          tag_type: e.tagType ?? null,
          is_default: e.isDefault ? 1 : 0,
        },
        'label_i18n',
        e.labelI18n,
      )
  }
}

/** Inserts a missing row; a live one only gets the languages of `texts` it lacks (its own ones win). */
async function seedDictRow(
  q: EntityManager,
  table: 'cfg_dict' | 'cfg_dict_entry',
  key: Row,
  row: Row,
  column: 'name_i18n' | 'label_i18n',
  texts: Texts,
): Promise<void> {
  const found = await findRow(q, table, key)
  if (!found) await insertRow(q, table, { ...key, ...row, [column]: texts })
  else if (!found.deleted)
    await q.query(
      // arch-allow: sql-concat table and column names are the constants above; every value is bound
      `UPDATE ${table} SET ${column} = JSON_MERGE_PATCH(CAST(? AS JSON), COALESCE(${column}, JSON_OBJECT()))
        WHERE id = ?`,
      [JSON.stringify(texts), found.id],
    )
}

/** Dicts and entries by code(+value), params by key (value only on insert: admins own it), menus. */
export async function seedSettings(q: EntityManager): Promise<string[]> {
  await upsertDicts(q, DICTS)
  for (const p of PARAMS)
    await upsert(
      q,
      'cfg_param',
      { param_key: p.key },
      {
        name: p.nameI18n['zh-CN'],
        name_i18n: p.nameI18n,
        group_code: p.key.split('.')[0],
        is_builtin: 1,
        is_public: p.isPublic ? 1 : 0,
      },
      {
        param_value:
          p.key === signupParams.defaultRoleId
            ? String((await findId(q, 'iam_role', { code: 'member' })) ?? '')
            : String(p.value),
      },
    )

  // the early read-only dictionary viewer, replaced by the dict page: gone from older databases too
  // (its action `settings.dict.browse` moves to the dict page, seedDict upserts it by perms right after)
  const viewer = await findId(q, 'iam_menu', { route_name: 'settings-dict-viewer' })
  if (viewer !== undefined) {
    await softDeleteWhere(q, 'iam_role_menus', 'menu_id', [viewer])
    await softDeleteWhere(q, 'iam_menu', 'id', [viewer])
  }
  return []
}
