// codegen/rules.ts (rule table; see docs/design-notes.md#codegen): one case per row, plus the TS type map, the naming helpers
// and that every default passes the shared whitelist schemas; the project domains (derivation,
// reserved names, qualified class names, module paths). Pure: no database.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CG_IDENT,
  cgColumnFields,
  cgDictCode,
  cgDomainAllowed,
  type CgParentMenuNode,
  cgTableFields,
  Err,
  RESERVED_NAMES,
} from '@qiwu/shared'
import type { ColumnInfo } from '../../src/core/db/schema-info.js'
import {
  defaultParent,
  type GroupRow,
  groupForest,
  groupLines,
  pickableGroups,
} from '../../src/modules/platform/codegen/groups.js'
import {
  assertDeletedAt,
  assertNamesFree,
  camel,
  EXCLUDED_TABLE,
  humanize,
  importHints,
  initColumn,
  initTable,
  labelOf,
  pascal,
  qualifyNames,
  TABLE_PREFIXES,
  tsTypeOf,
} from '../../src/modules/platform/codegen/rules.js'
import {
  crudModel,
  crudRegistration,
  crudTargets,
  type RenderConfig,
  renderCrud,
} from '../../src/modules/platform/codegen/crud.js'

/** A NOT NULL column without default, comment and key unless overridden. */
const col = (name: string, columnType: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  columnType,
  nullable: false,
  comment: '',
  default: null,
  isPk: false,
  autoIncrement: false,
  generated: false,
  unique: false,
  ...over,
})
const init = (name: string, columnType: string, over: Partial<ColumnInfo> = {}) => {
  const c = initColumn(col(name, columnType, over), 'demo', 10)
  if (!c) throw new Error(`${name} was ignored`)
  return c
}
const pick = (name: string, columnType: string, over: Partial<ColumnInfo> = {}) => {
  const c = init(name, columnType, over)
  return {
    widget: c.widget,
    inList: c.inList,
    inForm: c.inForm,
    inQuery: c.inQuery,
    queryOp: c.queryOp,
  }
}

describe('rule table (one row each)', () => {
  it('audit columns: never in forms; created_at listed + range query; alive and generated columns ignored', () => {
    for (const name of ['created_by', 'updated_by'])
      expect(pick(name, 'bigint unsigned', { nullable: true })).toMatchObject({
        inList: false,
        inForm: false,
        inQuery: false,
      })
    for (const name of ['updated_at', 'deleted_at'])
      expect(pick(name, 'datetime(3)', { nullable: true })).toMatchObject({
        inList: false,
        inForm: false,
        inQuery: false,
      })
    expect(init('created_at', 'datetime(3)', { default: 'CURRENT_TIMESTAMP(3)' })).toMatchObject({
      widget: 'datetime',
      inList: true,
      inForm: false,
      inQuery: true,
      queryOp: 'between',
      sortable: true,
      required: false,
    })
    expect(initColumn(col('alive', 'tinyint', { generated: true }), 'demo', 0)).toBeNull()
    expect(initColumn(col('primary_one', 'tinyint', { generated: true }), 'demo', 0)).toBeNull()
  })

  it('primary key: read-only, not listed, not required', () => {
    expect(
      init('id', 'bigint unsigned', { isPk: true, autoIncrement: true, comment: 'ID' }),
    ).toMatchObject({
      isPk: true,
      isAutoInc: true,
      inList: false,
      inForm: false,
      inQuery: false,
      required: false,
    })
  })

  it('varchar ≤ 255: an input; *name / *title (and codes) searched by LIKE; longer: a textarea', () => {
    expect(pick('isbn', 'varchar(20)')).toEqual({
      widget: 'input',
      inList: true,
      inForm: true,
      inQuery: false,
      queryOp: 'eq',
    })
    for (const name of ['name', 'display_name', 'title', 'code'])
      expect(pick(name, 'varchar(255)')).toMatchObject({
        widget: 'input',
        inQuery: true,
        queryOp: 'like',
      })
    expect(init('title', 'varchar(200)').sortable).toBe(true)
    expect(pick('note', 'varchar(500)', { nullable: true })).toMatchObject({
      widget: 'textarea',
      inList: true,
      inQuery: false,
    })
  })

  it('nullable *_enc chars become write-only secrets with labels before the box note', () => {
    for (const type of ['varchar(512)', 'char(200)']) {
      expect(
        init('password_enc', type, { nullable: true, comment: '密码（SecretBox 密文）' }),
      ).toMatchObject({
        fieldName: 'passwordEnc',
        widget: 'secret',
        inList: false,
        inForm: true,
        inQuery: false,
        sortable: false,
        required: false,
        labelI18n: { 'zh-CN': '密码', 'en-US': 'Password' },
      })
    }
    expect(init('api_secret_enc', 'varchar(512)', { nullable: true }).labelI18n).toEqual({
      'zh-CN': 'Api secret',
      'en-US': 'Api secret',
    })
    expect(init('password_enc', 'varchar(512)').widget).not.toBe('secret')
    expect(init('password_enc', 'text', { nullable: true }).widget).not.toBe('secret')
  })

  it('text / mediumtext: a textarea, content/body a rich text editor; not listed', () => {
    expect(pick('summary', 'text')).toMatchObject({ widget: 'textarea', inList: false })
    expect(pick('content', 'mediumtext')).toMatchObject({ widget: 'richtext', inList: false })
    expect(pick('mail_body', 'text')).toMatchObject({ widget: 'richtext' })
  })

  it('enabled / is_* tinyint(1): a switch over core.enabled / core.yes_no, searched by equality', () => {
    expect(init('enabled', 'tinyint(1)', { default: '1' })).toMatchObject({
      tsType: 'boolean',
      widget: 'switch',
      inQuery: true,
      queryOp: 'eq',
      dictCode: 'core.enabled',
      required: false,
    })
    expect(init('is_public', 'tinyint(1)', { default: '0' })).toMatchObject({
      widget: 'switch',
      dictCode: 'core.yes_no',
    })
  })

  it('short varchar *_kind / *_type / *_status: a select pointed at the dict <domain>.<column>', () => {
    for (const name of ['leave_kind', 'user_type', 'order_status', 'kind', 'type', 'status'])
      expect(init(name, 'varchar(24)')).toMatchObject({
        widget: 'select',
        inQuery: true,
        queryOp: 'eq',
        dictCode: `demo.${name}`,
      })
    // long varchar or another name: no dict hint
    expect(init('order_status', 'varchar(64)')).toMatchObject({ widget: 'input', dictCode: null })
    expect(init('genre', 'varchar(16)')).toMatchObject({ widget: 'input', dictCode: null })
    expect(init('subtype', 'varchar(16)')).toMatchObject({ widget: 'input', dictCode: null })
    // a bare name: the table's business in front (msg_bulletin.kind → messaging.bulletin_kind)
    expect(initColumn(col('kind', 'varchar(24)'), 'messaging', 10, 'bulletin')).toMatchObject({
      dictCode: 'messaging.bulletin_kind',
    })
    expect(initColumn(col('status', 'varchar(24)'), 'biz', 10, 'leave-request')).toMatchObject({
      dictCode: 'biz.leave_request_status',
    })
  })

  it('datetime / date: datetime / date widgets, searched as a range', () => {
    expect(pick('published_on', 'date', { nullable: true })).toMatchObject({
      widget: 'date',
      inQuery: true,
      queryOp: 'between',
    })
    expect(pick('issued_at', 'datetime(3)')).toMatchObject({
      widget: 'datetime',
      inQuery: true,
      queryOp: 'between',
    })
  })

  it('decimal / int / bigint: a number input, sortable', () => {
    for (const type of ['decimal(10,2)', 'int', 'bigint unsigned', 'smallint'])
      expect(init('qty', type, { default: '0' })).toMatchObject({
        widget: 'number',
        tsType: 'number',
        sortable: true,
        inQuery: false,
      })
  })

  it('a decimal wider than 15 digits (a JS number): a text input over its digits as a string', () => {
    expect(init('amount', 'decimal(20,4)', { default: '0.0000' })).toMatchObject({
      widget: 'input',
      tsType: 'string',
      sortable: true,
    })
    expect(init('amount', 'decimal(15,4)')).toMatchObject({ widget: 'number', tsType: 'number' })
  })

  it('image / avatar and file / attachment url columns: image and file uploads', () => {
    expect(pick('avatar_url', 'varchar(512)')).toMatchObject({ widget: 'image-upload' })
    expect(pick('cover_image', 'varchar(512)')).toMatchObject({ widget: 'image-upload' })
    expect(pick('file_url', 'varchar(512)')).toMatchObject({ widget: 'file-upload' })
    expect(pick('attachment', 'varchar(255)')).toMatchObject({ widget: 'file-upload' })
    // only url (char) columns: a count is a number
    expect(pick('image_count', 'int')).toMatchObject({ widget: 'number' })
  })

  it('*_user_id / dept_id: user picker / dept tree select, searched by equality', () => {
    expect(pick('head_user_id', 'bigint unsigned')).toMatchObject({
      widget: 'user-picker',
      inQuery: true,
      queryOp: 'eq',
    })
    expect(pick('dept_id', 'bigint unsigned')).toMatchObject({
      widget: 'dept-tree-select',
      inQuery: true,
    })
  })

  it('required = NOT NULL without a default', () => {
    expect(init('code', 'varchar(64)').required).toBe(true)
    expect(init('code', 'varchar(64)', { nullable: true }).required).toBe(false)
    expect(init('sort_no', 'int', { default: '0' }).required).toBe(false)
    expect(init('genre', 'varchar(16)', { default: '' }).required).toBe(false)
  })

  it('table name: built-in prefix stripped → group, domain, business, class name', () => {
    expect(initTable({ name: 'iam_position', comment: '岗位' })).toMatchObject({
      groupCode: 'platform',
      domain: 'iam',
      business: 'position',
      className: 'Position',
      featureName: '岗位',
      featureNameI18n: { 'zh-CN': '岗位', 'en-US': 'Position' },
      parentMenuRouteName: 'system',
      template: 'crud',
    })
    expect(initTable({ name: 'demo_book', comment: '图书（生成器示例）' })).toMatchObject({
      groupCode: 'biz',
      domain: 'demo',
      business: 'book',
      className: 'Book',
      featureName: '图书',
      options: { entityI18n: { 'zh-CN': '图书', 'en-US': 'book' } },
    })
    expect(initTable({ name: 'biz_leave_request', comment: '' })).toMatchObject({
      domain: 'biz',
      business: 'leave-request',
      className: 'LeaveRequest',
      featureName: 'Leave request',
    })
    expect(initTable({ name: 'wf_model', comment: 'x' })).toMatchObject({
      groupCode: 'workflow',
      domain: 'wf',
    })
    // no built-in prefix: the first name segment is the project domain
    expect(initTable({ name: 'shop_order', comment: '' })).toMatchObject({
      groupCode: 'biz',
      domain: 'shop',
      business: 'order',
      className: 'Order',
    })
    // a class name the templates import or declare (Nest's `Param`, a global): the domain in front
    expect(initTable({ name: 'cfg_param', comment: '' })).toMatchObject({
      business: 'param',
      className: 'SettingsParam',
    })
    expect(initTable({ name: 'demo_date', comment: '' }).className).toBe('DemoDate')
    expect(initTable({ name: 'query', comment: '' }).className).toBe('BizQuery')
    // the prefixed name taken as well (`BizError` is core's)
    expect(initTable({ name: 'biz_error', comment: '' }).className).toBe('BizErrorItem')
    for (const [prefix, parent] of Object.entries({
      iam: 'system',
      cfg: 'system',
      msg: 'messaging',
      aud: 'audit',
      fs: 'storage',
      job: 'monitor',
      oauth: 'system',
      wf: 'wf-admin',
      biz: 'biz',
      demo: 'demo',
    }))
      expect(initTable({ name: `${prefix}_sample`, comment: '' }).parentMenuRouteName).toBe(parent)
    expect(initTable({ name: 'sample', comment: '' }).parentMenuRouteName).toBe('biz')
  })

  it('field names: a reserved word or a template local gets a suffix', () => {
    for (const name of ['default', 'delete', 'class', 'qb', 'seeded', 'contains'])
      expect(init(name, 'varchar(64)', { nullable: true }).fieldName).toBe(`${name}Value`)
    expect(init('delete_flag', 'tinyint(1)').fieldName).toBe('deleteFlag')
  })

  it('tree: parent_id + tree_path → the tree template labelled by the first name / title column, no export; the path never in lists or forms, the parent not listed', () => {
    const columns = ['id', 'parent_id', 'tree_path', 'code', 'title', 'sort_no'].map((name) => ({
      name,
    }))
    expect(initTable({ name: 'demo_topic', comment: '', columns })).toMatchObject({
      template: 'tree',
      treeParentCol: 'parent_id',
      treeLabelCol: 'title',
      options: { withExport: false },
    })
    const crud = initTable({ name: 'demo_x', comment: '', columns: columns.slice(1, 2) })
    expect(crud).toMatchObject({ template: 'crud', treeParentCol: null, treeLabelCol: null })
    expect(crud.options.withExport).toBe(true)
    expect(pick('tree_path', 'varchar(512)')).toMatchObject({ inList: false, inForm: false })
    expect(pick('parent_id', 'bigint unsigned', { default: '0' })).toMatchObject({
      widget: 'number',
      inList: false,
      inForm: true,
      inQuery: false,
    })
  })
})

it('framework tables are excluded from import', () => {
  for (const t of ['meta_migrations', 'test_scoped_note', 'cg_table', 'cg_column'])
    expect(EXCLUDED_TABLE.test(t)).toBe(true)
  for (const t of ['iam_position', 'demo_book', 'metadata', 'testimony', 'cgx'])
    expect(EXCLUDED_TABLE.test(t)).toBe(false)
})

it('import hints: a unique key without alive; no deleted_at is refused instead', () => {
  const hints = (...uniqueKeys: { name: string; columns: string[] }[]) =>
    importHints({ name: 'demo_x', uniqueKeys })
  expect(hints({ name: 'uk_x', columns: ['code', 'alive'] })).toEqual([])
  expect(
    hints(
      { name: 'uk_a', columns: ['code'] },
      { name: 'uk_b', columns: ['a', 'alive'] },
      { name: 'uk_c', columns: ['b', 'deleted_at'] },
    ),
  ).toEqual([
    { tableName: 'demo_x', missing: 'alive', key: 'uk_a' },
    { tableName: 'demo_x', missing: 'alive', key: 'uk_c' },
  ])
  const info = (...names: string[]) => ({
    name: 'demo_x',
    columns: names.map((n) => col(n, 'int')),
  })
  expect(() => assertDeletedAt(info('id'))).toThrow(
    expect.objectContaining({ err: Err.CODEGEN_NO_DELETED_AT, params: { table: 'demo_x' } }),
  )
  expect(() => assertDeletedAt(info('id', 'deleted_at'))).not.toThrow()
})

it('TS types', () => {
  expect(
    Object.fromEntries(
      [
        'tinyint(1)',
        'tinyint',
        'int',
        'bigint unsigned',
        'decimal(10,2)',
        'decimal(15,2)',
        'decimal(16,2)',
        'numeric(30,10)',
        'double',
        'varchar(64)',
        'text',
        'date',
        'datetime(3)',
        'timestamp',
        'json',
      ].map((t) => [t, tsTypeOf(t)]),
    ),
  ).toEqual({
    'tinyint(1)': 'boolean',
    tinyint: 'number',
    int: 'number',
    'bigint unsigned': 'number',
    'decimal(10,2)': 'number',
    'decimal(15,2)': 'number',
    // beyond 15 significant digits a JS number is not exact
    'decimal(16,2)': 'string',
    'numeric(30,10)': 'string',
    double: 'number',
    'varchar(64)': 'string',
    text: 'string',
    date: 'string',
    'datetime(3)': 'Date',
    timestamp: 'Date',
    json: 'unknown',
  })
})

it('names and labels', () => {
  expect(camel('sort_no')).toBe('sortNo')
  expect(camel('a__b_1')).toBe('aB1')
  expect(camel('name_')).toBe('name')
  expect(pascal('leave_request')).toBe('LeaveRequest')
  expect(humanize('published_on')).toBe('Published on')
  expect(labelOf('岗位名称（种子为 seed.* 键）')).toBe('岗位名称')
  expect(labelOf('Price (CNY)')).toBe('Price')
  const c = init('sort_no', 'int', { default: '0', comment: '排序号' })
  expect(c).toMatchObject({
    fieldName: 'sortNo',
    labelI18n: { 'zh-CN': '排序号', 'en-US': 'Sort no' },
    sortNo: 10,
    columnDefault: '0',
    options: {},
    example: null,
  })
  // alone in a unique index: marked for the 409 case and upsert imports
  expect(init('isbn', 'varchar(20)', { unique: true }).options).toEqual({ unique: true })
  // no comment: the humanized column name in both languages
  expect(init('isbn', 'varchar(20)').labelI18n).toEqual({ 'zh-CN': 'Isbn', 'en-US': 'Isbn' })
  // long comments are cut to the label limit
  expect(init('x', 'int', { comment: 'y'.repeat(300) }).labelI18n['zh-CN']).toHaveLength(64)
})

/** The keys of `schema` (the editable config) out of a full config (which also holds the DB facts). */
const only = (schema: { shape: object }, config: object) =>
  Object.fromEntries(
    Object.keys(schema.shape).map((k) => [k, (config as Record<string, unknown>)[k]]),
  )

it('every default passes the shared whitelist schemas', () => {
  const columns: [string, string, Partial<ColumnInfo>?][] = [
    ['id', 'bigint unsigned', { isPk: true, autoIncrement: true }],
    ['code', 'varchar(64)'],
    ['note', 'varchar(500)', { nullable: true }],
    ['content', 'mediumtext'],
    ['enabled', 'tinyint(1)', { default: '1' }],
    ['leave_kind', 'varchar(16)'],
    ['published_on', 'date'],
    ['price', 'decimal(10,2)', { default: '0.00' }],
    ['cover_image', 'varchar(512)'],
    ['head_user_id', 'bigint unsigned'],
    ['name_i18n', 'json', { nullable: true }],
    ['created_at', 'datetime(3)', { default: 'CURRENT_TIMESTAMP(3)' }],
  ]
  for (const [name, type, over] of columns)
    expect(
      cgColumnFields.safeParse(only(cgColumnFields, init(name, type, over))).error,
    ).toBeUndefined()
  for (const name of ['iam_position', 'demo_book', 'biz_leave_request', 'shop_order'])
    expect(
      cgTableFields.safeParse(only(cgTableFields, initTable({ name, comment: 'x（y）' }))).error,
    ).toBeUndefined()
})

describe('project domains', () => {
  const names = (name: string) => {
    const t = initTable({ name, comment: '' })
    return [t.groupCode, t.domain, t.business, t.className, t.parentMenuRouteName].join(' ')
  }

  it('the first name segment outside the built-in prefixes is the domain, the rest the business', () => {
    expect(names('erp_sale_order')).toBe('biz erp sale-order SaleOrder biz')
    expect(names('crm_customer')).toBe('biz crm customer Customer biz')
    expect(names('erp__x')).toBe('biz erp x X biz')
    // no underscore, nothing after it, or a first segment no domain name: `biz`, the whole name
    expect(names('course')).toBe('biz biz course Course biz')
    expect(names('erp_')).toBe('biz biz erp- Erp biz')
    expect(names(`${'a'.repeat(33)}_x`)).toMatch(/^biz biz a{33}-x /)
    // built-in prefixes keep their rule
    expect(names('biz_course')).toBe('biz biz course Course biz')
    expect(names('demo_book')).toBe('biz demo book Book demo')
    expect(names('iam_position')).toBe('platform iam position Position system')
    expect(names('im_room')).toBe('platform im room Room system')
  })

  it('a reserved first segment is no domain: biz, the whole name', () => {
    expect(names('core_thing')).toBe('biz biz core-thing CoreThing biz')
    expect(names('menu_item')).toBe('biz biz menu-item MenuItem biz')
    // a static web route's first segment: the page route `biz-password-reset`, never `password-reset`
    expect(names('password_reset')).toBe('biz biz password-reset PasswordReset biz')
    expect(names('my_inbox')).toBe('biz biz my-inbox MyInbox biz')
    expect(names('not_found')).toBe('biz biz not-found NotFound biz')
    expect(cgDomainAllowed('biz', 'password')).toBe(false)
    const prefixes = new Set(Object.keys(TABLE_PREFIXES).map((p) => p.slice(0, -1)))
    const words = [...RESERVED_NAMES].filter((r) => CG_IDENT.domain.test(r) && !prefixes.has(r))
    expect(words.length).toBeGreaterThan(40)
    expect(
      words.filter((r) => initTable({ name: `${r}_thing`, comment: '' }).domain !== 'biz'),
    ).toEqual([])
  })

  it('dict codes follow the derived domain and business', () => {
    const status = initColumn(col('status', 'varchar(24)'), 'erp', 10, 'sale-order')
    expect(status?.dictCode).toBe('erp.sale_order_status')
    expect(cgDictCode('erp', 'sale-order', 'pay_kind')).toBe('erp.pay_kind')
  })

  it('a reserved name is no project domain (built-in biz / demo aside); platform keeps its own', () => {
    for (const d of ['core', 'platform', 'home', 'auth', 'menu', 'iam', 'codegen'])
      expect([d, cgDomainAllowed('biz', d)]).toEqual([d, false])
    for (const d of ['biz', 'demo', 'erp']) expect(cgDomainAllowed('biz', d)).toBe(true)
    expect(cgDomainAllowed('platform', 'iam')).toBe(true)
    // one word: a hyphen would clash once joined to a business (`a-b` + `c` = `a` + `b-c`)
    expect(CG_IDENT.domain.test('sale-x')).toBe(false)
    expect(cgTableFields.shape.domain.safeParse('sale-x').success).toBe(false)
  })

  const n = (tableName: string) => {
    const { domain, business, className } = initTable({ name: tableName, comment: '' })
    return { tableName, domain, business, className }
  }
  const conflict = (table: string) => ({ err: Err.CODEGEN_NAME_CONFLICT, params: { table } })

  it('the same business in another domain: the domain in front of the class name', () => {
    expect(qualifyNames(n('erp_customer'), [n('crm_customer')]).className).toBe('ErpCustomer')
    expect(qualifyNames(n('erp_customer'), [n('iam_position')]).className).toBe('Customer')
    // a taken class name (edited) gets the domain in front too
    const taken = { ...n('iam_position'), className: 'Customer' }
    expect(qualifyNames(n('erp_customer'), [taken]).className).toBe('ErpCustomer')
    // still taken → 422 naming the table
    const twin = { ...n('crm_customer'), className: 'ErpCustomer' }
    expect(() => qualifyNames(n('erp_customer'), [n('crm_customer'), twin])).toThrow(
      expect.objectContaining(conflict('crm_customer')),
    )
    // a table's derivation (not imported, or hand-written like iam_user) counts too, its class name not
    expect(qualifyNames(n('crm_user'), [], [n('iam_user')]).className).toBe('CrmUser')
    expect(qualifyNames(n('crm_customer'), [], [n('erp_customer')]).className).toBe('CrmCustomer')
    expect(qualifyNames(n('erp_customer'), [], [taken]).className).toBe('Customer')
    // a table is no clash: only a config's names are taken (an unimported `course` beside `biz_course`)
    expect(qualifyNames(n('course'), [], [n('biz_course')]).className).toBe('Course')
    // the same module (domain + business) is never fixed by a prefix
    expect(() => qualifyNames(n('course'), [n('biz_course')])).toThrow(
      expect.objectContaining(conflict('biz_course')),
    )
  })

  it("a class whose exports @qiwu/shared holds for another module (hand-written): the domain in front; the table's own module is none", () => {
    expect(qualifyNames(n('erp_leave'), []).className).toBe('ErpLeave')
    expect(qualifyNames(n('hr_leave'), []).className).toBe('HrLeave')
    expect(qualifyNames(n('erp_session'), []).className).toBe('ErpSession')
    expect(qualifyNames(n('erp_page'), []).className).toBe('ErpPage')
    // no clash: the short name
    expect(qualifyNames(n('erp_sale_order'), []).className).toBe('SaleOrder')
    // re-imported iam_position, the hand-written iam_role and biz_leave: their own `<domain>.<business>` perms
    expect(qualifyNames(n('iam_position'), []).className).toBe('Position')
    expect(qualifyNames(n('iam_role'), []).className).toBe('Role')
    expect(qualifyNames(n('biz_leave'), []).className).toBe('Leave')
  })

  it('assertNamesFree: another config with the class name or the module → 422', () => {
    expect(() => assertNamesFree(n('erp_customer'), [n('crm_customer')])).toThrow(
      expect.objectContaining(conflict('crm_customer')),
    )
    expect(() =>
      assertNamesFree({ ...n('erp_customer'), className: 'X' }, [
        { ...n('erp_customer'), tableName: 'o' },
      ]),
    ).toThrow(expect.objectContaining(conflict('o')))
    expect(() => assertNamesFree(n('erp_customer'), [n('iam_position')])).not.toThrow()
  })
})

describe('generator paths', () => {
  const ROOT = join(process.cwd(), '../..')
  /** A CRUD config of `name` as import would store it: key, a name column, the audit columns. */
  const config = (name: string, over: Partial<RenderConfig> = {}): RenderConfig => {
    const table = { ...initTable({ name, comment: '' }), ...over }
    const columns = [
      col('id', 'bigint unsigned', { isPk: true, autoIncrement: true }),
      col('title', 'varchar(64)'),
      col('created_by', 'bigint unsigned', { nullable: true }),
      col('created_at', 'datetime(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
      col('updated_by', 'bigint unsigned', { nullable: true }),
      col('updated_at', 'datetime(3)', { default: 'CURRENT_TIMESTAMP(3)' }),
      col('deleted_at', 'datetime(3)', { nullable: true }),
    ].map((c, i) => ({
      ...initColumn(c, table.domain, (i + 1) * 10, table.business)!,
      id: i + 1,
      tableId: 1,
    }))
    return { ...table, id: 1, columns } as unknown as RenderConfig
  }

  it('a project module at <domain>/<business>, platform / workflow under their layer', () => {
    const paths = (name: string) => crudTargets(crudModel(config(name)), true).map((t) => t.path)
    expect(paths('erp_sale_order')).toEqual([
      'apps/server/src/modules/erp/sale-order/sale-order.entity.ts',
      'apps/server/src/modules/erp/sale-order/sale-order.service.ts',
      'apps/server/src/modules/erp/sale-order/sale-order.controller.ts',
      'apps/server/src/modules/erp/sale-order/sale-order.module.ts',
      'apps/server/src/modules/erp/sale-order/sale-order.seed.ts',
      'packages/shared/src/erp/sale-order.schema.ts',
      'packages/shared/src/i18n/zh-CN/modules/erp.sale-order.json',
      'packages/shared/src/i18n/en-US/modules/erp.sale-order.json',
      'apps/server/test/e2e/erp-sale-order.e2e-spec.ts',
      'apps/web/src/api/erp/sale-order.ts',
      'apps/web/src/views/erp/sale-order/index.vue',
      'apps/web/src/views/erp/sale-order/form.vue',
      'apps/web/src/locales/zh-CN/erp.sale-order.json',
      'apps/web/src/locales/en-US/erp.sale-order.json',
    ])
    expect(paths('biz_course')[0]).toBe('apps/server/src/modules/biz/course/course.entity.ts')
    expect(paths('demo_book')[0]).toBe('apps/server/src/modules/demo/book/book.entity.ts')
    expect(paths('iam_position')[0]).toBe(
      'apps/server/src/modules/platform/iam/position/position.entity.ts',
    )
    expect(paths('iam_position')[5]).toBe('packages/shared/src/platform/iam/position.schema.ts')
    const m = crudModel(config('erp_sale_order'))
    expect([m.url, m.routePath, m.component, m.key]).toEqual([
      'erp/sale-orders',
      '/erp/sale-orders',
      'erp/sale-order/index',
      'erp.saleOrder',
    ])
    // project.module.ts and SEEDS.project (the samples keep SEEDS.demo)
    expect(crudRegistration(config('erp_sale_order'))).toEqual([
      'apps/server/src/modules/project.module.ts:',
      "  import { SaleOrderModule } from './erp/sale-order/sale-order.module.js'  + SaleOrderModule in `imports`",
      'apps/server/src/db/seeds/index.ts:',
      "  import { seedSaleOrder } from '../../modules/erp/sale-order/sale-order.seed.js'  + seedSaleOrder in SEEDS.project",
      'packages/shared/src/index.ts:',
      "  export * from './erp/sale-order.schema.js'",
    ])
    expect(crudRegistration(config('biz_course'))).toContain(
      "  import { seedCourse } from '../../modules/biz/course/course.seed.js'  + seedCourse in SEEDS.project",
    )
  })

  it('every relative import of a rendered module resolves (project and platform depth)', async () => {
    for (const name of ['erp_sale_order', 'iam_position']) {
      const files = await renderCrud(config(name))
      const rendered = new Set(files.map((f) => f.path))
      const missing: string[] = []
      for (const f of files.filter((x) => /\.(ts|vue)$/.test(x.path)))
        for (const [, spec] of f.content.matchAll(/from '((?:\.\.?|@)\/[^']+)'/g)) {
          const path = spec!.startsWith('@/')
            ? `apps/web/src/${spec!.slice(2)}`
            : join(dirname(f.path), spec!).replaceAll('\\', '/')
          const candidates = [path.replace(/\.js$/, '.ts'), `${path}.ts`, path]
          if (!candidates.some((p) => rendered.has(p) || existsSync(join(ROOT, p))))
            missing.push(`${f.path}: ${spec}`)
        }
      expect([name, missing]).toEqual([name, []])
    }
  })

  it('exported identifiers follow the class name: a qualified one carries the domain', async () => {
    const files = await renderCrud(config('erp_customer', { className: 'ErpCustomer' }))
    const schema = files.find((f) => f.path.endsWith('.schema.ts'))!
    expect(schema.path).toBe('packages/shared/src/erp/customer.schema.ts')
    expect(schema.content).toContain('export const erpCustomerPerms = {')
    expect(schema.content).toContain("browse: 'erp.customer.browse',")
    expect(schema.content).toContain('export type ErpCustomerVo =')
  })

  it('render refuses a reserved project domain (422 C3002)', () => {
    expect(() => crudModel(config('erp_x', { domain: 'core' }))).toThrow(
      expect.objectContaining({ err: Err.CODEGEN_IDENTIFIER_INVALID, params: { name: 'core' } }),
    )
    expect(() => crudModel(config('erp_x', { domain: 'demo' }))).not.toThrow()
  })

  it('the menu seed: its group by live kind=group, a deleted one skips the module; a project page writes parent, icon and sort once', async () => {
    const seed = async (name: string, over: Partial<RenderConfig> = {}) =>
      (await renderCrud(config(name, over))).find((f) => f.path.endsWith('.seed.ts'))!.content
    const project = await seed('erp_sale_order', { parentMenuRouteName: 'erp-sale' })
    expect(project).toContain(
      "const parent = await findRow(q, 'iam_menu', { route_name: 'erp-sale', kind: 'group' })",
    )
    expect(project).toContain(
      "'seedSaleOrder: the erp-sale menu group is missing: add it to apps/server/src/db/seeds/project/menu-groups.seed.ts'",
    )
    expect(project).toContain(
      "return ['seed: the erp-sale menu group was deleted: the sale order menus are skipped']",
    )
    expect(project).toContain("{ parent_id: parent.id, icon: 'lucide:table', sort_no: 10 },")
    expect(project).not.toMatch(/^ {6}(parent_id|icon|sort_no):/m)
    // a built-in group: no menu-groups.seed.ts to point at; a platform page keeps every field upserted
    const platform = await seed('iam_position')
    expect(platform).toContain("throw new Error('seedPosition: the system menu group is missing')")
    expect(platform).toMatch(/^ {6}parent_id: parent\.id,$/m)
    expect(platform).toMatch(/^ {6}sort_no: 10,$/m)
    expect(platform).not.toContain('{ parent_id: parent.id')
  })
})

describe('menu groups', () => {
  let seq = 0
  /** A live group row under `parentId` (0 = top level). */
  const row = (routeName: string | null, parentId = 0, over: Partial<GroupRow> = {}): GroupRow => ({
    id: ++seq,
    parentId,
    routeName,
    name: routeName ?? 'nameless',
    nameI18n: null,
    routePath: `/${routeName}`,
    icon: null,
    sortNo: 10,
    ...over,
  })

  it('pickable: its route name and every ancestor one in the generator format; the forest keeps orphans as roots', () => {
    const biz = row('biz')
    const bad = row('Bad_Name')
    const rows = [
      biz,
      row('erp', biz.id),
      bad,
      row('erp-sale', bad.id),
      row(null),
      row('lost', 999),
    ]
    const forest = groupForest(rows)
    const flat = (nodes: CgParentMenuNode[]): [string | null, boolean, string | null][] =>
      nodes.flatMap((n) => [[n.routeName, n.pickable, n.reason], ...flat(n.children)])
    expect(flat(forest)).toEqual([
      ['biz', true, null],
      ['erp', true, null],
      ['Bad_Name', false, 'route_name'],
      ['erp-sale', false, 'ancestor'],
      [null, false, 'route_name'],
      ['lost', true, null],
    ])
    expect([...pickableGroups(forest)]).toEqual(['biz', 'erp', 'lost'])
  })

  it('default parent: the longest leading run of name segments that is a pickable group, never the whole name; else biz (a hint unless the table is of domain biz)', () => {
    const parent = (name: string, pickable: string[]) =>
      defaultParent({ ...initTable({ name, comment: '' }), tableName: name }, new Set(pickable))
    const all = ['biz', 'system', 'demo', 'erp', 'erp-sale', 'erp-sale-order']
    expect(parent('erp_sale_order', all)).toEqual({ parent: 'erp-sale' })
    expect(parent('erp_sale_order', ['biz', 'erp'])).toEqual({ parent: 'erp' })
    const hint = (tableName: string, key: string) => ({ tableName, missing: 'parent_menu', key })
    expect(parent('erp_sale_order', ['biz'])).toEqual({
      parent: 'biz',
      hint: hint('erp_sale_order', 'erp'),
    })
    expect(parent('biz_course', all)).toEqual({ parent: 'biz' })
    expect(parent('course', all)).toEqual({ parent: 'biz' })
    expect(parent('course', [])).toEqual({ parent: 'biz', hint: hint('course', 'biz') })
    expect(parent('demo_book', all)).toEqual({ parent: 'demo' })
    // a platform table: its prefix's group, never a segment match
    expect(parent('iam_position', all)).toEqual({ parent: 'system' })
    expect(parent('iam_erp', ['biz', 'iam'])).toEqual({
      parent: 'biz',
      hint: hint('iam_erp', 'system'),
    })
  })

  it('registration lines of a parent chain: its project groups top first up to the first built-in one; none below a built-in group; a note for a group not pickable', () => {
    const biz = row('biz')
    const erp = row('erp', biz.id, {
      name: 'ERP zh',
      nameI18n: { 'zh-CN': 'ERP zh', 'en-US': 'ERP' },
      routePath: '/erp',
      icon: 'lucide:package',
      sortNo: 50,
    })
    const sale = row('erp-sale', erp.id, { name: 'Sales', routePath: 'sale' })
    // a built-in group moved below a project group: the walk still stops there
    const demo = row('demo', sale.id)
    const lab = row('lab', demo.id, { nameI18n: { 'en-US': 'Lab' } })
    const rows = [biz, erp, sale, demo, lab]
    const [head, ...lines] = groupLines(rows, 'erp-sale')
    expect(head).toBe(
      'apps/server/src/db/seeds/project/menu-groups.seed.ts, in PROJECT_MENU_GROUPS (the groups not there yet, parents first):',
    )
    expect(lines).toEqual([
      '  { routeName: "erp", parent: "biz", name: "ERP zh", nameI18n: { "zh-CN": "ERP zh", "en-US": "ERP" }, routePath: "/erp", icon: "lucide:package", sortNo: 50 },',
      '  { routeName: "erp-sale", parent: "erp", name: "Sales", nameI18n: { "zh-CN": "Sales", "en-US": "Erp sale" }, routePath: "sale", icon: null, sortNo: 10 }, // en-US derived from the route name: check it',
    ])
    expect(groupLines(rows, 'lab').slice(1)).toEqual([
      '  { routeName: "lab", parent: "demo", name: "lab", nameI18n: { "zh-CN": "lab", "en-US": "Lab" }, routePath: "/lab", icon: null, sortNo: 10 },',
    ])
    expect(groupLines(rows, 'demo')).toEqual([])
    expect(groupLines(rows, 'biz')).toEqual([])
    expect(groupLines(rows, 'gone')).toEqual([
      'apps/server/src/db/seeds/project/menu-groups.seed.ts: gone is no group of this database whose route names are all in the generator format; build it in the menu page, then pick it again',
    ])
  })
})
