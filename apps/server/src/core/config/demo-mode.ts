import { z } from 'zod'

/** Seed-time flag parsing matches EnvSchema; unset or invalid means off. */
export const demoMode = () => z.stringbool().safeParse(process.env.APP_DEMO_MODE).data === true
