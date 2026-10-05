// docs/design-notes.md#audit: every non-GET route of a server controller carries @ActionLog(...) or @SkipActionLog()
// (TypeScript AST over apps/server/src; test probes are not product routes), and every @ActionLog verb
// (also in the generator's controller template) is a string literal with an `audit.verb` dict entry, so the
// action log never shows a raw code: one of the platform's VERBS (the audit seed) or of the project's
// PROJECT_ACTION_VERBS (db/seeds/project/action-verbs.seed.ts, a missing file lists none). A project
// verb must be kebab-case (at most 32 characters, the aud_action_log column) and must not repeat a platform
// verb (use the platform one).
import ts from 'typescript'

const WRITE = new Set(['Post', 'Put', 'Patch', 'Delete', 'All'])
const MARKS = new Set(['ActionLog', 'SkipActionLog'])

const decoratorsOf = (node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
const names = (node) =>
  decoratorsOf(node).map((d) =>
    (ts.isCallExpression(d.expression) ? d.expression.expression : d.expression).getText(),
  )

export default function ({ files, read }) {
  const out = []
  // the string first elements of the tuples of array `name` in `file` ([] for a missing file)
  const tuples = (file, name) => {
    if (!files(file).length) return []
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    return sf.statements
      .filter(ts.isVariableStatement)
      .flatMap((s) => [...s.declarationList.declarations])
      .filter(
        (d) =>
          d.name.getText(sf) === name &&
          d.initializer &&
          ts.isArrayLiteralExpression(d.initializer),
      )
      .flatMap((d) => d.initializer.elements)
      .filter(ts.isArrayLiteralExpression)
      .map((tuple) => tuple.elements[0])
      .filter((value) => value && ts.isStringLiteral(value))
      .map((value) => ({
        verb: value.text,
        line: sf.getLineAndCharacterOfPosition(value.getStart()).line + 1,
      }))
  }
  const verbs = new Set(
    tuples('apps/server/src/db/seeds/audit/audit.seed.ts', 'VERBS').map((t) => t.verb),
  )
  const projectFile = 'apps/server/src/db/seeds/project/action-verbs.seed.ts'
  for (const { verb, line } of tuples(projectFile, 'PROJECT_ACTION_VERBS')) {
    if (verbs.has(verb))
      out.push(
        `${projectFile}:${line} project verb '${verb}' repeats a platform verb (audit VERBS): use that one`,
      )
    else if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(verb) || verb.length > 32)
      out.push(
        `${projectFile}:${line} project verb '${verb}' must be kebab-case, at most 32 characters`,
      )
    verbs.add(verb)
  }
  for (const file of [
    ...files('apps/server/src/**/*.ts'),
    ...files('apps/server/codegen-templates/server/controller.ts.ejs'),
  ]) {
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    const checkVerb = (node) => {
      if (
        ts.isDecorator(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(sf) === 'ActionLog'
      ) {
        const arg = node.expression.arguments[0]
        const verb =
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'verb',
              )?.initializer
            : undefined
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (!verb || !ts.isStringLiteral(verb))
          out.push(
            `${file}:${line} @ActionLog verb must be a string literal in audit VERBS or PROJECT_ACTION_VERBS`,
          )
        else if (!verbs.has(verb.text))
          out.push(
            `${file}:${line} @ActionLog verb '${verb.text}' is missing from audit VERBS and PROJECT_ACTION_VERBS`,
          )
      }
      ts.forEachChild(node, checkVerb)
    }
    checkVerb(sf)
    for (const cls of sf.statements) {
      if (!ts.isClassDeclaration(cls) || !names(cls).includes('Controller')) continue
      for (const m of cls.members) {
        if (!ts.isMethodDeclaration(m)) continue
        const marks = names(m)
        if (!marks.some((n) => WRITE.has(n)) || marks.some((n) => MARKS.has(n))) continue
        const line = sf.getLineAndCharacterOfPosition(m.getStart()).line + 1
        out.push(
          `${file}:${line} ${cls.name?.text}.${m.name.getText()}: non-GET route needs @ActionLog(...) or @SkipActionLog() (docs/design-notes.md#audit)`,
        )
      }
    }
  }
  return out
}
