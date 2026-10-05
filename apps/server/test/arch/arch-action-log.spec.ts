// scripts/arch/action-log.mjs (see docs/design-notes.md#audit) against a throwaway source tree: a non-GET controller method
// without @ActionLog/@SkipActionLog fails; GET routes, marked routes and non-controllers pass; a verb
// needs an entry in the platform's VERBS or the project's PROJECT_ACTION_VERBS, which must not
// repeat a platform verb. The real tree passing is `pnpm arch:check` (pnpm verify).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = `@Controller('things')
export class ThingController {
  @Get() list() {}
  @Post() @ActionLog({ domain: 'demo.thing', verb: 'create' }) create() {}
  // a reason
  @SkipActionLog()
  @Post('ping') ping() {}
  @Put(':id') update() {}
  @HttpCode(200) @Delete(':id') remove() {}
  @Patch(':id') patch() {}
  helper() {}
  @Post('missing') @ActionLog({ domain: 'demo.thing', verb: 'missing' }) missing() {}
  @Post('dynamic') @ActionLog({ domain: 'demo.thing', verb: dynamicVerb }) dynamic() {}
}
export class NotAController {
  @Post() create() {}
}
`

it('flags unmarked routes and verbs missing from the audit dict', () => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
  try {
    mkdirSync(join(root, 'apps/server/src/modules/demo'), { recursive: true })
    mkdirSync(join(root, 'apps/server/src/db/seeds/audit'), { recursive: true })
    mkdirSync(join(root, 'apps/server/codegen-templates/server'), { recursive: true })
    writeFileSync(join(root, 'apps/server/src/modules/demo/thing.controller.ts'), SOURCE)
    writeFileSync(
      join(root, 'apps/server/codegen-templates/server/controller.ts.ejs'),
      "@Controller('things') class TemplateController { @Post() @ActionLog({ domain: 'demo.thing', verb: 'missing-template' }) create() {} }\n",
    )
    writeFileSync(
      join(root, 'apps/server/src/db/seeds/audit/audit.seed.ts'),
      "const VERBS = [['create', 'Create', 'Create']]\n",
    )
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'action-log'],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(1)
    expect([...r.stderr.matchAll(/x (\S+:\d+ ThingController\.\S+)/g)].map(([, v]) => v)).toEqual([
      'apps/server/src/modules/demo/thing.controller.ts:8 ThingController.update:',
      'apps/server/src/modules/demo/thing.controller.ts:9 ThingController.remove:',
      'apps/server/src/modules/demo/thing.controller.ts:10 ThingController.patch:',
    ])
    expect(r.stderr).toContain("thing.controller.ts:12 @ActionLog verb 'missing'")
    expect(r.stderr).toContain('thing.controller.ts:13 @ActionLog verb must be a string literal')
    expect(r.stderr).toContain("controller.ts.ejs:1 @ActionLog verb 'missing-template'")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('accepts a verb the project registers in action-verbs.seed.ts; a project verb repeating a platform one or not kebab-case fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
  const check = (projectVerbs: string) => {
    writeFileSync(
      join(root, 'apps/server/src/db/seeds/project/action-verbs.seed.ts'),
      `export const PROJECT_ACTION_VERBS: ProjectActionVerb[] = [${projectVerbs}]\n`,
    )
    return spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'action-log'],
      { encoding: 'utf8' },
    )
  }
  try {
    mkdirSync(join(root, 'apps/server/src/modules/crm'), { recursive: true })
    mkdirSync(join(root, 'apps/server/src/db/seeds/audit'), { recursive: true })
    mkdirSync(join(root, 'apps/server/src/db/seeds/project'), { recursive: true })
    writeFileSync(
      join(root, 'apps/server/src/modules/crm/customer.controller.ts'),
      "@Controller('customers') class CustomerController { @Post() @ActionLog({ domain: 'crm.customer', verb: 'upgrade' }) upgrade() {} }\n",
    )
    writeFileSync(
      join(root, 'apps/server/src/db/seeds/audit/audit.seed.ts'),
      "const VERBS = [['create', 'Create', 'Create']]\n",
    )
    expect(check("['upgrade', 'Upgrade', 'Upgrade to VIP', 'success']").status).toBe(0)
    const unregistered = check('')
    expect(unregistered.status).toBe(1)
    expect(unregistered.stderr).toContain(
      "customer.controller.ts:1 @ActionLog verb 'upgrade' is missing from audit VERBS and PROJECT_ACTION_VERBS",
    )
    const repeated = check(
      "['upgrade', 'U', 'U'],\n  ['create', 'C', 'C'],\n  ['Bad_Verb', 'B', 'B']",
    )
    expect(repeated.status).toBe(1)
    expect(repeated.stderr).toContain(
      "action-verbs.seed.ts:2 project verb 'create' repeats a platform verb (audit VERBS): use that one",
    )
    expect(repeated.stderr).toContain(
      "action-verbs.seed.ts:3 project verb 'Bad_Verb' must be kebab-case",
    )
    expect(repeated.stdout).toContain('arch: 2 violation(s)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
