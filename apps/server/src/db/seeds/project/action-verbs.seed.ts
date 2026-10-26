// Project action verbs: the `@ActionLog` verbs the project's own write routes add (a customer's
// "升级为 VIP" as `upgrade`, …), so the platform audit seed (db/seeds/audit/audit.seed.ts, VERBS) stays
// untouched. Same format as VERBS: [value, zh-CN label, en-US label, tagType?]; the value is kebab-case
// (lowercase letters, digits, hyphens, at most 32 characters). `pnpm arch:check` (scripts/arch/action-log.mjs)
// accepts an @ActionLog verb listed in either file and fails on a value that repeats a platform verb (use
// that one). Generated code only uses platform verbs: this list is for hand-written actions.
// A SEEDS.project seed, after the project menu groups. Insert-only: each verb becomes an item of the dict
// `audit.verb` when that dict has no item with its value (live or deleted); an item that exists keeps the
// administrator's label, tag, sort and state, and the dict's name and the platform items are never touched.
// New items sort after the dict's last one.
// This file belongs to the project (the template ships it empty); Chinese labels are fine here.
import type { DICT_TAG_TYPES } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findRow, insertRow } from '../upsert.js'

export type ProjectActionVerb = [
  value: string,
  zh: string,
  en: string,
  tagType?: (typeof DICT_TAG_TYPES)[number],
]

export const PROJECT_ACTION_VERBS: ProjectActionVerb[] = []

export async function seedProjectActionVerbs(
  q: EntityManager,
  verbs: readonly ProjectActionVerb[] = PROJECT_ACTION_VERBS,
): Promise<string[]> {
  const dict_code = 'audit.verb'
  for (const [value, zh, en, tagType] of verbs) {
    if (await findRow(q, 'cfg_dict_entry', { dict_code, value })) continue
    const [{ last }] = await q.query(
      // qw:include-deleted after deleted items too (one restored keeps its place)
      'SELECT COALESCE(MAX(sort_no), 0) AS last FROM cfg_dict_entry WHERE dict_code = ?',
      [dict_code],
    )
    const labels = { 'zh-CN': zh, 'en-US': en }
    await insertRow(q, 'cfg_dict_entry', {
      dict_code,
      value,
      label: zh,
      label_i18n: labels,
      sort_no: Number(last) + 10,
      tag_type: tagType ?? null,
    })
  }
  return []
}
