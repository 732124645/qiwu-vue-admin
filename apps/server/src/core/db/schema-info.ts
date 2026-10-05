import type { DataSource, EntityManager } from 'typeorm'

export interface ColumnInfo {
  name: string
  columnType: string
  nullable: boolean
  comment: string
  /** COLUMN_DEFAULT as MySQL reports it (`0`, `crud`, `CURRENT_TIMESTAMP(3)`); none → null */
  default: string | null
  isPk: boolean
  autoIncrement: boolean
  /** a generated column (`alive`, …): computed by MySQL, never written */
  generated: boolean
  /**
   * alone in a unique index, generated columns aside (`unique(code)`, or `unique(isbn, alive)`: unique
   * among live rows)
   */
  unique: boolean
}

export interface TableInfo {
  name: string
  comment: string
  columns: ColumnInfo[]
  /** every unique index but the primary key, with all its columns (generated ones too) in order */
  uniqueKeys: { name: string; columns: string[] }[]
}

/**
 * Table + column facts of a base table of the connected schema (`table_schema = DATABASE()`), read
 * from information_schema with the table name as a parameter (codegen source; see docs/design-notes.md#codegen). Missing or
 * a view → null.
 */
export async function readTableInfo(
  db: DataSource | EntityManager,
  table: string,
): Promise<TableInfo | null> {
  const [t] = await db.query(
    'SELECT table_name AS name, table_comment AS comment FROM information_schema.tables' +
      " WHERE table_schema = DATABASE() AND table_name = ? AND table_type = 'BASE TABLE'",
    [table],
  )
  if (!t) return null
  const columns: {
    name: string
    columnType: string
    nullable: string
    comment: string
    dflt: string | null
    colKey: string
    extra: string
    gen: string | null
  }[] = await db.query(
    'SELECT column_name AS name, column_type AS columnType, is_nullable AS nullable,' +
      ' column_comment AS comment, column_default AS dflt, column_key AS colKey, extra AS extra,' +
      ' generation_expression AS gen FROM information_schema.columns' +
      ' WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
    [table],
  )
  const indexes: { idx: string; col: string }[] = await db.query(
    'SELECT index_name AS idx, column_name AS col FROM information_schema.statistics' +
      " WHERE table_schema = DATABASE() AND table_name = ? AND non_unique = 0 AND index_name <> 'PRIMARY'" +
      ' ORDER BY index_name, seq_in_index',
    [table],
  )
  const generated = new Set(columns.filter((c) => c.gen).map((c) => c.name))
  const byIndex = new Map<string, string[]>()
  for (const { idx, col } of indexes) byIndex.set(idx, [...(byIndex.get(idx) ?? []), col])
  const unique = new Set(
    [...byIndex.values()]
      .map((cols) => cols.filter((c) => !generated.has(c)))
      .filter((cols) => cols.length === 1)
      .map(([c]) => c),
  )
  return {
    name: t.name,
    comment: t.comment,
    uniqueKeys: [...byIndex].map(([name, cols]) => ({ name, columns: cols })),
    columns: columns.map(({ dflt, colKey, extra, gen, ...c }) => ({
      ...c,
      nullable: c.nullable === 'YES',
      default: dflt,
      isPk: colKey === 'PRI',
      autoIncrement: /\bauto_increment\b/i.test(extra),
      generated: !!gen,
      unique: unique.has(c.name),
    })),
  }
}
