// Code generator rendering (see docs/design-notes.md#codegen). pipeline: ejs → Prettier → @generated header, the escaping
// helpers and the ejs-lint guard. server / shared / web: the CRUD templates render the golden position
// module byte for byte (docs/codegen-golden.md) from its config (import defaults + test/codegen/golden.ts),
// and demo_book's options (soft delete, decimal/date/dict/image columns, export + import, detail drawer),
// the tree template from demo_topic's; mobile: the uni-app pages of a withMobile config, the golden
// demo modules' byte for byte where the repository has mobile/;
// untrusted names are refused and DB comments stay comments.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, insertImportBody } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import ts from 'typescript'
import type { DataSource } from 'typeorm'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import { CodegenServiceModule } from '../../src/modules/platform/codegen/codegen.module.js'
import {
  type CgTableDetail,
  CodegenService,
} from '../../src/modules/platform/codegen/codegen.service.js'
import {
  crudModel,
  crudRegistration,
  crudTargets,
  type RenderConfig,
  renderCrud,
} from '../../src/modules/platform/codegen/crud.js'
import {
  Code,
  comment,
  emit,
  finish,
  names,
  type RenderedFile,
  renderSource,
  str,
} from '../../src/modules/platform/codegen/render.js'
import { hasMobile, MOBILE } from '../../src/modules/platform/codegen/workspace.js'

// most cases type-check (and lint) what they render: 1-3 s each alone, the four variants up to 8 s, past the
// 5 s default on a loaded machine. One ceiling for the file instead of one per case
vi.setConfig({ testTimeout: 30_000 })

/** Every generator config with its columns, for good (no foreign key cascades them). */
const clearCg = async (ds: DataSource) => {
  await ds.query('DELETE FROM cg_column')
  await ds.query('DELETE FROM cg_table')
}

describe('pipeline', () => {
  it('lint reports violations with repository-relative paths', () => {
    const found = lint([{ path: 'apps/server/src/core/bad.ts', content: 'const n = 1\nn = 2\n' }])
    expect(found).toContainEqual(
      expect.stringMatching(/^apps\/server\/src\/core\/bad\.ts:1:7: .*no-const-assign/),
    )
    expect(found.every((line) => line.startsWith('apps/server/src/core/bad.ts:'))).toBe(true)
  })

  it('<%= %> prints plain tokens and helper output, refuses any other text', () => {
    for (const ok of [
      'Position',
      'iam.position.browse',
      '/iam/positions',
      'lucide:table',
      'a-b_c$',
    ])
      expect(emit(ok)).toBe(ok)
    expect(emit(12)).toBe('12')
    expect(emit(false)).toBe('false')
    expect(emit(new Code("'x'"))).toBe("'x'")
    for (const bad of [
      "a'b",
      'a b',
      'a\nb',
      'a//b',
      'a/*b',
      'a*/b',
      '<b>',
      'a\\b',
      '`',
      null,
      undefined,
      {},
      NaN,
    ])
      expect(() => emit(bad)).toThrow(/unsafe value/)
  })

  it('str() is a string literal of any text, comment() one line without comment marks', () => {
    for (const text of [
      'it\'s "q" \\ `t` ${x}',
      'a\nb\r\nc',
      '</script><!-- -->',
      'p\u2028q\u2029r',
    ])
      expect(JSON.parse(str(text).text)).toBe(text)
    expect(str('</script>').text).not.toContain('<')
    expect(str('p\u2028q').text).not.toMatch(/[\u2028\u2029]/)
    expect(comment('*/ evil()').text).toBe('evil()')
    expect(comment('a */*/ b /*/ c').text).toBe('a b / c')
    expect(comment('x --> <!-- y --!> z\n  */ evil()\u2028w').text).toBe('x y z evil() w')
    expect(comment('**//').text).toBe('')
  })

  it('names() orders named imports like the repository, refuses anything but names', () => {
    expect(
      names([
        'type PositionQuery',
        'positionQuery',
        'pageVo',
        'type EnabledBody',
        'enabledBody',
        false,
      ]).text,
    ).toBe('type EnabledBody, enabledBody, pageVo, type PositionQuery, positionQuery')
    expect(() => names(['a, evil'])).toThrow(/bad import name/)
  })

  it('renders in strict mode through the escape: DB text only via the helpers', () => {
    expect(
      renderSource('const a = <%= str(label) %> // <%= comment(label) %>', { label: "x'*/y" }),
    ).toBe('const a = "x\'*/y" // x\'y')
    expect(() => renderSource('const a = <%= label %>', { label: "x' + evil() + '" })).toThrow(
      /unsafe value/,
    )
    // strict: no `with`, so an unknown name is an error, not a lookup on the data object
    expect(() => renderSource('<%= missing %>', {})).toThrow(/missing is not defined/)
  })

  it('formats with the repository Prettier config by file type and prepends the header', async () => {
    const ts = await finish('import {a} from "b";\nexport const x = {a, "b": 1};', 'x.ts', 'crud')
    expect(ts).toBe(
      "// @generated by qw-codegen (crud)\nimport { a } from 'b'\nexport const x = { a, b: 1 }\n",
    )
    const vue = await finish('<template><div   class="a">{{x}}</div></template>', 'x.vue', 'crud')
    expect(vue).toBe(
      '<!-- @generated by qw-codegen (crud) -->\n<template>\n  <div class="a">{{ x }}</div>\n</template>\n',
    )
    expect(await finish('{"a":{"b":"c"}}', 'x.json', 'crud')).toBe('{ "a": { "b": "c" } }\n')
    await expect(finish('x', 'x.txt', 'crud')).rejects.toThrow(/no formatter/)
  })

  it('ejs-lint refuses <%- %> except include(…)', () => {
    const root = mkdtempSync(join(tmpdir(), 'qw-ejs-lint-'))
    try {
      const dir = join(root, 'apps/server/codegen-templates/server')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'x.ts.ejs'),
        [
          "<%- include('part.ejs') %>",
          '<%%- literal %>',
          '<%= str(name) %>',
          '<%- name %>',
          '<%-  str(name) -%>',
          "<%- include('part.ejs') + name %>",
        ].join('\n'),
      )
      const r = spawnSync(
        process.execPath,
        ['../../scripts/arch/run.mjs', '--root', root, '--only', 'ejs-lint'],
        { encoding: 'utf8' },
      )
      expect(r.status).toBe(1)
      expect(
        [...r.stderr.matchAll(/x (\S+:\d+) <%- (\S+)/g)].map(([, at, v]) => `${at} ${v}`),
      ).toEqual([
        'apps/server/codegen-templates/server/x.ts.ejs:4 name',
        'apps/server/codegen-templates/server/x.ts.ejs:5 str(name)',
        "apps/server/codegen-templates/server/x.ts.ejs:6 include('part.ejs')",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** Repository root (tests run with cwd = apps/server). */
const ROOT = join(process.cwd(), '../..')
const committed = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// the repository parsed once, in a hook: a case's first typecheck() then costs what the others do
beforeAll(() => {
  const app = 'apps/server/src/app.module.ts'
  typecheck([], { [app]: committed(app) })
})

/** Nest context with the codegen service; `golden` imports the golden configs once per describe. */
function useCodegen() {
  const ctx = {} as {
    ds: DataSource
    svc: CodegenService
    run: <T>(fn: () => Promise<T>) => Promise<T>
  }
  let moduleRef: TestingModule
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CoreContextModule, CoreDbModule, CodegenServiceModule],
    }).compile()
    await moduleRef.init()
    ctx.ds = moduleRef.get(getDataSourceToken())
    ctx.svc = moduleRef.get(CodegenService)
    const cls = moduleRef.get(ClsService)
    ctx.run = (fn) => cls.run(fn)
    await clearCg(ctx.ds)
  })
  afterAll(async () => {
    if (ctx.ds?.isInitialized) await clearCg(ctx.ds)
    await moduleRef?.close()
  })
  return ctx
}

/** Syntax errors of a rendered .ts file, and whether any identifier `name` made it into the code. */
function parsed(file: RenderedFile, name: string) {
  const sf = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const errors = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map(
    (d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  )
  let found = false
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name) found = true
    n.forEachChild(walk)
  }
  walk(sf)
  return { errors, found }
}

/** The server module files (the seed beside them belongs to the `shared` group). */
const pick = (files: RenderedFile[], dir: string) =>
  files.filter((f) => f.path.includes(dir) && !f.path.endsWith('.seed.ts'))

describe('server', () => {
  const ctx = useCodegen()
  let position: CgTableDetail
  let book: CgTableDetail
  let topic: CgTableDetail
  beforeAll(async () => {
    const { importGolden } = await import('./golden.js')
    position = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'iam_position'))
    book = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_book'))
    topic = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_topic'))
  })

  it('secret: write-only body, boxed entity, service and password form', async () => {
    const source = book.columns.find((c) => c.columnName === 'author')!
    const secret = {
      ...source,
      id: 99_991,
      columnName: 'password_enc',
      fieldName: 'passwordEnc',
      columnType: 'varchar(512)',
      columnComment: 'Password box',
      widget: 'secret' as const,
      labelI18n: { 'zh-CN': '密码', 'en-US': 'Password box' },
      tsType: 'string' as const,
      nullable: true,
      required: false,
      inForm: true,
      inList: true,
      inQuery: true,
      sortable: true,
      example: null,
    }
    const config = { ...book, columns: [...book.columns, secret] } as CgTableDetail
    const model = crudModel(config)
    expect(model.secrets.map((c) => c.secret)).toEqual([{ body: 'password', max: 117 }])
    for (const fields of [model.list, model.filters, model.excel, model.detail])
      expect(fields.some((c) => c.field === 'passwordEnc')).toBe(false)
    expect(model.sortFields).not.toContain('passwordEnc')
    const files = await renderCrud(config)
    const output = (suffix: string) => files.find((f) => f.path.endsWith(suffix))!.content
    expect(output('book.entity.ts')).toContain(
      "name: 'password_enc', type: 'varchar', length: 512, nullable: true, select: false",
    )
    const schema = output('book.schema.ts')
    expect(schema).toContain('password: z.string().max(117).optional()')
    expect(schema).not.toContain('passwordEnc:')
    expect(output('book.service.ts')).toContain(
      "import { SecretBox } from '../../../core/crypto/secret-box.js'",
    )
    expect(output('book.service.ts')).toContain('this.box.encrypt(password)')
    expect(output('book.service.ts')).toContain('return this.get(row.id)')
    expect(output('form.vue')).toMatch(
      /v-model="model.password"\s+type="password"\s+show-password\s+autocomplete="new-password"\s+maxlength="117"/,
    )
    expect(output('form.vue')).toContain("t('crud.placeholder.secretKeep')")
    expect(output('demo.book.json')).toContain('"password": "密码"')
    expect(output('.e2e-spec.ts')).toContain('box.decrypt(before.passwordEnc)')
    const mixed = await renderCrud({
      ...config,
      columns: config.columns.map((c) =>
        c.columnName === 'author' ? { ...c, widget: 'richtext' } : c,
      ),
    } as CgTableDetail)
    expect(mixed.find((f) => f.path.endsWith('book.service.ts'))!.content).toMatch(
      /sanitizeFields\(\s*\{ \.\.\.\$rest, passwordEnc: password \? this\.box\.encrypt\(password\) : null \},\s*RICH_TEXT/,
    )
    await expect(
      renderCrud({
        ...config,
        columns: [
          ...config.columns,
          { ...secret, id: 99_993, fieldName: 'restEnc', columnName: 'rest_enc' },
        ],
      } as CgTableDetail),
    ).resolves.toEqual(expect.any(Array))
    const tree = await renderCrud({
      ...topic,
      columns: [...topic.columns, { ...secret, tableId: topic.id }],
    } as CgTableDetail)
    expect(tree.find((f) => f.path.endsWith('.e2e-spec.ts'))!.content).toContain(
      'box.decrypt(before.passwordEnc)',
    )
    expect(typecheck(tree, sharedIndexWith('packages/shared/src/demo/topic.schema.ts'))).toEqual([])
    expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual([])
    expect(lint(files)).toEqual([])
    // two type-checked renders and a lint
  })

  it('secret configs with unsafe shape or body name refuse C3002 on render and save', async () => {
    const source = book.columns.find((c) => c.columnName === 'author')!
    const secret = {
      ...source,
      id: 99_992,
      columnName: 'password_enc',
      fieldName: 'passwordEnc',
      columnType: 'varchar(512)',
      widget: 'secret' as const,
      tsType: 'string' as const,
      nullable: true,
      required: false,
    }
    const bad = [
      { ...secret, nullable: false },
      { ...secret, columnType: 'int' },
      { ...secret, tsType: 'number' as const },
      { ...secret, fieldName: 'password' },
      { ...secret, fieldName: 'defaultEnc' },
      { ...secret, fieldName: 'titleEnc', columnName: 'title_enc' },
    ]
    for (const c of bad)
      await expect(
        renderCrud({ ...book, columns: [...book.columns, c] } as CgTableDetail),
      ).rejects.toMatchObject({ err: Err.CODEGEN_IDENTIFIER_INVALID })
    await expect(
      ctx.run(() =>
        ctx.svc.save(book.id, {
          columns: [
            {
              id: book.columns.find((c) => c.columnName === 'title')!.id,
              fieldName: 'titleEnc',
              widget: 'secret',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ err: Err.CODEGEN_IDENTIFIER_INVALID })
    const { importGolden } = await import('./golden.js')
    const invoice = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice'))
    await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice_line'))
    const master = await ctx.run(() => ctx.svc.renderConfig(invoice.id))
    await expect(
      renderCrud({ ...master, columns: [...master.columns, secret] } as RenderConfig),
    ).rejects.toMatchObject({ err: Err.CODEGEN_IDENTIFIER_INVALID })
    await expect(
      renderCrud({
        ...master,
        subs: [{ ...master.subs![0]!, columns: [...master.subs![0]!.columns, secret] }],
      } as RenderConfig),
    ).rejects.toMatchObject({ err: Err.CODEGEN_IDENTIFIER_INVALID })
  })

  it('renders the golden position module (entity, service, controller, module) byte for byte', async () => {
    const files = pick(await renderCrud(position), 'apps/server/src/')
    expect(files.map((f) => f.path)).toEqual(
      ['entity', 'service', 'controller', 'module'].map(
        (k) => `apps/server/src/modules/platform/iam/position/position.${k}.ts`,
      ),
    )
    for (const f of files) expect({ ...f }).toEqual({ path: f.path, content: committed(f.path) })
  })

  it('demo_book: soft delete, decimal/date columns, dict filter, export and import routes', async () => {
    const files = pick(await renderCrud(book), 'apps/server/src/')
    const [entity, service, controller] = files.map((f) => f.content)
    expect(files[0]!.path).toBe('apps/server/src/modules/demo/book/book.entity.ts')
    expect(entity).toContain('export class Book extends BaseEntity {')
    expect(entity).toContain(
      "@Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: decimalNumber })",
    )
    expect(entity).toContain("@Column({ name: 'published_on', type: 'date', nullable: true })")
    expect(service).toContain("if (genre) qb.andWhere('t.genre = :genre', { genre })")
    expect(service).toContain(
      "qb.andWhere('t.published_on >= :publishedOnFrom', { publishedOnFrom })",
    )
    expect(service).toContain('{ createdAtTo: new Date(createdAtTo) }')
    expect(service).toContain(".andWhere('t.isbn = :isbn', { isbn: row.value.isbn })")
    expect(controller).toContain("@Get('import-template')")
    expect(controller).toContain("@ActionLog({ domain: 'demo.book', verb: 'import' })")
    expect(controller).not.toContain("@Get('options')")
    expect(controller).toContain("@Put(':id/enabled')")
    for (const f of files) expect([f.path, parsed(f, 'evil').errors]).toEqual([f.path, []])
  })

  it('data scope: @DataScoped by dept_id (owner created_by) unless switched off; none without dept_id', async () => {
    const entity = async (t: CgTableDetail) =>
      (await renderCrud(t)).find((f) => f.path.endsWith('.entity.ts'))!.content
    expect(await entity(book)).toContain(
      "@Entity('demo_book')\n@DataScoped({ dept: 'dept_id', owner: 'created_by' })\nexport class Book",
    )
    const off = { ...book, options: { ...book.options, dataScope: false } } as CgTableDetail
    expect(await entity(off)).not.toContain('DataScoped')
    const spec = (await renderCrud(off)).find((f) => f.path.endsWith('.e2e-spec.ts'))!.content
    expect(spec).not.toContain('own_dept')
    const noDept = {
      ...book,
      columns: book.columns.filter((c) => c.columnName !== 'dept_id'),
    } as CgTableDetail
    expect(await entity(noDept)).not.toContain('DataScoped')
    expect(await entity(position)).not.toContain('DataScoped')
    // the spec's own_dept rows: through the form's dept field, else set straight in the table
    const specOf = async (t: CgTableDetail) =>
      (await renderCrud(t)).find((f) => f.path.endsWith('.e2e-spec.ts'))!.content
    expect(await specOf(book)).toContain(
      'const addIn = (dept: number, tag = unique()) => add(body(tag, { deptId: dept }))',
    )
    const hidden = {
      ...book,
      columns: book.columns.map((c) => (c.columnName === 'dept_id' ? { ...c, inForm: false } : c)),
    } as CgTableDetail
    expect(await specOf(hidden)).toContain(
      "await ds.query('UPDATE demo_book SET dept_id = ? WHERE id = ?', [dept, id])",
    )
  })

  it('refuses a class name outside the whitelist on save and on render', async () => {
    for (const className of ['Book;evil()', 'Book`x`', 'Book*/', 'book'])
      await expect(ctx.run(() => ctx.svc.save(book.id, { className }))).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: ['className'] })],
      })
    // stored anyway (a hand-edited row, a seed): rendering refuses it too
    await ctx.ds.query('UPDATE cg_table SET class_name = ? WHERE id = ?', ['Book;evil()', book.id])
    try {
      const stored = await ctx.run(() => ctx.svc.detail(book.id))
      await expect(renderCrud(stored)).rejects.toMatchObject({
        err: Err.CODEGEN_IDENTIFIER_INVALID,
        params: { name: 'Book;evil()' },
      })
    } finally {
      await ctx.ds.query('UPDATE cg_table SET class_name = ? WHERE id = ?', ['Book', book.id])
    }
  })

  it('referencedBy: the entity registers each reference (label as a comment); names whitelisted again on render', async () => {
    const entity = async (t: CgTableDetail) =>
      (await renderCrud(t)).find((f) => f.path.endsWith('.entity.ts'))!
    const withRefs = (referencedBy: unknown) =>
      ({ ...book, options: { ...book.options, referencedBy } }) as CgTableDetail
    const file = await entity(
      withRefs([
        { table: 'demo_loan', column: 'book_id', label: '借阅 */ evil() //' },
        { table: 'demo_review', column: 'book_id', label: 'reviews' },
      ]),
    )
    expect(file.content).toContain(
      "import { referencedBy } from '../../../core/db/references.js'\n",
    )
    expect(file.content).toContain(
      "// 借阅 evil() //\nreferencedBy('demo_book', { table: 'demo_loan', column: 'book_id' })\n" +
        "// reviews\nreferencedBy('demo_book', { table: 'demo_review', column: 'book_id' })\n",
    )
    expect(parsed(file, 'evil')).toEqual({ errors: [], found: false })
    expect(typecheck([file])).toEqual([])
    // none: no import, no registration
    expect((await entity(book)).content).not.toContain('referencedBy')
    // stored behind the save's back: an identifier outside the whitelist never reaches the code
    for (const bad of [
      { table: "demo_loan' OR 1", column: 'book_id', label: 'x' },
      { table: 'demo_loan', column: 'book_id`', label: 'x' },
    ])
      await expect(entity(withRefs([bad]))).rejects.toMatchObject({
        err: Err.CODEGEN_IDENTIFIER_INVALID,
      })
  })

  it('options need a label column: none (no name, title or text column) → 422 C3003', async () => {
    const numbers = {
      ...book,
      options: { ...book.options, withOptions: true },
      columns: book.columns.filter((c) => c.tsType !== 'string'),
    } as CgTableDetail
    await expect(renderCrud(numbers)).rejects.toMatchObject({
      err: Err.CODEGEN_OPTIONS_LABEL_MISSING,
      params: { table: 'demo_book' },
    })
    // without options it renders
    expect(await renderCrud({ ...numbers, options: book.options } as CgTableDetail)).not.toEqual([])
  })

  it('options need a non-dict label column: dict text only → 422 C3003 on render and save', async () => {
    const before = await ctx.run(() => ctx.svc.detail(book.id))
    const dictOnly = {
      ...book,
      options: { ...book.options, withOptions: true },
      columns: book.columns
        .filter((c) => c.tsType !== 'string' || c.columnName === 'title')
        .map((c) => (c.tsType === 'string' ? { ...c, dictCode: 'demo.genre' } : c)),
    } as CgTableDetail
    await expect(renderCrud(dictOnly)).rejects.toMatchObject({
      err: Err.CODEGEN_OPTIONS_LABEL_MISSING,
    })
    await expect(
      ctx.run(() =>
        ctx.svc.save(book.id, {
          options: dictOnly.options,
          columns: before.columns.map((c) => ({
            id: c.id,
            dictCode: c.tsType === 'string' ? 'demo.genre' : c.dictCode,
          })),
        }),
      ),
    ).rejects.toMatchObject({ err: Err.CODEGEN_OPTIONS_LABEL_MISSING })
    expect(await ctx.run(() => ctx.svc.detail(book.id))).toEqual(before)
  })

  it('demo_topic (tree): BaseTreeService, the forest route; no paging, batch delete or export', async () => {
    const files = pick(await renderCrud(topic), 'apps/server/src/')
    const [entity, service, controller] = files.map((f) => f.content)
    expect(files[0]!.path).toBe('apps/server/src/modules/demo/topic/topic.entity.ts')
    expect(entity).toMatch(/^\/\/ @generated by qw-codegen \(tree\)\n/)
    expect(entity).toContain("@Column({ name: 'tree_path', length: 512 })\n  treePath: string")
    expect(service).toContain('export class TopicService extends BaseTreeService<Topic> {')
    expect(controller).toContain('@ApiEnvelope(z.array(topicNodeVo))')
    expect(controller).toContain('return this.topics.list(query)')
    for (const gone of ['batch-delete', "@Get('export')", 'pageVo', 'HttpCode'])
      expect(controller).not.toContain(gone)
    // a tree has no export, import, options, detail drawer or read-only mode: those options change nothing
    const all = {
      ...topic,
      withDetailView: true,
      readonly: true,
      options: { ...topic.options, withExport: true, withImport: true, withOptions: true },
    } as CgTableDetail
    expect(await renderCrud(all)).toEqual(await renderCrud(topic))
  })

  it('demo_invoice (master_sub): the sub entity beside the master, the document written in one transaction; every file compiles', async () => {
    const { importGolden } = await import('./golden.js')
    const invoice = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice'))
    await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice_line'))
    const config = await ctx.run(() => ctx.svc.renderConfig(invoice.id))
    expect(config.subs!.map((s) => s.tableName)).toEqual(['demo_invoice_line'])
    const files = await renderCrud(config)
    const byName = (end: string) => files.find((f) => f.path.endsWith(end))!.content
    const dir = 'apps/server/src/modules/demo/invoice'
    expect(pick(files, `${dir}/`).map((f) => f.path)).toEqual(
      [
        'invoice.entity.ts',
        'invoice-line.entity.ts',
        'invoice.service.ts',
        'invoice.controller.ts',
        'invoice.module.ts',
      ].map((f) => `${dir}/${f}`),
    )
    expect(byName('invoice-line.entity.ts')).toMatch(
      /^\/\/ @generated by qw-codegen \(master_sub\)\n/,
    )
    expect(byName('invoice-line.entity.ts')).toContain(
      'export class InvoiceLine extends BaseEntity {',
    )
    expect(byName('invoice.module.ts')).toContain(
      'TypeOrmModule.forFeature([Invoice, InvoiceLine])',
    )
    const service = byName('invoice.service.ts')
    expect(service).toContain('override create({ lines, ...dto }: InvoiceCreate)')
    expect(service).toContain(
      'private async saveLines(invoiceId: number, rows: InvoiceLineInput[])',
    )
    // soft-deleted like every table: no remove override, the lines follow by the cascade the
    // master's entity registers; lines left out of an update are soft-deleted too
    expect(service).not.toContain('override remove(')
    expect(byName('invoice.entity.ts')).toContain(
      "referencedBy('demo_invoice', { table: 'demo_invoice_line', column: 'invoice_id', cascade: true })",
    )
    expect(byName('invoice-line.entity.ts')).not.toContain('referencedBy')
    expect(service).toContain("await softDeleteRows(this.txHost.tx, 'demo_invoice_line', gone)")
    // a sub row's references are checked like the master's (the base does not write sub rows): an
    // added row whole, an updated one against its stored row (a value it already holds is not re-locked)
    expect(service).toContain(
      "const added = { ...row, invoiceId }\n        await assertReferencesLive(this.txHost.tx, 'demo_invoice_line', added)\n        await repo.insert(added)",
    )
    expect(service).toContain(
      "await assertReferencesLive(this.txHost.tx, 'demo_invoice_line', row, async () =>\n          stored.get(id)!,\n        )\n        await repo.update(id, row)",
    )
    expect(service).not.toMatch(/\.delete\(/)
    // a restrict reference configured on the same column: the cascade wins, registered once
    const same = {
      ...config,
      options: {
        ...config.options,
        referencedBy: [
          { table: 'demo_invoice_line', column: 'invoice_id', label: 'x' },
          { table: 'demo_audit', column: 'invoice_id', label: 'y' },
        ],
      },
    } as RenderConfig
    const refs = (await renderCrud(same))
      .find((f) => f.path.endsWith('/invoice.entity.ts'))!
      .content.match(/^referencedBy\(.*$/gm)
    expect(refs).toEqual([
      "referencedBy('demo_invoice', { table: 'demo_invoice_line', column: 'invoice_id', cascade: true })",
      "referencedBy('demo_invoice', { table: 'demo_audit', column: 'invoice_id' })",
    ])
    expect(byName('invoice.controller.ts')).toContain('return this.invoices.detail(id)')
    const schema = byName('invoice.schema.ts')
    expect(schema).toContain('lines: z.array(invoiceLineInput).max(SUB_ROWS_MAX),')
    expect(schema).toContain(
      'export const invoiceLineInput = z\n  .object({\n    id: z.number().int().positive().optional(),',
    )
    expect(schema).not.toMatch(/invoiceId: z\.number\(\)\.int\(\)\.min/) // the fk is the server's
    // one label fragment and validation domain for the whole document
    expect(JSON.parse(byName('zh-CN/modules/demo.invoice.json')).field.demo.invoice).toMatchObject({
      lines: '发票明细',
      item: '品名',
    })
    expect(byName('form.vue')).toContain('<QwEditTable\n      v-model="model.lines"')
    expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/invoice.schema.ts'))).toEqual(
      [],
    )
    // import and read-only mode do not apply to a document
    const all = {
      ...config,
      readonly: true,
      options: { ...config.options, withImport: true },
    } as RenderConfig
    expect(await renderCrud(all)).toEqual(files)

    // test data of a short dict column without an example, a sub row's too: an entry of its dict that
    // fits the column (never the whole tag), read when the spec starts
    const state = config.columns.find((c) => c.columnName === 'state')!
    const item = config.subs![0]!.columns.find((c) => c.columnName === 'item')!
    const unit = {
      ...item,
      id: 9_999,
      columnName: 'unit',
      fieldName: 'unit',
      columnType: 'varchar(8)',
      widget: 'select',
      dictCode: 'demo.unit',
      sortNo: item.sortNo + 1,
    }
    const dicts = await renderCrud({
      ...config,
      columns: config.columns.map((c) =>
        c === state ? { ...c, example: null, required: true } : c,
      ),
      subs: [{ ...config.subs![0]!, columns: [...config.subs![0]!.columns, unit] }],
    } as RenderConfig)
    const spec = dicts.find((f) => f.path.endsWith('.e2e-spec.ts'))!.content
    expect(spec).toContain("  state: DICT_VALUES['demo.invoice_state'],")
    expect(spec).toContain("  unit: DICT_VALUES['demo.unit'],")
    expect(spec.replace(/\s+/g, ' ')).toContain(
      "for (const [code, max] of [ ['demo.invoice_state', 16], ['demo.unit', 8], ] as const) {",
    )
    expect(typecheck(dicts, sharedIndexWith('packages/shared/src/demo/invoice.schema.ts'))).toEqual(
      [],
    )
    expect(lint(dicts)).toEqual([])
  })

  it('master_sub: needs a linked sub table, a sub its own integer fk and another master, else 422 C3007 on render and save', async () => {
    const { importGolden } = await import('./golden.js')
    const invoice = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice'))
    const line = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice_line'))
    const refused = (table: string) => ({ err: Err.CODEGEN_SUB_TABLES, params: { table } })
    await expect(renderCrud({ ...invoice, subs: [] })).rejects.toMatchObject(
      refused('demo_invoice'),
    )
    await expect(
      renderCrud({ ...invoice, subs: [{ ...line, subFkCol: 'item' }] }),
    ).rejects.toMatchObject(refused('demo_invoice_line'))
    await expect(
      renderCrud({ ...invoice, subs: [{ ...line, masterTableId: line.id }] }),
    ).rejects.toMatchObject(refused('demo_invoice_line'))
    for (const body of [
      { subFkCol: 'item' }, // not an integer column
      { subFkCol: 'id' }, // its key
      { subFkCol: null }, // half a link
      { masterTableId: line.id }, // itself
      { masterTableId: 999_999 }, // no such config
      { template: 'tree' }, // a sub is plain CRUD
    ])
      await expect(ctx.run(() => ctx.svc.save(line.id, body))).rejects.toMatchObject(
        refused('demo_invoice_line'),
      )
    // a master of another template (book is crud) → 422, the link stays
    await expect(
      ctx.run(() => ctx.svc.save(line.id, { masterTableId: book.id })),
    ).rejects.toMatchObject(refused('demo_invoice_line'))
    // the master's only sub never leaves it (unlinked or moved)
    await expect(
      ctx.run(() => ctx.svc.save(line.id, { masterTableId: null, subFkCol: null })),
    ).rejects.toMatchObject(refused('demo_invoice_line'))
    expect((await ctx.run(() => ctx.svc.detail(line.id))).masterTableId).toBe(invoice.id)
    // a master switched to crud releases its subs; linked again once it is master_sub
    await ctx.run(() => ctx.svc.save(invoice.id, { template: 'crud' }))
    expect(await ctx.run(() => ctx.svc.detail(line.id))).toMatchObject({
      masterTableId: null,
      subFkCol: null,
    })
    await expect(
      ctx.run(() => ctx.svc.save(line.id, { masterTableId: invoice.id, subFkCol: 'invoice_id' })),
    ).rejects.toMatchObject(refused('demo_invoice_line'))
    await ctx.run(() => ctx.svc.save(invoice.id, { template: 'master_sub' }))
    await ctx.run(() =>
      ctx.svc.save(line.id, { masterTableId: invoice.id, subFkCol: 'invoice_id' }),
    )
    expect(await renderCrud(await ctx.run(() => ctx.svc.renderConfig(invoice.id)))).not.toEqual([])
    // a master and its sub go in one batch (the reference check does not count a sub deleted with it)
    await ctx.run(() => ctx.svc.remove([invoice.id, line.id]))
    expect(
      await ctx.ds.query('SELECT id FROM cg_table WHERE id IN (?) AND deleted_at IS NULL', [
        [invoice.id, line.id],
      ]),
    ).toEqual([])
  })

  it('tree: needs parent_id + tree_path (as parentId / treePath) and a text label column, else 422 C3004 on render and save', async () => {
    const without = (name: string) =>
      ({ ...topic, columns: topic.columns.filter((c) => c.columnName !== name) }) as CgTableDetail
    const renamed = {
      ...topic,
      columns: topic.columns.map((c) =>
        c.columnName === 'parent_id' ? { ...c, fieldName: 'parent' } : c,
      ),
    } as CgTableDetail
    for (const t of [
      without('tree_path'),
      without('parent_id'),
      without('title'),
      renamed,
      { ...topic, treeLabelCol: 'sort_no' } as CgTableDetail,
      { ...topic, treeParentCol: 'sort_no' } as CgTableDetail,
      {
        ...topic,
        treeLabelCol: null,
        columns: topic.columns.map((c) =>
          c.columnName === 'title' ? { ...c, dictCode: 'demo.genre' } : c,
        ),
      } as CgTableDetail,
    ])
      await expect(renderCrud(t)).rejects.toMatchObject({
        err: Err.CODEGEN_TREE_COLUMNS,
        params: { table: 'demo_topic' },
      })
    await expect(ctx.run(() => ctx.svc.save(book.id, { template: 'tree' }))).rejects.toMatchObject({
      err: Err.CODEGEN_TREE_COLUMNS,
    })
    expect((await ctx.run(() => ctx.svc.detail(book.id))).template).toBe('crud')
  })

  it('a DB comment with */ evil() stays inside the comment', async () => {
    const title = book.columns.find((c) => c.columnName === 'title')!
    const evil = {
      ...book,
      tableComment: 'x */ evil() /*',
      columns: book.columns.map((c) =>
        c === title ? { ...c, columnComment: '*/ evil() //\n evil()' } : c,
      ),
    }
    const files = pick(await renderCrud(evil as CgTableDetail), 'apps/server/src/')
    for (const f of files)
      expect([f.path, parsed(f, 'evil')]).toEqual([f.path, { errors: [], found: false }])
    expect(files[0]!.content).toContain('/** evil() // evil() */')
  })
})

/** The server tsconfig as typecheck() compiles with: + unused locals and parameters, what the lint of a scaffold commit refuses too. */
let tsconfig: ts.ParsedCommandLine | undefined
/**
 * Repository and library files as parsed (and bound) by earlier typecheck() calls: they never change
 * during a run, and parsing them is most of what creating a program costs.
 */
const parsedFiles = new Map<string, ts.SourceFile>()

/**
 * TypeScript errors of the rendered server / shared .ts files as if they were written into the repository
 * (the server tsconfig, @qiwu/shared from source), `extra` files overlaid too (e.g. the shared index
 * exporting a new schema). Nothing is written to disk. The web files need vue-tsc: `pnpm verify` checks
 * them once written (the golden modules are).
 * Only the overlaid files and the repository files importing one of them are checked: every other
 * file of the program is unchanged, so `pnpm verify` already checks it. The rest of the program comes
 * from `parsedFiles`, so a call costs well under a second.
 */
function typecheck(files: RenderedFile[], extra: Record<string, string> = {}): string[] {
  const slash = (path: string) => path.replaceAll('\\', '/')
  const key = (path: string) =>
    process.platform === 'win32' ? slash(path).toLowerCase() : slash(path)
  const virtual = [
    ...files
      // the web and mobile files need vue-tsc (`pnpm verify`, `pnpm mobile:verify` once written)
      .filter(
        (f) =>
          f.path.endsWith('.ts') && !f.path.startsWith('apps/web/') && !f.path.startsWith(MOBILE),
      )
      .map((f) => [slash(join(ROOT, f.path)), f.content] as const),
    ...Object.entries(extra).map(([path, content]) => [slash(join(ROOT, path)), content] as const),
  ]
  const overlay = new Map(virtual.map(([path, content]) => [key(path), content] as const))
  const config = (tsconfig ??= ts.getParsedCommandLineOfConfigFile(
    join(process.cwd(), 'tsconfig.json'),
    {
      customConditions: ['source'],
      noEmit: true,
      incremental: false,
      rootDir: ROOT,
      noUnusedLocals: true,
      noUnusedParameters: true,
    },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(String(d.messageText))
      },
    },
  )!)
  const host = ts.createCompilerHost(config.options)
  const { readFile, fileExists, directoryExists, getSourceFile } = host
  const dirs = virtual.map(([path]) => key(dirname(path)))
  host.readFile = (f) => overlay.get(key(f)) ?? readFile.call(host, f)
  host.fileExists = (f) => overlay.has(key(f)) || fileExists.call(host, f)
  host.directoryExists = (d) =>
    dirs.some((o) => o === key(d) || o.startsWith(`${key(d)}/`)) || !!directoryExists?.call(host, d)
  host.getSourceFile = (f, lang, ...rest) => {
    if (overlay.has(key(f))) return ts.createSourceFile(f, overlay.get(key(f))!, lang)
    let file = parsedFiles.get(key(f))
    if (!file) {
      file = getSourceFile.call(host, f, lang, ...rest)
      if (file) parsedFiles.set(key(f), file)
    }
    return file
  }
  // + the repository's own declarations (ejs.d.ts), which nothing imports
  const roots = [
    ...virtual.map(([path]) => path),
    ...config.fileNames.filter((f) => f.endsWith('.d.ts')),
  ].filter((f) => f.endsWith('.ts'))
  const program = ts.createProgram(roots, config.options, host)
  // An importer is found by its `/<name>.js'` specifier (the repository's import style);
  // resolve each import through the program if another style ever appears
  const imported = virtual.map(([path]) => `/${basename(path, '.ts')}.js'`)
  const checked = program
    .getSourceFiles()
    .filter(
      (f) =>
        overlay.has(key(f.fileName)) ||
        (key(f.fileName).startsWith(`${key(ROOT)}/`) &&
          !f.fileName.includes('/node_modules/') &&
          imported.some((i) => f.text.includes(i))),
    )
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...checked.flatMap((f) => [
      ...program.getSyntacticDiagnostics(f),
      ...program.getSemanticDiagnostics(f),
    ]),
  ].map(
    (d) =>
      `${d.file?.fileName.replaceAll('\\', '/').replace(slash(ROOT), '')}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
  )
}

/**
 * oxlint (the repository config, as lint-staged runs it on a scaffold commit) over the rendered .ts and
 * .vue files, copied below a temporary directory; its problems as `path:line:col: message` lines.
 */
function lint(files: RenderedFile[]): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qw-cg-lint-')))
  try {
    for (const f of files.filter((f) => /\.(ts|vue)$/.test(f.path))) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true })
      writeFileSync(join(dir, f.path), f.content)
    }
    const bin = join(ROOT, 'node_modules/oxlint/bin/oxlint')
    const cfg = join(ROOT, '.oxlintrc.json')
    const r = spawnSync(process.execPath, [bin, '-c', cfg, '--format', 'unix', '.'], {
      cwd: dir,
      encoding: 'utf8',
    })
    if (r.error) throw r.error
    if (r.status !== 0 && r.status !== 1)
      throw new Error(`oxlint exited ${r.status ?? r.signal}: ${r.stderr}`)
    return r.stdout
      .split('\n')
      .map((l) => l.split('\\').join('/').replace(/^\.\//, ''))
      .filter((l) => /^[^:]+:\d+:\d+: /.test(l))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The shared index plus the export line the generator prints for a new schema. */
const sharedIndexWith = (schemaPath: string) => {
  const rel = schemaPath.replace('packages/shared/src/', '').replace(/\.ts$/, '.js')
  const kept = committed('packages/shared/src/index.ts')
    .split('\n')
    .filter((line) => !line.endsWith(`/${rel}'`))
  return { 'packages/shared/src/index.ts': `${kept.join('\n')}export * from './${rel}'\n` }
}

describe('shared', () => {
  const ctx = useCodegen()
  let position: CgTableDetail
  let book: CgTableDetail
  let topic: CgTableDetail
  beforeAll(async () => {
    const { importGolden } = await import('./golden.js')
    position = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'iam_position'))
    book = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_book'))
    topic = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_topic'))
  })

  it('renders the golden position schema, field labels, menu seed and e2e spec byte for byte', async () => {
    const files = (await renderCrud(position)).filter(
      (f) =>
        !f.path.startsWith('apps/web/') &&
        (!f.path.startsWith('apps/server/src/') || f.path.endsWith('.seed.ts')),
    )
    expect(files.map((f) => f.path)).toEqual([
      'apps/server/src/modules/platform/iam/position/position.seed.ts',
      'packages/shared/src/platform/iam/position.schema.ts',
      'packages/shared/src/i18n/zh-CN/modules/iam.position.json',
      'packages/shared/src/i18n/en-US/modules/iam.position.json',
      'apps/server/test/e2e/iam-position.e2e-spec.ts',
    ])
    for (const f of files) expect({ ...f }).toEqual({ path: f.path, content: committed(f.path) })
  })

  it('demo_book: every rendered file compiles; perms, labels and the menu seed follow the config', async () => {
    const files = await renderCrud(book)
    const schema = files.find((f) => f.path.endsWith('.schema.ts'))!
    expect(schema.path).toBe('packages/shared/src/demo/book.schema.ts')
    expect(typecheck(files, sharedIndexWith(schema.path))).toEqual([])
    expect(schema.content).toContain("import: 'demo.book.import',")
    expect(schema.content.replace(/\s+/g, '')).toContain(
      'price:z.number().min(-99_999_999.99).max(99_999_999.99).multipleOf(0.01).meta({example:42.5}).optional(),',
    )
    expect(schema.content).toContain('publishedOnFrom: z.iso.date().optional(),')
    expect(schema.content).toContain('createdAtTo: z.iso.datetime({ offset: true }).optional(),')
    const zh = JSON.parse(
      files.find((f) => f.path.includes('zh-CN/modules/demo.book.json'))!.content,
    )
    expect(zh.field.demo.book).toMatchObject({
      isbn: 'ISBN',
      publishedOnFrom: '出版日期起',
      publishedOnTo: '出版日期止',
    })
    const en = JSON.parse(
      files.find((f) => f.path.includes('en-US/modules/demo.book.json'))!.content,
    )
    expect(en.field.demo.book).toMatchObject({
      publishedOnFrom: 'Published on (from)',
      publishedOnTo: 'Published on (to)',
    })
    const seed = files.find((f) => f.path.endsWith('book.seed.ts'))!.content
    expect(seed).toContain("[bookPerms.import, 'menu.action.import'],")
    expect(seed).toContain("component: 'demo/book/index',")
    expect(seed).toContain("component_name: 'DemoBook',")
  })

  it('demo_topic (tree): every rendered file compiles; forest schemas, no paging, the tree spec', async () => {
    const files = await renderCrud(topic)
    const schema = files.find((f) => f.path.endsWith('.schema.ts'))!
    expect(schema.path).toBe('packages/shared/src/demo/topic.schema.ts')
    expect(typecheck(files, sharedIndexWith(schema.path))).toEqual([])
    expect(schema.content).not.toContain('pageQuery')
    expect(schema.content).toContain('parentId: z.number().int().min(0).optional(),')
    expect(schema.content).toContain(
      'export const topicNodeVo: z.ZodType<TopicNode> = topicVo.extend({',
    )
    expect(schema.content).not.toMatch(/export: |import: /)
    const spec = files.find((f) => f.path.endsWith('.e2e-spec.ts'))!
    expect(spec.path).toBe('apps/server/test/e2e/demo-topic.e2e-spec.ts')
    expect(spec.content).toContain('Err.TREE_PARENT_INVALID.code')
    expect(spec.content).toContain('Err.TREE_CHILD_ENABLED.code')
    const seed = files.find((f) => f.path.endsWith('topic.seed.ts'))!.content
    expect(seed).toContain("[topicPerms.remove, 'menu.action.remove'],\n]")
    expect(seed).toContain("icon: 'lucide:list-tree',")
  })

  it('a column example is its body field Swagger example, typed like the column; none → unchanged', async () => {
    const files = await renderCrud({
      ...book,
      columns: book.columns.map((c) => (c.columnName === 'enabled' ? { ...c, example: '1' } : c)),
    } as CgTableDetail)
    const schema = files.find((f) => f.path.endsWith('.schema.ts'))!.content.replace(/\s+/g, '')
    for (const field of [
      "publishedOn:z.iso.date().meta({example:'2024-05-01'}).nullish(),",
      '.multipleOf(0.01).meta({example:42.5}).optional(),',
      "genre:z.string().trim().min(1).max(16).meta({example:'fiction'}),",
      'enabled:z.boolean().meta({example:true}).optional(),',
      // no example: as before
      'isbn:z.string().trim().min(1).max(20),',
    ])
      expect(schema).toContain(field)
    // the generated spec checks them in the served OpenAPI document
    const spec = files.find((f) => f.path.endsWith('.e2e-spec.ts'))!.content.replace(/\s+/g, '')
    expect(spec).toContain(
      "post.requestBody.content['application/json'].schema.properties,).toMatchObject({publishedOn:{example:'2024-05-01'},price:{example:42.5},genre:{example:'fiction'},enabled:{example:true},})",
    )
  })

  it('the spec keys tags by a text column searched by like (never its example); none → rows by id only', async () => {
    const col = (name: string) => book.columns.find((c) => c.columnName === name)!
    const edited = (edits: Record<string, object>) =>
      ({
        ...book,
        columns: book.columns.map((c) => ({ ...c, ...edits[c.columnName] })),
      }) as CgTableDetail
    const files = await renderCrud(
      edited({ isbn: { example: '978-7', sortable: false }, title: { inQuery: false } }),
    )
    const spec = files.find((f) => f.path.endsWith('.e2e-spec.ts'))!.content
    expect(spec).toContain('  isbn: tag,')
    // an unsortable key is only ever sorted by in the 400 cases (list and export)
    expect(spec.match(/sort: '-?isbn'/g)).toHaveLength(2)
    expect(spec).toContain(".query({ sort: 'isbn' }).expect(400)")
    expect(spec).toContain("(await exported('admin', { sort: 'isbn' })).res.status).toBe(400)")
    expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual([])
    expect(col('isbn').example).toBeNull()
    // no such column: the spec still comes, finding its rows by id; the 400 case leaves out a required field
    const none = await renderCrud(edited({ isbn: { inQuery: false }, title: { inQuery: false } }))
    const keyless = none.find((f) => f.path.endsWith('.e2e-spec.ts'))!.content
    expect(
      none.filter((f) => !f.path.startsWith('apps/web/') && !f.path.startsWith(MOBILE)),
    ).toHaveLength(9)
    expect(keyless).not.toContain('text filters contain')
    expect(keyless).toContain("const PREFIX = 'e2e-book-'")
    expect(keyless).toContain("await ds.query('DELETE FROM demo_book WHERE id > ?', [lastId])")
    expect(keyless).toContain('const { isbn: _left, ...left } = body(unique())')
    expect(keyless).toMatch(/await exported\('admin', \{\}, \{ 'X-Request-Id': traceId \}\)/)
    expect(typecheck(none, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual([])
    // the CLI prints the registration lines
    const lines = crudRegistration(book)
    expect(lines.slice(0, 2)).toEqual([
      'apps/server/src/modules/project.module.ts:',
      "  import { BookModule } from './demo/book/book.module.js'  + BookModule in `imports`",
    ])
    expect(crudRegistration(position).slice(0, 2)).toEqual([
      "apps/server/src/modules/platform/iam/iam.module.ts (or the module that imports this domain's modules):",
      "  import { PositionModule } from './position/position.module.js'  + PositionModule in `imports`",
    ])
    expect(lines).toContain(
      "  import { seedBook } from '../../modules/demo/book/book.seed.js'  + seedBook in SEEDS.demo",
    )
    expect(lines).toContain("  export * from './demo/book.schema.js'")
  })

  it('names the templates use already: cfg_param defaults to SettingsParam and compiles; reserved class / field names → 422 C3002 on save and render', async () => {
    const param = await ctx.run(() => ctx.svc.defaults('cfg_param'))
    // `Param` would clash with the controller's `Param` import from @nestjs/common
    expect(param.className).toBe('SettingsParam')
    // beside the hand-written settings/param module: another business, the same class default
    const files = await renderCrud({ ...param, business: 'param-probe' } as CgTableDetail)
    const schema = files.find((f) => f.path.endsWith('.schema.ts'))!
    expect(files.find((f) => f.path.endsWith('.controller.ts'))!.content).toContain(
      'export class SettingsParamController {',
    )
    expect(typecheck(files, sharedIndexWith(schema.path))).toEqual([])
    const refused = (name: string) => ({ err: Err.CODEGEN_IDENTIFIER_INVALID, params: { name } })
    const title = book.columns.find((c) => c.columnName === 'title')!
    for (const [edit, name] of [
      [{ className: 'Param' }, 'Param'],
      [{ className: 'Date' }, 'Date'],
      // `crudApi` / `treeApi` beside `<biz>Api` in the web and mobile api files
      [{ className: 'Crud' }, 'Crud'],
      [{ className: 'Tree' }, 'Tree'],
      [{ columns: [{ id: title.id, fieldName: 'default' }] }, 'default'],
      [{ columns: [{ id: title.id, fieldName: 'qb' }] }, 'qb'],
    ] as const)
      await expect(ctx.run(() => ctx.svc.save(book.id, edit))).rejects.toMatchObject(refused(name))
    expect((await ctx.run(() => ctx.svc.detail(book.id))).className).toBe('Book')
    // stored anyway (a hand-edited row, a seed): rendering refuses them too
    await expect(
      renderCrud({ ...book, className: 'Entity' } as CgTableDetail),
    ).rejects.toMatchObject(refused('Entity'))
    await expect(renderCrud({ ...book, className: 'Crud' } as CgTableDetail)).rejects.toMatchObject(
      refused('Crud'),
    )
    const deleteField = {
      ...book,
      columns: book.columns.map((c) => (c === title ? { ...c, fieldName: 'delete' } : c)),
    } as CgTableDetail
    await expect(renderCrud(deleteField)).rejects.toMatchObject(refused('delete'))
  })

  it('import without a unique imported column: insert only (server, Swagger, web dialog, spec)', async () => {
    for (const isbn of [{ options: {} }, { inForm: false }]) {
      const files = await renderCrud({
        ...book,
        columns: book.columns.map((c) => (c.columnName === 'isbn' ? { ...c, ...isbn } : c)),
      } as CgTableDetail)
      const text = (end: string) => files.find((f) => f.path.endsWith(end))!.content
      expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual(
        [],
      )
      const controller = text('book.controller.ts')
      expect(controller).toContain(
        '@Body({ schema: insertImportBody }) { mode }: InsertImportBody,',
      )
      expect(controller).toContain(
        "mode: { type: 'string', enum: [...INSERT_ONLY_MODES], default: 'insert' },",
      )
      expect(controller).toContain('(multipart: file + mode insert);')
      expect(text('book.service.ts')).toContain('_mode: ImportMode')
      expect(text('book.service.ts')).not.toContain("mode === 'upsert'")
      expect(text('index.vue')).toContain("modes: ['insert'],")
      expect(text('.e2e-spec.ts')).toContain(
        "await upload('admin', await xlsx([body(`${tag}-a`)]), 'upsert').expect(400)",
      )
    }
    expect(insertImportBody.safeParse({ mode: 'upsert' }).success).toBe(false)
    expect(insertImportBody.parse({})).toEqual({ mode: 'insert' })
    // demo_book imports its unique isbn: both modes
    const files = await renderCrud(book)
    expect(files.find((f) => f.path.endsWith('book.controller.ts'))!.content).toContain(
      '@Body({ schema: importBody }) { mode }: ImportBody,',
    )
    expect(files.find((f) => f.path.endsWith('index.vue'))!.content).not.toContain('modes:')
  })

  it('readonly: list, view and export only (no write routes, perms, menu actions, buttons or form)', async () => {
    const files = await renderCrud({ ...book, readonly: true } as CgTableDetail)
    const text = (end: string) => files.find((f) => f.path.endsWith(end))?.content
    expect(files.map((f) => f.path).filter((p) => p.endsWith('form.vue'))).toEqual([])
    expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual([])
    const controller = text('book.controller.ts')!
    expect(controller.match(/@(Get|Post|Put|Delete)\([^)]*\)/g)).toEqual([
      '@Get()',
      "@Get('export')",
      "@Get(':id')",
    ])
    expect(controller).not.toMatch(/Idempotent|UploadFile|bookCreate/)
    const schema = text('book.schema.ts')!
    expect(schema).toMatch(
      /bookPerms = \{\n {2}browse: 'demo.book.browse',\n {2}view: 'demo.book.view',\n {2}export: 'demo.book.export',\n\}/,
    )
    expect(schema).not.toMatch(/bookCreate|bookUpdate/)
    expect(text('book.seed.ts')!.match(/\[bookPerms\.\w+/g)).toEqual([
      '[bookPerms.browse',
      '[bookPerms.view',
      '[bookPerms.export',
    ])
    expect(text('book.service.ts')).not.toContain('importXlsx')
    expect(text('apps/web/src/api/demo/book.ts')).toContain('...crudApi<BookVo>(BASE),')
    expect(text('apps/web/src/api/demo/book.ts')).not.toMatch(
      /setEnabled|importFile|importTemplate/,
    )
    const index = text('index.vue')!
    expect(index).not.toMatch(
      /openForm|BookForm|batchRemove|selection|#actions|el-switch|openImport/,
    )
    expect(index).toContain('<DictTag code="core.enabled" :value="row.enabled" />')
    expect(index).toContain('v-perm="bookPerms.export"')
    const spec = text('.e2e-spec.ts')!
    expect(spec).toContain("import { Book } from '../../src/modules/demo/book/book.entity.js'")
    expect(spec).toContain('no write routes (POST / PUT / DELETE → 404, nothing written)')
    expect(spec).not.toMatch(/(?<!\.)\bcreate\(|@Idempotent|ActionLog: every write/)
  })

  it('append-only tables (no created_by / updated_by / updated_at): a read-only page over CreatedEntity / IdEntity; lints and type-checks', async () => {
    for (const table of ['aud_action_log', 'aud_signin_log']) {
      const log = await ctx.run(() => ctx.svc.defaults(table))
      expect(log.readonly).toBe(false)
      // beside the hand-written audit module: another business and class
      const Biz = `${log.className}Probe`
      const probe = { ...log, business: `${log.business}-probe`, className: Biz } as CgTableDetail
      const files = await renderCrud(probe)
      const text = (end: string) => files.find((f) => f.path.endsWith(end))?.content
      expect(text('.entity.ts')).toContain(`export class ${Biz} extends CreatedEntity {`)
      expect(text('.entity.ts')).not.toMatch(/createdBy|updatedAt/)
      // read-only whatever the config says: GET routes only, no form
      expect(text('.controller.ts')!.match(/@(Get|Post|Put|Delete)\([^)]*\)/g)).toEqual([
        '@Get()',
        "@Get('export')",
        "@Get(':id')",
      ])
      expect(files.some((f) => f.path.endsWith('form.vue'))).toBe(false)
      expect(text('.schema.ts')).toContain('createdAt: z.iso.datetime(),')
      expect(text('.schema.ts')).not.toMatch(/createdBy|updatedBy|updatedAt/)
      const schema = files.find((f) => f.path.endsWith('.schema.ts'))!
      expect(typecheck(files, sharedIndexWith(schema.path))).toEqual([])
      expect(lint(files)).toEqual([])
    }
    // without created_at: IdEntity, newest first by id
    const log = await ctx.run(() => ctx.svc.defaults('aud_action_log'))
    const bare = {
      ...log,
      business: 'bare-log',
      columns: log.columns.filter((c) => c.columnName !== 'created_at'),
    } as CgTableDetail
    const files = await renderCrud(bare)
    expect(files.find((f) => f.path.endsWith('.entity.ts'))!.content).toContain(
      'extends IdEntity {',
    )
    expect(files.find((f) => f.path.endsWith('index.vue'))!.content).toContain("sort: '-id'")
    expect(
      typecheck(files, sharedIndexWith('packages/shared/src/platform/audit/bare-log.schema.ts')),
    ).toEqual([])
    expect(lint(files)).toEqual([])
    // partly audited (or soft-deleted) tables, and append-only trees / masters, stay refused
    const unavailable = { err: Err.CODEGEN_TABLE_UNAVAILABLE }
    const partly = { ...book, columns: book.columns.filter((c) => c.columnName !== 'updated_by') }
    await expect(renderCrud(partly as CgTableDetail)).rejects.toMatchObject(unavailable)
    await expect(
      renderCrud({ ...bare, template: 'master_sub', subs: [] } as RenderConfig),
    ).rejects.toMatchObject(unavailable)
  })

  it('richtext: the core RichEditor in the form, sanitized by the service on create / update and GET /:id, v-html in the detail drawer, text in the list', async () => {
    const title = book.columns.find((c) => c.columnName === 'title')!
    const intro = {
      ...title,
      id: 9_998,
      columnName: 'intro',
      fieldName: 'intro',
      columnType: 'text',
      widget: 'richtext',
      inList: true,
      inForm: true,
      inQuery: false,
      required: false,
      nullable: true,
      example: null,
      options: {},
      sortNo: title.sortNo + 1,
    }
    const rich = { ...book, columns: [...book.columns, intro] } as CgTableDetail
    const files = await renderCrud(rich)
    const text = (end: string) => files.find((f) => f.path.endsWith(end))!.content
    expect(text('form.vue')).toContain("import RichEditor from '@/core/components/RichEditor.vue'")
    expect(text('form.vue')).toContain('<RichEditor v-model="model.intro" :height="320" />')
    const service = text('book.service.ts')
    expect(service).toContain("import { sanitizeFields } from '../../../core/sanitize.js'")
    expect(service).toContain("const RICH_TEXT = ['intro']")
    expect(service).toContain('return super.create(sanitizeFields(dto, RICH_TEXT))')
    expect(service).toContain('return super.update(id, sanitizeFields(dto, RICH_TEXT))')
    expect(text('detail.vue')).toContain('<div class="qw-detail__html" v-html="row.intro" />')
    expect(text('index.vue')).toContain(
      '<template #cell-intro="{ row }">{{ htmlText(row.intro) }}</template>',
    )
    expect(text('.e2e-spec.ts')).toContain(
      "it('rich text: intro stored and read as the core/sanitize.ts allow-list leaves it'",
    )
    expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual([])
    expect(lint(files)).toEqual([])
    // GET /:id sanitizes too (rows stored before or behind the API's back): so does a read-only page
    expect(service).toContain('return sanitizeFields(await super.get(id), RICH_TEXT)')
    const view = await renderCrud({ ...rich, readonly: true } as CgTableDetail)
    const viewService = view.find((f) => f.path.endsWith('book.service.ts'))!.content
    expect(viewService).toContain('return sanitizeFields(await super.get(id), RICH_TEXT)')
    expect(viewService).not.toMatch(/override (create|update)/)
    expect(view.find((f) => f.path.endsWith('detail.vue'))!.content).toContain('v-html="row.intro"')
    expect(typecheck(view, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual([])
    expect(lint(view)).toEqual([])
    // master-sub: the document's create / update sanitize the master's fields
    const { importGolden } = await import('./golden.js')
    const invoice = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice'))
    await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice_line'))
    const config = await ctx.run(() => ctx.svc.renderConfig(invoice.id))
    const sub = config.subs![0]!
    const doc = await renderCrud({
      ...config,
      columns: [...config.columns, { ...intro, tableId: invoice.id }],
      subs: [{ ...sub, columns: [...sub.columns, { ...intro, id: 9_997, tableId: sub.id }] }],
    } as RenderConfig)
    const docService = doc.find((f) => f.path.endsWith('invoice.service.ts'))!.content
    expect(docService).toContain('await super.create(sanitizeFields(dto, RICH_TEXT))')
    expect(docService).toContain('await super.update(id, sanitizeFields(dto, RICH_TEXT))')
    // a sub row's rich text: sanitized when the rows are saved
    expect(docService).toContain("sanitizeFields(row, ['intro'])")
    expect(docService).toContain('const added = { ...clean(row), invoiceId }')
    expect(docService).toContain('await repo.update(id, clean(row))')
    expect(lint(doc)).toEqual([])
    expect(typecheck(doc, sharedIndexWith('packages/shared/src/demo/invoice.schema.ts'))).toEqual(
      [],
    )
  })

  it('every variant lints and type-checks clean (no unused helper): read-only without export, export without created_at or enabled', async () => {
    const without = (...names: string[]) =>
      book.columns.map((c) => (names.includes(c.columnName) ? { ...c, inList: false } : c))
    const variants = [
      { ...book, readonly: true, options: { ...book.options, withExport: false } },
      { ...book, readonly: true, columns: without('created_at') },
      { ...book, columns: without('created_at', 'enabled') },
      { ...book, columns: book.columns.filter((c) => c.columnName !== 'enabled') },
    ] as CgTableDetail[]
    for (const variant of variants) {
      const files = await renderCrud(variant)
      expect(lint(files)).toEqual([])
      expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual(
        [],
      )
    }
    const spec = async (t: CgTableDetail) =>
      (await renderCrud(t)).find((f) => f.path.endsWith('.e2e-spec.ts'))!.content
    expect(await spec(variants[0]!)).not.toContain('logOf')
    expect(await spec(variants[3]!)).not.toContain('dictLabel')
    // the export's rows counted before it (an action-log export adds a row of its own)
    expect(await spec(book)).toContain('expect(ws!.actualRowCount).toBe(rows + 1)')
  })

  it('a decimal wider than 15 digits stays a string: decimal-string check, text input and Excel cell', async () => {
    const files = await renderCrud({
      ...book,
      columns: book.columns.map((c) =>
        c.columnName === 'price'
          ? { ...c, columnType: 'decimal(20,4)', columnDefault: '0.0000', tsType: 'string' }
          : c,
      ),
    } as CgTableDetail)
    const text = (end: string) => files.find((f) => f.path.endsWith(end))!.content
    expect(typecheck(files, sharedIndexWith('packages/shared/src/demo/book.schema.ts'))).toEqual([])
    expect(text('book.schema.ts').replace(/\s+/g, '')).toContain(
      "price:z.string().trim().regex(/^-?\\d{1,16}(\\.\\d{1,4})?$/).meta({example:'42.5000'}).optional(),",
    )
    expect(text('book.schema.ts')).toContain('  price: z.string(),')
    expect(text('book.entity.ts')).toContain(
      "@Column({ type: 'decimal', precision: 20, scale: 4, default: '0.0000' })\n  price: string",
    )
    expect(text('book.service.ts')).toContain("{ prop: 'price', label: 'field.demo.book.price' },")
    expect(text('form.vue')).toContain('<el-input v-model="model.price" maxlength="22" />')
    expect(text('form.vue')).toContain("price: '0.0000',")
    expect(text('index.vue')).not.toContain('toFixed')
    expect(text('index.vue')).toMatch(/prop: 'price',[^}]+width: 190, align: 'right' }/)
    // test data as MySQL answers it: every digit of the scale
    expect(text('.e2e-spec.ts')).toContain("price: '42.5000',")
  })

  it('DB texts stay comments and strings: a */ evil() comment or label renders, compiles and runs nothing', async () => {
    const evilText = '*/ evil() // \'" `${evil()}` </script> <!-- --> \n evil()'
    const evil = {
      ...book,
      tableComment: evilText,
      featureName: evilText.slice(0, 128),
      featureNameI18n: { 'zh-CN': evilText, 'en-US': evilText },
      options: { ...book.options, entityI18n: { 'zh-CN': evilText, 'en-US': evilText } },
      columns: book.columns.map((c) =>
        c.columnName === 'title'
          ? {
              ...c,
              columnComment: evilText,
              labelI18n: { 'zh-CN': evilText, 'en-US': evilText },
              example: evilText,
            }
          : c,
      ),
    } as CgTableDetail
    const files = await renderCrud(evil)
    const schema = files.find((f) => f.path.endsWith('.schema.ts'))!
    expect(typecheck(files, sharedIndexWith(schema.path))).toEqual([])
    for (const f of files.filter((f) => f.path.endsWith('.ts')))
      expect([f.path, parsed(f, 'evil')]).toEqual([f.path, { errors: [], found: false }])
    const zh = JSON.parse(
      files.find((f) => f.path.includes('zh-CN/modules/demo.book.json'))!.content,
    )
    expect(zh.field.demo.book.title).toBe(evilText)
    // the example is test data and the Swagger example: string literals holding the text as is
    const literals = (end: string, prop: string) => {
      const f = files.find((f) => f.path.endsWith(end))!
      const found: string[] = []
      const walk = (n: ts.Node): void => {
        if (
          ts.isPropertyAssignment(n) &&
          n.name.getText() === prop &&
          ts.isStringLiteral(n.initializer)
        )
          found.push(n.initializer.text)
        n.forEachChild(walk)
      }
      walk(ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, true))
      return found
    }
    expect(literals('.e2e-spec.ts', 'title')).toContain(evilText)
    expect(literals('.schema.ts', 'example')).toContain(evilText)
  })
})

describe('web', () => {
  const ctx = useCodegen()
  let position: CgTableDetail
  let book: CgTableDetail
  let topic: CgTableDetail
  let invoice: RenderConfig
  beforeAll(async () => {
    const { importGolden } = await import('./golden.js')
    position = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'iam_position'))
    book = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_book'))
    topic = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_topic'))
    const master = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice'))
    await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice_line'))
    invoice = await ctx.run(() => ctx.svc.renderConfig(master.id))
  })
  const web = async (t: CgTableDetail) =>
    Object.fromEntries(
      (await renderCrud(t))
        .filter((f) => f.path.startsWith('apps/web/'))
        .map((f) => [f.path, f.content]),
    )

  it('renders the golden position api, list page, form and locale fragments byte for byte', async () => {
    const files = await web(position)
    expect(Object.keys(files)).toEqual([
      'apps/web/src/api/platform/iam/position.ts',
      'apps/web/src/views/platform/iam/position/index.vue',
      'apps/web/src/views/platform/iam/position/form.vue',
      'apps/web/src/locales/zh-CN/iam.position.json',
      'apps/web/src/locales/en-US/iam.position.json',
    ])
    for (const [path, content] of Object.entries(files))
      expect({ path, content }).toEqual({ path, content: committed(path) })
  })

  it('date and datetime query ranges share shortcuts; pages without date queries omit the import', async () => {
    const { parse, compileScript, compileTemplate } = createRequire(
      new URL('../../../web/package.json', import.meta.url),
    )('vue/compiler-sfc')
    for (const config of [
      book,
      {
        ...topic,
        columns: topic.columns.map((c) =>
          c.columnName === 'created_at' ? { ...c, inQuery: true } : c,
        ),
      },
      invoice,
      { ...book, readonly: true },
    ]) {
      const files = await renderCrud(config)
      const index = files.find(
        (f) => f.path.endsWith('/index.vue') && f.path.startsWith('apps/web/'),
      )!.content
      expect(index).toContain("import { useDateRangeShortcuts } from '@/core/date-shortcuts'")
      expect(index).toContain('const dateRangeShortcuts = useDateRangeShortcuts()')
      const ranges = crudModel(config).filters.filter(
        (c) => c.queryOp === 'between' && ['date', 'datetime'].includes(c.widget),
      )
      expect(ranges.length).toBeGreaterThan(0)
      for (const c of ranges) {
        expect(index).toMatch(
          new RegExp(
            `v-model="query.${c.web.filterKey}"\\s+type="daterange"\\s+:shortcuts="dateRangeShortcuts"\\s+value-format="YYYY-MM-DD"`,
          ),
        )
      }
      expect(index.match(/:shortcuts="dateRangeShortcuts"/g)).toHaveLength(ranges.length)
      expect(index).not.toContain('common.dateRange.')
      const { descriptor, errors } = parse(index, { filename: 'index.vue' })
      expect(errors).toEqual([])
      const script = compileScript(descriptor, { id: config.business })
      expect(ts.transpileModule(script.content, { reportDiagnostics: true }).diagnostics).toEqual(
        [],
      )
      expect(
        compileTemplate({
          source: descriptor.template.content,
          filename: 'index.vue',
          id: config.business,
          compilerOptions: { bindingMetadata: script.bindings },
        }).errors,
      ).toEqual([])
    }
    for (const config of [
      position,
      topic,
      { ...book, columns: book.columns.map((c) => ({ ...c, inQuery: false })) },
    ]) {
      const files = await web(config)
      const index = Object.entries(files).find(([path]) => path.endsWith('/index.vue'))![1]
      expect(index).not.toContain('date-shortcuts')
      expect(index).not.toContain('dateRangeShortcuts')
    }
  })

  it('demo_topic (tree): the tree table page (label column first, no paging) and the parent picker', async () => {
    const files = await web(topic)
    const dir = 'apps/web/src/views/demo/topic'
    expect(Object.keys(files)).toEqual([
      'apps/web/src/api/demo/topic.ts',
      `${dir}/index.vue`,
      `${dir}/form.vue`,
      'apps/web/src/locales/zh-CN/demo.topic.json',
      'apps/web/src/locales/en-US/demo.topic.json',
    ])
    const [api, index, form] = Object.values(files)
    expect(api).toContain('...treeApi<TopicVo, TopicCreate>(BASE),')
    expect(index).toContain('useTreeList({')
    expect(index).toContain(':default-expand-all="expanded"')
    expect(index).toContain(
      "{ prop: 'title', label: 'field.demo.topic.title', minWidth: 240, showOverflowTooltip: true },",
    )
    expect(index).toContain('@click="openForm(undefined, row.id)"')
    expect(index).toContain(':disabled="row.children.length > 0"')
    expect(index).not.toMatch(/Pagination|selection|sortable|batchDelete/)
    expect(form).toContain(
      'const { id, parentId = 0 } = defineProps<{ id?: number; parentId?: number }>()',
    )
    expect(form).toContain("emptyModel: () => ({ parentId, title: '', sortNo: 0, enabled: true }),")
    expect(form).toContain(':load="() => topicApi.list({ enabled: true })"')
    expect(form).toContain(':exclude="id"')
  })

  it('demo_book: detail drawer, import dialog, dict/date/image/number widgets, date ranges', async () => {
    const files = await web(book)
    const dir = 'apps/web/src/views/demo/book'
    const [api, index, form, detail] = [
      'apps/web/src/api/demo/book.ts',
      'index',
      'form',
      'detail',
    ].map((p) => files[p.includes('/') ? p : `${dir}/${p}.vue`]!)
    expect(api).toContain('importFile(file: File, mode: ImportMode) {')
    expect(api).not.toContain('options:')
    expect(index).toContain("import BookDetail from './detail.vue'")
    expect(index).toContain('publishedOnDates: null as [string, string] | null,')
    expect(index).toContain('createdAtRange: null as [string, string] | null,')
    expect(index).toContain('<DictSelect v-model="query.genre" code="demo.genre" />')
    expect(index).toContain('<DictTag code="demo.genre" :value="row.genre" />')
    expect(index).toContain("sort: '-createdAt',")
    expect(index).toContain('v-perm="bookPerms.import" @click="openImport"')
    expect(index).toContain(
      "{ prop: 'price', label: 'field.demo.book.price', sortable: true, width: 120, align: 'right' },",
    )
    // no free-text column: the label column takes the spare width
    expect(index).toMatch(
      /prop: 'title',\n\s+label: 'field.demo.book.title',\n\s+sortable: true,\n\s+minWidth: 160,/,
    )
    expect(index).toContain('class="qw-cell-link"')
    // widths: a short text as wide as its values, a header never cut (en-US "Published on" + caret)
    expect(index).toMatch(/prop: 'isbn',[^}]+width: 180,/)
    expect(index).toContain(
      "{ prop: 'publishedOn', label: 'field.demo.book.publishedOn', sortable: true, width: 140 },",
    )
    expect(index).toMatch(/prop: 'genre',[^}]+showOverflowTooltip: true,/)
    // decimals keep their scale
    expect(index).toContain('<template #cell-price="{ row }">{{ row.price.toFixed(2) }}</template>')
    expect(detail).toContain('{{ row.price.toFixed(2) }}')
    expect(form).toContain('<ImageUpload v-model="coverUrlFiles" biz-tag="cover" />')
    expect(form).toContain(
      '<el-date-picker v-model="model.publishedOn" type="date" value-format="YYYY-MM-DD" />',
    )
    expect(form).toMatch(
      /:min="-99999999.99"\n\s+:max="99999999.99"\n\s+:precision="2"\n\s+:step="0.01"/,
    )
    expect(form).toContain('publishedOn: null,')
    expect(form).toContain('price: 0,')
    expect(detail).toContain("defineOptions({ name: 'DemoBookDetail' })")
    expect(detail).toContain('{{ time(row.createdAt) }}')
    expect(JSON.parse(files['apps/web/src/locales/en-US/demo.book.json']!)).toEqual({
      demo: {
        book: {
          entity: 'book',
        },
      },
      menu: { demo: { book: 'Books' } },
    })
  })

  it('the other widgets: radio, user and dept pickers, file upload, datetime, textarea', async () => {
    let n = 1000
    const base = book.columns.find((c) => c.columnName === 'author')!
    const col = (columnName: string, columnType: string, extra: object) => ({
      ...base,
      id: ++n,
      sortNo: n,
      columnName,
      columnType,
      columnDefault: null,
      fieldName: columnName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      options: {},
      ...extra,
    })
    const files = await web({
      ...book,
      withDetailView: false,
      columns: [
        ...book.columns.map((c) =>
          c.columnName === 'author' ? { ...c, widget: 'radio', dictCode: 'demo.genre' } : c,
        ),
        col('owner_user_id', 'bigint unsigned', {
          tsType: 'number',
          widget: 'user-picker',
          nullable: false,
          required: true,
          inQuery: true,
        }),
        col('dept_id', 'bigint unsigned', {
          tsType: 'number',
          widget: 'dept-tree-select',
          inQuery: true,
        }),
        col('attachment', 'varchar(512)', { tsType: 'string', widget: 'file-upload' }),
        col('due_at', 'datetime(3)', {
          tsType: 'Date',
          widget: 'datetime',
          inQuery: true,
          queryOp: 'between',
        }),
        col('summary', 'text', { tsType: 'string', widget: 'textarea' }),
        col('starts_at', 'datetime(3)', {
          tsType: 'Date',
          widget: 'datetime',
          nullable: false,
          columnDefault: 'CURRENT_TIMESTAMP(3)',
        }),
      ],
    } as CgTableDetail)
    const dir = 'apps/web/src/views/demo/book'
    expect(Object.keys(files)).not.toContain(`${dir}/detail.vue`)
    const [index, form] = [files[`${dir}/index.vue`]!, files[`${dir}/form.vue`]!]
    expect(form).toContain("const { options: authorOptions } = useDict('demo.genre')")
    expect(form).toContain('<el-radio v-for="o in authorOptions"')
    expect(form).toContain('<UserSelect v-model="model.ownerUserId" />')
    expect(form).toContain('<DeptTreeSelect v-model="model.deptId" />')
    expect(form).toContain("const attachmentFiles = uploadField(model, 'attachment', 'file')")
    expect(form).toContain('<FileUpload v-model="attachmentFiles" :limit="1" />')
    expect(form).toContain('value-format="YYYY-MM-DD[T]HH:mm:ss.SSSZ"')
    // a required picker starts empty; the form's rules report it
    expect(form).toContain('ownerUserId: null,')
    // NOT NULL with an expression default: the schema only allows leaving it out, so it starts unset
    expect(form).toContain('startsAt: undefined,')
    expect(form).toMatch(
      /v-model="model.summary"\n\s+type="textarea"\n\s+:rows="3"\n\s+maxlength="16383"/,
    )
    expect(index).toContain('<UserSelect v-model="query.ownerUserId" />')
    expect(index).toContain('<DeptTreeSelect v-model="query.deptId" />')
    expect(index).toContain('dueAtRange: null as [string, string] | null,')
    expect(index).toContain('ownerUserId: null as number | null,')
    expect(index).toContain('{{ uploadName(row.attachment) }}')
    expect(index).not.toContain('openDetail')
    // the free text comes last and takes the spare width; the label column is fixed again
    expect(index).toMatch(/prop: 'summary',[^}]+minWidth: 120,[^}]+\},\n\]/)
    expect(index).toMatch(/prop: 'title',[^}]+width: 160,/)
  })

  it('form_cols 2 / 3: that many field columns (uploads and free text a whole row), a wider dialog', async () => {
    const dir = 'apps/web/src/views/demo/book'
    expect((await web(book))[`${dir}/form.vue`]).not.toContain('qw-form-')
    for (const [formCols, width] of [
      [2, 880],
      [3, 1200],
    ] as const) {
      const files = await web({ ...book, formCols })
      const [index, form] = [files[`${dir}/index.vue`]!, files[`${dir}/form.vue`]!]
      expect(form).toContain(`class="qw-form-cols-${formCols}"`)
      // the cover upload takes a whole row, every other field one label + field pair
      expect(form).toMatch(/prop="coverUrl"\s+class="qw-form-wide"/)
      expect(form.match(/qw-form-wide/g)).toHaveLength(1)
      expect(index).toContain(`width: '${width}px'`)
    }
  })

  it('DB texts reach the web files only as JSON strings of the locale fragments', async () => {
    const evilText = '*/ evil() \'" `${evil()}` </script> <!-- --> {{ evil() }} \n evil()'
    const files = await web({
      ...book,
      featureNameI18n: { 'zh-CN': evilText, 'en-US': evilText },
      options: {
        ...book.options,
        entityI18n: { 'zh-CN': evilText, 'en-US': evilText },
      },
      columns: book.columns.map((c) =>
        c.columnName === 'title'
          ? { ...c, columnComment: evilText, labelI18n: { 'zh-CN': evilText, 'en-US': evilText } }
          : c,
      ),
    } as CgTableDetail)
    const entries = Object.entries(files)
    const json = entries.filter(([path]) => path.endsWith('.json'))
    expect(json).toHaveLength(2)
    for (const [, content] of json)
      expect(JSON.parse(content)).toMatchObject({
        demo: { book: { entity: evilText } },
        menu: { demo: { book: evilText } },
      })
    const code = entries.filter(([path]) => !path.endsWith('.json'))
    expect(code.filter(([, content]) => content.includes('evil')).map(([path]) => path)).toEqual([])
  })
})

describe('mobile', () => {
  const ctx = useCodegen()
  let position: CgTableDetail
  let book: CgTableDetail
  let topic: CgTableDetail
  let invoice: RenderConfig
  beforeAll(async () => {
    const { importGolden } = await import('./golden.js')
    position = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'iam_position'))
    book = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_book'))
    topic = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_topic'))
    const master = await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice'))
    await ctx.run(() => importGolden(ctx.ds, ctx.svc, 'demo_invoice_line'))
    invoice = await ctx.run(() => ctx.svc.renderConfig(master.id))
  })
  /** The mobile files of `t` as rendered where the repository has the client (whether it has or not). */
  const mobile = async (t: RenderConfig) =>
    Object.fromEntries(
      (await renderCrud(t, true))
        .filter((f) => f.path.startsWith(MOBILE))
        .map((f) => [f.path, f.content]),
    )
  const pages = (home: string, form = true) => [
    `${MOBILE}api/${home}.ts`,
    `${MOBILE}pages-biz/${home}/index.vue`,
    `${MOBILE}pages-biz/${home}/detail.vue`,
    ...(form ? [`${MOBILE}pages-biz/${home}/form.vue`] : []),
    `${MOBILE}locales/zh-CN/${home.replace('/', '.')}.json`,
    `${MOBILE}locales/en-US/${home.replace('/', '.')}.json`,
  ]

  it('only a withMobile config, only where the repository has the client: renderCrud, targets and registration', async () => {
    // withMobile off (the platform's iam_position)
    expect(await mobile(position)).toEqual({})
    // no client: none, whatever the config
    expect((await renderCrud(book, false)).filter((f) => f.path.startsWith(MOBILE))).toEqual([])
    expect(crudTargets(crudModel(book), false).filter((t) => t.path.startsWith(MOBILE))).toEqual([])
    expect(
      crudTargets(crudModel(book), true).filter((t) => t.path.startsWith(MOBILE)),
    ).toHaveLength(6)
    // the default asks the repository: the one at hand, a tree with mobile/src/pages.json or without
    expect(hasMobile()).toBe(existsSync(join(ROOT, MOBILE, 'pages.json')))
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'qw-cg-mobile-')))
    try {
      expect(hasMobile(join(tmp, 'apps/server'))).toBe(false)
      mkdirSync(join(tmp, MOBILE), { recursive: true })
      expect(hasMobile(join(tmp, 'apps/server'))).toBe(false)
      writeFileSync(join(tmp, MOBILE, 'pages.json'), '{}')
      expect(hasMobile(join(tmp, 'apps/server'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    // the pages.json lines to add by hand (the generator edits no existing file)
    expect(crudRegistration(book, false).join('\n')).not.toContain('pages.json')
    expect(crudRegistration(position, true).join('\n')).not.toContain('pages.json')
    expect(crudRegistration(book, true).slice(-5)).toEqual([
      `${MOBILE}pages.json (subpackage "pages-biz"):`,
      '  { "path": "demo/book/index", "style": {} }',
      '  { "path": "demo/book/detail", "style": {} }',
      '  { "path": "demo/book/form", "style": {} }',
      `  an entry point is up to the project, e.g. a shortcut in ${MOBILE}pages/home/index.vue (SHORTCUTS) to /pages-biz/demo/book/index`,
    ])
    const readonly = { ...book, readonly: true } as CgTableDetail
    expect(crudRegistration(readonly, true).slice(-3, -1)).toEqual([
      '  { "path": "demo/book/index", "style": {} }',
      '  { "path": "demo/book/detail", "style": {} }',
    ])
  })

  it('the pages by template: read-only without form or writes, a tree by level, master-sub rows in the form and detail', async () => {
    const view = await mobile({ ...book, readonly: true } as CgTableDetail)
    expect(Object.keys(view)).toEqual(pages('demo/book', false))
    expect(view[`${MOBILE}api/demo/book.ts`]).toContain('...crudApi<BookVo>(BASE),')
    for (const page of ['index', 'detail'])
      expect(view[`${MOBILE}pages-biz/demo/book/${page}.vue`]).not.toMatch(/QwPerm|form\?|remove/)
    const tree = await mobile(topic)
    const list = tree[`${MOBILE}pages-biz/demo/topic/index.vue`]!
    expect(list).not.toContain('<z-paging')
    expect(list).toContain('const forest = shallowRef<TreeRow<TopicVo>[]>([])')
    expect(list).toContain('`/pages-biz/demo/topic/index?parentId=${id}`')
    expect(tree[`${MOBILE}pages-biz/demo/topic/detail.vue`]).toContain(
      '`/pages-biz/demo/topic/form?parentId=${id.value}`',
    )
    expect(tree[`${MOBILE}pages-biz/demo/topic/form.vue`]).toContain(
      ':title="t(\'field.demo.topic.parentId\')" :value="parentText"',
    )
    const doc = await mobile(invoice)
    expect(doc[`${MOBILE}api/demo/invoice.ts`]).toContain(
      'get: (id: number) => api.get<InvoiceDetail>(`${BASE}/${id}`),',
    )
    const form = doc[`${MOBILE}pages-biz/demo/invoice/form.vue`]!
    expect(form).toContain('<view v-for="(line, i) in form.lines" :key="i" class="qw-stack">')
    expect(form).toContain('<wd-input v-model="line.item" :maxlength="128" clearable />')
    expect(form).toContain(
      "const newInvoiceLine = (): Form<InvoiceLineInput> => ({ item: '', qty: 1, unitPrice: 0 })",
    )
    expect(doc[`${MOBILE}pages-biz/demo/invoice/detail.vue`]).toContain(
      'v-for="(line, i) in row.lines"',
    )
  })

  it('every list gates detail navigation on view; paged lists preserve the latest load error', async () => {
    for (const config of [book, invoice, topic, { ...book, readonly: true }]) {
      const files = await mobile(config)
      const biz = config.business
      const list = files[`${MOBILE}pages-biz/demo/${biz}/index.vue`]!
      expect(list).toContain("import { hasPerm } from '@/core/stores/auth'")
      expect(list).toContain(`const canView = computed(() => hasPerm(${biz}Perms.view))`)
      expect(list).toContain(':role="canView ? \'link\' : undefined"')
      expect(list).toContain('const open = (id: number) =>\n  canView.value && uni.navigateTo(')
      expect(list).toMatch(
        new RegExp(`import \\{[^}]*\\b${biz}Perms\\b[^}]*\\} from '@qiwu/shared'`),
      )
      expect(list).toContain("import { errorText } from '@/core/request'")
    }
    const tree = await mobile(topic)
    expect(tree[`${MOBILE}pages-biz/demo/topic/index.vue`]).toContain('@click.stop="drill(row.id)"')
    for (const config of [book, invoice, { ...book, readonly: true }]) {
      const files = await mobile(config)
      const list = files[`${MOBILE}pages-biz/demo/${config.business}/index.vue`]!
      expect(list).toContain(
        ":title=\"isLoadFailed ? error || t('common.error.network') : t('crud.empty')\"",
      )
      expect(list).toContain("const error = ref('')")
      expect(list).toMatch(
        /\(e\) => \{\s+if \(mine !== seq\) return\s+error.value = errorText\(e\)/,
      )
      expect(list).toMatch(/\(res\) => \{\s+if \(mine !== seq\) return\s+error.value = ''/)
    }
  })

  it('row labels skip dict text, including name/title columns, for web and mobile', async () => {
    const source = book.columns.find((c) => c.columnName === 'title')!
    for (const columnName of ['platform', 'title']) {
      const config = {
        ...book,
        options: { ...book.options, withOptions: true },
        columns: [
          ...book.columns.filter((c) => c.tsType !== 'string'),
          {
            ...source,
            columnName,
            fieldName: columnName,
            dictCode: 'settings.app_platform',
            sortNo: 1,
          },
          {
            ...source,
            id: 99_999,
            columnName: 'version',
            fieldName: 'version',
            dictCode: null,
            sortNo: 2,
          },
        ],
      } as CgTableDetail
      const files = await renderCrud(config, true)
      const text = (path: string) => files.find((f) => f.path === path)!.content
      expect(text('apps/web/src/views/demo/book/index.vue')).toContain(
        ':aria-label="`${t(\'field.demo.book.enabled\')} ${row.version}`"',
      )
      expect(text('apps/server/src/modules/demo/book/book.service.ts')).toContain(
        ".select(['t.id', 't.version'])",
      )
      expect(text(`${MOBILE}pages-biz/demo/book/index.vue`)).toContain(
        '<text class="qw-row__title">{{ row.version }}</text>',
      )
    }
  })

  it('the widgets: dict, number, date, image; radio, user and dept pickers, file upload, datetime, free and rich text; no secret', async () => {
    let n = 1000
    const base = book.columns.find((c) => c.columnName === 'author')!
    const col = (columnName: string, columnType: string, extra: object) => ({
      ...base,
      id: ++n,
      sortNo: n,
      columnName,
      columnType,
      columnDefault: null,
      fieldName: columnName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      options: {},
      ...extra,
    })
    const files = await mobile({
      ...book,
      columns: [
        ...book.columns.map((c) =>
          c.columnName === 'author' ? { ...c, widget: 'radio', dictCode: 'demo.genre' } : c,
        ),
        col('owner_user_id', 'bigint unsigned', {
          tsType: 'number',
          widget: 'user-picker',
          nullable: false,
          required: true,
        }),
        col('attachment', 'varchar(512)', { tsType: 'string', widget: 'file-upload' }),
        col('due_at', 'datetime(3)', { tsType: 'Date', widget: 'datetime' }),
        col('summary', 'text', { tsType: 'string', widget: 'textarea' }),
        col('intro', 'text', { tsType: 'string', widget: 'richtext' }),
        col('token_enc', 'varchar(255)', { tsType: 'string', widget: 'secret', nullable: true }),
      ],
    } as CgTableDetail)
    const form = files[`${MOBILE}pages-biz/demo/book/form.vue`]!
    for (const part of [
      '<QwDictSelect v-model="form.genre" code="demo.genre"',
      '<QwDictSelect v-model="form.author" code="demo.genre"',
      // wd-input-number hands back '' (emptied) and its formatted text (first shown): numOf makes numbers
      '<wd-input-number :model-value="form.price ?? \'\'" :min="-99999999.99" :max="99999999.99" :precision="2" :step="0.01" allow-null @update:model-value="form.price = numOf($event)" />',
      "@click=\"pickDate(form, 'publishedOn', 'date', t('field.demo.book.publishedOn'))\"",
      "@click=\"pickDate(form, 'dueAt', 'datetime', t('field.demo.book.dueAt'))\"",
      ':model-value="uploadsOf(form.coverUrl, \'image\')" biz-tag="cover" :limit="1"',
      ':model-value="uploadsOf(form.attachment, \'file\')" :limit="1"',
      '<QwDeptPicker v-model="form.deptId"',
      ':model-value="usersOf(form.ownerUserId)" source="iam"',
      '@update:model-value="form.ownerUserId = userId($event)"',
      '<wd-textarea v-model="form.summary" :maxlength="16383" show-word-limit />',
      '<wd-textarea v-model="form.intro" :maxlength="16383" show-word-limit />',
      '<wd-switch v-model="form.enabled" />',
    ])
      expect([part, form.replace(/\s+/g, ' ').includes(part)]).toEqual([part, true])
    expect(form).toMatch(/^import \{[^}]*\bnumOf\b[^}]*\} from '@\/core\/crud'$/m)
    expect(form).not.toMatch(/token/i)
    const detail = files[`${MOBILE}pages-biz/demo/book/detail.vue`]!.replace(/\s+/g, ' ')
    for (const part of [
      ':value="dictText(\'demo.genre\', row.author)"',
      ':value="row.dueAt ? formatTime(row.dueAt) : \'\'"',
      ':value="uploadName(row.attachment)"',
      ':value="row.price.toFixed(2)"',
      ':title="t(\'field.demo.book.summary\')" :label="row.summary ?? \'\'"',
      '<template #label><rich-text :nodes="row.intro ?? \'\'" /></template>',
      ':src="assetUrl(row.coverUrl)"',
      ':value="row.ownerUserId"',
    ])
      expect([part, detail.includes(part)]).toEqual([part, true])
    expect(detail).not.toMatch(/token|v-html/i)
  })

  it('DB texts reach the mobile files only as JSON strings of the locale fragments', async () => {
    const evilText = '*/ evil() \'" `${evil()}` </script> <!-- --> {{ evil() }} \n evil()'
    const files = await mobile({
      ...book,
      tableComment: evilText,
      featureNameI18n: { 'zh-CN': evilText, 'en-US': evilText },
      options: { ...book.options, entityI18n: { 'zh-CN': evilText, 'en-US': evilText } },
      columns: book.columns.map((c) =>
        c.columnName === 'title'
          ? { ...c, columnComment: evilText, labelI18n: { 'zh-CN': evilText, 'en-US': evilText } }
          : c,
      ),
    } as CgTableDetail)
    const entries = Object.entries(files)
    const json = entries.filter(([path]) => path.endsWith('.json'))
    expect(json).toHaveLength(2)
    for (const [, content] of json)
      expect(JSON.parse(content)).toMatchObject({
        demo: { book: { entity: evilText } },
        menu: { demo: { book: evilText } },
      })
    const code = entries.filter(([path]) => !path.endsWith('.json'))
    expect(code).toHaveLength(4)
    expect(code.filter(([, content]) => content.includes('evil')).map(([path]) => path)).toEqual([])
  })

  // PC only (docs/mobile.md): no mobile/, nothing to compare with
  describe.skipIf(!hasMobile())('against the committed client', () => {
    it('renders the golden demo modules’ api, list, detail and form pages and locale fragments byte for byte', async () => {
      for (const [t, home] of [
        [book, 'demo/book'],
        [topic, 'demo/topic'],
        [invoice, 'demo/invoice'],
      ] as const) {
        const files = await mobile(t)
        expect(Object.keys(files)).toEqual(pages(home))
        for (const [path, content] of Object.entries(files))
          expect({ path, content }).toEqual({ path, content: committed(path) })
      }
    })

    // the files a page imports are the client's or the module's own rendered api
    it('every import of a mobile file resolves (the client’s core, the module’s api)', async () => {
      for (const t of [book, topic, invoice]) {
        const files = await mobile(t)
        const missing: string[] = []
        for (const [path, content] of Object.entries(files))
          for (const [, spec] of content.matchAll(/from '@\/([^']+)'/g)) {
            const at = `${MOBILE}${spec!}`
            if (![at, `${at}.ts`].some((p) => p in files || existsSync(join(ROOT, p))))
              missing.push(`${path}: @/${spec}`)
          }
        expect(missing).toEqual([])
      }
    })
  })
})
