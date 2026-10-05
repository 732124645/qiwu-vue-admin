// `pnpm gen import|render|write <table...> [--out <dir>]` (root → `pnpm --filter @qiwu/server
// gen` → `node dist/modules/platform/codegen/cli.js`, cwd apps/server, env like the db:* scripts; see docs/design-notes.md#codegen):
//   import  <table...>              store the rules' default config of each table
//   render  <table...> [--out dir]  the files of each table: to stdout, or copied below `dir` (outside the
//                                   repository); a table not imported renders its import defaults
//   write   <table...>              into the repository (NODE_ENV=development && CODEGEN_WRITE=true), from
//                                   the stored config; never overwrites: if any existing file differs, it
//                                   prints the diffs and writes nothing (for the whole batch)
// render / write end with the lines to register the module by hand (the generator edits no existing file;
// a `withMobile` config: also its pages.json entries). A `withMobile` config renders its uni-app pages
// (api, list, detail, form, locale fragments below mobile's src) only where the repository has mobile/.
import 'reflect-metadata'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Module, NotFoundException } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { Err } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import { CoreContextModule } from '../../../core/context/context.module.js'
import { CoreDbModule } from '../../../core/db/db.module.js'
import { BizError } from '../../../core/http/biz-error.js'
import { ValidationException } from '../../../core/http/validation.pipe.js'
import { CodegenServiceModule } from './codegen.module.js'
import { CodegenService } from './codegen.service.js'
import type { RenderConfig } from './crud.js'
import type { RenderedFile } from './render.js'
import { canWrite, repoRoot, WorkspaceError, writeCopy, writeWorkspace } from './workspace.js'

/** Only what the generator needs: the DataSource (+ transactions) and the config service. */
@Module({ imports: [CoreContextModule, CoreDbModule, CodegenServiceModule] })
class CodegenCliModule {}

const USAGE = 'usage: pnpm gen import|render|write <table...> [--out <dir>] (--out: render only)'

class UsageError extends Error {}

async function run(svc: CodegenService, command: string, tables: string[], out?: string) {
  if (command === 'import') {
    const { ids, hints } = await svc.import(tables)
    tables.forEach((t, i) => console.log(`imported ${t} (config ${ids[i]})`))
    // the soft-delete convention: unique keys end with alive (no deleted_at: refused); the default parent
    for (const h of hints)
      console.warn(
        h.missing === 'alive'
          ? `hint: ${h.tableName} unique key ${h.key} has no alive column; a deleted row's value stays taken (make it (..., alive))`
          : `hint: ${h.tableName}: no menu group ${h.key} (or one below it) to hang the page under, so its parent is biz (Business); build the group in the menu page, then pick it on the config's generation tab`,
      )
    return 0
  }
  const root = repoRoot()
  // the whole batch is rendered first: a table that fails leaves nothing written
  const batch: { table: string; registration: string[] }[] = []
  const files: RenderedFile[] = []
  for (const table of tables) {
    let config: RenderConfig
    try {
      config = await svc.renderConfig(await svc.idOf(table))
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e
      if (command === 'write')
        throw new UsageError(`${table} is not imported: pnpm gen import ${table}, then write`)
      console.error(`${table} is not imported: rendering its import defaults`)
      config = await svc.defaults(table)
    }
    const one = await svc.renderOne(config)
    batch.push({ table, registration: one.registration })
    files.push(...one.files)
  }
  if (command === 'render' && !out)
    for (const f of files) process.stdout.write(`\n=== ${f.path}\n${f.content}`)
  else if (command === 'render')
    for (const path of writeCopy(root, resolve(process.env.INIT_CWD ?? '.', out!), files))
      console.log(`rendered ${path}`)
  else {
    const r = writeWorkspace(root, files)
    for (const { diff } of r.conflicts) process.stdout.write(diff)
    for (const path of r.unchanged) console.log(`unchanged ${path}`)
    for (const path of r.written) console.log(`written ${path}`)
    if (r.conflicts.length) {
      console.error(
        `${r.conflicts.length} existing file(s) differ (diff above); nothing was written`,
      )
      return 1
    }
  }
  for (const { table, registration } of batch) {
    console.log(`\nregister ${table} by hand (the generator edits no existing file):`)
    for (const line of registration) console.log(`  ${line}`)
  }
  return 0
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'), // pnpm may forward the separator
    allowPositionals: true,
    options: { out: { type: 'string' } },
  })
  const [command = '', ...names] = positionals
  const tables = [...new Set(names)]
  if (!['import', 'render', 'write'].includes(command) || !tables.length)
    throw new UsageError(USAGE)
  if (values.out !== undefined && command !== 'render') throw new UsageError(USAGE)
  if (command === 'write' && !canWrite())
    throw new UsageError(
      'write needs NODE_ENV=development and CODEGEN_WRITE=true (apps/server/.env)',
    )
  const app = await NestFactory.createApplicationContext(CodegenCliModule, {
    logger: ['error', 'warn'],
  })
  try {
    const svc = app.get(CodegenService)
    return await app.get(ClsService).run(() => run(svc, command, tables, values.out))
  } finally {
    await app.close()
  }
}

/** One line for the expected failures; anything else with its stack. */
function report(err: unknown): void {
  if (err instanceof UsageError || err instanceof WorkspaceError) console.error(err.message)
  else if (err instanceof BizError && err.err === Err.CODEGEN_NO_DELETED_AT)
    console.error(
      `${err.err.code} ${String(err.params.table)} has no deleted_at column, so it is neither imported nor generated (nothing was): the generated code soft-deletes; add deleted_at datetime(3) NULL (docs/codegen.md "New tables")`,
    )
  else if (err instanceof BizError)
    console.error(`${err.err.code} ${err.err.key} ${JSON.stringify(err.params)}`)
  else if (err instanceof ValidationException)
    for (const i of err.issues) console.error(`${i.path.join('.')}: ${i.message}`)
  else if ((err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS'))
    console.error(`${(err as Error).message}\n${USAGE}`)
  else console.error(err)
}

main().then(
  (status) => (process.exitCode = status),
  (err: unknown) => {
    report(err)
    process.exitCode = 1
  },
)
