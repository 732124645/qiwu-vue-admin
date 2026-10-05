import type { Page, SortOrder } from '@qiwu/shared'
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm'

/** Parsed `pageQuery([...sortable])` output (see docs/design-notes.md#api-envelope). */
export interface PageParams<F extends string = string> {
  page: number
  pageSize: number
  sort?: SortOrder<F>[]
}

/**
 * ORDER BY `sort`, then `<alias>.id DESC` (unless `sort` already orders by it) so the order is stable.
 * Sort fields were whitelisted by the zod schema (`pageQuery(['createdAt', 'id'])`), so they are safe
 * identifiers; by default a field is the same-named property of the main alias, `columns` maps the
 * ones that differ (e.g. `{ deptName: 'd.name' }` for a joined column).
 */
export function sorted<Q extends SelectQueryBuilder<ObjectLiteral>, F extends string>(
  qb: Q,
  sort: SortOrder<F>[] = [],
  columns: Partial<Record<F, string>> = {},
): Q {
  const id = `${qb.alias}.id`
  // whitelisted sort fields + the alias chosen by code, never a request value
  const order = sort.map(
    ({ field, order }) => [columns[field] ?? `${qb.alias}.${field}`, order] as const,
  )
  for (const [column, dir] of order) qb.addOrderBy(column, dir)
  // a second addOrderBy on the same column would replace the requested direction
  if (!order.some(([column]) => column === id)) qb.addOrderBy(id, 'DESC')
  return qb
}

/**
 * Every row of `query()` (a fresh filtered, sorted builder per call) in batches of `size`, for exports, so an
 * export never holds the whole table and rows written meanwhile (the action log's line for the export itself)
 * cannot shift a batch boundary (seen twice or skipped). Ordered by the id alone (the lists' default): keyset
 * batches after the last id, exact while rows come and go. Any other order: offset batches over the rows up to
 * the highest id there was before the first batch.
 * Under a requested sort a row deleted mid-export still shifts an offset batch (one skipped); keyset on
 * the whole sort tuple if exports must be exact under deletes too.
 */
export async function* exportBatches<E extends ObjectLiteral & { id: number }>(
  query: () => SelectQueryBuilder<E>,
  size: number,
): AsyncGenerator<E[]> {
  const probe = query()
  const id = `${probe.alias}.id`
  const orders = Object.entries(probe.expressionMap.orderBys)
  const [column, dir] = orders.length === 1 ? orders[0]! : []
  const keyset = column === id
  const asc = (typeof dir === 'object' ? dir.order : dir) === 'ASC'
  // `id`: the builder's own alias (code-chosen, never a request value) + `.id`
  let ceiling: unknown
  if (!keyset)
    ({ ceiling } = (await query()
      .orderBy()
      // arch-allow: sql-concat the alias the code chose
      .select(`MAX(${id})`, 'ceiling')
      .getRawOne<{ ceiling: unknown }>()) ?? { ceiling: null })
  let last: number | undefined
  for (let skip = 0; ; skip += size) {
    const qb = query()
    // arch-allow: sql-concat the alias the code chose
    if (!keyset) qb.andWhere(`${id} <= :exportCeiling`, { exportCeiling: ceiling }).skip(skip)
    else if (last !== undefined)
      // arch-allow: sql-concat the alias the code chose
      qb.andWhere(`${id} ${asc ? '>' : '<'} :exportLast`, { exportLast: last })
    const rows = await qb.take(size).getMany()
    if (rows.length) yield rows
    if (rows.length < size) return
    last = rows.at(-1)!.id
  }
}

/** `LIKE :x` value matching `text` anywhere, its `%`, `_` and `\` taken literally. */
export const contains = (text: string): string => `%${text.replace(/[\\%_]/g, '\\$&')}%`

/** One page of `qb` as `{ items, total }`, ordered by `sorted`. */
export async function paginate<E extends ObjectLiteral, F extends string>(
  qb: SelectQueryBuilder<E>,
  { page, pageSize, sort }: PageParams<F>,
  columns?: Partial<Record<F, string>>,
): Promise<Page<E>> {
  const [items, total] = await sorted(qb, sort, columns)
    .skip((page - 1) * pageSize)
    .take(pageSize)
    .getManyAndCount()
  return { items, total }
}
