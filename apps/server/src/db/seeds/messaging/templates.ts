import { LOCALES, type Locale } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { upsert, type Row } from '../upsert.js'

type TemplateTable = 'msg_inbox_template' | 'msg_mail_template' | 'msg_sms_template'
type TemplateText<T extends TemplateTable> = T extends 'msg_inbox_template'
  ? { title: string; body: string }
  : T extends 'msg_mail_template'
    ? { subject: string; body: string }
    : { body: string }

/** Seed both languages on insert; subsequent runs leave administrator-owned template fields alone. */
export async function upsertTemplates<T extends TemplateTable>(
  q: EntityManager,
  table: T,
  code: string,
  rows: Record<Locale, TemplateText<T>>,
  shared: Row,
): Promise<void> {
  for (const locale of LOCALES)
    await upsert(q, table, { code, locale }, {}, { ...shared, ...rows[locale] })
}
