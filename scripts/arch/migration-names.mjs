// Migration file names (apps/server/src/db/migrations): TypeORM runs migrations in the order of the
// timestamp at the end of their class name, and an installed database records each by name. So every
// file is `<14-digit timestamp>-<kebab-name>.ts`, no two files share a timestamp (a project's migration
// taking the template's time would run in an order nobody chose), and the migration class (and its
// `name`, when set) ends with the file's timestamp. Use the real current time, seconds included, for a
// new migration; never rename a released one (databases record its name).
const DIR = 'apps/server/src/db/migrations/'
const FILE = /^(\d{14})-[a-z0-9][a-z0-9-]*\.ts$/
const CLASS = /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g
const NAME = /^\s*(?:public\s+)?(?:readonly\s+)?name\s*=\s*['"`]([^'"`]+)['"`]/gm

/** 列出迁移命名的违规：时间戳格式、时间戳重复、类名与 `name` 不以文件的时间戳结尾。 */
export default function ({ files, read }) {
  const out = []
  const byStamp = new Map()
  for (const file of files(`${DIR}*.ts`)) {
    const base = file.slice(DIR.length)
    const m = FILE.exec(base)
    if (!m) {
      out.push(
        `${file}: name it <14-digit timestamp>-<kebab-name>.ts (e.g. 20261020153817-crm-order.ts)`,
      )
      continue
    }
    const stamp = m[1]
    byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), file])
    const text = read(file)
    const names = [...text.matchAll(CLASS), ...text.matchAll(NAME)].map((n) => n[1])
    if (!names.length) out.push(`${file}: no exported migration class`)
    for (const name of names)
      if (!name.endsWith(stamp))
        out.push(`${file}: ${name} does not end with the file's timestamp ${stamp}`)
  }
  for (const [stamp, same] of byStamp)
    if (same.length > 1)
      out.push(
        `${same.join(', ')}: share the timestamp ${stamp}; give the unreleased one the current time (seconds included)`,
      )
  return out
}
