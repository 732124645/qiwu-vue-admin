import { z } from 'zod'
import { PAGE_SIZE_MAX } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'

/**
 * Realtime push demo, `POST /api/demo/realtime/send`: a signed-in user pushes
 * plain text to users, roles or everyone as a `demo:message` envelope (`RT.demoMessage`, payload in
 * `RealtimePayloads`). Field labels `field.demo.realtime.<prop>`.
 */

export const demoRealtimePerms = {
  send: 'demo.realtime.send',
  /** `target: 'all'` needs this on top of `send` */
  broadcast: 'demo.realtime.broadcast',
} as const

export const DEMO_REALTIME_TARGETS = ['user', 'role', 'all'] as const
export type DemoRealtimeTarget = (typeof DEMO_REALTIME_TARGETS)[number]

const ids = z.array(z.number().int().positive()).max(PAGE_SIZE_MAX).optional()
const listOf = { user: 'userIds', role: 'roleIds' } as const

/**
 * POST body: `userIds` with `target: 'user'`, `roleIds` with `'role'` (1–200 each), neither with `'all'`;
 * the other list must be left out or empty. `text` (1–500 characters, not only whitespace) is sent as
 * is, never trimmed, and always shown as plain text.
 */
export const demoRealtimeSendBody = z
  .object({
    target: z.enum(DEMO_REALTIME_TARGETS),
    userIds: ids,
    roleIds: ids,
    text: z
      .string()
      .max(500)
      .refine((s) => s.trim() !== '', { error: 'validation.required' }),
  })
  .superRefine((b, ctx) => {
    for (const [target, prop] of Object.entries(listOf)) {
      const n = b[prop]?.length ?? 0
      if (target === b.target ? n === 0 : n > 0)
        ctx.addIssue({
          code: 'custom',
          path: [prop],
          message: target === b.target ? 'validation.required' : 'validation.invalid',
        })
    }
  })
  .register(fieldDomains, { domain: 'demo.realtime' })
export type DemoRealtimeSendBody = z.infer<typeof demoRealtimeSendBody>

/** Send result: distinct users with a live socket across the deployment when sending. */
export const demoRealtimeSendVo = z.object({ delivered: z.number().int() })
export type DemoRealtimeSendVo = z.infer<typeof demoRealtimeSendVo>
