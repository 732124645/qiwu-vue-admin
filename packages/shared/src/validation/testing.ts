import { z } from 'zod'
import { fieldDomains } from './zod-i18n.js'

// Test fixture (`@qiwu/shared/testing`): one schema that both the server e2e spec and the web form spec
// validate with, proving the shared-schema contract of docs/adr/003-validation.md. Not part of the main entry point.

export const DemoNoteCreate = z
  .object({
    title: z.string().trim().min(3).max(50),
    email: z.email(),
    quantity: z.number().int().min(1).max(99),
  })
  .register(fieldDomains, { domain: 'demo' })

export type DemoNoteCreate = z.infer<typeof DemoNoteCreate>

/**
 * A generated create schema with a NOT NULL column the DB fills by an expression default (`starts_at
 * DEFAULT CURRENT_TIMESTAMP`): the field may be left out, never sent as null.
 */
export const DemoEventCreate = z
  .object({
    title: z.string().trim().min(1).max(50),
    startsAt: z.iso.datetime({ offset: true }).optional(),
  })
  .register(fieldDomains, { domain: 'demo' })
