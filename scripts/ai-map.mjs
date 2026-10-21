// 项目地图：用 TypeScript 编译器 API 静态解析服务端与 shared 的源码（不连库、不启动服务、不读构建产物），
// 生成 docs/ai/project-map.md，供开发工具先读这一份而不必遍历整个仓库。输出只取决于源码：排序稳定、
// 路径相对且用 `/`、LF 换行、没有时间戳，在任何系统上逐字节相同。
// Usage: node scripts/ai-map.mjs [--root <dir>] [--check] [--self-test]
//   --check      文件过期（与重新生成的内容不同）时失败，提示运行 `pnpm ai:map`
//   --self-test  在临时目录的小夹具上验证提取与 --check 的失败
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import ts from 'typescript'

const OUT = 'docs/ai/project-map.md'
const SERVER = 'apps/server/src'
const SHARED = 'packages/shared/src'
const ROUTE_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'All',
  'Head',
  'Options',
  'Sse',
])
const ROUTE_MARKERS = [
  'Public',
  'PlatformOnly',
  'HomeTenant',
  'RequireFeature',
  'Idempotent',
  'RequireRole',
  'OAuthScope',
]

/** 按 UTF-16 码元比较：不依赖系统语言环境，各平台排序一致。 */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
/** 多键排序；忽略 Markdown 反引号，按原值比较。 */
const by =
  (...keys) =>
  (a, b) =>
    keys.reduce(
      (r, k) => r || cmp(String(k(a)).replaceAll('`', ''), String(k(b)).replaceAll('`', '')),
      0,
    )
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 一个值能展开成的全部字符串（数组与嵌套对象逐项展开）。 */
const strings = (v) =>
  typeof v === 'string'
    ? [v]
    : typeof v === 'number'
      ? [String(v)]
      : Array.isArray(v)
        ? v.flatMap(strings)
        : isObj(v)
          ? Object.values(v).flatMap(strings)
          : []

const decorators = (n) => (ts.canHaveDecorators(n) && ts.getDecorators(n)) || []
/** 装饰器名（`RequirePerm.all` 这类带成员的写法保留成员）与其参数。 */
const decoInfo = (d) => {
  const call = ts.isCallExpression(d.expression) ? d.expression : undefined
  return {
    name: (call ? call.expression : d.expression).getText(),
    args: call ? [...call.arguments] : [],
  }
}
const findDeco = (n, name) =>
  decorators(n)
    .map(decoInfo)
    .find((d) => d.name === name)
const propName = (n) =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : undefined
const walk = (node, fn) => {
  fn(node)
  ts.forEachChild(node, (c) => walk(c, fn))
}

/**
 * 读取 `root` 下源码的解析器：按需解析文件（带缓存），沿相对导入与 `@qiwu/shared` 找常量和类，
 * 把常量表达式（字面量、对象、数组、模板字符串、属性访问）求成普通值；求不出的返回 undefined。
 */
function createProject(root) {
  const cache = new Map()
  let sharedExports

  const list = (pattern) =>
    globSync(pattern, { cwd: root, exclude: (f) => f.includes('node_modules') })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => !/\.(spec|d)\.ts$/.test(f))
      .sort(cmp)
  const text = (rel) => readFileSync(join(root, rel), 'utf8')

  /** 解析一个文件，收集它声明的常量（顶层优先，其次函数内与带默认值的参数）、类与具名导入。 */
  function load(rel) {
    if (cache.has(rel)) return cache.get(rel)
    const sf = ts.createSourceFile(rel, text(rel), ts.ScriptTarget.Latest, true)
    const file = { rel, sf, decls: new Map(), classes: new Map(), imports: new Map() }
    const declare = (n) => {
      if (
        (ts.isVariableDeclaration(n) || ts.isParameter(n)) &&
        ts.isIdentifier(n.name) &&
        n.initializer
      )
        if (!file.decls.has(n.name.text)) file.decls.set(n.name.text, n.initializer)
      if (ts.isClassDeclaration(n) && n.name) file.classes.set(n.name.text, n)
    }
    for (const s of sf.statements) {
      if (ts.isVariableStatement(s)) s.declarationList.declarations.forEach(declare)
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        const named = s.importClause?.namedBindings
        if (named && ts.isNamedImports(named))
          for (const el of named.elements)
            file.imports.set(el.name.text, {
              from: s.moduleSpecifier.text,
              name: (el.propertyName ?? el.name).text,
            })
      }
    }
    walk(sf, declare)
    cache.set(rel, file)
    return file
  }

  /** shared 包导出的顶层常量：名字 → 声明（同名时按路径排序取第一个）。 */
  function shared() {
    if (sharedExports) return sharedExports
    sharedExports = new Map()
    for (const rel of list(`${SHARED}/**/*.ts`)) {
      const file = load(rel)
      for (const s of file.sf.statements)
        if (
          ts.isVariableStatement(s) &&
          s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        )
          for (const d of s.declarationList.declarations)
            if (ts.isIdentifier(d.name) && d.initializer && !sharedExports.has(d.name.text))
              sharedExports.set(d.name.text, { node: d.initializer, file })
    }
    return sharedExports
  }

  /** 相对导入的目标文件（`.js` 写法对应 `.ts` 源文件），找不到时 undefined。 */
  function target(from, spec) {
    if (!spec.startsWith('.')) return undefined
    const base = posix.join(posix.dirname(from.rel), spec).replace(/\.js$/, '')
    return [`${base}.ts`, `${base}/index.ts`].find((f) => existsSync(join(root, f)))
  }

  /** 名字在 `file` 中指向的常量声明：本文件、相对导入或 `@qiwu/shared`。 */
  function lookup(name, file, depth = 0) {
    if (file.decls.has(name)) return { node: file.decls.get(name), file }
    const imp = file.imports.get(name)
    if (!imp || depth > 10) return undefined
    if (imp.from === '@qiwu/shared') return shared().get(imp.name)
    const rel = target(file, imp.from)
    return rel ? lookup(imp.name, load(rel), depth + 1) : undefined
  }

  /** 类名在 `file` 中指向的类声明（本文件或相对导入）。 */
  function lookupClass(name, file, depth = 0) {
    if (file.classes.has(name)) return { cls: file.classes.get(name), file }
    const imp = file.imports.get(name)
    const rel = imp && depth < 10 && target(file, imp.from)
    return rel ? lookupClass(imp.name, load(rel), depth + 1) : undefined
  }

  /** 把值按绑定模式（名字、数组解构、对象解构、剩余参数、默认值）写进 `env`。 */
  function bind(pattern, value, env, file, d) {
    if (ts.isIdentifier(pattern)) return env.set(pattern.text, value)
    const elements =
      ts.isArrayBindingPattern(pattern) || ts.isObjectBindingPattern(pattern)
        ? pattern.elements
        : []
    elements.forEach((el, i) => {
      if (!ts.isBindingElement(el)) return
      let v
      if (ts.isArrayBindingPattern(pattern))
        v = Array.isArray(value) ? (el.dotDotDotToken ? value.slice(i) : value[i]) : undefined
      else {
        const key = propName(el.propertyName ?? el.name)
        v = isObj(value) && key !== undefined ? value[key] : undefined
      }
      bind(
        el.name,
        v === undefined && el.initializer ? ev(el.initializer, file, env, d) : v,
        env,
        file,
        d,
      )
    })
    return env
  }

  /** 调用表达式体的箭头函数（种子里的 `page(...)`、`entries(...)` 这类小工具函数与 `.map` 回调）。 */
  function apply(fn, args, file, env, d) {
    if (!ts.isArrowFunction(fn) || ts.isBlock(fn.body)) return undefined
    const next = new Map(env)
    fn.parameters.forEach((p, i) =>
      bind(p.name, p.dotDotDotToken ? args.slice(i) : args[i], next, file, d),
    )
    return ev(fn.body, file, next, d)
  }

  /** 常量求值；`env` 是循环变量、函数参数等局部绑定。 */
  function ev(node, file, env = new Map(), depth = 0) {
    if (!node || depth > 60) return undefined
    const d = depth + 1
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      return ev(node.expression, file, env, d)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (ts.isTemplateExpression(node)) {
      let s = node.head.text
      for (const span of node.templateSpans) {
        const v = ev(span.expression, file, env, d)
        if (typeof v !== 'string' && typeof v !== 'number') return undefined
        s += v + span.literal.text
      }
      return s
    }
    if (ts.isIdentifier(node)) {
      if (env.has(node.text)) return env.get(node.text)
      const hit = lookup(node.text, file)
      return hit && ev(hit.node, hit.file, new Map(), d)
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ev(node.argumentExpression, file, env, d)
      const base = ev(node.expression, file, env, d)
      if (Array.isArray(base) && typeof key === 'number') return base[key]
      return isObj(base) && typeof key === 'string' && Object.hasOwn(base, key)
        ? base[key]
        : undefined
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out = Object.create(null)
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) {
          const k = propName(p.name)
          if (k !== undefined) out[k] = ev(p.initializer, file, env, d)
        } else if (ts.isShorthandPropertyAssignment(p)) out[p.name.text] = ev(p.name, file, env, d)
        else if (ts.isSpreadAssignment(p)) {
          const v = ev(p.expression, file, env, d)
          if (isObj(v)) Object.assign(out, v)
        }
      }
      return out
    }
    const spread = (nodes) =>
      nodes.flatMap((e) => {
        if (!ts.isSpreadElement(e)) return [ev(e, file, env, d)]
        const v = ev(e.expression, file, env, d)
        return Array.isArray(v) ? v : []
      })
    if (ts.isArrayLiteralExpression(node)) return spread(node.elements)
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const [first] = node.arguments
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'map' && first) {
        const list = ev(callee.expression, file, env, d)
        return Array.isArray(list)
          ? list.map((item, i) => apply(first, [item, i], file, env, d))
          : undefined
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'entries' && !first) {
        const list = ev(callee.expression, file, env, d)
        return Array.isArray(list) ? list.map((item, i) => [i, item]) : undefined
      }
      const name = callee.getText()
      if ((name === 'Object.values' || name === 'Object.keys') && first) {
        const v = ev(first, file, env, d)
        return isObj(v) ? (name === 'Object.keys' ? Object.keys(v) : Object.values(v)) : undefined
      }
      if (ts.isIdentifier(callee) && !env.has(callee.text)) {
        const hit = lookup(callee.text, file)
        if (hit) return apply(hit.node, spread(node.arguments), hit.file, new Map(), d)
      }
    }
    return undefined
  }

  /**
   * `node` 所在的 `for (const x of LIST)` 循环把 `x` 依次绑定为 LIST 的每一项：返回全部组合的绑定
   * （外层循环在前）。LIST 求不出时该循环变量不绑定。
   */
  function envsAt(node, file) {
    const loops = []
    for (let p = node.parent; p; p = p.parent)
      if (ts.isForOfStatement(p) && ts.isVariableDeclarationList(p.initializer)) loops.unshift(p)
    let envs = [new Map()]
    for (const loop of loops) {
      const pattern = loop.initializer.declarations[0]?.name
      envs = envs.flatMap((env) => {
        const items = ev(loop.expression, file, env)
        if (!Array.isArray(items) || !pattern) return [env]
        return items.map((item) => bind(pattern, item, new Map(env), file, 0))
      })
    }
    return envs
  }

  /**
   * `X.prop` 里的 X 是求不出的函数参数时（如递归遍历菜单树的 `m.routeName`），退而取本文件顶层常量
   * 求值后（含嵌套的子项）所有带字符串 `prop` 的对象，逐个作为 X 的取值。
   */
  function fallbackEnvs(expr, file, env) {
    if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return []
    const name = expr.expression.text
    if (env.has(name) || lookup(name, file)) return []
    const prop = expr.name.text
    const found = new Set()
    const collect = (v) => {
      if (Array.isArray(v)) v.forEach(collect)
      else if (isObj(v)) {
        if (typeof v[prop] === 'string') found.add(v)
        Object.values(v).forEach(collect)
      }
    }
    for (const s of file.sf.statements)
      if (ts.isVariableStatement(s))
        for (const decl of s.declarationList.declarations)
          if (!(decl.initializer && ts.isArrowFunction(decl.initializer)))
            collect(ev(decl.initializer, file))
    return [...found].map((v) => new Map(env).set(name, v))
  }

  return { root, list, text, load, lookup, lookupClass, ev, envsAt, fallbackEnvs }
}

/** 类及其父类（沿 `extends` 跨文件）中是否有成员带某个装饰器。 */
function memberDeco(project, cls, file, name, depth = 0) {
  if (cls.members.some((m) => findDeco(m, name))) return true
  const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
  if (!ext || !ts.isIdentifier(ext.expression) || depth > 10) return false
  const parent = project.lookupClass(ext.expression.text, file)
  return !!parent && memberDeco(project, parent.cls, parent.file, name, depth + 1)
}

/** 源码中带某个类装饰器的类：[{ cls, file, deco }]，按文件与位置排序。 */
function classesWith(project, files, deco) {
  const out = []
  for (const rel of files) {
    if (!project.text(rel).includes(`@${deco}(`)) continue
    const file = project.load(rel)
    walk(file.sf, (n) => {
      if (ts.isClassDeclaration(n) && n.name) {
        const d = findDeco(n, deco)
        if (d) out.push({ cls: n, file, deco: d })
      }
    })
  }
  return out
}

/** 带某个方法装饰器的方法：[{ method, cls, file, deco }]。 */
function methodsWith(project, files, deco) {
  const out = []
  for (const rel of files) {
    if (!project.text(rel).includes(`@${deco}(`)) continue
    const file = project.load(rel)
    walk(file.sf, (n) => {
      if (ts.isMethodDeclaration(n) && ts.isClassDeclaration(n.parent)) {
        const d = findDeco(n, deco)
        if (d) out.push({ method: n, cls: n.parent, file, deco: d })
      }
    })
  }
  return out
}

/** `@RequirePerm(...)` 的参数展开成权限码；求不出的参数保留源码文本。 */
function permsOf(project, deco, file) {
  if (!deco) return ''
  const codes = deco.args.flatMap((a) => {
    const expr = ts.isSpreadElement(a) ? a.expression : a
    const v = strings(project.ev(expr, file))
    return v.length ? v : [a.getText()]
  })
  return codes.join(deco.name === 'RequirePerm.all' ? ' + ' : ' / ')
}

/** 路由标记（`Public`、`PlatformOnly(root)` 等），参数能求出时附在括号里。 */
function markersOf(project, node, file) {
  return ROUTE_MARKERS.flatMap((name) => {
    const d = findDeco(node, name)
    if (!d) return []
    const args = d.args.flatMap((a) => strings(project.ev(a, file)))
    return [args.length ? `${name}(${args.join(', ')})` : name]
  })
}

const short = (rel) =>
  rel.startsWith(`${SERVER}/`)
    ? rel.slice(SERVER.length + 1)
    : rel.startsWith(`${SHARED}/`)
      ? `shared:${rel.slice(SHARED.length + 1)}`
      : rel
const cell = (v) =>
  String(v ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
const code = (v) => (v ? `\`${v}\`` : '')
const table = (head, rows) =>
  rows.length
    ? [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
      ].join('\n')
    : '（无）'

/** 功能开关：`ConditionalModule.registerWhen` 加载的模块（经开关函数读到的环境变量）与只在开启时显示的菜单。 */
function switches(project) {
  const modules = []
  const appRel = `${SERVER}/app.module.ts`
  if (existsSync(join(project.root, appRel))) {
    const app = project.load(appRel)
    walk(app.sf, (n) => {
      if (!ts.isCallExpression(n) || n.expression.getText() !== 'ConditionalModule.registerWhen')
        return
      const [mod, when] = n.arguments
      if (!mod || !ts.isIdentifier(mod) || !when) return
      const names = new Set()
      const scan = (node) =>
        walk(node, (x) => {
          if (ts.isPropertyAccessExpression(x) && /^[A-Z][A-Z0-9_]+$/.test(x.name.text))
            names.add(x.name.text)
        })
      scan(when)
      walk(when, (x) => {
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
          const fn = project.lookup(x.expression.text, app)
          if (fn) scan(fn.node)
        }
      })
      const cls = project.lookupClass(mod.text, app)
      for (const sw of names)
        modules.push({ sw, module: mod.text, dir: cls && posix.dirname(cls.file.rel) })
    })
  }
  const featRel = `${SERVER}/core/auth/menu-features.ts`
  const features = existsSync(join(project.root, featRel))
    ? project.ev(project.load(featRel).decls.get('MENU_FEATURES'), project.load(featRel))
    : undefined
  const menus = isObj(features) ? Object.entries(features) : []
  return { modules, menus }
}

/** 生成地图的全部 Markdown（LF 结尾）。 */
export function generate(root) {
  const project = createProject(root)
  const server = project.list(`${SERVER}/**/*.ts`)
  const seeds = [
    ...new Set([
      ...project.list(`${SERVER}/**/*.seed.ts`),
      ...project.list(`${SERVER}/db/seeds/**/*.ts`),
    ]),
  ].sort(cmp)
  const sw = switches(project)
  const out = [
    '# 项目地图',
    '',
    '> 本文件由 `pnpm ai:map` 生成，请勿手工编辑：源码变化后重新运行 `pnpm ai:map`（`pnpm verify` 会检查它是否过期）。',
    '> 静态解析源码得到；服务端文件路径相对 `apps/server/src/`，`shared:` 开头的相对 `packages/shared/src/`。',
    '',
  ]

  // 1. 领域与模块
  const gated = (rel) =>
    sw.modules
      .filter((m) => m.dir && (rel === m.dir || rel.startsWith(`${m.dir}/`)))
      .map((m) => m.sw)
      .join(', ')
  const byDir = new Map()
  for (const { cls, file } of classesWith(
    project,
    project.list(`${SERVER}/modules/**/*.ts`),
    'Module',
  )) {
    const dir = posix.dirname(file.rel.slice(`${SERVER}/modules/`.length))
    if (!byDir.has(dir)) byDir.set(dir, { mods: [], sw: gated(file.rel) })
    byDir.get(dir).mods.push(`${code(cls.name.text)}（${posix.basename(file.rel)}）`)
  }
  const modRows = [...byDir.entries()]
    .map(([dir, { mods, sw: s }]) => [
      dir === '.' ? '（项目登记）' : dir,
      mods.sort(cmp).join(', '),
      s,
    ])
    .sort(by((r) => r[0]))
  out.push(
    '## 领域与模块',
    '',
    '领域是 `modules/` 下的第一级目录：`platform`、`workflow` 与项目领域（如 `biz`、`demo`）；项目模块在 `modules/project.module.ts` 登记。',
    '',
    table(['目录（modules/ 下）', 'Nest 模块（文件）', '开关'], modRows),
    '',
  )
  const swNames = [
    ...new Set([...sw.modules.map((m) => m.sw), ...sw.menus.map(([, s]) => s)]),
  ].sort(cmp)
  const swRows = swNames.map((s) => [
    code(s),
    sw.modules
      .filter((m) => m.sw === s)
      .map((m) => `${m.module}${m.dir ? `（${short(m.dir)}）` : ''}`)
      .sort(cmp)
      .join(', '),
    sw.menus
      .filter(([, x]) => x === s)
      .map(([r]) => r)
      .sort(cmp)
      .join(', '),
  ])
  out.push(
    '### 功能开关',
    '',
    table(['开关', '只在开启时加载的模块', '只在开启时显示的菜单（路由名）'], swRows),
    '',
  )

  // 2. 表
  const tenantRel = `${SERVER}/core/db/tenant-tables.ts`
  const platform = new Set(
    existsSync(join(root, tenantRel))
      ? strings(
          project.ev(project.load(tenantRel).decls.get('PLATFORM_TABLES'), project.load(tenantRel)),
        )
      : [],
  )
  const tableRows = classesWith(project, server, 'Entity')
    .map(({ cls, file, deco }) => {
      const arg = project.ev(deco.args[0], file)
      const name =
        typeof arg === 'string' ? arg : isObj(arg) && typeof arg.name === 'string' ? arg.name : ''
      const tenant = platform.has(name)
        ? '平台'
        : memberDeco(project, cls, file, 'TenantColumn')
          ? '租户'
          : '无租户列'
      const soft = memberDeco(project, cls, file, 'DeleteDateColumn') ? '是' : '否'
      return [code(name), code(cls.name.text), tenant, soft, short(file.rel)]
    })
    .sort(
      by(
        (r) => r[0],
        (r) => r[4],
        (r) => r[1],
      ),
    )
  out.push(
    '## 表',
    '',
    '租户表由 ORM 自动加租户条件；平台表登记在 `PLATFORM_TABLES` / `PROJECT_PLATFORM_TABLES`；软删除表删除时写 `deleted_at`。',
    '',
    table(['表', '实体', '租户', '软删除', '文件'], tableRows),
    '',
  )

  // 3. 接口
  let prefix = ''
  let exclude = []
  const setupRel = `${SERVER}/app.setup.ts`
  if (existsSync(join(root, setupRel))) {
    const setup = project.load(setupRel)
    walk(setup.sf, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'setGlobalPrefix'
      ) {
        const p = project.ev(n.arguments[0], setup)
        if (typeof p === 'string') prefix = p
        const opts = project.ev(n.arguments[1], setup)
        exclude = isObj(opts) ? strings(opts.exclude) : []
      }
    })
  }
  const join2 = (...segs) =>
    `/${segs
      .flatMap((s) => s.split('/'))
      .filter(Boolean)
      .join('/')}`
  const controllers = classesWith(project, server, 'Controller')
    .map(({ cls, file, deco }) => {
      const arg = project.ev(deco.args[0], file)
      const base = typeof arg === 'string' ? arg : isObj(arg) ? (strings(arg.path)[0] ?? '') : ''
      const classPerm = findDeco(cls, 'RequirePerm') ?? findDeco(cls, 'RequirePerm.all')
      const classMarks = markersOf(project, cls, file)
      const rows = []
      for (const m of cls.members) {
        if (!ts.isMethodDeclaration(m)) continue
        const route = decorators(m)
          .map(decoInfo)
          .find((d) => ROUTE_DECORATORS.has(d.name))
        if (!route) continue
        // a path the static evaluation cannot resolve shows as its source text instead of disappearing
        const evaluated = route.args.length ? strings(project.ev(route.args[0], file)) : ['']
        const paths = evaluated.length ? evaluated : [`{${route.args[0].getText()}}`]
        const perm = findDeco(m, 'RequirePerm') ?? findDeco(m, 'RequirePerm.all') ?? classPerm
        const marks = markersOf(project, m, file)
          .filter((x) => !classMarks.includes(x))
          .join(', ')
        for (const p of paths) {
          const local = join2(base, p).slice(1)
          const full = exclude.includes(local) || !prefix ? join2(local) : join2(prefix, local)
          rows.push([
            route.name === 'Sse' ? 'GET (SSE)' : route.name.toUpperCase(),
            code(full),
            permsOf(project, perm, file),
            marks,
          ])
        }
      }
      const title = `${code(cls.name.text)}（${short(file.rel)}）${classMarks.length ? `，全部：${classMarks.join(', ')}` : ''}`
      rows.forEach((r, i) => r.unshift(i ? '' : title))
      return { title, base, rows }
    })
    .filter((c) => c.rows.length)
    .sort(
      by(
        (c) => c.base,
        (c) => c.title,
      ),
    )
  out.push(
    '## 接口',
    '',
    '控制器写在它第一个接口的行上，“全部：”后的标记作用于它的每个接口；权限 `a / b` 任一即可，`a + b` 须全部具备，空白表示登录即可（标记 Public 的无需登录）。',
    '',
    table(
      ['控制器', '方法', '路径', '权限', '标记'],
      controllers.flatMap((c) => c.rows),
    ),
    '',
  )

  // 4. 权限码
  const permRows = []
  for (const rel of project.list(`${SHARED}/**/*.ts`)) {
    const file = project.load(rel)
    for (const s of file.sf.statements) {
      if (!ts.isVariableStatement(s)) continue
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.name.text.endsWith('Perms')) continue
        const v = project.ev(d.initializer, file)
        if (isObj(v)) permRows.push([code(d.name.text), strings(v).join(', '), short(rel)])
      }
    }
  }
  permRows.sort(
    by(
      (r) => r[0],
      (r) => r[2],
    ),
  )
  out.push('## 权限码', '', table(['常量', '权限码', '文件'], permRows), '')

  // 5. 菜单、字典、系统参数（种子文件）
  const hasProp = (obj, name) =>
    obj.properties.some((p) => ts.isPropertyAssignment(p) && propName(p.name) === name)
  const propInit = (obj, name) =>
    obj.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === name)?.initializer
  const menuFeature = new Map(sw.menus)
  const menus = new Map()
  const dicts = new Map()
  const params = new Map()
  for (const rel of seeds) {
    const src = project.text(rel)
    if (!/route_name|upsertDicts|param_key/.test(src)) continue
    const file = project.load(rel)
    walk(file.sf, (n) => {
      // 菜单行：带 `route_name` 的对象，自身或同一调用的另一个对象参数写了 `route_path`（只查找的不算）
      if (ts.isObjectLiteralExpression(n) && hasProp(n, 'route_name')) {
        const siblings = ts.isCallExpression(n.parent)
          ? n.parent.arguments.filter((a) => a !== n && ts.isObjectLiteralExpression(a))
          : []
        const def = [n, ...siblings].find((o) => hasProp(o, 'route_path'))
        if (!def) return
        const init = propInit(n, 'route_name')
        const kindInit = propInit(n, 'kind') ?? propInit(def, 'kind')
        for (const env of project.envsAt(n, file)) {
          const vals = strings(project.ev(init, file, env))
          const envs = vals.length ? [env] : project.fallbackEnvs(init, file, env)
          for (const e of envs) {
            const kind = project.ev(kindInit, file, e)
            for (const r of strings(project.ev(init, file, e)))
              if (!menus.has(r))
                menus.set(r, [
                  code(r),
                  typeof kind === 'string' ? kind : '',
                  menuFeature.get(r) ?? '',
                  short(rel),
                ])
          }
        }
      }
      // 字典：`upsertDicts(q, [...])` 的每一项（code + entries[].value）
      if (ts.isCallExpression(n) && n.expression.getText() === 'upsertDicts' && n.arguments[1])
        for (const env of project.envsAt(n, file)) {
          const list = project.ev(n.arguments[1], file, env)
          for (const dict of Array.isArray(list) ? list : []) {
            if (!isObj(dict) || typeof dict.code !== 'string' || dicts.has(dict.code)) continue
            const values = (Array.isArray(dict.entries) ? dict.entries : []).flatMap((e) =>
              isObj(e) ? strings(e.value) : [],
            )
            const shown =
              values.length > 20 ? [...values.slice(0, 20), `…（共 ${values.length} 项）`] : values
            dicts.set(dict.code, [code(dict.code), shown.join(', '), short(rel)])
          }
        }
      // 系统参数：带 `param_key` 的对象
      if (ts.isObjectLiteralExpression(n) && hasProp(n, 'param_key')) {
        const init = propInit(n, 'param_key')
        for (const env of project.envsAt(n, file))
          for (const k of strings(project.ev(init, file, env)))
            if (!params.has(k)) params.set(k, [code(k), short(rel)])
      }
    })
  }
  const sorted = (m) => [...m.values()].sort(by((r) => r[0]))
  out.push(
    '## 菜单路由名',
    '',
    table(['路由名', '类型', '开关', '种子文件'], sorted(menus)),
    '',
    '## 字典码',
    '',
    table(['字典码', '取值', '种子文件'], sorted(dicts)),
    '',
    '## 系统参数',
    '',
    table(['参数键', '种子文件'], sorted(params)),
    '',
  )

  // 6. 队列、定时任务处理器、MCP 工具
  const queues = new Map()
  for (const rel of server) {
    if (!project.text(rel).includes('registerQueue(')) continue
    const file = project.load(rel)
    walk(file.sf, (n) => {
      if (ts.isCallExpression(n) && n.expression.getText() === 'registerQueue')
        for (const a of n.arguments) {
          const v = project.ev(a, file)
          if (isObj(v) && typeof v.name === 'string')
            queues.set(v.name, { registered: short(rel), processors: [] })
        }
    })
  }
  for (const { cls, file, deco } of classesWith(project, server, 'Processor')) {
    const name = strings(project.ev(deco.args[0], file))[0] ?? deco.args[0]?.getText() ?? ''
    const q = queues.get(name) ?? { registered: '', processors: [] }
    q.processors.push(`${cls.name.text}（${short(file.rel)}）`)
    queues.set(name, q)
  }
  const queueRows = [...queues.entries()]
    .map(([name, q]) => [code(name), q.registered, q.processors.sort(cmp).join(', ')])
    .sort(by((r) => r[0]))
  const jobRows = methodsWith(project, server, 'JobHandler')
    .map(({ cls, method, file, deco }) => [
      code(strings(project.ev(deco.args[0], file))[0] ?? deco.args[0]?.getText()),
      `${cls.name?.text ?? ''}.${method.name.getText()}`,
      short(file.rel),
    ])
    .sort(
      by(
        (r) => r[0],
        (r) => r[2],
      ),
    )
  const toolRows = methodsWith(project, server, 'McpTool')
    .map(({ cls, method, file, deco }) => {
      const meta = project.ev(deco.args[0], file)
      const m = isObj(meta) ? meta : {}
      return [
        code(typeof m.name === 'string' ? m.name : ''),
        typeof m.kind === 'string' ? m.kind : '',
        typeof m.perm === 'string' ? code(m.perm) : m.perm === null ? '（只需登录）' : '',
        `${cls.name?.text ?? ''}.${method.name.getText()}`,
        short(file.rel),
      ]
    })
    .sort(
      by(
        (r) => r[0],
        (r) => r[4],
      ),
    )
  out.push(
    '## 队列',
    '',
    table(['队列', '登记位置', '处理器'], queueRows),
    '',
    '## 定时任务处理器',
    '',
    table(['处理器名', '方法', '文件'], jobRows),
    '',
    '## MCP 工具',
    '',
    table(['工具名', '类型', '权限', '方法', '文件'], toolRows),
    '',
  )
  return out.join('\n')
}

/** 写入或检查地图文件；返回进程退出码。 */
function run(root, check) {
  const md = generate(root)
  const path = join(root, OUT)
  if (check) {
    // a CRLF working copy is the same map
    const current = existsSync(path)
      ? readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
      : undefined
    if (current === md) {
      console.log(`ai-map: ${OUT} is up to date`)
      return 0
    }
    console.error(
      `ai-map: ${OUT} is ${current === undefined ? 'missing' : 'stale'}; how to fix: run \`pnpm ai:map\` and commit ${OUT}`,
    )
    return 1
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, md)
  console.log(`ai-map: wrote ${OUT} (${Buffer.byteLength(md)} bytes)`)
  return 0
}

/** 夹具自测：实体、带权限码的路由与 --check 的过期失败。 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'qw-ai-map-'))
  const put = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  const fail = (msg) => {
    throw new Error(`ai-map self-test: ${msg}`)
  }
  try {
    put(`${SERVER}/app.setup.ts`, "export const setup = (app: any) => app.setGlobalPrefix('api')\n")
    put(
      `${SHARED}/demo/widget.schema.ts`,
      "export const widgetPerms = { browse: 'demo.widget.browse', create: 'demo.widget.create' } as const\n",
    )
    put(
      `${SERVER}/core/db/base.ts`,
      'export abstract class Base {\n  @DeleteDateColumn() deletedAt: Date | null\n}\n',
    )
    put(
      `${SERVER}/modules/demo/widget/widget.entity.ts`,
      "import { Base } from '../../../core/db/base.js'\n@Entity('demo_widget')\nexport class Widget extends Base {\n  @TenantColumn() tenantId: number\n}\n",
    )
    put(
      `${SERVER}/modules/demo/widget/widget.controller.ts`,
      [
        "import { widgetPerms } from '@qiwu/shared'",
        'const perms = widgetPerms',
        "@Controller('demo/widgets')",
        'export class WidgetController {',
        "  @Get(':id')",
        '  @RequirePerm(perms.browse)',
        '  get() {}',
        '  @Post()',
        '  @RequirePerm(widgetPerms.create)',
        '  @Idempotent()',
        '  create() {}',
        '}',
        '',
      ].join('\n'),
    )
    const md = generate(dir)
    const line = (re, what) => md.split('\n').some((l) => re.test(l)) || fail(`missing ${what}`)
    line(
      /^\| `demo_widget` \| `Widget` \| 租户 \| 是 \| modules\/demo\/widget\/widget\.entity\.ts \|$/,
      'the entity row',
    )
    line(
      /^\| `WidgetController`（modules\/demo\/widget\/widget\.controller\.ts） \| GET \| `\/api\/demo\/widgets\/:id` \| demo\.widget\.browse \| {2}\|$/,
      'the GET route with its perm',
    )
    line(
      /^\| {2}\| POST \| `\/api\/demo\/widgets` \| demo\.widget\.create \| Idempotent \|$/,
      'the POST route',
    )
    line(/^\| `widgetPerms` \| demo\.widget\.browse, demo\.widget\.create \|/, 'the perms row')
    if (generate(dir) !== md) fail('two runs differ')
    const cli = (...args) =>
      spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', dir, ...args], {
        encoding: 'utf8',
      })
    if (cli().status !== 0) fail('writing the map failed')
    if (cli('--check').status !== 0) fail('--check fails on a fresh map')
    writeFileSync(join(dir, OUT), `${md}edited by hand\n`)
    const stale = cli('--check')
    if (stale.status !== 1 || !stale.stderr.includes('pnpm ai:map'))
      fail('--check passes a stale map or does not say to run pnpm ai:map')
    console.log('ai-map self-test ok')
    return 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// run directly (also through a symlinked or substituted path)
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      check: { type: 'boolean' },
      'self-test': { type: 'boolean' },
    },
  })
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  process.exit(values['self-test'] ? selfTest() : run(root, !!values.check))
}
